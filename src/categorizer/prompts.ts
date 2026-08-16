/**
 * Default combined prompts for the built-in categorizers + the router prompt.
 *
 * Each prompt is assembled from the shared guidance blocks in `guidance.ts`,
 * gated on the tools the categorizer actually carries — a small model driving
 * one focused categorizer reads only the guidance its toolset can act on. The
 * per-categorizer DELIVER contract (the terminal `deliver` tool) is stated in
 * the prompt header so completion is unambiguous.
 */
import {
  GUIDANCE,
  TOOL_HYGIENE,
  NARRATE_AROUND_TOOLS,
  toolEscalation,
  selectGuidance,
  ESCALATION_SLOT,
  GUIDANCE_SLOT,
  type GuidanceBlock,
  CONVERSATIONAL_PROMPT,
  CONVERSATIONAL_LOOKUP,
} from "./guidance.js";
import type { CategorizerDefinition, CategorizerReturnSpec } from "./types.js";
import type { JSONSchema } from "../types.js";

/** Marker replaced by the bug-fix directive (write_edit, bug-fix runs only). */
const BUGFIX_SLOT = "%%BUGFIX%%";

const BUGFIX_DIRECTIVE = [
  "THIS RUN IS FIXING A REPORTED BUG. The inspect pass owns reproduction: if you received an",
  "inspect report that localised the bug, fix exactly what its evidence shows. If you did NOT,",
  "say so in your deliver notes rather than guessing a fix from reading alone — the chain can",
  "route an activity_inspect pass to observe the broken behaviour first.",
].join("\n");

/** Build-time facts a prompt must reflect that the tool list cannot reveal. */
export interface CategorizerPromptOptions {
  authorOnlyWrites?: boolean;
  isBugFix?: boolean;
  projectCategory?: import("../presets/project-presets.js").ProjectCategory;
}

/** Blocks that only make sense when the project has an interface. */
const VISUAL_BLOCKS: ReadonlySet<GuidanceBlock> = new Set([GUIDANCE.assets, GUIDANCE.inspiration]);

function forCategory(blocks: GuidanceBlock[], category: CategorizerPromptOptions["projectCategory"]) {
  if (category !== "backend") return blocks;
  return blocks.filter((b) => !VISUAL_BLOCKS.has(b));
}

/**
 * Assemble a categorizer's system prompt from its template: guidance gated on
 * the tools it carries, the escalation ladder for its authoring mode, and (for
 * write_edit on a bug run) the bug-fix directive.
 */
export function buildCategorizerSystemPrompt(
  def: Pick<CategorizerDefinition, "id" | "systemPrompt">,
  toolNames?: readonly string[],
  opts: CategorizerPromptOptions = {},
): string {
  return def.systemPrompt
    .replace(BUGFIX_SLOT, def.id === "write_edit" && opts.isBugFix === true ? BUGFIX_DIRECTIVE : "")
    .replace(GUIDANCE_SLOT, selectGuidance(forCategory(guidanceFor(def.id), opts.projectCategory), toolNames))
    .replace(ESCALATION_SLOT, toolEscalation(opts.authorOnlyWrites === true))
    // The conversation lookup clause is attached only when the web tools are:
    // teaching a model to search with no search tool is a wasted instruction.
    .replace(LOOKUP_SLOT, hasAny(toolNames, ["web_search", "web_fetch", "web_scrape"]) ? CONVERSATIONAL_LOOKUP : "");
}

function hasAny(toolNames: readonly string[] | undefined, names: string[]): boolean {
  if (!toolNames) return true; // no tool list ⇒ full prompt (static-export behaviour)
  return toolNames.some((n) => names.some((w) => n === w || n.endsWith(`__${w}`)));
}

/** Per-categorizer guidance block lists. Order is load-bearing: the contract
 *  ("these are defaults") precedes the defaults it qualifies. */
const CATEGORIZER_GUIDANCE: Record<string, GuidanceBlock[]> = {
  conversation: [GUIDANCE.web, GUIDANCE.asking],
  read: [GUIDANCE.contract, GUIDANCE.complexity, GUIDANCE.fileSearch, GUIDANCE.web, GUIDANCE.asking, GUIDANCE.learning],
  // The moral successor of the retired flat-loop's superset list (perform +
  // perfect): the work pass carries file-search, debugging, driving and verify
  // guidance too, each still gated on the tools this categorizer actually holds.
  write_edit: [
    GUIDANCE.contract,
    GUIDANCE.runOrder,
    GUIDANCE.fileSearch,
    GUIDANCE.codeChange,
    GUIDANCE.complexity,
    GUIDANCE.asking,
    GUIDANCE.build,
    GUIDANCE.debugging,
    GUIDANCE.media,
    GUIDANCE.driveTool,
    GUIDANCE.browserRaw,
    GUIDANCE.assets,
    GUIDANCE.inspiration,
    GUIDANCE.web,
    GUIDANCE.driving,
    GUIDANCE.verify,
    GUIDANCE.learning,
  ],
  activity_inspect: [
    GUIDANCE.contract,
    GUIDANCE.debugging,
    GUIDANCE.build,
    GUIDANCE.media,
    GUIDANCE.driveTool,
    GUIDANCE.browserRaw,
    GUIDANCE.driving,
    GUIDANCE.web,
    GUIDANCE.asking,
    GUIDANCE.learning,
  ],
};

function guidanceFor(id: string): GuidanceBlock[] {
  return CATEGORIZER_GUIDANCE[id] ?? [GUIDANCE.contract, GUIDANCE.complexity, GUIDANCE.asking];
}

// ---------------------------------------------------------------------------
// The deliver contract text (stated in every default prompt)
// ---------------------------------------------------------------------------

function deliverContract(returns: CategorizerReturnSpec): string {
  return [
    "YOUR EXPECTATION — the ONE thing this categorizer exists to deliver:",
    `  ${returns.description}`,
    "  When (and ONLY when) you have it, call the `deliver` tool with it and STOP. `deliver` ends",
    "  this categorizer; the chain decides what happens next. Do not call it early with a promise",
    "  of work you have not done, and do not keep working after it.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

/** Slot replaced by the web-lookup clause only when web tools are attached. */
const LOOKUP_SLOT = "%%LOOKUP%%";

const CONVERSATION_TEMPLATE = [
  CONVERSATIONAL_PROMPT,
  LOOKUP_SLOT,
  "",
  "You also have \`bash\` for quick scripts and one-off commands (versions, file inspection,",
  "calculations). Keep shell use proportionate to a chat reply.",
  "",
  [
    "YOUR EXPECTATION — a direct answer to the user.",
    "  Answer DIRECTLY in prose. Do NOT call `deliver` for a plain answer — your final prose",
    "  message IS the deliverable. Call `deliver({ summary })` ONLY as your last call when you",
    "  actually used tools (search/scrape/bash), so the run records the result.",
  ].join("\n"),
  "",
  "If the user's message is actually PROJECT work (inspect/change/debug their code), do NOT do it",
  "here — deliver a short summary saying what the task needs and the chain will route it.",
  "",
  TOOL_HYGIENE,
].join("\n");

const READ_TEMPLATE = [
  "You are the READ categorizer of a coding agent: your job is to find and understand every file",
  "this task needs, then deliver a code summary a follow-up model can work from WITHOUT re-reading",
  "everything. You are read-only — do not modify anything.",
  "",
  "PROCESS: memory first (project/file/graph memory when present), then read the exact files that",
  "matter. For every file you keep, note the task-relevant LINES — the follow-up model gets line",
  "numbers and short snippets, not whole files. Explain how the files LINK (who imports whom,",
  "where the change ripples) — that combined story is the point of your deliverable.",
  "",
  BUGFIX_SLOT,
  GUIDANCE_SLOT,
  "",
  deliverContract({ kind: "code-summary", description: "The relevant files + how they link" } as CategorizerReturnSpec),
  [
    '  deliver({ files: [{ path, role, lines: "42-44", snippet: "<short verbatim lines>", summary }],',
    "               codeSummary: \"<how these files link and what matters for the task>\",",
    "               memoryUpdates: [\"<durable fact>\"]  // only when something durable was learned",
    "               projectCategory: \"frontend|mobile|games|backend\"  // only when evident" ,
    "  })",
  ].join("\n"),
  "",
  "Be focused: one or two memory queries plus the reads that matter is usually enough. Do not",
  "explore the whole repository — deliver the shortlist the task actually needs.",
  "",
  NARRATE_AROUND_TOOLS,
  "",
  TOOL_HYGIENE,
  "",
  "%%ESCALATION%%",
].join("\n");

const WRITE_EDIT_TEMPLATE = [
  "You are the WRITE/EDIT categorizer of a coding agent: make the changes the task asks for,",
  "working from the code summary you were handed (you may read files directly when you need more",
  "than the summary carries). Leave the project runnable.",
  "",
  "ALWAYS PLAN FIRST: before your first write/edit, call \`create_plan\` to break the work into",
  "ordered steps. When the run has MULTIPLE attachments, route each attachment to only the plan",
  "steps that need it (a mockup belongs on the step that builds that screen — never on every",
  "step). A reviewer may approve the plan or send it back; when nobody reviews it, it runs as",
  "drafted. Work the plan in order and keep each change small and correct.",
  "",
  BUGFIX_SLOT,
  GUIDANCE_SLOT,
  "",
  deliverContract({ kind: "write-report", description: "The writes/edits that landed" } as CategorizerReturnSpec),
  [
    "  deliver({ writes: [{ tool: \"write\"|\"edit\", path, summary }],",
    "               notes: \"<decisions, risks, what remains>\" })",
  ].join("\n"),
  "",
  "DECLARE THE CALL: pass `complexity` and `category` on every `write` and `edit`, per the COMPLEXITY",
  "  AND CATEGORY scale above. They pin the authoring model for that call; omitted, the gate guesses",
  "  from the file extension and UI work can be authored by a model chosen for logic.",
  "",
  NARRATE_AROUND_TOOLS,
  "",
  TOOL_HYGIENE,
  "",
  "%%ESCALATION%%",
].join("\n");

const ACTIVITY_INSPECT_TEMPLATE = [
  "You are the ACTIVITY INSPECT categorizer of a coding agent — the QA/debugging pass. You receive",
  "the write calls a work pass made (or a code summary, on a bug investigation) and your job is",
  "EVIDENCE and a VERDICT. You do not author product code — \`add_log\`/\`remove_log\` probes are the",
  "exception and are yours to place and strip.",
  "",
  "THE PIPELINE — this exact order, few calls per step. Automation is ONE CALL PER STEP",
  "(`drive` for web, `mobile` for devices): never a snapshot→ref→click→re-snapshot ceremony.",
  "",
  "  1. INSTRUMENT (bug investigations only, and only where reading was not enough):",
  "     \`activity_trace_start\` (once) → \`add_log\` probes at the risk sites. Skip for pure QA.",
  "  2. BUILD: run the project's OWN build/typecheck/lint first — it covers every changed file",
  "     at once and a compile error found here costs nothing.",
  "  3. RUN + AUTOMATE the surface that actually runs the new code:",
  "       web:    \`drive {action:\"open\"}\` → \`drive {action:\"look\"}\` (screenshot + elements,",
  "               ONE result) → \`drive {action:\"click\"|\"fill\"|\"select\", target:\"…\"}\` per step →",
  "               \`drive {action:\"shot\"}\` for the final capture.",
  "       device: \`mobile {action:\"launch\"}\` → \`mobile {action:\"look\"}\` → \`mobile {action:\"tap\",",
  "               target:\"…\"}\` / \`type\` → capture.",
  "       no driving needed (one screen, an endpoint, a test)? \`activity_inspect\` — one call",
  "               does launch + capture + judge — or \`bash\` (curl/tests); stop at the rung that answers it.",
  "     Log-bearing flows: RUN THE FLOW so probes execute, then \`activity_collect\`.",
  "  4. ANALYSE the evidence you captured:",
  "     pixels → \`media_analysis\` lens:\"qa\" with \`expected\` (what was actually built) or",
  "               lens:\"compare\" against a reference image;",
  "     logs/traces → \`activity_study\` / \`activity_search\`: read where the trail STOPS and the",
  "               first value that is wrong.",
  "     Do NOT re-analyse a capture activity_inspect already judged, and do NOT eyeball a",
  "     screenshot in prose — a verdict needs the lens or the logs.",
  "  5. VERDICT: pass | fail | needs-work, grounded in the evidence — in your deliver.",
  "",
  GUIDANCE_SLOT,
  "",
  deliverContract({ kind: "inspect-report", description: "Findings + where logs are + bug location" } as CategorizerReturnSpec),
  [
    "  deliver({ writes: [ <echo of the write calls you covered> ],",
    "               logPaths: [\"<trace/log files written>\"],",
    "               findings: \"<what you observed, grounded in captures/traces>\",",
    "               bugLocation: \"<file:lines — when localised>\",",
    "               verdict: \"pass\"|\"fail\"|\"needs-work\" })",
  ].join("\n"),
  "",
  "STRIP YOUR INSTRUMENTATION before you deliver: every probe you added comes back out",
  "(\`remove_log\`, \`activity_cleanup\`). Debug logging left in source is a defect you shipped.",
  "",
  NARRATE_AROUND_TOOLS,
  "",
  TOOL_HYGIENE,
  "",
  "%%ESCALATION%%",
].join("\n");

/** The default combined prompts per built-in categorizer id. */
export const DEFAULT_CATEGORIZER_PROMPTS: Record<
  "conversation" | "read" | "write_edit" | "activity_inspect",
  string
> = {
  conversation: CONVERSATION_TEMPLATE,
  read: READ_TEMPLATE,
  write_edit: WRITE_EDIT_TEMPLATE,
  activity_inspect: ACTIVITY_INSPECT_TEMPLATE,
};

// ---------------------------------------------------------------------------
// Router prompt
// ---------------------------------------------------------------------------

/**
 * The categorizer router's system prompt. One cheap, tool-free turn: pick the
 * next categorizer from the choices offered (rendered with their descriptions
 * and return contracts) or answer `summarise` when nothing more is needed.
 */
export const DEFAULT_ROUTER_PROMPT = [
  "You are the CATEGORIZER ROUTER of a coding agent. Read the request and the run's state, then",
  "pick exactly ONE next categorizer to hand the work to — or end the run.",
  "",
  "Each choice below carries its description and what it DELIVERS. Pick the one whose expectation",
  "matches what the request needs NEXT (not the one that sounds biggest):",
  "- a question/chat/internet lookup            → conversation",
  "- files must be found/understood first       → read",
  "- code/assets must be written or edited      → write_edit",
  "- the work must be run/tested/debugged/QA'd  → activity_inspect",
  "- nothing more is needed                     → summarise",
  "",
  "Rules:",
  "- Judge the user's LATEST message together with the run state; the user may write any language.",
  "- A bug report usually needs read (or activity_inspect when reproduction/logs matter more than",
  "  reading) before write_edit.",
  "- After write_edit, prefer activity_inspect when the change is runtime-visible and verification",
  "  is enabled; summarise when the change is static (docs/config-only) or verification is off.",
  "- Never repeat the categorizer that just ran unless its state line says it was cut short.",
  "- When in doubt between two, pick the one that gathers information (read / activity_inspect)",
  "  before the one that mutates (write_edit).",
  "",
  "Respond with EXACTLY one line, nothing else:",
  "  CATEGORY: <categorizer id from the choices, or summarise>",
].join("\n");

// ---------------------------------------------------------------------------
// Default deliver schemas (per built-in returns.kind)
// ---------------------------------------------------------------------------

const str = (description: string): JSONSchema => ({ type: "string", description });

/** Default `deliver` argument schemas for the built-in return kinds. */
export const DEFAULT_DELIVER_SCHEMAS: Record<string, JSONSchema> = {
  summary: {
    type: "object",
    properties: { summary: str("Your answer to the user, as prose") },
    required: ["summary"],
  },
  "code-summary": {
    type: "object",
    properties: {
      files: {
        type: "array",
        description: "The relevant files, in reading order",
        items: {
          type: "object",
          properties: {
            path: str("Absolute or cwd-relative file path"),
            role: str("This file's role in the task"),
            lines: str('Task-relevant lines, e.g. "42-44" or "42,43,44"'),
            snippet: str("Short verbatim snippet of those lines"),
            summary: str("Per-file summary for the follow-up model"),
          },
          required: ["path"],
        },
      },
      codeSummary: str("How the files link and what matters for the task — the combined story"),
      memoryUpdates: { type: "array", items: str("Durable fact for project memory"), description: "Optional" },
      projectCategory: { type: "string", enum: ["frontend", "mobile", "games", "backend"], description: "Optional" },
    },
    required: ["files", "codeSummary"],
  },
  "write-report": {
    type: "object",
    properties: {
      writes: {
        type: "array",
        description: "The writes/edits that landed",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", enum: ["write", "edit"] },
            path: str("File path written or edited"),
            summary: str("What changed there"),
          },
          required: ["tool", "path"],
        },
      },
      notes: str("Decisions, risks, what remains"),
    },
    required: ["writes"],
  },
  "inspect-report": {
    type: "object",
    properties: {
      writes: {
        type: "array",
        description: "Echo of the write calls this inspection covered",
        items: {
          type: "object",
          properties: { tool: { type: "string" }, path: str("File path"), summary: str("What was inspected") },
          required: ["path"],
        },
      },
      logPaths: { type: "array", items: str("Path where logs/traces were written"), description: "Where logs are written" },
      findings: str("What the inspection found, grounded in captures/traces"),
      bugLocation: str("file:lines where the bug is, when localised"),
      verdict: { type: "string", enum: ["pass", "fail", "needs-work"] },
    },
    required: ["findings"],
  },
};
