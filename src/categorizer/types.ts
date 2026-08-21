/**
 * Categorizer types (v2).
 *
 * A categorizer is ONE focused working context for a small model: a small toolset,
 * one combined prompt, its own orchestrator (driver) model, and a single
 * expectation it must DELIVER before the chain moves on. The chain driver hops
 * between categorizers via a cheap router call; everything a follow-up
 * categorizer learns arrives through the structured deliverable + the tool
 * results its `accepts` spec names — never as a shared transcript.
 *
 * Definitions are plain data so an app can ship them from a config file
 * (`categorizer-setup`) without importing orchestrator internals.
 */
import type { JSONSchema } from "../types.js";

/** Stable unique key of a categorizer, e.g. "read". */
export type CategorizerId = string;

/**
 * What upstream context a categorizer receives when it is NOT the first hop.
 *
 * The v2 context-passing contract: a categorizer sees the TASK, its attachments,
 * and ONLY the outputs named here from earlier hops. Two channels:
 *   - `from`  — the structured DELIVERABLES of those categorizer ids.
 *   - `tools` — raw results (tool name, args, output, reasoning) of those tool
 *     names from earlier hops, e.g. activity_inspect accepting `write`/`edit`
 *     results so QA starts from what actually changed on disk.
 * Both default to "nothing" — a categorizer that declares neither starts fresh.
 */
export interface CategorizerAcceptSpec {
  /** Categorizer ids whose deliverables flow in. */
  from?: CategorizerId[];
  /** Tool names whose successful call records flow in. */
  tools?: string[];
}

/**
 * The single expectation a categorizer must deliver. Drives the injected
 * `deliver` terminal tool: its arguments schema, the prompt text that states the
 * expectation, and (via `kind`) the typed shape the chain hands downstream.
 */
export interface CategorizerReturnSpec {
  /**
   * Built-in kinds get default deliver schemas + typed deliverables:
   *   - "summary"         — `{ summary: string }` (conversation)
   *   - "code-summary"    — files + linked summary with line numbers + snippets (read)
   *   - "write-report"    — the writes/edits that landed (write_edit)
   *   - "repro-report"    — the symptom observed + evidence + suspect lines (activity_reproduce)
   *   - "inspect-report"  — writes echo + log paths + findings + verdict (activity_inspect)
   * Any other string is a custom kind: `deliverSchema` becomes required and the
   * deliverable travels as opaque data.
   */
  kind: "summary" | "code-summary" | "write-report" | "repro-report" | "inspect-report" | (string & {});
  /** One paragraph, shown to the ROUTER: what this categorizer hands onward. */
  description: string;
  /** Optional override of the deliver tool's argument schema. */
  deliverSchema?: JSONSchema;
}

/**
 * One categorizer definition. Pure configuration — the chain driver instantiates
 * the runtime (tools, deliver tool, model) from it.
 */
export interface CategorizerDefinition {
  /** Unique key. Also the router's selection token and the event label. */
  id: CategorizerId;
  /** Human-facing name. */
  name: string;
  /** Router-facing: WHEN to pick this categorizer (rendered as the choice's blurb). */
  description: string;
  /**
   * The combined system prompt for this categorizer's tool loop. Build it with
   * `buildCategorizerSystemPrompt` or write your own; the chain uses it verbatim.
   */
  systemPrompt: string;
  /**
   * Tool names assigned to this categorizer. Unresolved names are skipped with a
   * logged warning (so a setup can list optional tools like the *_memory set).
   * `globalTools` from the setup and mention-resolved MCP/skill tools are added
   * on top.
   */
  tools: string[];
  /**
   * Allowed NEXT categorizer ids (the router chooses among these, or summarise).
   * Empty ⇒ the chain can only summarise after this categorizer.
   */
  children: CategorizerId[];
  /** What upstream context this categorizer accepts (see CategorizerAcceptSpec). */
  accepts?: CategorizerAcceptSpec;
  /** The single expectation this categorizer must deliver. */
  returns: CategorizerReturnSpec;
  /**
   * The orchestrator (driver) model for this categorizer's reasoning, as an
   * OpenRouter slug. Omitted ⇒ the role-slot default (see chain driver).
   * write/edit escalation is INDEPENDENT of this and works exactly as before:
   * this model is Model A; Model B still authors bytes by complexity/category.
   */
  model?: string;
  /** Reasoning effort for this categorizer's loop turns. */
  reasoning?: import("../types.js").ThinkingLevel;
  /** Whether the router may pick this as the FIRST categorizer. Default true. */
  entry?: boolean;
  /**
   * Resolve registry-SCOPED tools as if this categorizer were the named one.
   *
   * Tools declare which categorizer they serve (`AgentTool.categorizers`), and an
   * MCP server's scope is inferred the same way — so a NEW categorizer sharing an
   * existing one's surface would otherwise start empty, and every browser tool,
   * every device tool and every activity builtin would have to name it too. That
   * is a list no host can keep current: it lives partly in this library and partly
   * in whatever MCP servers happen to be connected.
   *
   * `activity_reproduce` sets this to `activity_inspect`: same QA surface,
   * different job. Its own `tools` list still applies on top.
   */
  toolScope?: CategorizerId;
  /** Optional hard cap on tool-call turns for this categorizer's loop. */
  maxSteps?: number;
}

/**
 * A validated set of categorizers plus chain-wide settings. Built via
 * `createCategorizerSetup` / `defineCategorizer` (see categorizer-setup).
 */
export interface CategorizerSetup {
  categories: CategorizerDefinition[];
  /**
   * Tools EVERY categorizer receives regardless of its own `tools` — defaults to
   * bash, ask_user_question, clearing_doubt and the web set. Mention-resolved
   * MCP/skill tools are added to this baseline by the chain.
   */
  globalTools: string[];
  /** Router model slug. Omitted ⇒ the router role-slot default. */
  routerModel?: string;
  /** Summary-turn model slug. Omitted ⇒ the summary role-slot default. */
  summaryModel?: string;
  /**
   * The "big model" `clearing_doubt` consults when a small-model categorizer is
   * stuck or beyond its capability. Omitted ⇒ orchestrator slot, then the plan
   * default (a model picked for exactly this kind of senior reasoning).
   */
  doubtModel?: string;
  /** Max categorizer hops per run (the loop write_edit↔activity_inspect guard). Default 6. */
  maxHops?: number;
  /** Router prompt override. */
  routerPrompt?: string;
}

// ---------------------------------------------------------------------------
// Deliverables (typed shapes per built-in returns.kind)
// ---------------------------------------------------------------------------

/** One file a `read` categorizer hands downstream. */
export interface ReadDeliverableFile {
  path: string;
  /** Role in the task ("entry point being changed", "defines the types used…"). */
  role?: string;
  /** Task-relevant lines, 1-based, e.g. "42-44" or "42,43,44". */
  lines?: string;
  /** A SHORT verbatim snippet of the lines that matter. */
  snippet?: string;
  /** Per-file summary for the follow-up model. */
  summary?: string;
}

/** `returns.kind: "code-summary"` — the read categorizer's expectation. */
export interface ReadDeliverable {
  files: ReadDeliverableFile[];
  /** How the files link: the combined story for the follow-up model. */
  codeSummary: string;
  /** Durable facts the host may persist into project memory, if any. */
  memoryUpdates?: string[];
  /** Project category observed from the files, for preset reconciliation. */
  projectCategory?: "frontend" | "mobile" | "games" | "backend";
  /**
   * Expert analyses a stronger model produced for files too complex for the
   * reading model (staged-read comprehension). Bounded by the chain before it is
   * handed on; the full analyses live in the run's `ComprehensionStore`, which
   * the next hop's reads re-inject from with no extra model call.
   */
  comprehensions?: Array<{
    path: string;
    rating: "low" | "medium" | "high";
    model: string;
    analysis: string;
  }>;
}

/** One write/edit that landed. */
export interface WriteRecord {
  tool: "write" | "edit" | (string & {});
  path: string;
  summary?: string;
}

/** `returns.kind: "write-report"`. */
export interface WriteDeliverable {
  writes: WriteRecord[];
  /** Notes for the follow-up categorizer (decisions, risks, what remains). */
  notes?: string;
}

/**
 * `returns.kind: "repro-report"` — what a QA pass produces BEFORE the fix exists.
 *
 * Deliberately not an `InspectDeliverable`. The two QA jobs look alike from the
 * outside and their outputs are opposites: verification answers "is the change
 * good?" and carries a verdict; reproduction answers "what does the defect
 * actually do, and where does it live?" and carries evidence. A run that reported
 * `verdict: "pass"` from a pass that ran BEFORE any fix would mark the bug
 * verified fixed — so the pre-fix pass gets a shape with no verdict in it at all.
 */
export interface ReproDeliverable {
  /** Was the reported behaviour actually observed? */
  reproduced: boolean;
  /** What was seen, in the user's terms — the symptom, not the theory. */
  symptom: string;
  /** How it was produced: the steps, the screen, the request. */
  steps?: string;
  /** Where the evidence is: trace files, tailed logs, captures. */
  logPaths: string[];
  /** The lines a fix should target, with why each is suspected. */
  suspects: Array<{ path: string; lines?: string; why?: string }>;
  /** What the fixer still has to decide, when reproduction did not settle it. */
  openQuestions?: string;
}

/** `returns.kind: "inspect-report"`. */
export interface InspectDeliverable {
  /** Echo of the write calls this inspection covered (from its accepted input). */
  writes: WriteRecord[];
  /** Where logs/traces were written (trace files, tailed project logs). */
  logPaths: string[];
  /** What the inspection found. */
  findings: string;
  /** Best-known location of a bug, when one was localized. */
  bugLocation?: string;
  /** pass ⇒ verified; fail ⇒ defects found (write_edit should repair); omit ⇒ inconclusive. */
  verdict?: "pass" | "fail" | "needs-work";
}

/** `returns.kind: "summary"`. */
export interface SummaryDeliverable {
  summary: string;
}

/** Union of built-in deliverable shapes; custom kinds arrive as opaque records. */
export type CategorizerDeliverable =
  | SummaryDeliverable
  | ReadDeliverable
  | WriteDeliverable
  | ReproDeliverable
  | InspectDeliverable
  | Record<string, unknown>;

/**
 * One executed categorizer hop, as the chain (and the router's compact state)
 * sees it. This is the run's shape of "what happened", not a transcript.
 */
export interface CategorizerHop {
  id: CategorizerId;
  /** 0-based position in the run. */
  index: number;
  /** The deliverable captured from the `deliver` tool (or derived fallback). */
  deliverable?: CategorizerDeliverable;
  /** One-line human summary of the hop (for events + the summary turn). */
  summary: string;
  /** Whether `deliver` was actually called (vs a derived fallback). */
  delivered: boolean;
  /** Tool-name → call records, for downstream `accepts.tools` filtering. */
  toolRecords: CategorizerToolRecord[];
  /** Successful writes this hop made (loop-tracked, success-only). */
  writtenPaths: string[];
  /** Files this hop read (success-only). */
  readPaths: string[];
  /** Plan produced by `create_plan` in this hop, if any. */
  planSet?: import("../types.js").PlanSet;
  /**
   * Where this hop's own driver says the work goes next, in order — read off its
   * `deliver` call and validated against this categorizer's `children`.
   *
   * The router is a separate, cheap, tool-free turn that sees one 240-character
   * summary of the hop. The driver just spent twenty turns in the code. On the
   * run that motivated this field, read produced a full root-cause analysis of a
   * reported bug and the router — reading the first 240 characters of it, which
   * looked like a finished report — ended the run without a line being written.
   * The model that knew the answer had no way to say it.
   *
   * A nomination is a PROPOSAL, not a jump: the chain validates every id against
   * `children`, applies the run's policy floors, and keeps the loop guard. Empty
   * or absent ⇒ fall back to the router.
   */
  nominations?: CategorizerId[];
  /** Why the driver nominated those, for the log and the router's fallback. */
  nominationReason?: string;
}

/**
 * A compact record of ONE successful tool call, carried between categorizers
 * whose `accepts.tools` names it. The "reasoning" is the assistant text that
 * surrounded the call, truncated — enough for a follow-up categorizer to know
 * WHY its predecessor made the call without receiving the whole transcript.
 */
export interface CategorizerToolRecord {
  tool: string;
  /** Display target (path/query/command), truncated. */
  target?: string;
  /** Output text, truncated. */
  output?: string;
  /** The reasoning the predecessor model gave around the call, truncated. */
  reasoning?: string;
}
