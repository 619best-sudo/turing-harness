/**
 * The flat tool loop — a pi-agent-style, phase-agnostic work loop.
 *
 * Each call runs a completion-driven turn loop: stream a model turn, walk its tool calls,
 * route each through the permission gate (permission callback fires here),
 * estimate complexity + select the per-call model, execute the tool, and feed
 * the result back into one growing message history — until the model produces a
 * turn with no tool calls (the normal end: the work is done), stalls, aborts, or
 * hard-errors. There is no step cap by default; `maxSteps` is opt-in.
 *
 * All four callbacks are honored inside this loop:
 *   - permission: `permission.evaluate(req)` before every tool call.
 *   - model:      `decision.model` / `decision.authorModel` re-pin the driver.
 *   - complexity: `estimateComplexity` per call; inherited ratings honored.
 *   - category:   the `phase` field on PermissionRequest (kept for back-compat).
 *
 * This is the loop core the categorizer chain drives: one scoped toolset, one
 * system prompt, one model per invocation. It carries no orchestration policy —
 * the chain (categorizer hops, routing, deliverables) lives in the caller.
 *
 * TERMINAL TOOLS: a tool flagged `terminal: true` (the categorizers' `deliver`)
 * ends the loop after its turn completes — completion is a deterministic signal.
 */
import { PROBE_MARKER_RE } from "../probe-marker.js";
import type {
  ImageContent,
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  AssistantMessage,
  AuthoringContext,
  Complexity,
  ComplexityRating,
  ComplexitySource,
  Context,
  LLMBridge,
  MediaRef,
  LiveImage,
  Message,
  Model,
  ReadFileContent,
  ResolvedClarification,
  Tool,
  ToolResultMessage,
  Usage,
} from "../types.js";
import {
  asComplexityCategory,
  asComplexityRating,
  emptyUsage,
  ratingToScore,
  scoreToRating,
} from "../types.js";
import type { LogStore } from "../logging/logger.js";
import type { Registry } from "../registry/registry.js";
import { isMalformedToolArgs, MALFORMED_TOOL_ARGS_KEY } from "../llm/bridge.js";
import { PermissionGate } from "./permission.js";
import { StallGuard, STEP_BUDGET_EXHAUSTED } from "./stall-guard.js";
import { ClarifyGate, normalizeQuestion, shellAuthoringTarget } from "./clarify-gate.js";
import { ToolFallbackAdvisor, type FallbackAdvice } from "./tool-fallback.js";
import { SearchLadderAdvisor, type SearchAdvice } from "./search-ladder.js";
import {
  nameBeforeFraming,
  resolveToolAlias,
  unknownToolMessage,
  unknownArgumentKeys,
  unknownArgumentMessage,
} from "./tool-suggest.js";
import {
  coerceStringArgs,
  coercionNote,
  renameNote,
  resolveArgAliases,
  type CoercedArg,
} from "./tool-arg-coercion.js";
import { estimateComplexity, selectModel } from "../llm/model-selector.js";
import { compactHistory, historySize, pruneHistoricalMedia, resolveCompactionThreshold } from "./compaction.js";
import { designReferenceFromBrief } from "../tools/builtin/design-skill.js";
import { guessMimeType } from "../multimodal/attachment.js";
import { generateAssetsFromReference } from "./asset-generation.js";
import type { GeneratedAssetRef } from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Inputs to a single loop invocation. */
export interface ToolLoopInput {
  /** The originating task (for authoring context + logging). */
  task: string;
  /**
   * What THIS loop invocation was asked to do, when that is narrower than `task`.
   *
   * `task` is run-level and outlives every turn in the run ("build a solar system
   * animation"). The authoring model is handed one anchor and asked what should
   * replace it, so a run-level string is the wrong altitude: on a follow-up turn
   * ("now rename the title to ToottyFruity") it states an intent that has already
   * been satisfied, and B authors toward the stale goal instead of the live one.
   * The observed failure was B rewriting a title to describe the run task while
   * the actual instruction never appeared in its prompt at all.
   *
   * Set this to the current step's / turn's instruction; `task` remains the
   * fallback for callers that have nothing narrower. This is the ONLY intent
   * channel that works under `authorOnlyWrites`, where the schema gives Model A
   * no `content`/`newString` field in which to express the change.
   */
  authoringTask?: string;
  /** Optional system prompt; defaults to a minimal work prompt. */
  systemPrompt?: string;
  /** Initial user message content (text or text+image blocks). */
  userMessage: string | import("../types.js").UserContent[];
  /** Optional prior context to seed the conversation (follow-up continuity). */
  priorMessages?: Message[];
  /** Executable tools available this loop. */
  tools: AgentTool[];
  /**
   * Optional dynamic tool resolver. When provided, the loop calls this at the
   * start of every turn to refresh the tool set — allowing MCP servers that
   * connect mid-run to surface their tools without restarting the loop.
   * When omitted, the static `tools` array is used for the entire loop.
   */
  resolveTools?: () => AgentTool[];
  /** The model driving the loop turns. */
  model: Model;
  /** Candidate model slugs the permission layer may pick from for tool calls. */
  toolModelCandidates?: string[];
  /**
   * Multimodal model used to DESCRIBE images a tool returns when the run's own
   * model cannot read them. Without it a blind run loses tool screenshots
   * entirely; with it, it gets them as text.
   */
  visionModel?: string;
  /**
   * Host-owned escalation routing: (kind, rating) → model slug. Consulted for
   * write/edit authoring here, and handed to tools via `ctx.routeModel` so the
   * staged `read` resolves its comprehension model from the same table.
   */
  routeModel?: import("../types.js").ModelRouter;
  llm: LLMBridge;
  permission: PermissionGate;
  registry?: Registry;
  logStore: LogStore;
  emit: (e: AgentEvent) => void;
  cwd: string;
  signal?: AbortSignal;
  /**
   * Optional hard cap on turns. Unset by default: the loop runs until the model
   * stops calling tools, and `StallGuard` ends it if it stops making progress.
   * When set, the loop also injects a wind-down note as the cap nears.
   */
  maxSteps?: number;
  /**
   * Characters of conversation above which older turns are summarised away.
   *
   * Defaults to the `TURING_COMPACT_THRESHOLD_CHARS` env var, then to 300k
   * (~75k tokens). Pass `Infinity` to disable for one loop. This exists because
   * bounding each tool result stops ONE result from ending a run, but forty
   * bounded results still add up to a request the provider refuses.
   */
  compactThresholdChars?: number;
  temperature?: number;
  /** Reasoning effort for the loop's turns. */
  reasoning?: import("../types.js").ThinkingLevel;
  transcriptMode?: import("../types.js").TranscriptMode;
  /**
   * When set, overrides what `transcriptMode` would imply for reasoning blocks.
   * `transcriptMode: "compact"` otherwise seeds this off — which is a real trap:
   * emission can only be turned back on by a TOOL CALL's permission decision, so
   * a compact run silently discards the whole first turn's thinking, and discards
   * it entirely on a turn that calls no tools. A host that wants the model's
   * reasoning in a compact transcript must be able to say so up front.
   */
  emitReasoning?: boolean;
  /** Same, for assistant text. Defaults to `false` under `transcriptMode: "compact"`. */
  emitText?: boolean;
  /**
   * Optional host callback for `ask_user_question`; when provided the tool blocks
   * in-place for the answer and the model continues in the same conversation.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  /** Host callback for `create_plan` review (approve / re-plan with comments). */
  planApproval?: import("../types.js").PlanApprovalCallback;
  /**
   * The run's live attachment set — forwarded to write/edit authoring, and to
   * `ctx.images` for every tool that reads it.
   *
   * `LiveImage` rather than a bare path/mime pair so each entry keeps the ROLE
   * attachment triage assigned it. Visual verification depends on that role: a
   * live capture is compared against the run's design mockup, never against an
   * `informational` attachment that merely happened to be listed first.
   */
  images?: LiveImage[];
  /** Per-path complexity inherited from a plan task (raises the call's floor). */
  complexityByPath?: Record<string, ComplexityRating>;
  /** Where the inherited per-path complexity came from. */
  complexitySource?: "prepare-file" | "plan-task";
  /**
   * Label stamped onto PermissionRequest.phase. In v2 this is the CATEGORIZER id
   * driving this loop ("read", "write_edit", …) — kept as a plain string so
   * hosts keying on the old field keep working, and the chain can label honestly.
   */
  phase?: string;
  /**
   * The ask-before-you-invent gate, threaded in by the chain so one refusal
   * covers the whole run rather than one per categorizer. When omitted the loop
   * creates an INERT one (no task ⇒ never active), so standalone `runToolLoop`
   * callers are unaffected.
   */
  clarifyGate?: ClarifyGate;
  /**
   * Questions the user already answered in EARLIER hops. Seeds the authoring
   * channel, re-enters answer attachments into the live image set, and arms the
   * clarify gate against asking any of them again.
   */
  clarifications?: ResolvedClarification[];
  /** Optional plan JSON handed to the authoring context. */
  planJson?: unknown[];
  /** Optional surrounding-file snippets handed to the authoring context. */
  attachedFileContents?: ReadFileContent[];
  attachedContextFiles?: ReadFileContent[];
  /**
   * Task-relevant line extracts a prior categorizer's deliverable carried
   * (read's `files[].snippet`). These reach the AUTHORING context only,
   * clearly labeled as extracts — they are NOT verbatim file contents and
   * must NEVER satisfy a `read` call: a hop that wants exact bytes (an edit
   * anchor) gets a real read, not a paraphrase served as the file. Feeding
   * them through the attached-file cache is exactly the field failure where
   * write_edit's offset read came back as read's summary and the model fell
   * back to `bash sed -n` to see its own lines.
   */
  handoffSnippets?: ReadFileContent[];
  /**
   * A read-dedup cache SHARED across a run's loops (the chain threads one in).
   * Within a loop, identical read-only calls are served from cache; a write to a
   * path invalidates its entries. Sharing it across hops means write_edit does
   * not re-pay (or re-escalate) reads the read categorizer already made.
   */
  sharedReadCache?: Map<string, string>;
  /**
   * The run-scoped comprehension store (the chain creates one per run and threads
   * it through every hop). The staged `read` consults it before rating or
   * comprehending, so a file the read hop already handed to a stronger model is
   * reused — re-injected into each new hop's driver context at zero model cost,
   * pointed-to (never re-emitted) within the same loop — instead of being
   * re-rated and re-comprehended on every hop. Absent ⇒ tools fall back to the
   * module-level default store (direct tool use).
   */
  sharedComprehension?: import("../tools/builtin/comprehension.js").ComprehensionStore;
  /**
   * Files whose whole-file analyses were ALREADY injected into this loop's
   * opening message by the chain (the hop-start handover). Seeding
   * `emittedInThisLoop` with them arms the re-visit advisor from turn one: the
   * first re-read of such a file is already flagged as redundant, instead of
   * arming only after the loop itself has emitted the analysis once.
   */
  preComprehended?: string[];
  /**
   * The detected project category, threaded live so the post-Prepare correction
   * is seen here. Drives the non-UI skip: when `"backend"`, the
   * inspiration/design-skill reference ladder is bypassed (no UI to design) and
   * the inspiration/assets tools decline when the model invokes them directly.
   */
  projectCategory?: import("../presets/project-presets.js").ProjectCategory;
  /**
   * Initial media fact seed: informational OCR/text lifted out of attachments by
   * the orchestrator's triage pre-pass, so the very first write/edit already
   * carries it as known context (the loop would otherwise only learn a media
   * fact from a mid-run media_analysis call). The loop's `mediaFact`
   * accumulator is seeded with this and appended to across the run.
   */
  mediaFact?: string;
  /**
   * Optional callback to triage an image a user supplies MID-RUN (in answer to
   * `ask_user_question`). Without it, such images join `images` un-enriched (the
   * legacy behavior). When provided, the loop runs the same describe→ocr pre-pass
   * the orchestrator runs on initial attachments and folds the extracted `fact`
   * into the `mediaFact` accumulator, so a spec/screenshot dropped after the run
   * started is understood exactly like one attached up front. A triage failure
   * resolves to `undefined` and the image is kept as a raw live image.
   */
  triageAttachment?: (img: { path: string; mimeType: string }) => Promise<{ fact?: string; note?: string; category?: string } | undefined>;
  /** Label for logging only. */
  label?: string;
}

/** Result of a single loop invocation. */
export interface ToolLoopResult {
  /** The final assistant message (last streamed turn). */
  finalMessage?: AssistantMessage;
  /** The full message history produced by this loop. */
  messages: Message[];
  /** Concatenated text of the final assistant message. */
  finalText: string;
  /** Aggregated token usage across all turns. */
  usage: Usage;
  /** Media/artifact refs accumulated. */
  refs: MediaRef[];
  /** Max complexity score observed across tool calls. */
  maxComplexity: number;
  /** Files actually written/edited during this loop (success-only). */
  writtenPaths: string[];
  /**
   * Files that had activity-monitor probe markers (`__t()`/`__TRACE` etc.)
   * written into them this loop. Tracked so the orchestrator can refuse run
   * completion while instrumentation remains, and so `activity_cleanup` can
   * name the files to strip. A superset-tracking best-effort: markers a model
   * writes into a file we never see the content of are missed, but the common
   * case (the loop-mediated write/edit that inserted `__t()`) is caught.
   */
  instrumentedPaths: string[];
  /** Files successfully read during this loop (success-only). */
  readPaths: string[];
  /** All confirmed paths touched by tool calls. */
  discoveredPaths: string[];
  /** A pending clarifying question that paused the loop, if any. */
  pendingUserQuestion?: AskUserQuestionRequest;
  /**
   * Questions the user has ANSWERED — the ones seeded into this loop plus any it
   * resolved itself. The chain threads these into every later hop so no
   * categorizer asks for something the user already supplied.
   */
  resolvedClarifications?: ResolvedClarification[];
  /**
   * The run's live attachment set as it stands at the end of this loop: what came
   * in, plus any image the user handed over via `ask_user_question`.
   */
  liveImages?: LiveImage[];
  /**
   * A plan produced by the `create_plan` tool during this loop. Surfaced here so
   * the orchestrator can execute a TOOL-authored plan the same way it executes
   * one scraped from the planning turn's text.
   */
  planSet?: import("../types.js").PlanSet;
  /** Hard error (LLM/transport/tool) that ended the loop early, if any. */
  error?: string;
  /**
   * Name of the TERMINAL tool that completed this loop (`deliver`), when the
   * loop ended because a categorizer delivered rather than because the model
   * stopped calling tools. Undefined on a natural stop.
   */
  terminatedBy?: string;
  /**
   * Final per-path complexity state (plan floors + measured ratchets), for
   * callers that chain loops and want difficulty to carry forward.
   */
  complexityByPath?: Record<string, import("../types.js").ComplexityRating>;
}

/**
 * Run the tool loop to completion. Returns the accumulated history + final message.
 * Throws never — aborts and hard errors are captured in the result.
 */
export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const { llm, permission, emit, cwd, signal, logStore } = input;
  // No step cap by default: the loop runs until the model stops calling tools.
  // A fixed number was always the wrong control — it cut real multi-file work
  // mid-edit (with no summary, so the run looked "complete") while doing nothing
  // about a model that had genuinely gone in circles. Non-convergence is caught
  // by `StallGuard` (repetition / all-calls-failed) instead. A host may still set
  // `maxSteps` explicitly; when it does, the wind-down below applies.
  const maxSteps = input.maxSteps ?? Infinity;
  // Characters of history above which the loop summarises its older turns. Env
  // configurable so a host on a small-context model can lower it without a code
  // change; see `resolveCompactionThreshold`.
  let compactThreshold = input.compactThresholdChars ?? resolveCompactionThreshold();
  // Retries spent on a request the provider called too large. See the
  // stream-error branch in the turn loop.
  let oversizeRetries = 0;
  const MAX_OVERSIZE_RETRIES = 2;
  const boundedSteps = Number.isFinite(maxSteps);
  const stallGuard = new StallGuard();
  // An unarmed gate by default: without the router's verdict there is nothing to
  // enforce, so a standalone `runToolLoop` caller behaves exactly as before.
  const clarifyGate = input.clarifyGate ?? new ClarifyGate();
  const fallbackAdvisor = new ToolFallbackAdvisor();
  // Enforces the file-search order — memory index first, shell search only after
  // memory has actually been tried and come back empty.
  const searchLadder = new SearchLadderAdvisor();
  // Files this loop has already told the driver it holds the whole-file expert
  // analysis for. The re-visit advisor fires once per file per loop, then stays
  // quiet — repeating the same note every turn is itself the no-progress pattern
  // the stall guard exists to stop.
  const readRevisitWarned = new Set<string>();
  // Files whose whole-file analysis has been emitted into THIS loop's context
  // (as of the end of the previous turn). Snapshot per turn into
  // `preTurnEmitted` so the re-visit advisor never nags the turn that FIRST
  // emitted an analysis.
  const emittedInThisLoop = new Set<string>(input.preComprehended ?? []);
  // Distinct files read this loop, and whether the "you have read enough —
  // deliver or edit now" nudge has already fired. The comprehension store makes
  // re-reads free, so the thing that still costs is opening NEW files: a driver
  // that keeps opening more without delivering is gathering past the point of
  // diminishing returns, and nothing but this nudge tells it so.
  const loopReadFiles = new Set<string>();
  let readCompletionWarned = false;
  // QA-hop read spiral, stage two. The completion nudge is advice; the field
  // run it exists for read 4+ MORE files after it and never launched, never
  // drove, never delivered — 18 minutes of a QA hop doing the read pass's job.
  // Past the fence below, exploration-only turns end the hop with a named
  // reason instead of grinding to a derived fallback.
  let qaReadFenceNoted = false;
  let qaExplorationTurns = 0;
  // The window spiral: re-reading ONE file at many offsets never grows the
  // distinct-file count, so the fence above stays silent while a field run
  // read a single provider at EIGHT offsets before ever probing. Re-reads of
  // an already-read file count separately — until the hop ACTS (probes, runs,
  // drives), because the byte-exact anchor reads for `add_log` come after the
  // decision and are legitimate.
  let windowRereads = 0;
  let sawHopAction = false;
  // When only this many steps remain, inject a system note telling the model to
  // stop calling tools and produce its summary. Graceful wind-down beats a hard
  // cut that leaves the run looking "complete" but unfinished.
  const wrapUpRemaining = 5;
  let toolByName = new Map(input.tools.map((t) => [t.name, t]));
  const phase = input.phase ?? "perform";

  logStore.append({
    tags: ["loop", ...(input.label ? [`loop:${input.label}`] : [])],
    level: "info",
    message: input.label ? `start loop: ${input.label}` : "start loop",
  });

  const userContent = input.userMessage;
  const messages: Message[] = input.priorMessages ? [...input.priorMessages] : [];
  messages.push({ role: "user", content: userContent, timestamp: Date.now() });

  const context: Context = {
    systemPrompt: input.systemPrompt,
    messages,
    tools: toToolDefs(input.tools),
  };

  let usage = emptyUsage();
  // Latest inspiration lookup this loop; the last call wins, since a second
  // lookup means the model rejected the first reference.
  let designReference: unknown[] | undefined;
  // Assets the harness generated to fulfill the media roles `designReference`
  // described (image/video/audio). Threaded into authoring so a fresh UI write
  // embeds real paths instead of placeholders. Set alongside designReference.
  let generatedAssets: GeneratedAssetRef[] | undefined;
  // Informational facts lifted from a `media_analysis` result (OCR text of an
  // `informational` attachment). Append-only: a run may triage several images,
  // each contributing a fact the authoring pass should know. Mirror of
  // `designReference` — captured from a tool result, fed to the next write/edit.
  // Seeded from the orchestrator's attachment triage pre-pass (`input.mediaFact`)
  // so the first write/edit carries triaged info without a mid-run analysis.
  let mediaFact: string | undefined = input.mediaFact;
  // A resolved `ask_user_question` carries the user's answer in its tool result.
  // The driver sees it in conversation, but the authoring model does not — and
  // under `authorOnlyWrites` the driver has no `content`/`newString` field in
  // which to express the answer, so the bytes are authored without it. Fold the
  // Q&A into the authoring intent, exactly as `mediaFact`/`designReference` are
  // folded, so the next write/edit authors toward the clarified instruction
  // rather than the run-level goal. Append-only: a run may ask more than once.
  let clarification: string | undefined;
  /**
   * Every question the user has answered, this hop and every hop before it.
   *
   * Seeded from `input.clarifications` so a later hop starts already knowing
   * what the user said, and returned so the chain can hand it to the hop after
   * this one. Without the seed the answer lived only in the asking hop and the
   * next categorizer asked again.
   */
  const resolvedClarifications: ResolvedClarification[] = [...(input.clarifications ?? [])];
  const CLARIFIED_QUESTIONS = new Set(resolvedClarifications.map((entry) => normalizeQuestion(entry.question)));
  // Prior hops' answers reach the authoring model too, not just the driver.
  for (const entry of resolvedClarifications) {
    const rendered = renderClarification(entry);
    clarification = clarification ? `${clarification}\n${rendered}` : rendered;
  }
  // The run's LIVE attachment set. Seeded from what the host supplied, and grown
  // when the user hands a file over mid-run via `ask_user_question`.
  //
  // A fixed `input.images` was the reason asking for a file achieved nothing:
  // the agent could request the mockup, the user could send it, and the very
  // next write would still author from prose — the file was named in a tool
  // result and never looked at again. An attachment that arrives mid-run has to
  // reach the same places one attached up front does, or asking for it is a
  // round trip that costs the user an interruption and buys nothing.
  const liveImages: LiveImage[] = [...(input.images ?? [])];
  const LIVE_IMAGE_PATHS = new Set(liveImages.map((i) => i.path));
  // A file the user attached to an answer in an EARLIER hop is an attachment of
  // this run, not of that hop. Re-enter it here so a write/edit two hops later
  // still authors from the mockup the user handed over.
  for (const entry of input.clarifications ?? []) {
    for (const file of entry.attachments ?? []) {
      if (!file.mimeType.startsWith("image/") || LIVE_IMAGE_PATHS.has(file.path)) continue;
      LIVE_IMAGE_PATHS.add(file.path);
      liveImages.push({ path: file.path, mimeType: file.mimeType });
    }
  }
  const refs: MediaRef[] = [];
  const discoveredPaths: string[] = [];
  const readPaths: string[] = [];
  const writtenPaths: string[] = [];
  // Paths seen to contain activity-monitor probe markers this loop. Tracked for
  // the orchestrator's post-verify "strip instrumentation" check and for
  // `activity_cleanup`. Deduped via INSTRUMENTED_WITH like writtenPaths.
  const instrumentedPaths: string[] = [];
  const PATHS_WITH = new Set<string>();
  const READ_WITH = new Set<string>();
  const WRITTEN_WITH = new Set<string>();
  const INSTRUMENTED_WITH = new Set<string>();
  // Seeded from the plan step's ratings, then MUTATED during the run as tools
  // measure the artifacts they touch (see `measuredComplexity` below).
  const COMPLEXITY_BY_PATH = new Map<string, ComplexityRating>();
  for (const [filePath, rating] of Object.entries(input.complexityByPath ?? {})) {
    COMPLEXITY_BY_PATH.set(normalizeToolPath(cwd, filePath), rating);
  }
  /** Paths whose rating came from a tool measuring the file, not from the plan.
   *  Tracked so the permission request can report the honest `complexitySource`. */
  const MEASURED_PATHS = new Set<string>();
  const MUTATING_TOOLS = new Set(["write", "edit"]);
/** `guessMimeType` narrowed to image/* (plan attachments may omit the mime). */
function guessImageMime(p: string): string {
  const m = guessMimeType(p);
  return m.startsWith("image/") ? m : "application/octet-stream";
}
  const READ_TOOLS = new Set(["read", "ls", "grep", "cat"]);
  const ATTACHED_FILE_CONTENTS = new Map(
    [...(input.attachedFileContents ?? []), ...(input.attachedContextFiles ?? [])].map((file) => [
      normalizeToolPath(cwd, file.path),
      file.content,
    ] as const),
  );
  const readCache = input.sharedReadCache ?? new Map<string, string>();
  let maxComplexity = 0;
  let lastAssistant: AssistantMessage | undefined;
  let error: string | undefined;
  let pendingUserQuestion: AskUserQuestionRequest | undefined;
  let producedPlanSet: import("../types.js").PlanSet | undefined;
  // Set when a TERMINAL tool (a categorizer's `deliver`) completed successfully;
  // the loop finishes the turn (so every toolCall keeps its result — providers
  // reject a dangling call) and then stops instead of prompting another turn.
  let terminatedBy: string | undefined;
  // Turns that ended in prose with nothing called, while a terminal `deliver`
  // was still owed. Re-prompted rather than accepted, twice at most — see the
  // no-tool-call branch in the turn loop.
  let prematureFinishes = 0;
  const MAX_PREMATURE_FINISH = 2;
  /** Has this loop called any tool yet? (Distinguishes "trailed off" from "answered".) */
  let madeToolCall = false;

  // Live UI-emission axes + reasoning effort + driver model (same semantics as
  // the old phase runner: a TOOL decision may flip them for subsequent turns).
  // An explicit seed wins over what transcriptMode implies. Without this, the
  // only way emission ever turns on is the permission decision inside the tool
  // loop below — i.e. after the first turn has already streamed and been
  // dropped, and never at all on a turn that calls no tools.
  const seedCompact = input.transcriptMode === "compact";
  let liveEmitText = input.emitText ?? !seedCompact;
  let liveEmitReasoning = input.emitReasoning ?? !seedCompact;
  let liveReasoningLevel = input.reasoning;
  let liveModel = input.model;
  // Did ANY turn actually come back with thinking? See the end-of-loop check.
  let sawThinkingContent = false;

  // Log the starting toolset by name. "The model only used bash" has two very
  // different causes — the tool was never registered, or it was registered and
  // the model didn't pick it — and they are indistinguishable from the outside.
  // Only refreshes were logged before, so a run that never gained or lost a tool
  // left no record of what it started with. Memory tools are called out
  // separately because they are the ones that go missing: `registerBuiltins`
  // does NOT include them (see tools/index.ts), so they exist only when the host
  // went through `Harness.createProjectSession` with memory enabled.
  {
    const names = [...toolByName.keys()].sort();
    const memoryTools = names.filter((n) => n.endsWith("_memory"));
    logStore.append({
      tags: ["loop", "tools"],
      level: memoryTools.length === 0 ? "warn" : "info",
      message:
        `${input.phase ? `[${input.phase}] ` : ""}loop starting with ${names.length} tools` +
        (memoryTools.length === 0
          ? "; NO memory tools registered — the search ladder will fall through to the shell " +
            "(project_memory/file_memory/graph_memory are registered only by createProjectSession)"
          : `; memory: ${memoryTools.join(", ")}`),
      data: {
        tools: names,
        memoryTools,
        // Without this the log cannot be attributed: a 61-tool list is correct
        // for activity_inspect and alarming for read, and the entry looked
        // identical either way.
        ...(input.phase ? { categorizer: input.phase } : {}),
        ...(input.label ? { label: input.label } : {}),
      },
    });
  }

  /**
   * Argument names each tool has already been corrected on, this loop.
   *
   * The reminder that stops a repeat has to differ from the one that did not: a
   * second identical note reads as the same generic warning. On a repeat the note
   * restates the tool's whole signature and says it has happened before.
   */
  const ARG_NAME_MISTAKES = new Map<string, Set<string>>();

  // Per-tool streak of consecutive calls rejected for missing/empty required
  // arguments. A model that emits empty tool calls (e.g. `bash {}`) burns turns
  // one rejected call at a time, because the rejections are interspersed with
  // successful reads and so never trip the all-error stall guard. This escalates
  // the nudge as the streak grows so the model stops flailing.
  const missingArgStreak = new Map<string, number>();
  // TOTAL empty-argument rejections per tool this loop, which the consecutive
  // streak above cannot see. The streak resets on every well-formed call, so a
  // model that alternates good call / `bash {}` / good call / `bash {}` never
  // gets past streak 1 — which is exactly what one run did, eight times, each
  // one a wasted call answered with the same message it had already ignored.
  const missingArgTotal = new Map<string, number>();

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) throw new DOMExceptionLike("aborted");
      // Files whose whole-file analysis was already in THIS loop's context before
      // the upcoming turn. The comprehension re-visit advisor fires only on reads
      // of files in this set — a file's FIRST read in the loop (which emits the
      // analysis during its own turn) is not a re-visit, and must not be nagged.
      const preTurnEmitted = new Set(emittedInThisLoop);

      // Prune old inlined media BEFORE sizing/compacting. Captures (screenshots,
      // audio, video, file bytes) arrive as base64 blocks that otherwise
      // accumulate one per turn and balloon every subsequent request; keeping
      // only the most recent captures also stops them from tripping compaction
      // (which summarises away load-bearing text context — a user's ask_user
      // answer, completed edits — and is how a run "forgets" what it just did
      // and re-asks the same question).
      pruneHistoricalMedia(context.messages);

      // Compact BEFORE the turn, so the request about to be sent is the smaller
      // one. Doing it after a failed send would be too late — the provider has
      // already rejected it and the turn is lost.
      if (historySize(context.messages) > compactThreshold) {
        const compaction = await compactHistory({
          messages: context.messages,
          llm,
          model: liveModel ?? input.model,
          threshold: compactThreshold,
          ...(signal ? { signal } : {}),
        });
        if (compaction.compacted) {
          context.messages = compaction.messages;
          usage = addUsage(usage, compaction.usage);
          logStore.append({
            timestamp: Date.now(),
            level: "info",
            tags: ["loop", "loop:compacted"],
            message:
              `compacted history at step ${step + 1}: freed ${compaction.savedChars.toLocaleString("en-US")} chars ` +
              `(threshold ${compactThreshold.toLocaleString("en-US")})`,
            ...(input.label ? { data: { label: input.label } } : {}),
          });
        }
      }

      // Dynamic tool resolution: re-resolve the tool set each turn so MCP servers
      // that connected mid-run become visible to the model without restarting.
      if (input.resolveTools) {
        const fresh = input.resolveTools();
        const prevNames = new Set([...toolByName.keys()]);
        const newNames = new Set(fresh.map((t) => t.name));
        const added = [...newNames].filter((n) => !prevNames.has(n));
        const removed = [...prevNames].filter((n) => !newNames.has(n));
        if (added.length || removed.length) {
          toolByName = new Map(fresh.map((t) => [t.name, t]));
          context.tools = toToolDefs(fresh);
          logStore.append({
            tags: ["loop", "tools"],
            level: "info",
            message: `loop tool refresh: ${added.length} added, ${removed.length} removed`,
            data: { added, removed },
          });
        }
      }

      // Context size computed ONCE per turn and reused by every complexity
      // estimate in it. The old code serialized the ENTIRE history
      // (JSON.stringify) on EVERY tool call — O(history × calls) work per turn,
      // which is what made long runs slow down as they grew.
      const turnContextChars = historySize(context.messages);

      emit({ type: "turn_start" });
      const assistant = await streamToMessage(llm, liveModel, context, emit, {
        temperature: input.temperature,
        // Omit when unset: an explicit `reasoning: undefined` still means
        // "provider default" to most callers, but omitting the key keeps the
        // historical "absent ⇒ provider default" contract observable to hosts.
        ...(liveReasoningLevel ? { reasoning: liveReasoningLevel } : {}),
        signal,
        emitText: liveEmitText,
        emitReasoning: liveEmitReasoning,
      });
      lastAssistant = assistant;
      if (assistant.content.some((c) => c.type === "thinking")) sawThinkingContent = true;
      usage = addUsage(usage, assistant.usage);
      context.messages.push(assistant);
      liveModel = input.model;

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        // A REQUEST THAT WAS TOO BIG IS NOT A DEAD RUN.
        //
        // From the field: a verify hop got the app building on a simulator, then
        // polled the build log three times, and the next request came back
        // `OpenRouter stream failed (413): request entity too large`. That ended
        // the hop, which ended the RUN — after the change had been written, the
        // user had answered the QA handshake, and the app was actually starting.
        // Every one of those was thrown away by a failure whose entire remedy is
        // "send less".
        //
        // So: compact hard and retry the same turn. The pre-turn compactor only
        // fires above its threshold, and 413 says the provider's real limit is
        // BELOW wherever that threshold sits for this model, so the threshold
        // comes down for the rest of the loop too. Bounded — after
        // `MAX_OVERSIZE_RETRIES` the error stands and the run ends as it did
        // before, with the reason named.
        if (
          assistant.stopReason === "error" &&
          isOversizedRequestError(assistant.errorMessage) &&
          oversizeRetries < MAX_OVERSIZE_RETRIES
        ) {
          oversizeRetries += 1;
          // Drop the failed assistant turn — it carries no content, and leaving
          // it in the history is one more message on the retry.
          if (context.messages[context.messages.length - 1] === assistant) context.messages.pop();
          const before = historySize(context.messages);
          compactThreshold = Math.max(MIN_COMPACT_THRESHOLD, Math.floor(before * 0.5));
          const compaction = await compactHistory({
            messages: context.messages,
            llm,
            model: liveModel ?? input.model,
            threshold: compactThreshold,
            ...(signal ? { signal } : {}),
          });
          if (compaction.compacted) {
            context.messages = compaction.messages;
            usage = addUsage(usage, compaction.usage);
          }
          logStore.append({
            tags: ["loop", "loop:oversized-request"],
            level: "warn",
            message:
              `request rejected as too large (${before.toLocaleString("en-US")} chars of history); ` +
              `compacted to ${historySize(context.messages).toLocaleString("en-US")} and retrying ` +
              `(${oversizeRetries}/${MAX_OVERSIZE_RETRIES}, threshold now ${compactThreshold.toLocaleString("en-US")})`,
            data: { phase: input.phase, ...(input.label ? { label: input.label } : {}) },
          });
          emit({ type: "turn_end", message: assistant, toolResults: [] });
          // Nothing was compacted and nothing can be: retrying the same bytes
          // would just fail the same way.
          if (!compaction.compacted && historySize(context.messages) >= before) {
            error = assistant.errorMessage ?? "request too large and nothing left to compact";
            break;
          }
          continue;
        }
        error = assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "aborted" : undefined);
        emit({ type: "turn_end", message: assistant, toolResults: [] });
        break;
      }
      if (signal?.aborted) break;

      const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
      if (toolCalls.length === 0) {
        // A turn with no tool calls normally means the work is done. In a
        // CATEGORIZER hop it can also mean the driver never started: the hop
        // holds a `deliver` tool it must finish through, so prose with nothing
        // called is a hop that ended before it began.
        //
        // From the field, and the reason this exists: FLOOR 0 correctly routed a
        // finished write pass into `activity_inspect`, the hop opened with 62
        // tools — and five seconds later it "ended without calling deliver".
        // Zero tool calls. Every gate in the QA pass keys off a tool call, so
        // none of them fired: not the handshake that asks the user who does the
        // QA, not observe-first, not the freshness check. A guard that can only
        // speak when spoken to cannot bind a model that says nothing.
        //
        // So: one re-prompt, naming what the hop still owes, then the loop
        // continues. Bounded and cheap — after `MAX_PREMATURE_FINISH` it ends as
        // before and the chain derives its fallback deliverable, which is an
        // honest empty answer rather than an invented one.
        const terminalTool = [...toolByName.values()].find((t) => t.terminal)?.name;
        const isQa = input.phase === "activity_reproduce" || input.phase === "activity_inspect";
        // Prose IS the answer on the conversational path — one turn, no tools, no
        // loop, by design. So this only fires where prose cannot be the answer: a
        // QA hop (whose entire job is evidence about running software), or any hop
        // that already started calling tools and then trailed off mid-work.
        const owesDeliver = terminalTool != null && !terminatedBy && (isQa || madeToolCall);
        if (owesDeliver && prematureFinishes < MAX_PREMATURE_FINISH) {
          prematureFinishes += 1;
          const note = isQa
            ? "NOTE: you ended the turn with prose and called nothing, and this categorizer's work has " +
              "not started. Do STEP 0 now: ONE `ask_user_question` asking the user who runs the " +
              "software — you do it / they do it themselves / skip this pass — naming the surface you " +
              "would run and what you would look at, so one click settles it. Their answer decides what " +
              "happens next: you drive it, or you ask them for the capture/log and judge that, or you " +
              "`deliver` the honest empty result saying it was skipped at their request. Analysis in " +
              "prose is not any of those three, and it is not what this categorizer is for."
            : "NOTE: you ended the turn with prose and called nothing, but this categorizer finishes " +
              `through \`${terminalTool}\` — a text reply is not a handoff, and the chain cannot pass ` +
              "prose to the next step. Either take the next action the task needs, or call " +
              `\`${terminalTool}\` now with what you actually have (an honest partial result is a real ` +
              "answer; an invented one is not).";
          context.messages.push({
            role: "user",
            content: [{ type: "text", text: note }],
            timestamp: Date.now(),
          });
          stallGuard.grantGrace();
          logStore.append({
            tags: ["loop", "loop:premature-finish"],
            level: "warn",
            message: `hop ended with prose and no tool call before delivering — re-prompted (${prematureFinishes}/${MAX_PREMATURE_FINISH})`,
            data: { phase: input.phase, ...(input.label ? { label: input.label } : {}) },
          });
          emit({ type: "turn_end", message: assistant, toolResults: [] });
          continue;
        }
        emit({ type: "turn_end", message: assistant, toolResults: [] });
        break;
      }

      madeToolCall = true;
      const toolResults: Message[] = [];
      for (const call of toolCalls) {
        if (call.type !== "toolCall") continue;

        // ---- recover a call whose NAME carries leaked provider framing ----
        // Some endpoints delimit tool calls with sentinel tokens, and a
        // mis-segmented stream puts them in the `name` field:
        // `read<|channel|>clipboard`, `bash<|tool_call_begin|>…`. The arguments
        // usually survive intact, and when they do the call is fully recoverable
        // — the model asked for a real tool with real arguments and the
        // transport mangled one field.
        //
        // It was not being recovered. The whole call was rejected as an unknown
        // tool, with a message asserting the arguments were empty — which in the
        // observed run was FALSE: `read<|channel|>clipboard` arrived with
        // `{path, offset: 670, limit: 50}` and was refused anyway. The model
        // re-issued it three different ways across three turns before getting
        // through. Repairing the name costs nothing and cannot change intent:
        // only the leading identifier is trusted, and only when it names a tool
        // that actually exists.
        if (!toolByName.has(call.name) && !isMalformedToolArgs(call.arguments)) {
          const recovered = nameBeforeFraming(call.name, toolByName.keys());
          if (recovered && call.arguments && Object.keys(call.arguments).length > 0) {
            logStore.append({
              tags: ["loop", "tools", "tools:framing-recovered"],
              level: "warn",
              message: `tool name arrived with provider framing; recovered "${recovered}" and ran the call`,
              data: { requested: call.name, recovered, ...(input.label ? { label: input.label } : {}) },
            });
            call.name = recovered;
          }
        }

        // A name that IS another tool, in another agent's vocabulary — resolve it
        // and run it. The alternative, observed twice in one run: `shell
        // {command}` answered with "Unknown tool. Did you mean read?" while
        // `bash` sat unused in the same toolset, after which the model gave up on
        // tools and wrote its probes through `python3` heredocs.
        //
        // Resolved HERE, before the lookup, so everything downstream — argument
        // validation, the permission gate, `mutates` — sees the real tool.
        let renamedTool: { from: string; to: string } | undefined;
        if (!toolByName.has(call.name)) {
          const aliased = resolveToolAlias(call.name, toolByName.keys());
          if (aliased) {
            renamedTool = { from: call.name, to: aliased };
            logStore.append({
              tags: ["loop", "tools", "tools:name-resolved"],
              level: "info",
              message: `${call.name} → ${aliased} (same tool, different name)`,
              data: { requested: call.name, resolved: aliased, ...(input.label ? { label: input.label } : {}) },
            });
            call.name = aliased;
          }
        }
        const tool = toolByName.get(call.name);
        const mutates = tool?.mutates ?? true;
        const argPath = (call.arguments as { path?: unknown } | undefined)?.path;

        // ---- argument validation: reject empty/missing required args up front ----
        // Unknown argument keys are detected here but surfaced as a non-blocking
        // warning appended to the tool RESULT (after it runs), so the call still
        // executes under the lenient historic contract while the model learns the
        // tool's real schema. Hoisted so it is in scope at the result-assembly.
        let unknownArgs: Array<{ key: string; suggestion?: string }> = [];
        // ---- argument COERCION, before validation ----
        // A string argument that arrived as an array of lines, an array of
        // content blocks, or a one-field wrapper object is a serialisation
        // difference, not a misunderstanding — the model said exactly what it
        // wanted written. Rejecting it burns a turn; `String(["a","b"])` (what
        // `edit` used to do) writes "a,b" into the user's file. Join it and say
        // so. Anything ambiguous is left for the validation below to reject.
        // Rename before anything validates: an alias resolved here is a call
        // that RUNS, where the same call yesterday was refused and cost a turn.
        let renamedArgs: Array<{ from: string; to: string }> = [];
        let renameRepeated = false;
        if (tool) {
          const aliased = resolveArgAliases(tool, call.arguments);
          if (aliased.renamed.length) {
            call.arguments = aliased.args;
            renamedArgs = aliased.renamed;
            const seen = ARG_NAME_MISTAKES.get(call.name) ?? new Set<string>();
            renameRepeated = aliased.renamed.some((r) => seen.has(r.from));
            for (const r of aliased.renamed) seen.add(r.from);
            ARG_NAME_MISTAKES.set(call.name, seen);
            logStore.append({
              tags: ["loop", "tools", "tools:arg-renamed"],
              level: renameRepeated ? "warn" : "info",
              message:
                `${call.name}: ${aliased.renamed.map((r) => `${r.from}→${r.to}`).join(", ")}` +
                (renameRepeated ? " (repeat — signature restated)" : ""),
              data: {
                tool: call.name,
                renamed: aliased.renamed,
                repeat: renameRepeated,
                ...(input.label ? { label: input.label } : {}),
              },
            });
          }
        }
        let coercedArgs: CoercedArg[] = [];
        if (tool) {
          const fixed = coerceStringArgs(tool, call.arguments);
          if (fixed.coerced.length) {
            call.arguments = fixed.args;
            coercedArgs = fixed.coerced;
            logStore.append({
              tags: ["loop", "tools", "tools:arg-coerced"],
              level: "warn",
              message: `${call.name}: ${fixed.coerced
                .map((c) => `${c.key} arrived as ${c.from} → ${c.to ?? "string"}`)
                .join("; ")}`,
              data: { tool: call.name, ...(input.label ? { label: input.label } : {}) },
            });
          }
        }
        if (tool) {
          const missing = missingRequiredArgs(tool, call.arguments);
          // Unparseable argument buffer: the model DID send arguments, they just
          // could not be decoded (a call cut off mid-JSON is the usual cause).
          // Reporting them as "missing" is false and unactionable — the model
          // re-sends the same call and fails the same way. Say what is wrong.
          const malformed = isMalformedToolArgs(call.arguments);
          if (malformed) {
            const truncated = assistant.stopReason === "length";
            const msg =
              `${call.name}: the arguments for this call were not valid JSON, so none of them could be read` +
              (truncated
                ? " — the response hit its token limit mid-arguments. Re-issue the call with SHORTER arguments"
                : ". Re-issue the call with complete, valid JSON") +
              `. Do not repeat the call unchanged; it will fail identically.`;
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(call.id, call.name, msg, true);
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            logStore.append({
              tags: ["loop", "tools"],
              level: "warn",
              message: `tool call ${call.name} had unparseable arguments`,
              data: { toolName: call.name, truncated, rawLength: String((call.arguments as Record<string, unknown>)[MALFORMED_TOOL_ARGS_KEY] ?? "").length },
            });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
          if (missing.length) {
            const plural = missing.length > 1;
            const streak = (missingArgStreak.get(call.name) ?? 0) + 1;
            missingArgStreak.set(call.name, streak);
            const base =
              `${call.name}: missing required argument${plural ? "s" : ""} ` +
              `${missing.map((m) => `'${m}'`).join(", ")}. ` +
              `Do not call ${call.name} without ${plural ? "them" : "it"} — provide the argument${plural ? "s" : ""} and retry, or skip the call if it isn't needed.`;
            // Escalate once the model has repeated the same empty-arg rejection:
            // a single miss is normal, but a streak means it is stuck emitting
            // malformed calls (observed: 8 `bash {}` calls in one run). Name the
            // streak and tell it to stop calling tools if it cannot form the call.
            const total = (missingArgTotal.get(call.name) ?? 0) + 1;
            missingArgTotal.set(call.name, total);
            // Two counters, two different problems. A STREAK means the model is
            // wedged on one malformed shape right now. A TOTAL means it keeps
            // coming back to the same mistake between successful calls, which
            // the streak resets away and which no amount of re-explaining has
            // fixed — so that message stops explaining and shows the literal
            // JSON instead.
            // How to describe the repetition: consecutive is a different problem
            // from recurring, and the model should be told which one it has.
            const howOften =
              streak >= 2 && streak === total
                ? `${streak} times in a row`
                : streak >= 2
                  ? `${streak} times in a row (and ${total} times in this run)`
                  : `${total} times in this run`;
            const names = missing.map((m) => `'${m}'`).join(" and ");
            const escalation =
              streak < 2 && total < 3
                ? ""
                : `\n\nYou have now called \`${call.name}\` ${howOften} with missing/empty required arguments, ` +
                  `and it was rejected each time. Re-issue ONE well-formed call with ${names} filled in, or ` +
                  `STOP calling tools and say in plain text what you are trying to do.` +
                  // From the third rejection, stop explaining the rule and show
                  // the shape. Re-wording the same instruction had already failed
                  // twice by this point in the run that prompted it.
                  (total >= 3
                    ? `\nA valid call is EXACTLY this, with your own values substituted:\n` +
                      `  ${JSON.stringify(Object.fromEntries(missing.map((m) => [m, `<the ${m}>`])))}`
                    : "");
            const msg = base + escalation;
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(call.id, call.name, msg, true);
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
          // A well-formed call: clear this tool's missing-arg streak.
          missingArgStreak.delete(call.name);
          // Unknown ARGUMENT keys (computed but NOT blocking): the model sent a
          // field this tool does not accept — a hallucination, a typo
          // (`comand`), or cross-tool conflation (`bash({url})`). The call still
          // runs (the unknown key is ignored, matching the lenient historic
          // contract), but the warning is appended to the result so the model
          // sees the closest real field and the tool's accepted fields and can
          // self-correct on the next call. Blocking here broke legitimate calls
          // that carry a sibling tool's fields.
          unknownArgs = unknownArgumentKeys(call.name, tool.parameters, call.arguments, mutates);
        }


        // ---- attached-file short-circuit: serve cached file content ----
        if (typeof argPath === "string" && ["read", "cat"].includes(call.name)) {
          const requested = normalizeToolPath(cwd, argPath);
          const attached = ATTACHED_FILE_CONTENTS.get(requested);
          if (attached != null) {
            const attachedResult = makeToolResult(
              call.id,
              call.name,
              `${attached}\n\n(note: returned from the handoff cache; this file content was already available from earlier work in the same session.)`,
              false,
            );
            context.messages.push(attachedResult);
            toolResults.push(attachedResult);
            if (!READ_WITH.has(requested)) {
              readPaths.push(requested);
              READ_WITH.add(requested);
            }
            continue;
          }
        }

        // ---- dedup: identical read-only call already answered this loop ----
        //
        // The path is normalised into the key rather than taken verbatim: the same
        // file reached as `lib/x.dart` and as `/abs/path/lib/x.dart` is the same
        // read, and keying on the raw argument made those two misses. Every OTHER
        // argument still participates, so a genuine re-read at a different
        // `offset`/`limit` is correctly treated as a different call.
        const callSig = readCacheKey(cwd, call.name, call.arguments);
        if (tool && !mutates && READ_TOOLS.has(call.name) && readCache.has(callSig)) {
          const cached = readCache.get(callSig)!;
          const dup = makeToolResult(
            call.id,
            call.name,
            `${cached}\n\n(note: an identical ${call.name} call already returned this earlier in this loop — reusing the cached result. Do not repeat the same read.)`,
            false,
          );
          context.messages.push(dup);
          toolResults.push(dup);
          continue;
        }

        // ---- ask-before-you-invent ----
        // Ordered before the reproduce gate because it is the cheaper question:
        // "do you even know what to write" precedes "have you seen the bug".
        const clarify = clarifyGate.check(call.name, call.arguments);
        if (clarify.kind === "block") {
          emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
          const refused = makeToolResult(call.id, call.name, clarify.message, true);
          emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: refused.content, isError: true });
          logStore.append({
            tags: ["loop", "clarify-gate"],
            level: "warn",
            message: `${call.name} refused: the request names no new value and the user has not been asked`,
          });
          context.messages.push(refused);
          toolResults.push(refused);
          continue;
        }

        // ---- complexity estimate → model selection ----
        const inheritedKey =
          typeof argPath === "string" && argPath.trim() ? normalizeToolPath(cwd, argPath) : undefined;
        const inheritedRating = inheritedKey ? COMPLEXITY_BY_PATH.get(inheritedKey) : undefined;
        const complexity = estimateComplexity({
          toolCount: input.tools.length,
          contextChars: turnContextChars,
          mutates,
          refs,
          bias: tool?.complexityHint ? tool.complexityHint - 0.3 : 0,
        });
        // ---- model-DECLARED rating + category (mutations only) ----
        // A write/edit call already carries the target path and the code, so the
        // model can rate the work at zero extra token cost — the read half has to
        // spend a rater call because there is nothing to judge until the bytes
        // exist. Where a rating is declared it is AUTHORITATIVE, not a floor: the
        // arithmetic estimate cannot produce `low` for a mutation at all (the
        // `mutates` term alone clears the threshold), so treating a declaration as
        // a floor would discard the only signal able to route a genuinely trivial
        // edit back to the cheap model.
        //
        // Absent ⇒ nothing happens and the arithmetic stands, which is why this
        // needs no feature flag: a model that never populates the field behaves
        // exactly as before.
        const declaredRating = canDeclareComplexity(call.name, mutates)
          ? asComplexityRating(call.arguments?.complexity)
          : undefined;
        const declaredCategory = canDeclareComplexity(call.name, mutates)
          ? asComplexityCategory(call.arguments?.category)
          : undefined;
        // A call that carries images is building FROM a design, and the arithmetic
        // estimate already weighted those attachments. Overwriting the score with a
        // declaration would throw that signal away — so a mockup floors the rating
        // at `medium`. "Here is the mockup, build it" is never mechanical work, and
        // a `low` there would author the driver's text-only draft and quietly lose
        // the image.
        const callImageCount =
          (Array.isArray(call.arguments?.images) ? call.arguments.images.length : 0) +
          liveImages.length;
        if (declaredRating) {
          const effective =
            declaredRating === "low" && callImageCount > 0 ? "medium" : declaredRating;
          complexity.score = ratingToScore(effective);
          complexity.signals.declaredComplexity = declaredRating;
          if (effective !== declaredRating) complexity.signals.imageFloor = effective;
          if (declaredCategory) complexity.signals.declaredCategory = declaredCategory;
        }
        // The measured floor is applied AFTER the declaration on purpose. A rating
        // produced by a tool that actually read the file is evidence; a self-report
        // is not. So a model may talk its way UP but never down past what a read
        // already established for this path.
        if (inheritedRating) {
          const floor = ratingToScore(inheritedRating);
          if (complexity.score < floor) {
            complexity.score = floor;
            complexity.signals.inheritedComplexity = inheritedRating;
          }
        }
        maxComplexity = Math.max(maxComplexity, complexity.score);

        // ---- permission gate ----
        const req = {
          kind: "tool" as const,
          name: call.name,
          mutates,
          args: call.arguments,
          complexity,
          complexityRating: scoreToRating(complexity.score),
          // A rating a tool measured off the real file is reported as such, rather
          // than being mislabeled as inherited from the plan.
          complexitySource: (!inheritedRating
            ? "estimated"
            : inheritedKey && MEASURED_PATHS.has(inheritedKey)
              ? "tool-measured"
              : input.complexitySource ?? "plan-task") as ComplexitySource,
          refs,
          phase,
        };
        emit({ type: "permission_request", request: req });
        const decision = await permission.evaluate(req);
        emit({ type: "permission_decision", request: req, decision });

        if (typeof decision.transcript === "boolean") liveEmitText = decision.transcript;
        if (typeof decision.reasoning === "boolean") liveEmitReasoning = decision.reasoning;

        if (!decision.allowed) {
          const denied = makeToolResult(call.id, call.name, `Permission denied by policy: ${decision.reason ?? ""}`, true);
          context.messages.push(denied);
          toolResults.push(denied);
          continue;
        }
        if (!tool) {
          const missing = makeToolResult(
            call.id,
            call.name,
            unknownToolMessage(call.name, toolByName.keys()) +
              surfaceMismatchNote(call.name, input.phase, toolByName.has("drive")),
            true,
          );
          context.messages.push(missing);
          toolResults.push(missing);
          logStore.append({
            tags: ["loop", "tools"],
            level: "warn",
            message: `model called unknown tool "${call.name}"`,
            data: { requested: call.name, available: [...toolByName.keys()] },
          });
          continue;
        }

        if (typeof decision.thinkingLevel === "string") {
          liveReasoningLevel = decision.thinkingLevel;
        }
        if (decision.model) {
          liveModel = llm.resolveModel(decision.model);
        }

        const { model: callModel } = selectModel({
          preferred: decision.model,
          candidates: input.toolModelCandidates,
          complexity,
          refs,
          mutates,
        });

        // Authoring model (Model B) for write/edit — optional, image-aware.
        // An explicit `decision.authorModel` is a per-call instruction and wins.
        // Otherwise consult the host's routing table with the rating this call
        // actually carries, so write escalation follows the same stated policy as
        // read escalation instead of every host re-deriving it in its permission
        // callback. `low` is never routed: it authors on the loop's own model.
        const canAuthor = mutates && (call.name === "write" || call.name === "edit");
        const callRating = scoreToRating(complexity.score);
        const routedAuthorSlug =
          canAuthor && !decision.authorModel && callRating !== "low"
            ? input.routeModel?.({
                kind: "write",
                rating: callRating,
                // The model's own read of what this work IS, so the host can pick
                // for spatial reasoning on `ui`/`svg` rather than inferring intent
                // from the file extension (a `.tsx` may be pure logic, and often
                // is).
                ...(declaredCategory ? { category: declaredCategory } : {}),
                // Third axis, independent of the other two: authoring FROM a design
                // has a ground truth to match, and the host may want a different
                // model for it at the same rating and category.
                ...(callImageCount > 0 ? { hasAttachment: true } : {}),
                ...(typeof call.arguments?.path === "string" ? { path: call.arguments.path } : {}),
              })
            : undefined;
        const authorSlug = decision.authorModel ?? routedAuthorSlug;
        const authorModel = canAuthor && authorSlug ? llm.resolveModel(authorSlug) : undefined;

        // ---- reference sourcing for a UI write/edit with no reference yet ----
        //
        // The reference-sourcing ladder, by case:
        //   1. the model attached an IMAGE — it replicates directly via
        //      `REPLICATE_FROM_IMAGE` in `authoring.ts`. Nothing to source here;
        //      `callImageCount > 0` is the explicit skip of this block.
        //   2. no image, but `inspiration_generator` is registered — auto-invoke
        //      it on the model's behalf. The model is told to call it in the
        //      prompt, but prompt advice does not bind (see `enforceObserveFirst`
        //      for the same lesson): a rule the model can silently skip is a
        //      suggestion, and the observed failure was UI writes authoring blind
        //      because the model never called the tool. Invoking it here
        //      guarantees a reference when one is achievable.
        //   3. no image, no inspiration match (or no tool registered) — the design
        //      SKILL (`design-skill.ts`) designs a coherent page from the brief,
        //      emitting the same `InspirationJson[]` shape so the existing
        //      threading carries it behind the SAME `DESIGN_REUSE_BOUNDARY`.
        //
        // Engagement is deliberately NARROW, because a design skeleton only helps
        // when authoring a screen FROM SCRATCH:
        //   - UI/SVG path only — a logic write with no reference is the normal case.
        //   - no image attached — an image is handled by rung 1 above.
        //   - the file does NOT already exist — overwriting an existing file has
        //     its structure on disk already; a design reference there competes with
        //     the file's own layout (and would re-fire on every edit to a UI file,
        //     which is not what "only where ui development is happening" means).
        const isFreshUiBuild =
          canAuthor &&
          !designReference?.length &&
          callImageCount === 0 &&
          call.name === "write" &&
          typeof argPath === "string" &&
          isUiOrSvgPath(argPath) &&
          input.projectCategory !== "backend";
        if (isFreshUiBuild) {
          // Existence check: a `write` to a path that already exists is a
          // whole-file rewrite of known structure, not a fresh build. The design
          // reference would argue with the file's own layout.
          let fileExists = true;
          try {
            const abs = path.isAbsolute(argPath) ? argPath : path.join(cwd, argPath);
            await fs.stat(abs);
          } catch {
            fileExists = false;
          }
          if (!fileExists) {
            const refTask = input.authoringTask ?? input.task;
            // --- rung 2: auto-invoke inspiration_generator ---
            let invokable: AgentTool | undefined;
            try {
              invokable = input.registry?.getTool("inspiration_generator");
            } catch {
              invokable = undefined;
            }
            let matched = false;
            if (invokable) {
              const inspireArgs = inspirationArgsFromBrief(refTask, argPath);
              // A minimal tool context: the inspiration tool only reads
              // `cwd`/`signal`/`llm`/`registry` (and its own backend), none of
              // which depend on the write's authoring context that is assembled
              // below. Building the full `toolCtx` would require the very
              // `designReference` this block exists to populate.
              const inspireCtx = {
                cwd,
                log: (e: import("../types.js").LogEntry) => logStore.append(e),
                ...(signal ? { signal } : {}),
                llm,
                ...(input.registry ? { registry: input.registry } : {}),
              };
              try {
                const res = await invokable.execute(
                  `inspiration-auto-${call.id}`,
                  inspireArgs,
                  inspireCtx,
                );
                const blueprints = designReferenceFromToolResult(res.details);
                if (blueprints) {
                  designReference = blueprints;
                  matched = true;
                  if (res.usage) usage = addUsage(usage, res.usage);
                  logStore.append({
                    timestamp: Date.now(),
                    level: "info",
                    tags: ["loop", "inspiration", "inspiration:auto-invoked"],
                    message:
                      `no reference image on ${argPath}; auto-invoked inspiration_generator ` +
                      `→ ${blueprints.length} section(s)`,
                  });
                }
              } catch {
                // A tool failure forgoes the lookup, not the write; fall through
                // to the design skill.
              }
            }
            // --- rung 3: the design skill, when nothing matched above ---
            if (!matched) {
              const skillModel = resolveAuthorModelForSkill({
                decision,
                routedAuthorSlug,
                loop: input,
              });
              if (skillModel) {
                const designed = await designReferenceFromBrief({
                  llm,
                  model: skillModel,
                  ...(refTask ? { task: refTask } : {}),
                  path: argPath,
                  ...(signal ? { signal } : {}),
                });
                if (designed?.sections.length) {
                  designReference = designed.sections;
                  if (designed.usage) usage = addUsage(usage, designed.usage);
                  logStore.append({
                    timestamp: Date.now(),
                    level: "info",
                    tags: ["loop", "design-reference", "design-reference:skill"],
                    message:
                      `no inspiration match for ${argPath}; design skill produced ` +
                      `${designed.sections.length} section(s) via ${skillModel.openRouterSlug ?? skillModel.id}`,
                  });
                }
              }
            }
            // rung 4: fulfill the media roles the reference describes. Generate
            // the image/video/audio assets the blueprint calls for so the write
            // embeds real paths instead of placeholders or authoring blind. No-op
            // when there are no media needs or `assets_generator` is unavailable;
            // a missing backend yields a flagged placeholder, never a failed build.
            if (designReference?.length && input.registry && !signal?.aborted) {
              const gen = await generateAssetsFromReference({
                sections: designReference,
                task: refTask,
                registry: input.registry,
                cwd,
                llm,
                logStore,
                ...(signal ? { signal } : {}),
              });
              if (gen.assets.length) {
                generatedAssets = gen.assets;
                if (gen.usage) usage = addUsage(usage, gen.usage);
                logStore.append({
                  timestamp: Date.now(),
                  level: "info",
                  tags: ["loop", "assets", "assets:auto-generated"],
                  message:
                    `design reference for ${argPath} described ${gen.assets.length} media role(s); ` +
                    `generated via assets_generator`,
                });
              }
            }
          }
        }

        // Assemble the authoring context whenever this call CAN author — NOT only
        // when a slug was pinned or routed.
        //
        // Gating this on a resolved `authorModel` was a starvation bug. The tool
        // does not author only when the runner resolved a model: under
        // `authorOnlyWrites` there is no `content`/`newString` draft at all, so
        // write/edit author UNCONDITIONALLY, falling back to the driver model
        // (`coding.ts`, `driver-fallback`). Routing meanwhile never fires for a
        // `low` rating by design (see `routedAuthorSlug`). So every unrouted low
        // call — "change the title", the most ordinary edit there is — reached the
        // authoring helper with `authoringContext: undefined`: no task, no plan, no
        // snippets. Model B saw the current file and an anchor, was asked for a
        // replacement, and had no statement of intent anywhere in its prompt, so it
        // invented one from the file's own contents. The driver then re-edited the
        // same region against a different invention each round.
        //
        // `canAuthor` is the honest predicate: it is exactly the condition under
        // which the bytes may be authored by a second pass.
        const authoringTask = input.authoringTask ?? input.task;
        // The clarification is appended to the intent because it is the most
        // live statement of what THIS edit should do — a run-level or step task
        // states a goal that may already be satisfied, while a just-answered
        // question names the exact change. The base task still frames it; the
        // clarification specializes it. Under authorOnlyWrites this is the ONLY
        // way a clarification answer reaches the authoring model.
        const taskWithClarification = clarification
          ? authoringTask
            ? `${authoringTask}\n\n${clarification}`
            : clarification
          : authoringTask;
        // The plan the loop itself produced (create_plan inside write_edit)
        // stands in for a caller-threaded planJson: Model B authors toward the
        // approved tasks, exactly as the classic per-step loops did.
        const effectivePlanJson = input.planJson?.length
          ? input.planJson
          : producedPlanSet
            ? (producedPlanSet.plans.flatMap((p) => p.tasks) as unknown[])
            : undefined;
        const authoringContext: AuthoringContext | undefined =
          canAuthor && (taskWithClarification || effectivePlanJson?.length || input.attachedFileContents?.length || input.attachedContextFiles?.length || input.handoffSnippets?.length || liveImages.length)
            ? {
                task: taskWithClarification,
                ...(effectivePlanJson?.length ? { planJson: effectivePlanJson } : {}),
                ...buildAuthoringSnippets(input),
                ...(liveImages.length ? { images: liveImages } : {}),
                ...(designReference?.length ? { designReference } : {}),
                ...(mediaFact ? { mediaFact } : {}),
                ...(generatedAssets?.length ? { generatedAssets } : {}),
              }
            : undefined;

        // The driver's OWN reasoning from this turn, so a tool that escalates to a
        // second model (the staged read's analyst) is told what the driver already
        // covered and can keep its output disjoint from it. Bounded by the tool
        // when it is passed on; here it is only gathered.
        const currentReasoning = assistant.content
          .filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
          .map((c) => c.thinking)
          .join("\n")
          .trim();

        const toolCtx = {
          cwd,
          signal,
          // The live statement of intent, on EVERY call — not only the mutating
          // ones that build an `authoringContext`. A tool that escalates to a
          // second model needs to be able to tell it what the run is doing; see
          // `ToolContext.task` for the run that proved what happens when it
          // cannot.
          ...(taskWithClarification ? { task: taskWithClarification } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
          ...(input.label ? { loopLabel: input.label } : {}),
          model: decision.model ? llm.resolveModel(decision.model) : callModel ?? input.model,
          ...(authorModel ? { authorModel } : {}),
          ...(authoringContext ? { authoringContext } : {}),
          ...(liveImages.length ? { images: liveImages } : {}),
          // Candidate pool + any rating we already hold for this path, so a staged
          // tool can escalate INTERNALLY (rate the artifact → pick the tier that
          // rating deserves) without a host round-trip, and can skip re-rating a
          // file this run has already judged.
          ...(input.toolModelCandidates?.length ? { toolModelCandidates: input.toolModelCandidates } : {}),
          ...(input.routeModel ? { routeModel: input.routeModel } : {}),
          ...(inheritedRating ? { knownComplexity: inheritedRating } : {}),
          // The run-scoped comprehension store: "analyse once per file, inject
          // into the tool chain". The staged read consults it before rating or
          // comprehending, so a file the read hop already analysed is reused by
          // every later hop — re-injected into each new driver context at zero
          // model cost, pointed-to (never re-emitted) within the same loop.
          ...(input.sharedComprehension ? { comprehensionStore: input.sharedComprehension } : {}),
          ...(currentReasoning ? { currentReasoning } : {}),
          // The self-report travels separately from `knownComplexity` (which means
          // MEASURED, and gates whether a staged read spends a rater call). The
          // authoring escalation inside write/edit needs the effective rating for
          // this call — including the image floor above — so a vision escalation
          // tiers on what this call actually is rather than defaulting to `medium`.
          ...(declaredRating ? { declaredComplexity: callRating } : {}),
          ...(declaredCategory ? { declaredCategory } : {}),
          log: (e: import("../types.js").LogEntry) => logStore.append(e),
          // Progress from inside the call, correlated to this call's id so a host
          // can render it against the right tool card. Disarmed once the call
          // settles — an update after `tool_execution_end` is an ordering bug.
          progress: (update: import("../types.js").ToolProgress) => {
            if (settled) return;
            emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, progress: update });
          },
          llm,
          registry: input.registry,
          ...(input.projectCategory ? { projectCategory: input.projectCategory } : {}),
          ...(input.askUserQuestion ? { askUserQuestion: input.askUserQuestion } : {}),
          ...(input.planApproval ? { planApproval: input.planApproval } : {}),
        };

        let settled = false;
        emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
        let resultMsg: ToolResultMessage;
        try {
          const res = await tool.execute(call.id, call.arguments, toolCtx);
          resultMsg = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: boundResultContent(res.content ?? [{ type: "text", text: res.output ?? "" }], call.name),
            details: res.details,
            isError: res.isError ?? false,
            timestamp: Date.now(),
          };
          if (res.output && !(res.content ?? []).some((c) => c.type === "text")) {
            resultMsg.content = boundResultContent(
              [{ type: "text", text: res.output }, ...(res.content ?? [])],
              call.name,
            );
          }
          // Surface unknown argument keys as a non-blocking warning PREPENDED to
          // the result. The call already ran (the unknown keys were ignored); the
          // warning tells the model which fields it invented or typo'd and what
          // the tool actually accepts, so it self-corrects on the next call.
          //
          // Prepended, not appended, because appending made the warning
          // unreadable exactly where it mattered most. A `read` returns the file,
          // so a note placed after the content sits ~20k characters down, past the
          // point any of it is being attended to — a live run typo'd `read`'s
          // window argument three times and never once acted on the warning that
          // was sitting at the bottom of each result. A correction belongs before
          // the thing it corrects.
          // Same placement, same reason: a coerced call SUCCEEDED, so without a
          // note the model has no signal that its argument shape was wrong and
          // keeps sending it.
          if (coercedArgs.length) {
            resultMsg.content = boundResultContent(
              [{ type: "text", text: coercionNote(coercedArgs, call.name) }, ...(resultMsg.content ?? [])],
              call.name,
            );
          }
          if (renamedTool) {
            resultMsg.content = boundResultContent(
              [
                {
                  type: "text",
                  text:
                    `NOTE: there is no tool called \`${renamedTool.from}\` here — \`${renamedTool.to}\` is ` +
                    `the same capability under this harness's name, and the call ran as that. Use ` +
                    `\`${renamedTool.to}\` from now on.`,
                },
                ...(resultMsg.content ?? []),
              ],
              call.name,
            );
          }
          if (renamedArgs.length && tool) {
            resultMsg.content = boundResultContent(
              [
                {
                  type: "text",
                  text: renameNote(call.name, renamedArgs, renameRepeated, tool.parameters),
                },
                ...(resultMsg.content ?? []),
              ],
              call.name,
            );
          }
          if (unknownArgs.length && tool) {
            const warning = unknownArgumentMessage(call.name, tool.parameters, unknownArgs);
            resultMsg.content = boundResultContent(
              [{ type: "text", text: warning }, ...(resultMsg.content ?? [])],
              call.name,
            );
            logStore.append({
              tags: ["loop", "tools"],
              level: "warn",
              message: `tool call ${call.name} carried unknown argument key${unknownArgs.length > 1 ? "s" : ""}: ${unknownArgs.map((u) => u.key).join(", ")}`,
              data: { toolName: call.name, unknown: unknownArgs },
            });
          }
          if (res.usage) usage = addUsage(usage, res.usage);

          // ---- fold a tool-MEASURED rating into the per-path floor ----
          // A tool that actually looked at the artifact knows more than our
          // pre-flight estimate did. Recording it here means the NEXT call on this
          // path (typically the edit that follows a read) arrives at the permission
          // gate already carrying the rating, so the host can escalate `authorModel`
          // on evidence rather than on a guess. Ratings only ever ratchet UP — a
          // later cheap read must not erase a `high` we already established.
          if (res.measuredComplexity) {
            const measuredTarget = res.measuredPath ?? (typeof argPath === "string" ? argPath : undefined);
            if (measuredTarget) {
              const key = normalizeToolPath(cwd, measuredTarget);
              const known = COMPLEXITY_BY_PATH.get(key);
              if (!known || ratingToScore(res.measuredComplexity) > ratingToScore(known)) {
                COMPLEXITY_BY_PATH.set(key, res.measuredComplexity);
                MEASURED_PATHS.add(key);
              }
            }
          }
        } catch (err) {
          resultMsg = makeToolResult(call.id, call.name, `Tool threw: ${(err as Error).message}`, true);
        }
        settled = true;
        // A terminal tool that SUCCEEDED completes the loop after this turn.
        // An errored terminal call does not: the model gets the error and a
        // chance to re-deliver.
        if (tool?.terminal && !resultMsg.isError && !terminatedBy) {
          terminatedBy = tool.name;
          logStore.append({
            tags: ["loop", "loop:terminated"],
            level: "info",
            message: `terminal tool "${tool.name}" completed; finishing after this turn`,
            ...(input.label ? { data: { label: input.label } } : {}),
          });
        }
        emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result: toolExecutionEventResult(resultMsg),
          isError: resultMsg.isError,
        });

        const ref = refFromToolResult(resultMsg);
        if (ref) {
          refs.push(ref);
          // A generated asset (assets_generator) writes its file to disk and
          // reports the path back as `details.uri` — but unlike `write`/`edit`
          // it is not a MUTATING_TOOLS call and its path is in the RESULT, not a
          // `file_path` argument. So the arg-based capture below never sees it,
          // the generated asset was absent from `writtenPaths`, and the run
          // summary + the next prompt's thread context silently dropped every
          // generation the run did. The ref's `uri` IS that path when it points
          // at the local filesystem (a remote URL is media the tool read, not a
          // file it produced), so capture it here on the same success path.
          if (
            !resultMsg.isError &&
            typeof ref.uri === "string" &&
            !/^(https?|data|blob):/i.test(ref.uri)
          ) {
            const assetAbs = path.isAbsolute(ref.uri) ? ref.uri : path.join(cwd, ref.uri);
            if (!WRITTEN_WITH.has(assetAbs)) {
              writtenPaths.push(assetAbs);
              WRITTEN_WITH.add(assetAbs);
              if (writtenPaths.length > 50) writtenPaths.splice(0, writtenPaths.length - 50);
            }
          }
        }
        const questionRequest = askUserQuestionRequestFromResult(resultMsg.details);
        if (questionRequest) pendingUserQuestion = questionRequest;
        // A `create_plan` result carries the structured plan; the last one wins
        // so a re-plan supersedes an earlier draft within the same loop.
        const planFromTool = planSetFromToolResult(resultMsg.details);
        if (planFromTool) {
          producedPlanSet = planFromTool;
          // Files the USER attached to steps during plan review land on the
          // tasks; feed them into the live image set the moment the plan
          // exists, so the write that builds that step authors from them
          // (triaged like any other attachment when a callback is wired).
          for (const plan of planFromTool.plans) {
            for (const t of plan.tasks) {
              for (const att of t.attachments ?? []) {
                if (!att.path) continue;
                const mime = att.mimeType || guessImageMime(att.path);
                if (!mime.startsWith("image/")) continue;
                if (LIVE_IMAGE_PATHS.has(att.path)) continue;
                LIVE_IMAGE_PATHS.add(att.path);
                liveImages.push({ path: att.path, mimeType: mime });
                if (input.triageAttachment) {
                  try {
                    const triaged = await input.triageAttachment({ path: att.path, mimeType: mime });
                    if (triaged?.fact && triaged.fact.trim()) {
                      const fact = triaged.fact.trim();
                      mediaFact = mediaFact ? `${mediaFact}\n${fact}` : fact;
                    }
                  } catch {
                    // enrichment is best-effort
                  }
                }
              }
            }
          }
          // Fold the planner's per-task complexity into the per-path floor, so
          // a write/edit on a file a plan task rated `high` reaches the
          // permission gate already rated high (complexitySource "plan-task").
          // This is the v2 replacement for the classic run's per-step loop
          // threading: the plan now lives INSIDE the write_edit loop, so the
          // inheritance must happen the moment the plan exists. Ratings only
          // ratchet UP — a later cheap read must not erase a plan's high.
          for (const plan of planFromTool.plans) {
            for (const t of plan.tasks) {
              for (const f of t.files) {
                const key = normalizeToolPath(cwd, f);
                const known = COMPLEXITY_BY_PATH.get(key);
                if (!known || ratingToScore(t.complexity) > ratingToScore(known)) {
                  COMPLEXITY_BY_PATH.set(key, t.complexity);
                }
              }
            }
          }
        }
        // Blueprints from `inspiration_generator`, held for the authoring pass.
        // The driver sees this tool result in its conversation; the model that
        // writes the bytes does not, so without this the run looks up a design
        // reference and then authors the UI without it.
        const blueprints = designReferenceFromToolResult(resultMsg.details);
        if (blueprints) designReference = blueprints;
        // An `informational` media_analysis result carries OCR/reference text the
        // task should know at authoring time but the authoring model won't see
        // (it only gets task + file + anchors). Fold it into `mediaFact` so a
        // later write/edit carries it as known context. `ui-replicate`/`ui-bug`
        // images travel as pixels via `images`, not as text — they are skipped
        // here on purpose.
        const fact = mediaFactFromToolResult(resultMsg.details);
        if (fact) mediaFact = mediaFact ? `${mediaFact}\n${fact}` : fact;
        // A resolved `ask_user_question` folds its Q&A into the authoring intent.
        // The driver already saw the answer in conversation; this is what carries
        // it to Model B, which otherwise authors from the run-level task alone.
        const resolvedClarification = clarificationFromToolResult(resultMsg.details, resultMsg.content);
        if (resolvedClarification) {
          clarification = clarification ? `${clarification}\n${resolvedClarification}` : resolvedClarification;
        }
        // The structured twin: what leaves this hop, and what the gate checks a
        // later question against.
        const resolvedRecord = resolvedClarificationFromToolResult(resultMsg.details, resultMsg.content);
        if (resolvedRecord && !CLARIFIED_QUESTIONS.has(normalizeQuestion(resolvedRecord.question))) {
          CLARIFIED_QUESTIONS.add(normalizeQuestion(resolvedRecord.question));
          resolvedClarifications.push(resolvedRecord);
          clarifyGate.recordAnswer(resolvedRecord);
        }

        // Files the USER just handed over in answer to `ask_user_question`.
        // Images join the run's live attachment set so the next write/edit
        // authors from the pixels, exactly as it would for a file attached to
        // the prompt. Non-image files are named in the tool output (which the
        // driver reads) and left to `media_analysis`/`read` — inventing a vision
        // input from a CSV would be worse than pointing at the right tool.
        for (const file of answerAttachmentsFromToolResult(resultMsg.details)) {
          if (!file.mimeType.startsWith("image/")) continue;
          if (LIVE_IMAGE_PATHS.has(file.path)) continue;
          LIVE_IMAGE_PATHS.add(file.path);
          liveImages.push({ path: file.path, mimeType: file.mimeType });
          // Triage the answered image the SAME way initial attachments are
          // triaged up front, so a spec/screenshot the user drops mid-run has
          // its text lifted into `mediaFact` (and its role logged) instead of
          // reaching the authoring pass as undifferentiated pixels. Skipped when
          // no callback is wired (legacy behavior) and resilient to triage
          // failure — the image stays as a raw live image either way.
          let triageNote: string | undefined;
          if (input.triageAttachment) {
            try {
              const triaged = await input.triageAttachment({ path: file.path, mimeType: file.mimeType });
              if (triaged?.fact && triaged.fact.trim()) {
                const fact = triaged.fact.trim();
                mediaFact = mediaFact ? `${mediaFact}\n${fact}` : fact;
              }
              triageNote = triaged?.note;
            } catch {
              // triage is enrichment; a failure leaves the image un-enriched.
            }
          }
          logStore.append({
            timestamp: Date.now(),
            level: "info",
            tags: ["loop", "attachment", "attachment:from-user"],
            message: triageNote
              ? `user attached ${file.path} in answer to a question; triaged — ${triageNote}`
              : `user attached ${file.path} in answer to a question; added to the run's images`,
          });
        }

        // ---- success-only handover capture ----
        if (!resultMsg.isError) {
          // A FILE CHANGED THROUGH THE SHELL IS STILL A CHANGED FILE.
          //
          // `writtenPaths` drives everything downstream: the verify floor that
          // refuses to summarise unlooked-at work, the freshness gate, the
          // probe strip, the run's own report of what it did. It was fed only by
          // `write`/`edit`, so a mutation made any other way was invisible —
          // and a run proved it: the read hop rewrote a Dart source file with a
          // `python3 -c` script, and the run ended "0 written", unverified, in
          // the read hop, with the user's code already changed.
          //
          // The gates that refuse shell authoring are the first answer and they
          // all stand down eventually (deliberately — a gate that can wedge a
          // run is worse than the run). So this is the backstop: whatever the
          // gates allowed through is at least ON THE RECORD, and the run treats
          // it as the change it is.
          const shellAuthored = shellAuthoringTarget(call.name, call.arguments as Record<string, unknown> | undefined);
          if (shellAuthored) {
            const abs = path.isAbsolute(shellAuthored.path)
              ? shellAuthored.path
              : path.join(cwd, shellAuthored.path);
            invalidateReadCache(readCache, cwd, abs);
            ATTACHED_FILE_CONTENTS.delete(normalizeToolPath(cwd, abs));
            if (!WRITTEN_WITH.has(abs)) {
              writtenPaths.push(abs);
              WRITTEN_WITH.add(abs);
              if (writtenPaths.length > 50) writtenPaths.splice(0, writtenPaths.length - 50);
              logStore.append({
                tags: ["loop", "loop:shell-write", "mutation"],
                level: "warn",
                message:
                  `${call.name} changed ${abs} (${shellAuthored.form}) — counted as a write so the run ` +
                  "verifies it; file changes belong in `write`/`edit`",
                data: { path: abs, form: shellAuthored.form, ...(input.label ? { label: input.label } : {}) },
              });
            }
          }
          let absPath: string | undefined;
          if (typeof argPath === "string" && argPath.trim()) {
            absPath = path.isAbsolute(argPath) ? argPath : path.join(cwd, argPath);
            if (!PATHS_WITH.has(absPath)) {
              discoveredPaths.push(absPath);
              PATHS_WITH.add(absPath);
            }
            if (MUTATING_TOOLS.has(call.name)) {
              // Invalidate only what this write actually changed. Clearing the
              // WHOLE cache meant one edit forced a re-read of every other file
              // the run had already loaded — and a re-read is not cheap here: it
              // re-runs the staged rating and, for anything non-trivial, a fresh
              // escalation to the big model. Files this write did not touch are
              // still exactly as they were read.
              invalidateReadCache(readCache, cwd, absPath);
              ATTACHED_FILE_CONTENTS.delete(normalizeToolPath(cwd, absPath));
              if (!WRITTEN_WITH.has(absPath)) {
                writtenPaths.push(absPath);
                WRITTEN_WITH.add(absPath);
                if (writtenPaths.length > 50) writtenPaths.splice(0, writtenPaths.length - 50);
              }
              // Detect activity-monitor probe markers in what was just written,
              // so the chain can strip instrumentation before finishing and
              // `activity_cleanup` can name the files. Scan the diff first
              // (cheapest, most precise); fall back to the tool output for a
              // write whose content isn't surfaced as a diff.
              const diffText = (resultMsg.details as { diff?: unknown } | undefined)?.diff;
              const probeHaystack =
                typeof diffText === "string" ? diffText : typeof resultMsg.content === "string" ? resultMsg.content : "";
              if (probeHaystack && PROBE_MARKER_RE.test(probeHaystack) && !INSTRUMENTED_WITH.has(absPath)) {
                instrumentedPaths.push(absPath);
                INSTRUMENTED_WITH.add(absPath);
              }
            }
            if (READ_TOOLS.has(call.name) && !READ_WITH.has(absPath)) {
              readPaths.push(absPath);
              READ_WITH.add(absPath);
              if (readPaths.length > 50) readPaths.splice(0, readPaths.length - 50);
            }
          }

          const outText = (resultMsg.content ?? [])
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          // A tool that instrumented a file says so in its details (`add_log`).
          // Probe tracking otherwise works by scanning write/edit diffs, which never
          // sees a tool that writes files itself — so these would escape the
          // chain's strip check and ship whenever cleanup was skipped.
          const instrumentedByTool = (resultMsg.details as { instrumented?: unknown; path?: unknown } | undefined);
          if (instrumentedByTool?.instrumented === true && typeof instrumentedByTool.path === "string") {
            const probed = normalizeToolPath(cwd, instrumentedByTool.path);
            if (!INSTRUMENTED_WITH.has(probed)) {
              instrumentedPaths.push(probed);
              INSTRUMENTED_WITH.add(probed);
            }
          }
          // A question to the user satisfies the clarify gate for the rest of the
          // run: the value is no longer being guessed.
          if (!resultMsg.isError) clarifyGate.observe(call.name);
          if (outText) {
            if (!mutates && READ_TOOLS.has(call.name)) {
              readCache.set(callSig, outText);
            }
          }
        }

        // Materialise any inlined audio/video/file bytes to disk and replace them
        // with a path BEFORE the result enters history — so non-image media travels
        // as a `uri`, not megabytes of base64 that bloat every later turn. (Images
        // are handled by the re-surface + prune path below.)
        await materializeInlinedMedia(resultMsg.content, call.name, call.id, cwd);

        context.messages.push(resultMsg);
        toolResults.push(resultMsg);

        // The tool role can't carry images, so an image a tool produced is
        // re-surfaced as a follow-up user message.
        //
        // Which FORM it takes depends on what the run's model can actually read.
        // Handing an image to a text-only model does not degrade — the provider
        // rejects the entire request, killing a browser session on its first
        // screenshot. So a blind model gets a vision model's description instead,
        // and the work continues.
        //
        // The DISK gets the full-resolution capture (persistToolImages, below —
        // it is what media_analysis and the final report read); the CONVERSATION
        // gets a bounded derivative of it. From the field: a 1206×2622 simulator
        // screenshot is 1.2-2MB of PNG, ~1.6-2.7MB of base64, and the 1MB-bounded
        // chat proxy rejected the very next request (413 "request entity too
        // large") — two runs died on their first capture with the app already
        // launched. Vision tokens also scale with pixels, so every turn the
        // original stayed in history re-paid for it. See image-embed.ts.
        const images = resultMsg.content.filter((c) => c.type === "image");
        if (images.length) {
          // Persist the ORIGINALS to files and name the paths to the model, so it
          // can pass them to media_analysis and so the history need not carry the
          // base64 once pruned (the path text is a sibling of the image block and
          // survives pruning). See persistToolImages / buildToolMediaMessage.
          const savedPaths = await persistToolImages(
            images as ImageContent[],
            call.name,
            call.id,
            cwd,
          );
          const embeddable = await downscaleForEmbed(images as ImageContent[], {
            log: (stat) =>
              logStore.append({
                tags: ["loop", "media", "media:compressed"],
                level: "info",
                message: `embedded ${stat.after}B JPEG (≤${stat.width}×${stat.height}) of a ${stat.before}B capture`,
                data: { ...stat, tool: call.name },
              }),
          });
          const mediaMsg = await buildToolMediaMessage({
            toolName: call.name,
            images: embeddable,
            model: liveModel,
            llm,
            visionModel: input.visionModel,
            ...(savedPaths.length ? { savedPaths } : {}),
            log: (message, data) =>
              logStore.append({ tags: ["loop", "media"], level: "info", message, data }),
          });
          context.messages.push(mediaMsg);
          toolResults.push(mediaMsg);
        }
        if (pendingUserQuestion) break;
      }
      emit({ type: "turn_end", message: assistant, toolResults });
      if (pendingUserQuestion) break;
      if (terminatedBy) break;

      const turnCalls = toolCalls.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
      const turnResults = toolResults.filter((m): m is ToolResultMessage => m.role === "toolResult");

      // Escalation ladder for a tool that keeps failing: bash recipe → ask the
      // user → honest stop. Evaluated BEFORE the stall verdict, and the two
      // actionable rungs buy a grace turn, so advice the loop just gave is never
      // advice the model never got to act on.
      for (const advice of fallbackAdvisor.observe(turnCalls, turnResults, toolByName.keys())) {
        context.messages.push({
          role: "user",
          content: [{ type: "text", text: advice.note }],
          timestamp: Date.now(),
        });
        if (advice.kind !== "abandon") stallGuard.grantGrace();
        logStore.append({
          tags: ["loop", "loop:fallback", `fallback:${advice.kind}`],
          level: "warn",
          message: `${advice.tool} kept failing; advised ${ADVICE_LABEL[advice.kind]}`,
          data: { tool: advice.tool, ...(input.label ? { label: input.label } : {}) },
        });
      }

      // File-search ladder: memory index → better query → shell search. Unlike the
      // fallback advisor this needs each tool's OUTPUT, because "found nothing" is
      // a successful call and no error flag will ever reveal it.
      for (const advice of searchLadder.observe(
        turnCalls,
        turnResults.map((r) => ({
          toolCallId: r.toolCallId,
          isError: r.isError,
          text: r.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
        })),
        toolByName.keys(),
      )) {
        context.messages.push({
          role: "user",
          content: [{ type: "text", text: advice.note }],
          timestamp: Date.now(),
        });
        // Every rung hands the model a concrete next call, so none of them should
        // be the turn the stall guard chooses to stop on.
        stallGuard.grantGrace();
        logStore.append({
          tags: ["loop", "loop:search", `search:${advice.kind}`],
          level: "info",
          message: `${advice.tool}: advised ${SEARCH_ADVICE_LABEL[advice.kind]}`,
          data: { tool: advice.tool, ...(input.label ? { label: input.label } : {}) },
        });
      }

      // Comprehension-aware read advisors. Two problems, both the "read tool
      // bottleneck" the field runs showed:
      //
      //  1. RE-VISIT — a driver that re-reads a file it ALREADY holds the
      //     whole-file expert analysis for is re-reading to UNDERSTAND, not to get
      //     bytes (one observed run read a single file at five different offsets).
      //     The read tool's own reuse note covers the per-call case; this covers
      //     the turn-level case with one explicit note per file per loop. Fires on
      //     FULL re-reads too — a full re-read of a comprehended file returns the
      //     same bytes and the same analysis, so it is equally redundant.
      //
      //  2. READ-COMPLETION — opening NEW files is what still costs (each new file
      //     pays its own rater + comprehension). Once the loop has read a
      //     threshold of distinct files with no deliver/write, the driver is told
      //     to wrap up: deliver what it has (read/investigation) or make the
      //     change (write_edit). A nudge, not a stop — it can still read one
      //     specific file it names.
      // A QA hop is told to RUN it, never to "make the change": it holds no
      // write/edit, and on the run this fixes the generic wording landed in
      // `activity_reproduce` — which then went and authored a fix through a
      // `python3` heredoc instead of launching the app.
      const qaHop = input.phase === "activity_reproduce" || input.phase === "activity_inspect";
      if (input.sharedComprehension) {
        const store = input.sharedComprehension;
        // Fold THIS turn's emissions into `emittedInThisLoop` — the NEXT turn's
        // snapshot — and track every distinct file read this loop for the
        // read-completion nudge.
        for (const call of turnCalls) {
          if (call.name !== "read") continue;
          const rawPath = (call.arguments as { path?: unknown } | undefined)?.path;
          if (typeof rawPath !== "string" || !rawPath.trim()) continue;
          const file = normalizeToolPath(cwd, rawPath);
          if (qaHop && !sawHopAction && loopReadFiles.has(file)) windowRereads += 1;
          loopReadFiles.add(file);
          const entry = store.recall(file);
          if (entry?.emittedInLoop === input.label) emittedInThisLoop.add(file);
        }
        for (const call of turnCalls) {
          if (call.name !== "read") continue;
          const rawPath = (call.arguments as { path?: unknown } | undefined)?.path;
          if (typeof rawPath !== "string" || !rawPath.trim()) continue;
          const windowed =
            (call.arguments as { offset?: unknown } | undefined)?.offset != null ||
            (call.arguments as { limit?: unknown } | undefined)?.limit != null;
          const file = normalizeToolPath(cwd, rawPath);
          if (readRevisitWarned.has(file)) continue;
          // Not a re-visit unless the analysis was already in context BEFORE this
          // turn — the turn that first emitted it is the turn that INTRODUCED it.
          if (!preTurnEmitted.has(file)) continue;
          const entry = store.recall(file);
          // Whole-file analyses only: a windowed analysis of a huge file does not
          // explain the rest of it, so asking for another window there is real work.
          if (!entry?.analysis || entry.coveredRange !== "full") continue;
          readRevisitWarned.add(file);
          const note = windowed
            ? `NOTE: you already hold the whole-file expert analysis of ${file} (from a stronger model, ` +
              `given with an earlier read of it in this run). It covers every part of the file — the window ` +
              `you just read is already explained by it. Do not keep reading windows of this file to ` +
              `understand it: read a precise range only when you need its exact bytes, then continue ` +
              `toward the task.`
            : `NOTE: you already read ${file} in full and hold its whole-file expert analysis (injected ` +
              `earlier in this run). Re-reading it returns the same bytes and the same analysis. If you ` +
              `need a specific line range, read that range once; otherwise continue toward the task — ` +
              `edit, or deliver when you are gathering.`;
          context.messages.push({
            role: "user",
            content: [{ type: "text", text: note }],
            timestamp: Date.now(),
          });
          stallGuard.grantGrace();
          logStore.append({
            tags: ["loop", "loop:comprehension-revisit"],
            level: "info",
            message: `advised the driver it already holds the whole-file analysis of ${file}`,
            data: { file, ...(input.label ? { label: input.label } : {}) },
          });
        }
        if (!readCompletionWarned && loopReadFiles.size >= READ_COMPLETION_THRESHOLD) {
          readCompletionWarned = true;
          const note = qaHop
            ? `NOTE: you have read ${loopReadFiles.size} distinct files this step, and reading is not ` +
              `this categorizer's job — RUN IT. Launch the surface (\`drive\`/\`mobile\`), or the ` +
              `project's own run/test command, and look at what it does; collect your probes if you ` +
              `placed any. More files will not tell you what the software does. Then deliver.`
            : `NOTE: you have read ${loopReadFiles.size} distinct files this step. If the task is ` +
              `understood, deliver now (when gathering/investigating) or make the change (when editing) — ` +
              `reading more files is unlikely to change the answer. Name and read ONE specific file only if ` +
              `you still need a concrete detail from it, then finish.`;
          context.messages.push({
            role: "user",
            content: [{ type: "text", text: note }],
            timestamp: Date.now(),
          });
          stallGuard.grantGrace();
          logStore.append({
            tags: ["loop", "loop:read-completion"],
            level: "info",
            message:
              `advised the driver it has read ${loopReadFiles.size} files and should ` +
              (input.phase === "activity_reproduce" || input.phase === "activity_inspect" ? "RUN it" : "deliver or edit"),
            data: { files: loopReadFiles.size, ...(input.label ? { label: input.label } : {}) },
          });
        }
      }

      // QA read-spiral fence: the completion nudge above is advice, and a field
      // run took the advice as optional — four MORE files after it, no launch,
      // no drive, no deliver, and an 18-minute hop that ended in a derived
      // fallback. Three extra distinct files past the nudge earns one final
      // note naming the three real exits; after that, two consecutive turns
      // that neither run, drive, ask, nor deliver end the hop with the reason
      // named, so the chain's fallback deliverable says what actually happened
      // instead of the model's last dangling thought.
      // Permissive on purpose — anything that runs, drives, asks, instruments
      // or finishes counts as acting; a false positive only buys the model a
      // turn, while a false negative would kill a live investigation.
      const turnActed = turnCalls.some(
        (c) =>
          /^(?:deliver|mobile|drive|activity_|browser_|ask_user|add_log|remove_log)/.test(c.name) ||
          (c.name === "bash" &&
            typeof (c.arguments as { command?: unknown } | undefined)?.command === "string" &&
            /\b(?:run|test|serve|start|attach|curl|log|install)\b/i.test(
              (c.arguments as { command: string }).command,
            )),
      );
      if (turnActed) sawHopAction = true;
      if (qaHop && readCompletionWarned && !qaReadFenceNoted && (loopReadFiles.size >= READ_COMPLETION_THRESHOLD + 3 || windowRereads >= 4)) {
        qaReadFenceNoted = true;
        context.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                `NOTE: reading is DONE for this hop — ${loopReadFiles.size} files opened and nothing has run. ` +
                `More source will not reproduce anything. Exactly three exits exist now:\n` +
                `  1. RUN IT — \`activity_trace_start { startCommand }\` (probe first if the defect is a value ` +
                `that never arrives), then \`mobile\`/\`drive\` to the symptom, then \`activity_collect\`;\n` +
                `  2. a WALL you actually met (login/OTP/permission) — \`ask_user_question\` at it;\n` +
                `  3. \`deliver\` an honest \`reproduced: false\` with what you established.\n` +
                `Turns that only keep reading will end this hop.`,
            },
          ],
          timestamp: Date.now(),
        });
        stallGuard.grantGrace();
        logStore.append({
          tags: ["loop", "loop:qa-read-fence"],
          level: "warn",
          message: `QA hop read ${loopReadFiles.size} files without running anything; final note issued`,
          data: { files: loopReadFiles.size, ...(input.label ? { label: input.label } : {}) },
        });
      }
      if (qaHop && qaReadFenceNoted) {
        // Permissive on purpose — anything that runs, drives, asks or finishes
        // resets the spiral counter; a false positive only buys the model a
        // turn, while a false negative would kill a live investigation.
        const acted = turnCalls.some(
          (c) =>
            /^(?:deliver|mobile|drive|activity_|browser_|ask_user)/.test(c.name) ||
            (c.name === "bash" &&
              typeof (c.arguments as { command?: unknown } | undefined)?.command === "string" &&
              /\b(?:run|test|serve|start|attach|curl|log|install)\b/i.test(
                (c.arguments as { command: string }).command,
              )),
        );
        qaExplorationTurns = acted ? 0 : qaExplorationTurns + 1;
        if (turnCalls.length > 0 && qaExplorationTurns >= 2) {
          error =
            `QA_READ_SPIRAL: the hop opened ${loopReadFiles.size} files and kept reading after being told to ` +
            `run it — reading is how the READ pass works, not how a defect is reproduced`;
          logStore.append({
            tags: ["loop", "loop:qa-read-spiral"],
            level: "warn",
            message: error,
            data: { files: loopReadFiles.size, ...(input.label ? { label: input.label } : {}) },
          });
          break;
        }
      }

      // Stall detection: the loop has no step cap, so the only thing standing
      // between it and a model that cannot converge is this. A repeating or
      // wholly-failing turn is nudged first; a persistent one ends the loop with
      // a reason that names the pattern.
      const verdict = stallGuard.observe(turnCalls, turnResults);
      if (verdict.kind === "stop") {
        error = verdict.reason;
        logStore.append({
          tags: ["loop", "loop:stalled"],
          level: "warn",
          message: verdict.reason,
          ...(input.label ? { data: { label: input.label } } : {}),
        });
        break;
      }
      if (verdict.kind === "nudge") {
        context.messages.push({
          role: "user",
          content: [{ type: "text", text: verdict.note }],
          timestamp: Date.now(),
        });
      }

      // Graceful wind-down, only when a host explicitly configured a step cap:
      // inject a note so the model stops calling tools and writes its summary
      // instead of being hard-cut on the next iteration (which previously left
      // runs looking "complete" but unfinished — mid-edit, no summary). And if
      // this WAS the last step, surface a clear truncation error rather than a
      // silent success-looking end.
      if (!boundedSteps) continue;
      const remaining = maxSteps - (step + 1);
      if (remaining === 0) {
        error = `${STEP_BUDGET_EXHAUSTED} (${maxSteps} steps) before the model finished; last turn was a tool call`;
        logStore.append({
          tags: ["loop", "loop:truncated"],
          level: "warn",
          message: `loop hit maxSteps (${maxSteps}) mid-tool; ending with truncation error`,
          ...(input.label ? { data: { label: input.label } } : {}),
        });
        break;
      }
      if (remaining <= wrapUpRemaining) {
        context.messages.push({
          role: "user",
          content: [{
            type: "text",
            text: `NOTE: only ${remaining} step${remaining === 1 ? "" : "s"} remaining in this run's budget. ` +
              `Stop calling tools now (unless one is essential to finish) and reply with your summary of what you've done so far and what remains. ` +
              `Prefer a partial summary over being cut off mid-action.`,
          }],
          timestamp: Date.now(),
        });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const finalText = lastAssistant
    ? lastAssistant.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n")
    : "";

  logStore.append({
    tags: ["loop", ...(error ? ["loop:error"] : [])],
    level: error ? "error" : "info",
    message: input.label ? `end loop: ${input.label}${error ? ` error=${error}` : ""}` : `end loop${error ? ` error=${error}` : ""}`,
  });

  // Reasoning was ASKED FOR and never ARRIVED. Almost always the model: a slug
  // without the capability just returns deltas of `content`/`role` with no
  // `reasoning` field, so the bridge has nothing to turn into thinking blocks.
  // Nothing errors, nothing warns, and the host renders an empty reasoning pane
  // forever — the single most expensive silent failure in this stack, because it
  // looks identical to an emission bug. Say so, and name the model.
  if (liveReasoningLevel && liveReasoningLevel !== "off" && !sawThinkingContent && !error) {
    logStore.append({
      tags: ["loop", "reasoning"],
      level: "warn",
      message:
        `reasoning="${liveReasoningLevel}" was requested but no turn returned any thinking. ` +
        `Model "${liveModel.openRouterSlug ?? liveModel.id}" most likely has no reasoning capability ` +
        `(a proxy backend may have routed this elsewhere than the slug you set). ` +
        `Emission is a separate axis: check this BEFORE suspecting transcriptMode/emitReasoning.`,
      data: { model: liveModel.openRouterSlug ?? liveModel.id, reasoning: liveReasoningLevel },
    });
  }

  return {
    finalMessage: lastAssistant,
    messages: context.messages,
    finalText,
    usage,
    refs,
    maxComplexity,
    writtenPaths,
    instrumentedPaths,
    readPaths,
    discoveredPaths,
    pendingUserQuestion,
    ...(resolvedClarifications.length ? { resolvedClarifications } : {}),
    // Grown by any file the user handed over mid-hop, so the chain can carry the
    // run's live attachment set forward instead of re-deriving it from triage.
    ...(liveImages.length ? { liveImages } : {}),
    ...(producedPlanSet ? { planSet: producedPlanSet } : {}),
    error,
    ...(terminatedBy ? { terminatedBy } : {}),
    // The loop's final per-path complexity state (plan-task floors + tool-
    // measured ratchets). The chain threads it into later hops so difficulty
    // discovered in read reaches write_edit's permission gate.
    complexityByPath: Object.fromEntries(COMPLEXITY_BY_PATH),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Distinct files a single loop may read before the read-completion advisor tells
 * the driver to deliver or edit. Comprehension makes re-reads free, so the cost
 * that remains is opening NEW files (each pays its own rater + comprehension);
 * past this many, a driver that is still gathering is past the point of
 * diminishing returns and is nudged to wrap up. A nudge, not a stop — it may
 * still read one specific file it names.
 */
const READ_COMPLETION_THRESHOLD = 6;

const SEARCH_ADVICE_LABEL: Record<SearchAdvice["kind"], string> = {
  "memory-first": "searching the memory index before the shell",
  broaden: "a better memory query",
  "shell-fallback": "falling back to a shell search",
};

/** How each escalation rung is described in the log. */
const ADVICE_LABEL: Record<FallbackAdvice["kind"], string> = {
  fallback: "a bash fallback",
  escalate: "asking the user",
  abandon: "to stop retrying and report the blocker",
};

/**
 * Pull section blueprints out of an `inspiration_generator` result.
 *
 * Shape-checked rather than name-checked so a host that wraps or renames the
 * tool still feeds the authoring pass — the discriminator is a `sections` array
 * of objects carrying the blueprint's own `kind`/`category`.
 */
function designReferenceFromToolResult(details: unknown): unknown[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as { matched?: unknown; sections?: unknown };
  if (d.matched !== true || !Array.isArray(d.sections) || d.sections.length === 0) return undefined;
  const usable = d.sections.filter(
    (s) => s && typeof s === "object" && typeof (s as { kind?: unknown }).kind === "string",
  );
  return usable.length ? usable : undefined;
}

/**
 * Lift informational text out of a `media_analysis` tool result so it reaches
 * the authoring pass. Only an `informational` triage qualifies — a
 * `ui-replicate`/`ui-bug` image travels as pixels via `images`/`ctx.images`,
 * not as text, so returning those here would duplicate the reference in the
 * wrong channel. Prefers the structured `ocr.text` field (the ocr lens), then
 * falls back to `analysis` for any other informational attachment.
 */
/**
 * Files the user attached to an `ask_user_question` answer.
 *
 * Read off the tool's `details.answerAttachments` rather than parsed out of its
 * text: the paths have already been normalized to absolute and mime-typed by the
 * tool, and a regex over prose would be one rename away from silently returning
 * nothing.
 */
function answerAttachmentsFromToolResult(
  details: unknown,
): Array<{ path: string; mimeType: string }> {
  if (!details || typeof details !== "object") return [];
  const d = details as { kind?: unknown; answerAttachments?: unknown };
  if (d.kind !== "ask_user_question" || !Array.isArray(d.answerAttachments)) return [];
  const out: Array<{ path: string; mimeType: string }> = [];
  for (const entry of d.answerAttachments) {
    if (!entry || typeof entry !== "object") continue;
    const { path: p, mimeType } = entry as { path?: unknown; mimeType?: unknown };
    if (typeof p === "string" && p.trim() && typeof mimeType === "string" && mimeType) {
      out.push({ path: p, mimeType });
    }
  }
  return out;
}

/**
 * Lift the Q&A out of an ANSWERED `ask_user_question` result so it reaches the
 * authoring model.
 *
 * The driver sees the answer in its own conversation, but the model that authors
 * the bytes does not — and under `authorOnlyWrites` the driver has no field in
 * which to express it, so the write/edit is authored toward the run-level goal
 * instead. This is the channel that closes that gap.
 *
 * Only a RESOLVED question qualifies: `details.answered === true` distinguishes
 * a blocking question the host just answered from an OUTSTANDING one (which also
 * carries `details`, but would otherwise seed intent for a question that has no
 * answer yet). The question comes off `details.question`; the answer is parsed
 * from the tool result's text, because `details.answerAttachments` carries files
 * only, not the answer text.
 */
/**
 * The same resolved Q&A as {@link clarificationFromToolResult}, structured, plus
 * whatever the user attached to the answer.
 *
 * The string form seeds the authoring model inside this hop; this form is what
 * survives the hop, so it keeps the question and answer as separate fields
 * rather than one pre-rendered sentence — a later hop needs to compare the
 * question it is about to ask against the one already answered.
 */
/** One resolved Q&A as a line of prompt text. */
export function renderClarification(entry: ResolvedClarification): string {
  const files = entry.attachments?.length
    ? ` files the user attached: ${entry.attachments.map((file) => file.path).join(", ")}`
    : "";
  return `Clarification — question: ${entry.question} answer: ${entry.answer}${files}`;
}

export function resolvedClarificationFromToolResult(
  details: unknown,
  content: unknown,
): ResolvedClarification | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as { kind?: unknown; answered?: unknown; question?: unknown; reason?: unknown };
  if (d.kind !== "ask_user_question" || d.answered !== true) return undefined;
  const question = typeof d.question === "string" ? d.question.trim() : "";
  if (!question) return undefined;
  const text = textFromToolResult(content).replace(/\n+/g, " ");
  const answer = text.match(/User answered:\s*(.+?)\s*(?:\(clarification for:|$)/)?.[1]?.trim();
  const attachments = answerAttachmentsFromToolResult(details);
  // An answer that is files ONLY is still an answer — the user handed over the
  // mockup instead of describing it. Keep it rather than dropping the record.
  if ((!answer || answer === "(empty)") && attachments.length === 0) return undefined;
  return {
    question,
    answer: !answer || answer === "(empty)" ? "(files only — see attachments)" : answer,
    ...(typeof d.reason === "string" && d.reason.trim() ? { reason: d.reason.trim() } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

export function clarificationFromToolResult(
  details: unknown,
  content: unknown,
): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as { kind?: unknown; answered?: unknown; question?: unknown };
  if (d.kind !== "ask_user_question" || d.answered !== true) return undefined;
  const question = typeof d.question === "string" ? d.question.trim() : "";
  // The tool renders the answer as `User answered: <text>` (see ask-user-question.ts).
  // Parse it off the result's text blocks rather than a structured field, since the
  // tool emits no such field — only files are structured, and an answer can be text
  // alone. A non-matching shape (e.g. files-only) yields no text and is skipped.
  // The text is newline-collapsed before matching: a free-text answer can span
  // several lines, and a `.`/`$`-anchored match would otherwise drop everything
  // after the first newline. `(empty)` is the tool's empty-answer rendering and is
  // not a real answer, so it is excluded.
  const text = textFromToolResult(content).replace(/\n+/g, " ");
  const answerMatch = text.match(/User answered:\s*(.+?)\s*(?:\(clarification for:|$)/);
  const answer = answerMatch?.[1]?.trim();
  if (!answer || answer === "(empty)") return undefined;
  return question
    ? `Clarification — question: ${question} answer: ${answer}`
    : `Clarification — answer: ${answer}`;
}

/** Join the text blocks of a tool result's content into a single string. */
export function textFromToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function mediaFactFromToolResult(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as { category?: unknown; ocr?: unknown; analysis?: unknown };
  if (d.category !== "informational") return undefined;
  const ocrText = (d.ocr as { text?: unknown } | undefined)?.text;
  if (typeof ocrText === "string" && ocrText.trim()) return ocrText.trim();
  if (typeof d.analysis === "string" && d.analysis.trim()) return d.analysis.trim();
  return undefined;
}

function toToolDefs(tools: AgentTool[]): Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
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

/** Consume a pi stream into a final AssistantMessage, re-emitting message_update. */
async function streamToMessage(
  llm: LLMBridge,
  model: Model,
  context: Context,
  emit: (e: AgentEvent) => void,
  opts: {
    temperature?: number;
    reasoning?: import("../types.js").ThinkingLevel;
    signal?: AbortSignal;
    emitText: boolean;
    emitReasoning: boolean;
  },
): Promise<AssistantMessage> {
  let final: AssistantMessage | undefined;
  let started = false;
  const { emitText, emitReasoning, ...streamOpts } = opts;
  for await (const ev of llm.stream(model, context, streamOpts)) {
    if (ev.type === "start" && !started) {
      started = true;
      emitAssistantLifecycle({ emit, message: ev.partial, emitText, emitReasoning, kind: "start" });
    }
    if ("partial" in ev) {
      emitAssistantLifecycle({ emit, message: ev.partial, assistantMessageEvent: ev, emitText, emitReasoning, kind: "update" });
    }
    if (ev.type === "done") {
      final = ev.message;
      emitAssistantLifecycle({ emit, message: ev.message, emitText, emitReasoning, kind: "end" });
    } else if (ev.type === "error") {
      final = ev.error;
      emitAssistantLifecycle({ emit, message: ev.error, emitText, emitReasoning, kind: "end" });
    }
  }
  if (!final) throw new Error("stream produced no final message");
  return final;
}

function filterAssistantContentForEmission(
  message: AssistantMessage,
  emitText: boolean,
  emitReasoning: boolean,
): AssistantMessage {
  if (emitText && emitReasoning) return message;
  return {
    ...message,
    content: message.content.filter((entry) => {
      if (entry.type === "text") return emitText;
      if (entry.type === "thinking") return emitReasoning;
      return true;
    }),
  };
}

function shouldForwardUpdateEvent(
  event: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"] | undefined,
  emitText: boolean,
  emitReasoning: boolean,
): boolean {
  switch (event?.type) {
    case "text_start":
    case "text_delta":
    case "text_end":
      return emitText;
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      return emitReasoning;
    default:
      return true;
  }
}

function emitAssistantLifecycle(input: {
  emit: (e: AgentEvent) => void;
  message: AssistantMessage;
  assistantMessageEvent?: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"];
  emitText: boolean;
  emitReasoning: boolean;
  kind: "start" | "update" | "end";
}) {
  const eventType = input.kind === "start" ? "message_start" : input.kind === "update" ? "message_update" : "message_end";
  if (input.kind === "update" && !shouldForwardUpdateEvent(input.assistantMessageEvent, input.emitText, input.emitReasoning)) {
    return;
  }
  input.emit({
    type: eventType,
    message: filterAssistantContentForEmission(input.message, input.emitText, input.emitReasoning),
    ...(input.kind === "update" && input.assistantMessageEvent ? { assistantMessageEvent: input.assistantMessageEvent } : {}),
  } as AgentEvent);
}

/** Where tool-returned screenshots are persisted so the model can reference them. */
const TOOL_SCREENSHOT_DIR = path.join(".turing", "screenshots");

function mediaMimeToExt(mimeType: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mp4") || m.includes("video")) return ".mp4";
  if (m.includes("mov")) return ".mov";
  if (m.includes("mp3") || m.includes("mpeg")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("flac")) return ".flac";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("json")) return ".json";
  return "";
}

/**
 * Persist inlined (base64) audio/video/file blocks to disk and replace `data`
 * with a `uri` path, so non-image media travels through history as a PATH
 * reference instead of megabytes of base64. The same problem screenshots had —
 * base64 bloating the request and tripping compaction — applies to audio and
 * video too; a tool that returns either as bytes would otherwise inflate every
 * subsequent turn. Images are handled separately (re-surfaced for the current
 * turn, then pruned); this covers the rest. Mutates `content` in place;
 * best-effort (a write failure leaves the block as-is rather than dropping it).
 */
async function materializeInlinedMedia(
  content: unknown | undefined,
  toolName: string,
  callId: string,
  cwd: string,
): Promise<void> {
  if (!Array.isArray(content)) return;
  // Find the blocks that actually need materialising BEFORE touching the
  // filesystem — a plain-text result has none, and creating `.turing/media` for
  // it would litter the working directory (and break callers that count files).
  const targets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (!b || typeof b !== "object") continue;
    const t = (b as { type?: string }).type;
    if (t !== "audio" && t !== "video" && t !== "file") continue;
    const data = (b as { data?: unknown }).data;
    if (typeof data === "string" && data) targets.push(i);
  }
  if (!targets.length) return; // nothing inlined → leave the cwd untouched
  const dir = path.join(cwd, ".turing", "media");
  const safeName = `${toolName}_${callId}`.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
  const stamp = Date.now();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return;
  }
  let n = 0;
  for (const i of targets) {
    const b = content[i] as { type?: string; data?: string; mimeType?: string };
    const t = b.type!;
    const mimeType = b.mimeType ?? "application/octet-stream";
    const file = path.join(dir, `${safeName}-${stamp}-${n}${mediaMimeToExt(mimeType)}`);
    try {
      await fs.writeFile(file, Buffer.from(b.data!, "base64"));
      content[i] = { type: t, uri: file, mimeType };
      n++;
    } catch {
      // leave the block as-is.
    }
  }
}

/**
 * Persist each tool-returned image to a file under `.turing/screenshots/` and
 * return the paths. This exists for two coupled reasons:
 *
 *  - The model needs a PATH it can hand to `media_analysis` later. Without it, a
 *    run takes a screenshot, then calls `media_analysis` expecting it to analyze
 *    "the screenshot" — but media_analysis needs an explicit `file`/`url`, and
 *    the screenshot existed only as base64 in a prior message. Persisting + naming
 *    the path gives the model something concrete to pass.
 *
 *  - The history need not carry the base64 forever. The path is recorded as text
 *    alongside the image (see {@link buildToolMediaMessage}); once the image block
 *    is pruned, the path text survives, so the model can re-read or re-analyze the
 *    capture by path instead of the run re-sending megabytes each turn.
 *
 * Best-effort: a write failure skips that image (the base64 still reaches the
 * model for the current turn). Returns the paths that DID save.
 */
async function persistToolImages(
  images: ImageContent[],
  toolName: string,
  callId: string,
  cwd: string,
): Promise<SavedImage[]> {
  const dir = path.join(cwd, TOOL_SCREENSHOT_DIR);
  const safeName = `${toolName}_${callId}`.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
  const stamp = Date.now();
  const saved: SavedImage[] = [];
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return saved;
  }
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    // The extension is what media_analysis infers the modality from, and a
    // mime-less block (some capture sources omit it) would otherwise save extension-less.
    const sniffed = sniffImageFormat(img.data, img.mimeType ?? "");
    const mime = img.mimeType ?? (sniffed === "jpeg" ? "image/jpeg" : sniffed === "webp" ? "image/webp" : sniffed === "png" ? "image/png" : "");
    const file = path.join(dir, `${safeName}-${stamp}-${i}${mediaMimeToExt(mime)}`);
    try {
      await fs.writeFile(file, Buffer.from(img.data, "base64"));
      const dims = imagePixelDimensions(img.data, img.mimeType ?? "");
      saved.push({ path: file, ...(dims ?? {}) });
    } catch {
      // skip; the base64 still reaches the model this turn.
    }
  }
  return saved;
}

export { imagePixelDimensions } from "../image-dims.js";
import { imagePixelDimensions, sniffImageFormat } from "../image-dims.js";
import { downscaleForEmbed } from "../image-embed.js";

/** A persisted capture: its path and, when readable, its pixel dimensions. */
interface SavedImage {
  path: string;
  width?: number;
  height?: number;
}

/** Suffix naming the saved paths so the model can pass them to media_analysis. */
function savedPathsNote(saved: SavedImage[], toolName: string): string {
  if (!saved.length) return "";
  const list =
    saved.length === 1
      ? formatSaved(saved[0]!)
      : saved.map((s, i) => `(${i + 1}) ${formatSaved(s)}`).join("  ");
  let note = ` Saved to: ${list}. Pass any one as \`file:\` to \`media_analysis\` to analyze it.`;
  // A DEVICE capture is the one place image pixels and screen points diverge,
  // and by arbitrary, call-to-call-inconsistent ratios. Name the conversion so
  // the model never has to invent (or `sips`) one.
  if (/mobile|device|simctl|adb/i.test(toolName) && saved.some((s) => s.width)) {
    note +=
      " IMAGE px ≠ SCREEN points: any position an analysis reports for this image is in IMAGE pixels — " +
      "convert before tapping: logical = image_px × (screen ÷ image) per axis, with the screen's logical " +
      "size from `mobile_get_screen_size`.";
  }
  return note;
}

function formatSaved(s: SavedImage): string {
  return s.width && s.height ? `${s.path} (${s.width}×${s.height} px)` : s.path;
}

/**
 * Turn a tool's image output into a message the run's model can actually use.
 *
 * Three outcomes, in order of preference:
 *   1. The model reads images  -> pass them through untouched.
 *   2. It doesn't, but a vision model is configured -> describe them and pass
 *      the description as text. The run keeps its sight, second-hand.
 *   3. Neither -> a short note, so the model at least knows an image existed
 *      rather than silently reasoning about a page it was never shown.
 *
 * When `savedPaths` is set, each outcome names the persisted file path(es) so the
 * model can hand them to `media_analysis`. That text is a SIBLING of the image
 * block, so it survives {@link pruneHistoricalImages} — the model keeps the path
 * even after the base64 is pruned from history.
 *
 * Never throws: a failed description degrades to (3). Losing the picture is
 * survivable; losing the run is not.
 */
async function buildToolMediaMessage(input: {
  toolName: string;
  images: ImageContent[];
  model: Model;
  llm: LLMBridge;
  visionModel?: string;
  savedPaths?: SavedImage[];
  log: (message: string, data?: Record<string, unknown>) => void;
}): Promise<Message> {
  const { toolName, images, model, llm, visionModel, log } = input;
  const note = savedPathsNote(input.savedPaths ?? [], input.toolName);
  const modelReadsImages = !model.input || model.input.length === 0 || model.input.includes("image");

  if (modelReadsImages) {
    return {
      role: "user",
      content: [{ type: "text", text: `Image output from ${toolName}:${note}` }, ...images],
      timestamp: Date.now(),
    };
  }

  if (visionModel) {
    try {
      const vision = llm.resolveModel(visionModel);
      const described = await llm.complete(
        vision,
        {
          systemPrompt:
            "You are describing an image for another model that cannot see it. " +
            "Be concrete and complete: layout, visible text (verbatim), controls, " +
            "state, and anything that looks broken. No preamble, no speculation.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Describe this output from the \`${toolName}\` tool so another model can act on it.`,
                },
                ...images,
              ],
              timestamp: Date.now(),
            },
          ],
          tools: [],
        },
        { reasoning: "off" },
      );
      const text = described.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n")
        .trim();
      if (text) {
        log(`described ${toolName} image output with ${visionModel}`, {
          toolName,
          visionModel,
          images: images.length,
          chars: text.length,
        });
        return {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Image output from ${toolName} (described by ${visionModel}, ` +
                `because ${model.id} cannot read images):\n\n${text}${note}`,
            },
          ],
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      log(`vision description failed for ${toolName}; falling back to a note`, {
        toolName,
        visionModel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `${toolName} returned ${images.length} image(s), but ${model.id} cannot read images ` +
          `and no vision model is configured. Continue without them, or use a tool that returns text.${note}`,
      },
    ],
    timestamp: Date.now(),
  };
}

function missingRequiredArgs(tool: AgentTool, args: Record<string, unknown> | undefined): string[] {
  const required = tool.parameters?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const a = args ?? {};
  const missing: string[] = [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    const v = (a as Record<string, unknown>)[key];
    // A required argument is "missing" only when it is genuinely ABSENT
    // (undefined/null). An empty string is a legitimate, intentional value —
    // `edit`'s `newString: ""` is a deletion, and replacement/override fields
    // can validly be empty — so it must not be rejected here. Empty arrays are
    // the same: a tool may legitimately receive `[]`. Each tool's own `execute`
    // already validates its fields with a field-specific message (e.g.
    // "oldString not found in <file>", "bash: missing required argument
    // 'command'"), so dropping the empty-value rule here loses no real
    // protection — it only stops this generic gate from blocking valid calls.
    if (v === undefined || v === null) missing.push(key);
  }
  return missing;
}

function canonicalArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  try {
    const keys = Object.keys(args).sort();
    return JSON.stringify(args, keys);
  } catch {
    return "";
  }
}

/**
 * Cache key for a read-only tool call.
 *
 * `path` is resolved to an absolute path first, so the same file reached
 * relatively and absolutely collapses to one entry; every other argument is
 * canonicalised as-is, so `offset`/`limit`/`pattern` still distinguish genuinely
 * different calls.
 */
function readCacheKey(cwd: string, name: string, args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return `${name}:`;
  const argPath = (args as { path?: unknown }).path;
  const normalised =
    typeof argPath === "string" && argPath.trim()
      ? { ...args, path: normalizeToolPath(cwd, argPath) }
      : args;
  return `${name}:${canonicalArgs(normalised)}`;
}

/**
 * Drop the cached reads that a write to `absPath` invalidated — that path only.
 *
 * Entries are keyed by tool + canonical args, so the path is matched against the
 * normalised form embedded in the key. A directory listing (`ls`) is dropped too
 * when the write was inside it, since its contents may now differ.
 */
function invalidateReadCache(cache: Map<string, string>, cwd: string, absPath: string): void {
  const target = normalizeToolPath(cwd, absPath);
  const parent = path.dirname(target);
  for (const key of [...cache.keys()]) {
    if (key.includes(target) || key.includes(parent)) cache.delete(key);
  }
}

/**
 * Ceiling on the text of ONE tool result as it enters the conversation.
 *
 * ~24k characters is roughly 6k tokens — big enough for a long file or a wide
 * search, small enough that a runaway result cannot end the run.
 */
const MAX_TOOL_RESULT_CHARS = 24_000;

/**
 * Activity-monitor probe markers. A write/edit whose content or diff matches
 * this likely inserted `__t()` instrumentation that must be stripped before the
 * run completes (the model places the snippet the tool hands back; see
 * `activity_trace_start`). Anchored on the function name and the trace-id
 * constant names every supported language emits, so it is stable across the
 * TS/JS/Python/Go/Rust/Dart variants. False positives (a model that names a
 * helper `__t` on its own) are vanishingly rare and only cost one extra verify
 * round that finds nothing to strip.
 */

/** Floor for the retry-shrunk compaction threshold — below this there is no run left. */
const MIN_COMPACT_THRESHOLD = 40_000;

/**
 * Does this stream error mean "the request was too big", as opposed to something
 * a retry cannot fix?
 *
 * Providers spell it several ways and at two layers: HTTP 413 with "request
 * entity too large" (the body was rejected before the model saw it) and the
 * model's own context-window complaint ("maximum context length", "too many
 * tokens"). Both have the same remedy — send less — and neither is worth losing
 * a run over. Deliberately narrow: a 400 for a malformed tool call, a 401, a
 * 429 or a provider outage are NOT this, and retrying them with a smaller
 * history would just burn the budget more slowly.
 */
export function isOversizedRequestError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (/\b413\b/.test(m)) return true;
  return (
    /request entity too large|payload too large|body (?:is )?too large|too large to process/.test(m) ||
    /(?:maximum|max)\s+context\s+length|context[_ ]length[_ ]exceeded|context window (?:is )?(?:too small|exceeded)/.test(m) ||
    /too many (?:input )?tokens|prompt is too long|input is too long/.test(m)
  );
}

/**
 * Bound one tool result before it becomes a message.
 *
 * This is the general safety net, and it exists because the specific guards
 * cannot be complete: a single `grep` with no `path` recursed a whole repo
 * (node_modules included) and returned 11.3 MB, which was appended verbatim and
 * made the NEXT request 413 Payload Too Large. The run died with ten successful
 * tool calls, no stall and no cap — just one result nobody bounded.
 *
 * It has to live here rather than in each tool, because the tools that can do
 * this are not only ours: any MCP server the user connects can return anything,
 * and the loop is the last place that sees every result.
 *
 * The middle is dropped rather than the tail: the head carries what the result
 * IS (the first matches, the opening of a file) and the tail often carries the
 * conclusion (a summary line, the final error), while the bulk in between is
 * what makes it unmanageable. The notice is explicit so the model narrows its
 * next call instead of assuming it saw everything.
 */
function boundToolResultText(text: string, toolName: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const keep = Math.floor(MAX_TOOL_RESULT_CHARS / 2) - 200;
  const dropped = text.length - keep * 2;
  return (
    `${text.slice(0, keep)}\n\n` +
    `… [${toolName}: ${dropped.toLocaleString("en-US")} characters omitted from the middle of this result — ` +
    `it exceeded the ${MAX_TOOL_RESULT_CHARS.toLocaleString("en-US")}-character limit. You are NOT seeing the whole ` +
    `output. Narrow the call (a specific path, a tighter pattern, a glob, fewer lines) rather than assuming this ` +
    `is everything.] …\n\n${text.slice(-keep)}`
  );
}

/**
 * Apply {@link boundToolResultText} to every text block of a result.
 *
 * Non-text blocks (images, refs) pass through untouched — they are already
 * bounded by their own tools and are not what blows a request up.
 */
function boundResultContent<T extends { type: string; text?: string }>(content: T[], toolName: string): T[] {
  return content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? ({ ...block, text: boundToolResultText(block.text, toolName) } as T)
      : block,
  );
}

function makeToolResult(id: string, name: string, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: boundToolResultText(text, name) }],
    isError,
    timestamp: Date.now(),
  };
}

function toolExecutionEventResult(result: ToolResultMessage): unknown {
  if (result.details !== undefined) return { content: result.content, details: result.details };
  return result.content;
}

function refFromToolResult(msg: ToolResultMessage): MediaRef | undefined {
  const d = msg.details as { uri?: string; mimeType?: string; size?: number; summary?: string } | undefined;
  if (d && typeof d.uri === "string" && typeof d.mimeType === "string") {
    return { id: msg.toolCallId, uri: d.uri, mimeType: d.mimeType, size: d.size, summary: d.summary };
  }
  return undefined;
}

/**
 * Recognize a `create_plan` result. Keyed on the `kind` discriminator rather than
 * the tool name so any host-registered planner can produce a plan the loop picks
 * up, as long as it uses the same result shape.
 */
function planSetFromToolResult(details: unknown): import("../types.js").PlanSet | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (record.kind !== "plan_set") return undefined;
  const planSet = record.planSet as import("../types.js").PlanSet | undefined;
  // An empty plan (a cancelled or failed draft) must not be mistaken for a plan
  // to execute — the run should fall through to planless work instead.
  if (!planSet || !Array.isArray(planSet.plans) || planSet.plans.length === 0) return undefined;
  return planSet;
}

function askUserQuestionRequestFromResult(details: unknown): AskUserQuestionRequest | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (record.kind !== "ask_user_question") return undefined;
  // An ANSWERED question is not a pending one. The tool emits details on both
  // paths — the answered path carries the user's files so they can be threaded
  // into the run — and without this guard a question the host just answered
  // would stop the run as though it were still waiting for one.
  if (record.answered === true) return undefined;
  if (typeof record.question !== "string" || record.question.trim().length === 0) return undefined;
  const options = Array.isArray(record.options)
    ? record.options.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const answerMode =
    record.answerMode === "text" || record.answerMode === "single-select" || record.answerMode === "multi-select"
      ? record.answerMode
      : undefined;
  return {
    phase: "plan",
    question: record.question.trim(),
    ...(typeof record.reason === "string" && record.reason.trim().length > 0 ? { reason: record.reason.trim() } : {}),
    ...(typeof record.placeholder === "string" && record.placeholder.trim().length > 0 ? { placeholder: record.placeholder.trim() } : {}),
    ...(answerMode ? { answerMode } : {}),
    ...(options?.length ? { options } : {}),
  };
}

function normalizeToolPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
}

/**
 * Whether a call is allowed to self-declare its complexity/category.
 *
 * Restricted to the mutating file tools, which are the only ones whose arguments
 * carry both the target and the code. Accepting the fields from any tool would let
 * an arbitrary MCP tool's unrelated `complexity` argument silently steer routing.
 */
function canDeclareComplexity(name: string, mutates: boolean): boolean {
  return mutates && (name === "write" || name === "edit");
}


function buildAuthoringSnippets(input: ToolLoopInput): { fileSnippets?: Array<{ path: string; content: string }> } {
  const MAX = 12000;
  const fileSnippets: Array<{ path: string; content: string }> = [];
  let totalChars = 0;
  const push = (file: ReadFileContent, label?: string) => {
    if (!file?.path || !file?.content) return;
    if (totalChars >= MAX) return;
    const remaining = MAX - totalChars;
    const raw = file.content.length > remaining ? file.content.slice(0, remaining) : file.content;
    // Handoff extracts are labeled so the authoring model never mistakes a
    // prior pass's extract for the file itself; verbatim attached files need
    // no label.
    const content = label ? `${label}\n${raw}` : raw;
    fileSnippets.push({ path: file.path, content });
    totalChars += content.length;
  };
  for (const file of [...(input.attachedFileContents ?? []), ...(input.attachedContextFiles ?? [])]) {
    push(file);
  }
  for (const file of input.handoffSnippets ?? []) {
    push(file, "[task-relevant lines extracted by the read pass — NOT the full file]");
  }
  return fileSnippets.length ? { fileSnippets } : {};
}

/**
 * File extensions whose content is a rendered interface, not plain logic — the
 * set the fallback synthesizer fires on. Mirrors `UI_EXTENSIONS` in
 * `coding.ts:1073` plus `.svg` (kept local to avoid an orchestrator→tool import
 * for a private constant). A `.tsx` that is pure logic still triggers, but a
 * false positive there only spends a synthesis call the authoring model can
 * ignore; a false negative on a real UI file leaves it blind.
 */
const UI_OR_SVG_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".html", ".htm", ".svg",
]);

function isUiOrSvgPath(file: string): boolean {
  return UI_OR_SVG_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Resolve a model for the design skill (rung 3 of reference sourcing).
 *
 * The skill does not consume an image — it designs from the brief — so it does
 * not need a vision-capable model the way the removed image synthesis did. It
 * does need a model strong enough to design a coherent layout, so the
 * precedence mirrors the authoring path: an explicit host decision wins, then
 * the routed write model, then the loop model. Returns `undefined` when nothing
 * resolves, in which case the gate's guard skips the skill and the run proceeds
 * with no reference (today's no-match behavior).
 */
function resolveAuthorModelForSkill(input: {
  decision: { authorModel?: string };
  routedAuthorSlug?: string;
  loop: ToolLoopInput;
}): Model | undefined {
  const { decision, routedAuthorSlug, loop } = input;
  const slug = decision.authorModel ?? routedAuthorSlug ?? loop.model?.openRouterSlug ?? loop.model?.id;
  if (slug) return loop.llm.resolveModel(slug);
  return loop.model;
}

/**
 * Derive `inspiration_generator` lookup args from the task + path.
 *
 * The auto-invoked call has no model in the loop to choose keywords, so this
 * does the cheap version: tokenize the task into lowercase tags, infer `kind`
 * from the extension, default the sections to a full page, and ask for
 * `scope:"page"` so the result is coherent. The tool's own normalization handles
 * dedupe and case; we just produce a reasonable query. An empty task still
 * yields the default sections/kind, which lets the backend pick.
 */
function inspirationArgsFromBrief(
  task: string | undefined,
  argPath: string,
): Record<string, unknown> {
  const keywords = (task ?? "")
    .toLowerCase()
    // Keep words of 4+ chars as tags; shorter words add noise. Style/domain
    // terms (glassmorphism, ecommerce) are what the backend scores on.
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
    .slice(0, 12);
  const ext = path.extname(argPath).toLowerCase();
  const kind = ext === ".svg" ? "poster" : "web-ui";
  return {
    ...(keywords.length ? { keywords } : { keywords: ["ui", "landing"] }),
    kind,
    scope: "page",
    sections: ["navigation", "hero", "section", "footer"],
  };
}

/** Minimal abort error without depending on DOM lib types. */
class DOMExceptionLike extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AbortError";
  }
}

// Silence the unused-import linter for Complexity (re-exported for callers).
export type { Complexity };

// ---------------------------------------------------------------------------
// Unknown-tool coaching for QA-surface names
// ---------------------------------------------------------------------------

/**
 * Names a model reaches for when it wants to SEE or DRIVE running software —
 * the vocabulary of browser/device automation, whether or not such tools are
 * registered in this loop.
 */
const QA_SURFACE_NAME_RE = /^(browser_|playwright|chrome_|devtools_|puppeteer_|selenium_|mobile_|device_|simulator_|take_screenshot|screenshot$)/i;

/**
 * When a model reaches for a QA-surface tool that this loop does not hold, the
 * bare "Unknown tool" list is not enough — from a field run: after a successful
 * edit, the write pass tried `bash({})`, then `playwright(...)`, then
 * `browser_navigate(...)`, three failed turns, and the stall guard killed the
 * run before the chain could hand the verification to the pass that DOES hold
 * the browser. Two directions of coaching:
 *
 *  - a WORK pass holding no automation tools: the capability is real, it just
 *    belongs to the NEXT pass — finish with `deliver` and the chain routes it;
 *  - a QA pass holding `drive` but not raw `browser_*`: same intent, right
 *    pass, wrong spelling — name the one-call form.
 */
function surfaceMismatchNote(requested: string, phase: string | undefined, hasDrive: boolean): string {
  if (!QA_SURFACE_NAME_RE.test(requested)) return "";
  const isQa = phase === "activity_inspect" || phase === "activity_reproduce";
  if (isQa && hasDrive) {
    return (
      "\n\nThis pass drives the browser through `drive`, not raw browser tools — one call per step: " +
      '`drive {action:"open", url:"…"}` to navigate, `drive {action:"look"}` to see the page ' +
      '(screenshot + elements), `drive {action:"click", target:"Sign in"}` to act by description.'
    );
  }
  if (!isQa) {
    return (
      "\n\nYou are reaching for browser/device automation, which this pass does not hold ON PURPOSE: " +
      "verifying running software is the NEXT pass's job (activity_inspect). Finish THIS pass — make the " +
      "change and `deliver` — and the chain will route verification with the right tools. Retrying " +
      "automation names here will only fail again."
    );
  }
  return "";
}
