/**
 * Turing Harness — the top-level entry point and **session manager**.
 *
 * A Harness holds shared, stateless configuration (the OpenRouter LLM bridge, model
 * defaults, asset/audit backends) and mints isolated {@link Session}s. Each session
 * runs independently, so a single process — e.g. one Electron app with several
 * project tabs — can run many `runChain`/`runPhase` operations in parallel with no
 * cross-talk (separate registries, logs, permission gates, model overrides, event
 * streams, and abort scopes).
 *
 * For convenience and backward compatibility, the Harness also exposes a lazily
 * created **default session** and proxies the single-session methods
 * (`runChain`, `runPhase`, `subscribe`, registry APIs, ...) to it. New multi-session
 * code should call {@link Harness.createSession} explicitly.
 *
 * Runs in Node and in an Electron main process (pure Node built-ins + fetch).
 */
import * as path from "node:path";

import type {
  AgentEvent,
  AgentTool,
  LLMBridge,
  PermissionCallback,
  PermissionMode,
  Phase,
  PhaseResult,
  RunLoopResult,
  ThreadRunSnapshot,
  TranscriptMode,
} from "./types.js";
import type {
  PhaseToolSpec,
  ProviderInput,
  ProviderListItem,
  Registry,
  ToolCategorizer,
} from "./registry/registry.js";
import type { LogStore } from "./logging/logger.js";
import type { PermissionGate } from "./orchestrator/permission.js";
import type { ChainResult, Orchestrator, OrchestratorConfig, RunChainOptions, RunOptions, RunPhaseOptions } from "./orchestrator/orchestrator.js";
import { OpenRouterBridge } from "./llm/bridge.js";
import type { McpServerOptions } from "./mcp/client.js";
import type { AssetsGeneratorConfig } from "./tools/builtin/assets-generator.js";
import type { MediaAnalysisConfig } from "./tools/builtin/media-analysis.js";
import type { WebConfig } from "./tools/builtin/web.js";
import type { PlanToolConfig } from "./tools/builtin/plan.js";
import type { InspirationGeneratorConfig } from "./tools/builtin/inspiration-generator.js";
import { HarnessAgent, type AgentHost, type HarnessAgentOptions } from "./agent.js";
import { Session, type SessionInfo, type SessionOptions } from "./session.js";
import {
  applyProjectPreset,
  type ApplyPresetOptions,
  type ApplyPresetReport,
  type ProjectCategory,
} from "./presets/project-presets.js";
import { FileMemory } from "./memory/file-memory.js";
import { FileMemoryRuntime, type FileMemoryRuntimeOptions } from "./memory/file-memory-runtime.js";
import { GraphMemory } from "./memory/graph-memory.js";
import { ProjectMemory } from "./memory/project-memory.js";
import { ProjectWatcherRuntime } from "./memory/project-watcher-runtime.js";
import { detectProject } from "./memory/detect.js";
import { createGraphMemoryTool } from "./tools/builtin/graph-memory.js";
import { createFileMemoryTool } from "./tools/builtin/file-memory.js";
import { createProjectMemoryTool } from "./tools/builtin/project-memory.js";

export interface HarnessConfig extends Omit<OrchestratorConfig, "registry" | "logStore" | "permission" | "llm"> {
  /**
   * OpenRouter API key (else read from OPENROUTER_API_KEY).
   *
   * Pass a function when the credential is short-lived (e.g. a host proxying
   * through its own backend with a renewed JWT): it is resolved per request, so
   * a token rotated mid-run reaches the very next turn instead of leaving the
   * run to 401 on the value captured here.
   */
  apiKey?: string | (() => string | undefined);
  /** Override the base URL (any OpenAI-compatible endpoint). */
  baseUrl?: string;
  /** Provide a custom LLM bridge (defaults to OpenRouter). Shared by all sessions. */
  llm?: LLMBridge;
  /** Default permission mode for new sessions (req #7). Default "ask-mutations". */
  permissionMode?: PermissionMode;
  /** Default permission callback for new sessions. */
  permissionCallback?: PermissionCallback;
  /** Skip registering the bundled internal tools in new sessions. */
  registerBuiltins?: boolean;
  /** Default backends for the assets_generator tool. */
  assets?: AssetsGeneratorConfig;
  /** Default config for the media_analysis tool. */
  mediaAnalysis?: MediaAnalysisConfig;
  /**
   * Multimodal slug used to describe images a TOOL returns when the run model
   * cannot read them. Defaults to `mediaAnalysis.model` when that is set, so a
   * host configuring vision once gets both behaviours.
   */
  visionModel?: string;
  /** Config for `create_plan`, including its replaceable planning prompt. */
  plan?: PlanToolConfig;
  /** Config for `web_search` / `web_fetch` (engine, model, limits, custom backend). */
  web?: WebConfig;
  /**
   * Config for the `inspiration_generator` tool — a host-injected keyword
   * lookup returning a reusable UI/poster/parallax blueprint (or null). The
   * harness owns no HTTP client; the host wires the real backend here.
   */
  inspiration?: InspirationGeneratorConfig;
  /** Default model used by activity_monitor's "study" action. */
  studyModel?: string;
  /**
   * Register `write`/`edit` in content-less author-only mode for new sessions
   * (see BuiltinToolsConfig.authorOnlyWrites). The calling model emits only the
   * path (+ `oldString` for edit); a resolved authoring model authors the bytes,
   * eliminating the wasted full-file draft. Only meaningful when an authoring
   * model is configured; default false keeps today's behaviour.
   */
  authorOnlyWrites?: boolean;
  /** Default custom 4P categorization strategy for new sessions' registries. */
  categorizer?: ToolCategorizer;
  /** Default transcript emission mode for new sessions. */
  transcriptMode?: TranscriptMode;
}

/** Options for {@link Harness.createProjectSession}. */
export interface ProjectSessionOptions extends SessionOptions, ApplyPresetOptions {
  /** Persist project memory to disk (default true). Set false to skip `.turing/`. */
  memory?: boolean;
  /** Memory directory relative to cwd (default ".turing"). */
  memoryDir?: string;
  /** Re-run stack detection even if a memory already exists. */
  detect?: boolean;
  /** Optional file-memory runtime overrides for watcher/hydration behavior. */
  fileMemoryRuntime?: Omit<Partial<FileMemoryRuntimeOptions>, "cwd" | "llm" | "memory">;
}

export interface ProjectSessionResult {
  session: Session;
  report: ApplyPresetReport;
  /** The project's durable memory (undefined when `memory: false`). */
  memory?: ProjectMemory;
  /** The project's durable file-memory index (undefined when `memory: false`). */
  fileMemory?: FileMemory;
  /** The per-session background file-memory runtime (undefined when `memory: false`). */
  fileMemoryRuntime?: FileMemoryRuntime;
  /** The project's durable dependency graph memory (undefined when `memory: false`). */
  graphMemory?: GraphMemory;
}

export class Harness implements AgentHost {
  readonly llm: LLMBridge;
  private readonly config: HarnessConfig;
  private readonly sessions = new Map<string, Session>();
  private readonly projectWatchers = new Map<string, { runtime: ProjectWatcherRuntime; refCount: number }>();
  /** Stateless providers registered into every new session. */
  private readonly sharedProviders: ProviderInput[] = [];
  /** Cross-session event listeners: receive (sessionId, event). */
  private readonly globalListeners = new Set<(sessionId: string, e: AgentEvent) => void>();
  private readonly sessionUnsubs = new Map<string, () => void>();
  private readonly sessionProjectWatchers = new Map<string, string>();
  private _default?: Session;

  constructor(config: HarnessConfig = {}) {
    this.config = config;
    this.llm = config.llm ?? new OpenRouterBridge({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  }

  // ---- Session lifecycle (multi-session) ---------------------------------

  /** Create a new isolated session. Manager defaults are applied, then `opts`. */
  createSession(opts: SessionOptions = {}): Session {
    const merged: SessionOptions = {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      permissionCallback: this.config.permissionCallback,
      models: this.config.models,
      toolModelCandidates: this.config.toolModelCandidates,
      ...(this.config.routeModel ? { routeModel: this.config.routeModel } : {}),
      phaseTools: this.config.phaseTools,
      maxSteps: this.config.maxSteps,
      reasoning: this.config.reasoning,
      temperature: this.config.temperature,
      maxChainIterations: this.config.maxChainIterations,
      transcriptMode: this.config.transcriptMode,
      registerBuiltins: this.config.registerBuiltins,
      assets: this.config.assets,
      mediaAnalysis: this.config.mediaAnalysis,
      ...(this.config.visionModel ?? this.config.mediaAnalysis?.model
        ? { visionModel: this.config.visionModel ?? this.config.mediaAnalysis?.model }
        : {}),
      plan: this.config.plan,
      web: this.config.web,
      inspiration: this.config.inspiration,
      studyModel: this.config.studyModel,
      ...(this.config.authorOnlyWrites ? { authorOnlyWrites: true } : {}),
      categorizer: this.config.categorizer,
      ...opts,
      // Shared providers are prepended; per-session `providers` come after.
      providers: [...this.sharedProviders.map(stripDispose), ...(opts.providers ?? [])],
    };
    const session = new Session({ llm: this.llm }, merged);
    this.sessions.set(session.id, session);
    // Fan session events out to cross-session listeners.
    const unsub = session.subscribe((e) => {
      for (const l of this.globalListeners) l(session.id, e);
    });
    this.sessionUnsubs.set(session.id, unsub);
    return session;
  }

  /**
   * Create a session pre-wired for a project.
   *
   * Project memory (req): the first time a project directory is opened, its tech
   * stack is detected and a durable memory is written to `<cwd>/.turing/` recording
   * the category (frontend/mobile/games/backend) + stack. On later opens the memory
   * is loaded, and its category selects the 4P preset — so you don't have to pass
   * the category every time.
   *
   * Call with an explicit category, or omit it to use memory/auto-detection:
   *   createProjectSession("backend", { connectMcp: true, dbUrl })
   *   createProjectSession({ cwd, connectMcp: true })   // category from memory
   *
   * The phase-tool policy + model defaults apply synchronously; the preset's MCP
   * servers spawn only when `connectMcp: true` (missing ones are reported, not
   * thrown). Set `memory: false` to skip the on-disk memory entirely.
   */
  createProjectSession(category: ProjectCategory, opts?: ProjectSessionOptions): Promise<ProjectSessionResult>;
  createProjectSession(opts?: ProjectSessionOptions): Promise<ProjectSessionResult>;
  async createProjectSession(
    a?: ProjectCategory | ProjectSessionOptions,
    b?: ProjectSessionOptions,
  ): Promise<ProjectSessionResult> {
    const explicit = typeof a === "string" ? a : undefined;
    const opts: ProjectSessionOptions = (typeof a === "string" ? b : a) ?? {};
    const cwd = opts.cwd ?? this.config.cwd ?? process.cwd();

    // Resolve the project's memory + category.
    let memory: ProjectMemory | undefined;
    let fileMemory: FileMemory | undefined;
    let graphMemory: GraphMemory | undefined;
    let category: ProjectCategory;
    if (opts.memory === false) {
      // No persistence: use explicit category, else detect (without writing).
      category = explicit ?? (await detectProject(cwd)).category;
    } else {
      memory = await ProjectMemory.open(cwd, { dir: opts.memoryDir, forceDetect: opts.detect });
      fileMemory = await FileMemory.open(cwd, { dir: opts.memoryDir, forceReindex: opts.detect });
      graphMemory = await GraphMemory.open(cwd, {
        dir: opts.memoryDir,
        forceReindex: opts.detect,
        stack: memory.stack,
        category: memory.category,
      });
      if (explicit && explicit !== memory.category) {
        await memory.setCategory(explicit, { auto: false }); // caller override persists
      }
      category = explicit ?? memory.category;
    }

    const session = this.createSession({ ...opts, cwd, preset: category });
    session.configureProjectReconciliation({
      connectMcp: opts.connectMcp,
      cwd,
      env: opts.env,
      dbUrl: opts.dbUrl,
      filesystemDir: opts.filesystemDir,
      engineCommand: opts.engineCommand,
    });
    if (memory) {
      session.memory = memory;
      // Give the agent read/write access to the project's durable memory.
      session.addProvider({
        id: "builtin:project_memory",
        kind: "tool",
        source: "internal",
        name: "project_memory",
        tools: [createProjectMemoryTool(memory)],
      });
    }
    if (fileMemory) {
      session.fileMemory = fileMemory;
      session.addProvider({
        id: "builtin:file_memory",
        kind: "tool",
        source: "internal",
        name: "file_memory",
        tools: [createFileMemoryTool(fileMemory)],
      });
      session.fileMemoryRuntime = new FileMemoryRuntime({
        cwd,
        llm: session.llm,
        memory: fileMemory,
        ...opts.fileMemoryRuntime,
        watch: false,
      });
      session.fileMemoryRuntime.startInitialHydration();
    }
    if (graphMemory) {
      session.graphMemory = graphMemory;
      session.addProvider({
        id: "builtin:graph_memory",
        kind: "tool",
        source: "internal",
        name: "graph_memory",
        tools: [createGraphMemoryTool(graphMemory, fileMemory)],
      });
    }
    if ((session.fileMemoryRuntime || graphMemory) && opts.fileMemoryRuntime?.watch !== false) {
      const projectWatcher = this.acquireProjectWatcher(cwd);
      projectWatcher.subscribe(session.id, {
        fileMemoryRuntime: session.fileMemoryRuntime,
        graphMemory,
      });
      session.configureRunLifecycleHooks({
        onRunStart: () => projectWatcher.suspend(session.id),
        onRunEnd: () => projectWatcher.resume(session.id),
      });
      this.sessionProjectWatchers.set(session.id, this.projectWatcherKey(cwd));
    }

    // Policy already merged at construction (explicit opts win), so only connect
    // MCP here — don't re-apply the policy over the explicit overrides.
    const report = await applyProjectPreset(session, category, { ...opts, applyPolicy: false });
    return { session, report, memory, fileMemory, fileMemoryRuntime: session.fileMemoryRuntime, graphMemory };
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Dispose and remove a session (aborts its in-flight runs, stops its MCPs). */
  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.releaseProjectWatcherForSession(id);
    this.sessionUnsubs.get(id)?.();
    this.sessionUnsubs.delete(id);
    this.sessions.delete(id);
    if (this._default === session) this._default = undefined;
    await session.dispose();
  }

  /** Subscribe to events from ALL sessions, tagged with the originating id. */
  subscribeAll(fn: (sessionId: string, e: AgentEvent) => void): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  /**
   * Register a stateless provider (plain tools/skills) shared by every session.
   * Live resources (MCP servers) should be added per-session via `addMcpServer`.
   */
  addSharedProvider(input: ProviderInput): void {
    const clean = stripDispose(input);
    this.sharedProviders.push(clean);
    for (const s of this.sessions.values()) s.registry.add(clean);
  }

  // ---- Default session (backward-compatible single-session API) ----------

  /** The lazily created default session used by the proxy methods below. */
  get default(): Session {
    if (!this._default) this._default = this.createSession({ id: "default" });
    return this._default;
  }

  get registry(): Registry {
    return this.default.registry;
  }
  get logStore(): LogStore {
    return this.default.logStore;
  }
  get permission(): PermissionGate {
    return this.default.permission;
  }
  get orchestrator(): Orchestrator {
    return this.default.orchestrator;
  }
  get threadSnapshot(): ThreadRunSnapshot | undefined {
    return this.default.threadSnapshot;
  }

  listCapabilities(filter?: Parameters<Registry["list"]>[0]): ProviderListItem[] {
    return this.default.listCapabilities(filter);
  }
  addProvider(input: ProviderInput): ProviderListItem {
    return this.default.addProvider(input);
  }
  removeProvider(id: string): Promise<boolean> {
    return this.default.removeProvider(id);
  }
  addMcpServer(opts: McpServerOptions): Promise<ProviderListItem> {
    return this.default.addMcpServer(opts);
  }
  addSkill(input: Omit<ProviderInput, "kind"> & { kind?: "skill" }): ProviderListItem {
    return this.default.addSkill(input);
  }
  toolsForPhase(phase: Phase): AgentTool[] {
    return this.default.toolsForPhase(phase);
  }
  setPhaseTools(phase: Phase, spec: PhaseToolSpec | undefined): void {
    this.default.setPhaseTools(phase, spec);
  }
  setToolPhases(toolName: string, phases: Phase[]): boolean {
    return this.default.setToolPhases(toolName, phases);
  }
  setProviderPhases(providerId: string, phases: Phase[]): boolean {
    return this.default.setProviderPhases(providerId, phases);
  }
  setPermissionMode(mode: PermissionMode): void {
    this.default.setPermissionMode(mode);
  }
  /** Install the plan-review callback on the default session. */
  setPlanApprovalCallback(cb: import("./types.js").PlanApprovalCallback | undefined): void {
    this.default.setPlanApprovalCallback(cb);
  }

  setPermissionCallback(cb: PermissionCallback | undefined): void {
    this.default.setPermissionCallback(cb);
  }
  runPhase(phase: Phase, task: string, opts?: RunPhaseOptions): Promise<PhaseResult> {
    return this.default.runPhase(phase, task, opts);
  }
  runChain(task: string, opts?: RunChainOptions): Promise<ChainResult> {
    return this.default.runChain(task, opts);
  }
  /** Flat loop driver — the primary entry point (delegates to the default session). */
  run(task: string, opts?: RunOptions): Promise<RunLoopResult> {
    return this.default.run(task, opts);
  }
  subscribe(fn: (e: AgentEvent) => void): () => void {
    return this.default.subscribe(fn);
  }
  clearThreadSnapshot(): void {
    this.default.clearThreadSnapshot();
  }
  phaseTools(): AgentTool[] {
    return this.default.phaseTools();
  }
  chainTool(): AgentTool {
    return this.default.chainTool();
  }
  createAgent(opts?: HarnessAgentOptions): HarnessAgent {
    return this.default.createAgent(opts);
  }

  // ---- Teardown ----------------------------------------------------------

  /** Dispose every session and release all external resources. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private acquireProjectWatcher(cwd: string): ProjectWatcherRuntime {
    const key = this.projectWatcherKey(cwd);
    const existing = this.projectWatchers.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing.runtime;
    }
    const runtime = new ProjectWatcherRuntime({ cwd: key });
    this.projectWatchers.set(key, { runtime, refCount: 1 });
    return runtime;
  }

  private releaseProjectWatcherForSession(sessionId: string): void {
    const key = this.sessionProjectWatchers.get(sessionId);
    if (!key) return;
    this.sessionProjectWatchers.delete(sessionId);
    const entry = this.projectWatchers.get(key);
    if (!entry) return;
    entry.runtime.unsubscribe(sessionId);
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    this.projectWatchers.delete(key);
    void entry.runtime.dispose().catch(() => undefined);
  }

  private projectWatcherKey(cwd: string): string {
    return path.resolve(cwd);
  }
}

/** Copy a provider without its dispose hook (manager owns shared lifecycles). */
function stripDispose(input: ProviderInput): ProviderInput {
  if (!input.dispose) return input;
  const { dispose: _drop, ...rest } = input;
  return rest;
}
