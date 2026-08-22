/**
 * Session — an isolated, independently-runnable unit of work.
 *
 * Each session owns its OWN registry, log store, permission gate, orchestrator
 * (with its own model overrides and categorizer setup), working directory, event
 * stream, and abort scope. Two sessions share nothing mutable, so any number of
 * them can run concurrently in a single process (e.g. one Electron app driving
 * several project tabs at once) without cross-talk.
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
  RunLoopResult,
  ThreadFollowUpContext,
  ThreadRunSnapshot,
  TranscriptMode,
} from "./types.js";
import {
  Registry,
  type CategorizerToolSpec,
  type ProviderInput,
  type ProviderListItem,
  type ToolCategorizer,
} from "./registry/registry.js";
import type { CategorizerDefinition, CategorizerHop } from "./categorizer/types.js";
import { createCategorizerSetup, type CategorizerSetup } from "./categorizer/setup.js";
import { LogStore } from "./logging/logger.js";
import { PermissionGate } from "./orchestrator/permission.js";
import { Orchestrator, type PhaseModelConfig, type RunOptions } from "./orchestrator/orchestrator.js";
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
   * (offline-safe; no MCP spawned). Explicit `categorizerTools`/`models` below override
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
  /**
   * The categorizer setup driving runs (the categories, their tools/prompts/
   * models/transitions). Defaults to the four built-in categories; see
   * `categorizer-setup`.
   */
  categorizerSetup?: CategorizerSetup | CategorizerDefinition[];
  /**
   * Declarative EXTRA tools per categorizer (filter over the registry scope, an
   * exact list, or a resolver) — merged on top of each categorizer's own tools.
   * How presets scope their MCP servers into categories.
   */
  categorizerTools?: Partial<Record<string, CategorizerToolSpec>>;
  /** Custom scoping strategy for this session's registry (defaults per tool). */
  categorizer?: ToolCategorizer;
  /**
   * LEGACY: include every CONNECTED external MCP server in the chain via the
   * name heuristics, without any per-run selection. Default false — connected
   * is not selected; name servers per run with `selectMcpServers`.
   */
  includeUnselectedMcpTools?: boolean;
  maxSteps?: number;
  reasoning?: import("./types.js").ThinkingLevel;
  temperature?: number;
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
  /**
   * `writtenPaths` is what the run actually changed, so a subscriber can act on
   * the edits instead of re-deriving them from filesystem events. Undefined when
   * the run failed before producing a snapshot.
   */
  onRunEnd?: (summary?: { writtenPaths?: string[] }) => Promise<void> | void;
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
  /** Per-run MCP selection (composer): named servers ride every category. */
  private mcpSelection: string[] | undefined;
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
    this.registry = new Registry({
      categorizer: opts.categorizer,
      // Connected ≠ in-chain: external MCPs stay out of every hop until the
      // host names them via selectMcpServers (the composer selection). The
      // "auto" escape restores the legacy name-heuristic scoping.
      externalMcpScoping: opts.includeUnselectedMcpTools ? "auto" : "selection",
    });
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

    // Merge a project preset's policy (categorizer tools + model defaults) with
    // explicit options; explicit options win per key. MCP servers are NOT spawned
    // here — use Harness.createProjectSession / applyProjectPreset(connectMcp).
    const policy = opts.preset ? presetPolicy(opts.preset) : undefined;
    const models = policy ? { ...policy.models, ...opts.models } : opts.models;
    const categorizerTools = {
      ...(policy?.categorizerTools ?? {}),
      ...(opts.categorizerTools ?? {}),
    };

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
      ...(opts.categorizerSetup ? { categorizerSetup: normalizeCategorizerSetup(opts.categorizerSetup) } : {}),
      maxSteps: opts.maxSteps,
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      transcriptMode: opts.transcriptMode,
      ...(opts.autoTriageAttachments === false ? { autoTriageAttachments: false } : {}),
    });
    for (const [id, spec] of Object.entries(categorizerTools)) {
      if (spec) this.orchestrator.setCategorizerTools(id, spec);
    }
    // Seed the live category from the preset so the non-UI skip is in effect
    // before the first read hop runs. Corrected live in `reconcileAfterRead`.
    if (opts.preset) this.orchestrator.projectCategory = opts.preset;
    this.orchestrator.setAfterCategorizerHook((hop, signal) => this.reconcileAfterCategorizer(hop, signal));

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
    const item = this.registry.add(provider);
    this.applyMcpSelectionTo(provider.id);
    return item;
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
    const item = this.registry.add(wrapped);
    this.applyMcpSelectionTo(item.id);
    return item;
  }

  /**
   * Name the EXTERNAL MCP servers offered to this run (the composer
   * selection). Selected servers join EVERY categorizer; every other external
   * MCP stays connected but reaches no hop. Re-callable per run — a later call
   * with a different list re-scopes both ways. Late-attached servers
   * (addMcpServer after this call) inherit the current selection.
   *
   * Names match a provider id exactly or as its `…:name` suffix, so a host's
   * namespaced ids (`turing-machine:mcp:chrome-devtools`) resolve from the
   * plain server name the UI knows (`chrome-devtools`).
   */
  selectMcpServers(names: readonly string[]): { selected: string[]; dropped: string[] } {
    this.mcpSelection = [...names];
    const res = this.registry.selectExternalMcps(names, this.categoryIds);
    this.logStore.append({
      tags: ["session", "mcp", "mcp:selection"],
      level: "info",
      message: `mcp selection applied: ${res.selected.length} in-chain, ${res.dropped.length} connected-only`,
      data: { selected: res.selected, dropped: res.dropped },
    });
    return res;
  }

  /** Current per-run MCP selection, if one has been made. */
  get mcpServersSelected(): readonly string[] | undefined {
    return this.mcpSelection ? [...this.mcpSelection] : undefined;
  }

  /** Re-apply the active selection (a server attached after the selection was
   * made must not sneak into the chain unselected). Idempotent over the whole
   * external-MCP set, so re-running it for one late attach is safe. */
  private applyMcpSelectionTo(_providerId: string): void {
    if (!this.mcpSelection) return;
    this.registry.selectExternalMcps(this.mcpSelection, this.categoryIds);
  }

  /** Every categorizer id in this session's setup — what "all categories" means. */
  private get categoryIds(): string[] {
    const setup = this.orchestrator.categorizerSetup;
    return setup ? setup.categories.map((c) => c.id) : ["conversation", "read", "write_edit", "activity_inspect"];
  }

  /** Attach multiple pooled MCP servers concurrently. */
  async addPooledMcpServers(opts: McpServerOptions[], pool: McpRuntimePool): Promise<ProviderListItem[]> {
    return Promise.all(opts.map((o) => this.addPooledMcpServer(o, pool)));
  }
  addSkill(input: Omit<ProviderInput, "kind"> & { kind?: "skill" }): ProviderListItem {
    return this.registry.add({ ...input, kind: "skill" });
  }
  /** Extra tools the given categorizer receives on top of its own setup list. */
  toolsForCategorizer(id: string): AgentTool[] {
    return this.orchestrator.extraToolsFor(id);
  }

  // ---- Per-categorizer toolset customization --------------------------------

  /** Set/clear EXTRA tools for a categorizer (exact list, filter, or resolver). */
  setCategorizerTools(id: string, spec: CategorizerToolSpec | undefined): void {
    this.orchestrator.setCategorizerTools(id, spec);
  }
  /** Move a single tool between categorizers (e.g. a custom screenshot tool → activity_inspect). */
  setToolCategorizers(toolName: string, ids: string[]): boolean {
    return this.registry.setToolCategorizers(toolName, ids);
  }
  /** Move a whole provider/MCP between categorizers. */
  setProviderCategorizers(providerId: string, ids: string[]): boolean {
    return this.registry.setProviderCategorizers(providerId, ids);
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

  /**
   * Run the categorizer chain — the primary (and only) execution entry point.
   */
  async run(task: string, opts: RunOptions = {}): Promise<RunLoopResult> {
    this.assertLive();
    const { signal, done } = await this.beginRun(opts.signal);
    const followUpContext = this.resolveFollowUpContext(opts.followUpContext);
    let writtenPaths: string[] | undefined;
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
      writtenPaths = result.threadSnapshot?.writtenPaths;
      return result;
    } finally {
      await done({ writtenPaths });
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

  /**
   * Host-side reconciliation after each categorizer hop. The read categorizer's
   * deliverable carries the durable corrections the old Prepare phase used to
   * emit: project category, memory updates. Presets re-apply when the category
   * changed. Provider assignment plumbing is retired — mention-resolved and
   * preset-scoped tools flow through the categorizer toolset directly.
   */
  private async reconcileAfterCategorizer(hop: CategorizerHop, _signal?: AbortSignal): Promise<void> {
    if (hop.id !== "read") return;
    const deliverable = hop.deliverable as
      | { memoryUpdates?: string[]; projectCategory?: import("./presets/project-presets.js").ProjectCategory }
      | undefined;
    if (!deliverable) return;
    const { memoryUpdates, projectCategory } = deliverable;

    if (this.memory && projectCategory && this.memory.category !== projectCategory) {
      await this.memory.setCategory(projectCategory, { auto: false });
    }
    // Thread the corrected category live to the orchestrator so the non-UI skip
    // (inspiration/assets/design-skill) reflects the post-read verdict, not the
    // preset guess. Memory is the source of truth once the read reconciled.
    const liveCategory = this.memory?.category ?? projectCategory;
    if (liveCategory) this.orchestrator.projectCategory = liveCategory;

    if (this.memory && memoryUpdates?.length) {
      const known = new Set(this.memory.data.facts.map((f) => f.text.trim().toLowerCase()));
      for (const update of memoryUpdates) {
        const text = update.trim();
        if (!text || known.has(text.toLowerCase())) continue;
        await this.memory.remember(text, { tags: ["read", "handoff"], source: "read" });
        known.add(text.toLowerCase());
      }
    }

    if (projectCategory && this.projectPresetReconciliation && this.orchestrator.projectCategory !== projectCategory) {
      await applyProjectPreset(this, projectCategory, {
        ...this.projectPresetReconciliation,
        applyPolicy: true,
        setModels: false,
      });
    }

    this.logStore.append({
      tags: ["categorizer", "handoff", "read", `session:${this.id}`],
      level: "info",
      message: "read reconciliation complete",
      data: { projectCategory, memoryUpdates: memoryUpdates?.length ?? 0 },
    });
  }

  /** Create a run-scoped abort signal linked to any external signal + session abort. */
  private async beginRun(
    external?: AbortSignal,
  ): Promise<{ signal: AbortSignal; done: (summary?: { writtenPaths?: string[] }) => Promise<void> }> {
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
      done: async (summary) => {
        try {
          await this.runLifecycleHooks?.onRunEnd?.(summary);
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

/** Accept either a full setup or a bare category list (defaults filled in). */
function normalizeCategorizerSetup(
  setup: CategorizerSetup | CategorizerDefinition[],
): CategorizerSetup {
  return Array.isArray(setup) ? createCategorizerSetup({ categories: setup }) : setup;
}
