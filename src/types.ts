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
  /**
   * Human-readable label for UI surfaces — what a person watching the run sees
   * instead of the raw `name`. Purely presentational: it is NOT part of the
   * tool payload sent to the model (see `toLLMTools` in the loop), so changing
   * it never changes model behaviour. Hosts that render a header from the tool
   * name would otherwise show "MEDIA ANALYSIS / media_analysis" — a title that
   * repeats the name and says nothing. Say what the call DOES, in the user's
   * terms ("Analyze an image or video"). A title that merely restates the name
   * ("Media Analysis" for `media_analysis`) is dropped by the registry: when
   * this is absent the host must render NOTHING, not the raw name — a header
   * that repeats the identifier below it is noise.
   */
  title?: string;
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
  /**
   * Token usage incurred INSIDE the tool (e.g. an internal authoring-model call).
   * Absent for pure-IO tools. When present, the phase runner folds it into the
   * phase/chain total so cost accounting stays honest for tools that make their
   * own LLM calls (contrast with phase-model turns, accounted by the runner).
   */
  usage?: Usage;
  /**
   * Complexity the tool MEASURED by looking at the artifact it touched (as
   * opposed to `AgentTool.complexityHint`, a static guess made before the call
   * runs). Only comprehension-capable tools set this — today the staged `read`,
   * which rates the file it just loaded.
   *
   * The loop folds this into its per-path complexity map, so the rating becomes
   * the inherited FLOOR for later calls on the same path (a subsequent `edit` on
   * a file measured `high` arrives at the permission gate already rated `high`,
   * with `complexitySource: "tool-measured"`). This is how difficulty discovered
   * mid-run propagates forward without the runner reasoning over content.
   */
  measuredComplexity?: ComplexityRating;
  /** Absolute path `measuredComplexity` applies to. Defaults to the call's path
   *  argument when omitted. */
  measuredPath?: string;
}

/**
 * An image in the run's LIVE attachment set — a design the user attached to the
 * prompt, routed to a plan step, or handed over mid-run via `ask_user_question`.
 *
 * `targets`/`label` exist so the set can be routed per file rather than applied
 * wholesale: a run carrying three screen designs must author each file from the
 * one design that depicts it. See `multimodal/attachment-routing.ts` for the
 * order of evidence and what happens when it cannot be established.
 */
export interface LiveImage {
  path: string;
  mimeType: string;
  /** Files this attachment is FOR. When set, it is a candidate for these only. */
  targets?: string[];
  /** Short human label (a plan note, or what media_analysis called it). */
  label?: string;
  /**
   * The role attachment triage assigned this image: `ui-replicate` (a design to
   * rebuild), `ui-bug` (a defect being pointed at), `informational` (text/data
   * the task should KNOW — a spec, a stack trace, a screenshot of logs), or
   * `other`. Absent when the run did not triage.
   *
   * Load-bearing for VISUAL VERIFICATION, not just authoring. `activity_inspect`
   * compares a live capture against "the run's reference image", and without a
   * role that phrase resolves to whichever attachment happened to be first — so
   * a run whose user attached a stack trace could have its screen graded against
   * the stack trace. See `resolveReference` in `tools/builtin/activity-monitor.ts`.
   */
  category?: string;
}

/**
 * Context handed to an authoring-model pass inside a mutating tool, so a host
 * can swap in a second model (Model B) to author a file's bytes from scratch
 * via a permission-decision `authorModel`. Carries just enough for the authoring
 * model to produce content coherent with the task and surrounding code, without
 * the runner itself reasoning over file contents.
 */
export interface AuthoringContext {
  /** The originating task the chain is working on. */
  task: string;
  /** Structured PLAN_JSON handed from Plan to Perform, if any. */
  planJson?: unknown[];
  /** Bounded snippets of surrounding files (from Plan's handoff). */
  fileSnippets?: Array<{ path: string; content: string }>;
  /**
   * Image references for a multimodal authoring pass. When present, the authoring
   * model is a vision-capable model that authors the file bytes FROM the images
   * (e.g. a design mockup → HTML). Each entry is a path/URL the tool reads itself
   * (the media_analysis pattern), not inline base64 on the wire.
   *
   * An entry may declare `targets` (the files it depicts) and a `label`; both feed
   * the per-file routing in `attachment-routing.ts`, which is what stops a run
   * holding several designs from handing all of them to every write.
   */
  images?: LiveImage[];
  /**
   * Section blueprints returned by `inspiration_generator` earlier in this run.
   *
   * Load-bearing under `authorOnlyWrites`. The blueprint arrives as a tool result
   * in the DRIVER's conversation, but the driver does not write the bytes — a
   * second model does, from task + current file + anchor. So the run would look
   * up a reference, and then author the UI having never seen it: the driver's
   * one-line paraphrase ("a gradient hero") is all that survived, which is not a
   * layout.
   *
   * It travels with a hard reuse boundary (see the authoring prompt): the
   * blueprint describes SOMEONE ELSE'S design and legitimately carries their
   * copy, hex values, imagery and logos. Structure, rhythm and motion are the
   * reusable part; the content is not, and shipping it verbatim is the one
   * failure mode this field could otherwise cause.
   */
  designReference?: unknown[];
  /**
   * Informational facts lifted out of a `media_analysis` call earlier in this
   * loop — today, the verbatim OCR text of an attachment categorized
   * `informational`. Travels the same path as `designReference`: the driver sees
   * the tool result, but the model that authors the bytes does not, so without
   * this the OCR text the loop just paid for is lost before write/edit.
   *
   * Distinct from `images` (which carries pixels for replication): this is text
   * the task should *know* (a stack trace, a spec, captured data), not rebuild.
   * Append-only across a loop; the authoring prompt renders it as known context.
   */
  mediaFact?: string;
  /**
   * Image/video/audio assets the HARNESS generated to fulfill the media roles the
   * design reference (`designReference`) described — e.g. a hero "product photo"
   * or a "background video". Threaded into authoring so the write embeds real
   * paths (`<img src>`, `<video src>`) instead of leaving placeholders or authoring
   * blind. Each entry carries the `role` it was generated for and a `placeholder`
   * flag when no real backend produced it. See `src/orchestrator/asset-generation.ts`.
   */
  generatedAssets?: GeneratedAssetRef[];
}

/**
 * One asset the harness auto-generated from a design reference's media roles.
 * Path is what the authoring pass embeds; `placeholder` is true when
 * `assets_generator` wrote a stand-in (no real backend for that kind).
 */
export interface GeneratedAssetRef {
  path: string;
  kind: "image" | "video" | "audio";
  role: string;
  placeholder?: boolean;
}

/**
 * One progress report from inside a running tool call (see
 * {@link ToolContext.progress}).
 *
 * `message` is written for a human watching a UI, not for the model — it is never
 * fed back into the transcript. Keep it short and concrete ("instrumented 3 of 7
 * files") rather than a log line.
 */
export interface ToolProgress {
  /** Human-facing status line, e.g. "analyzing 412 trace lines". */
  message: string;
  /**
   * Coarse stage within the tool, when it has more than one — lets a host group or
   * order updates instead of only showing the latest. Free-form by design; a tool
   * names its own stages.
   */
  stage?: string;
  /** 0..1 completion, when the tool genuinely knows it. Omit rather than guess. */
  percent?: number;
  /**
   * `true` when the tool is blocked on something OUTSIDE itself — a user answer, a
   * process the user must start. This is the distinction a spinner cannot make:
   * waiting-on-you looks identical to still-working. Hosts should surface these
   * differently.
   */
  waiting?: boolean;
}

/**
 * The execution context handed to every tool. Carries the harness services a tool
 * may need (LLM access, permission gate, logger, workspace root) without the tool
 * having to import the orchestrator.
 */
/**
 * What an escalation is FOR. The two halves of the staged-tool design:
 *   `read`  — a file rated too complex for the loop's model, handed to a
 *             stronger one for comprehension (`comprehendFile`).
 *   `write` — a mutating write/edit whose bytes are authored by a stronger
 *             model instead of the requesting model's draft (`authorModel`).
 *
 * They are separate because the right model differs: comprehension rewards raw
 * capability, authoring rewards instruction-following and diff discipline.
 */
export type ModelRouteKind = "read" | "write";

/**
 * Maps an escalation (kind + the complexity rating that triggered it) to a model
 * slug. Owned by the host so routing policy lives in one place instead of being
 * implied by a pool's ordering.
 *
 * Returning `undefined` means "no opinion" — the caller falls back to the
 * candidate pool, and then to not escalating at all.
 *
 * `low` is asymmetric between the two kinds, and hosts have to know which:
 *   - a `low` READ never routes — `stageRead` returns the bytes and stops before
 *     it would ask, since re-deriving what the reader was already trusted with is
 *     pure cost;
 *   - a `low` WRITE does route. The tool consults this for every write, which is
 *     what lets `authorOnlyWrites` resolve its trivial tier (normally back to the
 *     driver itself). Under that mode a plain write left unrouted errors rather
 *     than being silently authored by the driver.
 */
export type ModelRouter = (input: {
  kind: ModelRouteKind;
  rating: ComplexityRating;
  /**
   * What KIND of work this is, when it could be determined. Orthogonal to
   * `rating`: a trivial SVG tweak and a hairy one are both `"svg"`. The rating
   * says whether to escalate; the category says what the escalation model needs
   * to be good at — spatial and visual reasoning for `ui`/`svg`, ordinary code
   * reasoning for `code`.
   *
   * This is a capability-tier hint, NOT a modality one: whether a call needs a
   * model that can see is decided separately, from the images actually attached
   * to it. Absent ⇒ the host should route on `rating` alone.
   */
  category?: ComplexityCategory;
  /**
   * Whether this call carries image attachments — a mockup, a screenshot, a
   * design to build FROM.
   *
   * The third independent axis. It is not a rating and not a category: it changes
   * what the model has to DO. Authoring from a design is a transcription problem
   * with a ground truth to match, so it can justify a stronger model than the same
   * rating would without one, and the model must be able to see at all (the driver
   * is text-only, so authoring there would lose the image entirely).
   */
  hasAttachment?: boolean;
  /** Absolute path being read/written, when the call has one. */
  path?: string;
}) => string | undefined;

export interface ToolContext {
  /** Absolute workspace root the tool should operate within. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * What the run is trying to do, at the narrowest altitude available (this
   * step's instruction when there is one, otherwise the run task).
   *
   * Populated on EVERY call, which is the point. `authoringContext.task` carries
   * the same string but only exists for a `write`/`edit` — so any tool that
   * escalates to a second model on a non-mutating call had no statement of
   * intent to pass on.
   *
   * That gap produced the worst observed derailment in the harness. The staged
   * `read` escalates hard files to a stronger model and appends its analysis to
   * the bytes; the analyst is instructed to LEAD WITH THE TASK — and was handed
   * no task, because a read is not an authoring call. So it invented one from
   * the file's own contents. On a run whose actual task was "change title of
   * delete account popup", the analysis opened `TASK: changing the "Lock screen
   * Widget" label (line 767) and extending the platform gate at line 640`, went
   * on for 14KB about a feature nobody had mentioned, and was appended to six
   * separate reads. The driver followed it — re-reading lines 640-767 three
   * times — and eventually wrote, in the transcript, "I see the analysis is
   * confusing me."
   */
  task?: string;
  /** Per-call resolved model (from permission callback), if any. */
  model?: Model;
  /**
   * Resolved authoring model (from a TOOL-scoped permission decision's
   * `authorModel`). When set on a mutating write/edit call, the tool authors the
   * bytes via `llm` from scratch instead of using the requesting model's draft.
   * Distinct from `model` (which only sets the model available to the tool for its
   * own internal calls and the model that processes the result). Absent ⇒ the
   * tool writes the caller's args as-is (today's behavior).
   */
  authorModel?: Model;
  /**
   * Context for an authoring pass, populated only when `authorModel` is set:
   * the originating task, the structured plan JSON, and bounded snippets of the
   * surrounding files Plan handed to Perform. Lets the authoring model produce
   * content that fits the plan and the surrounding code, without the runner
   * reasoning over file contents itself.
   */
  authoringContext?: AuthoringContext;
  /**
   * The run's live attachment set, offered to a write/edit for vision authoring.
   * Each entry is a path/URL the tool resolves and reads (mirrors media_analysis);
   * bytes are NOT carried inline here.
   *
   * Offered, not applied: the tool routes these per target file (see
   * `attachment-routing.ts`) and passes only what belongs to the file it is
   * writing. Entries may carry `targets`/`label` to make that routing explicit.
   */
  images?: LiveImage[];
  /**
   * The loop's candidate model pool (`toolModelCandidates`), cheap → capable, so
   * a tool can escalate INTERNALLY without a host round-trip: rate the artifact,
   * then `selectModel({complexity, candidates})` to pick the tier that rating
   * deserves. Used by the staged `read` to hand a too-complex file to a stronger
   * model. Absent ⇒ the tool cannot escalate and must behave as a single-stage
   * tool (graceful degradation — no config flag gates this).
   */
  toolModelCandidates?: string[];
  /**
   * Host-owned escalation routing, consulted BEFORE `toolModelCandidates`.
   *
   * `toolModelCandidates` is a flat pool indexed by complexity score, so which
   * model a rating lands on depends on how many entries the pool happens to
   * have — it cannot say "medium reads go here, high writes go there" without
   * the host reverse-engineering `floor(score * pool.length)`. This states it
   * directly, and lets the app keep the mapping in one file it owns.
   *
   * Return a slug to route that (kind, rating) pair, or `undefined` to fall
   * through to the candidate pool. `low` is not routed: it proceeds on the
   * loop's own model, unescalated.
   */
  routeModel?: ModelRouter;
  /**
   * Rating the loop ALREADY holds for this call's path (inherited from a plan
   * step, or measured by an earlier tool call on the same file). Lets a staged
   * tool skip its own rating pass entirely — re-rating a file the run has already
   * judged is a wasted LLM call on the hottest tool in the harness.
   */
  knownComplexity?: ComplexityRating;
  /**
   * The rating the CALLING model declared for this write/edit, already floored by
   * any measured rating for the path.
   *
   * Kept separate from `knownComplexity` on purpose: that field means "a tool has
   * already MEASURED this artifact" and is what lets a staged read skip its rater
   * pass. A self-report is not a measurement, so folding it in there would make
   * reads stop rating files. This field only tiers authoring escalation.
   */
  declaredComplexity?: ComplexityRating;
  /** The category the calling model declared for this write/edit, if any. */
  declaredCategory?: ComplexityCategory;
  /**
   * Host callback for plan review, used by `create_plan`. Absent ⇒ the tool
   * auto-approves its first draft (headless-safe default).
   */
  planApproval?: PlanApprovalCallback;
  /** Structured logger; also feeds the activity_monitor tool. */
  log: (entry: LogEntry) => void;
  /**
   * Report progress from INSIDE a long-running tool call.
   *
   * A tool call is otherwise opaque to the host: it sees `tool_execution_start`,
   * then nothing until `tool_execution_end`. For a tool that finishes in
   * milliseconds that is fine, but a tool that waits on a user or polls a file
   * (`activity_collect` with `waitMs`, most obviously) can occupy minutes — and a
   * host UI can otherwise only show an indefinite spinner, leaving the user unable
   * to tell "working" from "wedged".
   *
   * Each call emits a `tool_execution_update` event carrying the same
   * `toolCallId`, so a host can render progress against the right tool call.
   * Absent ⇒ the tool runs silently (headless-safe); every call site must treat
   * this as optional and must never depend on it for control flow.
   */
  progress?: (update: ToolProgress) => void;
  /** Call another model via OpenRouter (used by asset/audit tools). */
  llm?: LLMBridge;
  /**
   * The categorizer this call is running in, when the caller knows it (v2's
   * replacement for the old 4P phase label). Tools that report back to the host
   * (asking the user, say) need it to label the request honestly instead of
   * assuming one.
   */
  phase?: string;
  /**
   * The detected project category, threaded live from the orchestrator. Tools
   * that only make sense for UI projects (inspiration/assets) decline with a
   * friendly note when this is `"backend"`, so the model doesn't burn calls on
   * visual tooling a non-UI project can't use.
   */
  projectCategory?: import("./presets/project-presets.js").ProjectCategory;
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
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
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
  /**
   * Which categorizer(s) this tool belongs to, by id (e.g. ["read",
   * "write_edit"]). Used by the registry's categorizer scoping when a setup does
   * not name tools explicitly. Empty/absent ⇒ scoped by the default categorizer
   * of `categorizeTool`.
   */
  categorizers?: string[];
  /**
   * A terminal tool ENDS its loop once it executes successfully — the tool-call
   * turn completes (every call in the turn keeps its result), then the loop stops
   * instead of prompting another turn. This is how a categorizer's `deliver`
   * tool signals "expectation met" deterministically.
   */
  terminal?: boolean;
  /**
   * Optional static complexity hint (0..1) used for model selection before the
   * call runs. The tool may also return a measured complexity in its result.
   */
  complexityHint?: number;
  /**
   * For action-dispatch tools (one tool, many verbs): which argument carries the
   * verb, and a human label per verb. A host showing the raw value renders
   * "Graph Memory / stats" — the enum token leaks to the user. With these it can
   * show "Summarize the code graph" instead. Presentational only; the model
   * never sees them. Titles are per-CALL, so {@link Tool.title} stays the
   * tool-level label and this refines it once the args are known.
   */
  actionParam?: string;
  actionTitles?: Record<string, string>;
  /**
   * How the tool itself resolves the verb when the model omits `action` (these
   * tools infer it from the other arguments). Without this a host would label
   * every inferred call with the generic tool title, which is exactly the case
   * the enum default exists for. Same resolver the tool uses internally.
   */
  resolveAction?: (args: Record<string, unknown>) => string;
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
  // Progress from inside a still-running call (see ToolContext.progress). Purely
  // advisory: a host may ignore every update and still see start → end.
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; progress: ToolProgress }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  // ---- categorizer chain extensions (namespaced so pi UIs can ignore them) ----
  /** A categorizer hop is starting (router picked it; tools are scoped). */
  | { type: "categorizer_start"; categorizer: string; model: string }
  /**
   * A categorizer hop finished. PROGRESS TELEMETRY ONLY: the hop's deliverable
   * is an internal handoff for the NEXT categorizer and is deliberately NOT
   * carried here — the only user-facing summary of a run is the final one
   * (RunLoopResult.summary / the last assistant message), composed from every
   * hop's deliverable. Hosts may use this event for progress indication
   * (a step finished, these paths changed); never for content to display.
   */
  | {
      type: "categorizer_end";
      categorizer: string;
      writtenPaths?: string[];
      readPaths?: string[];
    }
  /**
   * The run's ONE user-facing closing summary, composed from every hop's
   * deliverable (see `summarizeChain`) and emitted once, after the last hop.
   *
   * This exists because the last thing a host renders is otherwise the final
   * `deliver` call, whose body is that HOP's note — "the sun is properly blood
   * purple, the corona ring is subtle at 30% opacity" — which reads as the
   * closing word on the run while describing only the check that happened to
   * run last. Render THIS as the run's ending; render a `deliver` card as the
   * step it is (its result carries `scope: "hop"`), or not at all.
   */
  | { type: "run_summary"; summary: string }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_decision"; request: PermissionRequest; decision: PermissionDecision };

// ---------------------------------------------------------------------------
// Run continuity records
// ---------------------------------------------------------------------------

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
  /** Categorizer ids this provider serves (v2; formerly 4P phases). */
  categorizers: string[];
  toolNames: string[];
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


export interface ReadFileContent {
  path: string;
  content: string;
}

/**
 * Lines in a read file that the reading phase flagged as relevant to the task
 * (the lines a change targets, or the evidence for a finding). Populated from
 * successful `mark_concern_lines` calls; one entry per (path) declaration.
 * Distinct from {@link ReadFileContent} (whole-file contents) — this is the
 * per-line anchor a host UI uses to highlight what matters in a read.
 */
export interface LineConcern {
  path: string;
  /** 1-based line numbers, deduped + sorted. */
  lines: number[];
  /** Optional one-line reason: why these lines matter. */
  why?: string;
}

export type PlanFileMutationMode = "edit" | "write";

/** Complexity rating shared by Prepare file reads and Plan tasks (req: complexity flows across phases). */
export type ComplexityRating = "low" | "medium" | "high";

/**
 * The kind of work a mutation represents, as declared by the model making the
 * call. Deliberately only three buckets: the axis exists to pick an escalation
 * model with the right STRENGTH (visual judgment vs code reasoning), and finer
 * grain than this cannot be declared reliably by a model mid-tool-call.
 *
 * - `ui`   — rendered interface work: components, layout, styling, visual states.
 * - `svg`  — vector artwork edited as markup, where geometry and paths matter.
 * - `code` — everything else: logic, types, config, tests, build.
 */
export type ComplexityCategory = "ui" | "svg" | "code";

/** Narrow an untrusted value to a `ComplexityCategory`. */
export function asComplexityCategory(v: unknown): ComplexityCategory | undefined {
  return v === "ui" || v === "svg" || v === "code" ? v : undefined;
}

/** Narrow an untrusted value to a `ComplexityRating`. */
export function asComplexityRating(v: unknown): ComplexityRating | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}

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
  /**
   * Set to `true` by the loop once this task's sub-loop finishes. Authored by the
   * harness, never the model: a task is incomplete until its dedicated work pass
   * ends, then it flips to complete for the rest of the run.
   */
  isCompleted?: boolean;
  /**
   * Extra instructions the USER added to this step during plan review. Injected
   * into the step's opening message when it runs. Never authored by the model —
   * it is the user's word on this step, and it outranks the planner's summary.
   */
  userNotes?: string;
  /**
   * Files the USER attached to this step during plan review. Forwarded as the
   * step's `images` (for image types) and listed in its opening message, so the
   * attachment is available exactly when this step executes.
   */
  attachments?: PlanAttachment[];
}

/**
 * A file the USER attached to a specific plan step (not something the model
 * found). Carried by address, like all harness media, and forwarded into that
 * step's work loop when it executes — so a mockup attached to "build the header"
 * reaches the header step and nothing else.
 */
export interface PlanAttachment {
  /** Absolute (or cwd-relative) path to the attached file. */
  path: string;
  mimeType: string;
  /** Optional user note about why this file is attached to this step. */
  note?: string;
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

// ---------------------------------------------------------------------------
// Plan review (create_plan tool <-> host)
// ---------------------------------------------------------------------------

/**
 * A proposed plan handed to the host for review. The host renders it, and the
 * user either approves it or sends it back with comments to be re-planned.
 */
export interface PlanApprovalRequest {
  /** The plan as currently drafted. */
  planSet: PlanSet;
  /** 1-based draft number. Increments on every re-plan. */
  revision: number;
  /** The originating task the plan is for. */
  task: string;
  /** Comments from the PREVIOUS round, if this is a re-plan. */
  priorComments?: string;
  /** Revisions still available before the tool stops re-planning. */
  revisionsRemaining: number;
}

/**
 * A user's per-step addition made during plan review: extra instructions and/or
 * files attached to ONE step. Applied to the matching {@link PlanTask} before the
 * plan is returned, so the step carries them into its own execution.
 */
export interface PlanStepEdit {
  /** Id of the {@link PlanTask} this applies to. */
  taskId: string;
  /** Extra instructions for this step. Appended to any existing notes. */
  notes?: string;
  /** Files to attach to this step. Appended to any existing attachments. */
  attachments?: PlanAttachment[];
}

/** What the host returns after showing a plan to the user. */
export interface PlanApprovalDecision {
  /**
   * `true` ⇒ run this plan. `false` ⇒ re-plan using `comments`.
   *
   * `stepEdits` are applied in BOTH cases: a user can approve a plan while still
   * attaching a mockup to step 3, which is the common case and must not require
   * a wasted re-planning round.
   */
  approved: boolean;
  /** How the plan should be redone. Only meaningful when `approved` is false. */
  comments?: string;
  /** Per-step notes/attachments the user added while reviewing. */
  stepEdits?: PlanStepEdit[];
  /**
   * Abandon planning entirely (the user cancelled the review). The tool returns
   * an error result rather than a plan, and the run does not proceed on a plan
   * the user rejected outright.
   */
  cancelled?: boolean;
}

/**
 * Host callback invoked by the `create_plan` tool once a draft exists. When no
 * callback is installed the tool auto-approves its first draft, so headless and
 * library runs are never blocked waiting for a reviewer that will never answer.
 */
export type PlanApprovalCallback = (
  request: PlanApprovalRequest,
) => Promise<PlanApprovalDecision> | PlanApprovalDecision;





/**
 * One offered answer. A bare label is often not enough for the user to choose
 * well — the whole point of offering choices is to move the thinking to the side
 * that has it, so an option carries the trade-off it implies, and the model may
 * mark the one it would pick.
 */
export interface AskUserQuestionOption {
  /** The short answer text, e.g. "Postgres". */
  label: string;
  /** What choosing this means — the consequence, not a restatement of the label. */
  description?: string;
  /** True on the option the model recommends. At most one should carry it. */
  recommended?: boolean;
}

/**
 * A file moving in either direction across an `ask_user_question` exchange —
 * one the AGENT attached to its question, or one the USER attached to their
 * answer. Same shape as the run-level `images`/plan attachments, so a file that
 * arrives this way is threaded exactly like one attached up front.
 */
export interface AskUserQuestionAttachment {
  /** Absolute path on the host's disk. */
  path: string;
  mimeType: string;
  /** Why this file is here — the agent's caption, or the user's note. */
  note?: string;
}

/**
 * What the host may ask the user to attach.
 *
 * The agent frequently needs a FILE rather than a sentence: the mockup it is
 * supposed to match, the screenshot of the error, the CSV whose columns decide
 * the schema, the export it has to parse. Describing those in prose is exactly
 * the round trip this avoids — "send me the design" answered with three
 * paragraphs about the design is a worse outcome than not asking.
 *
 * `required` means the question is not answerable without a file, so a host
 * should not let an empty submission through; `optional` offers the picker
 * without insisting.
 */
export interface AskUserQuestionAttachmentRequest {
  mode: "optional" | "required";
  /**
   * Hints for the host's file picker — extensions or mime types (`".png"`,
   * `"image/*"`, `"text/csv"`). Advisory: a host that cannot filter should still
   * accept whatever the user picks rather than blocking the answer.
   */
  accept?: string[];
  /** What to attach, in the user's terms ("the Figma export of the hero"). */
  hint?: string;
  /** Whether more than one file is wanted. Default false. */
  multiple?: boolean;
}

/** A user's answer, when the host can return files alongside the text. */
export interface AskUserQuestionAnswer {
  /** The typed/selected answer. May be empty when the files ARE the answer. */
  text: string;
  /** Files the user attached. Absolute paths the harness can read. */
  attachments?: AskUserQuestionAttachment[];
}

/**
 * The host callback's return value.
 *
 * A bare string is still valid and still means "text only" — every host written
 * before attachments existed keeps working unchanged, and a host that cannot
 * offer a file picker never has to pretend it can.
 */
export type AskUserQuestionResult = string | AskUserQuestionAnswer;

export interface AskUserQuestionRequest {
  /** Categorizer id the question came from (formerly the 4P phase). */
  phase?: string;
  question: string;
  kind?: "clarification" | "plan_review";
  reason?: string;
  placeholder?: string;
  answerMode?: "text" | "single-select" | "multi-select";
  /**
   * Files the AGENT is showing WITH the question — two candidate screenshots to
   * choose between, the capture of the defect it wants confirmed, the generated
   * asset it wants approved. A question about something visual is far cheaper to
   * answer when the thing is on screen next to it.
   */
  attachments?: AskUserQuestionAttachment[];
  /**
   * Set when the answer should include a file. See
   * {@link AskUserQuestionAttachmentRequest} — a host that renders no picker
   * degrades to a text answer, which is the pre-attachment behaviour.
   */
  requestAttachments?: AskUserQuestionAttachmentRequest;
  /**
   * Option labels. Kept as plain strings for hosts that render a simple picker;
   * {@link AskUserQuestionRequest.choices} carries the same options with their
   * trade-offs for hosts that can show them.
   */
  options?: string[];
  /** The same options, with descriptions and the recommendation. */
  choices?: AskUserQuestionOption[];
  /**
   * Whether the host must ALSO offer a free-text box next to the options.
   *
   * Set true by the tool on every call that carries choices, because a picker
   * without an escape hatch is a worse question than a blank box: the model
   * enumerated the paths it could think of, and the one the user actually wants
   * is frequently the one that did not occur to it ("neither — use the existing
   * queue"). With options only, that user has to pick a wrong answer, or abort
   * the run and restart with a reworded prompt.
   *
   * A host that renders a picker for `single-select`/`multi-select` and no input
   * is not honouring this flag, even though nothing crashes — the failure is a
   * user who cannot say what they mean.
   */
  allowFreeText?: boolean;
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

/**
 * One executed step (plan task) from a {@link RunLoopResult}. Mirrors a
 * {@link PlanTask} but carries the post-run state the loop filled in — chiefly
 * whether the step's sub-loop finished (`isCompleted`) and any hard error.
 */




export interface RunStep {
  planId: string;
  taskId: string;
  title: string;
  summary: string;
  complexity: ComplexityRating;
  isCompleted: boolean;
  /** Files this step declared (from the plan); for display only. */
  files: string[];
  /** Hard error (LLM/transport/tool failure) that ended this step early, if any. */
  error?: string;
}

/**
 * Result of the new flat loop (`Orchestrator.run`). The loop is text↔text by
 * default, optionally multimodal (a write/edit can invoke a vision model), and
 * ends with a single summary turn over the whole run. When the model supplied a
 * plan, `steps` records per-task progress with `isCompleted`; otherwise the run
 * was a single unstructured work loop and `steps` is empty.
 */
export interface RunLoopResult {
  /** The original task string. */
  task: string;
  /** How the request was routed: a direct answer or a full work run. */
  route: "conversational" | "task";
  /** True unless a hard error aborted the run (a user abort is not a failure). */
  success: boolean;
  /** The end-of-run summary the loop produced (the summary turn). */
  summary?: string;
  /** Per-task progress when a plan was produced; empty for a planless run. */
  steps: RunStep[];
  /** The structured plan, if the model emitted one. */
  planSet?: PlanSet;
  /** Media/artifact refs accumulated across the run. */
  refs: MediaRef[];
  /** Aggregated token usage across every turn. */
  usage: Usage;
  /** A pending clarifying question that paused the run, if any. */
  pendingUserQuestion?: AskUserQuestionRequest;
  /**
   * A hard failure (LLM/transport/tool error) that ended the run early. Undefined
   * on a normal run. A user abort surfaces as success=false but is NOT an error.
   */
  error?: string;
  /** Continuity snapshot for the next prompt in the same session. */
  threadSnapshot?: ThreadRunSnapshot;
  /**
   * Whether the run's written files were verified. In v2 this comes from the
   * last `activity_inspect` deliverable's verdict: `true` on "pass", `false`
   * on "fail", and `undefined` when no inspection ran (no writes,
   * conversational route, or `RunOptions.verify: false`).
   */
  verified?: boolean;
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
 *  rating was inherited from Prepare's per-file rating, Plan's per-task rating, or
 *  MEASURED mid-run by a tool that looked at the artifact (`"tool-measured"` — the
 *  staged `read` rating a file it loaded), vs. freshly estimated. */
export type ComplexitySource = "estimated" | "prepare-file" | "plan-task" | "tool-measured";

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
  /**
   * Label of the loop driving this call. In v2 that is the categorizer id
   * ("read" | "write_edit" | …); the old 4P names are gone. Kept as a plain
   * string so hosts keying on the field keep compiling.
   */
  phase?: string;
  /** The categorizer id (same value as `phase` in v2; explicit for new hosts). */
  categorizer?: string;
  /** Optional named choices the host may present to the user. */
  options?: PermissionOption[];
}

/** What the permission callback returns. */
export interface PermissionDecision {
  allowed: boolean;
  /**
   * OpenRouter model slug that should PROCESS THIS tool call's RESULT — i.e. the
   * phase-model turn that consumes the tool result runs on this model (Model B)
   * instead of the phase model (Model A, which requested the call). The tool
   * itself still reads/executes as usual; only the model turn that ingests the
   * result is swapped. Applied for exactly ONE subsequent turn: after that turn
   * the driver reverts to the phase model, so Model A resumes. (Contrast with
   * `thinkingLevel`, which persists across subsequent turns, and with the
   * `reasoning`/`transcript` emission toggles.) Also sets the model made
   * available to the tool via `toolCtx.model` if the tool makes its own internal
   * LLM call. Omit to let the phase model consume the result as usual. The slug
   * is resolved via `llm.resolveModel`; the client may send any OpenRouter slug.
   * Only honored from TOOL-scoped decisions (the phase decision's `model` still
   * only affects the tool's internal context).
   */
  model?: string;
  /**
   * OpenRouter slug of the model that should AUTHOR the bytes for a mutating
   * write/edit call (Model B), instead of writing the requesting model's (Model
   * A's) draft. By the time this decision is made, Model A has already emitted
   * its args one turn earlier — `authorModel` makes a SECOND model author the
   * actual on-disk content via an internal LLM call inside the tool:
   *   - `write`: Model B authors the whole file from scratch; Model A's
   *     `content` is discarded (kept only as `details.draft` for diagnostics).
   *   - `edit`: Model A's `oldString` anchor is preserved (an edit needs an
   *     anchor); Model B authors the replacement `newString`, and the disk
   *     mutation becomes `oldString → B's text`.
   * The tool is given the task, plan JSON, and surrounding file snippets (via
   * `toolCtx.authoringContext`) so it can author coherently. Distinct from
   * `model`, which only swaps the model that PROCESSES the result on the next
   * turn — `authorModel` swaps the byte authoring for mutations. Honored only
   * for write/edit from TOOL-scoped decisions. Omit ⇒ Model A's args are written
   * as-is (today's behavior). Slug resolved via `llm.resolveModel`.
   */
  authorModel?: string;
  /**
   * Reasoning EFFORT for the model turn this decision gates — distinct from the
   * `reasoning` boolean (which only controls whether thinking blocks are *emitted*
   * to the UI). This sets HOW HARD the model reasons on the *next* phase-model
   * turn (the turn after this tool's result is processed, or the phase's first
   * turn for a PHASE decision): `"off"` disables reasoning entirely; `"minimal"`
   * … `"xhigh"` scale effort. Lets a host run a specific tool with lower/higher
   * thinking than the harness-wide `thinkingLevel` default.
   *
   * Honored from BOTH the PHASE-scoped decision (overrides the phase's baseline
   * effort for the whole phase) and each TOOL-scoped decision (applied to the
   * phase's subsequent model turns — the turn that produced the current tool
   * call has already been requested and cannot be retroactively re-efforted).
   * Omit to inherit the configured default. The model's own `reasoning`
   * capability still gates the request (a model without `reasoning` won't think
   * regardless of this value).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Two INDEPENDENT UI-emission toggles the client may send back with the
   * decision, next to `model`. They control what the AI's response to a tool
   * result streams to the host UI (tool calls always stream regardless):
   *   - `reasoning`: emit the model's reasoning/thinking blocks.
   *   - `transcript`: emit the model's NON-reasoning text response (the answer /
   *     narration the host renders), separate from `reasoning`.
   * Each axis is independent: set both `true` and both stream; set one and only
   * that one streams; omit a flag and that axis is left unchanged.
   *
   * Honored from BOTH the PHASE-scoped decision (applied before the phase
   * streams) and each TOOL-scoped decision (applied to the phase's subsequent
   * model turns — the turn that produced the current tool call has already
   * streamed and cannot be retroactively re-emitted). When neither is set the
   * configured default (`transcriptMode`) applies.
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
  /**
   * Hard ceiling on REASONING tokens, separate from `maxTokens` (which bounds the
   * whole completion).
   *
   * Needed because omitting a reasoning parameter does not mean "no reasoning" —
   * it means the provider picks, and reasoning-capable models will happily spend
   * the entire completion budget thinking and return `content: null`. The harness
   * only reads `content` ([bridge] maps `reasoning` to a separate `thinking`
   * block), so that arrives as an EMPTY response after being billed in full. Any
   * internal call that needs text back should bound this.
   */
  reasoningMaxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  /** Extra headers merged into the request (OpenRouter attribution, etc.). */
  headers?: Record<string, string>;
  /**
   * Model-selection hints forwarded to a backend proxy as `metadata.modelSelection`
   * (only when the bridge is routed through a backend via baseUrl override).
   * Lets the backend control model selection "from there": send
   * `model: 'turing-machine'` + this, and the backend picks the upstream model by
   * complexity across the candidate pool. Ignored by OpenRouter when going direct.
   */
  modelSelection?: {
    /** 0..1 complexity score, or 'low' | 'medium' | 'high'. */
    complexity?: number | string;
    /** Candidate pool cheap → capable; the backend maps complexity to a tier. */
    modelCandidates?: string[];
    /** Explicit preferred slug; wins over complexity-based selection. */
    preferredModel?: string;
  };
}
