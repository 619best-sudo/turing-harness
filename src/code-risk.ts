/**
 * The places code actually breaks.
 *
 * Read, write and edit all pass through a complexity gate: `low` proceeds with
 * the current model, `medium`/`high` escalate to a stronger one (the reading side
 * decides internally in `stageRead`; the writing side is decided by the host via
 * `PermissionDecision.authorModel`). But a stronger model is only worth its cost
 * if it is looking at the right things — and empirically, wrong edits cluster in
 * the same seven places regardless of language or framework.
 *
 * This module is the single, shared enumeration of those places, consumed by all
 * three prompt paths so they cannot drift:
 *
 *   - `comprehension.ts` RATE_SYSTEM      — these are the DIFFICULTY signals
 *   - `comprehension.ts` COMPREHEND_SYSTEM — report these, for the reader
 *   - `authoring.ts` AUTHOR/EDIT_SYSTEM   — get these right, when writing bytes
 *   - `phases/prompts.ts`                 — the requesting model's own checklist
 *
 * Deliberately phrased as *what goes wrong* rather than as rules to obey: the
 * point is to aim attention, not to add ceremony. A model that has read the real
 * callers and says why a branch is safe has done the work; one that recites the
 * list has not.
 */

/**
 * The seven risk sites, as failure modes. Kept compact on purpose — this text is
 * prepended to every escalated read and every authored write, so it is paying
 * rent on each call.
 */
export const CODE_RISK_SITES = [
  "1. CONDITIONALS AND BRANCHES — every branch, including the one nobody wrote. What happens on the",
  "   implicit else, and on null / undefined / 0 / \"\" / empty-array, which truthiness checks silently",
  "   collapse together? Are negation and && / || precedence right? Does a guard clause actually return",
  "   early, or fall through? A new branch must still handle every state the old code handled.",
  "2. FUNCTIONS THAT RETURN A VALUE — the return contract is an API. Does EVERY path return, or can one",
  "   fall off the end as undefined? Is the shape identical on the success, empty and error paths (returning",
  "   null in one place and [] in another is a caller-side crash)? If you change what a function returns or",
  "   accepts, find and update its callers — that is the single most common way a local edit breaks",
  "   something far away.",
  "3. SYNC VS ASYNC — a missing `await` is invisible until it isn't. Is every promise awaited or",
  "   deliberately handed off? Errors in an un-awaited call become unhandled rejections, not catchable",
  "   failures. `map`/`forEach`/`filter` callbacks cannot await — use `for await` or `Promise.all`. Awaiting",
  "   inside a loop is sequential (sometimes correct, often needlessly slow); `Promise.all` is parallel",
  "   (sometimes correct, sometimes a rate-limit violation or a race). Does cleanup still run on the throw",
  "   path? Is ordering guaranteed, or only usually observed?",
  "4. LOOPS AND ITERATION — boundaries and the empty case. Off-by-one at either end, the zero-iteration",
  "   path, accumulators initialized wrong, mutating a collection while iterating it, `break`/`continue`",
  "   skipping necessary work, closures capturing the loop variable, and per-iteration I/O that turns into",
  "   an N+1 or an unbounded fan-out.",
  "5. OTHER FILES THAT DEPEND ON THIS — the change set is rarely one file. Who imports this symbol and what",
  "   do they assume about it? Renaming or re-shaping an export, moving a file, or touching a barrel/index",
  "   re-export ripples outward; shared types must be updated on both sides. Use `graph_memory`",
  "   (blast_radius / symbol_deps) or a literal search to enumerate the callers instead of hoping.",
  "6. LIBRARIES AND EXTERNAL APIs — code is written against the version actually installed, not the one you",
  "   remember. Does the function exist with that signature in THIS version (check package.json/lockfile,",
  "   go.mod, requirements.txt)? Are option names, defaults, sync-vs-promise variants and throw-vs-return-",
  "   error semantics right? ESM/CJS import form? If something that should work doesn't, read the changelog",
  "   for a breaking change rather than re-guessing the call.",
  "7. EXPENSIVE WORK — cost that is invisible at one item and fatal at ten thousand. Is the heavy",
  "   computation inside a render, a loop or a request handler when it could run once and be cached? Does it",
  "   recompute on every call because nothing memoizes it? Is it O(n²) (a nested scan, a `find` inside a",
  "   `map`) over input with no bound? Does it block — sync I/O, a long CPU pass on the main thread/event",
  "   loop — where the caller expected to stay responsive? State the input size you assumed.",
].join("\n");

/** Rater framing: these are the signals that make a file expensive to get wrong. */
export const CODE_RISK_FOR_RATING = [
  "Difficulty concentrates in seven places — weight them when you judge:",
  CODE_RISK_SITES,
  "",
  "Density of these, not line count, is the signal. A 2000-line generated barrel file or a config map is",
  "LOW however large; a 60-line function with nested conditionals, an un-awaited call and three callers",
  "elsewhere is HIGH.",
].join("\n");

/** Comprehension framing: what the stronger model must surface for the reader. */
export const CODE_RISK_FOR_COMPREHENSION = [
  "Aim your analysis at the seven places edits actually break, and be specific to THIS file with line numbers:",
  CODE_RISK_SITES,
].join("\n");

/**
 * Comprehension framing for INTERFACE files, where the logic enumeration above is
 * the wrong checklist.
 *
 * The authoring side already made this distinction — `systemFor` in authoring.ts
 * gives `ui`/`svg` the bare format contract and reserves the seven sites for code,
 * because a model told to walk a concurrency checklist before drawing a component
 * draws a conservative component. The READ side had no equivalent, so a UI file
 * came back with several KB about `await`, loop boundaries and blast radius: risks
 * that were real in the file and irrelevant to the change, repeated on every
 * re-read, crowding out the thing the reader had actually asked about.
 *
 * These are the places an interface edit breaks instead. Fewer, and none of them
 * are about control flow.
 */
export const UI_RISK_FOR_COMPREHENSION = [
  "This is INTERFACE code. Do NOT walk a logic checklist — no paragraphs about await, loop bounds or return",
  "contracts unless this file genuinely turns on them. Aim at where an interface edit actually breaks, and be",
  "specific to THIS file with line numbers:",
  "1. WHAT RENDERS WHAT — which block on screen each part of this file produces, so the reader can find the",
  "   thing being changed without reading the whole tree. Name the enclosing widget/component/element for the",
  "   region the task points at.",
  "2. CONDITIONAL AND PLATFORM RENDERING — branches that decide whether something appears at all: feature",
  "   flags, role/permission checks, platform or breakpoint gates, empty and loading states. A change to a",
  "   branch that is off by default is invisible until it isn't.",
  "3. SHARED STYLE AND TOKENS — values that come from a theme, token, constant or shared style rather than",
  "   from here. Editing the literal instead of the token, or the token instead of the literal, is the most",
  "   common wrong fix; say which one this file uses.",
  "4. DUPLICATED SURFACES — another place in this file (or an obvious sibling) that renders the same thing,",
  "   so a change lands in one copy and not the other. Say if the region the task names appears more than once.",
  "5. TEXT AND CONTENT SOURCE — whether copy is inline here or comes from a localization/constants file. An",
  "   edit to an inline string that is actually overridden elsewhere silently does nothing.",
  "6. LAYOUT CONSTRAINTS THAT WILL BREAK — fixed sizes, overflow/clipping, alignment or intrinsic-size",
  "   assumptions that a longer string or a taller element would break. Flag only what this file really has.",
].join("\n");

/** Authoring framing: what Model B must get right in the bytes it produces. */
export const CODE_RISK_FOR_AUTHORING = [
  "Before you emit the code, walk these seven places — they are where edits break, whether you are writing",
  "something new, modifying what is there, or fixing a bug:",
  CODE_RISK_SITES,
  "",
  "Where the context you were given is not enough to be sure about a caller, a return shape or a library",
  "signature, write the code that is correct under both readings rather than guessing at one.",
].join("\n");
