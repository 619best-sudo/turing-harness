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
import { PROBE_MARKER_RE } from "../probe-marker.js";
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  AssistantMessage,
  ComplexityRating,
  LiveImage,
  LLMBridge,
  MediaRef,
  Model,
  Phase,
  PlanFileMutationMode,
  PlanSet,
  PlanTask,
  PhaseResult,
  PrepareProviderAssignmentMap,
  PrepareRelevantFile,
  PrepareToolTranscriptEntry,
  ReadFileContent,
  RegisteredProviderSummary,
  RunLoopResult,
  RunStep,
  ThreadFollowUpContext,
  ThreadRunDisposition,
  ThreadRunSnapshot,
  TranscriptMode,
  ThinkingLevel,
  ToolSnippet,
  Usage,
} from "../types.js";
import { emptyUsage, PHASES } from "../types.js";
import type { VerifyOptions, VerificationReport } from "../types.js";
import { Registry, type PhaseToolSpec } from "../registry/registry.js";
import { LogStore } from "../logging/logger.js";
import { PermissionGate } from "./permission.js";
import { runPhase, type PhaseRunInput } from "./phase-runner.js";
import { VerificationGate, parseDeclarations, type VerificationGap } from "./verification-gate.js";
import { ReproductionGate, type ReproductionReport } from "./reproduction-gate.js";
import { ClarifyGate } from "./clarify-gate.js";
import { QaGate } from "./qa-gate.js";
import { detectProject } from "../memory/detect.js";
import type { ProjectCategory } from "../presets/project-presets.js";
import { coordinateRunHandoff, type RunHandoffResult } from "./run-handoff.js";
import {
  VerifyStageTracker,
  buildStageMessage,
  buildFullVerificationMessage,
  type VerifyStageContext,
} from "./verify-stages.js";
import { waitForUserEvidence } from "./evidence-wait.js";
import {
  detectDeviceRunCommands,
  detectDevServerCommands,
  detectMobileStack,
  type ProjectRunCommand,
} from "../exec/run-commands.js";
import { newRunId, ensureArtifactDir } from "./verify-artifacts.js";
import { OpenRouterBridge } from "../llm/bridge.js";
import { DEFAULT_PHASE_MODELS } from "../llm/models.js";
import { estimateComplexity } from "../llm/model-selector.js";
import {
  buildLoopSystemPrompt,
  CONVERSATIONAL_LOOKUP,
  CONVERSATIONAL_PROMPT,
  INTENT_ROUTER_PROMPT,
} from "../phases/prompts.js";
import { runToolLoop, type ToolLoopResult } from "./loop.js";
import { isNonFatalLoopError } from "./stall-guard.js";
import { extractPlanSet, normalizeLegacyPlanJson, extractPlanJson } from "./plan-extract.js";
import { triageImageAttachment, triageDocumentAttachment, isDocumentRef, describeImageRole } from "./attachment-triage.js";
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
  /**
   * Mirrors `BuiltinToolsConfig.authorOnlyWrites`. The orchestrator does not build
   * tools, so it cannot infer this from the registry — under that mode the toolset
   * still contains a tool NAMED `bash`, just a guarded one that refuses to author
   * source. It is carried here purely so the system prompts stop advising a shell
   * fallback the runtime rejects.
   */
  authorOnlyWrites?: boolean;
  /** Multimodal slug used to describe tool images for a text-only run model. */
  visionModel?: string;
  /**
   * Host-owned escalation routing: (kind, rating) → model slug. Threaded into
   * every work loop, which uses it for write/edit authoring and hands it to
   * tools as `ctx.routeModel` for staged reads.
   */
  routeModel?: import("../types.js").ModelRouter;
  /** Customize the fixed toolset per phase. Each value may be an exact
   *  `AgentTool[]`, a `PhaseToolFilter` (include/exclude over the category), or a
   *  resolver function. If omitted, tools are resolved from the registry by 4P
   *  category. (req #3: each P has fixed mcps/skills — and they're customizable.) */
  phaseTools?: Partial<Record<Phase, PhaseToolSpec>>;
  /**
   * Optional per-phase hard cap on tool-call turns. Unset by default — a phase
   * runs until its model stops calling tools; `StallGuard` ends non-converging
   * loops instead. Set only to bound a phase deliberately.
   */
  maxSteps?: Partial<Record<Phase, number>>;
  reasoning?: Partial<Record<Phase, ThinkingLevel>>;
  temperature?: Partial<Record<Phase, number>>;
  /** Max Perfect→Perform retry iterations before giving up. */
  maxChainIterations?: number;
  /** Host-owned reconciliation hook invoked after Prepare and before Plan. */
  afterPrepare?: AfterPrepareHook;
  /** How much raw transcript detail should be emitted/persisted for hosts. */
  transcriptMode?: TranscriptMode;
  /**
   * Whether to auto-triage image attachments at the start of a task run: one
   * cheap `media_analysis` call per image to learn its role (informational /
   * ui-replicate / ui-bug) and any OCR text, then surface that in the loop so
   * follow-up write/edit calls get the data without the model re-analyzing.
   * Default `true`; pass `false` to skip the pre-pass (latency-sensitive runs
   * where the host already knows the images' roles).
   */
  autoTriageAttachments?: boolean;
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
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
}

export interface RunChainOptions {
  signal?: AbortSignal;
  /**
   * Optional host callback for `ask_user_question`. Threaded to every phase.
   * See `RunPhaseOptions.askUserQuestion` for behavior.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
}

/**
 * Options for the flat loop driver {@link Orchestrator.run}. This is the primary
 * entry point going forward; `runChain`/`runPhase` remain as back-compat shims.
 */
/**
 * An attached image after triage: the same ref the host supplied, plus what the
 * `media_analysis` pre-pass learned about it — the `category` that routes it
 * (reference material vs. a mockup to rebuild vs. a defect to fix), the verbatim
 * `ocr` text when it carries any, and a one-line `note` for the model.
 */
export interface EnrichedImage {
  path: string;
  mimeType: string;
  category?: string;
  ocr?: string;
  note?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Optional host callback for `ask_user_question`, threaded into the loop. */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  /**
   * Host callback for `create_plan` review. Overrides the orchestrator-level
   * callback for this run. Absent (here and on the orchestrator) ⇒ the plan tool
   * auto-approves its first draft.
   */
  planApproval?: import("../types.js").PlanApprovalCallback;
  /** Structured continuity from the previous completed run in this session. */
  followUpContext?: ThreadFollowUpContext;
  transcriptMode?: TranscriptMode;
  /**
   * Emit the model's reasoning blocks to the UI. Defaults to `false` under
   * `transcriptMode: "compact"` and `true` otherwise. Set it explicitly to keep
   * reasoning visible in a compact transcript — otherwise the first turn's
   * thinking is dropped before any host callback can ask for it back.
   */
  emitReasoning?: boolean;
  /** Same, for assistant text. Same defaults. */
  emitText?: boolean;
  /** Image refs made available to the loop's write/edit authoring passes. */
  images?: Array<{ path: string; mimeType: string }>;
  /**
   * Non-image attachment refs (documents, audio, video, data files) made visible
   * to the loop. Unlike `images` these are not vision-authored; they are listed
   * to the model as AVAILABLE FILES so it can `read` text/code/data or analyze
   * PDF/DOCX/audio/video with `media_analysis`. Document types are also run
   * through the triage pre-pass so their text reaches authoring via `mediaFact`.
   * Without this, a non-image attachment is invisible to the loop — the model
   * never learns the file exists and cannot act on it.
   */
  files?: Array<{ path: string; mimeType: string }>;
  /**
   * Populated by the orchestrator's attachment triage pre-pass (when
   * `autoTriageAttachments` is enabled): the same image refs as `images`, each
   * optionally annotated with the triage `category`, extracted `ocr` text, and a
   * human-readable `note` summarizing the role. The loop-opening and step
   * messages prefer this over `images` so the model learns each image's role
   * without re-running media analysis. Hosts do not set this; they set `images`.
   */
  enrichedImages?: EnrichedImage[];
  /**
   * Skip the planning turn and run a single work loop. Default false: the model
   * decides whether to plan. Set true for trivial / latency-sensitive calls.
   */
  skipPlan?: boolean;
  /**
   * Optional hard cap on tool-call turns per plan step. Omitted by default: a
   * step runs until the model stops calling tools, with stall detection (not a
   * step count) ending a loop that cannot converge.
   */
  maxStepsPerStep?: number;
  /**
   * Whether this run is fixing a REPORTED BUG rather than building something new.
   *
   * Turns on the reproduce-before-you-edit gate in every work loop of the run:
   * the first `write`/`edit` is refused until something has actually observed the
   * broken behaviour (a capture, a collected trace, a project log) or the run has
   * asked the user for steps.
   *
   * Resolution: an explicit `true`/`false` always wins. When LEFT UNSET, the
   * intent classifier's `bugFixHint` is consulted — so a host that doesn't know
   * how the task reached it still gets the reproduce gate on messages that read
   * like a bug report. Pass `false` explicitly to suppress a false-positive hint.
   */
  isBugFix?: boolean;
  /**
   * Verify-what-you-wrote gate. Default ON for any task route: after the work
   * loops finish, refuse the summary until every written RUNTIME file has a
   * check behind it (visual → activity_inspect + media_analysis, logic → trace
   * loop or tests, endpoint → curl), with the build→ask→drive-or-wait handoff.
   * Static files (docs/config/fixtures) bypass via a logged declaration. Pass
   * `false` to disable the gate entirely; pass `{ maxRounds }` to tune it. A
   * verification failure never fails a run — it reports `verified: false`.
   */
  verify?: boolean | VerifyOptions;
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
  /** Runtime reasoning-effort overrides per phase (mirrors modelOverrides). */
  private reasoningOverrides: Partial<Record<Phase, ThinkingLevel>> = {};
  /** Runtime per-phase toolset overrides (customizable at any time). */
  private phaseToolOverrides: Partial<Record<Phase, PhaseToolSpec>> = {};
  /** Optional host-owned Prepare reconciliation hook. */
  private afterPrepareHook?: AfterPrepareHook;
  /** Session-level plan-review callback; a per-run `opts.planApproval` wins. */
  private planApprovalCallback?: import("../types.js").PlanApprovalCallback;
  /**
   * The detected project category, MUTABLE so the post-Prepare reconciliation
   * (which can correct a frontend preset to backend once the repo is scanned)
   * is seen live by every work loop. Seeded from the preset at construction,
   * overwritten in `Session.reconcileAfterPrepare`. Drives the non-UI skip.
   */
  projectCategory?: import("../presets/project-presets.js").ProjectCategory;

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
   * Re-point the candidate model pool (cheap → capable) after construction.
   *
   * Hosts that keep a WARM session per project but let the user change models per
   * run need this: the pool drives both per-call model selection and the internal
   * escalation a staged tool performs (see `ToolContext.toolModelCandidates`), and
   * a pool pinned at session-creation time would go stale the moment the user
   * switches models. Pass an empty array to disable escalation entirely.
   */
  /** Install the host's plan-review callback for every subsequent run. */
  setPlanApprovalCallback(cb: import("../types.js").PlanApprovalCallback | undefined): void {
    this.planApprovalCallback = cb;
  }

  setToolModelCandidates(slugs: string[] | undefined): void {
    this.config.toolModelCandidates = slugs?.length ? [...slugs] : undefined;
  }

  /**
   * Install (or clear) the host's escalation routing table for subsequent runs.
   *
   * Symmetric with `setToolModelCandidates`, and needed for the same reason: a
   * host that reuses a warm session could previously only supply `routeModel` at
   * CREATION time. A run configured after creation therefore had no router, so
   * write/edit escalation silently never fired — `routedAuthorSlug` stayed
   * undefined and the driver's own draft was written verbatim.
   */
  setRouteModel(router: import("../types.js").ModelRouter | undefined): void {
    this.config.routeModel = router;
  }

  /**
   * Set (or clear) the model for a phase or the orchestrator at runtime (req #5).
   * Precedence when resolving: runtime override → constructor config → default.
   */
  setModel(target: Phase | "orchestrator", slug: string | undefined): void {
    if (slug) this.modelOverrides[target] = slug;
    else delete this.modelOverrides[target];
  }

  /**
   * Set (or clear) the reasoning effort for a phase at runtime, mirroring
   * `setModel`. Precedence when resolving: runtime override → constructor
   * config. Drives whether the phase model is *asked* to reason (and thus
   * whether thinking tokens are ever produced for the UI to emit).
   */
  setReasoning(target: Phase, level: ThinkingLevel | undefined): void {
    if (level) this.reasoningOverrides[target] = level;
    else delete this.reasoningOverrides[target];
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
      // Not inferable inside the phase runner: under this mode the toolset still
      // holds a tool named `bash`, only guarded. Without it the phase prompt keeps
      // telling the model to write files through a shell that will refuse.
      authorOnlyWrites: this.config.authorOnlyWrites === true,
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
      // No default cap: a phase runs until its model stops calling tools (or the
      // stall guard fires). Only an explicit per-phase budget bounds it.
      maxSteps: this.config.maxSteps?.[phase],
      temperature: this.config.temperature?.[phase],
      reasoning: this.reasoningOverrides[phase] ?? this.config.reasoning?.[phase],
      // A PHASE-scoped permission decision may raise/lower the phase's reasoning
      // effort for the whole phase (overrides the harness/override default above).
      ...(typeof decision.thinkingLevel === "string" ? { reasoning: decision.thinkingLevel } : {}),
      toolModelCandidates: this.config.toolModelCandidates,
        ...(this.config.visionModel ? { visionModel: this.config.visionModel } : {}),
      followUpContext: opts.followUpContext,
      transcriptMode,
      ...(typeof decision.reasoning === "boolean" ? { emitReasoning: decision.reasoning } : {}),
      ...(opts.askUserQuestion ? { askUserQuestion: opts.askUserQuestion } : {}),
    };
    const result = await runPhase(runInput);
    // Lightweight end-of-phase signal for UI/IPC hosts: emit ONLY the
    // user-facing uiSummary + the structured handoff, so a host gets the one
    // string it renders + the continuity object without unpacking the heavy
    // PhaseResult that phase_end already carries. runPhase is the single
    // chokepoint for every chain phase + standalone phase, so this fires once
    // per phase end-to-end. The conversational short-circuit path builds its
    // own PhaseResult and never reaches here, so it can't double-emit.
    this.emit({
      type: "phase_summary",
      phase,
      uiSummary: result.uiSummary,
      handoff: result.handoff,
    });
    return result;
  }

  /**
   * The front of PREPARE: decide whether a request needs the full 4P pipeline or
   * is a conversational turn to answer directly. Uses the prepare-phase model for
   * a cheap, tool-free, two-line classification. Defaults to `route:"task"` and a
   * `false` bugfix hint on any ambiguity or model error, so real work is never
   * skipped and the expensive reproduce-before-edit gate is not falsely tripped.
   *
   * The `bugFixHint` is a HINT — the host's explicit `opts.isBugFix` always wins
   * at the resolution site in `run()`. Only when the host leaves `isBugFix`
   * unset does this hint turn a run into a bug-fix run.
   */
  /**
   * The project's category, detected from the workspace when the host never set
   * one. Cached for the instance — the manifests do not change mid-run.
   */
  private detectedCategory?: ProjectCategory;

  /**
   * The category to use this run: the host's if it set one, otherwise detected
   * from the workspace.
   *
   * This exists because a host that sets nothing made the category-dependent
   * behaviour silently inert, and "silently inert" was worse than the bug it
   * replaced. On a real run the verification gate fell back to `logic` for a
   * mobile screen file, the model satisfied that with the project's analyzer, and
   * the run reported `verified: true` for a change nobody had looked at — a FALSE
   * PASS, produced by correct code that never received the one input it needed.
   *
   * A library must not depend on a host remembering to pass something it can work
   * out for itself. `detectProject` already reads the workspace's manifests and
   * returns exactly this; calling it here costs one directory read per run.
   */
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
      // Detection is best-effort: an unreadable workspace must not fail a run.
      return undefined;
    }
  }

  private async classifyIntent(
    task: string,
    signal?: AbortSignal,
  ): Promise<{ route: ChainRoute; bugFixHint?: boolean; qaHint?: boolean; valueUnspecified?: boolean; usage?: Usage }> {
    try {
      const model = this.llm.resolveModel(this.phaseModelSlug("prepare"));
      const msg = await this.llm.complete(
        model,
        { systemPrompt: INTENT_ROUTER_PROMPT, messages: [{ role: "user", content: task, timestamp: Date.now() }] },
        { reasoning: "off", signal },
      );
      // The router runs on EVERY prompt, so dropping its usage under-reports
      // every single run — including the conversational ones, where it is a
      // meaningful share of the total.
      const usage = msg.usage;
      if (msg.stopReason === "error") return { route: "task", ...(usage ? { usage } : {}) }; // endpoint failure → let the chain surface it
      const raw = messageText(msg);
      const text = raw.toUpperCase();
      // ROUTE: CONVERSATIONAL only when stated and TASK is not. Default TASK.
      const route: ChainRoute =
        text.includes("CONVERSATIONAL") && !text.includes("TASK") ? "conversational" : "task";
      // BUGFIX: YES only on an explicit `BUGFIX: YES` line. The hint defaults
      // off so the reproduce gate is never falsely armed by a malformed reply.
      const bugLine = raw
        .split(/\r?\n/)
        .map((l) => l.trim().toUpperCase())
        .find((l) => l.startsWith("BUGFIX"));
      const bugFixHint = bugLine ? bugLine.includes("YES") && !bugLine.includes("NO") : false;
      // QA: YES only on an explicit `QA: YES` line — the primary goal is to
      // verify existing behavior and report a verdict, with no change requested.
      // Same default-off shape as BUGFIX so an older/malformed router reply
      // (including one without the QA line) never engages the QA path.
      const qaLine = raw
        .split(/\r?\n/)
        .map((l) => l.trim().toUpperCase())
        .find((l) => l.startsWith("QA"));
      const qaHint = qaLine ? qaLine.includes("YES") && !qaLine.includes("NO") : false;
      // UNSPECIFIED: the request names a value to change and never says what to.
      // Same shape and same default as BUGFIX — an explicit `YES` line and
      // nothing else arms it, so a malformed reply (or an older router prompt)
      // leaves the clarify gate inert rather than refusing writes on a guess.
      const unspecLine = raw
        .split(/\r?\n/)
        .map((l) => l.trim().toUpperCase())
        .find((l) => l.startsWith("UNSPECIFIED"));
      const valueUnspecified = unspecLine
        ? unspecLine.includes("YES") && !unspecLine.includes("NO")
        : false;
      return { route, bugFixHint, qaHint, valueUnspecified, ...(usage ? { usage } : {}) };
    } catch {
      return { route: "task" };
    }
  }

  /**
   * Triage each image attachment once, up front, by invoking the
   * `media_analysis` tool with a `describe` lens per image. Returns the enriched
   * image list (each entry carrying its triaged `category`, any extracted `ocr`,
   * and a `note`) and a combined `mediaFact` of the informational images' text,
   * which seeds the loops' `mediaFact` accumulator so the first write/edit
   * already knows the reference text.
   *
   * Resilient by design: any per-image failure leaves that image un-enriched
   * (the loops fall back to treating it as undifferentiated), and the whole
   * pass returns `undefined` if the tool isn't registered or aborts — so a
   * triage failure never blocks the run, only forgoes the enrichment.
   */
  private async triageAttachments(
    images: Array<{ path: string; mimeType: string }>,
    task: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        enriched: EnrichedImage[];
        mediaFact: string | undefined;
        usage: import("../types.js").Usage | undefined;
      }
    | undefined
  > {
    const ctx = this.triageContext(signal);
    if (!ctx) return undefined;
    const enriched: EnrichedImage[] = [];
    const facts: string[] = [];
    let usage: import("../types.js").Usage | undefined;
    for (const img of images) {
      if (signal?.aborted) break;
      const { result, fact, usage: u } = await triageImageAttachment(img, task, ctx);
      if (fact) facts.push(fact);
      if (u) usage = usage ? addUsage(usage, u) : u;
      enriched.push(result);
    }
    const mediaFact = facts.length ? facts.join("\n") : undefined;
    return { enriched, mediaFact, usage };
  }

  /**
   * Build the reusable triage {@link TriageContext} for this orchestrator, or
   * `undefined` when the `media_analysis` tool is not registered. Both the
   * up-front pre-pass ({@link triageAttachments}) and the mid-run callback the
   * work loop uses for user-answered attachments ({@link buildTriageCallback})
   * resolve their tool + bridge here, so there is exactly one place that decides
   * "no tool ⇒ no triage".
   */
  private triageContext(signal?: AbortSignal): import("./attachment-triage.js").TriageContext | undefined {
    let tool: import("../types.js").AgentTool | undefined;
    try {
      tool = this.registry.getTool("media_analysis");
    } catch {
      tool = undefined;
    }
    if (!tool) return undefined;
    return {
      tool,
      cwd: this.cwd,
      llm: this.llm,
      registry: this.registry,
      logStore: this.logStore,
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * Build a callback the work loop can invoke to triage a single image a user
   * hands over MID-RUN (in answer to `ask_user_question`), so a spec or
   * screenshot dropped after the run started is understood exactly like one
   * attached up front — its text lifted into `mediaFact`, its role logged.
   * Returns `undefined` when triage is off or the tool is unavailable, in which
   * case the loop keeps the legacy behavior (a raw, un-enriched live image).
   */
  private buildTriageCallback(
    task: string,
    signal?: AbortSignal,
  ): ((img: { path: string; mimeType: string }) => Promise<{ fact?: string; note?: string; category?: string } | undefined>) | undefined {
    const ctx = this.triageContext(signal);
    if (!ctx) return undefined;
    return async (img) => {
      if (signal?.aborted) return undefined;
      try {
        const { result, fact } = await triageImageAttachment(img, task, ctx);
        return {
          ...(fact ? { fact } : {}),
          ...(result.category ? { category: result.category } : {}),
          ...(result.note ? { note: result.note } : {}),
        };
      } catch {
        return undefined;
      }
    };
  }


  /**
   * Stream a direct conversational answer (no tools, no project assumptions),
   * emitting the same message and turn_end events a phase emits so a subscribed
   * Agent folds it into its message history. Returns the finished message.
   *
   * Reasoning honours the configured level rather than being forced off. This is
   * a USER-VISIBLE assistant turn — `classifyIntent` routes any prompt it reads
   * as conversational here, which includes plain questions like "what is 17*23?"
   * where a host showing a thinking block most expects one. Hard-disabling it
   * meant a host could set `thinkingLevel: "high"` and still see no reasoning,
   * with nothing in the transcript explaining why. The genuinely internal calls
   * (`classifyIntent`, `summarizeRun`) stay off on purpose: their output is
   * machinery, never shown.
   */
  private async streamConversationalReply(
    task: string,
    signal?: AbortSignal,
  ): Promise<{ message: AssistantMessage; error?: string }> {
    const model = this.llm.resolveModel(this.phaseModelSlug("prepare"));

    // Web lookup, when the host registered it.
    //
    // The router sends everything needing no PROJECT work here, and that set is
    // wider than small talk: "what's the current React release?", "is this
    // library still maintained?", "what changed in Node 24?" are all
    // conversational by that definition. With no tools at all the model could
    // only answer those from weights — a stale answer stated confidently, with
    // nothing in the transcript revealing it was stale. Project access is still
    // withheld (that is what makes this path cheap and safe); only the outward
    // lookup is granted.
    const lookupTools = this.resolveConversationalTools();
    if (lookupTools.length) {
      return this.streamConversationalWithLookup(task, model, lookupTools, signal);
    }

    const context = {
      systemPrompt: CONVERSATIONAL_PROMPT,
      messages: [{ role: "user" as const, content: task, timestamp: Date.now() }],
    };
    // Same resolution the work loop uses, but keyed on "prepare" to match the
    // model this path resolves above.
    const reasoning = this.reasoningOverrides["prepare"] ?? this.config.reasoning?.["prepare"];
    this.emit({ type: "turn_start" });
    let final: AssistantMessage | undefined;
    let started = false;
    for await (const ev of this.llm.stream(model, context, { ...(reasoning ? { reasoning } : {}), signal })) {
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
   * Run the flat loop driver — the primary entry point. A conversational prompt
   * is answered inline; a real task runs one or more bounded tool sub-loops
   * (one per plan step, or a single loop when no plan is produced), then a final
   * summary turn over the whole run.
   *
   * Emits only the pi-compatible events (message_*, turn_*, tool_execution_*,
   * permission_*, agent_*) so a pi UI renders it without 4P-specific handling.
   * The four callbacks (permission, model, complexity, category-via-phase) all
   * fire inside each tool sub-loop.
   */
  async run(task: string, opts: RunOptions = {}): Promise<RunLoopResult> {
    const signal = opts.signal ?? this.config.signal;
    this.emit({ type: "chain_start", task });

    // --- Front intent routing: small talk is answered inline. ---
    // `bugFixHint` is the classifier's read on whether this looks like a bug
    // fix; it only matters when the host did NOT set `opts.isBugFix` explicitly
    // (see the `??` resolution below). Captured here, used at the gate.
    let bugFixHint = false;
    // The router's read on whether the PRIMARY goal is to VERIFY existing
    // behavior (no change requested). Engages the staged verify spine even when
    // nothing was written — the agent observes and reports a pass/fail verdict.
    let qaIntent = false;
    // The router's read on whether the request names a value to change without
    // saying what to change it to. Arms the clarify gate below; see
    // `clarify-gate.ts` for why the judgement is made by the router rather than
    // by a pattern here.
    let valueUnspecified = false;
    // Declared before the routing branch so the router's own turn is billed on
    // BOTH paths. It runs unconditionally; leaving it out of the total makes
    // every run — task and conversational alike — under-report what it spent.
    let usage = emptyUsage();
    if (!signal?.aborted) {
      const intent = await this.classifyIntent(task, signal);
      bugFixHint = intent.bugFixHint === true;
      qaIntent = intent.qaHint === true;
      valueUnspecified = intent.valueUnspecified === true;
      if (intent.usage) usage = addUsage(usage, intent.usage);
      // The conversational path is text-only — it has no tools that can read a
      // file, so an attachment-bearing request that routes here would have its
      // attachment silently dropped (and the answer hallucinated from weights).
      // Force such requests onto the task path, which triages images, surfaces
      // all files, and can actually read them. A chatty line with a stray
      // attachment costing a work loop is the safe, rare tradeoff.
      const hasAttachments = !!(opts.images?.length || opts.files?.length);
      if (intent.route === "conversational" && !hasAttachments) {
        const { message, error } = await this.streamConversationalReply(task, signal);
        if (message.usage) usage = addUsage(usage, message.usage);
        const summary = messageText(message);
        const threadSnapshot = buildRunThreadSnapshot({
          task,
          route: "conversational",
          success: !error,
          summary,
          usage,
          ...(error ? { error } : {}),
        });
        this.emit({ type: "chain_end", success: !error, iterations: 0 });
        return {
          task,
          route: "conversational",
          success: !error,
          summary,
          steps: [],
          refs: [],
          usage,
          threadSnapshot,
          ...(error ? { error } : {}),
        };
      }
    }

    const tools = this.resolveLoopTools();
    const resolveTools = () => this.resolveLoopTools();
    // Built ONCE and used by every loop of this run — planning, work, verify and
    // the instrumentation strip.
    //
    // The verify and strip loops used to pass none at all, so they ran on the
    // bare default: no guidance on routing a check by method, no debugging loop,
    // no media lenses, no code-change attention. That is exactly backwards —
    // verification is where `activity_inspect`, `media_analysis` and the fix-and-
    // re-check discipline matter most, and it was the one loop told nothing about
    // them. The detailed user message carried the instructions; the system prompt
    // carried nothing.
    // Host flag wins when explicitly set (true OR false); only when the host
    // leaves it unset does the classifier's bugFixHint arm the reproduce gate.
    // Resolved BEFORE the loop system prompt is built so the prompt can carry
    // the reproduce-first directive when this is a bug fix.
    const isBugFix = opts.isBugFix === true || (opts.isBugFix === undefined && bugFixHint);
    // Resolved BEFORE the system prompt, because the prompt's UI-vs-backend gating
    // reads it too — and used for the gate and every loop below, so the
    // classification the gate enforces and the one the authoring pass routes on
    // cannot disagree.
    const runCategory = await this.effectiveCategory();
    const loopSystemPrompt = buildLoopSystemPrompt(tools.map((t) => t.name), {
      authorOnlyWrites: this.config.authorOnlyWrites === true,
      ...(isBugFix ? { isBugFix: true } : {}),
      ...(runCategory ? { projectCategory: runCategory } : {}),
    });
    // Undefined = no cap: each step's loop runs until the model stops calling
    // tools (or the stall guard fires). A host that wants a hard cap passes one.
    const maxStepsPerStep = opts.maxStepsPerStep;
    // The reproduce-before-you-edit gate. One run-scoped instance, threaded into
    // every work loop so a multi-step bug fix reproduces ONCE — without this, a
    // fresh gate per step would re-block step 2's first edit even after step 1
    // already observed the bug.
    const reproductionGate = new ReproductionGate({ enabled: isBugFix });
    // The ask-before-you-invent gate. Same run-scoped shape and for the same
    // reason: one refusal is the intervention, and a fresh gate per step would
    // re-refuse step 2 after step 1 had already asked. Inert unless the request
    // asks to change a value it never names — see `clarify-gate.ts`. An
    // attachment usually IS the missing specification, so the gate stands down
    // when the run carries one.
    const clarifyGate = new ClarifyGate({
      valueUnspecified,
      task,
      hasAttachments: !!(opts.images?.length || opts.files?.length),
    });
    if (clarifyGate.active) {
      this.logStore.append({
        tags: ["clarify-gate"],
        level: "info",
        message: "request names a change but no new value; the first mutation will be refused until the user is asked",
      });
    }
    // The verify-what-you-wrote gate. Default ON for task routes. One instance
    // per run, threaded into every work loop so it sees every write + check.
    const verifyEnabled = opts.verify !== false;
    const verifyOpts: VerifyOptions | undefined =
      opts.verify && typeof opts.verify === "object" ? opts.verify : undefined;
    const verificationGate = verifyEnabled
      ? new VerificationGate({
          ...(verifyOpts ?? {}),
          // The category decides the fallback check for a source file the model
          // never classified: on a project whose product is a screen, that check
          // is "go and look at it". Without this the gate defaults every source
          // file to a logic check and no UI change is ever seen.
          ...(runCategory ? { projectCategory: runCategory } : {}),
        })
      : undefined;
    // The project's OWN run commands, read from its manifests once per run.
    //
    // Read here rather than inside the verify block (where they used to be read)
    // because the QA gate needs them from the first work loop: a freshness
    // refusal is only actionable if it can quote the command that fixes it, and
    // an unquoted refusal is how a run ends up inventing `flutter run
    // --no-sound-null-safety` — a flag that does not exist — and then reading
    // its own bad invocation as proof the app cannot be verified.
    const deviceCommands = await detectDeviceRunCommands(this.cwd).catch(() => []);
    // Which mobile toolchain, so a booted device can be pinned onto the
    // project's own run command with the right flag (`-d` / `--udid` / `--device`).
    const mobileStack = await detectMobileStack(this.cwd).catch(() => undefined);
    const webCommands = await detectDevServerCommands(this.cwd).catch(() => []);
    // The QA sequencing gate. One per run, threaded into every loop, because the
    // two facts it correlates — what was written, what was deployed — happen in
    // different loops. See `qa-gate.ts` for the run this exists because of.
    const qaGate = new QaGate({
      deviceCommands,
      // Enables the wrong-surface refusal: a Flutter/RN app must not be "run" in
      // Chrome while a simulator is booted. Detected from the project, so a real
      // web or desktop project is never affected. `deviceCommands` is the second
      // signal — a project that declares `flutter run -d …` is a device project
      // whatever the category classifier decided.
      mobileProject: runCategory === "mobile" || deviceCommands.length > 0 || !!mobileStack,
      ...(mobileStack ? { mobileStack } : {}),
    });
    const runId = newRunId();
    const verifyEvidenceDir = verificationGate
      ? await ensureArtifactDir(this.cwd, runId)
      : undefined;
    const loopModel = this.llm.resolveModel(this.phaseModelSlug("perform"));
    const askUserQuestion = opts.askUserQuestion;
    const planApproval = opts.planApproval ?? this.planApprovalCallback;
    const transcriptMode = opts.transcriptMode ?? this.config.transcriptMode;
    // Seeded once for the whole run. The loop can still have these flipped
    // later by a tool's permission decision; this is what they START as.
    const emitReasoning = opts.emitReasoning;
    const emitText = opts.emitText;

    // --- Attachment triage pre-pass: learn each image's role up front so the
    // model doesn't burn a media_analysis call re-deriving it mid-run, and so
    // informational OCR text reaches the write/edit authoring pass as known
    // context (spec: "include in harness so follow-up tool calls get this
    // data"). Skipped when disabled, when there are no images, or on abort. The
    // enriched list and the mediaFact seed are threaded into the loops below. ---
    const autoTriage = this.config.autoTriageAttachments !== false;
    let enrichedImages: EnrichedImage[] | undefined;
    let mediaFactSeed: string | undefined;
    // Every image path this run has already triaged. Plan-review attachments are
    // triaged lazily per step (see the work loop), and a file the user pins to
    // two steps — or one that was also attached to the run — must not be paid
    // for twice.
    const triagedPaths = new Set<string>(opts.images?.map((i) => i.path) ?? []);
    if (autoTriage && opts.images?.length && !signal?.aborted) {
      const triaged = await this.triageAttachments(opts.images, task, signal);
      if (triaged) {
        enrichedImages = triaged.enriched;
        mediaFactSeed = triaged.mediaFact;
        if (triaged.usage) usage = addUsage(usage, triaged.usage);
      }
    }
    // Document attachments get the same treatment as images: their content is
    // extracted up front and folded into mediaFactSeed, so a spec / data /
    // reference doc the user attached reaches authoring automatically — the
    // document analogue of image OCR. Audio and video stay path-only: they are
    // surfaced via AVAILABLE FILES and the model transcribes/analyzes on demand.
    if (autoTriage && opts.files?.length && !signal?.aborted) {
      const docCtx = this.triageContext(signal);
      if (docCtx) {
        for (const doc of opts.files.filter((f) => isDocumentRef(f))) {
          if (signal?.aborted) break;
          if (triagedPaths.has(doc.path)) continue;
          triagedPaths.add(doc.path);
          const { fact, usage: u } = await triageDocumentAttachment(doc, task, docCtx);
          if (fact) mediaFactSeed = mediaFactSeed ? `${mediaFactSeed}\n${fact}` : fact;
          if (u) usage = addUsage(usage, u);
        }
      }
    }
    // Publish the enriched list onto the run options so the loop-opening and
    // step-message builders (which read `opts.enrichedImages ?? opts.images`)
    // render each image's triaged role. Run-scoped augmentation of the host's
    // `images`; the host's original refs are preserved on `opts.images`.
    if (enrichedImages) opts.enrichedImages = enrichedImages;
    // The image set every loop is handed, PREFERRING the triaged form.
    //
    // Loops used to receive the raw `opts.images`, which dropped each image's
    // role on the floor. That role is what tells a live capture WHICH attachment
    // it should be graded against: `activity_inspect` compares against "the
    // run's reference image", and with no role that resolved to whichever
    // attachment happened to come first — so a run where the user attached both
    // a mockup and a screenshot of a stack trace could grade the screen against
    // the stack trace and report a confident, meaningless FAIL.
    const runImages: LiveImage[] = enrichedImages ?? opts.images ?? [];

    const refs: MediaRef[] = [];
    const writtenPaths: string[] = [];
    const readPaths: string[] = [];
    const discoveredPaths: string[] = [];
    // Files that had activity-monitor probe markers written into them during
    // the run. Scanned after the verify gate clears so leftover `__t()`
    // instrumentation is stripped before the summary — without this, a model
    // that forgets the cleanup step ships debug probes.
    const instrumentedPaths: string[] = [];
    let planSet: PlanSet | undefined;
    const steps: RunStep[] = [];
    let summary: string | undefined;
    // Each work step's own closing prose. This is the only record of what the model
    // actually observed while it had the evidence in view, and the summary turn is a
    // fresh context — without it, the summary is written from titles alone.
    const stepReports: Array<{ label: string; text: string }> = [];
    let pendingUserQuestion: AskUserQuestionRequest | undefined;
    let runError: string | undefined;
    // The running conversation across the work loops, carried into the verify
    // phase so verification continues the same transcript the work produced.
    let carryMessages: import("../types.js").Message[] | undefined;
    // Whether the verify gate was satisfied. Set by the verify phase; surfaced
    // on RunLoopResult and the thread snapshot. `undefined` = gate didn't run.
    let verified: boolean | undefined;
    let verificationReport: VerificationReport | undefined;
    // The reproduce-gate report, surfaced for bug-fix runs so the summary and
    // host can state whether the bug was reproduced (or declared/skipped).
    let reproductionReport: ReproductionReport | undefined;

    // --- (Optional) planning turn. The model may emit PLAN_JSON / PLANS_JSON. ---
    let planTask: PlanTask[] | undefined;
    let planId = "plan-1";
    if (!opts.skipPlan && !signal?.aborted) {
      const planLoop = await runToolLoop({
        task,
        systemPrompt: loopSystemPrompt,
        userMessage: this.buildLoopOpening(task, opts, { phase: "plan" }),
        tools,
        resolveTools,
        model: loopModel,
        toolModelCandidates: this.config.toolModelCandidates,
        ...(this.config.visionModel ? { visionModel: this.config.visionModel } : {}),
        ...(this.config.routeModel ? { routeModel: this.config.routeModel } : {}),
        llm: this.llm,
        permission: this.permission,
        registry: this.registry,
        logStore: this.logStore,
        emit: (e) => this.emit(e),
        cwd: this.cwd,
        signal,
        ...(maxStepsPerStep ? { maxSteps: maxStepsPerStep } : {}),
        ...(isBugFix ? { isBugFix: true } : {}),
        ...(verificationGate ? { verificationGate } : {}),
        ...(reproductionGate ? { reproductionGate } : {}),
        ...(clarifyGate ? { clarifyGate } : {}),
        qaGate,
        reasoning: this.reasoningOverrides["perform"] ?? this.config.reasoning?.["perform"],
        transcriptMode,
        ...(emitReasoning !== undefined ? { emitReasoning } : {}),
        ...(emitText !== undefined ? { emitText } : {}),
        ...(askUserQuestion ? { askUserQuestion } : {}),
        ...(planApproval ? { planApproval } : {}),
        ...(runImages.length ? { images: runImages } : {}),
        ...(runCategory ? { projectCategory: runCategory } : {}),
        ...(mediaFactSeed ? { mediaFact: mediaFactSeed } : {}),
        phase: "plan",
        label: "plan",
      });
      usage = addUsage(usage, planLoop.usage);
      collectLoopRefs(refs, planLoop);
      collectLoopPaths(writtenPaths, readPaths, discoveredPaths, planLoop, instrumentedPaths);
      pendingUserQuestion = pendingUserQuestion ?? planLoop.pendingUserQuestion;

      // Parse a plan out of the planning turn. PLANS_JSON wins; else a legacy
      // PLAN_JSON step array is normalized into a single plan.
      // A `create_plan` result wins over scraped text: it is structured, and it is
      // the one the USER reviewed and approved (possibly with per-step notes and
      // attachments the prose version would not carry).
      planSet =
        planLoop.planSet ??
        extractPlanSet(planLoop.finalText) ??
        normalizeLegacyPlanJson(extractPlanJson(planLoop.finalText));
      if (planSet?.plans.length) {
        const orderedIds = planSet.executionOrder.length ? planSet.executionOrder : planSet.plans.map((p) => p.id);
        const first = planSet.plans.find((p) => p.id === orderedIds[0]) ?? planSet.plans[0]!;
        planId = first.id;
        // Flatten: the loop runs every task across every plan in execution order.
        planTask = [];
        for (const id of orderedIds) {
          const doc = planSet.plans.find((p) => p.id === id);
          if (!doc) continue;
          for (const t of [...doc.tasks].sort((a, b) => a.order - b.order)) planTask.push(t);
        }
      }

      if (planLoop.error && planLoop.error !== "aborted" && !isNonFatalLoopError(planLoop.error)) {
        runError = planLoop.error;
      }
    }

    // After planning, the plan's file spread + declared complexity are known.
    // If the fix is GENUINELY simple (few source files, low complexity) the gate
    // can lift now — verified by the harness, not the model's self-assertion.
    // (The concurrency-content scan runs in the loop, which holds file bytes;
    // here the assessment is plan-shaped: spread + complexity.)
    if (isBugFix && planTask?.length) {
      reproductionGate.assessAndLift(planTask, undefined);
    }

    // --- Work: one sub-loop per plan task, or a single loop when planless. ---
    if (!pendingUserQuestion && !runError && !signal?.aborted) {
      // A callback the work loop invokes to triage an image a user hands over
      // mid-run (in answer to `ask_user_question`), so a spec/screenshot dropped
      // after the run started is understood exactly like one attached up front.
      // Built once here so every work step shares it; `undefined` falls back to
      // the loop's legacy behavior (a raw, un-enriched live image).
      const triageAttachment = autoTriage ? this.buildTriageCallback(task, signal) : undefined;
      const workUnits: Array<{ taskEntry?: PlanTask; label: string }> = [];
      if (planTask?.length) {
        for (let i = 0; i < planTask.length; i++) {
          const t = planTask[i]!;
          workUnits.push({ taskEntry: t, label: `step ${i + 1}/${planTask.length}: ${t.title}` });
        }
      } else {
        workUnits.push({ label: "work" });
      }

      let workMessages: import("../types.js").Message[] | undefined;
      for (const unit of workUnits) {
        if (signal?.aborted) break;
        if (pendingUserQuestion) break;
        const t = unit.taskEntry;
        const complexityByPath = t ? this.complexityByPathForTask(t) : undefined;
        // Merge the user's step attachments with the run-wide images. Image-typed
        // attachments become vision input for this step's write/edit/analysis.
        const stepOwnImages = stepImageRefs(t);
        const stepImages = [...stepOwnImages, ...runImages];

        // Triage the images the user pinned to THIS step during plan review.
        //
        // The run-level pre-pass above only saw `opts.images` — the attachments
        // that existed when the run started. Anything the user dropped onto a
        // step while reviewing the plan arrives later, and without this it would
        // reach the work loop as an undifferentiated image: no category (so the
        // loop cannot tell a mockup to rebuild from an error screenshot to read)
        // and no OCR text (so its exact strings never reach the authoring pass).
        // A review attachment is the one the user chose most deliberately; it
        // should be understood at least as well as one attached up front.
        let stepEnriched: EnrichedImage[] | undefined;
        let stepMediaFact = mediaFactSeed;
        const untriaged = stepOwnImages.filter((i) => !triagedPaths.has(i.path));
        if (autoTriage && untriaged.length && !signal?.aborted) {
          const triaged = await this.triageAttachments(untriaged, task, signal);
          if (triaged) {
            for (const i of untriaged) triagedPaths.add(i.path);
            stepEnriched = triaged.enriched;
            if (triaged.mediaFact) {
              stepMediaFact = [mediaFactSeed, triaged.mediaFact].filter(Boolean).join("\n");
            }
            if (triaged.usage) usage = addUsage(usage, triaged.usage);
          }
        }
        const stepUserMessage = this.buildStepMessage(task, t, steps, opts, stepEnriched);
        const stepAuthoringTask = this.buildAuthoringTask(task, t);
        const workLoop = await runToolLoop({
          task,
          ...(stepAuthoringTask ? { authoringTask: stepAuthoringTask } : {}),
          systemPrompt: loopSystemPrompt,
          userMessage: stepUserMessage,
          priorMessages: workMessages,
          tools,
          resolveTools,
          model: loopModel,
          toolModelCandidates: this.config.toolModelCandidates,
        ...(this.config.visionModel ? { visionModel: this.config.visionModel } : {}),
          ...(this.config.routeModel ? { routeModel: this.config.routeModel } : {}),
          llm: this.llm,
          permission: this.permission,
          registry: this.registry,
          logStore: this.logStore,
          emit: (e) => this.emit(e),
          cwd: this.cwd,
          signal,
          ...(maxStepsPerStep ? { maxSteps: maxStepsPerStep } : {}),
          ...(isBugFix ? { isBugFix: true } : {}),
          ...(verificationGate ? { verificationGate } : {}),
          ...(reproductionGate ? { reproductionGate } : {}),
          ...(clarifyGate ? { clarifyGate } : {}),
          qaGate,
          reasoning: this.reasoningOverrides["perform"] ?? this.config.reasoning?.["perform"],
          transcriptMode,
          ...(emitReasoning !== undefined ? { emitReasoning } : {}),
          ...(emitText !== undefined ? { emitText } : {}),
          ...(askUserQuestion ? { askUserQuestion } : {}),
          ...(planApproval ? { planApproval } : {}),
          // Step attachments come FIRST so a file the user pinned to this step
          // takes precedence over run-wide images when a tool reads `ctx.images`.
          ...(stepImages.length ? { images: stepImages } : {}),
          ...(complexityByPath ? { complexityByPath, complexitySource: "plan-task" } : {}),
          ...(t?.files ? { planJson: [t] as unknown[] } : {}),
          ...(runCategory ? { projectCategory: runCategory } : {}),
          ...(stepMediaFact ? { mediaFact: stepMediaFact } : {}),
          ...(triageAttachment ? { triageAttachment } : {}),
          phase: "perform",
          label: unit.label,
        });
        usage = addUsage(usage, workLoop.usage);
        collectLoopRefs(refs, workLoop);
        collectLoopPaths(writtenPaths, readPaths, discoveredPaths, workLoop, instrumentedPaths);
        pendingUserQuestion = pendingUserQuestion ?? workLoop.pendingUserQuestion;
        // Thread the working conversation forward so later steps see earlier work.
        workMessages = workLoop.messages;
        const report = workLoop.finalText?.trim();
        if (report) stepReports.push({ label: unit.label, text: report });

        // Record the step (plan task) with its post-run state.
        if (t) {
          steps.push({
            planId,
            taskId: t.id,
            title: t.title,
            summary: t.summary,
            complexity: t.complexity,
            isCompleted: !workLoop.error,
            files: t.files,
            ...(workLoop.error && workLoop.error !== "aborted" ? { error: workLoop.error } : {}),
          });
          // Mark the source task complete on the PlanSet, in place.
          const srcTask = planSet?.plans.flatMap((p) => p.tasks).find((x) => x.id === t.id);
          if (srcTask) srcTask.isCompleted = !workLoop.error;
        }

        // "aborted" is a user cancel: stop the whole run, nothing else is wanted.
        if (workLoop.error === "aborted") break;

        // A step that ended early on its own (a stalled loop, or a host-configured
        // step cap running out) is NOT a hard failure and — critically — NOT a
        // reason to abandon the rest of the plan. Both conditions are PER STEP, so
        // step 1 going in circles says nothing about whether step 2 can finish, and
        // silently dropping the remaining steps of a plan the USER approved is
        // worse than letting step 2 try. The step is already recorded above with
        // `isCompleted: false` and its error, so the run still reports honestly
        // which steps ended early.
        const endedEarly = isNonFatalLoopError(workLoop.error);
        if (workLoop.error && !endedEarly) {
          runError = workLoop.error;
          break;
        }
        if (endedEarly) {
          this.logStore.append({
            tags: ["loop", "loop:truncated", "run:continue"],
            level: "warn",
            message: `${unit.label} ended early (${workLoop.error}); continuing with the remaining steps`,
          });
        }
      }
      // Hoist the final work conversation so the verify phase (below) continues
      // the same transcript the work loops produced, not a fresh one.
      carryMessages = workMessages;
    }

    // Capture the reproduce-gate report after all work loops. Only present for
    // bug-fix runs (the gate is inert otherwise). Surfaced on RunLoopResult and
    // the summary so the host can see whether the bug was reproduced.
    if (isBugFix) reproductionReport = reproductionGate.toReport();

    // Verify rounds that were stopped before the model finished. Empty on a
    // normal run; each entry names the round and the reason, so the summary can
    // distinguish "not checked" from "checking was cut off".
    const verifyEndedEarly: string[] = [];

    // --- QA: verify EXISTING behavior, no change requested. ---
    // The verify-what-you-wrote gate keys off WRITTEN files, so a pure "QA this"
    // request (no write/edit) would skip the staged spine entirely — the agent
    // would never reach instrument→wait→inspect→decide. Seed ONE synthetic gap
    // (the thing to verify) so the same flow engages, routed by the project's
    // category: a screen app → visual, a backend → endpoint, else logic. The
    // path is the file the agent investigated (readPaths) or a descriptive
    // sentinel; the METHOD is declared explicitly so it does not depend on the
    // path's extension (a sentinel has no meaningful one).
    if (verificationGate && qaIntent) {
      const qaMethod =
        runCategory === "frontend" || runCategory === "mobile" || runCategory === "games"
          ? "visual"
          : runCategory === "backend"
            ? "endpoint"
            : "logic";
      const qaPath = readPaths.length
        ? readPaths[readPaths.length - 1]
        : "(the behavior described in the request)";
      verificationGate.observeWritten(qaPath);
      verificationGate.declare([{ path: qaPath, tier: "runtime", method: qaMethod }]);
    }

    // --- Verify-what-you-wrote gate (post-development, replaces Perfect verify). ---
    // The gate was fed every write + check by the work loops. Now, before the
    // summary is allowed, refuse completion until every written RUNTIME file has
    // evidence behind it — with a build→ask→drive-or-wait handoff when a running
    // app is needed. For a QA run the "written" file is the synthetic gap seeded
    // above, so the same spine runs without any real edit. Everything here is
    // non-fatal: any error degrades to `verified: false` and the run completes.
    if (verificationGate && (writtenPaths.length > 0 || qaIntent) && !pendingUserQuestion && !runError && !signal?.aborted) {
      try {
        const report0 = verificationGate.toReport();
        // What the outstanding files need, which is what decides whether a
        // running app is required at all — and therefore whether the user is
        // asked to hand one over.
        const declaredMethods = report0.unverified.map((u) => u.method);
        const handoff: RunHandoffResult = await coordinateRunHandoff({
          registry: this.registry,
          ...(askUserQuestion ? { askUserQuestion } : {}),
          declaredMethods,
          ...(verifyEvidenceDir ? { evidenceDir: verifyEvidenceDir } : {}),
          ...(signal ? { signal } : {}),
        });
        if (handoff.mode !== "skip" && !verificationGate.isSatisfied()) {
          const maxRounds = verificationGate.maxRounds;
          // The dedicated verify rounds ARE the QA pass, so the gate's "QA
          // belongs to the verify pass" refusal stands down here — driving the
          // app to reach the screen under test is what these rounds are for. Its
          // freshness rule stays armed: a capture of a build that predates the
          // change is wrong whoever takes it.
          qaGate.setVerifyPass(true);
          // `deviceCommands` / `webCommands` were read once, before the work
          // loops, and are reused here — the project's manifests do not change
          // between verify attempts and each detection walks the tree.
          const stageDeviceCommands = handoff.surfaces.mobile ? deviceCommands : [];
          // The project's own start command, for the same reason the device half
          // reads one: a guessed port captures an error page.
          const stageWebCommands = handoff.surfaces.mobile ? [] : webCommands;
          // Staged verify: nudge the model through instrument → run → inspect →
          // decide (one focused message per round) instead of naming every route
          // at once and leaving it to choose. Seeded with paths the work loops
          // already instrumented (e.g. bug-fix reproduction), so it does not tell
          // the model to re-probe files that already carry probes.
          // A failed verify attempt gets a FRESH cycle (instrument → run → inspect
          // → decide) rather than giving up at verified:false. The first attempt
          // often misses for a fixable reason — a stale build, a screen the model
          // got stuck on, a wrong route — and the carried transcript lets the next
          // attempt correct course (rebuild, ask the user, pick another route).
          // This loop is the single verify path for every run shape — development,
          // debugging, and QA/classic — so the retry covers all three. Bounded by
          // maxAttempts so a change that genuinely cannot verify still completes
          // honestly (verified:false), never an infinite loop.
          const maxAttempts = verificationGate.maxAttempts;
          for (
            let attempt = 0;
            attempt < maxAttempts && !verificationGate.isSatisfied() && !signal?.aborted;
            attempt++
          ) {
            // Fresh tracker per attempt: each cycle builds, probes, runs, inspects
            // and decides from scratch. Seeded with paths the run already
            // instrumented, and with the BUILD debt pre-armed when the project's
            // own files give it a launch/build command — the writes landed in the
            // work loops, so nothing has been observed running them yet.
            const stageTracker = new VerifyStageTracker({
              mode: handoff.mode,
              ...(qaIntent ? { qa: true } : {}),
              ...(instrumentedPaths.length ? { initialInstrumented: instrumentedPaths } : {}),
              buildRequired:
                (stageDeviceCommands?.length ?? 0) > 0 || (stageWebCommands?.length ?? 0) > 0,
            });
            // USER mode waits for the user to run the app once per instrument
            // cycle. Re-entering INSTRUMENT (a fix triggered re-instrument) resets
            // it so the user re-runs after a fix too.
            let userWaitDone = false;
            if (attempt > 0) {
              this.logStore.append({
                tags: ["verify", "verify:retry"],
                level: "info",
                message: `previous verify attempt produced no evidence; starting a fresh cycle (attempt ${attempt + 1} of ${maxAttempts})`,
              });
            }
            for (let round = 0; round < maxRounds && !verificationGate.isSatisfied() && !signal?.aborted; round++) {
              const gaps = verificationGate.gaps();
              // Drain any FAIL recorded last round into this round's message ctx.
              const failureReasons = stageTracker.takeFailure();
              if (gaps.length === 0) break;
              const stage = stageTracker.stage({ gaps, round, maxRounds });
              // Tell the tracker which stage this round targets so its premature-strip
              // guard lifts at DECIDE (a run that could not verify must still clean up).
              stageTracker.setCurrentStage(stage);
              if (stage === "instrument") userWaitDone = false;
              // USER mode: between INSTRUMENT (done) and INSPECT, wait for the user
              // to run the app and drop evidence. The model has nothing to drive —
              // the wait is the "run" step for this mode, and it was missing.
              if (
                handoff.mode === "user" &&
                stage === "inspect" &&
                !stageTracker.isCaptured() &&
                !userWaitDone &&
                !signal?.aborted
              ) {
                try {
                  this.logStore.append({
                    tags: ["verify", "verify:user-wait"],
                    level: "info",
                    message: "waiting for the user to run the app and share evidence",
                  });
                  await waitForUserEvidence({
                    ...(verifyEvidenceDir ? { dir: verifyEvidenceDir } : {}),
                    ...(handoff.userEvidencePath ? { userEvidencePath: handoff.userEvidencePath } : {}),
                    signal,
                    onProgress: (n) => {
                      // A heartbeat roughly every 15s, not every 1.5s tick.
                      if (Math.floor(n.waitedMs / 15000) !== Math.floor((n.waitedMs - 1500) / 15000)) {
                        this.logStore.append({
                          tags: ["verify", "verify:user-wait"],
                          level: "info",
                          message: `still waiting for user evidence (${Math.round(n.waitedMs / 1000)}s elapsed)`,
                        });
                      }
                    },
                  });
                } catch {
                  // Non-fatal: proceed to INSPECT, which reads what arrived or honestly reports unverified.
                }
                userWaitDone = true;
              }
              let userMessage = buildStageMessage(stage, {
                gaps,
                handoff,
                round,
                maxRounds,
                deviceCommands: stageDeviceCommands,
                webCommands: stageWebCommands,
                ...(qaIntent ? { qa: true } : {}),
                ...(isBugFix ? { isBugFix: true } : {}),
                // A FAIL recorded last round turns this round's message into a
                // repair round: what failed + authorization to edit + where the
                // spine restarts. Consumed once so it does not repeat forever.
                ...(failureReasons.length ? { failureReasons } : {}),
              });
              // A retry's first round is framed: do not repeat the same failing
              // steps. The previous attempt's transcript is carried, so the model
              // can see what did not work and choose a different route forward.
              if (attempt > 0 && round === 0) {
                userMessage =
                  `FRESH VERIFY ATTEMPT ${attempt + 1} of ${maxAttempts}. The previous attempt ended WITHOUT a ` +
                  `usable capture, so the change is still UNVERIFIED. Before repeating the same steps, change ` +
                  `approach: rebuild / restart the app so it actually contains the change; if you were stuck on a ` +
                  `screen (login / form / input / auth), use \`ask_user_question\` for that value or to have the ` +
                  `user do that step; or pick a different route to the target. Then instrument → run → inspect → decide.\n\n` +
                  userMessage;
              }
              const verifyLoop = await runToolLoop({
                llm: this.llm,
                permission: this.permission,
                registry: this.registry,
                logStore: this.logStore,
                emit: (e) => this.emit(e),
                cwd: this.cwd,
                model: loopModel,
                toolModelCandidates: this.config.toolModelCandidates,
                ...(this.config.visionModel ? { visionModel: this.config.visionModel } : {}),
                ...(this.config.routeModel ? { routeModel: this.config.routeModel } : {}),
                tools,
                resolveTools,
                task,
                systemPrompt: loopSystemPrompt,
                userMessage,
                priorMessages: carryMessages,
                ...(maxStepsPerStep ? { maxSteps: maxStepsPerStep } : {}),
                ...(isBugFix ? { isBugFix: true } : {}),
                ...(verificationGate ? { verificationGate } : {}),
                ...(reproductionGate ? { reproductionGate } : {}),
                ...(clarifyGate ? { clarifyGate } : {}),
                qaGate,
                verifyStageTracker: stageTracker,
                reasoning: this.reasoningOverrides["perform"] ?? this.config.reasoning?.["perform"],
                transcriptMode,
                ...(emitReasoning !== undefined ? { emitReasoning } : {}),
                ...(emitText !== undefined ? { emitText } : {}),
                ...(askUserQuestion ? { askUserQuestion } : {}),
                // A verify round is not read-only: the message tells the model to
                // fix the defects it finds and re-check. Those fixes are `write`/
                // `edit` calls, so they need the SAME authoring context the work
                // loops had — without the attachment the change was built from and
                // the text triage already extracted, the fix for a visual defect is
                // authored blind against the mockup it is supposed to match.
                ...(runImages.length ? { images: runImages } : {}),
                ...(mediaFactSeed ? { mediaFact: mediaFactSeed } : {}),
                // And the same project category, or a fix that creates a UI file on
                // a BACKEND project re-opens the design-reference ladder the work
                // loops correctly skipped.
                ...(runCategory ? { projectCategory: runCategory } : {}),
                phase: "perform",
                label: `verify-a${attempt}-r${round}`,
                ...(signal ? { signal } : {}),
              });
              usage = addUsage(usage, verifyLoop.usage);
              collectLoopRefs(refs, verifyLoop);
              collectLoopPaths(writtenPaths, readPaths, discoveredPaths, verifyLoop, instrumentedPaths);
              // The verify loop may have emitted DECLARE blocks (a file that needs
              // no runtime check) or run real checks (already observed by the gate
              // via the loop hook). Parse any declarations into the gate so a
              // certified-static bypass lands before the next satisfaction check.
              const declarations = parseDeclarations(verifyLoop.finalText ?? "");
              if (declarations.length) verificationGate.declare(declarations);
              // An explicit FAIL verdict recorded by the model is the repair-loop
              // trigger: the next round becomes a REPAIR round (what failed +
              // authorization to `edit`/`write` + spine restarts at BUILD after the
              // fix — the write itself re-arms the build debt via `onWritten`).
              // Without this a FAIL just... ended the attempt, and the change
              // shipped unverified while the model moved on to the summary.
              if (!verificationGate.isSatisfied()) {
                const finalText = verifyLoop.finalText ?? "";
                const verdictLine = finalText
                  .split("\n")
                  .find((l) => /\bVERDICT\s*:\s*FAIL\b/i.test(l))
                  ?.trim();
                if (verdictLine || /VERDICT\s*:\s*FAIL/i.test(finalText)) {
                  const reasons = verificationGate
                    .gaps()
                    .map((g) => `${g.path} — method: ${g.method}, still unverified`);
                  if (verdictLine) reasons.unshift(verdictLine);
                  stageTracker.noteFailure(reasons);
                  this.logStore.append({
                    tags: ["verify", "verify:repair"],
                    level: "info",
                    message: "verify round ended VERDICT: FAIL — next round is a repair round (fix, rebuild, re-verify)",
                  });
                }
              }
              carryMessages = verifyLoop.messages;
              pendingUserQuestion = pendingUserQuestion ?? verifyLoop.pendingUserQuestion;
              if (verifyLoop.pendingUserQuestion) break;
              if (verifyLoop.error === "aborted") break;
              // A round that ENDED EARLY — the stall guard stopped it, or a
              // host-configured step cap ran out — is recorded, not swallowed.
              //
              // This was the invisible half of a run that looked like it "just
              // stopped": the last verify round was cut mid-turn, so the transcript's
              // final event was a tool result with no closing words from the model,
              // and nothing anywhere said why. The gate then reported the file
              // UNVERIFIED, which reads as "the model declined to check it" when the
              // truth was "the round was stopped while it was still checking". Those
              // two want opposite responses from the user, so conflating them is
              // worse than either.
              //
              // Recorded and carried into the summary rather than breaking the loop:
              // the NEXT round starts a fresh turn budget and may well converge, so
              // one stalled round is not a reason to abandon verification.
              if (isNonFatalLoopError(verifyLoop.error)) {
                verifyEndedEarly.push(`attempt ${attempt + 1} round ${round + 1}: ${verifyLoop.error}`);
                this.logStore.append({
                  tags: ["verify", "verify:truncated"],
                  level: "warn",
                  message: `verify attempt ${attempt + 1} round ${round + 1} of ${maxRounds} ended early (${verifyLoop.error})`,
                });
              }
            }
          }
        }
        verified = verificationGate.isSatisfied();
        verificationReport = verificationGate.toReport();
      } catch {
        // Never fail a run over verification. Honest `verified: false` is the
        // contract; a thrown error here is reported as unverified, not as a run error.
        verified = false;
        verificationReport = verificationGate.toReport();
      }
    }

    // --- Probe-stripping enforcement: refuse the summary while activity-monitor
    // instrumentation (`__t()`/`__TRACE`) remains in a file the run touched.
    // The loop records paths that had markers inserted; here we re-scan them on
    // disk (markers may have been added OR removed since) and, if any remain,
    // run ONE capped verify round with a targeted message naming the files. The
    // round is bounded so a model that can't strip them is not deadlocked; the
    // finding is reported on the thread snapshot either way. Never fatal — a
    // throw degrades to "instrumentation may remain" and the run still completes.
    if (instrumentedPaths.length && !pendingUserQuestion && !signal?.aborted) {
      try {
        let remaining = await scanForProbeMarkers(this.cwd, instrumentedPaths);
        if (remaining.length) {
          const userMessage =
            `STRIP DEBUG INSTRUMENTATION: these files still contain activity-monitor probes ` +
            `(\`TURING_TRACE …\` lines) that must NOT ship. ` +
            `Remove every probe marker you added, then confirm. Files:\n` +
            remaining.map((p) => `- \`${p}\``).join("\n");
          const stripLoop = await runToolLoop({
            llm: this.llm,
            permission: this.permission,
            registry: this.registry,
            logStore: this.logStore,
            emit: (e) => this.emit(e),
            cwd: this.cwd,
            model: this.llm.resolveModel(this.phaseModelSlug("perform")),
            ...(this.config.toolModelCandidates ? { toolModelCandidates: this.config.toolModelCandidates } : {}),
            tools,
            resolveTools,
            task,
            systemPrompt: loopSystemPrompt,
            userMessage,
            priorMessages: carryMessages,
            ...(maxStepsPerStep ? { maxSteps: maxStepsPerStep } : {}),
            reasoning: this.reasoningOverrides["perform"] ?? this.config.reasoning?.["perform"],
            transcriptMode,
            ...(emitReasoning !== undefined ? { emitReasoning } : {}),
            ...(emitText !== undefined ? { emitText } : {}),
            // Stripping probes is an `edit` on files the run authored; the same
            // category gate applies as in the verify round above.
            ...(runCategory ? { projectCategory: runCategory } : {}),
            phase: "perform",
            label: "strip-instrumentation",
            ...(signal ? { signal } : {}),
          });
          usage = addUsage(usage, stripLoop.usage);
          collectLoopPaths(writtenPaths, readPaths, discoveredPaths, stripLoop);
          carryMessages = stripLoop.messages;
          pendingUserQuestion = pendingUserQuestion ?? stripLoop.pendingUserQuestion;
          // Re-scan after the strip round; whatever still holds is reported.
          remaining = await scanForProbeMarkers(this.cwd, instrumentedPaths);
          if (remaining.length) {
            this.logStore.append({
              timestamp: Date.now(),
              level: "warn",
              tags: ["orchestrator", "instrumentation", "instrumentation:leftover"],
              message: `probe markers remain after strip round in: ${remaining.join(", ")}`,
            });
          }
        }
      } catch {
        // A scan/strip failure never fails the run; the worst case is debug
        // probes that should have been removed. Reported, not fatal.
      }
    }

    // --- Final summary turn over the whole run (replaces Perfect verify). ---
    if (!pendingUserQuestion && !signal?.aborted) {
      const summarized = await this.summarizeRun(task, steps, writtenPaths, readPaths, refs, stepReports, opts, signal, verificationReport, reproductionReport, verifyEndedEarly);
      summary = summarized.text;
      // The summary is a real model turn and is billed like one.
      if (summarized.usage) usage = addUsage(usage, summarized.usage);
    }

    const success = !runError && !signal?.aborted;
    this.emit({ type: "chain_end", success, iterations: steps.length || (summary ? 1 : 0) });

    const threadSnapshot = buildRunThreadSnapshot({
      task,
      route: "task",
      success,
      summary: summary ?? (runError ? `Run failed: ${runError}` : task),
      usage,
      writtenPaths,
      readPaths,
      discoveredPaths,
      steps,
      ...(planSet ? { planSet } : {}),
      ...(pendingUserQuestion ? { pendingUserQuestion } : {}),
      ...(runError ? { error: runError } : {}),
      ...(typeof verified === "boolean" ? { verified } : {}),
      ...(reproductionReport ? { reproduction: reproductionReport } : {}),
    });

    return {
      task,
      route: "task",
      success,
      summary,
      steps,
      ...(planSet ? { planSet } : {}),
      refs,
      usage,
      threadSnapshot,
      ...(pendingUserQuestion ? { pendingUserQuestion } : {}),
      ...(runError ? { error: runError } : {}),
      ...(typeof verified === "boolean" ? { verified } : {}),
      ...(verificationReport ? { verification: verificationReport } : {}),
      ...(reproductionReport ? { reproduction: reproductionReport } : {}),
    };
  }

  /**
   * Resolve the toolset for the flat loop. Default: every registered tool. The
   * 4P `phases?` categorization is kept on tools for back-compat but is no longer
   * load-bearing for selection.
   */
  resolveLoopTools(): AgentTool[] {
    return this.registry.allTools();
  }

  /** Build the opening user message for the (optional) planning turn. */
  private buildLoopOpening(
    task: string,
    opts: RunOptions,
    ctx: { phase: Phase },
  ): string {
    const parts: string[] = [];
    parts.push(`WORKING DIRECTORY: ${this.cwd}`);
    parts.push(`TASK:\n${task}`);
    if (opts.followUpContext?.mode === "structured_continue") {
      const prev = opts.followUpContext.previousRun;
      parts.push(
        `THREAD CONTEXT FROM THE PREVIOUS RUN (reconcile against the current workspace first):\n` +
          [
            `Previous task: ${prev.task}`,
            `Previous disposition: ${prev.disposition}`,
            `Run summary: ${prev.summary}`,
            ...(prev.writtenPaths?.length ? [`Files changed: ${prev.writtenPaths.join(", ")}`] : []),
          ].join("\n"),
      );
    }
    const imgs = opts.enrichedImages ?? opts.images;
    if (imgs?.length) {
      const list = imgs
        .map((i, n) => {
          const base = `${n + 1}. ${i.path} (${i.mimeType})`;
          const role = describeImageRole(i);
          return role ? `${base} — ${role}` : base;
        })
        .join("\n");
      parts.push(`AVAILABLE IMAGES (pass these to write/edit \`images\` to author files from them):\n${list}`);
    }
    if (opts.files?.length) {
      const list = opts.files.map((f, n) => `${n + 1}. ${f.path} (${f.mimeType})`).join("\n");
      parts.push(
        `AVAILABLE FILES (the user attached these — use them):\n${list}\n` +
          `Read text/code/data with \`read\`; analyze PDF/DOCX/audio/video with \`media_analysis\`.`,
      );
    }
    void ctx;
    return parts.join("\n\n");
  }

  /** Build the per-step user message: the task, which step this is, and live progress. */
  private buildStepMessage(
    task: string,
    t: PlanTask | undefined,
    completedSteps: RunStep[],
    opts: RunOptions,
    /** Triage of the images the user pinned to THIS step during plan review. */
    stepEnriched?: EnrichedImage[],
  ): string {
    const parts: string[] = [];
    parts.push(`WORKING DIRECTORY: ${this.cwd}`);
    parts.push(`TASK:\n${task}`);
    if (t) {
      parts.push(
        [
          `ACTIVE STEP: "${t.title}" — ${t.summary}`,
          `complexity=${t.complexity}`,
          ...(t.files.length ? [`files: ${t.files.join(", ")}`] : []),
          ...(t.verification ? [`done when: ${t.verification}`] : []),
          ...(t.risks ? [`risks: ${t.risks}`] : []),
        ].join("\n"),
      );
    }
    // The user's own additions to THIS step, stated after the planner's summary
    // and explicitly outranking it — they were written while looking at the plan.
    if (t?.userNotes) {
      parts.push(
        `USER INSTRUCTIONS FOR THIS STEP (these override the plan summary above):\n${t.userNotes}`,
      );
    }
    if (t?.attachments?.length) {
      // Two notes can apply to one attachment and they say different things:
      // the plan's `note` is WHY this step needs the file, the triage role is
      // WHAT the file turned out to be. Show both when both exist.
      const roleByPath = new Map(
        (stepEnriched ?? []).map((i) => [i.path, describeImageRole(i)] as const),
      );
      const list = t.attachments
        .map((a, n) => {
          const notes = [a.note, roleByPath.get(a.path)].filter(Boolean).join(" — ");
          return `${n + 1}. ${a.path} (${a.mimeType})${notes ? ` — ${notes}` : ""}`;
        })
        .join("\n");
      parts.push(
        `FILES THE USER ATTACHED TO THIS STEP:\n${list}\n` +
          `Use them. For images, pass the path in \`images\` on write/edit to author from them, ` +
          `or as \`file\` on \`media_analysis\` to inspect them first. \`media_analysis\` also reads ` +
          `video, audio and documents (PDF/DOCX); for plain text and code, read them.`,
      );
    }
    if (completedSteps.length) {
      const lines = completedSteps.map(
        (s) => `- [${s.isCompleted ? "x" : " "}] ${s.title} (${s.complexity})${s.error ? ` — ERROR: ${s.error}` : ""}`,
      );
      parts.push(`PROGRESS (steps already run this task):\n${lines.join("\n")}`);
    }
    const imgs = opts.enrichedImages ?? opts.images;
    if (imgs?.length) {
      const list = imgs
        .map((i, n) => {
          const base = `${n + 1}. ${i.path} (${i.mimeType})`;
          const role = describeImageRole(i);
          return role ? `${base} — ${role}` : base;
        })
        .join("\n");
      parts.push(`AVAILABLE IMAGES (pass to write/edit \`images\` for vision authoring):\n${list}`);
    }
    if (opts.files?.length) {
      const list = opts.files.map((f, n) => `${n + 1}. ${f.path} (${f.mimeType})`).join("\n");
      parts.push(
        `AVAILABLE FILES (the user attached these — use them):\n${list}\n` +
          `Read text/code/data with \`read\`; analyze PDF/DOCX/audio/video with \`media_analysis\`.`,
      );
    }
    parts.push(
      "Do this step now using the tools. " +
        "A separate summary turn writes the user-facing summary for the whole run, so your closing turn here is an INTERNAL WORK NOTE, not a summary: " +
        "when this step's work is done, stop calling tools and write a brief note (2-4 sentences) of what you did, what you verified, and what (if anything) is incomplete or unverified. " +
        "Do NOT address it to the user, do NOT prefix it with 'Summary', and do NOT repeat the task or restate files you changed beyond naming them once — the summary turn already covers that. " +
        "This note grounds the summary, it is not the summary itself.",
    );
    return parts.join("\n\n");
  }

  /**
   * The tools the conversational path may use: outward lookup only.
   *
   * An explicit allowlist, not "everything read-only". The value of this path is
   * that it cannot touch the project — a `read` or `grep` here would make
   * "conversational" a second, unbounded work loop with none of the loop's
   * budget, plan or permission structure. Web tools are the exception because the
   * questions that route here are frequently about the world, not the repo.
   */
  private resolveConversationalTools(): AgentTool[] {
    const allowed = new Set(["web_search", "web_fetch", "web_scrape"]);
    return this.registry
      .allTools()
      .filter((t) => allowed.has(t.name) || [...allowed].some((n) => t.name.endsWith(`__${n}`)));
  }

  /**
   * Conversational reply that may look things up first. Runs the ordinary tool
   * loop with ONLY the lookup tools and a tight step cap: this is a chat turn, so
   * a couple of searches is the budget, not an investigation.
   */
  private async streamConversationalWithLookup(
    task: string,
    model: Model,
    tools: AgentTool[],
    signal?: AbortSignal,
  ): Promise<{ message: AssistantMessage; error?: string }> {
    const reasoning = this.reasoningOverrides["prepare"] ?? this.config.reasoning?.["prepare"];
    const result = await runToolLoop({
      task,
      systemPrompt: `${CONVERSATIONAL_PROMPT}\n${CONVERSATIONAL_LOOKUP}`,
      userMessage: task,
      tools,
      model,
      llm: this.llm,
      permission: this.permission,
      logStore: this.logStore,
      emit: (e) => this.emit(e),
      cwd: this.cwd,
      // A chat reply, not a research task. Enough for search → fetch → answer,
      // with headroom for one correction; past that the honest move is to answer
      // with what was found.
      maxSteps: 6,
      ...(reasoning ? { reasoning } : {}),
      ...(signal ? { signal } : {}),
    });
    const message =
      result.finalMessage ?? { ...emptyAssistant(model), errorMessage: "no response", stopReason: "error" as const };
    const error =
      message.stopReason === "error" ? (message.errorMessage ?? "conversational reply failed") : undefined;
    return { message, ...(error ? { error } : {}) };
  }

  /**
   * The intent statement handed to write/edit authoring for THIS step.
   *
   * Deliberately not the full step user message: that carries the working
   * directory, the progress checklist and the tool preamble, none of which tell
   * an authoring model what the bytes should become. It is also not the bare run
   * task — see `ToolLoopInput.authoringTask` for why run-level intent misdirects
   * a per-anchor author. What B needs is this step's goal, with the user's own
   * notes last so they outrank the planner's summary exactly as they do in the
   * step message.
   *
   * Planless runs have no narrower statement than the run task, so they return
   * undefined and the loop falls back to `task`.
   */
  private buildAuthoringTask(task: string, t: PlanTask | undefined): string | undefined {
    if (!t) return undefined;
    return [
      `Overall task: ${task}`,
      `This step: ${t.title} — ${t.summary}`,
      ...(t.verification ? [`Done when: ${t.verification}`] : []),
      ...(t.userNotes ? [`User instructions for this step (these override the summary above):\n${t.userNotes}`] : []),
    ].join("\n");
  }

  /** Map a plan task's files → inherited complexity for per-call model selection. */
  private complexityByPathForTask(t: PlanTask): Record<string, ComplexityRating> {
    const out: Record<string, ComplexityRating> = {};
    for (const f of t.files) out[f] = t.complexity;
    return out;
  }

  /**
   * Single bounded summary turn over the whole run. Returns the summary text.
   *
   * This turn is a FRESH context: it did not do the work, and it has no
   * transcript. Given only step titles and file paths it will happily narrate
   * plausible detail it has no basis for — including verification nobody ran, which
   * is the one thing a summary must never invent. So it is handed the loop's own
   * closing prose per step (`stepReports`, the FINISH text the working model wrote
   * while it still had the evidence in view) and told to write FROM that record
   * rather than from the shape of the task.
   */
  private async summarizeRun(
    task: string,
    steps: RunStep[],
    writtenPaths: string[],
    readPaths: string[],
    refs: MediaRef[],
    stepReports: Array<{ label: string; text: string }>,
    opts: RunOptions,
    signal?: AbortSignal,
    verification?: VerificationReport,
    reproduction?: ReproductionReport,
    /** Verify rounds stopped before the model finished, with their reasons. */
    verifyEndedEarly?: string[],
  ): Promise<{ text: string | undefined; usage?: Usage }> {
    try {
      const lines: string[] = [];
      lines.push(`Summarize the work you just did for this task, in 2-6 sentences.`);
      lines.push(`TASK: ${task}`);
      if (steps.length) {
        lines.push(
          `STEPS:\n` + steps.map((s) => `- ${s.title} (${s.complexity}) — ${s.isCompleted ? "done" : "incomplete"}${s.error ? ` [${s.error}]` : ""}`).join("\n"),
        );
      }
      if (writtenPaths.length) lines.push(`FILES CHANGED: ${writtenPaths.join(", ")}`);
      if (readPaths.length) lines.push(`FILES READ: ${readPaths.join(", ")}`);
      // Generated assets live in `refs` (their details.uri is the written file).
      // FILES CHANGED above now includes their paths too, but a bare path does not
      // tell the summariser a file was GENERATED (an image, an SVG) rather than
      // hand-edited — and a summary that omits a generation entirely is the gap
      // this closes, because that summary is the WHOLE context the next prompt on
      // the thread receives. Surface them as assets explicitly.
      const assetRefs = refs.filter((r) => !/^(https?|data|blob):/i.test(r.uri));
      if (assetRefs.length) {
        lines.push(
          `ASSETS GENERATED (each was produced by a tool this run, not hand-edited):\n` +
            assetRefs.map((r) => `- ${r.uri} (${r.mimeType})${r.summary ? ` — ${r.summary}` : ""}`).join("\n"),
        );
      }
      if (stepReports.length) {
        lines.push(
          `WHAT THE WORKING MODEL REPORTED (its own closing words per step — this is your evidence):\n` +
            stepReports.map((r) => `--- ${r.label} ---\n${r.text}`).join("\n\n"),
        );
      }
      if (verification && (verification.checked.length || verification.certified.length || verification.unverified.length)) {
        const vLines: string[] = [];
        if (verification.checked.length) {
          vLines.push(`Checked (evidence behind them): ${verification.checked.map((c) => `${c.path} (${c.tool})`).join(", ")}`);
        }
        if (verification.certified.length) {
          vLines.push(`Certified as no runtime check needed: ${verification.certified.map((c) => c.path).join(", ")}`);
        }
        if (verification.unverified.length) {
          vLines.push(`UNVERIFIED (no check landed): ${verification.unverified.map((c) => c.path).join(", ")}`);
        }
        lines.push(`VERIFICATION (ground truth from the verify gate, not the model's self-report):\n` + vLines.join("\n"));
      }
      // WHY verification ended where it did. Without this an interrupted check is
      // indistinguishable in the summary from a check nobody attempted, and the
      // user is left to guess whether the run gave up or was cut off.
      if (verifyEndedEarly?.length) {
        lines.push(
          `VERIFICATION ENDED EARLY (the round was stopped while the model was still working — this is NOT ` +
            `the same as declining to check):\n` + verifyEndedEarly.map((r) => `- ${r}`).join("\n"),
        );
      }
      if (reproduction) {
        const rLine = reproduction.declaredStraightforward
          ? `Skipped reproduction (declared straightforward): ${reproduction.declaredStraightforward.reason}`
          : reproduction.reproduced
            ? "Bug reproduced before editing (observed the broken behaviour)."
            : typeof reproduction.gaveUpAfterBlocks === "number"
              ? `Did NOT reproduce (gate gave up after ${reproduction.gaveUpAfterBlocks} refusals).`
              : reproduction.askedUser
                ? "Asked the user for reproduction steps."
                : reproduction.instrumentedForTrace?.length
                  ? // Probes went in and no trace was ever harvested. Distinct from a
                    // plain miss: the run started the reproduction and abandoned it,
                    // and the named files may still hold instrumentation.
                    `Did NOT reproduce — instrumented ${reproduction.instrumentedForTrace.join(", ")} with trace ` +
                    `probes but never collected any trace output.`
                  : reproduction.traceOpened
                    ? "Did NOT reproduce (a trace was opened but nothing was instrumented or collected)."
                    : "Did NOT reproduce.";
        lines.push(`REPRODUCTION (ground truth from the reproduce gate):\n${rLine}`);
      }
      lines.push(
        `Reply with ONLY the summary prose. Ground every claim in the report above. ` +
          `If a step ended early, failed, or was left incomplete, say so and what remains. ` +
          `If VERIFICATION is present, say plainly what was verified and name anything left UNVERIFIED — a change ` +
          `described as done but listed unverified is the one summary a user cannot trust. ` +
          `If REPRODUCTION is present, say whether the bug was reproduced before editing (or skipped and why). ` +
          `If VERIFICATION ENDED EARLY is present, say that verification was CUT SHORT and why — do not report ` +
          `those files as simply unchecked, and do not imply the run chose to skip the check. ` +
          `If ASSETS GENERATED is present, cover what was generated — the next message on this thread receives ONLY ` +
          `this summary, so a generation the summary omits is a generation the next run does not know happened.`,
      );
      const model = this.llm.resolveModel(this.phaseModelSlug("perfect"));
      const msg = await this.llm.complete(
        model,
        {
          systemPrompt: [
            "You write the closing summary of a coding run, for the user who asked for it.",
            "You did NOT do this work: everything you know is in the record below. Write from it, and never",
            "add detail it does not contain — no invented file contents, no reasoning you did not see, and",
            "above all no test, build, or visual check that the record does not say was actually run.",
            "Lead with what the user got. Name the files that changed by path, say plainly what is still",
            "incomplete or unverified, and stop. If assets were generated, name them and what kind they are.",
            "Plain prose, 2-6 sentences, no headings, no bullet lists, no preamble.",
          ].join(" "),
          messages: [{ role: "user", content: lines.join("\n\n"), timestamp: Date.now() }],
        },
        { reasoning: "off", signal },
      );
      const text = messageText(msg);
      return { text: text.trim() || undefined, ...(msg.usage ? { usage: msg.usage } : {}) };
    } catch {
      return { text: undefined };
    }
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
      const intent = await this.classifyIntent(task, signal);
      // `RunChainOptions` carries no attachments, so the conversational path's
      // inability to read files cannot bite here — no guard needed (cf. `run()`).
      if (intent.route === "conversational") {
        const { message, error } = await this.streamConversationalReply(task, signal);
        // The router turn is billed too — see `classifyIntent`. On this path it
        // is a meaningful share of a reply that may itself have used no tools.
        const usage = intent.usage ? addUsage(message.usage, intent.usage) : message.usage;
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
      // A host may answer with files as well as text (see `AskUserQuestionResult`).
      // The legacy plan-review path only ever cared about the prose verdict.
      const reviewAnswer = await opts.askUserQuestion(buildPlanReviewRequest());
      const decision = parsePlanReviewDecision(
        typeof reviewAnswer === "string" ? reviewAnswer : reviewAnswer.text,
      );
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

/** Fold a sub-loop's accumulated refs into the run's growing ref list (deduped). */
/**
 * Image refs attached to this specific step — by the planner routing a run
 * attachment to the step that needs it, or by the user dropping one on the step
 * during review.
 *
 * Each ref is stamped with the step's own files as `targets` and the attachment's
 * note as `label`, and BOTH matter.
 *
 * `targets` is the routing evidence, and dropping it was a real hole on any run
 * carrying more than one image. A step's own images are merged with every run-wide
 * image before reaching the work loop, so a write inside a step of a run with eight
 * uploaded mockups saw nine candidates. With no `targets`, the `routed` rung of
 * {@link scopeImagesForTarget} could not fire; affinity only wins on a distinctive
 * filename token, which the names real exports carry ("Frame 12.png",
 * "Screenshot 2026-01-02.png") do not have; `sole` needs exactly one candidate.
 * So the routing came out AMBIGUOUS and passed NO image — the step the user had
 * deliberately pinned a design to authored from prose, and said so only in a note
 * at the end of the tool result. The evidence to prevent that was sitting on the
 * plan the whole time: this step declares which files it touches.
 *
 * Stamping `targets` also buys the exclusion half: an image bound to this step's
 * files is removed from contention for every OTHER file, so a sibling step's
 * mockup can no longer be picked up here.
 *
 * `label` feeds the affinity rung and the ambiguity report, so a note like "the
 * hero this step builds" is usable evidence rather than decoration.
 *
 * Non-image attachments are excluded (they are still listed in the step's opening
 * message) because `images` feeds vision passes, and handing a PDF to a vision
 * model as if it were a screenshot produces confident nonsense.
 */
function stepImageRefs(task?: PlanTask): LiveImage[] {
  const targets = (task?.files ?? []).filter((f) => typeof f === "string" && f.trim());
  return (task?.attachments ?? [])
    // `mimeType` is typed as required but arrives from a host, so treat a
    // missing one as "not an image" instead of throwing — the plan tool fills it
    // in from the extension, and a step attachment is never worth a crash.
    .filter((a) => typeof a.mimeType === "string" && a.mimeType.startsWith("image/"))
    .map((a) => ({
      path: a.path,
      mimeType: a.mimeType,
      ...(targets.length ? { targets } : {}),
      ...(a.note?.trim() ? { label: a.note.trim() } : {}),
    }));
}

function collectLoopRefs(into: MediaRef[], loop: ToolLoopResult): void {
  if (!loop.refs?.length) return;
  const seen = new Set(into.map((r) => r.uri));
  for (const r of loop.refs) {
    if (!seen.has(r.uri)) {
      into.push(r);
      seen.add(r.uri);
    }
  }
}

/**
 * Activity-monitor probe markers, mirrored from `loop.ts` (kept local so the
 * orchestrator's post-verify scan has no cross-module dependency on a regex
 * that is an internal detail of the loop). See `loop.ts:PROBE_MARKER_RE`.
 */

/**
 * Re-scan the given paths (cwd-relative or absolute) for probe markers that
 * remain on disk. Returns only those that still contain a marker. Failures
 * (missing file, read error) are treated as "no marker found" so a transient
 * I/O issue never deadlocks the run — the worst case is a probe left in place,
 * which is reported, not fatal.
 */
async function scanForProbeMarkers(
  cwd: string,
  paths: string[],
): Promise<string[]> {
  if (!paths.length) return [];
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const remaining: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const content = await fs.readFile(abs, "utf8");
      if (PROBE_MARKER_RE.test(content)) remaining.push(p);
    } catch {
      // Missing/unreadable → can't confirm a marker; skip.
    }
  }
  return remaining;
}

/** Fold a sub-loop's touched paths into the run's growing path lists (deduped). */
function collectLoopPaths(
  written: string[],
  read: string[],
  discovered: string[],
  loop: ToolLoopResult,
  instrumented?: string[],
): void {
  const pushUnique = (arr: string[], items: string[]) => {
    const seen = new Set(arr);
    for (const p of items) if (!seen.has(p)) arr.push(p), seen.add(p);
  };
  if (loop.writtenPaths?.length) pushUnique(written, loop.writtenPaths);
  if (loop.readPaths?.length) pushUnique(read, loop.readPaths);
  if (loop.discoveredPaths?.length) pushUnique(discovered, loop.discoveredPaths);
  if (instrumented && loop.instrumentedPaths?.length) pushUnique(instrumented, loop.instrumentedPaths);
}

/**
 * Build the continuity snapshot for a flat-loop run. A compact, run-shaped
 * alternative to the 4P buildThreadSnapshot — carries the summary, the per-step
 * progress (with isCompleted), the changed/read files, and any pending question.
 */
/**
 * Test seam for {@link buildRunThreadSnapshot}. The disposition rule it encodes —
 * that a bug fix which observed nothing and changed nothing is not `completed` —
 * is the kind of thing that is only ever noticed in a database days later, so it
 * gets a direct test rather than one mediated by a whole orchestrated run.
 */
export function buildRunThreadSnapshotForTest(
  input: Parameters<typeof buildRunThreadSnapshot>[0],
): ThreadRunSnapshot {
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
  reproduction?: ReproductionReport;
}): ThreadRunSnapshot {
  // A bug fix that never observed the bug AND changed nothing did not complete
  // anything, and must not say it did. This is the state an observed run ended in:
  // it explored, was refused a premature fix, never instrumented, never collected,
  // wrote no file — and reported `disposition: "completed"`. The prose summary was
  // honest about it; the machine-readable field, which is what a host renders and
  // what the next run reads as history, said the opposite.
  //
  // A bug fix that did not reproduce but DID write a fix stays `completed`: work
  // landed, and `verified` plus `reproduction` carry how much to trust it. The line
  // is drawn at "nothing observed and nothing changed", where there is no outcome
  // to report at all.
  const emptyBugFix =
    input.reproduction !== undefined &&
    !input.reproduction.reproduced &&
    !input.reproduction.askedUser &&
    input.reproduction.declaredStraightforward === undefined &&
    (input.writtenPaths?.length ?? 0) === 0;
  const disposition: ThreadRunDisposition = input.pendingUserQuestion
    ? "pending_user_question"
    : input.error
      ? "failed"
      : input.success && !emptyBugFix
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
    // Carried so a host can SEE whether the bug was ever observed. Without it the
    // only signal was the summary prose, which no UI switches on.
    ...(input.reproduction ? { reproduction: input.reproduction } : {}),
  };
}

/**
 * Test seam for the verify message. The verify round is now STAGE-driven (see
 * {@link buildStageMessage} in verify-stages.ts): each round sends the focused
 * message for one stage (instrument / run / inspect / decide). This returns the
 * COMBINED form — all four slices in order — so the wiring (every route named,
 * the device/dev-server guidance, the DECLARE format) is still asserted in one
 * place. The slices are shared with the staged builder, so the two cannot drift.
 */
export function buildVerificationMessageForTest(
  gaps: VerificationGap[],
  handoff: RunHandoffResult,
  round: number,
  maxRounds: number,
  deviceCommands?: ProjectRunCommand[],
  webCommands?: ProjectRunCommand[],
): string {
  return buildFullVerificationMessage({ gaps, handoff, round, maxRounds, deviceCommands, webCommands });
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
