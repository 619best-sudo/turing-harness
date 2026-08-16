/**
 * A static (no-LLM) straightforwardness assessor for the reproduce-before-edit
 * gate.
 *
 * The gate arms UP FRONT from the task text (is it a bug fix?), but whether a
 * bug fix is GENUINELY SIMPLE enough to skip reproduction depends on the code —
 * and the code is only known after the model has read it. This module turns the
 * signals available post-read (how many source files, is there
 * async/concurrency, how hard the READER rated the files, how hard the planner
 * rated the work) into a verdict that lets the
 * gate lift for a trivial fix (a one-line title typo in a static HTML file)
 * while keeping reproduction required for the hard cases (a multi-file async
 * polling bug).
 *
 * It replaces the model's UNVERIFIED `DECLARE_REPRODUCE` self-assertion as the
 * primary lift path: the harness now assesses straightforwardness from the
 * actual code rather than trusting the model's claim. The model's declaration
 * remains as a fallback.
 *
 * Deliberately conservative: any concurrency marker or multi-file spread means
 * reproduction stays required, because those are exactly the cases where "I read
 * the code and I know the fix" most reliably fails (the bug is a runtime gap,
 * not a reading gap).
 */

import type { ComplexityRating } from "../types.js";

/**
 * Extensions that count as authored source for the file-spread signal. Mirrors
 * the `AUTHORED_EXTENSIONS` set used by the shell-authoring guard so a fix's
 * "touched files" is judged on the same notion of source. Non-source paths
 * (logs, lockfiles, build output) are ignored — reading a dozen `.log` files
 * says nothing about fix complexity.
 */
const SOURCE_EXTENSIONS =
  /\.(m?[jt]sx?|css|s[ac]ss|html?|json|ya?ml|md|dart|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|php|sql|svg|vue|svelte|astro|toml|sh|bash|zsh|lua|r|sc|scala|clj|ex|exs|erl|elm|fs|hs|ml|nim|pl|pm|tcl|vala|v)$/i;

/** Whether a path is authored source (vs a log/lockfile/build artifact). */
export function isSourceFile(p: string): boolean {
  return SOURCE_EXTENSIONS.test(p);
}

/**
 * Tokens whose presence in read source marks the fix as concurrency-sensitive.
 * These are the constructs behind the polling/status bug this was designed for
 * (`Future`, `Timer`, `Stream`, `await`) and their cross-language equivalents.
 * A single hit means reproduction stays required: async bugs are runtime gaps a
 * read cannot close, and "I traced the code" is the claim that fails most often
 * there.
 */
const CONCURRENCY_TOKENS = [
  "async",
  "await",
  "Future",
  "Timer",
  "Completer",
  "Stream",
  "Promise",
  ".then(",
  "setTimeout",
  "setInterval",
  "process.nextTick",
  "DispatchQueue",
  "Task",
  "channel",
  "mutex",
  "semaphore",
  "atomic",
  "volatile",
  "synchronized",
  "polling",
];

/**
 * Whether file CONTENT carries a concurrency marker. Word-bounded for the short
 * identifiers (`async`, `await`, `Future`, …) to avoid matching them inside
 * longer words; substring for the punctuation-bearing forms (`.then(`).
 */
export function scanForConcurrencyRisk(content: string): boolean {
  if (!content) return false;
  for (const token of CONCURRENCY_TOKENS) {
    if (token.startsWith(".") || token.includes("(")) {
      if (content.includes(token)) return true;
    } else if (new RegExp(`\\b${token}\\b`).test(content)) {
      return true;
    }
  }
  return false;
}

export interface StraightforwardAssessment {
  /** True when the fix is simple enough to skip reproduction. */
  straightforward: boolean;
  /** An evidence-backed reason the gate records in lieu of a self-assertion. */
  reason: string;
}

export interface AssessStraightforwardInput {
  /**
   * The planner's tasks, when a planning turn ran. `files` is the multi-file
   * spread signal; `complexity` is the planner's difficulty rating.
   */
  planTasks?: Array<{ files: string[]; complexity: ComplexityRating }>;
  /**
   * Distinct source paths the model has actually read so far, with their
   * content available for the concurrency scan. Used on the planless path
   * (no plan) and as corroboration on the plan path.
   *
   * `rating` is the MEASURED complexity of that file, from the staged read that
   * loaded it — not a self-report. It is the signal that stops this assessor
   * being gamed by ignorance: every other input here gets SAFER the less the
   * model has looked at (one file read, no async seen), so a run that reads one
   * file and reaches for an edit — the exact pattern the reproduce gate exists to
   * stop — presents as the most straightforward fix there is. The rating does not
   * move that way, because it describes the file rather than the run's progress
   * through it.
   */
  readFiles?: Array<{ path: string; content?: string; rating?: ComplexityRating }>;
}

/** Max source files a straightforward fix may touch/read. */
const MAX_FILES_STRAIGHTFORWARD = 2;

/**
 * Decide whether a bug fix is straightforward enough to skip reproduction.
 * Returns `undefined` when there is not enough signal yet (the gate stays
 * armed) — e.g. before any source file has been read.
 *
 * The verdict is conservative by design: it only returns `straightforward: true`
 * when ALL of (a) few source files are involved, (b) no read file carries a
 * concurrency marker, and (c) the planner (when present) rated the work `low`.
 * A single async marker or a 3+ file spread keeps reproduction required.
 */
export function assessStraightforward(
  input: AssessStraightforwardInput,
): StraightforwardAssessment | undefined {
  // Collect the distinct source files involved: from the plan's `files` (what
  // the fix will touch) and from what the model actually read. Both are signal
  // — a fix that "touches one file" but read four is not narrow in practice.
  const planSourceFiles = new Set(
    (input.planTasks ?? [])
      .flatMap((t) => t.files ?? [])
      .filter(isSourceFile)
      .map((p) => p.toLowerCase()),
  );
  const readSource = (input.readFiles ?? []).filter((f) => isSourceFile(f.path));
  const readSourcePaths = new Set(readSource.map((f) => f.path.toLowerCase()));

  // No source file seen anywhere yet → not enough signal to decide. The gate
  // stays armed; reassess after more reads.
  if (planSourceFiles.size === 0 && readSourcePaths.size === 0) return undefined;

  const involvedCount = new Set([...planSourceFiles, ...readSourcePaths]).size;

  // (a) file spread: a fix spanning more than a couple of source files is not
  // straightforward, regardless of how it reads.
  if (involvedCount > MAX_FILES_STRAIGHTFORWARD) {
    return {
      straightforward: false,
      reason: `${involvedCount} source file(s) involved — too broad to skip reproduction.`,
    };
  }

  // (b) concurrency: scan the content the model actually read. Any async /
  // Future / Timer / Promise marker means the bug is a runtime gap a read
  // cannot close, so reproduction stays required.
  const concurrencyHit = readSource.find((f) => f.content && scanForConcurrencyRisk(f.content));
  if (concurrencyHit) {
    return {
      straightforward: false,
      reason: `read source carries a concurrency construct (async/Future/Timer/Promise) in ${concurrencyHit.path} — runtime gap, reproduction required.`,
    };
  }

  // (c) MEASURED complexity of the files actually read. A file the reader rated
  // above `low` is, by that rubric, one where "subtle control flow, invariants
  // that are not stated locally, or a wrong edit breaks callers elsewhere" — which
  // is a description of a fix you cannot verify by reading. This is checked
  // BEFORE the planner's rating because it is evidence about the code rather than
  // a judgement made before the code was seen.
  const measured = readSource.find((f) => f.rating && f.rating !== "low");
  if (measured) {
    return {
      straightforward: false,
      reason: `${measured.path} was measured ${measured.rating} complexity on read — not a fix to make unobserved.`,
    };
  }

  // (d) declared complexity: when the planner rated the work, `low` is the only
  // rating consistent with "skip reproduction". medium/high keep the gate armed.
  const ratings = (input.planTasks ?? []).map((t) => t.complexity);
  if (ratings.length && ratings.some((r) => r !== "low")) {
    return {
      straightforward: false,
      reason: `planner rated the work ${ratings.find((r) => r !== "low")} — not low-complexity.`,
    };
  }

  // All three checks passed (or were unevaluated for lack of a plan): the fix
  // is narrow, synchronous, and low-complexity. Safe to lift.
  const filePart = involvedCount === 1 ? "one source file" : `${involvedCount} source files`;
  const planPart = ratings.length ? ", planner-rated low" : "";
  const measuredPart = readSource.some((f) => f.rating) ? ", measured low on read" : "";
  return {
    straightforward: true,
    reason: `Assessed straightforward: ${filePart}${planPart}${measuredPart}, no concurrency constructs in the read source.`,
  };
}
