/**
 * Orchestrator (req #4, #5, #7).
 *
 * The orchestrator's ONLY job is to run the loop and manage the four phases. It
 * does not reason over file contents and never writes/edits code — all reasoning
 * is delegated to the per-phase model, all IO to tools (req #7).
 *
 * Capabilities:
 *   - Per-phase model + per-tool model (via the permission decision) — req #5.
 *   - A single "coding chain" runs Prepare → Plan → Perform → Perfect; Perfect
 *     verifies and, on failure, re-runs Perform with feedback until it passes or a
 *     max-iteration cap is hit — req #4.
 *   - Each phase is also runnable standalone, and exposed as a meta-tool so it can
 *     be dropped into an outer tool-call chain — req #3/#4.
 */
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AssistantMessage,
  ComplexityRating,
  LLMBridge,
  MediaRef,
  Model,
  Phase,
  PlanFileMutationMode,
  PlanSet,
  PhaseResult,
  PrepareProviderAssignmentMap,
  PrepareRelevantFile,
  PrepareToolTranscriptEntry,
  ReadFileContent,
  RegisteredProviderSummary,
  ThreadFollowUpContext,
  ThreadRunDisposition,
  ThreadRunSnapshot,
  TranscriptMode,
  ThinkingLevel,
  ToolSnippet,
  Usage,
} from "../types.js";
import { emptyUsage, PHASES } from "../types.js";
import { Registry, type PhaseToolSpec } from "../registry/registry.js";
import { LogStore } from "../logging/logger.js";
import { PermissionGate } from "./permission.js";
import { runPhase, type PhaseRunInput } from "./phase-runner.js";
import { OpenRouterBridge } from "../llm/bridge.js";
import { DEFAULT_PHASE_MODELS } from "../llm/models.js";
import { estimateComplexity } from "../llm/model-selector.js";
import { CONVERSATIONAL_PROMPT, INTENT_ROUTER_PROMPT } from "../phases/prompts.js";
import * as path from "node:path";

/** Where a request is routed after the front-of-Prepare intent check. */
export type ChainRoute = "conversational" | "task";

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
  /** Per-phase orchestrator model slugs (req #5). */
  models?: PhaseModelConfig;
  /** Candidate model slugs the permission layer may pick from for tool calls. */
  toolModelCandidates?: string[];
  /** Customize the fixed toolset per phase. Each value may be an exact
   *  `AgentTool[]`, a `PhaseToolFilter` (include/exclude over the category), or a
   *  resolver function. If omitted, tools are resolved from the registry by 4P
   *  category. (req #3: each P has fixed mcps/skills — and they're customizable.) */
  phaseTools?: Partial<Record<Phase, PhaseToolSpec>>;
  maxSteps?: Partial<Record<Phase, number>>;
  reasoning?: Partial<Record<Phase, ThinkingLevel>>;
  temperature?: Partial<Record<Phase, number>>;
  /** Max Perfect→Perform retry iterations before giving up. */
  maxChainIterations?: number;
  /** Host-owned reconciliation hook invoked after Prepare and before Plan. */
  afterPrepare?: AfterPrepareHook;
  /** How much raw transcript detail should be emitted/persisted for hosts. */
  transcriptMode?: TranscriptMode;
  signal?: AbortSignal;
}

export interface RunPhaseOptions {
  priorSummaries?: Array<{ phase: Phase; summary: string }>;
  priorRefs?: MediaRef[];
  priorDiscoveredPaths?: string[];
  priorReadPaths?: string[];
  priorToolSnippets?: ToolSnippet[];
  priorRelevantFiles?: PrepareRelevantFile[];
  priorToolTranscript?: PrepareToolTranscriptEntry[];
  /** Structured Plan card/steps extracted from PLAN_JSON. */
  priorPlanJson?: unknown[];
  /** Exact file allowlist Perform may modify/read from the executable plan. */
  allowedWorkPaths?: string[];
  /** Planned mutation mode per absolute work file path. */
  plannedFileMutations?: Record<string, PlanFileMutationMode>;
  /** Full file contents attached from the previous phase for direct reuse. */
  attachedFileContents?: ReadFileContent[];
  /** Read-only supporting files attached from Plan for implementation context. */
  attachedContextFiles?: ReadFileContent[];
  priorWrittenPaths?: string[];
  /** Project profile (type/stack + run/verify) established by Prepare. */
  priorProjectProfile?: string;
  /** Structured RUN/STOP/VERIFY guidance established by Prepare. */
  priorProjectRunbook?: PhaseResult["projectRunbook"];
  /** MCP/skills/tools Prepare found relevant. */
  priorCapabilities?: string;
  /** Structured provider assignments Prepare selected for downstream phases. */
  priorProviderAssignments?: PrepareProviderAssignmentMap;
  /** Exact file allowlist this phase may read from the Prepare handoff. */
  allowedReadPaths?: string[];
  /** Per-path complexity inherited from earlier phases (Prepare file / Plan task). */
  complexityByPath?: Record<string, ComplexityRating>;
  /** Origin of the inherited per-path complexity. */
  complexitySource?: "prepare-file" | "plan-task";
  /** Label naming which plan (of several) a Perform run is executing. */
  planLabel?: string;
  /** Metadata-only list of registered providers shown to Prepare. */
  availableProviders?: RegisteredProviderSummary[];
  /** User-requested changes that a regenerated PLAN must address. */
  planReviewFeedback?: string;
  feedback?: string;
  tools?: AgentTool[];
  signal?: AbortSignal;
  /**
   * Optional host callback for `ask_user_question`. When provided, the tool
   * blocks in-place for the user's answer and the LLM continues in the same
   * conversation. When absent, the tool falls back to surfacing the question
   * via its `details` payload for a non-blocking host.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
}

export interface RunChainOptions {
  signal?: AbortSignal;
  /**
   * Optional host callback for `ask_user_question`. Threaded to every phase.
   * See `RunPhaseOptions.askUserQuestion` for behavior.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
}

export interface ChainResult {
  success: boolean;
  iterations: number;
  phases: {
    prepare?: PhaseResult;
    plan?: PhaseResult;
    perform?: PhaseResult;
    perfect?: PhaseResult;
    /** All perform/perfect iterations, in order. */
    history: PhaseResult[];
  };
  refs: MediaRef[];
  usage: Usage;
  /**
   * A hard failure (LLM/transport/tool error — NOT a Perfect "verify failed")
   * that ended the chain early. Undefined on a normal run, including one that
   * merely failed verification. A user abort is not reported here.
   */
  error?: string;
  /**
   * How the request was routed at the front of Prepare. `"conversational"` means
   * the prompt was small talk / a directly-answerable question, so the chain
   * answered inline and skipped Plan/Perform/Perfect. `"task"` is the full 4P run.
   */
  route?: ChainRoute;
  pendingUserQuestion?: AskUserQuestionRequest;
  threadSnapshot?: ThreadRunSnapshot;
}

export type AfterPrepareHook = (
  prepare: PhaseResult,
  ctx: { task: string; signal?: AbortSignal },
) => Promise<PhaseResult | void> | PhaseResult | void;

function messageText(msg: AssistantMessage): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

function emptyAssistant(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.openRouterSlug ?? model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type PlanReviewDecision =
  | { type: "approve" }
  | { type: "edit"; feedback: string }
  | { type: "reject"; feedback?: string };

function buildPlanReviewRequest(): AskUserQuestionRequest {
  return {
    kind: "plan_review",
    phase: "plan",
    question: "Review the execution plan before implementation starts.",
    reason:
      "Approve to begin implementation, edit to revise the plan, or reject to stop this run before any code changes are made.",
    placeholder: "If editing, describe exactly what should change in the plan.",
  };
}

function parsePlanReviewDecision(answer: string): PlanReviewDecision {
  const trimmed = answer.trim();
  if (!trimmed) {
    return { type: "edit", feedback: "Revise the plan based on the user's requested changes." };
  }
  if (/^__PLAN_APPROVE__$/i.test(trimmed) || /^approve\b/i.test(trimmed)) {
    return { type: "approve" };
  }
  if (/^__PLAN_REJECT__$/i.test(trimmed) || /^reject\b/i.test(trimmed)) {
    const feedback = trimmed
      .replace(/^__PLAN_REJECT__\s*/i, "")
      .replace(/^reject[:\s-]*/i, "")
      .trim();
    return feedback ? { type: "reject", feedback } : { type: "reject" };
  }
  if (/^__PLAN_EDIT__$/i.test(trimmed) || /^edit\b/i.test(trimmed)) {
    const feedback = trimmed
      .replace(/^__PLAN_EDIT__\s*/i, "")
      .replace(/^edit[:\s-]*/i, "")
      .trim();
    return {
      type: "edit",
      feedback: feedback || "Revise the plan based on the user's requested changes.",
    };
  }
  return { type: "edit", feedback: trimmed };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

const MAX_SNAPSHOT_PATHS = 24;
const MAX_SNAPSHOT_RELEVANT_FILES = 12;
const MAX_SNAPSHOT_PLAN_STEPS = 12;
const MAX_SNAPSHOT_CONTEXT_FILES = 4;
const MAX_SNAPSHOT_CONTEXT_CHARS = 12000;

function takeFirst<T>(items: T[] | undefined, limit: number): T[] | undefined {
  if (!items?.length) return undefined;
  return items.slice(0, limit);
}

function collectThreadContextFiles(phases: ThreadSummarySource): ReadFileContent[] | undefined {
  const ordered = [phases.perfect, phases.perform, phases.plan, phases.prepare];
  const byPath = new Map<string, ReadFileContent>();
  let totalChars = 0;
  for (const result of ordered) {
    for (const file of result?.readFileContents ?? []) {
      if (!file.path || !file.content) continue;
      if (byPath.has(file.path)) continue;
      const remaining = MAX_SNAPSHOT_CONTEXT_CHARS - totalChars;
      if (remaining <= 0) break;
      const content = file.content.length > remaining ? file.content.slice(0, remaining) : file.content;
      byPath.set(file.path, { path: file.path, content });
      totalChars += content.length;
      if (byPath.size >= MAX_SNAPSHOT_CONTEXT_FILES) break;
    }
    if (byPath.size >= MAX_SNAPSHOT_CONTEXT_FILES || totalChars >= MAX_SNAPSHOT_CONTEXT_CHARS) break;
  }
  return byPath.size ? [...byPath.values()] : undefined;
}

function preferredPhaseSummary(result: PhaseResult | undefined): string | undefined {
  const display = result?.display?.summary?.trim();
  if (display) return display;
  const summary = result?.summary?.trim();
  return summary || undefined;
}

export interface ThreadSummarySource {
  prepare?: PhaseResult;
  plan?: PhaseResult;
  perform?: PhaseResult;
  perfect?: PhaseResult;
}

function latestRunSummaryEntry(phases: ThreadSummarySource): { phase: Phase; summary: string } | undefined {
  const order: Phase[] = ["perfect", "perform", "plan", "prepare"];
  for (const phase of order) {
    const summary = preferredPhaseSummary(phases[phase]);
    if (summary) return { phase, summary };
  }
  return undefined;
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "prepare":
      return "Prepare";
    case "plan":
      return "Plan";
    case "perform":
      return "Perform";
    case "perfect":
      return "Perfect";
  }
}

export function buildThreadRunSummary(input: {
  task: string;
  disposition: ThreadRunDisposition;
  phases: ThreadSummarySource;
  error?: string;
  pendingUserQuestion?: AskUserQuestionRequest;
}): string {
  const latest = latestRunSummaryEntry(input.phases);
  const latestLine = latest ? `Latest progress (${phaseLabel(latest.phase)}): ${latest.summary}` : undefined;
  switch (input.disposition) {
    case "completed": {
      // A completed task run's continuity summary should carry the Perfect
      // verdict (PASS/FAIL) so the next run's handoff knows the outcome. The
      // perfect phase's raw `summary` includes the "VERDICT: …" line, whereas its
      // display summary strips it. Fall back to the latest phase summary for
      // runs with no Perfect (single-phase / conversational).
      const perfectSummary = input.phases.perfect?.summary?.trim();
      return perfectSummary || latest?.summary || `Completed the run for: ${input.task}`;
    }
    case "pending_user_question": {
      const question = input.pendingUserQuestion?.question?.trim();
      return [
        "Run paused and needs user input before continuing.",
        ...(latestLine ? [latestLine] : []),
        ...(question ? [`Pending question: ${question}`] : []),
      ].join("\n");
    }
    case "aborted":
      return [
        "Run stopped before completion.",
        ...(latestLine ? [latestLine] : [`Task in progress: ${input.task}`]),
      ].join("\n");
    case "failed":
      return [
        "Run failed before completion.",
        ...(latestLine ? [latestLine] : [`Task in progress: ${input.task}`]),
        ...(input.error ? [`Error: ${input.error}`] : []),
      ].join("\n");
  }
}

function deriveDisposition(input: {
  success: boolean;
  error?: string;
  pendingUserQuestion?: AskUserQuestionRequest;
  history: PhaseResult[];
}): ThreadRunDisposition {
  if (input.pendingUserQuestion) return "pending_user_question";
  if (input.error) return "failed";
  if (input.history.some((phase) => phase.error === "aborted")) return "aborted";
  return input.success ? "completed" : "failed";
}

function buildThreadSnapshot(input: {
  task: string;
  route: ChainRoute;
  success: boolean;
  iterations: number;
  phases: ChainResult["phases"];
  refs: MediaRef[];
  usage: Usage;
  error?: string;
  pendingUserQuestion?: AskUserQuestionRequest;
  discoveredPaths?: string[];
  readPaths?: string[];
  writtenPaths?: string[];
  relevantFiles?: PrepareRelevantFile[];
  planJson?: unknown[];
}): ThreadRunSnapshot {
  void input.iterations;
  void input.refs;
  void input.usage;
  const plan = input.phases.plan;
  const perfect = input.phases.perfect;
  const disposition = deriveDisposition({
    success: input.success,
    error: input.error,
    pendingUserQuestion: input.pendingUserQuestion,
    history: input.phases.history,
  });
  const summary = buildThreadRunSummary({
    task: input.task,
    disposition,
    phases: {
      prepare: input.phases.prepare,
      plan,
      perform: input.phases.perform,
      perfect,
    },
    ...(input.error ? { error: input.error } : {}),
    ...(input.pendingUserQuestion ? { pendingUserQuestion: input.pendingUserQuestion } : {}),
  });
  const recommendedFollowUpMode =
    disposition === "pending_user_question" ? "fresh" : "structured_continue";
  const contextFiles = collectThreadContextFiles({
    prepare: input.phases.prepare,
    plan,
    perform: input.phases.perform,
    perfect,
  });
  return {
    timestamp: Date.now(),
    task: input.task,
    route: input.route,
    disposition,
    recommendedFollowUpMode,
    summary,
    ...(contextFiles?.length ? { contextFiles } : {}),
    ...(plan?.summary ? { planSummary: plan.summary } : {}),
    ...(takeFirst(input.planJson, MAX_SNAPSHOT_PLAN_STEPS)?.length
      ? { planJson: takeFirst(input.planJson, MAX_SNAPSHOT_PLAN_STEPS) }
      : {}),
    ...(takeFirst(input.discoveredPaths, MAX_SNAPSHOT_PATHS)?.length
      ? { discoveredPaths: takeFirst(input.discoveredPaths, MAX_SNAPSHOT_PATHS) }
      : {}),
    ...(takeFirst(input.readPaths, MAX_SNAPSHOT_PATHS)?.length
      ? { readPaths: takeFirst(input.readPaths, MAX_SNAPSHOT_PATHS) }
      : {}),
    ...(takeFirst(input.writtenPaths, MAX_SNAPSHOT_PATHS)?.length
      ? { writtenPaths: takeFirst(input.writtenPaths, MAX_SNAPSHOT_PATHS) }
      : {}),
    ...(takeFirst(input.relevantFiles, MAX_SNAPSHOT_RELEVANT_FILES)?.length
      ? { relevantFiles: takeFirst(input.relevantFiles, MAX_SNAPSHOT_RELEVANT_FILES) }
      : {}),
    ...(typeof perfect?.verified === "boolean" ? { verified: perfect.verified } : {}),
    ...(input.pendingUserQuestion ? { pendingUserQuestion: input.pendingUserQuestion } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export class Orchestrator {
  readonly registry: Registry;
  readonly logStore: LogStore;
  readonly permission: PermissionGate;
  readonly llm: LLMBridge;
  private readonly config: OrchestratorConfig;
  private listeners = new Set<(e: AgentEvent) => void>();
  /** Runtime model overrides (req #5: models are customizable at any time). */
  private modelOverrides: Partial<Record<Phase | "orchestrator", string>> = {};
  /** Runtime per-phase toolset overrides (customizable at any time). */
  private phaseToolOverrides: Partial<Record<Phase, PhaseToolSpec>> = {};
  /** Optional host-owned Prepare reconciliation hook. */
  private afterPrepareHook?: AfterPrepareHook;

  constructor(config: OrchestratorConfig = {}) {
    this.config = config;
    this.registry = config.registry ?? new Registry();
    this.logStore = config.logStore ?? new LogStore();
    this.permission = config.permission ?? new PermissionGate("ask-mutations");
    this.llm = config.llm ?? new OpenRouterBridge();
    this.afterPrepareHook = config.afterPrepare;
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: AgentEvent): void {
    // A subscriber must never be able to abort a run. Host listeners (UI event
    // mappers, phase trackers, persistence) can throw — e.g. on a malformed field
    // in a phase result — and because emit() is called synchronously from inside
    // the phase loop, an uncaught listener throw would propagate up and terminate
    // the whole chain mid-way ("run stopped in the middle"). Isolate each
    // listener so a buggy/throwing subscriber only loses its own event.
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.logStore.append({
          tags: ["orchestrator", "listener-error"],
          level: "error",
          message: `event subscriber threw on "${e.type}" and was isolated`,
          data: { error: err instanceof Error ? err.message : String(err), eventType: e.type },
        });
      }
    }
  }

  private get cwd(): string {
    return this.config.cwd ?? process.cwd();
  }

  /**
   * Resolve the fixed toolset for a phase. Precedence: runtime override →
   * constructor `phaseTools` → registry category. The spec may be an exact list, a
   * filter, or a resolver — so the per-P toolset is fully customizable (req #3).
   */
  resolvePhaseTools(phase: Phase): AgentTool[] {
    const spec = this.phaseToolOverrides[phase] ?? this.config.phaseTools?.[phase];
    return this.registry.selectPhaseTools(phase, spec);
  }

  /**
   * Set (or clear) the toolset for a phase at runtime. Pass an `AgentTool[]`,
   * a `PhaseToolFilter`, a resolver function, or `undefined` to revert to the
   * configured/category default.
   */
  setPhaseTools(phase: Phase, spec: PhaseToolSpec | undefined): void {
    if (spec) this.phaseToolOverrides[phase] = spec;
    else delete this.phaseToolOverrides[phase];
  }

  /** Set or clear the host-owned reconciliation hook that runs after Prepare. */
  setAfterPrepareHook(hook: AfterPrepareHook | undefined): void {
    this.afterPrepareHook = hook;
  }

  /**
   * Set (or clear) the model for a phase or the orchestrator at runtime (req #5).
   * Precedence when resolving: runtime override → constructor config → default.
   */
  setModel(target: Phase | "orchestrator", slug: string | undefined): void {
    if (slug) this.modelOverrides[target] = slug;
    else delete this.modelOverrides[target];
  }

  /** Model slug for a phase: runtime override → config → orchestrator default → built-in. */
  private phaseModelSlug(phase: Phase): string {
    return (
      this.modelOverrides[phase] ??
      this.config.models?.[phase] ??
      this.modelOverrides.orchestrator ??
      this.config.models?.orchestrator ??
      DEFAULT_PHASE_MODELS[phase]
    );
  }

  /**
   * Run a single phase standalone. Applies the phase-level permission gate first
   * (which may pin the phase model). Returns a full {@link PhaseResult}.
   */
  async runPhase(phase: Phase, task: string, opts: RunPhaseOptions = {}): Promise<PhaseResult> {
    const tools = opts.tools ?? this.resolvePhaseTools(phase);
    const mutates = phase === "perform";
    const complexity = estimateComplexity({
      toolCount: tools.length,
      contextChars: task.length + JSON.stringify(opts.priorSummaries ?? []).length,
      mutates,
      refs: opts.priorRefs,
      bias: phase === "plan" ? 0.2 : phase === "perfect" ? 0.1 : 0,
    });

    // Phase-level permission (req #7: phase calls also gated + can pin a model).
    const req = { kind: "phase" as const, name: phase, mutates, complexity, phase, refs: opts.priorRefs };
    this.emit({ type: "permission_request", request: req });
    const decision = await this.permission.evaluate(req);
    this.emit({ type: "permission_decision", request: req, decision });

    if (!decision.allowed) {
      return {
        phase,
        summary: `Phase ${phase} denied by permission policy.`,
        complexity: complexity.score,
        usage: emptyUsage(),
        messages: [],
        error: "permission_denied",
        verified: phase === "perfect" ? false : undefined,
      };
    }

    const modelSlug = decision.model ?? this.phaseModelSlug(phase);
    const model: Model = this.llm.resolveModel(modelSlug);

    // UI emission toggles the client may send back with the phase decision, next
    // to `model`. `transcript` overrides transcriptMode (full vs compact);
    // `reasoning` gates whether thinking is emitted to the UI. Absent ⇒ the
    // configured default applies.
    const transcriptMode =
      decision.transcript === true
        ? "full"
        : decision.transcript === false
          ? "compact"
          : (opts.transcriptMode ?? this.config.transcriptMode);

    const runInput: PhaseRunInput = {
      phase,
      task,
      priorSummaries: opts.priorSummaries,
      priorRefs: opts.priorRefs,
      priorDiscoveredPaths: opts.priorDiscoveredPaths,
      priorReadPaths: opts.priorReadPaths,
      priorToolSnippets: opts.priorToolSnippets,
      priorRelevantFiles: opts.priorRelevantFiles,
      priorToolTranscript: opts.priorToolTranscript,
      priorPlanJson: opts.priorPlanJson,
      allowedWorkPaths: opts.allowedWorkPaths,
      plannedFileMutations: opts.plannedFileMutations,
      attachedFileContents: opts.attachedFileContents,
      attachedContextFiles: opts.attachedContextFiles,
      priorWrittenPaths: opts.priorWrittenPaths,
      priorProjectProfile: opts.priorProjectProfile,
      priorProjectRunbook: opts.priorProjectRunbook,
      priorCapabilities: opts.priorCapabilities,
      priorProviderAssignments: opts.priorProviderAssignments,
      allowedReadPaths: opts.allowedReadPaths,
      complexityByPath: opts.complexityByPath,
      complexitySource: opts.complexitySource,
      planLabel: opts.planLabel,
      availableProviders: opts.availableProviders,
      planReviewFeedback: opts.planReviewFeedback,
      feedback: opts.feedback,
      model,
      tools,
      llm: this.llm,
      permission: this.permission,
      registry: this.registry,
      logStore: this.logStore,
      emit: (e) => this.emit(e),
      cwd: this.cwd,
      signal: opts.signal ?? this.config.signal,
      // Plan may need extra steps to gather all plan-shaping clarifications
      // (each ask_user_question is a step) plus read the handed-over files before
      // producing the plan, so give it more headroom than the default when the
      // host hasn't configured a per-phase budget.
      maxSteps: this.config.maxSteps?.[phase] ?? (phase === "plan" ? 18 : undefined),
      temperature: this.config.temperature?.[phase],
      reasoning: this.config.reasoning?.[phase],
      toolModelCandidates: this.config.toolModelCandidates,
      followUpContext: opts.followUpContext,
      transcriptMode,
      ...(typeof decision.reasoning === "boolean" ? { emitReasoning: decision.reasoning } : {}),
      ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
    };
    return runPhase(runInput);
  }

  /**
   * The front of PREPARE: decide whether a request needs the full 4P pipeline or
   * is a conversational turn to answer directly. Uses the prepare-phase model for
   * a cheap, tool-free, single-word classification. Defaults to `"task"` on any
   * ambiguity or model error so real work is never skipped.
   */
  private async classifyIntent(task: string, signal?: AbortSignal): Promise<ChainRoute> {
    try {
      const model = this.llm.resolveModel(this.phaseModelSlug("prepare"));
      const msg = await this.llm.complete(
        model,
        { systemPrompt: INTENT_ROUTER_PROMPT, messages: [{ role: "user", content: task, timestamp: Date.now() }] },
        { reasoning: "off", signal },
      );
      if (msg.stopReason === "error") return "task"; // endpoint failure → let the chain surface it
      const text = messageText(msg).toUpperCase();
      return text.includes("CONVERSATIONAL") && !text.includes("TASK") ? "conversational" : "task";
    } catch {
      return "task";
    }
  }

  /**
   * Stream a direct conversational answer (no tools, no project assumptions),
   * emitting the same message and turn_end events a phase emits so a subscribed
   * Agent folds it into its message history. Returns the finished message.
   */
  private async streamConversationalReply(
    task: string,
    signal?: AbortSignal,
  ): Promise<{ message: AssistantMessage; error?: string }> {
    const model = this.llm.resolveModel(this.phaseModelSlug("prepare"));
    const context = {
      systemPrompt: CONVERSATIONAL_PROMPT,
      messages: [{ role: "user" as const, content: task, timestamp: Date.now() }],
    };
    this.emit({ type: "turn_start" });
    let final: AssistantMessage | undefined;
    let started = false;
    for await (const ev of this.llm.stream(model, context, { reasoning: "off", signal })) {
      if (ev.type === "start" && !started) {
        started = true;
        this.emit({ type: "message_start", message: ev.partial });
      }
      if ("partial" in ev) this.emit({ type: "message_update", message: ev.partial, assistantMessageEvent: ev });
      if (ev.type === "done") {
        final = ev.message;
        this.emit({ type: "message_end", message: ev.message });
      } else if (ev.type === "error") {
        final = ev.error;
        this.emit({ type: "message_end", message: ev.error });
      }
    }
    const message = final ?? { ...emptyAssistant(model), errorMessage: "no response", stopReason: "error" as const };
    this.emit({ type: "turn_end", message, toolResults: [] });
    const error = message.stopReason === "error" ? (message.errorMessage ?? "conversational reply failed") : undefined;
    return { message, error };
  }

  /**
   * Run the full 4P coding chain (req #4). Prepare and Plan run once; then
   * Perform→Perfect loop until Perfect verifies or maxChainIterations is reached.
   *
   * Front-of-Prepare routing: a conversational prompt (e.g. "hi", "thanks", a
   * question needing no project work) is answered inline and skips
   * Plan/Perform/Perfect — running the whole pipeline on small talk is wasteful.
   */
  async runChain(task: string, opts: RunChainOptions = {}): Promise<ChainResult> {
    const maxIter = this.config.maxChainIterations ?? 3;
    const signal = opts.signal ?? this.config.signal;
    this.emit({ type: "chain_start", task });

    // --- Front-of-Prepare intent routing ---
    if (!signal?.aborted) {
      const route = await this.classifyIntent(task, signal);
      if (route === "conversational") {
        const { message, error } = await this.streamConversationalReply(task, signal);
        const usage = message.usage;
        const prepareResult: PhaseResult = {
          phase: "prepare",
          summary: messageText(message),
          complexity: 0,
          usage,
          messages: [message],
          ...(error ? { error } : {}),
        };
        this.emit({ type: "chain_end", success: !error, iterations: 0 });
        const threadSnapshot = buildThreadSnapshot({
          task,
          route: "conversational",
          success: !error,
          iterations: 0,
          phases: { prepare: prepareResult, history: [prepareResult] },
          refs: [],
          usage,
          ...(error ? { error } : {}),
        });
        return {
          success: !error,
          iterations: 0,
          phases: { prepare: prepareResult, history: [prepareResult] },
          refs: [],
          usage,
          route: "conversational",
          threadSnapshot,
          ...(error ? { error } : {}),
        };
      }
    }

    let usage = emptyUsage();
    let refs: MediaRef[] = [];
    const summaries: Array<{ phase: Phase; summary: string }> = [];
    // Confirmed addresses + last 1-2 tool outputs accumulate across phases so
    // each new phase starts with the structured context the prior phases
    // actually established (not just their prose summary).
    let discoveredPaths: string[] = [];
    let readPaths: string[] = [];
    let toolSnippets: ToolSnippet[] = [];
    // Files actually written/edited in this chain. Carried forward so retry
    // iterations don't re-write or re-verify the same file.
    let writtenPaths: string[] = [];
    // Project profile + relevant capabilities Prepare established, carried to
    // every later phase (updated if any phase re-declares them).
    let projectProfile: string | undefined;
    let projectRunbook: PhaseResult["projectRunbook"] | undefined;
    let capabilities: string | undefined;
    let providerAssignments: PrepareProviderAssignmentMap | undefined;
    let relevantFiles: PrepareRelevantFile[] = [];
    let toolTranscript: PrepareToolTranscriptEntry[] = [];
      let planJson: unknown[] | undefined;
    const history: PhaseResult[] = [];
    const result: ChainResult["phases"] = { history };

    // A phase can end with a hard error (LLM/transport/tool failure, e.g. a 401
    // from the model endpoint) as opposed to a Perfect "verify failed". A user
    // abort surfaces as the sentinel "aborted" and is NOT a hard error. When a
    // phase hard-errors, stop the chain immediately and surface the message —
    // otherwise the remaining phases would repeat the same failing call and the
    // caller would see a silent, empty, "successful-looking" run.
    const hardError = (r: PhaseResult): string | undefined =>
      r.error && r.error !== "aborted" ? r.error : undefined;
    const failChain = (iterations: number, error: string): ChainResult => {
      this.emit({ type: "chain_end", success: false, iterations });
      return {
        success: false,
        iterations,
        phases: result,
        refs,
        usage,
        error,
        route: "task",
        threadSnapshot: buildThreadSnapshot({
          task,
          route: "task",
          success: false,
          iterations,
          phases: result,
          refs,
          usage,
          error,
          discoveredPaths,
          readPaths,
          writtenPaths,
          relevantFiles,
          ...(planJson?.length ? { planJson } : {}),
        }),
      };
    };

    const record = (r: PhaseResult) => {
      usage = addUsage(usage, r.usage);
      refs = dedupeRefs([...refs, ...(r.refs ?? [])]);
      if (r.discoveredPaths?.length) {
        const seen = new Set(discoveredPaths);
        for (const p of r.discoveredPaths) {
          if (!seen.has(p)) {
            discoveredPaths.push(p);
            seen.add(p);
          }
        }
      }
      if (r.readPaths?.length) {
        const seen = new Set(readPaths);
        for (const p of r.readPaths) {
          if (!seen.has(p)) {
            readPaths.push(p);
            seen.add(p);
          }
        }
      }
      if (r.writtenPaths?.length) {
        const seen = new Set(writtenPaths);
        for (const p of r.writtenPaths) {
          if (!seen.has(p)) {
            writtenPaths.push(p);
            seen.add(p);
          }
        }
      }
      if (r.recentToolSnippets?.length) {
        toolSnippets = r.recentToolSnippets.slice(-2);
      }
      if (r.projectProfile) projectProfile = r.projectProfile;
      if (r.projectRunbook) projectRunbook = r.projectRunbook;
      if (r.capabilities) capabilities = r.capabilities;
      if (r.providerAssignments) providerAssignments = r.providerAssignments;
      if (r.relevantFiles?.length) relevantFiles = r.relevantFiles;
      if (r.toolTranscript?.length) toolTranscript = r.toolTranscript;
      summaries.push({ phase: r.phase, summary: r.summary });
    };

    // --- Prepare (once) ---
    const availableProviders = summarizeRegisteredProviders(this.registry);
    let prepare = await this.runPhase("prepare", task, {
      priorRefs: refs,
      priorDiscoveredPaths: discoveredPaths,
      priorReadPaths: opts.followUpContext?.previousRun.readPaths?.length
        ? [...new Set([...(opts.followUpContext.previousRun.readPaths ?? []), ...readPaths])]
        : readPaths,
      priorToolSnippets: toolSnippets,
      availableProviders,
      priorWrittenPaths: writtenPaths,
      attachedContextFiles: opts.followUpContext?.previousRun.contextFiles,
      followUpContext: opts.followUpContext,
      signal,
      ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
    });
    if (this.afterPrepareHook) {
      const patched = await this.afterPrepareHook(prepare, { task, signal });
      if (patched) prepare = patched;
    }
    result.prepare = prepare;
    history.push(prepare);
    record(prepare);
    const prepareError = hardError(prepare);
    if (prepareError) return failChain(0, prepareError);
    // --- Plan (once) ---
    const planTools = filterPlanHandoffTools(this.resolvePhaseTools("plan"));
    const planAllowedReadPaths = resolvePlanAllowedReadPaths(relevantFiles, toolTranscript, readPaths);
    this.logStore.append({
      tags: ["phase", "handoff", "prepare", "plan"],
      level: "info",
      message: "prepare -> plan handoff",
      data: {
        task,
        planTools: planTools.map((tool) => tool.name),
        providerAssignmentsByPhase: summarizeProviderAssignments(this.registry),
        handoff: {
          priorSummaries: summaries,
          priorRefs: refs,
          priorDiscoveredPaths: discoveredPaths,
          priorReadPaths: readPaths,
          priorToolSnippets: toolSnippets,
          priorRelevantFiles: relevantFiles,
          priorToolTranscript: toolTranscript,
          priorWrittenPaths: writtenPaths,
          priorProjectProfile: projectProfile,
          priorProjectRunbook: projectRunbook,
          priorCapabilities: capabilities,
          priorProviderAssignments: providerAssignments,
        },
      },
    });
    let planReviewFeedback: string | undefined;
    let plan: PhaseResult;
    let performWorkPaths: string[] = [];
    let performFileMutations: Record<string, PlanFileMutationMode> = {};
    let attachedFileContents: ReadFileContent[] = [];
    let attachedContextFiles: ReadFileContent[] = [];
    let performReadTranscript: PrepareToolTranscriptEntry[] = [];
    let performReadPaths: string[] = [];
    let performRelevantFiles: PrepareRelevantFile[] = [];
    let performDiscoveredPaths: string[] = [];

    while (true) {
      plan = await this.runPhase("plan", task, {
        priorSummaries: summaries,
        priorRefs: refs,
        priorDiscoveredPaths: discoveredPaths,
        priorReadPaths: readPaths,
        priorToolSnippets: toolSnippets,
        priorRelevantFiles: relevantFiles,
        priorToolTranscript: toolTranscript,
        priorWrittenPaths: writtenPaths,
        priorProjectProfile: projectProfile,
        priorProjectRunbook: projectRunbook,
        priorCapabilities: capabilities,
        priorProviderAssignments: providerAssignments,
        allowedReadPaths: planAllowedReadPaths,
        ...(planReviewFeedback ? { planReviewFeedback } : {}),
        tools: planTools,
        signal,
        ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
      });
      result.plan = plan;
      history.push(plan);
      record(plan);
      planJson = Array.isArray(plan.artifacts?.planJson) ? plan.artifacts.planJson : undefined;
      performWorkPaths = resolvePerformWorkPaths(plan, planJson);
      performFileMutations = resolvePerformFileMutations(plan, planJson);
      attachedFileContents = filterReadFileContentsToAllowlist(plan.readFileContents, performWorkPaths);
      attachedContextFiles = excludeReadFileContentsFromAllowlist(plan.readFileContents, performWorkPaths);
      const attachedAllFiles = [...attachedFileContents, ...attachedContextFiles];
      performReadTranscript = attachedAllFiles.length
        ? buildReadTranscriptFromAttachedFiles(attachedAllFiles)
        : toolTranscript;
      performReadPaths = attachedAllFiles.map((file) => file.path);
      performDiscoveredPaths = [...new Set([...performWorkPaths, ...performReadPaths])];
      performRelevantFiles = filterRelevantFilesToAllowlist(
        plan.relevantFiles?.length ? plan.relevantFiles : relevantFiles,
        performDiscoveredPaths,
      );
      this.logStore.append({
        tags: ["phase", "handoff", "plan", "perform", "perfect"],
        level: "info",
        message: "plan complete; downstream phase assignments snapshot",
        data: {
          task,
          planSummary: plan.summary,
          phaseTools: {
            plan: this.resolvePhaseTools("plan").map((tool) => tool.name),
            perform: this.resolvePhaseTools("perform").map((tool) => tool.name),
            perfect: this.resolvePhaseTools("perfect").map((tool) => tool.name),
          },
          providerAssignmentsByPhase: summarizeProviderAssignments(this.registry),
          planToPerformHandoff: {
            allowedWorkPaths: performWorkPaths,
            plannedFileMutations: performFileMutations,
            attachedFileContents,
            attachedContextFiles,
            priorPlanJson: planJson,
            priorSummaries: [{ phase: "plan" as const, summary: plan.summary }],
            priorRefs: refs,
            priorDiscoveredPaths: performDiscoveredPaths,
            priorReadPaths: performReadPaths,
            priorToolSnippets: toolSnippets,
            priorRelevantFiles: performRelevantFiles,
            priorToolTranscript: performReadTranscript,
            priorWrittenPaths: writtenPaths,
          },
        },
      });
      const planError = hardError(plan);
      if (planError) return failChain(0, planError);
      if (plan.pendingUserQuestion) {
        this.emit({ type: "chain_end", success: false, iterations: 0 });
        const threadSnapshot = buildThreadSnapshot({
          task,
          route: "task",
          success: false,
          iterations: 0,
          phases: result,
          refs,
          usage,
          pendingUserQuestion: plan.pendingUserQuestion,
          discoveredPaths,
          readPaths,
          writtenPaths,
          relevantFiles,
          ...(planJson?.length ? { planJson } : {}),
        });
        return {
          success: false,
          iterations: 0,
          phases: result,
          refs,
          usage,
          route: "task",
          pendingUserQuestion: plan.pendingUserQuestion,
          threadSnapshot,
        };
      }
      if (!opts.askUserQuestion || !planJson?.length) {
        break;
      }
      const decision = parsePlanReviewDecision(await opts.askUserQuestion(buildPlanReviewRequest()));
      if (decision.type === "approve") {
        break;
      }
      if (decision.type === "reject") {
        this.emit({ type: "chain_end", success: false, iterations: 0 });
        const error = decision.feedback;
        const threadSnapshot = buildThreadSnapshot({
          task,
          route: "task",
          success: false,
          iterations: 0,
          phases: result,
          refs,
          usage,
          ...(error ? { error } : {}),
          discoveredPaths,
          readPaths,
          writtenPaths,
          relevantFiles,
          ...(planJson?.length ? { planJson } : {}),
        });
        return {
          success: false,
          iterations: 0,
          phases: result,
          refs,
          usage,
          route: "task",
          ...(error ? { error } : {}),
          threadSnapshot,
        };
      }
      planReviewFeedback = decision.feedback;
    }

    // --- Build Perform work units (req: one Perform per plan; a complex/multi-repo
    //     task yields several plans, each run in its own Perform pass in order) ---
    const performUnits = buildPerformUnits({
      plan,
      planSet: plan.planSet,
      fallback: {
        allowedWorkPaths: performWorkPaths,
        plannedFileMutations: performFileMutations,
        attachedFileContents,
        attachedContextFiles,
        readTranscript: performReadTranscript,
        readPaths: performReadPaths,
        relevantFiles: performRelevantFiles,
        discoveredPaths: performDiscoveredPaths,
        planJson,
      },
    });

    // --- Perform / Perfect loop ---
    let success = false;
    let iteration = 0;
    let feedback: string | undefined;
    while (iteration < maxIter) {
      if (signal?.aborted) break;
      this.emit({ type: "chain_iteration", iteration: iteration + 1 });

      // Run one Perform per plan, in execution order. Each unit is scoped to its
      // plan's files/mutations and inherits the plan's per-task complexity.
      let performError: string | undefined;
      for (const unit of performUnits) {
        if (signal?.aborted) break;
        const perform = await this.runPhase("perform", task, {
          allowedWorkPaths: unit.allowedWorkPaths,
          plannedFileMutations: unit.plannedFileMutations,
          attachedFileContents: unit.attachedFileContents,
          attachedContextFiles: unit.attachedContextFiles,
          priorPlanJson: unit.priorPlanJson,
          complexityByPath: unit.complexityByPath,
          complexitySource: "plan-task",
          ...(unit.planLabel ? { planLabel: unit.planLabel } : {}),
          priorSummaries: [{ phase: "plan", summary: plan.summary }],
          priorRefs: refs,
          priorDiscoveredPaths: unit.priorDiscoveredPaths,
          priorReadPaths: unit.priorReadPaths,
          priorRelevantFiles: unit.priorRelevantFiles,
          priorToolTranscript: unit.priorToolTranscript,
          priorWrittenPaths: writtenPaths,
          priorProjectProfile: projectProfile,
          priorProjectRunbook: projectRunbook,
          priorCapabilities: capabilities,
          priorProviderAssignments: providerAssignments,
          feedback,
          signal,
          ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
        });
        result.perform = perform;
        history.push(perform);
        record(perform);
        performError = hardError(perform);
        if (performError) break;
      }
      if (performError) return failChain(iteration + 1, performError);

      const perfect = await this.runPhase("perfect", task, {
        priorSummaries: summaries,
        priorRefs: refs,
        priorDiscoveredPaths: discoveredPaths,
        priorReadPaths: readPaths,
        priorToolSnippets: toolSnippets,
        priorRelevantFiles: relevantFiles,
        priorToolTranscript: toolTranscript,
        priorWrittenPaths: writtenPaths,
        priorProjectProfile: projectProfile,
        priorProjectRunbook: projectRunbook,
        priorCapabilities: capabilities,
        priorProviderAssignments: providerAssignments,
        signal,
        ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
      });
      result.perfect = perfect;
      history.push(perfect);
      record(perfect);
      const perfectError = hardError(perfect);
      if (perfectError) return failChain(iteration + 1, perfectError);

      iteration++;
      if (perfect.verified) {
        success = true;
        break;
      }
      // Feed the FIX section (or full summary) back into the next Perform run.
      feedback =
        (perfect.artifacts?.fix as string | undefined) ?? perfect.summary ?? "Verification failed; address the issues.";
    }

    this.emit({ type: "chain_end", success, iterations: iteration });
    return {
      success,
      iterations: iteration,
      phases: result,
      refs,
      usage,
      route: "task",
      threadSnapshot: buildThreadSnapshot({
        task,
        route: "task",
        success,
        iterations: iteration,
        phases: result,
        refs,
        usage,
        discoveredPaths,
        readPaths,
        writtenPaths,
        relevantFiles,
        ...(planJson?.length ? { planJson } : {}),
      }),
    };
  }

  /**
   * Expose the phases as meta-tools so they can be composed into an outer
   * tool-call chain (req #3/#4: "loaded to tool calls chain"). Each meta-tool runs
   * one phase and returns its summary.
   */
  phaseTools(): AgentTool[] {
    return PHASES.map((phase) => ({
      name: `phase_${phase}`,
      description: `Run the ${phase.toUpperCase()} phase of the 4P coding chain on a task.`,
      mutates: phase === "perform",
      phases: [phase],
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "The task/subtask for this phase." } },
        required: ["task"],
      },
      execute: async (_id, args) => {
        const r = await this.runPhase(phase, String(args.task));
        return {
          output: r.summary,
          details: { phase, verified: r.verified, complexity: r.complexity, refs: r.refs },
        };
      },
    }));
  }

  /**
   * A meta-tool that runs the entire 4P chain — the "single tool running each 4
   * tools" of req #4. Successful completion of the chain == a successful operation.
   */
  chainTool(): AgentTool {
    return {
      name: "code",
      description:
        "Run the full 4P coding chain (Prepare → Plan → Perform → Perfect, with verify/retry) on a task. Returns success + per-phase summaries.",
      mutates: true,
      phases: ["perform"],
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "What to build/fix." } },
        required: ["task"],
      },
      execute: async (_id, args) => {
        const r = await this.runChain(String(args.task));
        return {
          output: `Chain ${r.success ? "succeeded" : "did not verify"} in ${r.iterations} iteration(s).\nPERFECT: ${r.phases.perfect?.summary ?? "(n/a)"}`,
          details: r,
          isError: !r.success,
        };
      },
    };
  }
}

function filterPlanHandoffTools(tools: AgentTool[]): AgentTool[] {
  const blockedBuiltinNames = new Set(["bash", "bash_readonly", "ls", "grep", "cat"]);
  return tools.filter((tool) => tool.name === "read" || !blockedBuiltinNames.has(tool.name));
}

function resolvePlanAllowedReadPaths(
  relevantFiles: PrepareRelevantFile[],
  toolTranscript: PrepareToolTranscriptEntry[],
  readPaths: string[],
): string[] {
  const out = new Set<string>();
  for (const file of relevantFiles) out.add(file.path);
  for (const entry of toolTranscript) {
    if (entry.target?.startsWith("/")) out.add(entry.target);
  }
  if (!out.size) {
    for (const filePath of readPaths) out.add(filePath);
  }
  return [...out];
}

function filterRelevantFilesToAllowlist(
  files: PrepareRelevantFile[] | undefined,
  allowedPaths: string[],
): PrepareRelevantFile[] {
  if (!files?.length || !allowedPaths.length) return [];
  const allowed = new Set(allowedPaths);
  return files.filter((file) => allowed.has(stripMarkdownTicks(file.path)));
}

function filterReadFileContentsToAllowlist(
  files: ReadFileContent[] | undefined,
  allowedPaths: string[],
): ReadFileContent[] {
  if (!files?.length || !allowedPaths.length) return [];
  const allowed = new Set(allowedPaths);
  return files.filter((file) => allowed.has(stripMarkdownTicks(file.path)));
}

function excludeReadFileContentsFromAllowlist(
  files: ReadFileContent[] | undefined,
  allowedPaths: string[],
): ReadFileContent[] {
  if (!files?.length) return [];
  const allowed = new Set(allowedPaths);
  return files.filter((file) => !allowed.has(stripMarkdownTicks(file.path)));
}

function buildReadTranscriptFromAttachedFiles(files: ReadFileContent[]): PrepareToolTranscriptEntry[] {
  return files.map((file) => ({
    tool: "read",
    target: file.path,
    summary: summarizeFileContentForTranscript(file.content),
  }));
}

function summarizeFileContentForTranscript(content: string): string {
  const line = content
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return "file content attached from plan";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function resolvePerformWorkPaths(plan: PhaseResult, planJson: unknown[] | undefined): string[] {
  const knownList = collectKnownPlanPaths(plan);
  const out = new Set<string>();
  for (const candidate of extractPlanJsonFilePaths(planJson)) {
    const resolved = resolvePlannedPath(candidate, knownList);
    if (resolved) out.add(resolved);
  }
  if (!out.size) {
    for (const file of plan.relevantFiles ?? []) out.add(stripMarkdownTicks(file.path));
  }
  if (!out.size) {
    for (const filePath of plan.readPaths ?? []) out.add(stripMarkdownTicks(filePath));
  }
  return [...out].filter(Boolean);
}

function resolvePerformFileMutations(
  plan: PhaseResult,
  planJson: unknown[] | undefined,
): Record<string, PlanFileMutationMode> {
  if (!planJson?.length) return {};
  const knownList = collectKnownPlanPaths(plan);
  const out: Record<string, PlanFileMutationMode> = {};
  for (const entry of planJson) {
    if (!entry || typeof entry !== "object") continue;
    const fileMutations = (entry as { fileMutations?: unknown }).fileMutations;
    if (!fileMutations || typeof fileMutations !== "object") continue;
    for (const [candidate, mode] of Object.entries(fileMutations as Record<string, unknown>)) {
      if ((mode !== "edit" && mode !== "write") || !candidate.trim()) continue;
      const resolved = resolvePlannedPath(candidate, knownList);
      if (resolved) out[resolved] = mode;
    }
  }
  return out;
}

function collectKnownPlanPaths(plan: PhaseResult): string[] {
  const knownPaths = [
    ...(plan.readPaths ?? []),
    ...(plan.relevantFiles ?? []).map((file) => stripMarkdownTicks(file.path)),
    ...(plan.discoveredPaths ?? []),
  ].map(stripMarkdownTicks);
  return [...new Set(knownPaths.filter(Boolean))];
}

function extractPlanJsonFilePaths(planJson: unknown[] | undefined): string[] {
  if (!planJson?.length) return [];
  const out: string[] = [];
  for (const entry of planJson) {
    if (!entry || typeof entry !== "object") continue;
    const files = (entry as { files?: unknown }).files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file === "string" && file.trim()) out.push(file.trim());
    }
  }
  return out;
}

function resolvePlannedPath(candidate: string, knownList: string[]): string | null {
  const normalized = stripMarkdownTicks(candidate);
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  const trimmed = normalized.replace(/^\.\//, "");
  const matches = knownList.filter((filePath) => filePath === trimmed || filePath.endsWith(`/${trimmed}`));
  return matches.length === 1 ? matches[0]! : null;
}

function stripMarkdownTicks(value: string): string {
  return value.replace(/^`+|`+$/g, "").trim();
}

/** One Perform pass's fully-resolved inputs. A single-repo task has exactly one
 *  unit; a multi-repo task has one per plan, run in execution order. */
interface PerformUnit {
  allowedWorkPaths: string[];
  plannedFileMutations: Record<string, PlanFileMutationMode>;
  attachedFileContents: ReadFileContent[];
  attachedContextFiles: ReadFileContent[];
  priorDiscoveredPaths: string[];
  priorReadPaths: string[];
  priorRelevantFiles: PrepareRelevantFile[];
  priorToolTranscript: PrepareToolTranscriptEntry[];
  priorPlanJson?: unknown[];
  complexityByPath: Record<string, ComplexityRating>;
  planLabel?: string;
}

interface PerformFallbackInputs {
  allowedWorkPaths: string[];
  plannedFileMutations: Record<string, PlanFileMutationMode>;
  attachedFileContents: ReadFileContent[];
  attachedContextFiles: ReadFileContent[];
  readTranscript: PrepareToolTranscriptEntry[];
  readPaths: string[];
  relevantFiles: PrepareRelevantFile[];
  discoveredPaths: string[];
  planJson?: unknown[];
}

const COMPLEXITY_RANK: Record<ComplexityRating, number> = { low: 0, medium: 1, high: 2 };

function maxComplexity(a: ComplexityRating | undefined, b: ComplexityRating): ComplexityRating {
  if (!a) return b;
  return COMPLEXITY_RANK[b] > COMPLEXITY_RANK[a] ? b : a;
}

/**
 * Build the Perform work units. With a {@link PlanSet}, one unit per plan (scoped
 * to that plan's files, mutation modes, and per-task complexity). Without one
 * (legacy / no plan JSON), a single unit from the fallback inputs, still carrying
 * the shortlist's per-file complexity so Perform inherits Prepare's judgement.
 */
function buildPerformUnits(input: {
  plan: PhaseResult;
  planSet?: PlanSet;
  fallback: PerformFallbackInputs;
}): PerformUnit[] {
  const { plan, planSet, fallback } = input;
  if (!planSet?.plans.length) {
    const complexityByPath: Record<string, ComplexityRating> = {};
    for (const file of fallback.relevantFiles) {
      complexityByPath[stripMarkdownTicks(file.path)] = maxComplexity(
        complexityByPath[stripMarkdownTicks(file.path)],
        file.complexity,
      );
    }
    return [
      {
        allowedWorkPaths: fallback.allowedWorkPaths,
        plannedFileMutations: fallback.plannedFileMutations,
        attachedFileContents: fallback.attachedFileContents,
        attachedContextFiles: fallback.attachedContextFiles,
        priorDiscoveredPaths: fallback.discoveredPaths,
        priorReadPaths: fallback.readPaths,
        priorRelevantFiles: fallback.relevantFiles,
        priorToolTranscript: fallback.readTranscript,
        ...(fallback.planJson ? { priorPlanJson: fallback.planJson } : {}),
        complexityByPath,
      },
    ];
  }

  const knownList = collectKnownPlanPaths(plan);
  const byId = new Map(planSet.plans.map((p) => [p.id, p]));
  const orderedIds = planSet.executionOrder.length ? planSet.executionOrder : planSet.plans.map((p) => p.id);
  const multi = planSet.plans.length > 1;
  const units: PerformUnit[] = [];
  let index = 0;
  for (const id of orderedIds) {
    const doc = byId.get(id);
    if (!doc) continue;
    index += 1;
    const workPaths = new Set<string>();
    const plannedFileMutations: Record<string, PlanFileMutationMode> = {};
    const complexityByPath: Record<string, ComplexityRating> = {};
    for (const taskEntry of [...doc.tasks].sort((a, b) => a.order - b.order)) {
      for (const rawFile of taskEntry.files) {
        const resolved = resolvePlannedPath(rawFile, knownList) ?? stripMarkdownTicks(rawFile);
        if (!resolved) continue;
        workPaths.add(resolved);
        complexityByPath[resolved] = maxComplexity(complexityByPath[resolved], taskEntry.complexity);
      }
      for (const [rawFile, mode] of Object.entries(taskEntry.fileMutations)) {
        const resolved = resolvePlannedPath(rawFile, knownList) ?? stripMarkdownTicks(rawFile);
        if (resolved) plannedFileMutations[resolved] = mode;
      }
    }
    const workList = [...workPaths];
    const attachedFileContents = filterReadFileContentsToAllowlist(plan.readFileContents, workList);
    const attachedContextFiles = excludeReadFileContentsFromAllowlist(plan.readFileContents, workList);
    const attachedAll = [...attachedFileContents, ...attachedContextFiles];
    const readPaths = attachedAll.map((file) => file.path);
    const discoveredPaths = [...new Set([...workList, ...readPaths])];
    units.push({
      allowedWorkPaths: workList,
      plannedFileMutations,
      attachedFileContents,
      attachedContextFiles,
      priorDiscoveredPaths: discoveredPaths,
      priorReadPaths: readPaths,
      priorRelevantFiles: filterRelevantFilesToAllowlist(
        plan.relevantFiles?.length ? plan.relevantFiles : fallback.relevantFiles,
        discoveredPaths,
      ),
      priorToolTranscript: attachedAll.length ? buildReadTranscriptFromAttachedFiles(attachedAll) : fallback.readTranscript,
      // Single-plan: reuse the raw PLAN_JSON so Perform keeps every field the
      // planner emitted (e.g. "changes"). Multi-plan: hand each Perform ONLY its
      // own plan's tasks so it stays scoped to that plan.
      priorPlanJson: multi ? (doc.tasks as unknown[]) : (fallback.planJson ?? (doc.tasks as unknown[])),
      complexityByPath,
      ...(multi
        ? {
            planLabel: `Plan ${index}/${planSet.plans.length}: ${doc.title}${doc.repo ? ` (repo: ${doc.repo})` : ""} — ${doc.tasks
              .map((t) => t.title)
              .join("; ")}`,
          }
        : {}),
    });
  }
  return units.length ? units : buildPerformUnits({ plan, fallback });
}

function dedupeRefs(refs: MediaRef[]): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const r of refs) seen.set(r.uri, r);
  return [...seen.values()];
}

function summarizeProviderAssignments(registry: Registry): Record<Phase, Array<{ id: string; name: string; kind: string }>> {
  const out = {
    prepare: [] as Array<{ id: string; name: string; kind: string }>,
    plan: [] as Array<{ id: string; name: string; kind: string }>,
    perform: [] as Array<{ id: string; name: string; kind: string }>,
    perfect: [] as Array<{ id: string; name: string; kind: string }>,
  };
  for (const provider of registry.list()) {
    for (const phase of provider.phases) {
      out[phase].push({ id: provider.id, name: provider.name, kind: provider.kind });
    }
  }
  for (const phase of Object.keys(out) as Phase[]) {
    out[phase].sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}

function summarizeRegisteredProviders(registry: Registry): RegisteredProviderSummary[] {
  return registry.list().map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    description: provider.description,
    phases: provider.phases,
    toolNames: provider.tools.map((tool) => tool.name),
  }));
}
