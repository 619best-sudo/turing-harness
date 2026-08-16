/**
 * Orchestrator (v2 — the categorizer chain).
 *
 * The orchestrator owns CONFIG and PLUMBING only: models, permission gate,
 * registry, event fan-out, thread snapshots. The run itself is the categorizer
 * chain (src/categorizer/chain.ts): a router picks one focused categorizer at a
 * time, each runs a fresh scoped tool loop with its own driver model and a
 * terminal `deliver` tool, and the chain hops (read → write_edit ↔
 * activity_inspect → summarise) until the work is done.
 *
 * The per-call escalation machinery is untouched and lives in the tool loop:
 * Model-B authoring for write/edit by complexity/category, staged-read
 * comprehension, routeModel/toolModelCandidates, declared/measured complexity
 * floors. This file only resolves WHICH model drives each categorizer.
 */
import type {
  AgentEvent,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  LiveImage,
  LLMBridge,
  MediaRef,
  Model,
  PlanApprovalCallback,
  PlanSet,
  RunLoopResult,
  RunStep,
  ThreadFollowUpContext,
  ThreadRunDisposition,
  ThreadRunSnapshot,
  ThinkingLevel,
  TranscriptMode,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import type { ModelRouter } from "../types.js";
import { Registry } from "../registry/registry.js";
import { LogStore } from "../logging/logger.js";
import { PermissionGate } from "./permission.js";
import { ClarifyGate } from "./clarify-gate.js";
import { detectProject } from "../memory/detect.js";
import type { ProjectCategory } from "../presets/project-presets.js";
import { OpenRouterBridge } from "../llm/bridge.js";
import { DEFAULT_PHASE_MODELS } from "../llm/models.js";
import { DEFAULT_CATEGORIZER_SETUP, type CategorizerSetup } from "../categorizer/setup.js";
import type { CategorizerDefinition } from "../categorizer/types.js";
import { DEFAULT_DOUBT_MODEL } from "../categorizer/clearing-doubt.js";
import { runCategorizerChain, type CategorizerChainInput } from "../categorizer/chain.js";

/** Where a request is routed after the router's first choice. */
export type ChainRoute = "conversational" | "task";

/**
 * Model role slots. The KEYS are kept from the 4P era for config compatibility;
 * in v2 they mean:
 *   - orchestrator: escalation/doubt tier fallback (clearing_doubt)
 *   - prepare:      router + conversation categorizer driver
 *   - perform:      work categorizer drivers (read/write_edit/activity_inspect)
 *   - perfect:      the closing summary turn
 *   - plan:         unused (planning happens inside write_edit via create_plan)
 */
export interface PhaseModelConfig {
  orchestrator?: string;
  prepare?: string;
  plan?: string;
  perform?: string;
  perfect?: string;
}

export interface OrchestratorConfig {
  cwd?: string;
  llm?: LLMBridge;
  registry?: Registry;
  logStore?: LogStore;
  permission?: PermissionGate;
  /** Role-slot model slugs (see PhaseModelConfig). */
  models?: PhaseModelConfig;
  /** Candidate model slugs the permission layer may pick from for tool calls. */
  toolModelCandidates?: string[];
  /**
   * Mirrors `BuiltinToolsConfig.authorOnlyWrites`. The orchestrator does not
   * build tools, so it cannot infer this from the registry — under that mode
   * the toolset still contains a tool NAMED `bash`, just a guarded one that
   * refuses to author source. Carried so the categorizer prompts stop advising
   * a shell fallback the runtime rejects.
   */
  authorOnlyWrites?: boolean;
  /** Multimodal slug used to describe tool images for a text-only run model. */
  visionModel?: string;
  /**
   * Host-owned escalation routing: (kind, rating) → model slug. Threaded into
   * every categorizer loop, which uses it for write/edit authoring and hands it
   * to tools as `ctx.routeModel` for staged reads.
   */
  routeModel?: ModelRouter;
  /**
   * The categorizer setup driving runs. Defaults to the four built-in
   * categories (conversation / read / write_edit / activity_inspect) with the
   * standard transition graph. Apps replace or extend via categorizer-setup.
   */
  categorizerSetup?: CategorizerSetup;
  maxSteps?: number;
  reasoning?: ThinkingLevel;
  temperature?: number;
  transcriptMode?: TranscriptMode;
  autoTriageAttachments?: boolean;
  signal?: AbortSignal;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Optional host callback for `ask_user_question`, threaded into the loops. */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  /**
   * Host callback for `create_plan` review (the plan CARD). In v2 the card
   * shows only when `planMode` is true AND this callback exists; otherwise the
   * plan tool auto-approves its first draft silently.
   */
  planApproval?: PlanApprovalCallback;
  /** Structured continuity from the previous completed run in this session. */
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
  /** Emit the model's reasoning blocks to the UI. */
  emitReasoning?: boolean;
  /** Same, for assistant text. */
  emitText?: boolean;
  /** Image refs made available to the loops' write/edit authoring passes. */
  images?: Array<{ path: string; mimeType: string }>;
  /** Non-image attachment refs (documents, audio, video, data files). */
  files?: Array<{ path: string; mimeType: string }>;
  /**
   * PLAN MODE: show the create_plan review card to the user. Defaults to the
   * legacy `!skipPlan` (planning on). `create_plan` always runs in write_edit
   * either way — this only controls whether the user reviews it.
   */
  planMode?: boolean;
  /**
   * Legacy planning toggle. In v2 it only seeds the default for `planMode`.
   */
  skipPlan?: boolean;
  /**
   * Optional hard cap on tool-call turns per categorizer hop.
   */
  maxStepsPerStep?: number;
  /**
   * Whether this run is fixing a REPORTED BUG. A hint in v2: it biases the
   * router (read → activity_inspect before write_edit) and injects the
   * bug-fix directive into write_edit's prompt. The reproduce/verify gates of
   * the classic run are retired — inspection is the categorizer's job now.
   */
  isBugFix?: boolean;
  /**
   * Whether an activity_inspect hop is offered after writes (default true).
   * `false` discourages the router from picking activity_inspect.
   */
  verify?: boolean;
}

/**
 * The categorizer chain driver. Owns config resolution + event fan-out; the
 * chain (src/categorizer/chain.ts) owns the run itself.
 */
export class Orchestrator {
  readonly cwd: string;
  readonly llm: LLMBridge;
  readonly registry: Registry;
  readonly logStore: LogStore;
  readonly permission: PermissionGate;
  protected readonly config: OrchestratorConfig;
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  /** Role-slot model overrides (setModel targets). */
  private readonly modelOverrides: Record<string, string> = {};
  /** Per-categorizer driver overrides (setModel("<categorizer>", slug)). */
  private readonly categorizerModelOverrides: Record<string, string> = {};
  private readonly reasoningOverrides: Record<string, ThinkingLevel> = {};
  private toolModelCandidates: string[] | undefined;
  private routeModelFn: ModelRouter | undefined;
  private clarifyGate = new ClarifyGate();
  private setup: CategorizerSetup;
  private detectedCategory?: ProjectCategory;
  /** Extra tool specs per categorizer (presets, hosts). */
  private readonly categorizerToolSpecs = new Map<string, import("../registry/registry.js").CategorizerToolSpec>();
  /** Host callback after each completed categorizer hop. */
  private afterCategorizerHook?: (
    hop: import("../categorizer/types.js").CategorizerHop,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  /** Session-level plan review callback (used when a run passes none). */
  private planApprovalCb?: PlanApprovalCallback;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.cwd = config.cwd ?? process.cwd();
    this.llm = config.llm ?? new OpenRouterBridge();
    this.registry = config.registry ?? new Registry();
    this.logStore = config.logStore ?? new LogStore();
    this.permission = config.permission ?? new PermissionGate("ask-mutations");
    this.toolModelCandidates = config.toolModelCandidates;
    this.routeModelFn = config.routeModel;
    this.setup = config.categorizerSetup ?? DEFAULT_CATEGORIZER_SETUP;
  }

  // ---- events -------------------------------------------------------------

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected emit(e: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a throwing subscriber never breaks the run
      }
    }
  }

  // ---- configuration ------------------------------------------------------

  /** The active categorizer setup. */
  get categorizerSetup(): CategorizerSetup {
    return this.setup;
  }

  /** Replace the categorizer setup (validated by the caller). */
  setCategorizerSetup(setup: CategorizerSetup): void {
    this.setup = setup;
  }

  setToolModelCandidates(candidates: string[] | undefined): void {
    this.toolModelCandidates = candidates;
  }

  setRouteModel(router: ModelRouter | undefined): void {
    this.routeModelFn = router;
  }

  /**
   * Set a model by ROLE SLOT ("orchestrator" | "prepare" | "plan" | "perform" |
   * "perfect") or by CATEGORIZER ID ("read", "write_edit", …) — a categorizer id
   * pins that categorizer's driver model.
   */
  setModel(target: string, slug: string): void {
    const roleSlots = new Set(["orchestrator", "prepare", "plan", "perform", "perfect"]);
    if (roleSlots.has(target)) this.modelOverrides[target] = slug;
    else this.categorizerModelOverrides[target] = slug;
    this.logStore.append({
      tags: ["orchestrator", "models"],
      level: "info",
      message: `model override: ${target} → ${slug}`,
    });
  }

  setReasoning(level: ThinkingLevel, target?: string): void {
    if (target) this.reasoningOverrides[target] = level;
    else this.config.reasoning = level;
  }

  /** Resolve a role-slot slug with the precedence: override → config → default. */
  protected roleModelSlug(slot: keyof PhaseModelConfig): string {
    return (
      this.modelOverrides[slot] ??
      this.config.models?.[slot] ??
      DEFAULT_PHASE_MODELS[slot] ??
      "xiaomi/mimo-v2.5"
    );
  }

  /**
   * Resolve the driver model for a categorizer:
   * per-categorizer override → the definition's own `model` → role slot
   * (conversation → prepare; everything else → perform).
   */
  protected modelForCategorizer(def: CategorizerDefinition): Model {
    const slug =
      this.categorizerModelOverrides[def.id] ??
      def.model ??
      (def.id === "conversation" ? this.roleModelSlug("prepare") : this.roleModelSlug("perform"));
    return this.llm.resolveModel(slug);
  }

  // ---- project category ---------------------------------------------------

  /** The host-set project category (via Session presets), if any. Public so the
   *  Session can thread preset/reconciled categories live. */
  projectCategory?: ProjectCategory;

  private async effectiveCategory(): Promise<ProjectCategory | undefined> {
    if (this.projectCategory) return this.projectCategory;
    if (this.detectedCategory) return this.detectedCategory;
    try {
      const detected = await detectProject(this.cwd);
      this.detectedCategory = detected.category;
      this.logStore.append({
        tags: ["project", "category"],
        level: "info",
        message:
          `no project category supplied by the host; detected "${detected.category}" ` +
          `(confidence ${detected.confidence.toFixed(2)}) from the workspace`,
        data: { category: detected.category, evidence: detected.evidence },
      });
      return this.detectedCategory;
    } catch {
      return undefined;
    }
  }

  // ---- the run ------------------------------------------------------------

  /**
   * Run the categorizer chain. Emits the pi-compatible events (message_*,
   * turn_*, tool_execution_*, permission_*) plus the namespaced
   * categorizer_start/categorizer_end pair per hop. Returns the same
   * `RunLoopResult` shape the classic run did.
   */
  async run(task: string, opts: RunOptions = {}): Promise<RunLoopResult> {
    const signal = opts.signal ?? this.config.signal;
    const projectCategory = await this.effectiveCategory();

    // planMode default: the legacy skipPlan=false ⇒ planning review on.
    const planMode = opts.planMode ?? !opts.skipPlan;

    const input: CategorizerChainInput = {
      task,
      setup: this.setup,
      llm: this.llm,
      permission: this.permission,
      registry: this.registry,
      logStore: this.logStore,
      emit: (e) => this.emit(e),
      cwd: this.cwd,
      ...(signal ? { signal } : {}),
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.files?.length ? { files: opts.files } : {}),
      ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
      ...(opts.planApproval ?? this.planApprovalCb ? { planApproval: opts.planApproval ?? this.planApprovalCb } : {}),
      planMode,
      ...(opts.transcriptMode ?? this.config.transcriptMode
        ? { transcriptMode: opts.transcriptMode ?? this.config.transcriptMode }
        : {}),
      ...(opts.emitReasoning != null ? { emitReasoning: opts.emitReasoning } : {}),
      ...(opts.emitText != null ? { emitText: opts.emitText } : {}),
      ...(this.toolModelCandidates?.length ? { toolModelCandidates: this.toolModelCandidates } : {}),
      ...(this.routeModelFn ? { routeModel: this.routeModelFn } : {}),
      ...(this.config.visionModel ? { visionModel: this.config.visionModel } : {}),
      ...(this.config.authorOnlyWrites != null
        ? { authorOnlyWrites: this.config.authorOnlyWrites }
        : {}),
      ...(opts.isBugFix != null ? { isBugFix: opts.isBugFix } : {}),
      autoTriageAttachments: this.config.autoTriageAttachments !== false,
      verifyEnabled: opts.verify !== false,
      ...(opts.maxStepsPerStep ?? this.config.maxSteps != null
        ? { maxStepsPerCategorizer: opts.maxStepsPerStep ?? this.config.maxSteps }
        : {}),
      ...(this.config.temperature != null ? { temperature: this.config.temperature } : {}),
      ...(this.config.reasoning ? { reasoning: this.config.reasoning } : {}),
      reasoningFor: (def) =>
        this.reasoningOverrides[def.id] ??
        this.reasoningOverrides[def.id === "conversation" ? "prepare" : "perform"],
      ...(projectCategory ? { projectCategory } : {}),
      ...(opts.followUpContext ? { followUpContext: opts.followUpContext } : {}),
      modelFor: (def) => this.modelForCategorizer(def),
      extraToolsFor: (id) => this.extraToolsFor(id),
      ...(this.afterCategorizerHook
        ? { afterCategorizer: (hop, def) => this.afterCategorizerHook!(hop, signal) }
        : {}),
      routerModel: this.llm.resolveModel(this.setup.routerModel ?? this.roleModelSlug("prepare")),
      summaryModel: this.llm.resolveModel(this.roleModelSlug("perfect")),
      doubtModel: this.llm.resolveModel(
        this.setup.doubtModel ?? this.roleModelSlug("orchestrator") ?? DEFAULT_DOUBT_MODEL,
      ),
    };

    const result = await runCategorizerChain(input);
    const usage = result.usage ?? emptyUsage();

    const snapshot = buildRunThreadSnapshot({
      task,
      route: result.route,
      success: result.success,
      summary: result.summary ?? "",
      usage,
      writtenPaths: result.writtenPaths,
      readPaths: result.readPaths,
      discoveredPaths: result.discoveredPaths,
      steps: result.steps,
      ...(result.planSet ? { planSet: result.planSet } : {}),
      ...(result.pendingUserQuestion ? { pendingUserQuestion: result.pendingUserQuestion } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.verified != null ? { verified: result.verified } : {}),
    });

    this.logStore.append({
      tags: ["run", "run:end"],
      level: result.success ? "info" : "error",
      message:
        `run ${result.success ? "completed" : "ended unsuccessfully"}: ` +
        `${result.hops.length} categorizer hop(s) [${result.hops.map((h) => h.id).join(" → ") || "none"}], ` +
        `${result.writtenPaths.length} written, route=${result.route}`,
      data: { hops: result.hops.map((h) => h.id), written: result.writtenPaths.length },
    });

    return {
      task,
      route: result.route,
      success: result.success,
      ...(result.summary ? { summary: result.summary } : {}),
      steps: result.steps,
      ...(result.planSet ? { planSet: result.planSet } : {}),
      refs: result.refs,
      usage,
      ...(result.pendingUserQuestion ? { pendingUserQuestion: result.pendingUserQuestion } : {}),
      ...(result.error ? { error: result.error } : {}),
      threadSnapshot: snapshot,
      ...(result.verified != null ? { verified: result.verified } : {}),
    };
  }

  /** Exposed for the Session's ask_user_question wiring. */
  get sharedClarifyGate(): ClarifyGate {
    return this.clarifyGate;
  }

  // ---- categorizer tool specs + hooks -------------------------------------

  /** Set/clear EXTRA tools for a categorizer (exact list, filter, or resolver). */
  setCategorizerTools(id: string, spec: import("../registry/registry.js").CategorizerToolSpec | undefined): void {
    if (spec == null) this.categorizerToolSpecs.delete(id);
    else this.categorizerToolSpecs.set(id, spec);
  }

  /** Resolve the extra tools a categorizer receives beyond its setup list. */
  extraToolsFor(id: string): import("../types.js").AgentTool[] {
    const spec = this.categorizerToolSpecs.get(id);
    try {
      return this.registry.selectCategorizerTools(id, spec);
    } catch {
      return [];
    }
  }

  /** Host hook after each completed categorizer hop (Session reconciliation). */
  setAfterCategorizerHook(
    hook:
      | ((hop: import("../categorizer/types.js").CategorizerHop, signal?: AbortSignal) => Promise<void> | void)
      | undefined,
  ): void {
    this.afterCategorizerHook = hook;
  }

  /** Session-level `create_plan` review callback. */
  setPlanApprovalCallback(cb: PlanApprovalCallback | undefined): void {
    this.planApprovalCb = cb;
  }
}

// ---------------------------------------------------------------------------
// Thread snapshot (continuity for the next prompt in the session)
// ---------------------------------------------------------------------------

export function buildRunThreadSnapshotForTest(input: Parameters<typeof buildRunThreadSnapshot>[0]): ThreadRunSnapshot {
  return buildRunThreadSnapshot(input);
}

function buildRunThreadSnapshot(input: {
  task: string;
  route: ChainRoute;
  success: boolean;
  summary: string;
  usage: Usage;
  writtenPaths?: string[];
  readPaths?: string[];
  discoveredPaths?: string[];
  steps?: RunStep[];
  planSet?: PlanSet;
  pendingUserQuestion?: AskUserQuestionRequest;
  error?: string;
  verified?: boolean;
}): ThreadRunSnapshot {
  const disposition: ThreadRunDisposition = input.pendingUserQuestion
    ? "pending_user_question"
    : input.error
      ? "failed"
      : input.success
        ? "completed"
        : "failed";
  return {
    timestamp: Date.now(),
    task: input.task,
    route: input.route,
    disposition,
    recommendedFollowUpMode: disposition === "pending_user_question" ? "fresh" : "structured_continue",
    summary: input.summary,
    ...(input.readPaths?.length ? { readPaths: input.readPaths.slice(-24) } : {}),
    ...(input.writtenPaths?.length ? { writtenPaths: input.writtenPaths.slice(-24) } : {}),
    ...(input.discoveredPaths?.length ? { discoveredPaths: input.discoveredPaths.slice(-24) } : {}),
    ...(input.planSet ? { planJson: input.planSet.plans.flatMap((p) => p.tasks) as unknown[] } : {}),
    ...(input.pendingUserQuestion ? { pendingUserQuestion: input.pendingUserQuestion } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(typeof input.verified === "boolean" ? { verified: input.verified } : {}),
  };
}
