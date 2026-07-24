/**
 * turing-harness core types.
 *
 * These types are intentionally structurally compatible with `@mariozechner/pi-ai`
 * and `@mariozechner/pi-agent` so that a UI written against pi (message rendering,
 * streaming events, tool definitions) can consume this harness with zero/near-zero
 * changes. See README "pi compatibility" for the mapping.
 *
 * Everything here is provider-agnostic and DOM-free so it runs in Node, a bundler,
 * or an Electron main/renderer process.
 */

// ---------------------------------------------------------------------------
// JSON Schema (typebox-compatible surface for Tool.parameters)
// ---------------------------------------------------------------------------

/**
 * A minimal JSON-Schema shape. TypeBox's `TSchema` is structurally a JSON schema,
 * so pi tools built with `Type.Object({...})` satisfy this type and vice-versa.
 */
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Providers / models
// ---------------------------------------------------------------------------

export type Api =
  | "openai-completions"
  | "openrouter"
  | "anthropic-messages"
  | "google-generative-ai"
  | (string & {});

export type Provider = "openrouter" | "openai" | "anthropic" | "google" | (string & {});

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The modalities a model can accept as input. Extends pi's `("text"|"image")[]`. */
export type Modality = "text" | "image" | "video" | "audio" | "file";

export interface ModelCost {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Model descriptor. Mirrors pi's `Model<TApi>` (adds `video`/`audio`/`file`
 * modalities and an optional `openRouterSlug`).
 */
export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  /** Base URL of the API. Defaults to OpenRouter for the `openrouter` api. */
  baseUrl: string;
  reasoning: boolean;
  input: Modality[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  /** OpenRouter model slug, e.g. "anthropic/claude-opus-4.8". Defaults to `id`. */
  openRouterSlug?: string;
}

// ---------------------------------------------------------------------------
// Content blocks (pi-compatible, multimodal-extended)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

/** Inline image (pi-compatible). */
export interface ImageContent {
  type: "image";
  /** base64-encoded bytes (no data: prefix). */
  data: string;
  mimeType: string;
}

/**
 * Media content covering the remaining multimodal inputs (req #1).
 * `data` may be omitted when the media is referenced by `uri` (address-only,
 * see {@link MediaRef}) to keep tool calls lightweight.
 */
export interface MediaContent {
  type: "audio" | "video" | "file";
  /** base64 bytes, present only when the payload is inlined. */
  data?: string;
  /** file path or URL. Preferred over `data` for large media. */
  uri?: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type UserContent = TextContent | ImageContent | MediaContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type ToolResultContent = TextContent | ImageContent | MediaContent;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Map a 0..1 complexity score to a coarse low/medium/high rating. */
export function scoreToRating(score: number): "low" | "medium" | "high" {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

/** A representative 0..1 score for a coarse rating (used to bias model selection
 *  when a phase inherits a per-file / per-task complexity rating). */
export function ratingToScore(rating: "low" | "medium" | "high"): number {
  return rating === "high" ? 0.8 : rating === "medium" ? 0.5 : 0.2;
}

// ---------------------------------------------------------------------------
// Messages (pi-compatible)
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: string | UserContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Tools (pi-compatible: Tool + AgentTool)
// ---------------------------------------------------------------------------

export interface Tool<TParameters extends JSONSchema = JSONSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

/** What a tool's `execute` returns. Mirrors pi's `{ output?, details?, content? }`. */
export interface ToolResult<TDetails = unknown> {
  /** LLM-facing text (goes into the tool-result message). */
  output?: string;
  /** UI-facing structured payload (not shown to the model). */
  details?: TDetails;
  /** Extra content blocks, e.g. a screenshot the model should see. */
  content?: ToolResultContent[];
  /** Optional error flag; also inferred when `execute` throws. */
  isError?: boolean;
}

/**
 * The execution context handed to every tool. Carries the harness services a tool
 * may need (LLM access, permission gate, logger, workspace root) without the tool
 * having to import the orchestrator.
 */
export interface ToolContext {
  /** Absolute workspace root the tool should operate within. */
  cwd: string;
  signal?: AbortSignal;
  /** Per-call resolved model (from permission callback), if any. */
  model?: Model;
  /** Structured logger; also feeds the activity_monitor tool. */
  log: (entry: LogEntry) => void;
  /** Call another model via OpenRouter (used by asset/audit tools). */
  llm?: LLMBridge;
  /** The registry, so meta-tools (phases) can resolve their scoped toolset. */
  registry?: unknown;
  /**
   * Optional host callback: present the user with a clarifying question and
   * block until they answer. The tool should `await` this and return the
   * answer as part of the tool result, so the LLM continues in the SAME
   * conversation context (no new run is required).
   *
   * When this is absent, the tool must surface the question through
   * `ToolResult.details` (`kind: "ask_user_question"`) so a non-blocking host
   * can handle it via a restart. Backwards-compatible fallback.
   */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
}

/** pi-compatible AgentTool: a Tool plus an `execute` implementation. */
export interface AgentTool<
  TParameters extends JSONSchema = JSONSchema,
  TDetails = unknown,
> extends Tool<TParameters> {
  /**
   * Whether invoking this tool mutates state (filesystem, network side effects,
   * spawning processes). Drives the "ask only for mutation calls" permission mode.
   */
  mutates?: boolean;
  /** Which 4P phase(s) this tool belongs to. Empty ⇒ available to all phases. */
  phases?: Phase[];
  /**
   * Optional static complexity hint (0..1) used for model selection before the
   * call runs. The tool may also return a measured complexity in its result.
   */
  complexityHint?: number;
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult<TDetails>>;
}

// ---------------------------------------------------------------------------
// Context (pi-compatible)
// ---------------------------------------------------------------------------

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

// ---------------------------------------------------------------------------
// Streaming events (pi-compatible AssistantMessageEvent)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export type AssistantMessageEventStream = AsyncIterable<AssistantMessageEvent>;

// ---------------------------------------------------------------------------
// Attachments (pi-compatible, multimodal + reference-based, req #1 & #7)
// ---------------------------------------------------------------------------

export type AttachmentType = "image" | "document" | "audio" | "video" | "file";

/**
 * A reference to media by address + summary rather than payload. Per req #7 the
 * harness carries the address and a summary between tool calls, and only reads the
 * bytes when a step actually needs them.
 */
export interface MediaRef {
  /** Stable id used to look the media up later. */
  id: string;
  /** Filesystem path or URL. */
  uri: string;
  mimeType: string;
  /** Human/LLM-readable summary produced by a prior run. */
  summary?: string;
  /** Size in bytes, if known. */
  size?: number;
}

/** pi-compatible Attachment, extended with audio/video/file and lazy content. */
export interface Attachment {
  id: string;
  type: AttachmentType;
  fileName: string;
  mimeType: string;
  size: number;
  /** base64 content. Optional here: may be absent when only a `ref` is carried. */
  content?: string;
  /** Address + summary reference; preferred for large/binary media. */
  ref?: MediaRef;
  extractedText?: string;
  preview?: string;
}

// ---------------------------------------------------------------------------
// Agent-level events (pi-agent compatible) + 4P extensions
// ---------------------------------------------------------------------------

export type AppMessage = Message | (UserMessage & { attachments?: Attachment[] });

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AppMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AppMessage; toolResults: AppMessage[] }
  | { type: "message_start"; message: AppMessage }
  | { type: "message_update"; message: AppMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AppMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  // ---- 4P orchestration extensions (namespaced so pi UIs can ignore them) ----
  | { type: "phase_start"; phase: Phase; model: string }
  | { type: "phase_end"; phase: Phase; result: PhaseResult }
  | { type: "chain_start"; task: string }
  | { type: "chain_iteration"; iteration: number }
  | { type: "chain_end"; success: boolean; iterations: number }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_decision"; request: PermissionRequest; decision: PermissionDecision };

// ---------------------------------------------------------------------------
// The 4P model (req #3, #4)
// ---------------------------------------------------------------------------

export type Phase = "prepare" | "plan" | "perform" | "perfect";

export const PHASES: Phase[] = ["prepare", "plan", "perform", "perfect"];

export interface ToolSnippet {
  tool: string;
  path?: string;
  snippet: string;
}

export interface FileMemoryUpdate {
  path: string;
  summary: string;
  tags?: string[];
  role?: "entrypoint" | "config" | "component" | "schema" | "test" | "script" | "doc" | "unknown";
}

export interface RegisteredProviderSummary {
  id: string;
  kind: "tool" | "mcp" | "skill";
  name: string;
  description: string;
  phases: Phase[];
  toolNames: string[];
}

export interface PrepareProviderAssignmentMap {
  plan?: string[];
  perform?: string[];
  perfect?: string[];
}

export interface PrepareBlastRadiusSummary {
  directFiles: string[];
  directSymbols?: string[];
  notes?: string[];
}

export interface PrepareRelevantFile {
  path: string;
  complexity: "low" | "medium" | "high";
  why: string;
  blastRadius?: PrepareBlastRadiusSummary;
}

export interface PrepareToolTranscriptEntry {
  tool: string;
  target?: string;
  summary: string;
}

export interface ReadFileContent {
  path: string;
  content: string;
}

export type PlanFileMutationMode = "edit" | "write";

/** Complexity rating shared by Prepare file reads and Plan tasks (req: complexity flows across phases). */
export type ComplexityRating = "low" | "medium" | "high";

/**
 * A single ordered implementation task inside a {@link PlanDocument}. Perform
 * executes these in `order` and inherits each task's `complexity` when it reads,
 * edits, or writes the task's files (so per-call model selection is grounded in
 * the planner's judgement rather than re-estimated blindly).
 */
export interface PlanTask {
  id: string;
  /** 1-based execution order within the owning plan. */
  order: number;
  title: string;
  summary: string;
  /** Absolute (or cwd-relative) file addresses this task touches. */
  files: string[];
  /** Per-file mutation intent; every file in `files` should have a mode. */
  fileMutations: Record<string, PlanFileMutationMode>;
  /** Planner-judged complexity of this task; inherited by Perform's edits/writes. */
  complexity: ComplexityRating;
  /** Provider ids / tool names this task needs beyond read/write/edit. */
  tools?: string[];
  /** What must be true for this task to be considered done. */
  verification?: string;
  /** Known risks / caveats for this task. */
  risks?: string;
}

/**
 * One plan. A single-repo task yields exactly one plan; a complex multi-repo
 * task yields several, run in {@link PlanSet.executionOrder}. Each plan owns an
 * ordered list of {@link PlanTask}s.
 */
export interface PlanDocument {
  id: string;
  title: string;
  /** Optional repo / workspace root this plan applies to (multi-repo tasks). */
  repo?: string;
  summary: string;
  tasks: PlanTask[];
}

/**
 * The full planning output: one or more {@link PlanDocument}s plus the order the
 * orchestrator should run them in. Backward-compatible: a legacy single
 * `PLAN_JSON` step array is normalized into a one-plan `PlanSet`.
 */
export interface PlanSet {
  plans: PlanDocument[];
  /** Plan ids in the order the orchestrator should execute them. */
  executionOrder: string[];
}

/**
 * A QA check Perfect derives from the tech stack + changed files. Verified
 * against the running project; a failed check contributes to the FIX handoff.
 */
export interface QaCheck {
  id: string;
  /** What is being verified (e.g. "landing page renders the new title"). */
  description: string;
  /** How it is verified: the tool/surface Perfect should use. */
  method: "browser" | "mobile" | "api" | "test" | "typecheck" | "static" | "screenshot";
  /** Files/surfaces this check covers. */
  targets?: string[];
  /** Filled in after running: did the check pass? */
  passed?: boolean;
  /** Evidence / observed-vs-expected note. */
  evidence?: string;
}

/** Perfect's tech-stack-aware QA plan over the changed files. */
export interface QaPlan {
  /** The stack Perfect inferred the checks from (echoed from the profile). */
  stack?: string;
  checks: QaCheck[];
}

/**
 * A single continuity entry in a phase's tool-chain handover. Unlike the raw
 * LLM transcript, this is the curated set of tool activity a phase decides is
 * worth carrying forward (relevant reads + their reasoning + complexity).
 */
export interface ToolChainEntry {
  tool: string;
  /** Path or query the tool acted on. */
  target?: string;
  /** One-line reasoning: why this activity matters downstream. */
  reasoning: string;
  /** Complexity of the activity, if known (inherited by later phases). */
  complexity?: ComplexityRating;
}

/**
 * The structured, per-phase handoff object every phase produces for the next
 * phase. It complements (does not replace) the individual PhaseResult fields;
 * hosts and downstream phases can consume this single object for continuity.
 */
export interface PhaseHandoff {
  from: Phase;
  /** The phase intended to consume this handoff next. */
  to?: Phase;
  /** Files that matter downstream, with reasoning + complexity. */
  files: PrepareRelevantFile[];
  /** Curated tool-chain continuity (not the raw transcript). */
  toolChain: ToolChainEntry[];
  /** Free-form reasoning summary for the next phase. */
  reasoning?: string;
}

export interface AskUserQuestionRequest {
  phase: Phase;
  question: string;
  kind?: "clarification" | "plan_review";
  reason?: string;
  placeholder?: string;
  answerMode?: "text" | "single-select" | "multi-select";
  options?: string[];
}

export type TranscriptMode = "full" | "compact";

export type ThreadRunDisposition = "completed" | "pending_user_question" | "aborted" | "failed";

export type ThreadFollowUpMode = "fresh" | "structured_continue";

export interface ThreadRunSnapshot {
  timestamp: number;
  task: string;
  route: "conversational" | "task";
  disposition: ThreadRunDisposition;
  recommendedFollowUpMode: ThreadFollowUpMode;
  summary: string;
  contextFiles?: ReadFileContent[];
  planSummary?: string;
  planJson?: unknown[];
  discoveredPaths?: string[];
  readPaths?: string[];
  writtenPaths?: string[];
  relevantFiles?: PrepareRelevantFile[];
  verified?: boolean;
  pendingUserQuestion?: AskUserQuestionRequest;
  error?: string;
}

export interface ThreadFollowUpContext {
  mode: ThreadFollowUpMode;
  previousRun: ThreadRunSnapshot;
}

export interface PhaseDisplayArtifact {
  /** Host-facing markdown phase summary meant for chat/timeline cards. */
  summary: string;
  /** Optional phase label override for hosts that want to render a custom title. */
  label?: string;
  /** Ordered tool calls the phase emitted, for hosts that want to group them. */
  toolCallIds?: string[];
}

export interface PhaseResult {
  phase: Phase;
  /** Freeform summary the next phase / orchestrator can reason about. */
  summary: string;
  /** Host-facing display artifact, separate from the reasoning/handoff summary. */
  display?: PhaseDisplayArtifact;
  /**
   * Short, user-message-anchored UI summary with light markdown styling
   * (bold/inline-code for files & commands, bullet or numbered lists when long).
   * This is the "ui-summary" common parameter each phase produces for the client.
   * Distinct from `summary` (the reasoning/handoff briefing for the next phase).
   */
  uiSummary?: string;
  /**
   * The curated tool-chain continuity this phase hands to the next phase — the
   * relevant tool activity with reasoning + complexity, NOT the raw transcript.
   */
  toolChain?: ToolChainEntry[];
  /** The structured handoff object for the next phase (files + toolChain + reasoning). */
  handoff?: PhaseHandoff;
  /** Structured artifacts produced (plan steps, file addresses, findings...). */
  artifacts?: Record<string, unknown>;
  /** Media produced/consumed, carried by reference (address + summary). */
  refs?: MediaRef[];
  /** Absolute paths this phase confirmed exist (read/write/edit/ls/grep). Carried
   *  forward into the next phase's opening so it doesn't have to guess from prose.
   *  Only SUCCESSFUL tool calls contribute — failed/rejected calls never pollute
   *  the handover. */
  discoveredPaths?: string[];
  /** Absolute file paths this phase SUCCESSFULLY read (`read`/`ls`/`grep`/`cat`).
   *  Handed to the next phase (Prepare→Plan, Plan→Perform) so it knows exactly
   *  what was inspected without re-reading. */
  readPaths?: string[];
  /** Last 1-2 successful tool outputs (truncated), for short context carry-over. */
  recentToolSnippets?: ToolSnippet[];
  /** Files actually written/edited by `write` or `edit` in this chain (SUCCESS
   *  only). Handed to Perfect to verify, and carried across retry iterations so
   *  they aren't re-written or re-verified. */
  writtenPaths?: string[];
  /** The project profile Prepare established — its type/stack and how to run &
   *  verify it (e.g. "static HTML site (no package.json) → static file server").
   *  Threaded into every later phase so Plan/Perform/Perfect pick correct
   *  run/verify commands instead of re-guessing the stack each phase. */
  projectProfile?: string;
  /** The coarse project category Prepare inferred from evidence, used by the host
   *  to reconcile stale project memory/presets before Plan starts. */
  projectCategory?: "frontend" | "mobile" | "games" | "backend";
  /** Structured runbook Prepare established for later phases. These are kept
   *  separate from the one-line project profile so the host can thread concrete
   *  run/stop/verify commands forward without asking later phases to re-derive
   *  them from prose. */
  projectRunbook?: {
    run?: string;
    stop?: string;
    verify?: string;
  };
  /** The MCP servers / skills / tools Prepare identified as relevant to the task.
   *  Threaded forward so Plan can plan around them, Perform prefers them over
   *  bash, and Perfect verifies with them. */
  capabilities?: string;
  /** Structured provider assignments Prepare selected for downstream phases. */
  providerAssignments?: PrepareProviderAssignmentMap;
  /** The focused relevant-file shortlist Prepare assembled for downstream phases. */
  relevantFiles?: PrepareRelevantFile[];
  /** Compact transcript of successful Prepare tool work, derived from real tool calls. */
  toolTranscript?: PrepareToolTranscriptEntry[];
  /** Full contents of files successfully read during the phase, used for direct handoff. */
  readFileContents?: ReadFileContent[];
  /** Metadata-only view of the registered providers Prepare saw while deciding
   *  which MCPs/skills/providers later phases should use. */
  registeredProvidersSeen?: RegisteredProviderSummary[];
  /** Durable project-memory corrections/facts Prepare wants the host to persist
   *  after validating the filesystem. Interpreted by the session/host layer. */
  memoryUpdates?: string[];
  /** Durable file-memory updates Prepare wants the host to persist after it has
   *  inspected key files. */
  fileMemoryUpdates?: FileMemoryUpdate[];
  /** Structured clarification request emitted when a phase must pause for user input. */
  pendingUserQuestion?: AskUserQuestionRequest;
  /** Structured multi-plan output (Plan phase). One plan for a single-repo task,
   *  several ordered plans for a complex/multi-repo task. Normalized from either
   *  the new `PLANS_JSON` block or a legacy `PLAN_JSON` step array. */
  planSet?: PlanSet;
  /** Perfect's tech-stack-aware QA plan over the changed files. */
  qaPlan?: QaPlan;
  /** Only meaningful for the "perfect" phase: did verification pass? */
  verified?: boolean;
  /** Measured complexity of the work done in this phase (0..1). */
  complexity: number;
  usage: Usage;
  messages: Message[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Complexity + model selection (req #7)
// ---------------------------------------------------------------------------

/** A 0..1 score plus the signals that produced it, for auditability. */
export interface Complexity {
  score: number;
  signals: {
    /** number of tools available / likely needed */
    toolBreadth?: number;
    /** prompt/context size proxy */
    contextSize?: number;
    /** presence & weight of attachments */
    attachmentWeight?: number;
    /** whether the op mutates state */
    mutation?: boolean;
    [k: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Permissions (req #7)
// ---------------------------------------------------------------------------

export type PermissionMode = "ask-all" | "bypass" | "ask-mutations";

/** A named choice a permission callback may offer/return (e.g. "run once",
 *  "always allow", "run in sandbox"). The host surfaces these to the user and
 *  echoes the chosen one back in {@link PermissionDecision.option}. */
export interface PermissionOption {
  /** Stable id echoed back in the decision. */
  id: string;
  /** Human-facing label. */
  label: string;
  /** Whether choosing this option allows the call. */
  allow: boolean;
}

/** Where a request's complexity value came from. Lets the client show whether a
 *  rating was inherited from Prepare's per-file rating or Plan's per-task rating
 *  vs. freshly estimated. */
export type ComplexitySource = "estimated" | "prepare-file" | "plan-task";

/** Emitted to the permission callback before every phase/tool call. */
export interface PermissionRequest {
  kind: "tool" | "phase";
  /** Tool name or phase name. */
  name: string;
  mutates: boolean;
  args?: Record<string, unknown>;
  /** Estimated (or inherited) complexity of the operation (drives model selection). */
  complexity: Complexity;
  /** Coarse rating derived from `complexity.score`, for quick UI display. */
  complexityRating?: ComplexityRating;
  /** How `complexity` was derived — estimated, or inherited from Prepare/Plan. */
  complexitySource?: ComplexitySource;
  /** Attachments/refs relevant to this call (address + summary, not bytes). */
  refs?: MediaRef[];
  phase?: Phase;
  /** Optional named choices the host may present to the user. */
  options?: PermissionOption[];
}

/** What the permission callback returns. */
export interface PermissionDecision {
  allowed: boolean;
  /**
   * OpenRouter model slug to run this call with. If omitted the orchestrator's
   * (phase) model is used (req #5/#7). The client may send any OpenRouter slug.
   */
  model?: string;
  /**
   * UI emission toggles the client may send back with the decision, next to
   * `model`. They are honored from the PHASE-scoped decision (which is applied
   * before the phase streams):
   *   - `reasoning`: emit the phase model's reasoning/thinking to the UI stream.
   *   - `transcript`: emit the full assistant transcript (text + tool calls) vs a
   *     compact tool-calls-only stream.
   * Each is independent: set both `true` and both are emitted; set one and only
   * that one is; omit a flag and the configured default (`transcriptMode`, and
   * reasoning-on for a full transcript) applies.
   */
  reasoning?: boolean;
  transcript?: boolean;
  /** The id of the {@link PermissionOption} the user chose, if options were offered. */
  option?: string;
  /** Optional reason (logged / shown in UI). */
  reason?: string;
}

/**
 * Permission gate. Given a request, returns a decision (allow/deny + model).
 * In `bypass` mode it is never called; in `ask-mutations` it is called only for
 * mutating calls.
 */
export type PermissionCallback = (
  req: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

// ---------------------------------------------------------------------------
// Logging (feeds activity_monitor, req #6)
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  /** Searchable tags used by activity_monitor to cut noise (req #6). */
  tags: string[];
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// LLM bridge (implemented by the OpenRouter layer, consumed by tools)
// ---------------------------------------------------------------------------

export interface LLMBridge {
  complete(model: Model, context: Context, options?: LLMOptions): Promise<AssistantMessage>;
  stream(model: Model, context: Context, options?: LLMOptions): AssistantMessageEventStream;
  /** Resolve a model slug (e.g. "anthropic/claude-opus-4.8") to a Model descriptor. */
  resolveModel(slug: string): Model;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  signal?: AbortSignal;
  apiKey?: string;
  /** Extra headers merged into the request (OpenRouter attribution, etc.). */
  headers?: Record<string, string>;
}
