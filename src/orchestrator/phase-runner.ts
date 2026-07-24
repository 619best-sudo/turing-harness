/**
 * Phase runner: executes a single 4P phase as an LLM-driven tool loop.
 *
 * Design invariant (req #7): the orchestrator/runner never reasons over file
 * contents and never writes/edits code itself. It only:
 *   - drives the loop,
 *   - routes each tool call through the permission gate,
 *   - selects the model for the call,
 *   - shuttles messages between the phase model and the tools.
 * All reasoning is done by the phase model; all IO/mutation is done by tools.
 */
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AssistantMessage,
  ComplexityRating,
  Context,
  FileMemoryUpdate,
  LLMBridge,
  MediaRef,
  Message,
  Model,
  Phase,
  PhaseDisplayArtifact,
  PhaseHandoff,
  PlanDocument,
  PlanFileMutationMode,
  PlanSet,
  PlanTask,
  PhaseResult,
  PrepareBlastRadiusSummary,
  PrepareProviderAssignmentMap,
  QaCheck,
  QaPlan,
  ReadFileContent,
  PrepareRelevantFile,
  PrepareToolTranscriptEntry,
  RegisteredProviderSummary,
  ThreadFollowUpContext,
  ToolChainEntry,
  TranscriptMode,
  ThinkingLevel,
  Tool,
  ToolContext,
  ToolResultMessage,
  ToolSnippet,
  Usage,
} from "../types.js";
import { emptyUsage, ratingToScore, scoreToRating } from "../types.js";
import type { LogStore } from "../logging/logger.js";
import type { Registry } from "../registry/registry.js";
import { PermissionGate } from "./permission.js";
import { estimateComplexity, selectModel } from "../llm/model-selector.js";
import { PHASE_PROMPTS } from "../phases/prompts.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PhaseRunInput {
  phase: Phase;
  task: string;
  /** Summaries from earlier phases (carried by reference, not full transcripts). */
  priorSummaries?: Array<{ phase: Phase; summary: string }>;
  /** Media refs available to this phase (address + summary, not bytes). */
  priorRefs?: MediaRef[];
  /** Paths the previous phases confirmed exist (resolved absolute addresses).
   *  Surfaced as "CONFIRMED PATHS" in the opening so the model doesn't have to
   *  guess from prose. */
  priorDiscoveredPaths?: string[];
  /** Files the previous phases SUCCESSFULLY read. Surfaced as "FILES ALREADY
   *  READ" so Plan/Perform don't re-read what earlier phases already inspected. */
  priorReadPaths?: string[];
  /** Last 1-2 successful tool outputs (truncated) from the previous phase. */
  priorToolSnippets?: ToolSnippet[];
  /** Structured relevant-file shortlist established by Prepare. */
  priorRelevantFiles?: PrepareRelevantFile[];
  /** Compact successful Prepare tool transcript. */
  priorToolTranscript?: PrepareToolTranscriptEntry[];
  /** Structured PLAN_JSON handoff from Plan to Perform. */
  priorPlanJson?: unknown[];
  /** Exact file allowlist Perform may modify/read from the executable plan. */
  allowedWorkPaths?: string[];
  /** Planned mutation mode per absolute work file path. */
  plannedFileMutations?: Record<string, PlanFileMutationMode>;
  /** Full file contents attached from the previous phase for direct reuse until
   *  Perform mutates that file, after which reads must come from disk again. */
  attachedFileContents?: ReadFileContent[];
  /** Read-only supporting files attached from Plan for implementation context. */
  attachedContextFiles?: ReadFileContent[];
  /** Files this phase has already written/edited in the current chain
   *  (Prepare/Plan/Perform iterations). Surfaced as "ALREADY WRITTEN" so
   *  retries don't re-write the same file or re-verify it from scratch. */
  priorWrittenPaths?: string[];
  /** Project profile from Prepare (type/stack + how to run & verify). Surfaced as
   *  "PROJECT PROFILE" so every later phase uses the right run/verify commands. */
  priorProjectProfile?: string;
  /** Structured run/stop/verify guidance Prepare established. */
  priorProjectRunbook?: {
    run?: string;
    stop?: string;
    verify?: string;
  };
  /** MCP/skills/tools Prepare found relevant. Surfaced as "CAPABILITIES" so later
   *  phases prefer them. */
  priorCapabilities?: string;
  /** Structured provider assignments Prepare selected for downstream phases. */
  priorProviderAssignments?: PrepareProviderAssignmentMap;
  /** Exact file allowlist this phase may read from the Prepare handoff. */
  allowedReadPaths?: string[];
  /** Per-path complexity ratings inherited from earlier phases (Prepare's per-file
   *  rating, Plan's per-task rating). When a tool call targets one of these paths,
   *  the runner biases the call's complexity by the inherited rating and marks the
   *  permission request's complexitySource accordingly. */
  complexityByPath?: Record<string, ComplexityRating>;
  /** Where the inherited per-path complexity came from (prepare-file / plan-task). */
  complexitySource?: "prepare-file" | "plan-task";
  /** Optional label naming which plan (of several) this Perform run is executing. */
  planLabel?: string;
  /** Metadata-only registered provider list shown to Prepare. */
  availableProviders?: RegisteredProviderSummary[];
  /** User-requested changes that a regenerated PLAN must address. */
  planReviewFeedback?: string;
  /** Feedback from a failed Perfect verification, injected when re-running Perform. */
  feedback?: string;
  /** Structured thread context from the previous completed run in the same session. */
  followUpContext?: ThreadFollowUpContext;
  /** The phase (orchestrator) model driving the loop. */
  model: Model;
  /** Executable tools scoped to this phase. */
  tools: AgentTool[];
  llm: LLMBridge;
  permission: PermissionGate;
  registry?: Registry;
  logStore: LogStore;
  emit: (e: AgentEvent) => void;
  cwd: string;
  signal?: AbortSignal;
  maxSteps?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
  /** Candidate model slugs the permission layer may pick from for tool calls. */
  toolModelCandidates?: string[];
  /**
   * Optional host callback for `ask_user_question`. When provided, the tool
   * blocks in-place for the user's answer and the LLM continues in the SAME
   * conversation. When absent, the tool falls back to surfacing the question
   * via its `details` payload for a non-blocking host.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
  transcriptMode?: TranscriptMode;
  /** When `false`, the phase model's reasoning/thinking is NOT emitted to the UI
   *  stream (thinking blocks are stripped and thinking_* update events dropped).
   *  When `true`/undefined, reasoning is emitted as usual for a full transcript.
   *  Sourced from the phase permission decision's `reasoning` flag. */
  emitReasoning?: boolean;
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

function isCompactTranscriptMode(mode: TranscriptMode | undefined) {
  return mode === "compact";
}

function toCompactAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.filter((entry) => entry.type === "toolCall"),
  };
}

/** Drop reasoning/thinking blocks from an emitted message (UI reasoning suppressed). */
function stripThinkingContent(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter((entry) => entry.type !== "thinking") };
}

function isThinkingUpdateEvent(
  event: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"] | undefined,
): boolean {
  return (
    event?.type === "thinking_start" || event?.type === "thinking_delta" || event?.type === "thinking_end"
  );
}

function emitAssistantLifecycle(
  input: {
    emit: (e: AgentEvent) => void;
    message: AssistantMessage;
    assistantMessageEvent?: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"];
    transcriptMode?: TranscriptMode;
    emitReasoning?: boolean;
    kind: "start" | "update" | "end";
  },
) {
  const eventType =
    input.kind === "start" ? "message_start" : input.kind === "update" ? "message_update" : "message_end";

  // Compact transcript: only tool calls reach the UI (this already excludes text
  // and reasoning), and only tool-call update events are forwarded.
  if (isCompactTranscriptMode(input.transcriptMode)) {
    if (input.kind === "update") {
      const event = input.assistantMessageEvent;
      if (!event || (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end")) {
        return;
      }
    }
    input.emit({
      type: eventType,
      message: toCompactAssistantMessage(input.message),
      ...(input.kind === "update" && input.assistantMessageEvent
        ? { assistantMessageEvent: input.assistantMessageEvent }
        : {}),
    } as AgentEvent);
    return;
  }

  // Full transcript with reasoning suppressed: drop thinking_* update events and
  // strip thinking blocks from every emitted message.
  if (input.emitReasoning === false) {
    if (input.kind === "update" && isThinkingUpdateEvent(input.assistantMessageEvent)) return;
    input.emit({
      type: eventType,
      message: stripThinkingContent(input.message),
      ...(input.kind === "update" && input.assistantMessageEvent
        ? { assistantMessageEvent: input.assistantMessageEvent }
        : {}),
    } as AgentEvent);
    return;
  }

  // Full transcript with reasoning (default).
  input.emit({
    type: eventType,
    message: input.message,
    ...(input.kind === "update" && input.assistantMessageEvent
      ? { assistantMessageEvent: input.assistantMessageEvent }
      : {}),
  } as AgentEvent);
}

function buildOpeningMessage(input: PhaseRunInput): string {
  const parts: string[] = [];

  // 1. Always-on: explicit cwd so the model never has to guess where it is.
  parts.push(`WORKING DIRECTORY (use these absolute paths, or paths relative to this): ${input.cwd}`);

  // 2. The original task.
  parts.push(`TASK:\n${input.task}`);

  // 2·multi-plan: when PLAN produced several plans, PERFORM runs once per plan.
  // Name which plan this run owns so the model scopes its work correctly.
  if (input.phase === "perform" && input.planLabel) {
    parts.push(
      `ACTIVE PLAN (this PERFORM run executes ONLY this plan of a multi-plan task; other plans run in their own PERFORM passes):\n${input.planLabel}`,
    );
  }

  if (input.followUpContext?.mode === "structured_continue") {
    const previousRun = input.followUpContext.previousRun;
    const detailLines = [
      `Previous task: ${previousRun.task}`,
      `Previous route: ${previousRun.route}`,
      `Previous disposition: ${previousRun.disposition}`,
      `Recommended follow-up mode: ${previousRun.recommendedFollowUpMode}`,
      `Run summary: ${previousRun.summary}`,
      ...(previousRun.writtenPaths?.length
        ? [`Files changed: ${previousRun.writtenPaths.join(", ")}`]
        : []),
      ...(previousRun.readPaths?.length
        ? [`Files read: ${previousRun.readPaths.join(", ")}`]
        : []),
      ...(typeof previousRun.verified === "boolean"
        ? [`Verification: ${previousRun.verified ? "PASS" : "FAIL"}`]
        : []),
      ...(previousRun.pendingUserQuestion
        ? [`Pending question: ${previousRun.pendingUserQuestion.question}`]
        : []),
      ...(previousRun.error ? [`Error: ${previousRun.error}`] : []),
    ];
    parts.push(
      "THREAD CONTEXT FROM THE PREVIOUS RUN (same session; treat the run summary below as the canonical continuity handoff, then reconcile it against the current workspace before planning more work):\n" +
        detailLines.join("\n"),
    );
  }

  // 2a. Exact toolbox for THIS phase. The model already receives structured tool
  // defs, but surfacing the active names in prose sharply reduces "tool
  // imagination" (e.g. trying browser_* in a session that never connected a
  // browser MCP, or calling ui_screen_auditor without its required args).
  if (input.tools.length) {
    const list = input.tools
      .map((t) => {
        const required = Array.isArray(t.parameters?.required) && t.parameters.required.length
          ? ` [required: ${t.parameters.required.join(", ")}]`
          : "";
        return `  - ${t.name}${required} — ${t.description}`;
      })
      .join("\n");
    parts.push(
      `TOOLS AVAILABLE THIS PHASE (use ONLY these exact tool names; do NOT invent tools that are not listed here):\n${list}`,
    );
  }

  if (input.phase === "prepare" && input.availableProviders?.length) {
    const list = input.availableProviders
      .map((provider) => {
        const phases = provider.phases.join(", ") || "none";
        const tools = provider.toolNames.join(", ") || "none";
        return `  - ${provider.id} [${provider.kind}] — ${provider.name}\n    phases=${phases}\n    tools=${tools}\n    description=${provider.description}`;
      })
      .join("\n");
    parts.push(
      `REGISTERED PROVIDERS (metadata only — not additional executable tools. Use these to decide which MCPs/skills/providers later phases should receive):\n${list}`,
    );
  }

  // 2b. Project profile from Prepare — the authoritative statement of the stack
  //     and how to run/verify it. Prevents each phase from re-guessing (e.g.
  //     running expo/vite on a static HTML site with no package.json).
  if (input.priorProjectProfile) {
    parts.push(
      `PROJECT PROFILE (established by PREPARE — trust this for the stack and for run/verify commands; do NOT assume a different stack):\n${input.priorProjectProfile}`,
    );
  }

  if (input.priorProjectRunbook && (input.priorProjectRunbook.run || input.priorProjectRunbook.stop || input.priorProjectRunbook.verify)) {
    parts.push(
      "PROJECT RUNBOOK (established by PREPARE — reuse these exact run/stop/verify instructions instead of re-deriving them):\n" +
        [
          `RUN: ${input.priorProjectRunbook.run ?? "none"}`,
          `STOP: ${input.priorProjectRunbook.stop ?? "none"}`,
          `VERIFY: ${input.priorProjectRunbook.verify ?? "none"}`,
        ].join("\n"),
    );
  }

  // 2c. Capabilities (MCP servers / skills / tools) Prepare found relevant. Later
  //     phases should prefer these over ad-hoc bash.
  if (input.priorCapabilities) {
    parts.push(
      `CAPABILITIES AVAILABLE (MCP servers / skills / tools PREPARE identified — prefer these over improvising with bash):\n${input.priorCapabilities}`,
    );
  }

  if (
    input.priorProviderAssignments &&
    (input.priorProviderAssignments.plan?.length ||
      input.priorProviderAssignments.perform?.length ||
      input.priorProviderAssignments.perfect?.length)
  ) {
    const lines = [
      `PLAN: ${(input.priorProviderAssignments.plan ?? []).join(", ") || "none"}`,
      `PERFORM: ${(input.priorProviderAssignments.perform ?? []).join(", ") || "none"}`,
      `PERFECT: ${(input.priorProviderAssignments.perfect ?? []).join(", ") || "none"}`,
    ].join("\n");
    parts.push(`PHASE PROVIDER ASSIGNMENTS (selected by PREPARE — use these provider ids as the targeted MCP/skill/tool set):\n${lines}`);
  }

  // 3. Confirmed paths from prior phases — authoritative address list. The model
  //    should prefer these over prose paths mentioned in summaries.
  if (input.priorDiscoveredPaths?.length) {
    const list = input.priorDiscoveredPaths
      .map((p) => `  - ${p}`)
      .join("\n");
    parts.push(
      `CONFIRMED PATHS (these addresses were touched in earlier phases and exist — prefer them; do NOT guess like /project, /workspace, or \"\"):\n${list}`,
    );
  }

  if (input.priorRelevantFiles?.length) {
    const files = input.priorRelevantFiles
      .map((file) => {
        const blastParts = [
          file.blastRadius?.directFiles?.length ? `files=${file.blastRadius.directFiles.join(",")}` : undefined,
          file.blastRadius?.directSymbols?.length ? `symbols=${file.blastRadius.directSymbols.join(",")}` : undefined,
          file.blastRadius?.notes?.length ? `notes=${file.blastRadius.notes.join(",")}` : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        return `  - ${file.path} | complexity=${file.complexity} | why=${file.why}${blastParts ? ` | blast=${blastParts}` : ""}`;
      })
      .join("\n");
    parts.push(`RELEVANT FILES FROM PREPARE (focused task shortlist — prefer these files over broad rediscovery):\n${files}`);
  }

  if (input.phase === "plan" && input.allowedReadPaths?.length) {
    const list = input.allowedReadPaths
      .map((filePath) => `  - ${filePath}`)
      .join("\n");
    parts.push(
      `PLAN FILE HANDOFF (read ONLY these exact files in this phase; do NOT read any file not listed here, and do NOT rediscover the project tree):\n${list}`,
    );
  }

  if (input.phase === "plan" && input.planReviewFeedback) {
    parts.push(
      `PLAN REVIEW FEEDBACK TO ADDRESS (replace the previous draft plan with a revised implementation plan that satisfies this feedback before execution begins):\n${input.planReviewFeedback}`,
    );
  }

  if (input.priorToolTranscript?.length) {
    const rows = input.priorToolTranscript
      .map((entry) => `  - ${entry.tool}${entry.target ? ` | target=${entry.target}` : ""} | summary=${entry.summary}`)
      .join("\n");
    parts.push(
      `${
        input.phase === "perform"
          ? "PLAN READ TRANSCRIPT (actual successful file-reading work from PLAN; use this as implementation context)"
          : "PREPARE TOOL TRANSCRIPT (compact successful tool summary, not raw LLM transcript)"
      }:\n${rows}`,
    );
  }

  if (input.phase === "perform" && input.priorPlanJson?.length) {
    parts.push(
      `PLAN JSON FROM PLAN (treat this as the authoritative structured implementation card list for this phase):\n${JSON.stringify(input.priorPlanJson, null, 2)}`,
    );
  }

  if (input.phase === "perform" && input.allowedWorkPaths?.length) {
    const list = input.allowedWorkPaths.map((filePath) => `  - ${filePath}`).join("\n");
    parts.push(
      `PLAN FILES FOR DEVELOPMENT (implementation in PERFORM must stay within these exact files; do NOT read, edit, or write outside this allowlist unless the user explicitly changes the plan):\n${list}`,
    );
  }

  if (input.phase === "perform" && input.plannedFileMutations && Object.keys(input.plannedFileMutations).length) {
    const list = Object.entries(input.plannedFileMutations)
      .map(([filePath, mode]) => `  - ${filePath} => ${mode}`)
      .join("\n");
    parts.push(
      `PLAN FILE MUTATION MODES (authoritative per-file mutation contract from PLAN; for each listed file, use the declared tool mode and avoid mixing edit/write on the same file unless the plan changes):\n${list}`,
    );
  }

  if (input.phase === "perform" && input.attachedFileContents?.length) {
    const sections = input.attachedFileContents
      .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n");
    parts.push(
      `PLAN FILE CONTENTS ALREADY ATTACHED (treat these as the current source of truth from PLAN; do NOT re-read these files unless you need to verify a post-edit state):\n${sections}`,
    );
  }

  if (input.phase === "perform" && input.attachedContextFiles?.length) {
    const sections = input.attachedContextFiles
      .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n");
    parts.push(
      `PLAN SUPPORTING CONTEXT FILES ALREADY ATTACHED (read-only context from PLAN; use these for implementation guidance, but only edit files listed under PLAN FILES FOR DEVELOPMENT):\n${sections}`,
    );
  }

  if (input.phase === "prepare" && input.attachedContextFiles?.length) {
    const sections = input.attachedContextFiles
      .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n");
    parts.push(
      `FOLLOW-UP FILE CONTENTS FROM THE PREVIOUS RUN (same session continuity cache; treat these as already-read context and do NOT re-read them unless you need a genuinely new check):\n${sections}`,
    );
  }

  // 4. Recent successful tool snippets — last 1-2 non-error outputs from prior
  //    phases, truncated. Useful only as a fallback when no structured
  //    Prepare handoff exists yet.
  if (!input.priorRelevantFiles?.length && !input.priorToolTranscript?.length && input.priorToolSnippets?.length) {
    const blocks = input.priorToolSnippets
      .map((s) => {
        const head = s.path ? `${s.tool} ${s.path}` : s.tool;
        return `  - ${head}:\n${indent(s.snippet, "    ")}`;
      })
      .join("\n");
    parts.push(
      `RECENT TOOL OUTPUTS (last 1-2 successful outputs from earlier phases, truncated):\n${blocks}`,
    );
  }

  // 4a. Files already read by earlier phases — success-only read handover
  //     (Prepare→Plan, Plan→Perform). Shown to the read-heavy phases so they
  //     don't re-open files that were already inspected. Perform/Perfect care
  //     more about ALREADY WRITTEN (below), so this is scoped to plan/perform.
  if (input.priorReadPaths?.length && (input.phase === "prepare" || input.phase === "plan" || input.phase === "perform")) {
    const list = input.priorReadPaths
      .slice(-30)
      .map((p) => `  - ${p}`)
      .join("\n");
    parts.push(
      `FILES ALREADY READ (earlier phases read these successfully — do NOT re-read them unless you have a specific new question; their addresses are authoritative):\n${list}`,
    );
  }

  // 4b. Files already written/edited in this chain (used to prevent re-writes
  //     and re-verifications in retry iterations). Only shown to mutating
  //     phases and only when there's actual content.
  if (input.priorWrittenPaths?.length && (input.phase === "perform" || input.phase === "perfect")) {
    const list = input.priorWrittenPaths
      .slice(-30) // cap to keep opening message bounded
      .map((p) => `  - ${p}`)
      .join("\n");
    parts.push(
      `ALREADY WRITTEN THIS CHAIN (do NOT re-write these files unless FIX feedback names them; do NOT re-read them just to verify — the write/edit already succeeded):\n${list}`,
    );
  }

  // 5. Free-form summaries — still useful for intent, but NOT for path/address.
  if (input.priorSummaries?.length) {
    parts.push(
      "CONTEXT FROM EARLIER PHASES (prose summary — DO NOT trust this for exact paths; use CONFIRMED PATHS above):\n" +
        input.priorSummaries.map((s) => `[${s.phase.toUpperCase()}] ${s.summary}`).join("\n\n"),
    );
  }

  // 6. Media/artifact refs.
  if (input.priorRefs?.length) {
    parts.push(
      "AVAILABLE MEDIA/ARTIFACTS (by address — read only if needed):\n" +
        input.priorRefs.map((r) => `- ${r.uri} (${r.mimeType})${r.summary ? `: ${r.summary}` : ""}`).join("\n"),
    );
  }

  // 7. Verification feedback when re-running Perform after a failed Perfect.
  if (input.feedback) {
    parts.push(`VERIFICATION FEEDBACK TO ADDRESS (from a failed PERFECT run):\n${input.feedback}`);
  }

  return parts.join("\n\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.length ? prefix + l : l))
    .join("\n");
}

/** Detect a MediaRef produced by a tool (e.g. assets_generator). */
function refFromToolResult(msg: ToolResultMessage): MediaRef | undefined {
  const d = msg.details as { uri?: string; mimeType?: string; size?: number; summary?: string } | undefined;
  if (d && typeof d.uri === "string" && typeof d.mimeType === "string") {
    return { id: msg.toolCallId, uri: d.uri, mimeType: d.mimeType, size: d.size, summary: d.summary };
  }
  return undefined;
}

export async function runPhase(input: PhaseRunInput): Promise<PhaseResult> {
  const { phase, llm, permission, emit, cwd, signal, logStore } = input;
  const maxSteps = input.maxSteps ?? 12;
  const toolByName = new Map(input.tools.map((t) => [t.name, t]));

  emit({ type: "phase_start", phase, model: input.model.openRouterSlug ?? input.model.id });
  logStore.append({ tags: ["phase", `phase:${phase}`], level: "info", message: `start ${phase}` });

  const context: Context = {
    systemPrompt: PHASE_PROMPTS[phase],
    messages: [{ role: "user", content: buildOpeningMessage(input), timestamp: Date.now() }],
    tools: toToolDefs(input.tools),
  };

  let usage = emptyUsage();
  const refs: MediaRef[] = [...(input.priorRefs ?? [])];
  // Track absolute paths this phase actually touched (read/write/edit/ls/grep)
  // and the last 1-2 successful tool outputs. Both are carried into the next
  // phase's opening so it doesn't have to guess paths from prose.
  const discoveredPaths: string[] = [...(input.priorDiscoveredPaths ?? [])];
  const toolSnippets: ToolSnippet[] = [...(input.priorToolSnippets ?? [])];
  const toolTranscript: PrepareToolTranscriptEntry[] = [...(input.priorToolTranscript ?? [])];
  const PATHS_WITH = new Set(discoveredPaths);
  // Files that were actually written/edited this chain. Carried forward so
  // retry iterations don't re-write or re-verify the same file.
  const writtenPaths: string[] = [...(input.priorWrittenPaths ?? [])];
  const WRITTEN_WITH = new Set(writtenPaths);
  // Files successfully READ this chain — success-only read handover to the next
  // phase (Prepare→Plan, Plan→Perform).
  const readPaths: string[] = [...(input.priorReadPaths ?? [])];
  const READ_WITH = new Set(readPaths);
  const readFileContents: ReadFileContent[] = [];
  const READ_CONTENT_WITH = new Set<string>();
  const MUTATING_TOOLS = new Set(["write", "edit"]);
  const READ_TOOLS = new Set(["read", "ls", "grep", "cat"]);
  const PLAN_BLOCKED_TOOLS = new Set(["bash", "bash_readonly", "ls", "grep", "cat"]);
  const ALLOWED_PLAN_READ_PATHS = new Set((input.allowedReadPaths ?? []).map((filePath) => normalizeToolPath(cwd, filePath)));
  const ALLOWED_PERFORM_WORK_PATHS = new Set((input.allowedWorkPaths ?? []).map((filePath) => normalizeToolPath(cwd, filePath)));
  // Per-path complexity inherited from earlier phases (Prepare's per-file rating,
  // Plan's per-task rating). Normalized to absolute paths so a call's path arg can
  // be matched. Falls back to the shortlist's ratings when no explicit map exists.
  const COMPLEXITY_BY_PATH = new Map<string, ComplexityRating>();
  for (const [filePath, rating] of Object.entries(input.complexityByPath ?? {})) {
    COMPLEXITY_BY_PATH.set(normalizeToolPath(cwd, filePath), rating);
  }
  if (!COMPLEXITY_BY_PATH.size) {
    for (const file of input.priorRelevantFiles ?? []) {
      COMPLEXITY_BY_PATH.set(normalizeToolPath(cwd, stripMarkdownTicksLocal(file.path)), file.complexity);
    }
  }
  const INHERITED_COMPLEXITY_SOURCE = input.complexitySource ?? (input.priorRelevantFiles?.length ? "prepare-file" : undefined);
  const PLANNED_FILE_MUTATIONS = new Map(
    Object.entries(input.plannedFileMutations ?? {}).map(([filePath, mode]) => [normalizeToolPath(cwd, filePath), mode] as const),
  );
  const successfulMutationModeByPath = new Map<string, PlanFileMutationMode>();
  const ATTACHED_FILE_CONTENTS = new Map(
    [...(input.attachedFileContents ?? []), ...(input.attachedContextFiles ?? [])].map((file) => [
      normalizeToolPath(cwd, file.path),
      file.content,
    ] as const),
  );
  // Dedup cache for redundant read-only calls WITHIN this phase. Keyed by
  // tool-name + canonical args; a repeated identical read/ls/grep returns the
  // cached output instead of re-executing (efficiency). Any successful mutation
  // invalidates the cache, since a file may have changed on disk.
  const readCache = new Map<string, string>();
  const phaseToolCallIds: string[] = [];
  let maxComplexity = 0;
  let lastAssistant: AssistantMessage | undefined;
  let error: string | undefined;
  let pendingUserQuestion: AskUserQuestionRequest | undefined;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) throw new DOMExceptionLike("aborted");

      // ---- phase model turn (reasoning happens here, not in the orchestrator) ----
      emit({ type: "turn_start" });
      const assistant = await streamToMessage(llm, input.model, context, emit, {
        temperature: input.temperature,
        reasoning: input.reasoning,
        signal,
        transcriptMode: input.transcriptMode,
        emitReasoning: input.emitReasoning,
      });
      lastAssistant = assistant;
      usage = addUsage(usage, assistant.usage);
      context.messages.push(assistant);

      // Stop on error OR abort. On abort the stream throws before tool-call
      // argument buffers are parsed, so any streamed toolCall still has empty
      // arguments — we must NOT execute those. Break before the tool loop.
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        error = assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "aborted" : undefined);
        emit({ type: "turn_end", message: assistant, toolResults: [] });
        break;
      }
      if (signal?.aborted) break;

      const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
      if (toolCalls.length === 0) {
        emit({ type: "turn_end", message: assistant, toolResults: [] });
        break; // phase model produced its final answer
      }

      const toolResults: Message[] = [];
      for (const call of toolCalls) {
        if (call.type !== "toolCall") continue;
        phaseToolCallIds.push(call.id);
        const tool = toolByName.get(call.name);
        const mutates = tool?.mutates ?? true;

        // ---- argument validation: reject empty/random calls up front ----
        // Malformed calls with missing required args (e.g. `bash({})`,
        // `bash({timeoutMs:...})`, `read({})`) are a common weak-model / stream
        // artifact. Reject them centrally BEFORE permission, model-selection, or
        // execution, so they burn no budget and never pollute the handover.
        if (tool) {
          const missing = missingRequiredArgs(tool, call.arguments);
          if (missing.length) {
            const plural = missing.length > 1;
            const msg =
              `${call.name}: missing required argument${plural ? "s" : ""} ` +
              `${missing.map((m) => `'${m}'`).join(", ")}. ` +
              `Do not call ${call.name} without ${plural ? "them" : "it"} — provide the argument${plural ? "s" : ""} and retry, or skip the call if it isn't needed.`;
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(call.id, call.name, msg, true);
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
        }
        const argPath = (call.arguments as { path?: unknown } | undefined)?.path;
        if (phase === "plan" && call.name === "read" && typeof argPath === "string" && ALLOWED_PLAN_READ_PATHS.size > 0) {
          const requested = normalizeToolPath(cwd, argPath);
          if (!ALLOWED_PLAN_READ_PATHS.has(requested)) {
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(
              call.id,
              call.name,
              `read: path "${requested}" is outside the Prepare handoff. Read ONLY the files listed in PLAN FILE HANDOFF.`,
              true,
            );
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
        }

        if (
          phase === "perform" &&
          ["read", "write", "edit", "cat"].includes(call.name) &&
          typeof argPath === "string" &&
          ALLOWED_PERFORM_WORK_PATHS.size > 0
        ) {
          const requested = normalizeToolPath(cwd, argPath);
          if (!ALLOWED_PERFORM_WORK_PATHS.has(requested)) {
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(
              call.id,
              call.name,
              `${call.name}: path "${requested}" is outside the Plan file allowlist. PERFORM must stay within PLAN FILES FOR DEVELOPMENT.`,
              true,
            );
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
        }

        if (phase === "perform" && (call.name === "write" || call.name === "edit") && typeof argPath === "string" && argPath.trim()) {
          const requested = normalizeToolPath(cwd, argPath);
          const plannedMode = PLANNED_FILE_MUTATIONS.get(requested);
          if (plannedMode && plannedMode !== call.name) {
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(
              call.id,
              call.name,
              `${call.name}: "${requested}" is planned for ${plannedMode} in PLAN FILE MUTATION MODES. Use ${plannedMode} for this file unless the plan changes.`,
              true,
            );
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
          if (!plannedMode && call.name === "write" && successfulMutationModeByPath.get(requested) === "edit") {
            emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
            const invalid = makeToolResult(
              call.id,
              call.name,
              `write: "${requested}" already had a successful edit earlier in this PERFORM phase. Do not escalate an in-place edit into a full-file overwrite unless PLAN explicitly marked this file for write.`,
              true,
            );
            emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
            context.messages.push(invalid);
            toolResults.push(invalid);
            continue;
          }
        }

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
            if (!READ_CONTENT_WITH.has(requested)) {
              readFileContents.push({ path: requested, content: attached });
              READ_CONTENT_WITH.add(requested);
            }
            continue;
          }
        }

        if (phase === "plan" && PLAN_BLOCKED_TOOLS.has(call.name)) {
          emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
          const invalid = makeToolResult(
            call.id,
            call.name,
            `${call.name}: unavailable in PLAN for Prepare handoff mode. Use read on the handed-over files, or use the assigned MCP/skill tools already attached to PLAN.`,
            true,
          );
          emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
          context.messages.push(invalid);
          toolResults.push(invalid);
          continue;
        }
        if (
          tool &&
          typeof argPath === "string" &&
          argPath.trim() &&
          ["read", "edit", "cat"].includes(call.name)
        ) {
          const requested = path.isAbsolute(argPath) ? argPath : path.join(cwd, argPath);
          if (!PATHS_WITH.has(requested) && !(await pathExists(requested))) {
            const suggested = suggestKnownPath(requested, discoveredPaths);
            if (suggested && suggested !== requested) {
              emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
              const invalid = makeToolResult(
                call.id,
                call.name,
                `${call.name}: path "${requested}" is not a confirmed path. Reuse the exact listed path instead of paraphrasing it.\nClosest confirmed path: ${suggested}`,
                true,
              );
              emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: invalid.content, isError: true });
              context.messages.push(invalid);
              toolResults.push(invalid);
              continue;
            }
          }
        }

        // ---- dedup: identical read-only call already answered this phase ----
        // A repeated read/ls/grep with identical args wastes a step. Serve it
        // from the in-phase cache instead of re-executing. Any successful
        // mutation (below) clears the cache, so stale reads are never served.
        const callSig = `${call.name}:${canonicalArgs(call.arguments)}`;
        if (tool && !mutates && READ_TOOLS.has(call.name) && readCache.has(callSig)) {
          const cached = readCache.get(callSig)!;
          const dup = makeToolResult(
            call.id,
            call.name,
            `${cached}\n\n(note: an identical ${call.name} call already returned this earlier in this phase — reusing the cached result. Do not repeat the same read.)`,
            false,
          );
          context.messages.push(dup);
          toolResults.push(dup);
          continue;
        }

        // Complexity estimate for this call → drives model selection (req #7).
        // When the call targets a path with an inherited rating (Prepare's per-file
        // rating, or Plan's per-task rating), that rating raises the floor so the
        // planner/preparer's judgement is honored rather than blindly re-estimated.
        const inheritedRating =
          typeof argPath === "string" && argPath.trim()
            ? COMPLEXITY_BY_PATH.get(normalizeToolPath(cwd, argPath))
            : undefined;
        const complexity = estimateComplexity({
          toolCount: input.tools.length,
          contextChars: JSON.stringify(context.messages).length,
          mutates,
          refs,
          bias: tool?.complexityHint ? tool.complexityHint - 0.3 : 0,
        });
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
          complexitySource: (inheritedRating ? INHERITED_COMPLEXITY_SOURCE ?? "prepare-file" : "estimated") as
            | "prepare-file"
            | "plan-task"
            | "estimated",
          refs,
          phase,
        };
        emit({ type: "permission_request", request: req });
        const decision = await permission.evaluate(req);
        emit({ type: "permission_decision", request: req, decision });

        if (!decision.allowed) {
          const denied = makeToolResult(call.id, call.name, `Permission denied by policy: ${decision.reason ?? ""}`, true);
          context.messages.push(denied);
          toolResults.push(denied);
          continue;
        }
        if (!tool) {
          const missing = makeToolResult(call.id, call.name, `Unknown tool "${call.name}".`, true);
          context.messages.push(missing);
          toolResults.push(missing);
          continue;
        }

        // ---- per-call model selection ----
        // decision.model pins it; else pick by complexity/modality; else phase model.
        const { model: callModel } = selectModel({
          preferred: decision.model,
          candidates: input.toolModelCandidates,
          complexity,
          refs,
          mutates,
        });
        const toolCtx: ToolContext = {
          cwd,
          signal,
          model: decision.model ? llm.resolveModel(decision.model) : callModel ?? input.model,
          log: (e) => logStore.append(e),
          llm,
          registry: input.registry,
          ...(input.askUserQuestion ? { askUserQuestion: input.askUserQuestion } : {}),
        };

        emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
        let resultMsg: ToolResultMessage;
        try {
          const res = await tool.execute(call.id, call.arguments, toolCtx);
          resultMsg = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: res.content ?? [{ type: "text", text: res.output ?? "" }],
            details: res.details,
            isError: res.isError ?? false,
            timestamp: Date.now(),
          };
          // If a text output exists but content was custom, ensure the model sees text.
          if (res.output && !(res.content ?? []).some((c) => c.type === "text")) {
            resultMsg.content = [{ type: "text", text: res.output }, ...(res.content ?? [])];
          }
        } catch (err) {
          resultMsg = makeToolResult(call.id, call.name, `Tool threw: ${(err as Error).message}`, true);
        }
        emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result: toolExecutionEventResult(resultMsg),
          isError: resultMsg.isError,
        });

        const ref = refFromToolResult(resultMsg);
        if (ref) refs.push(ref);
        const questionRequest =
          phase === "plan" ? askUserQuestionRequestFromResult(phase, resultMsg.details) : undefined;
        if (questionRequest) pendingUserQuestion = questionRequest;

        // ---- SUCCESS-ONLY handover capture ----
        // Everything below runs only for calls that actually SUCCEEDED. A
        // failed/rejected call must never contribute a path to the next phase
        // (that was the bug behind "ALREADY WRITTEN" listing files a failed
        // write never created, and phases trusting paths from empty calls).
        if (!resultMsg.isError) {
          let absPath: string | undefined;
          if (typeof argPath === "string" && argPath.trim()) {
            absPath = path.isAbsolute(argPath) ? argPath : path.join(cwd, argPath);
            if (!PATHS_WITH.has(absPath)) {
              discoveredPaths.push(absPath);
              PATHS_WITH.add(absPath);
            }
            // Mutating tools (write/edit) → "already written" handover to
            // Perfect. A successful mutation also invalidates the read cache,
            // since a file on disk may now differ from a cached read.
            if (MUTATING_TOOLS.has(call.name)) {
              readCache.clear();
              ATTACHED_FILE_CONTENTS.delete(normalizeToolPath(cwd, absPath));
              if ((call.name === "write" || call.name === "edit") && !successfulMutationModeByPath.has(absPath)) {
                successfulMutationModeByPath.set(absPath, call.name);
              }
              if (!WRITTEN_WITH.has(absPath)) {
                writtenPaths.push(absPath);
                WRITTEN_WITH.add(absPath);
                if (writtenPaths.length > 50) writtenPaths.splice(0, writtenPaths.length - 50);
              }
            }
            // Read-family tools with a path → "files already read" handover.
            if (READ_TOOLS.has(call.name) && !READ_WITH.has(absPath)) {
              readPaths.push(absPath);
              READ_WITH.add(absPath);
              if (readPaths.length > 50) readPaths.splice(0, readPaths.length - 50);
            }
          }

          // Keep the last 2 successful tool outputs (truncated) for short
          // context carry-over. Errors/empty outputs are skipped — noise.
          const outText = (resultMsg.content ?? [])
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          if (outText) {
            if (call.name === "read" && absPath && !READ_CONTENT_WITH.has(absPath)) {
              readFileContents.push({ path: absPath, content: outText });
              READ_CONTENT_WITH.add(absPath);
            }
            if (call.name === "ls" && absPath) {
              const listed = listedChildPaths(absPath, outText);
              for (const child of listed) {
                if (!PATHS_WITH.has(child)) {
                  discoveredPaths.push(child);
                  PATHS_WITH.add(child);
                }
              }
            }
            toolSnippets.push({
              tool: call.name,
              path: typeof argPath === "string" ? argPath : undefined,
              snippet: outText.length > 1500 ? outText.slice(0, 1500) + "\n…(truncated)" : outText,
            });
            if (toolSnippets.length > 2) toolSnippets.splice(0, toolSnippets.length - 2);
            // Populate the in-phase dedup cache for read-only calls.
            if (!mutates && READ_TOOLS.has(call.name)) {
              readCache.set(callSig, outText.length > 1500 ? outText.slice(0, 1500) + "\n…(truncated)" : outText);
            }
            const summary = summarizeToolOutput(outText);
            if (summary) {
              toolTranscript.push({
                tool: call.name,
                target: summarizeToolTarget(call.arguments),
                summary,
              });
              if (toolTranscript.length > 12) toolTranscript.splice(0, toolTranscript.length - 12);
            }
          }

        }

        context.messages.push(resultMsg);
        toolResults.push(resultMsg);

        // The `tool` role can't carry images (see bridge.toORContent). Surface any
        // inline image a tool returned to the model as a follow-up user message so
        // vision-capable models can actually see it.
        const images = resultMsg.content.filter((c) => c.type === "image");
        if (images.length) {
          const mediaMsg: Message = {
            role: "user",
            content: [{ type: "text", text: `Image output from ${call.name}:` }, ...images],
            timestamp: Date.now(),
          };
          context.messages.push(mediaMsg);
          toolResults.push(mediaMsg);
        }
        if (pendingUserQuestion) break;
      }
      emit({ type: "turn_end", message: assistant, toolResults });
      if (pendingUserQuestion) break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const finalText = lastAssistant
    ? lastAssistant.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n")
    : "";

  // For Perfect, determine the verdict. If the model ended without an explicit
  // "VERDICT: PASS/FAIL" (e.g. it ran out of steps mid-tool-call — common with
  // weaker models), do ONE bounded, tool-free follow-up asking for the verdict
  // rather than silently defaulting to failure. The model still decides.
  let verified: boolean | undefined;
  if (phase === "perfect") {
    verified = matchVerdict(finalText);
    if (verified === undefined && !error && !signal?.aborted) {
      try {
        const elicited = await elicitVerdict(llm, input.model, context, signal);
        usage = addUsage(usage, elicited.usage);
        verified = elicited.verdict;
      } catch {
        /* leave undefined → treated as not-verified below */
      }
    }
    if (verified === undefined) verified = false;
  }

  let summary = extractSummary(phase, finalText);
  // UI SUMMARY is the single user-facing summary every phase emits. CHAT SUMMARY
  // is accepted as a legacy alias so older outputs still populate the UI card.
  const uiSummary = extractSingleOrSection(finalText, "UI SUMMARY") ?? extractSingleOrSection(finalText, "CHAT SUMMARY");
  if (phase === "perfect" && !/VERDICT:/i.test(summary)) {
    summary = `VERDICT: ${verified ? "PASS" : "FAIL"}${summary ? `\n${summary}` : ""}`;
  }

  // Prepare declares the project profile + relevant capabilities via markers; any
  // phase MAY re-declare them. When a phase doesn't, we fall back to the inherited
  // prior value so the profile/capabilities persist across the whole chain.
  const projectCategory = extractCategory(finalText);
  const projectProfile = extractLine(finalText, "PROJECT") ?? input.priorProjectProfile;
  const projectRunbook = {
    run: extractSingleOrSection(finalText, "RUN") ?? input.priorProjectRunbook?.run,
    stop: extractSingleOrSection(finalText, "STOP") ?? input.priorProjectRunbook?.stop,
    verify: extractSingleOrSection(finalText, "VERIFY") ?? input.priorProjectRunbook?.verify,
  };
  const capabilities = extractSection(finalText, "CAPABILITIES") ?? input.priorCapabilities;
  const parsedProviderAssignments = extractProviderAssignments(finalText);
  const fallbackProviderAssignments =
    phase === "prepare"
      ? deriveFallbackProviderAssignments({
          task: input.task,
          projectCategory,
          projectProfile,
          availableProviders: input.availableProviders ?? [],
        })
      : undefined;
  const providerAssignments =
    mergeProviderAssignments(parsedProviderAssignments, phase === "prepare" ? fallbackProviderAssignments : input.priorProviderAssignments) ??
    input.priorProviderAssignments;
  const parsedRelevantFiles = extractRelevantFiles(finalText);
  const relevantFiles =
    phase === "prepare"
      ? mergeRelevantFiles(
          parsedRelevantFiles,
          deriveFallbackRelevantFiles({
            task: input.task,
            readPaths,
            toolTranscript,
          }),
        )
      : parsedRelevantFiles;
  // TOOL CHAIN is the single continuity marker each phase emits; TOOL TRANSCRIPT
  // is a legacy alias. Fold the declared TOOL CHAIN into the compact transcript so
  // the downstream openings ("PREPARE TOOL TRANSCRIPT"/"PLAN READ TRANSCRIPT")
  // stay populated even though TOOL TRANSCRIPT is no longer part of the contract.
  const declaredToolChain = extractToolChain(finalText);
  const legacyToolTranscript = extractToolTranscript(finalText);
  const toolChainAsTranscript: PrepareToolTranscriptEntry[] = declaredToolChain.map((entry) => ({
    tool: entry.tool,
    ...(entry.target ? { target: entry.target } : {}),
    summary: entry.reasoning,
  }));
  const mergedToolTranscript = mergeToolTranscript(toolTranscript, [...legacyToolTranscript, ...toolChainAsTranscript]);
  const memoryUpdates = extractListSection(finalText, "MEMORY UPDATES");
  const fileMemoryUpdates = extractFileMemoryUpdates(finalText);
  const planJson = extractPlanJson(finalText);
  // Common handoff parameters produced by every phase.
  const toolChain = declaredToolChain.length
    ? declaredToolChain
    : deriveToolChainFromTranscript(mergedToolTranscript, relevantFiles);
  // Multi-plan (Plan phase): PLANS_JSON wins; else normalize a legacy PLAN_JSON.
  const planSet =
    phase === "plan"
      ? extractPlanSet(finalText) ?? normalizeLegacyPlanJson(planJson)
      : undefined;
  // QA plan (Perfect phase).
  const qaPlan = phase === "perfect" ? extractQaPlan(finalText) : undefined;
  summary = ensurePhaseSummary({
    phase,
    summary,
    pendingUserQuestion,
    error,
    verified,
    writtenPaths,
    readPaths,
    toolTranscript: mergedToolTranscript,
  });
  const display = buildPhaseDisplayArtifact(phase, finalText, summary, uiSummary, phaseToolCallIds);

  const handoff: PhaseHandoff = {
    from: phase,
    to: nextPhase(phase),
    files: relevantFiles,
    toolChain,
    ...(uiSummary ? { reasoning: uiSummary } : {}),
  };
  const result: PhaseResult = {
    phase,
    summary,
    ...(display ? { display } : {}),
    ...(uiSummary ? { uiSummary } : {}),
    ...(toolChain.length ? { toolChain } : {}),
    handoff,
    ...(planSet ? { planSet } : {}),
    ...(qaPlan ? { qaPlan } : {}),
    artifacts: {
      ...extractArtifacts(phase, finalText),
      ...(uiSummary ? { uiSummary } : {}),
      ...(planJson ? { planJson } : {}),
      ...(planSet ? { planSet } : {}),
      ...(qaPlan ? { qaPlan } : {}),
      ...(pendingUserQuestion ? { pendingUserQuestion } : {}),
    },
    refs,
    discoveredPaths: discoveredPaths.length ? discoveredPaths : undefined,
    readPaths: readPaths.length ? readPaths : undefined,
    recentToolSnippets: toolSnippets.length ? toolSnippets : undefined,
    writtenPaths: writtenPaths.length ? writtenPaths : undefined,
    projectCategory,
    projectProfile,
    projectRunbook:
      projectRunbook.run || projectRunbook.stop || projectRunbook.verify
        ? projectRunbook
        : input.priorProjectRunbook,
    capabilities,
    providerAssignments,
    relevantFiles: relevantFiles.length ? relevantFiles : input.priorRelevantFiles,
    toolTranscript: mergedToolTranscript.length ? mergedToolTranscript : input.priorToolTranscript,
    readFileContents: readFileContents.length ? readFileContents : undefined,
    registeredProvidersSeen: input.phase === "prepare" ? input.availableProviders : undefined,
    memoryUpdates: memoryUpdates.length ? memoryUpdates : undefined,
    fileMemoryUpdates: fileMemoryUpdates.length ? fileMemoryUpdates : undefined,
    pendingUserQuestion,
    verified,
    complexity: maxComplexity,
    usage,
    messages: context.messages,
    error,
  };
  emit({ type: "phase_end", phase, result });
  logStore.append({
    tags: ["phase", `phase:${phase}`, ...(result.verified === false ? ["verify:fail"] : [])],
    level: error ? "error" : "info",
    message: `end ${phase}${result.verified != null ? ` verified=${result.verified}` : ""}`,
  });
  return result;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of required parameters that are missing or empty for a tool
 * call. Used to reject malformed/empty calls (e.g. `bash({})`) at the runner
 * level, before permission/model-selection/execution. A value counts as
 * "missing" when it is undefined/null, an empty/whitespace-only string, or an
 * empty array — the shapes weak models emit as streaming artifacts.
 */
function missingRequiredArgs(tool: AgentTool, args: Record<string, unknown> | undefined): string[] {
  const required = tool.parameters?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  const a = args ?? {};
  const missing: string[] = [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    const v = (a as Record<string, unknown>)[key];
    if (v === undefined || v === null) missing.push(key);
    else if (typeof v === "string" && v.trim() === "") missing.push(key);
    else if (Array.isArray(v) && v.length === 0) missing.push(key);
  }
  return missing;
}

/** Stable, order-independent serialization of tool args for the dedup cache. */
function canonicalArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  try {
    const keys = Object.keys(args).sort();
    return JSON.stringify(args, keys);
  } catch {
    return "";
  }
}

function makeToolResult(id: string, name: string, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function hasStructuredDiff(details: unknown): details is { diff: string } {
  return typeof details === "object" && details !== null && typeof (details as { diff?: unknown }).diff === "string";
}

function toolExecutionEventResult(result: ToolResultMessage): unknown {
  return hasStructuredDiff(result.details)
    ? { content: result.content, details: result.details }
    : (result.details ?? result.content);
}

function askUserQuestionRequestFromResult(
  phase: Phase,
  details: unknown,
): AskUserQuestionRequest | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (record.kind !== "ask_user_question") return undefined;
  if (typeof record.question !== "string" || record.question.trim().length === 0) return undefined;
  const options = Array.isArray(record.options)
    ? record.options.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const answerMode =
    record.answerMode === "text" ||
    record.answerMode === "single-select" ||
    record.answerMode === "multi-select"
      ? record.answerMode
      : undefined;
  return {
    phase,
    question: record.question.trim(),
    ...(typeof record.reason === "string" && record.reason.trim().length > 0
      ? { reason: record.reason.trim() }
      : {}),
    ...(typeof record.placeholder === "string" && record.placeholder.trim().length > 0
      ? { placeholder: record.placeholder.trim() }
      : {}),
    ...(answerMode ? { answerMode } : {}),
    ...(options?.length ? { options } : {}),
  };
}

function buildPendingQuestionSummary(
  question: AskUserQuestionRequest,
  fallback: string,
): string {
  const lines = [
    `Waiting for user input before execution can continue.`,
    `Question: ${question.question}`,
    ...(question.reason ? [`Why this matters: ${question.reason}`] : []),
    ...(question.answerMode ? [`Expected answer mode: ${question.answerMode}`] : []),
    ...(question.options?.length ? [`Suggested answers: ${question.options.join(" | ")}`] : []),
    `Execution plan will appear after this clarification is answered.`,
  ];
  const body = lines.join("\n");
  // Do NOT append the phase fallback summary here. In interrupted PLAN runs the
  // fallback often contains raw internal transcript fragments (tool names,
  // marker-heavy blocks like CHAT SUMMARY / PLAN_JSON / PLAN, or file paths)
  // because the model asked the question before producing a clean final
  // SUMMARY. The pending-question card should stay focused on the clarification
  // itself; once the user answers, the resumed run will generate the real plan
  // summary and plan card.
  void fallback;
  return body;
}

/** Consume a pi stream into a final AssistantMessage, re-emitting message_update events. */
async function streamToMessage(
  llm: LLMBridge,
  model: Model,
  context: Context,
  emit: (e: AgentEvent) => void,
  opts: {
    temperature?: number;
    reasoning?: ThinkingLevel;
    signal?: AbortSignal;
    transcriptMode?: TranscriptMode;
    emitReasoning?: boolean;
  },
): Promise<AssistantMessage> {
  let final: AssistantMessage | undefined;
  let started = false;
  // `reasoning`/`emitReasoning` are runner concerns, not LLM request options.
  const { emitReasoning, transcriptMode, ...streamOpts } = opts;
  for await (const ev of llm.stream(model, context, streamOpts)) {
    if (ev.type === "start" && !started) {
      started = true;
      emitAssistantLifecycle({
        emit,
        message: ev.partial,
        transcriptMode,
        emitReasoning,
        kind: "start",
      });
    }
    if ("partial" in ev) {
      emitAssistantLifecycle({
        emit,
        message: ev.partial,
        assistantMessageEvent: ev,
        transcriptMode,
        emitReasoning,
        kind: "update",
      });
    }
    if (ev.type === "done") {
      final = ev.message;
      emitAssistantLifecycle({
        emit,
        message: ev.message,
        transcriptMode,
        emitReasoning,
        kind: "end",
      });
    } else if (ev.type === "error") {
      final = ev.error;
      emitAssistantLifecycle({
        emit,
        message: ev.error,
        transcriptMode,
        emitReasoning,
        kind: "end",
      });
    }
  }
  if (!final) throw new Error("stream produced no final message");
  return final;
}

function extractSummary(phase: Phase, text: string): string {
  const markers = {
    prepare: ["SUMMARY"],
    plan: ["SUMMARY", "PLAN"],
    perform: ["SUMMARY", "CHANGES"],
    perfect: ["SUMMARY", "FIX", "VERDICT"],
  }[phase];
  for (const marker of markers) {
    const section = extractSection(text, marker);
    if (section) return section;
    const line = extractLine(text, marker);
    if (line) return line;
  }
  return sanitizePhaseSummaryFallback(text) ?? text.trim().slice(0, 4000);
}

/** The single line following a `MARKER:` (e.g. the one-line PROJECT profile). */
function extractLine(text: string, marker: string): string | undefined {
  const block = findMarkerBlock(text, marker);
  if (!block) return undefined;
  const line = block.bodyLines.map((entry) => entry.trim()).find(Boolean);
  return line || undefined;
}

/** A `MARKER:` block up to the next ALL-CAPS section header (or end of text). */
function extractSection(text: string, marker: string): string | undefined {
  const block = findMarkerBlock(text, marker);
  if (!block) return undefined;
  const body = block.bodyLines.join("\n").trim();
  return body || undefined;
}

function extractSingleOrSection(text: string, marker: string): string | undefined {
  return extractLine(text, marker) ?? extractSection(text, marker);
}

function findMarkerBlock(text: string, marker: string): { bodyLines: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  const matches: Array<{ index: number; inline: string | undefined }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = matchMarkerHeader(lines[index] ?? "", marker);
    if (match !== undefined) {
      matches.push({ index, inline: match });
    }
  }
  const target = matches.at(-1);
  if (!target) return undefined;
  const bodyLines: string[] = [];
  if (target.inline) {
    bodyLines.push(target.inline);
  }
  let started = Boolean(target.inline);
  for (let index = target.index + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isStructuredSectionHeader(line)) break;
    if (!started && !line.trim()) continue;
    started = true;
    bodyLines.push(line);
  }
  return bodyLines.length ? { bodyLines } : undefined;
}

function matchMarkerHeader(line: string, marker: string): string | undefined {
  const stripped = line.trim().replace(/\*/g, "").trim();
  if (!stripped) return undefined;
  if (stripped === marker || stripped === `${marker}:`) return "";
  if (stripped.startsWith(`${marker}:`)) return stripped.slice(marker.length + 1).trim();
  if (stripped.startsWith(`${marker} `)) return stripped.slice(marker.length + 1).trim();
  return undefined;
}

function isStructuredSectionHeader(line: string): boolean {
  const stripped = line.trim().replace(/\*/g, "").trim();
  if (!stripped) return false;
  return /^[A-Z][A-Z _]{2,}(?::.*)?$/.test(stripped);
}

function sanitizePhaseSummaryFallback(text: string): string | undefined {
  const cleaned = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!cleaned) return undefined;
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected: string[] = [];
  for (const line of lines) {
    if (isStructuredSectionHeader(line)) {
      if (selected.length > 0) break;
      continue;
    }
    if (/^[a-z0-9_-]+\s+\|\s+target=/i.test(line)) continue;
    if (/^(none|n\/a)$/i.test(line)) continue;
    selected.push(line);
    if (selected.length >= 4) break;
  }
  const summary = selected.join("\n").trim();
  return summary || undefined;
}

function extractCategory(text: string): PhaseResult["projectCategory"] | undefined {
  const raw = extractLine(text, "CATEGORY")?.toLowerCase();
  if (raw === "frontend" || raw === "mobile" || raw === "games" || raw === "backend") return raw;
  return undefined;
}

function extractListSection(text: string, marker: string): string[] {
  const body = extractSection(text, marker);
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^none$/i.test(line));
}

function extractFileMemoryUpdates(text: string): FileMemoryUpdate[] {
  return extractListSection(text, "FILE MEMORY UPDATES")
    .map((line) => {
      const [left, ...rest] = line.split("|").map((part) => part.trim()).filter(Boolean);
      if (!left) return undefined;
      const arrow = left.indexOf("=>");
      if (arrow === -1) return undefined;
      const filePath = left.slice(0, arrow).trim();
      const summary = left.slice(arrow + 2).trim();
      if (!filePath || !summary) return undefined;
      const update: FileMemoryUpdate = { path: filePath, summary };
      for (const part of rest) {
        const [keyRaw, valueRaw] = part.split("=").map((x) => x.trim());
        const key = keyRaw?.toLowerCase();
        const value = valueRaw?.trim();
        if (!key || !value) continue;
        if (key === "tags") {
          const tags = value
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (tags.length) update.tags = tags;
        }
        if (
          key === "role" &&
          ["entrypoint", "config", "component", "schema", "test", "script", "doc", "unknown"].includes(value)
        ) {
          update.role = value as FileMemoryUpdate["role"];
        }
      }
      return update;
    })
    .filter((update): update is FileMemoryUpdate => Boolean(update));
}

function extractProviderAssignments(text: string): PrepareProviderAssignmentMap | undefined {
  const body = extractSection(text, "PROVIDER ASSIGNMENTS");
  if (!body) return undefined;
  const out: PrepareProviderAssignmentMap = {};
  for (const line of body.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^(PLAN|PERFORM|PERFECT)\s*(?:=>|:)\s*(.*)$/i);
    if (!match) continue;
    const phase = match[1]!.toLowerCase() as keyof PrepareProviderAssignmentMap;
    const ids = match[2]!
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && !/^none$/i.test(id));
    if (ids.length) out[phase] = ids;
  }
  if (!Object.keys(out).length) {
    for (const phase of ["plan", "perform", "perfect"] as const) {
      const match = body.match(new RegExp(`["']?${phase}["']?\\s*:\\s*(\\[[^\\]]*\\]|[^\\n\\r,}]+)`, "i"));
      const raw = match?.[1]?.trim();
      if (!raw) continue;
      const ids = raw
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((id) => id.replace(/^["'\s]+|["'\s]+$/g, "").trim())
        .filter((id) => id.length > 0 && !/^none$/i.test(id));
      if (ids.length) out[phase] = ids;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function extractRelevantFiles(text: string): PrepareRelevantFile[] {
  const body = extractSection(text, "FILE SEARCH");
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map(parseRelevantFileLine)
    .filter((entry): entry is PrepareRelevantFile => Boolean(entry));
}

function parseRelevantFileLine(line: string): PrepareRelevantFile | undefined {
  const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
  const filePath = parts.shift();
  if (!filePath) return undefined;
  let complexity: PrepareRelevantFile["complexity"] | undefined;
  let why = "";
  let blastRadius: PrepareBlastRadiusSummary | undefined;
  for (const part of parts) {
    const [keyRaw, ...valueParts] = part.split("=");
    const key = keyRaw?.trim().toLowerCase();
    const value = valueParts.join("=").trim();
    if (!key || !value) continue;
    if (key === "complexity" && (value === "low" || value === "medium" || value === "high")) complexity = value;
    if (key === "why") why = value;
    if (key === "blast") blastRadius = parseBlastRadius(value);
  }
  if (!complexity || !why) return undefined;
  return { path: filePath, complexity, why, ...(blastRadius ? { blastRadius } : {}) };
}

function parseBlastRadius(value: string): PrepareBlastRadiusSummary | undefined {
  const summary: PrepareBlastRadiusSummary = { directFiles: [] };
  for (const token of value.split(";").map((part) => part.trim()).filter(Boolean)) {
    const [keyRaw, ...valueParts] = token.split("=");
    const key = keyRaw?.trim().toLowerCase();
    const data = valueParts.join("=").trim();
    if (!key || !data) continue;
    const list = data.split(",").map((item) => item.trim()).filter(Boolean);
    if (key === "files") summary.directFiles = list;
    if (key === "symbols" && list.length) summary.directSymbols = list;
    if (key === "notes" && list.length) summary.notes = list;
  }
  return summary.directFiles.length || summary.directSymbols?.length || summary.notes?.length ? summary : undefined;
}

function extractToolTranscript(text: string): PrepareToolTranscriptEntry[] {
  const body = extractSection(text, "TOOL TRANSCRIPT");
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      const tool = parts.shift();
      if (!tool) return undefined;
      let target: string | undefined;
      let summary: string | undefined;
      for (const part of parts) {
        const [keyRaw, ...valueParts] = part.split("=");
        const key = keyRaw?.trim().toLowerCase();
        const value = valueParts.join("=").trim();
        if (key === "target" && value) target = value;
        if (key === "summary" && value) summary = value;
      }
      if (!summary) return undefined;
      return { tool, ...(target ? { target } : {}), summary };
    })
    .filter((entry): entry is PrepareToolTranscriptEntry => Boolean(entry));
}

function summarizeToolOutput(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function summarizeToolTarget(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const candidates = [args.path, args.query, args.symbol, args.qualifiedName, args.action]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return candidates[0];
}

function mergeToolTranscript(
  derived: PrepareToolTranscriptEntry[],
  declared: PrepareToolTranscriptEntry[],
): PrepareToolTranscriptEntry[] {
  const out: PrepareToolTranscriptEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...derived, ...declared]) {
    const sig = `${entry.tool}::${entry.target ?? ""}::${entry.summary}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(entry);
  }
  return out;
}

function nextPhase(phase: Phase): Phase | undefined {
  return phase === "prepare" ? "plan" : phase === "plan" ? "perform" : phase === "perform" ? "perfect" : undefined;
}

/** Parse the "TOOL CHAIN:" section (tool | target= | reasoning= | complexity=). */
function extractToolChain(text: string): ToolChainEntry[] {
  const body = extractSection(text, "TOOL CHAIN");
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^none$/i.test(line))
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      const tool = parts.shift();
      if (!tool) return undefined;
      const entry: ToolChainEntry = { tool, reasoning: "" };
      for (const part of parts) {
        const [keyRaw, ...valueParts] = part.split("=");
        const key = keyRaw?.trim().toLowerCase();
        const value = valueParts.join("=").trim();
        if (!key || !value) continue;
        if (key === "target") entry.target = value;
        if (key === "reasoning" || key === "why") entry.reasoning = value;
        if (key === "complexity" && (value === "low" || value === "medium" || value === "high")) {
          entry.complexity = value;
        }
      }
      if (!entry.reasoning) entry.reasoning = entry.target ? `Touched ${entry.target}` : `Ran ${entry.tool}`;
      return entry;
    })
    .filter((entry): entry is ToolChainEntry => Boolean(entry));
}

/** Fallback tool-chain when the model didn't emit a TOOL CHAIN section: derive it
 *  from the real transcript, enriched with per-file complexity from the shortlist. */
function deriveToolChainFromTranscript(
  transcript: PrepareToolTranscriptEntry[],
  relevantFiles: PrepareRelevantFile[],
): ToolChainEntry[] {
  if (!transcript.length) return [];
  const complexityByTarget = new Map<string, ComplexityRating>();
  for (const file of relevantFiles) complexityByTarget.set(stripMarkdownTicksLocal(file.path), file.complexity);
  return transcript.slice(-8).map((entry) => ({
    tool: entry.tool,
    ...(entry.target ? { target: entry.target } : {}),
    reasoning: entry.summary,
    ...(entry.target && complexityByTarget.has(entry.target)
      ? { complexity: complexityByTarget.get(entry.target)! }
      : {}),
  }));
}

/** Parse the "PLANS_JSON:" object into a normalized {@link PlanSet}. */
function extractPlanSet(text: string): PlanSet | undefined {
  const body = extractSection(text, "PLANS_JSON");
  if (!body) return undefined;
  const parsed = parseFirstJsonObject(body);
  if (!parsed || typeof parsed !== "object") return undefined;
  const rawPlans = (parsed as { plans?: unknown }).plans;
  if (!Array.isArray(rawPlans) || !rawPlans.length) return undefined;
  const plans: PlanDocument[] = [];
  for (const raw of rawPlans) {
    const doc = normalizePlanDocument(raw);
    if (doc) plans.push(doc);
  }
  if (!plans.length) return undefined;
  const declaredOrder = (parsed as { executionOrder?: unknown }).executionOrder;
  const validIds = new Set(plans.map((plan) => plan.id));
  const executionOrder = Array.isArray(declaredOrder)
    ? declaredOrder.filter((id): id is string => typeof id === "string" && validIds.has(id))
    : [];
  for (const plan of plans) if (!executionOrder.includes(plan.id)) executionOrder.push(plan.id);
  return { plans, executionOrder };
}

/** Turn a legacy PLAN_JSON step array into a single-plan {@link PlanSet}. */
function normalizeLegacyPlanJson(planJson: unknown[] | undefined): PlanSet | undefined {
  if (!planJson?.length) return undefined;
  const tasks = planJson.map((entry, index) => normalizePlanTask(entry, index)).filter((t): t is PlanTask => Boolean(t));
  if (!tasks.length) return undefined;
  const plan: PlanDocument = { id: "plan-1", title: "Implementation plan", summary: "", tasks };
  return { plans: [plan], executionOrder: [plan.id] };
}

function normalizePlanDocument(raw: unknown): PlanDocument | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : undefined;
  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  const tasks = rawTasks.map((task, index) => normalizePlanTask(task, index)).filter((t): t is PlanTask => Boolean(t));
  if (!id || !tasks.length) return undefined;
  return {
    id,
    title: typeof obj.title === "string" ? obj.title : id,
    ...(typeof obj.repo === "string" && obj.repo.trim() ? { repo: obj.repo.trim() } : {}),
    summary: typeof obj.summary === "string" ? obj.summary : "",
    tasks,
  };
}

function normalizePlanTask(raw: unknown, index: number): PlanTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const files = Array.isArray(obj.files)
    ? obj.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : [];
  const fileMutations: Record<string, PlanFileMutationMode> = {};
  if (obj.fileMutations && typeof obj.fileMutations === "object") {
    for (const [file, mode] of Object.entries(obj.fileMutations as Record<string, unknown>)) {
      if (mode === "edit" || mode === "write") fileMutations[file.trim()] = mode;
    }
  }
  const complexityRaw = typeof obj.complexity === "string" ? obj.complexity.toLowerCase() : undefined;
  const complexity: ComplexityRating =
    complexityRaw === "low" || complexityRaw === "medium" || complexityRaw === "high" ? complexityRaw : "medium";
  const orderRaw = typeof obj.order === "number" && Number.isFinite(obj.order) ? obj.order : index + 1;
  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `task-${index + 1}`,
    order: orderRaw,
    title: typeof obj.title === "string" ? obj.title : `Step ${index + 1}`,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    files,
    fileMutations,
    complexity,
    ...(Array.isArray(obj.tools)
      ? { tools: obj.tools.filter((t): t is string => typeof t === "string" && t.trim().length > 0) }
      : {}),
    ...(typeof obj.verification === "string" ? { verification: obj.verification } : {}),
    ...(typeof obj.risks === "string" ? { risks: obj.risks } : {}),
  };
}

/** Parse the "QA_PLAN:" object into a normalized {@link QaPlan}. */
function extractQaPlan(text: string): QaPlan | undefined {
  const body = extractSection(text, "QA_PLAN");
  if (!body) return undefined;
  const parsed = parseFirstJsonObject(body);
  if (!parsed || typeof parsed !== "object") return undefined;
  const rawChecks = (parsed as { checks?: unknown }).checks;
  if (!Array.isArray(rawChecks)) return undefined;
  const validMethods = new Set(["browser", "mobile", "api", "test", "typecheck", "static", "screenshot"]);
  const checks: QaCheck[] = [];
  for (const [index, raw] of rawChecks.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const description = typeof obj.description === "string" ? obj.description : undefined;
    const method = typeof obj.method === "string" && validMethods.has(obj.method) ? (obj.method as QaCheck["method"]) : undefined;
    if (!description || !method) continue;
    checks.push({
      id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `check-${index + 1}`,
      description,
      method,
      ...(Array.isArray(obj.targets)
        ? { targets: obj.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0) }
        : {}),
      ...(typeof obj.passed === "boolean" ? { passed: obj.passed } : {}),
      ...(typeof obj.evidence === "string" ? { evidence: obj.evidence } : {}),
    });
  }
  const stack = typeof (parsed as { stack?: unknown }).stack === "string" ? ((parsed as { stack: string }).stack) : undefined;
  return checks.length || stack ? { ...(stack ? { stack } : {}), checks } : undefined;
}

/** Extract and JSON.parse the first balanced {...} object from a text blob. */
function parseFirstJsonObject(body: string): unknown {
  for (const candidate of normalizePlanJsonCandidates(body)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
    const slice = extractFirstJsonObjectSlice(candidate);
    if (slice) {
      try {
        return JSON.parse(slice);
      } catch {}
    }
  }
  return undefined;
}

function extractFirstJsonObjectSlice(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }
  return undefined;
}

function extractPlanJson(text: string): unknown[] | undefined {
  const body = extractSection(text, "PLAN_JSON");
  if (!body) return undefined;
  for (const candidate of normalizePlanJsonCandidates(body)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return undefined;
}

function normalizePlanJsonCandidates(body: string): string[] {
  const out = new Set<string>();
  const trimmed = body.trim();
  if (trimmed) out.add(trimmed);
  const withoutMarkdown = trimmed
    .replace(/^\*\*+\s*/g, "")
    .replace(/\s*\*\*+$/g, "")
    .trim();
  if (withoutMarkdown) out.add(withoutMarkdown);
  const fenced = withoutMarkdown.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) out.add(fenced);
  const arraySlice = extractFirstJsonArray(withoutMarkdown);
  if (arraySlice) out.add(arraySlice);
  const fencedArraySlice = fenced ? extractFirstJsonArray(fenced) : undefined;
  if (fencedArraySlice) out.add(fencedArraySlice);
  return [...out];
}

function extractFirstJsonArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }
  return undefined;
}

function normalizeToolPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
}

function stripMarkdownTicksLocal(value: string): string {
  return value.replace(/^`+|`+$/g, "").trim();
}

function mergeProviderAssignments(
  preferred: PrepareProviderAssignmentMap | undefined,
  fallback: PrepareProviderAssignmentMap | undefined,
): PrepareProviderAssignmentMap | undefined {
  const out: PrepareProviderAssignmentMap = {};
  for (const phase of ["plan", "perform", "perfect"] as const) {
    const ids = [...(preferred?.[phase] ?? []), ...(fallback?.[phase] ?? [])]
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length) continue;
    out[phase] = [...new Set(ids)];
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeRelevantFiles(preferred: PrepareRelevantFile[], fallback: PrepareRelevantFile[]): PrepareRelevantFile[] {
  const out: PrepareRelevantFile[] = [];
  const seen = new Set<string>();
  for (const file of [...preferred, ...fallback]) {
    const key = file.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function deriveFallbackProviderAssignments(input: {
  task: string;
  projectCategory?: PhaseResult["projectCategory"];
  projectProfile?: string;
  availableProviders: RegisteredProviderSummary[];
}): PrepareProviderAssignmentMap | undefined {
  // TODO: tighten provider ranking so framework/runtime evidence dominates generic provider keywords.
  const providers = input.availableProviders.filter((provider) => provider.kind !== "tool" && !provider.id.startsWith("builtin:"));
  if (!providers.length) return undefined;
  const category = input.projectCategory ?? inferCategoryFromText(input.projectProfile ?? input.task);
  const context = `${input.task}\n${input.projectProfile ?? ""}`;
  const out: PrepareProviderAssignmentMap = {};
  for (const phase of ["plan", "perform", "perfect"] as const) {
    const ranked = providers
      .filter((provider) => provider.phases.includes(phase))
      .map((provider) => ({ provider, score: scoreProviderForPhase(provider, phase, context, category) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.provider.id.localeCompare(b.provider.id))
      .slice(0, 2)
      .map((entry) => entry.provider.id);
    if (ranked.length) out[phase] = ranked;
  }
  if (!out.perfect?.length) {
    const fallback = providers.find((provider) =>
      provider.phases.includes("perfect") && scoreProviderForPhase(provider, "perfect", context, category) >= 3);
    if (fallback) out.perfect = [fallback.id];
  }
  if (!out.perform?.length && category === "mobile") {
    const fallback = providers.find((provider) =>
      provider.phases.includes("perform") && /\bmobile|ios|android|flutter|react[- ]native|simulator|device\b/i.test(providerText(provider)));
    if (fallback) out.perform = [fallback.id];
  }
  return Object.keys(out).length ? out : undefined;
}

function scoreProviderForPhase(
  provider: RegisteredProviderSummary,
  phase: "plan" | "perform" | "perfect",
  context: string,
  category?: PhaseResult["projectCategory"],
): number {
  const text = providerText(provider);
  const overlaps = countKeywordOverlap(text, context);
  const docsLike = /\bdocs?|context|reference|search|spec\b/i.test(text);
  const designLike = /\bfigma|design|blender|asset|3d|multimodal|image\b/i.test(text);
  const verifyLike = /\bplaywright|browser|chrome|devtools|audit|verify|verification|test|screenshot|snapshot\b/i.test(text);
  const mobileLike = /\bmobile|ios|android|flutter|react[- ]native|simulator|device\b/i.test(text);
  let score = overlaps * 2;
  if (phase === "plan") {
    if (docsLike) score += 4;
    if (designLike) score += 1;
    if (category === "mobile" && mobileLike) score += 2;
  }
  if (phase === "perform") {
    if (designLike) score += 4;
    if (category === "mobile" && mobileLike) score += 5;
    if (category === "frontend" && /\bfigma|browser|chrome|devtools\b/i.test(text)) score += 2;
  }
  if (phase === "perfect") {
    if (verifyLike) score += 5;
    if (category === "mobile" && mobileLike) score += 5;
    if (category === "frontend" && /\bplaywright|browser|chrome|devtools\b/i.test(text)) score += 4;
  }
  return score;
}

function providerText(provider: RegisteredProviderSummary): string {
  return [provider.id, provider.name, provider.description, ...provider.toolNames].join(" ").toLowerCase();
}

function deriveFallbackRelevantFiles(input: {
  task: string;
  readPaths: string[];
  toolTranscript: PrepareToolTranscriptEntry[];
}): PrepareRelevantFile[] {
  const summariesByTarget = new Map<string, string>();
  for (const entry of input.toolTranscript) {
    if (entry.target) summariesByTarget.set(entry.target, entry.summary);
  }
  const taskText = input.task.toLowerCase();
  const candidates = [...new Set(input.readPaths)]
    .filter((filePath) => !isLikelyGeneratedPath(filePath))
    .map((filePath) => ({
      path: filePath,
      score: scoreRelevantFile(filePath, taskText),
      summary: summariesByTarget.get(filePath),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 6);
  return candidates.map(({ path: filePath, summary }) => ({
    path: filePath,
    complexity: classifyRelevantFileComplexity(filePath, taskText),
    why: buildRelevantFileWhy(filePath, taskText, summary),
  }));
}

function scoreRelevantFile(filePath: string, taskText: string): number {
  const base = path.basename(filePath).toLowerCase();
  let score = 1;
  if (/\b(main|app|index|router|navigation|screen|service|controller|provider|intercom)\b/i.test(base)) score += 3;
  if (/\b(package\.json|pubspec\.yaml|podfile|build\.gradle|settings\.gradle|androidmanifest\.xml|info\.plist)\b/i.test(base)) score += 2;
  if (/\.(ts|tsx|js|jsx|dart|swift|kt|java|go|py|rb|rs|php|cs)$/i.test(base)) score += 2;
  score += countKeywordOverlap(base, taskText);
  if (filePath.includes("/src/") || filePath.includes("/lib/")) score += 1;
  return score;
}

function classifyRelevantFileComplexity(filePath: string, taskText: string): PrepareRelevantFile["complexity"] {
  const base = path.basename(filePath).toLowerCase();
  let score = 0;
  if (/\b(main|app|index|router|navigation|screen|service|controller|provider)\b/i.test(base)) score += 2;
  if (/\.(ts|tsx|js|jsx|dart|swift|kt|java|go|py|rb|rs|php|cs)$/i.test(base)) score += 2;
  if (/\b(package\.json|pubspec\.yaml|podfile|build\.gradle|settings\.gradle|androidmanifest\.xml|info\.plist)\b/i.test(base)) score += 1;
  if (countKeywordOverlap(base, taskText) > 0) score += 1;
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function buildRelevantFileWhy(filePath: string, taskText: string, summary?: string): string {
  if (summary) return summary;
  const base = path.basename(filePath).toLowerCase();
  if (/\b(package\.json|pubspec\.yaml|podfile|build\.gradle|settings\.gradle|androidmanifest\.xml|info\.plist)\b/i.test(base)) {
    return "Dependency/config file inspected during Prepare";
  }
  const overlap = firstKeywordOverlap(base, taskText);
  if (overlap) return `Source/config file inspected during Prepare; matches task term "${overlap}"`;
  return "File inspected during Prepare and likely relevant to the task";
}

function countKeywordOverlap(left: string, right: string): number {
  const a = new Set(tokenizeKeywords(left));
  const b = new Set(tokenizeKeywords(right));
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function firstKeywordOverlap(left: string, right: string): string | undefined {
  const rightTokens = new Set(tokenizeKeywords(right));
  return tokenizeKeywords(left).find((token) => rightTokens.has(token));
}

function tokenizeKeywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !PREPARE_FALLBACK_STOPWORDS.has(token));
}

function isLikelyGeneratedPath(filePath: string): boolean {
  return /\/(node_modules|Pods|build|dist|DerivedData|\.dart_tool|\.git)\//.test(filePath);
}

function inferCategoryFromText(text: string): PhaseResult["projectCategory"] | undefined {
  const lower = text.toLowerCase();
  if (/\bmobile|flutter|react native|android|ios|expo\b/.test(lower)) return "mobile";
  if (/\bgame|godot|unity|unreal\b/.test(lower)) return "games";
  if (/\bfrontend|website|browser|vite|next|react|html|css\b/.test(lower)) return "frontend";
  if (lower.trim()) return "backend";
  return undefined;
}

const PREPARE_FALLBACK_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "what",
  "when",
  "where",
  "have",
  "will",
  "would",
  "should",
  "could",
  "task",
  "phase",
  "project",
  "file",
  "files",
  "tool",
  "tools",
  "using",
  "used",
  "need",
  "show",
  "tell",
  "does",
]);

function listedChildPaths(dir: string, output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "(empty)")
    .map((line) => {
      const isDir = line.endsWith("/");
      const name = isDir ? line.slice(0, -1) : line;
      return name ? path.join(dir, name) : "";
    })
    .filter(Boolean);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function suggestKnownPath(requested: string, known: string[]): string | undefined {
  let best: { candidate: string; score: number } | undefined;
  const reqBase = path.basename(requested).toLowerCase();
  const reqDir = path.dirname(requested).toLowerCase();
  for (const candidate of known) {
    const candBase = path.basename(candidate).toLowerCase();
    const candDir = path.dirname(candidate).toLowerCase();
    const full = levenshtein(requested.toLowerCase(), candidate.toLowerCase());
    const dirDist = levenshtein(reqDir, candDir);
    const baseDist = levenshtein(reqBase, candBase);
    const sameBase = reqBase === candBase;
    const score = Math.min(full, sameBase ? dirDist : Number.MAX_SAFE_INTEGER, dirDist + baseDist);
    const plausible =
      full <= 6 ||
      (sameBase && dirDist <= 6) ||
      (reqDir === candDir && baseDist <= 4) ||
      (dirDist <= 3 && baseDist <= 3);
    if (!plausible) continue;
    if (!best || score < best.score) best = { candidate, score };
  }
  return best?.candidate;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const next = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    next[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      next[j + 1] = Math.min(next[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    for (let j = 0; j < prev.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

function extractArtifacts(_phase: Phase, text: string): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  for (const key of ["SUMMARY", "PLAN_JSON", "PLAN", "ACCEPTANCE", "CHANGES", "VERDICT", "FIX"]) {
    const value = extractSingleOrSection(text, key);
    if (value) sections[key.toLowerCase().replace(/\s+/g, "_")] = value;
  }
  return sections;
}

function buildPhaseDisplayArtifact(
  phase: Phase,
  finalText: string,
  summary: string | undefined,
  chatSummary: string | undefined,
  toolCallIds: string[],
): PhaseDisplayArtifact | undefined {
  const trimmedSummary = resolvePhaseDisplaySummary(phase, finalText, summary, chatSummary);
  const orderedToolCallIds = toolCallIds.length ? [...toolCallIds] : undefined;
  if (!trimmedSummary && !orderedToolCallIds?.length) {
    return undefined;
  }
  return {
    summary: trimmedSummary ?? "",
    ...(orderedToolCallIds?.length ? { toolCallIds: orderedToolCallIds } : {}),
  };
}

function resolvePhaseDisplaySummary(
  phase: Phase,
  finalText: string,
  summary: string | undefined,
  chatSummary: string | undefined,
): string | undefined {
  if (phase !== "perfect") {
    return sanitizePhaseDisplaySummary(
      summary ?? deriveDisplaySummaryFallback(phase, finalText, chatSummary),
    );
  }

  const compactChatSummary = sanitizePhaseDisplaySummary(chatSummary);
  if (compactChatSummary) return compactChatSummary;

  const verdict = extractSingleOrSection(finalText, "VERDICT")
    ?.replace(/^VERDICT:\s*/i, "")
    .trim()
    .toUpperCase();
  const fix = sanitizePhaseDisplaySummary(extractSection(finalText, "FIX"));
  const reason = sanitizePerfectDisplaySummary(summary);

  if (verdict === "FAIL") {
    return fix ?? reason ?? "Verification did not pass yet.";
  }
  if (verdict === "PASS") {
    return reason ?? "Verification completed.";
  }
  return reason ?? fix ?? sanitizePhaseDisplaySummary(
    deriveDisplaySummaryFallback(phase, finalText, chatSummary),
  );
}

function sanitizePhaseDisplaySummary(summary: string | undefined): string | undefined {
  const trimmed = summary?.trim();
  if (!trimmed) return undefined;
  const withoutFences = trimmed.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutFences) return undefined;
  const lines = withoutFences
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    if (isStructuredSectionHeader(line)) break;
    if (/^[a-z0-9_-]+\s+\|\s+target=/i.test(line)) continue;
    if (/^(none|n\/a)$/i.test(line)) continue;
    kept.push(line);
  }
  const normalized = kept.join("\n").trim();
  return normalized || undefined;
}

function sanitizePerfectDisplaySummary(summary: string | undefined): string | undefined {
  const normalized = sanitizePhaseDisplaySummary(summary);
  if (!normalized) return undefined;
  const withoutVerdict = normalized
    .split(/\r?\n/)
    .filter((line) => !/^VERDICT:\s*(PASS|FAIL)\b/i.test(line.trim()))
    .join("\n")
    .trim();
  return withoutVerdict || undefined;
}

function deriveDisplaySummaryFallback(
  phase: Phase,
  finalText: string,
  chatSummary: string | undefined,
): string | undefined {
  const compactChatSummary = sanitizePhaseDisplaySummary(chatSummary);
  if (compactChatSummary) return compactChatSummary;

  if (phase === "perform") {
    const changes = extractSection(finalText, "CHANGES");
    const compactChanges = sanitizePhaseDisplaySummary(changes);
    if (compactChanges) return compactChanges;
  }

  if (phase === "perfect") {
    const fix = extractSection(finalText, "FIX");
    const compactFix = sanitizePhaseDisplaySummary(fix);
    if (compactFix) return compactFix;
    const verdict = extractSingleOrSection(finalText, "VERDICT")
      ?.replace(/^VERDICT:\s*/i, "")
      .trim()
      .toUpperCase();
    if (verdict === "FAIL") return "Verification did not pass yet.";
    if (verdict === "PASS") return "Verification completed.";
  }

  return sanitizePhaseSummaryFallback(finalText);
}

function buildPhaseFailureSummary(input: {
  phase: Phase;
  error?: string;
  writtenPaths: string[];
  readPaths: string[];
  toolTranscript: PrepareToolTranscriptEntry[];
}): string | undefined {
  if (!input.error || input.error === "aborted") return undefined;
  const lines: string[] = [];
  if (input.phase === "perform") {
    lines.push("Implementation failed before completion.");
  } else if (input.phase === "perfect") {
    lines.push("Verification failed before completion.");
  } else if (input.phase === "plan") {
    lines.push("Planning failed before completion.");
  } else {
    lines.push("Preparation failed before completion.");
  }

  const changed = input.writtenPaths.slice(-3);
  if (changed.length) {
    lines.push(`Files changed before failure: ${changed.join(", ")}`);
  } else {
    const inspected = input.readPaths.slice(-3);
    if (inspected.length) {
      lines.push(`Files inspected before failure: ${inspected.join(", ")}`);
    }
  }

  const recent = input.toolTranscript
    .slice(-3)
    .map((entry) =>
      entry.target?.trim()
        ? `${entry.tool} ${entry.target.trim()}`
        : entry.tool,
    );
  if (recent.length) {
    lines.push(`Recent tool activity: ${recent.join("; ")}`);
  }

  lines.push(`Error: ${input.error}`);
  return lines.join("\n");
}

function buildPhaseCompletionSummary(input: {
  phase: Phase;
  verified?: boolean;
  writtenPaths: string[];
  readPaths: string[];
  toolTranscript: PrepareToolTranscriptEntry[];
}): string {
  const lines: string[] = [];
  if (input.phase === "perform") {
    lines.push("Implementation completed.");
  } else if (input.phase === "perfect") {
    lines.push(input.verified === false ? "Verification did not pass yet." : "Verification completed.");
  } else if (input.phase === "plan") {
    lines.push("Planning completed.");
  } else {
    lines.push("Preparation completed.");
  }

  const changed = input.writtenPaths.slice(-3);
  if (changed.length) {
    lines.push(`Files changed: ${changed.join(", ")}`);
  } else {
    const inspected = input.readPaths.slice(-3);
    if (inspected.length) {
      lines.push(`Files inspected: ${inspected.join(", ")}`);
    }
  }

  const recent = input.toolTranscript
    .slice(-3)
    .map((entry) =>
      entry.target?.trim()
        ? `${entry.tool} ${entry.target.trim()}`
        : entry.tool,
    );
  if (recent.length) {
    lines.push(`Recent tool activity: ${recent.join("; ")}`);
  }

  return lines.join("\n");
}

function ensurePhaseSummary(input: {
  phase: Phase;
  summary: string;
  pendingUserQuestion?: AskUserQuestionRequest;
  error?: string;
  verified?: boolean;
  writtenPaths: string[];
  readPaths: string[];
  toolTranscript: PrepareToolTranscriptEntry[];
}): string {
  const trimmed = input.summary.trim();
  if (input.pendingUserQuestion) {
    return buildPendingQuestionSummary(input.pendingUserQuestion, trimmed);
  }
  if (trimmed) {
    return trimmed;
  }
  const failureSummary = buildPhaseFailureSummary({
    phase: input.phase,
    error: input.error,
    writtenPaths: input.writtenPaths,
    readPaths: input.readPaths,
    toolTranscript: input.toolTranscript,
  });
  if (failureSummary) return failureSummary;
  return buildPhaseCompletionSummary({
    phase: input.phase,
    verified: input.verified,
    writtenPaths: input.writtenPaths,
    readPaths: input.readPaths,
    toolTranscript: input.toolTranscript,
  });
}

/** Explicit verdict only: true/false when a `VERDICT: PASS|FAIL` line is present, else undefined. */
function matchVerdict(text: string): boolean | undefined {
  const m = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  return m ? m[1]!.toUpperCase() === "PASS" : undefined;
}

/**
 * One bounded, tool-free turn that asks the phase model for its final verdict.
 * Used only when Perfect ended without an explicit VERDICT line.
 */
async function elicitVerdict(
  llm: LLMBridge,
  model: Model,
  context: Context,
  signal?: AbortSignal,
): Promise<{ verdict: boolean | undefined; usage: import("../types.js").Usage }> {
  const ctx: Context = {
    systemPrompt: context.systemPrompt,
    messages: [
      ...context.messages,
      {
        role: "user",
        content:
          'Based on your verification above, give your final verdict now. Reply with EXACTLY one line and nothing else: "VERDICT: PASS" or "VERDICT: FAIL".',
        timestamp: Date.now(),
      },
    ],
    // No tools — force a direct textual verdict.
  };
  const msg = await llm.complete(model, ctx, { temperature: 0, signal });
  const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  return { verdict: matchVerdict(text), usage: msg.usage };
}

/** Minimal abort error without depending on DOM lib types. */
class DOMExceptionLike extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AbortError";
  }
}
