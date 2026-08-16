/**
 * The reproduce-before-you-edit gate.
 *
 * The prompt has said this for a long time: on a reported bug, capture the broken
 * behaviour BEFORE any `write`/`edit`, so you know which code is actually on the
 * failing path and so you have a baseline to prove the fix against. It is stated
 * unambiguously and it is routinely ignored — an observed run on a Flutter bug had
 * the `mobile_*` toolkit, `playwright`, `chrome-devtools` and the whole `activity_*` toolkit
 * connected with zero failures, and still went read → grep → edit without once
 * driving the app or instrumenting the flow.
 *
 * The lesson was that prose does not bind. A rule the model can silently skip is a
 * suggestion; this makes the first mutation of a bug-fix run fail until there is
 * evidence behind it, which is the same rule expressed as something that can
 * actually stop the run.
 *
 * What counts as evidence is deliberately broad — any of the ways the toolkit lets
 * you observe a running system. What does NOT count is reading the source, which
 * is the substitute the model reaches for on its own.
 *
 * It also does not count when the capture captured NOTHING, and that is subtler
 * than it sounds, because a tool that found nothing still answers at length: a dry
 * `activity_collect` returns a paragraph explaining that the trace is empty. Any
 * test of the OUTPUT therefore passes. So a capture tool states what it observed
 * in `details.captured` (see {@link CAPTURED_FIELD}) and zero is not evidence.
 * Tools that do not publish the field — a host's own, an MCP server's — behave as
 * they always did, so the contract is opt-in and cannot regress them.
 *
 * One route needs an exemption to work at all. The no-MCP route the gate itself
 * recommends is `activity_trace_start` → place `__t()` probes with `edit` → run →
 * `activity_collect` — and that middle step is an `edit`, the very call the gate
 * refuses. Blocking it made the recommended path unreachable: the model was told
 * to instrument, refused when it tried, and then (after `maxBlocks`) allowed to
 * apply the blind fix instead. That is the failure mode inverted — the gate was
 * steering runs AWAY from reproduction. So once a trace session is open, an `edit`
 * that only adds or removes probes is allowed through: see
 * {@link instrumentationTarget}, which requires a probe delta AND that no real
 * code moved, so the exemption cannot carry a fix.
 */

import { detectShellAuthoring, probeOnlyReplacement } from "../tools/builtin/coding.js";
import { assessStraightforward } from "./straightforward-assessor.js";

/** Tools whose successful result means the run has observed the real system. */
const REPRODUCTION_TOOLS = [
  // Instrumented a flow and read back what it recorded.
  "activity_collect",
  // Drove the running app — a page, a simulator, a device — and captured it.
  "activity_inspect",
  // Read a log the project itself writes.
  "activity_tail_file",
  // Reasoned over a captured trace.
  "activity_study",
];

/**
 * True for a tool name that produces reproduction evidence, allowing for the
 * prefixes an MCP server adds (`some-server__activity_inspect`, etc.).
 */
export function isReproductionTool(name: string): boolean {
  return REPRODUCTION_TOOLS.some((t) => name === t || name.endsWith(`__${t}`));
}

/**
 * The tool that OPENS the instrumentation window. Deliberately NOT reproduction
 * evidence: `activity_trace_start` only hands back a traceId and a `__t()`
 * snippet, and a trace that never ran proves nothing (only `activity_collect`
 * with output does). What it does establish is that the run has committed to the
 * instrument-and-run route — which is what earns it the right to edit probes in.
 */
export function isTraceOpenTool(name: string): boolean {
  return name === "activity_trace_start" || name.endsWith("__activity_trace_start");
}

/**
 * Whether a mutation is INSTRUMENTATION rather than a fix — a call that adds or
 * removes activity-monitor probes and changes nothing else.
 *
 * Only `edit` qualifies, and only because `edit` carries both halves of the
 * change: the anchor and the replacement. That pair is what makes the judgement
 * possible — {@link probeOnlyReplacement} needs a probe delta AND every other
 * line to survive. A whole-file `write` carries no anchor to compare against (the
 * gate holds no filesystem), so it is never exempt; the trace tool's own contract
 * says probes go in with `read`/`edit`.
 *
 * The replacement arrives as `newString` normally and as `probe` under
 * `authorOnlyWrites`, where the schema drops `newString` and `probe` is the one
 * channel that writes bytes verbatim. Both are judged by the same predicate the
 * `edit` tool validates with, so the gate cannot permit a form the tool refuses.
 */
export function instrumentationTarget(
  name: string,
  args: Record<string, unknown> | undefined,
): { path: string; kind: "insert" | "strip" } | null {
  if (name !== "edit") return null;
  const target = typeof args?.path === "string" ? args.path.trim() : "";
  const anchor = typeof args?.oldString === "string" ? args.oldString : "";
  // PRESENCE, not truthiness: an empty replacement is a deletion — the form a
  // probe strip takes when the whole anchor is a probe line — while an ABSENT one
  // means there is nothing to judge.
  const replacement =
    typeof args?.newString === "string"
      ? args.newString
      : typeof args?.probe === "string"
        ? args.probe
        : undefined;
  if (!target || replacement === undefined) return null;
  const kind = probeOnlyReplacement(anchor, replacement);
  return kind ? { path: target, kind } : null;
}

/** True for the tools this gate guards. */
export function isMutationTool(name: string): boolean {
  return name === "write" || name === "edit";
}

/**
 * Whether a tool call authors file CONTENTS through the shell — the bash escape
 * path around the `write`/`edit` gate. A `sed -i`, a `>`/heredoc redirect, or a
 * `python pathlib write` rewrites source with no authoring pass and no record,
 * so on a bug-fix run the gate must refuse it just as it refuses `edit`. Returns
 * the offending path so the message can name it. `null` for a bash call that is
 * not authoring (build/test/grep/mkdir) or for any non-bash tool.
 */
export function shellAuthoringTarget(name: string, args: Record<string, unknown> | undefined): { path: string; form: string } | null {
  if (name !== "bash") return null;
  const command = typeof args?.command === "string" ? args.command : "";
  if (!command) return null;
  // detectShellAuthoring is the same detector authorOnlyBashTool uses; importing
  // it here keeps the gate's notion of "a shell write" identical to the authoring
  // guard's, so a form blocked by one is blocked by the other.
  return detectShellAuthoring(command);
}

/**
 * The one field a capture tool sets to say HOW MUCH it observed: the number of
 * things it actually captured for the run. `0` means it observed nothing.
 *
 * This is a contract rather than a guess, and the guess is what failed. Reading
 * counts out of a tool's details by name cannot work: a dry trace reports
 * `{ totalLines: 1, traceLines: 0 }` when a single unrelated line sits in the
 * file, so "every count is zero" calls it a real capture and "any count is zero"
 * rejects the healthy `{ totalLines: 2, traceLines: 1 }`. No naming rule
 * distinguishes "lines we observed" from "lines that happened to be there" — the
 * TOOL knows which of its numbers means that, and nothing else does.
 *
 * So each capture tool publishes `captured`. A tool that does not (a host's own,
 * an MCP server's) is treated exactly as before: a successful call with output is
 * evidence. That keeps the contract opt-in and cannot regress an unaware tool.
 */
const CAPTURED_FIELD = "captured";

/**
 * Whether a successful capture actually captured NOTHING — i.e. it published
 * {@link CAPTURED_FIELD} and the value is zero.
 */
function capturedNothing(details?: Record<string, unknown>): boolean {
  return typeof details?.[CAPTURED_FIELD] === "number" && details[CAPTURED_FIELD] === 0;
}

/** True for the ask-the-user tool, under any MCP prefix. */
function isAskUserTool(name: string): boolean {
  return name === "ask_user_question" || name.endsWith("__ask_user_question");
}

export interface ReproductionGateOptions {
  /**
   * Whether this run is a bug fix. Off means the gate is inert — a greenfield
   * feature has nothing to reproduce, and blocking its first write would be
   * nonsense.
   */
  enabled: boolean;
  /**
   * How many mutations to block before giving up and letting the run proceed.
   * Default 2.
   *
   * A gate with no ceiling is a deadlock: a model that cannot work out how to
   * reproduce would be refused forever, burn its budget on the refusal, and end
   * with nothing — strictly worse than an unverified fix. Two refusals is enough
   * to change behaviour when the model CAN comply, and cheap when it cannot.
   */
  maxBlocks?: number;
}

/** What the gate decided about one mutation attempt. */
export type ReproductionVerdict =
  | { kind: "allow" }
  /** Return `message` as an ERROR tool result instead of running the tool. */
  | { kind: "block"; message: string };

/**
 * The structured report for the host/summary. A skip is visible here — a
 * declared straightforward-fix bypass or a maxBlocks give-up is named, never
 * silent, so a run that edited without reproducing is legible after the fact.
 */
export interface ReproductionReport {
  /** True if the model observed the bug (capture/trace/log) before editing. */
  reproduced: boolean;
  /** True if the run asked the user for reproduction steps. */
  askedUser: boolean;
  /** How many times the gate refused a mutation. */
  blocks: number;
  /** Present when the model declared the fix straightforward and skipped. */
  declaredStraightforward?: { reason: string };
  /**
   * True when the gate was lifted by the harness-side assessor (evidence-based:
   * few files, no async, low complexity) rather than the model's self-assertion.
   */
  assessedStraightforward?: boolean;
  /** Present when the gate gave up after maxBlocks refusals. */
  gaveUpAfterBlocks?: number;
  /** True once `activity_trace_start` opened a trace session in this run. */
  traceOpened?: boolean;
  /**
   * Files the run edited under the instrumentation exemption (probe add/strip
   * while a trace was open). Present so a run that instrumented but never
   * collected is legible: probes went in, nothing was harvested.
   */
  instrumentedForTrace?: string[];
}

export class ReproductionGate {
  private sawEvidence = false;
  private askedTheUser = false;
  private blocks = 0;
  private straightforwardReason: string | undefined;
  /**
   * Whether `activity_trace_start` has opened a trace session. This does NOT lift
   * the gate — a trace that never ran is not evidence — it opens the narrow
   * instrumentation window that lets probe edits through.
   */
  private traceOpen = false;
  /** Files edited under the instrumentation exemption (for the report). */
  private readonly instrumentedForTrace: string[] = [];
  /**
   * Whether the gate was lifted by the harness-side assessor (vs the model's
   * `DECLARE_REPRODUCE` self-assertion). Reported so the summary can tell an
   * evidence-based skip from a claimed one.
   */
  private assessedStraightforward = false;
  /**
   * A lazy provider of the read source files (path + content), set by the loop.
   * When set, the gate runs the straightforwardness assessor at BLOCK TIME — the
   * moment a mutation is about to be refused — so the assessment sees ALL files
   * the model has read so far, not just the first one. Without this, lifting
   * after each read would lift on a synchronous first file before the model
   * reads the file that carries the async marker.
   */
  private readFilesProvider: (() => Array<{ path: string; content?: string }>) | undefined;

  constructor(private readonly opts: ReproductionGateOptions) {}

  /**
   * Register a provider the gate consults at block time to run the
   * straightforwardness assessor over everything the model has read so far.
   * The loop calls this so the gate can make the lift decision with the full
   * read set, not the partial one an after-each-read call would see.
   */
  setReadFilesProvider(provider: (() => Array<{ path: string; content?: string }>) | undefined): void {
    this.readFilesProvider = provider;
  }

  /**
   * Record one completed tool call. Call for every tool result.
   *
   * `details` is the tool result's own `details` object when there is one. It is
   * what makes "an empty capture is not evidence" actually true: `outputChars`
   * cannot tell an empty capture from a full one, because a capture that found
   * NOTHING still returns a paragraph explaining that — `activity_collect` on a
   * dry trace answers "no trace lines yet. Either the instrumented code has not
   * run, or the `__t()` helper is not writing…", which is several hundred
   * non-empty characters. So the length test passed and the gate lifted on a
   * trace that proved nothing, which is the precise failure it was written to
   * prevent. The counts the tools already report (`traceLines`, `matched`,
   * `count`) are the honest signal.
   */
  observe(toolName: string, isError: boolean, outputChars: number, details?: Record<string, unknown>): void {
    // A trace session opened. Not evidence — only what the trace CAPTURES is —
    // but from here an `edit` that places or removes `__t()` probes is allowed,
    // so the route the gate recommends can actually be walked.
    if (isTraceOpenTool(toolName) && !isError) {
      this.traceOpen = true;
      return;
    }
    if (isAskUserTool(toolName) && !isError) {
      // The run asked for steps it could not derive. That is the documented way
      // out of "I cannot trigger it", so it satisfies the gate — the user now
      // owns the next move.
      this.askedTheUser = true;
      return;
    }
    // An errored capture is not evidence, and neither is an empty one: a trace
    // that collected nothing tells you the instrumentation did not run, not that
    // the bug is understood.
    if (isReproductionTool(toolName) && !isError && outputChars > 0 && !capturedNothing(details)) {
      this.sawEvidence = true;
    }
  }

  /**
   * The model declares the fix is straightforward and reproduction is not
   * needed (a copy fix, a constant, a one-line config). The reason is recorded
   * — a skip is an auditable bypass, never a silent give-up. Once declared, the
   * gate lifts for the rest of the run, same as if it had seen evidence.
   */
  declareStraightforward(reason: string): void {
    const trimmed = reason.trim();
    if (trimmed) this.straightforwardReason = trimmed;
  }

  /**
   * Run the harness-side straightforwardness assessor over the plan/read
   * signals and lift the gate when the fix is GENUINELY simple (few source
   * files, no concurrency constructs, low declared complexity). This is the
   * verified counterpart to the model's `DECLARE_REPRODUCE` self-assertion: it
   * grounds the lift in the actual code rather than trusting the model's claim.
   *
   * Idempotent: a no-op once the gate is already lifted by evidence, an ask, or
   * any prior lift. Returns whether THIS call lifted the gate (for logging).
   * `undefined` assessment (not enough signal yet) leaves the gate armed.
   */
  assessAndLift(
    planTasks: Array<{ files: string[]; complexity: import("../types.js").ComplexityRating }> | undefined,
    readFiles: Array<{ path: string; content?: string }> | undefined,
  ): boolean {
    if (!this.opts.enabled) return false;
    // Already lifted by any means — nothing to do.
    if (this.sawEvidence || this.askedTheUser || this.straightforwardReason) return false;
    const assessment = assessStraightforward({ planTasks, readFiles });
    if (!assessment?.straightforward) return false;
    this.straightforwardReason = assessment.reason;
    this.assessedStraightforward = true;
    return true;
  }

  /**
   * Judge one mutation attempt, before the tool runs. `args` is the call's
   * arguments — read only to detect a `bash` command that authors file contents
   * (the shell escape path around the `write`/`edit` gate); ignored for other
   * tools.
   */
  check(toolName: string, args?: Record<string, unknown>): ReproductionVerdict {
    if (!this.opts.enabled) return { kind: "allow" };
    const shellWrite = shellAuthoringTarget(toolName, args);
    if (!isMutationTool(toolName) && !shellWrite) return { kind: "allow" };
    if (this.sawEvidence || this.askedTheUser) return { kind: "allow" };
    if (this.straightforwardReason) return { kind: "allow" };
    // The instrumentation window. With a trace session open, an `edit` that only
    // adds or removes probes is the reproduction being SET UP, not a fix jumping
    // the queue — refusing it is what made the recommended no-MCP route
    // unreachable. Checked before the assessor and before `blocks` is touched, so
    // instrumenting never spends a refusal or lifts the gate as a side effect.
    if (this.traceOpen) {
      const probe = instrumentationTarget(toolName, args);
      if (probe) {
        if (!this.instrumentedForTrace.includes(probe.path)) this.instrumentedForTrace.push(probe.path);
        return { kind: "allow" };
      }
    }
    // Block-time assessment: before refusing, run the assessor over EVERYTHING
    // the model has read so far (via the provider the loop registered). This is
    // the moment all reads have accumulated, so the assessment sees the full
    // file set and can catch an async marker in a file read AFTER the first one
    // — the gap an after-each-read lift would miss (lifting on a synchronous
    // first file before the async file is read).
    if (this.readFilesProvider) {
      this.assessAndLift(undefined, this.readFilesProvider());
      if (this.straightforwardReason) return { kind: "allow" };
    }
    if (this.blocks >= (this.opts.maxBlocks ?? 2)) return { kind: "allow" };

    this.blocks += 1;
    // A trace is open and this edit is still not instrumentation — i.e. the run
    // set up the trace and then went straight for the fix. Say exactly that, and
    // what the difference is: the probe edit is permitted, this one changes real
    // code. Without the distinction the generic refusal reads as "instrumentation
    // is blocked too", which is what pushed earlier runs back to blind fixing.
    if (this.traceOpen && isMutationTool(toolName)) {
      return {
        kind: "block",
        message:
          `${toolName}: a trace session is OPEN but nothing has been collected from it yet, and this call changes ` +
          `real code rather than placing probes — so it is a fix, not instrumentation, and it is refused for now.\n` +
          `DO THIS NEXT, in order:\n` +
          `  1. \`add_log\` — anchor on the exact line (\`oldString\`) and pass it back with your ` +
          `\`TURING_TRACE …\` line added (\`newString\`). It writes verbatim, it is not ` +
          `a code change, and it cannot change code.\n` +
          `  2. RUN the flow so the probes execute.\n` +
          `  3. \`activity_collect\` with the traceId. Once it returns captured output you have observed the bug ` +
          `and this edit is allowed.\n` +
          `Do NOT call \`activity_trace_start\` again — you already have an open session, and a second one ` +
          `records nothing either. Do NOT go back to reading source: the gap between what the code says and what ` +
          `it does is what you are missing, and only running it closes that. If the flow cannot be run here, call ` +
          `\`ask_user_question\` for the steps rather than guessing.`,
      };
    }
    if (shellWrite) {
      return {
        kind: "block",
        message:
          `${toolName}: this run is fixing a REPORTED BUG and nothing has observed it yet, so authoring file ` +
          `contents through the shell (${shellWrite.form} → ${shellWrite.path}) is refused for now — it is the ` +
          `same editing-before-reproducing the \`edit\` tool is gated on, reached through \`bash\`.\n` +
          `Reproduce the bug first (drive the app with \`activity_inspect\`, instrument with ` +
          `\`activity_trace_start\` → \`add_log\` → \`activity_collect\`, or read a log with ` +
          `\`activity_tail_file\`), then apply the fix through \`write\`/\`edit\` so it is authored and recorded. ` +
          `Probes go in through \`edit\`, never through the shell. If you cannot trigger it, call ` +
          `\`ask_user_question\` for the steps. If it is genuinely straightforward (a typo/constant with no ` +
          `runtime behaviour), declare it: \`DECLARE_REPRODUCE { "reason": "..." }\`.`,
      };
    }
    return {
      kind: "block",
      message:
        `${toolName}: this run is fixing a REPORTED BUG and nothing has observed it yet, so this edit is ` +
        `refused for now. Reading the source tells you what the code should do; the bug is the gap between ` +
        `that and what it DOES, and editing before you have seen the gap means editing the plausible file ` +
        `rather than the failing one — with no baseline to prove the fix against afterwards.\n` +
        `Do ONE of these first, then re-issue this call:\n` +
        `  - Drive the running app and capture it: \`activity_inspect\` (\`url\` for a page, \`bundleId\` or a ` +
        `deep link for a simulator/device). Best for a visible symptom.\n` +
        `  - Instrument the flow: \`activity_trace_start\` → \`add_log\` (anchor a line, add your \`TURING_TRACE …\` ` +
        `line to it; written verbatim, never treated as a code change) → run the flow → \`activity_collect\`. ` +
        `Best for wrong data, nothing happening, or intermittent behaviour. This needs no MCP.\n` +
        `  - Read a log the project already writes: \`activity_tail_file\`.\n` +
        `  - If you genuinely cannot trigger it — no steps, no credentials, no device — call ` +
        `\`ask_user_question\` for the exact reproduction steps instead of guessing.\n` +
        `  - If this is genuinely a STRAIGHTFORWARD fix that needs no reproduction (a typo, a constant, a ` +
        `one-line config change with no runtime behaviour), say so with a declaration: ` +
        `\`DECLARE_REPRODUCE { "reason": "<why it needs no reproduction>" }\`. A skip is logged and auditable.`,
    };
  }

  /** Structured report for the summary and the host. */
  toReport(): ReproductionReport {
    const r: ReproductionReport = {
      reproduced: this.sawEvidence,
      askedUser: this.askedTheUser,
      blocks: this.blocks,
    };
    if (this.straightforwardReason) r.declaredStraightforward = { reason: this.straightforwardReason };
    if (this.assessedStraightforward) r.assessedStraightforward = true;
    if (this.traceOpen) r.traceOpened = true;
    if (this.instrumentedForTrace.length) r.instrumentedForTrace = [...this.instrumentedForTrace];
    if (this.blocks >= (this.opts.maxBlocks ?? 2) && !this.sawEvidence && !this.askedTheUser && !this.straightforwardReason) {
      r.gaveUpAfterBlocks = this.blocks;
    }
    return r;
  }
}

/**
 * Parse a `DECLARE_REPRODUCE { "reason": "…" }` block from a turn's text. The
 * keyword is distinct from the verify gate's `DECLARE` so the two loops (which
 * run at different times) cannot misread each other's declarations. Tolerant:
 * malformed JSON is skipped, never thrown.
 */
export function parseReproduceDeclaration(text: string): { reason: string } | undefined {
  if (!text) return undefined;
  const m = text.match(/DECLARE_REPRODUCE\s*(\{[\s\S]*?\})/);
  if (!m) return undefined;
  try {
    const obj = JSON.parse(m[1]) as Record<string, unknown>;
    if (typeof obj.reason === "string" && obj.reason.trim()) return { reason: obj.reason };
  } catch {
    // skip malformed
  }
  return undefined;
}
