/**
 * Session — an isolated, independently-runnable unit of work.
 *
 * Each session owns its OWN registry, log store, permission gate, orchestrator
 * (with its own per-phase model overrides), working directory, event stream, and
 * abort scope. Two sessions share nothing mutable, so any number of them can run
 * `runChain`/`runPhase` concurrently in a single process (e.g. one Electron app
 * driving several project tabs at once) without cross-talk.
 *
 * The stateless {@link LLMBridge} is shared from the {@link Harness} manager; the
 * model catalog is read-only at runtime. Everything else is per-session.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  LLMBridge,
  PermissionCallback,
  PermissionMode,
  Phase,
  PhaseResult,
  PrepareProviderAssignmentMap,
  RegisteredProviderSummary,
  RunLoopResult,
  ThreadFollowUpContext,
  ThreadRunDisposition,
  ThreadRunSnapshot,
  TranscriptMode,
} from "./types.js";
import {
  Registry,
  type PhaseToolFilter,
  type PhaseToolSpec,
  type ProviderInput,
  type ProviderListItem,
  type ToolCategorizer,
} from "./registry/registry.js";
import { LogStore } from "./logging/logger.js";
import { PermissionGate } from "./orchestrator/permission.js";
import {
  buildThreadRunSummary,
  Orchestrator,
  type ChainResult,
  type PhaseModelConfig,
  type RunChainOptions,
  type RunPhaseOptions,
  type RunOptions,
} from "./orchestrator/orchestrator.js";
import { registerBuiltins } from "./tools/index.js";
import { connectMcpServer, type McpServerOptions } from "./mcp/client.js";
import { McpRuntimePool, wrapPooledProvider, mcpServerSignature } from "./mcp/runtime-pool.js";
import type { AssetsGeneratorConfig } from "./tools/builtin/assets-generator.js";
import type { MediaAnalysisConfig } from "./tools/builtin/media-analysis.js";
import type { WebConfig } from "./tools/builtin/web.js";
import type { PlanToolConfig } from "./tools/builtin/plan.js";
import type { InspirationGeneratorConfig } from "./tools/builtin/inspiration-generator.js";
import { HarnessAgent, type AgentHost, type HarnessAgentOptions } from "./agent.js";
import { applyProjectPreset, presetPolicy, type ApplyPresetOptions, type ProjectCategory } from "./presets/project-presets.js";
import type { FileMemory } from "./memory/file-memory.js";
import type { FileMemoryRuntime } from "./memory/file-memory-runtime.js";
import type { GraphMemory } from "./memory/graph-memory.js";
import type { ProjectMemory } from "./memory/project-memory.js";

/** Options for a single session. Any field overrides the manager default. */
export interface SessionOptions {
  /** Stable id; auto-generated if omitted. */
  id?: string;
  /**
   * Apply a project preset's phase-tool policy + model defaults at construction
   * (offline-safe; no MCP spawned). Explicit `phaseTools`/`models` below override
   * the preset per key. Use `Harness.createProjectSession` (or `applyProjectPreset`)
   * to also connect the preset's recommended MCP servers.
   */
  preset?: ProjectCategory;
  /** Working directory the session's tools operate within. */
  cwd?: string;
  permissionMode?: PermissionMode;
  permissionCallback?: PermissionCallback;
  models?: PhaseModelConfig;
  toolModelCandidates?: string[];
  /** Host-owned escalation routing: (kind, rating) → model slug. See ModelRouter. */
  routeModel?: import("./types.js").ModelRouter;
  /** Customize the fixed toolset per phase (exact list, filter, or resolver). */
  phaseTools?: Partial<Record<Phase, PhaseToolSpec>>;
  /** Custom 4P categorization strategy for this session's registry. */
  categorizer?: ToolCategorizer;
  maxSteps?: Partial<Record<Phase, number>>;
  reasoning?: Partial<Record<Phase, import("./types.js").ThinkingLevel>>;
  temperature?: Partial<Record<Phase, number>>;
  maxChainIterations?: number;
  /** Register the bundled internal tools into this session (default true). */
  registerBuiltins?: boolean;
  assets?: AssetsGeneratorConfig;
  mediaAnalysis?: MediaAnalysisConfig;
  /** Multimodal slug used to describe tool images for a text-only run model. */
  visionModel?: string;
  /** Config for `create_plan`, including its replaceable planning prompt. */
  plan?: PlanToolConfig;
  /** Config for `web_search` / `web_fetch` (engine, model, limits, custom backend). */
  web?: WebConfig;
  /**
   * Config for `inspiration_generator` — a host-injected keyword lookup returning
   * a reusable UI/poster/parallax blueprint (or null). The harness owns no HTTP
   * client; the host wires the real backend here.
   */
  inspiration?: InspirationGeneratorConfig;
  studyModel?: string;
  /**
   * Register `write`/`edit` in content-less author-only mode (see
   * BuiltinToolsConfig.authorOnlyWrites). Only effective when authoring is
   * configured; default false keeps today's content-required behaviour.
   */
  authorOnlyWrites?: boolean;
  /** Extra providers to register at creation (e.g. shared, stateless tools). */
  providers?: ProviderInput[];
  /** Freeform metadata (project path, tab id, user...). */
  metadata?: Record<string, unknown>;
  /** How much raw transcript detail this session should expose to hosts. */
  transcriptMode?: TranscriptMode;
  /**
   * Whether to auto-triage image attachments at the start of a task run (one
   * media_analysis per image, then surface role + OCR to the loops). Default
   * true; pass false for latency-sensitive runs. See OrchestratorConfig.
   */
  autoTriageAttachments?: boolean;
}

/** A dependency bundle the manager passes to each session. */
export interface SessionDeps {
  llm: LLMBridge;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  running: boolean;
  metadata?: Record<string, unknown>;
}

interface RunLifecycleHooks {
  onRunStart?: () => Promise<void> | void;
  onRunEnd?: () => Promise<void> | void;
}

function deriveStandaloneDisposition(result: PhaseResult): ThreadRunDisposition {
  if (result.pendingUserQuestion) return "pending_user_question";
  if (result.error === "aborted") return "aborted";
  if (result.error) return "failed";
  return "completed";
}

function buildStandaloneThreadSnapshot(task: string, result: PhaseResult): ThreadRunSnapshot {
  const disposition = deriveStandaloneDisposition(result);
  const planJson = Array.isArray(result.artifacts?.planJson) ? result.artifacts.planJson : undefined;
  return {
    timestamp: Date.now(),
    task,
    route: "task",
    disposition,
    recommendedFollowUpMode: disposition === "pending_user_question" ? "fresh" : "structured_continue",
    summary: buildThreadRunSummary({
      task,
      disposition,
      phases: { [result.phase]: result },
      ...(result.error && result.error !== "aborted" ? { error: result.error } : {}),
      ...(result.pendingUserQuestion ? { pendingUserQuestion: result.pendingUserQuestion } : {}),
    }),
    ...(result.readFileContents?.length ? { contextFiles: result.readFileContents.slice(0, 4) } : {}),
    ...(planJson?.length ? { planJson: planJson.slice(0, 12) } : {}),
    ...(result.discoveredPaths?.length ? { discoveredPaths: result.discoveredPaths.slice(0, 24) } : {}),
    ...(result.readPaths?.length ? { readPaths: result.readPaths.slice(0, 24) } : {}),
    ...(result.writtenPaths?.length ? { writtenPaths: result.writtenPaths.slice(0, 24) } : {}),
    ...(result.relevantFiles?.length ? { relevantFiles: result.relevantFiles.slice(0, 12) } : {}),
    ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
    ...(result.pendingUserQuestion ? { pendingUserQuestion: result.pendingUserQuestion } : {}),
    ...(result.error && result.error !== "aborted" ? { error: result.error } : {}),
  };
}

export class Session implements AgentHost {
  readonly id: string;
  readonly cwd: string;
  readonly registry: Registry;
  readonly logStore: LogStore;
  readonly permission: PermissionGate;
  readonly orchestrator: Orchestrator;
  readonly llm: LLMBridge;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  /** Durable project memory, attached when created via Harness.createProjectSession. */
  memory?: ProjectMemory;
  /** Durable file memory, attached when created via Harness.createProjectSession. */
  fileMemory?: FileMemory;
  /** Per-session runtime that hydrates file summaries and watches file changes. */
  fileMemoryRuntime?: FileMemoryRuntime;
  /** Durable graph memory, attached when created via Harness.createProjectSession. */
  graphMemory?: GraphMemory;

  /** Active run abort controllers, so `abort()` cancels everything in-flight. */
  private activeRuns = new Set<AbortController>();
  /** Optional project-session context used when Prepare corrects the category. */
  private projectPresetReconciliation?: Pick<
    ApplyPresetOptions,
    "connectMcp" | "cwd" | "env" | "dbUrl" | "filesystemDir" | "engineCommand"
  >;
  private runLifecycleHooks?: RunLifecycleHooks;
  private lastThreadSnapshot?: ThreadRunSnapshot;
  private disposed = false;

  constructor(deps: SessionDeps, opts: SessionOptions = {}) {
    this.id = opts.id ?? `sess_${randomUUID().slice(0, 8)}`;
    this.cwd = opts.cwd ?? process.cwd();
    this.metadata = opts.metadata ?? {};
    this.createdAt = Date.now();
    this.llm = deps.llm;

    this.logStore = new LogStore();
    this.registry = new Registry({ categorizer: opts.categorizer });
    this.permission = new PermissionGate(opts.permissionMode ?? "ask-mutations", opts.permissionCallback);

    if (opts.registerBuiltins !== false) {
      registerBuiltins(this.registry, {
        logStore: this.logStore,
        assets: opts.assets,
        mediaAnalysis: opts.mediaAnalysis,
        plan: opts.plan,
        web: opts.web,
        inspiration: opts.inspiration,
        studyModel: opts.studyModel,
        ...(opts.authorOnlyWrites ? { authorOnlyWrites: true } : {}),
      });
    }
    for (const p of opts.providers ?? []) this.registry.add(p);

    // Merge a project preset's policy (phase tools + model defaults) with explicit
    // options; explicit options win per key. MCP servers are NOT spawned here —
    // use Harness.createProjectSession / applyProjectPreset(connectMcp).
    const policy = opts.preset ? presetPolicy(opts.preset) : undefined;
    const models = policy ? { ...policy.models, ...opts.models } : opts.models;
    const prepareMemoryOnly: PhaseToolFilter = {
      fromCategory: false,
      include: ["project_memory", "file_memory", "graph_memory", "read"],
    };
    const phaseTools = policy
      ? { ...policy.phaseTools, prepare: prepareMemoryOnly, ...(opts.phaseTools ?? {}) }
      : { prepare: prepareMemoryOnly, ...(opts.phaseTools ?? {}) };

    this.orchestrator = new Orchestrator({
      cwd: this.cwd,
      ...(opts.authorOnlyWrites ? { authorOnlyWrites: true } : {}),
      llm: this.llm,
      registry: this.registry,
      logStore: this.logStore,
      permission: this.permission,
      models,
      toolModelCandidates: opts.toolModelCandidates,
      ...(opts.visionModel ? { visionModel: opts.visionModel } : {}),
      ...(opts.routeModel ? { routeModel: opts.routeModel } : {}),
      phaseTools,
      maxSteps: opts.maxSteps,
      reasoning: opts.reasoning,
      temperature: opts.temperature,
      maxChainIterations: opts.maxChainIterations,
      transcriptMode: opts.transcriptMode,
      ...(opts.autoTriageAttachments === false ? { autoTriageAttachments: false } : {}),
    });
    // Seed the live category from the preset so the non-UI skip is in effect
    // even before Prepare runs. Corrected live in `reconcileAfterPrepare`.
    if (opts.preset) this.orchestrator.projectCategory = opts.preset;
    this.orchestrator.setAfterPrepareHook((prepare, { signal }) => this.reconcileAfterPrepare(prepare, signal));

    this.logStore.append({ tags: ["session", `session:${this.id}`], level: "info", message: `session ${this.id} created (cwd=${this.cwd})` });
  }

  // ---- Registry (per-session) --------------------------------------------

  listCapabilities(filter?: Parameters<Registry["list"]>[0]): ProviderListItem[] {
    return this.registry.list(filter);
  }
  addProvider(input: ProviderInput): ProviderListItem {
    return this.registry.add(input);
  }
  removeProvider(id: string): Promise<boolean> {
    return this.registry.remove(id);
  }
  async addMcpServer(opts: McpServerOptions): Promise<ProviderListItem> {
    const provider = await connectMcpServer(opts);
    return this.registry.add(provider);
  }
  /**
   * Attach multiple MCP servers concurrently. Each `addMcpServer` is an
   * independent child_process + JSON-RPC handshake, so serialising them was
   * the largest pre-prompt latency contributor. Failures are surfaced to
   * the caller — no item is silently swallowed.
   */
  async addMcpServers(opts: McpServerOptions[]): Promise<ProviderListItem[]> {
    return Promise.all(opts.map((o) => this.addMcpServer(o)));
  }

  /**
   * Attach an MCP server using a shared runtime pool. If the server is already
   * connected in the pool, borrows it instead of spawning a new child process.
   */
  async addPooledMcpServer(opts: McpServerOptions, pool: McpRuntimePool): Promise<ProviderListItem> {
    const provider = await pool.borrow(opts, this.id);
    const wrapped = wrapPooledProvider(provider, pool, opts, this.id);
    return this.registry.add(wrapped);
  }

  /** Attach multiple pooled MCP servers concurrently. */
  async addPooledMcpServers(opts: McpServerOptions[], pool: McpRuntimePool): Promise<ProviderListItem[]> {
    return Promise.all(opts.map((o) => this.addPooledMcpServer(o, pool)));
  }
  addSkill(input: Omit<ProviderInput, "kind"> & { kind?: "skill" }): ProviderListItem {
    return this.registry.add({ ...input, kind: "skill" });
  }
  toolsForPhase(phase: Phase): AgentTool[] {
    return this.orchestrator.resolvePhaseTools(phase);
  }

  // ---- Per-phase toolset customization (the fixed P toolset is customizable) --

  /** Set/clear the toolset for a phase at runtime (exact list, filter, or resolver). */
  setPhaseTools(phase: Phase, spec: PhaseToolSpec | undefined): void {
    this.orchestrator.setPhaseTools(phase, spec);
  }
  /** Move a single tool between phases (e.g. a custom screenshot tool → Perfect). */
  setToolPhases(toolName: string, phases: Phase[]): boolean {
    return this.registry.setToolPhases(toolName, phases);
  }
  /** Move a whole provider/MCP between phases. */
  setProviderPhases(providerId: string, phases: Phase[]): boolean {
    return this.registry.setProviderPhases(providerId, phases);
  }

  /** Configure how this project session should re-apply presets after Prepare. */
  configureProjectReconciliation(
    opts: Pick<ApplyPresetOptions, "connectMcp" | "cwd" | "env" | "dbUrl" | "filesystemDir" | "engineCommand">,
  ): void {
    this.projectPresetReconciliation = opts;
  }

  configureRunLifecycleHooks(hooks: RunLifecycleHooks | undefined): void {
    this.runLifecycleHooks = hooks;
  }

  // ---- Permissions -------------------------------------------------------

  setPermissionMode(mode: PermissionMode): void {
    this.permission.setMode(mode);
  }
  setPermissionCallback(cb: PermissionCallback | undefined): void {
    this.permission.setCallback(cb);
  }

  /** Re-point the candidate model pool (cheap → capable) for subsequent runs.
   *  Needed by hosts that reuse a warm session across runs whose model changes. */
  setToolModelCandidates(slugs: string[] | undefined): void {
    this.orchestrator.setToolModelCandidates(slugs);
  }

  /** Install the host's escalation routing table on a session created without one.
   *  Without this, a warm session reused across runs has no router and write/edit
   *  escalation cannot fire at all — see `Orchestrator.setRouteModel`. */
  setRouteModel(router: import("./types.js").ModelRouter | undefined): void {
    this.orchestrator.setRouteModel(router);
  }

  /**
   * Install the host's plan-review callback. `create_plan` calls it with each
   * draft; the host returns approve / re-plan-with-comments, plus any per-step
   * notes and attachments the user added. Without one the tool auto-approves its
   * first draft, so headless runs never block.
   */
  setPlanApprovalCallback(cb: import("./types.js").PlanApprovalCallback | undefined): void {
    this.orchestrator.setPlanApprovalCallback(cb);
  }

  /**
   * Install a host callback for `ask_user_question`. When set, the
   * `ask_user_question` tool blocks in-place until the callback resolves with
   * the user's answer, so the LLM continues in the SAME conversation context
   * — no new run is required to "apply" the answer. This mirrors the
   * `setPermissionCallback` flow used for tool approval.
   *
   * Pass `undefined` to fall back to the non-blocking `details` payload
   * (backwards-compatible behaviour: the host cancels the run and restarts
   * with the answer as a new user message).
   */
  setAskUserQuestionCallback(
    cb: ((request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>) | undefined,
  ): void {
    this.askUserQuestion = cb;
  }

  /**
   * Optional host callback resolved by every `ask_user_question` tool call in
   * this session. Set via {@link Session.setAskUserQuestionCallback}. When
   * `undefined`, the tool falls back to surfacing the question through
   * `details` so a non-blocking host can handle it.
   */
  private askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;

  // ---- Events ------------------------------------------------------------

  subscribe(fn: (e: AgentEvent) => void): () => void {
    return this.orchestrator.subscribe(fn);
  }

  get threadSnapshot(): ThreadRunSnapshot | undefined {
    return this.lastThreadSnapshot;
  }

  clearThreadSnapshot(): void {
    this.lastThreadSnapshot = undefined;
  }

  // ---- Execution ---------------------------------------------------------

  async runPhase(phase: Phase, task: string, opts: RunPhaseOptions = {}): Promise<PhaseResult> {
    this.assertLive();
    const { signal, done } = await this.beginRun(opts.signal);
    const followUpContext = this.resolveFollowUpContext(opts.followUpContext);
    const inheritedReadPaths = followUpContext?.previousRun.readPaths;
    const inheritedContextFiles = followUpContext?.previousRun.contextFiles;
    try {
      const result = await this.orchestrator.runPhase(phase, task, {
        ...opts,
        priorReadPaths:
          inheritedReadPaths?.length && !opts.priorReadPaths?.length
            ? inheritedReadPaths
            : opts.priorReadPaths,
        attachedContextFiles:
          inheritedContextFiles?.length && !opts.attachedContextFiles?.length
            ? inheritedContextFiles
            : opts.attachedContextFiles,
        availableProviders: opts.availableProviders ?? (phase === "prepare" ? summarizeRegisteredProviders(this.registry.list()) : undefined),
        signal,
        ...(followUpContext ? { followUpContext } : {}),
        ...(opts.askUserQuestion || this.askUserQuestion
          ? { askUserQuestion: opts.askUserQuestion ?? this.askUserQuestion }
          : {}),
      });
      this.lastThreadSnapshot = buildStandaloneThreadSnapshot(task, result);
      return result;
    } finally {
      await done();
    }
  }

  /**
   * Run the flat loop driver (the primary entry point). `runPhase`/`runChain`
   * remain as back-compat shims; new code should call this.
   */
  async run(task: string, opts: RunOptions = {}): Promise<RunLoopResult> {
    this.assertLive();
    const { signal, done } = await this.beginRun(opts.signal);
    const followUpContext = this.resolveFollowUpContext(opts.followUpContext);
    try {
      const result = await this.orchestrator.run(task, {
        ...opts,
        signal,
        ...(followUpContext ? { followUpContext } : {}),
        ...(opts.askUserQuestion || this.askUserQuestion
          ? { askUserQuestion: opts.askUserQuestion ?? this.askUserQuestion }
          : {}),
      });
      this.lastThreadSnapshot = result.threadSnapshot;
      return result;
    } finally {
      await done();
    }
  }

  async runChain(task: string, opts: RunChainOptions = {}): Promise<ChainResult> {
    this.assertLive();
    const { signal, done } = await this.beginRun(opts.signal);
    const followUpContext = this.resolveFollowUpContext(opts.followUpContext);
    try {
      const result = await this.orchestrator.runChain(task, {
        ...opts,
        signal,
        ...(followUpContext ? { followUpContext } : {}),
        ...(opts.askUserQuestion || this.askUserQuestion
          ? { askUserQuestion: opts.askUserQuestion ?? this.askUserQuestion }
          : {}),
      });
      this.lastThreadSnapshot = result.threadSnapshot;
      return result;
    } finally {
      await done();
    }
  }

  /** True while at least one run is in flight. */
  get isRunning(): boolean {
    return this.activeRuns.size > 0;
  }

  /** Abort every in-flight run in this session. */
  abort(): void {
    for (const c of this.activeRuns) c.abort();
    this.activeRuns.clear();
  }

  // ---- Agent facade ------------------------------------------------------

  createAgent(opts?: HarnessAgentOptions): HarnessAgent {
    return new HarnessAgent(this, opts);
  }

  phaseTools(): AgentTool[] {
    return this.orchestrator.phaseTools();
  }
  chainTool(): AgentTool {
    return this.orchestrator.chainTool();
  }

  info(): SessionInfo {
    return { id: this.id, cwd: this.cwd, createdAt: this.createdAt, running: this.isRunning, metadata: this.metadata };
  }

  /** Abort in-flight work and release external resources (MCP processes). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort();
    await this.fileMemoryRuntime?.dispose();
    await this.registry.dispose();
    this.logStore.append({ tags: ["session", `session:${this.id}`], level: "info", message: `session ${this.id} disposed` });
  }

  private assertLive(): void {
    if (this.disposed) throw new Error(`Session ${this.id} has been disposed.`);
  }

  private resolveFollowUpContext(
    followUpContext: ThreadFollowUpContext | undefined,
  ): ThreadFollowUpContext | undefined {
    if (followUpContext) return followUpContext;
    if (!this.lastThreadSnapshot) return undefined;
    if (this.lastThreadSnapshot.recommendedFollowUpMode !== "structured_continue") return undefined;
    return { mode: "structured_continue", previousRun: this.lastThreadSnapshot };
  }

  private async reconcileAfterPrepare(prepare: PhaseResult, _signal?: AbortSignal): Promise<PhaseResult> {
    const patched: PhaseResult = {
      ...prepare,
      projectRunbook: prepare.projectRunbook ? { ...prepare.projectRunbook } : undefined,
      memoryUpdates: prepare.memoryUpdates ? [...prepare.memoryUpdates] : undefined,
      fileMemoryUpdates: prepare.fileMemoryUpdates ? [...prepare.fileMemoryUpdates] : undefined,
    };

    if (this.memory && patched.projectCategory && this.memory.category !== patched.projectCategory) {
      await this.memory.setCategory(patched.projectCategory, { auto: false });
    }
    // Thread the corrected category live to the orchestrator so the non-UI skip
    // (inspiration/assets/design-skill) reflects the post-scan verdict, not the
    // preset guess. Memory is the source of truth once Prepare has reconciled.
    const liveCategory = this.memory?.category ?? patched.projectCategory;
    if (liveCategory) this.orchestrator.projectCategory = liveCategory;

    if (this.memory && patched.memoryUpdates?.length) {
      const known = new Set(this.memory.data.facts.map((f) => f.text.trim().toLowerCase()));
      for (const update of patched.memoryUpdates) {
        const text = update.trim();
        if (!text || known.has(text.toLowerCase())) continue;
        await this.memory.remember(text, { tags: ["prepare", "handoff"], source: "prepare" });
        known.add(text.toLowerCase());
      }
    }

    if (this.fileMemory && patched.fileMemoryUpdates?.length) {
      const known = new Set(
        Object.values(this.fileMemory.data.files).map((entry) => `${entry.path.trim().toLowerCase()}::${entry.summary.trim().toLowerCase()}`),
      );
      for (const update of patched.fileMemoryUpdates) {
        const filePath = update.path.trim();
        const summary = update.summary.trim();
        if (!filePath || !summary) continue;
        const sig = `${filePath.toLowerCase()}::${summary.toLowerCase()}`;
        if (known.has(sig)) continue;
        await this.fileMemory.remember(filePath, summary, {
          tags: update.tags,
          role: update.role,
          source: "prepare",
        });
        known.add(sig);
      }
    }

    if (patched.projectCategory && this.projectPresetReconciliation) {
      await applyProjectPreset(this, patched.projectCategory, {
        ...this.projectPresetReconciliation,
        applyPolicy: true,
        setModels: false,
      });
    }

    const structuredAssignments = this.reconcileStructuredProviderAssignments(patched.providerAssignments);
    this.applyStructuredProviderAssignments(structuredAssignments);
    const resolved =
      structuredAssignments.plan.length || structuredAssignments.perform.length || structuredAssignments.perfect.length
        ? [...structuredAssignments.plan, ...structuredAssignments.perform, ...structuredAssignments.perfect]
        : this.reconcileProvidersFromCapabilities(patched.capabilities);
    if (resolved.length) {
      const existing = new Set(
        (patched.capabilities ?? "")
          .split("\n")
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean),
      );
      const extra = resolved
        .map((provider) => `- resolved provider ${provider.id}: ${provider.name} [phases: ${provider.phases.join(", ")}]`)
        .filter((line) => !existing.has(line.trim().toLowerCase()));
      patched.capabilities = [patched.capabilities?.trim(), ...extra].filter(Boolean).join("\n");
    }

    this.logStore.append({
      tags: ["phase", "handoff", "prepare", "plan", "capabilities", `session:${this.id}`],
      level: "info",
      message: "prepare reconciliation complete",
      data: {
        projectCategory: patched.projectCategory,
        declaredCapabilities: patched.capabilities,
        structuredProviderAssignments: patched.providerAssignments,
        resolvedProviders: resolved.map((provider) => ({
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          phases: provider.phases,
          tools: provider.tools.map((tool) => tool.name),
        })),
        providerAssignmentsByPhase: summarizeProviderAssignments(this.registry.list()),
        toolAssignmentsByPhase: {
          prepare: this.toolsForPhase("prepare").map((tool) => tool.name),
          plan: this.toolsForPhase("plan").map((tool) => tool.name),
          perform: this.toolsForPhase("perform").map((tool) => tool.name),
          perfect: this.toolsForPhase("perfect").map((tool) => tool.name),
        },
      },
    });

    return patched;
  }

  private reconcileStructuredProviderAssignments(
    assignments?: PrepareProviderAssignmentMap,
  ): Record<"plan" | "perform" | "perfect", ProviderListItem[]> {
    const registryById = new Map(this.registry.list().map((provider) => [provider.id, provider]));
    const resolve = (phase: "plan" | "perform" | "perfect") =>
      (assignments?.[phase] ?? [])
        .map((id) => registryById.get(id))
        .filter((provider): provider is ProviderListItem => Boolean(provider));
    return {
      plan: resolve("plan"),
      perform: resolve("perform"),
      perfect: resolve("perfect"),
    };
  }

  private applyStructuredProviderAssignments(
    assignments: Record<"plan" | "perform" | "perfect", ProviderListItem[]>,
  ): void {
    for (const phase of ["plan", "perform", "perfect"] as const) {
      const providers = assignments[phase];
      if (!providers.length) continue;
      const tools = new Map<string, AgentTool>();
      for (const tool of this.toolsForPhase(phase)) tools.set(tool.name, tool);
      for (const provider of providers) {
        for (const tool of provider.tools) {
          const executable = this.registry.getTool(tool.name);
          if (executable) tools.set(executable.name, executable);
        }
      }
      this.setPhaseTools(phase, [...tools.values()]);
    }
  }

  private reconcileProvidersFromCapabilities(capabilities?: string): ProviderListItem[] {
    if (!capabilities || /^none\b/i.test(capabilities.trim())) return [];
    const lines = capabilities
      .split("\n")
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim().toLowerCase())
      .filter(Boolean);
    if (!lines.length) return [];

    const matched: ProviderListItem[] = [];
    for (const provider of this.registry.list()) {
      const hay = [
        provider.id,
        provider.name,
        provider.description,
        ...provider.tools.flatMap((tool) => [tool.name, tool.description ?? ""]),
      ]
        .join(" ")
        .toLowerCase();
      const providerTokens = tokenize(provider.id, provider.name, provider.description, ...provider.tools.map((tool) => tool.name));
      const phases = [...new Set(provider.tools.flatMap((tool) => tool.phases))];
      const isMatch = lines.some((line) => {
        if (hay.includes(line)) return true;
        const lineTokens = tokenize(line);
        const overlap = [...lineTokens].filter((token) => providerTokens.has(token)).length;
        return overlap >= 2 || (overlap >= 1 && /mcp|skill|browser|mobile|docs|search|database|sql|audit|test/.test(line));
      });
      if (!isMatch) continue;
      if (phases.length) this.setProviderPhases(provider.id, phases);
      matched.push({ ...provider, phases: phases.length ? phases : provider.phases });
    }
    return matched;
  }

  /** Create a run-scoped abort signal linked to any external signal + session abort. */
  private async beginRun(external?: AbortSignal): Promise<{ signal: AbortSignal; done: () => Promise<void> }> {
    const controller = new AbortController();
    this.activeRuns.add(controller);
    try {
      await this.runLifecycleHooks?.onRunStart?.();
    } catch (error) {
      this.activeRuns.delete(controller);
      throw error;
    }
    let onAbort: (() => void) | undefined;
    if (external) {
      if (external.aborted) controller.abort();
      else {
        onAbort = () => controller.abort();
        external.addEventListener("abort", onAbort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      done: async () => {
        try {
          await this.runLifecycleHooks?.onRunEnd?.();
        } finally {
          this.activeRuns.delete(controller);
          // Remove the listener so reusing one external signal across many runs
          // doesn't accumulate listeners (MaxListenersExceededWarning / leak).
          if (external && onAbort) external.removeEventListener("abort", onAbort);
        }
      },
    };
  }
}

function tokenize(...parts: string[]): Set<string> {
  return new Set(
    parts
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token)),
  );
}

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "later",
  "phase",
  "phases",
  "tool",
  "tools",
  "built",
  "only",
  "none",
  "use",
]);

function summarizeProviderAssignments(providers: ProviderListItem[]): Record<Phase, Array<{ id: string; name: string; kind: string }>> {
  const out = {
    prepare: [] as Array<{ id: string; name: string; kind: string }>,
    plan: [] as Array<{ id: string; name: string; kind: string }>,
    perform: [] as Array<{ id: string; name: string; kind: string }>,
    perfect: [] as Array<{ id: string; name: string; kind: string }>,
  };
  for (const provider of providers) {
    for (const phase of provider.phases) {
      out[phase].push({ id: provider.id, name: provider.name, kind: provider.kind });
    }
  }
  for (const phase of Object.keys(out) as Phase[]) {
    out[phase].sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}

function summarizeRegisteredProviders(providers: ProviderListItem[]): RegisteredProviderSummary[] {
  return providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    description: provider.description,
    phases: provider.phases,
    toolNames: provider.tools.map((tool) => tool.name),
  }));
}
