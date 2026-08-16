/**
 * Cleaning up what an authoring model actually returns.
 *
 * The two-step mutation contract asks a second model for file bytes (or an edit
 * replacement) and writes what comes back. The system prompt says "output ONLY
 * the raw file contents — no markdown code fences, no commentary", and models
 * comply at wildly different rates. The harness therefore has to be robust to
 * non-compliance, because it is meant to work with whatever model the user
 * prefers, not only the ones that follow that sentence.
 *
 * It was not. The old stripper was a single regex —
 *
 *     /^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/
 *
 * — which matches ONE shape: a perfectly balanced fence with nothing before or
 * after it. Every other shape a model produces was written into the user's
 * source verbatim. Measured against that regex, only the clean case survived:
 *
 *     stripped      balanced, clean
 *     NOT STRIPPED  leading newline
 *     NOT STRIPPED  preamble line ("Here is the replacement:")
 *     NOT STRIPPED  unbalanced (close only)
 *     NOT STRIPPED  unbalanced (open only)
 *     NOT STRIPPED  info string with a trailing space
 *     NOT STRIPPED  tilde fence
 *     NOT STRIPPED  trailing prose after the close
 *
 * An observed run on a Dart file shows the consequence. Four consecutive
 * authored edits each added stray blank lines and eventually wrote a bare ```
 * into the middle of a widget tree — a syntax error — and the driver, which
 * could see the damage but not the cause, spent the rest of the run trying to
 * repair a file the harness was corrupting underneath it:
 *
 *     1145  'Delete Account?',
 *     1146
 *     1147  ```
 *     1148  style: TextStyle(
 *
 * So: strip what is provably an artifact, repair the blank line it leaves
 * behind, and REPORT what was removed rather than doing it silently.
 *
 * The one place this must not overreach is Markdown, where a fence is content.
 * Markdown targets therefore only lose a wrapping pair; everything else keeps
 * its fences.
 */

/**
 * Extensions whose CONTENT legitimately contains code fences.
 *
 * Prose formats, not programming languages — for these a fence is the point of
 * the file, so only a wrapping pair is ever removed and nothing outside it is
 * discarded. Anything not listed is treated as source, which is the safe
 * default: the sweep there removes only markers that cannot be content (see
 * `sweepFenceLines`), so an unlisted prose format loses nothing real either.
 */
const FENCE_BEARING_EXTENSIONS = [
  ".md", ".mdx", ".markdown", ".mdown", ".mkd", ".rmd", ".qmd",
  ".adoc", ".asciidoc", ".rst", ".txt", ".mdc",
];

/** True when a fence inside this file's body is content rather than an artifact. */
export function targetAllowsFences(path: string | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return FENCE_BEARING_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * A line that is ENTIRELY a fence marker (plus an optional info string).
 *
 * Deliberately anchored to the whole line. A fence inside a doc comment is
 * written ` * ```ts`, and the leading `*` keeps it from matching here — so
 * JSDoc/KDoc examples survive.
 */
const FENCE_LINE_RE = /^[ \t]*(?:```+|~~~+)[^\s`~]*[ \t]*\r?$/;

/** True for a line that is only a fence marker. */
export function isFenceLine(line: string): boolean {
  return FENCE_LINE_RE.test(line);
}

/** A line with no content. */
function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * A line of NARRATION — a model talking about its answer rather than giving it
 * ("Here is the updated file:", "That should do it.").
 *
 * This has to be decided WITHOUT knowing the language, and the obvious test —
 * "does it contain code punctuation?" — is a C-family assumption that quietly
 * destroys other stacks. Measured, an earlier version of this function
 * classified `name: app` (YAML) and `package main` (Go) as prose and DELETED
 * them, because neither carries a brace or a semicolon.
 *
 * So the test is inverted: rather than asking "is this not code?", ask "is this
 * an English sentence?" — which is decidable without a language, and which no
 * common language uses as a whole line of source:
 *
 *   - several words (a bare identifier or keyword is never narration);
 *   - terminated like a sentence — `.`, `:`, `!` or `?`;
 *   - no code punctuation at all;
 *   - starts with a letter.
 *
 * `name: app` fails on the terminator. `package main` fails on the terminator.
 * `dependencies:` fails on the word count. `end` fails on both. Being wrong in
 * the conservative direction just means the block is not unwrapped, and the
 * caller falls through to a sweep that removes only fence markers — lossless.
 */
function looksLikeNarration(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 200) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  if (!/\s/.test(t)) return false;
  if (/[;{}()[\]<>=|&$#@`\\]/.test(t)) return false;
  return /[.:!?]$/.test(t);
}

export interface SanitizeOptions {
  /** Target path, used only to decide whether fences are legitimate content. */
  path?: string;
  /** Force the markdown behaviour regardless of path. */
  allowFences?: boolean;
}

export interface SanitizedOutput {
  text: string;
  /** How many whole-line fence markers were removed. 0 ⇒ nothing was touched. */
  fencesRemoved: number;
  /** True when prose surrounding a fenced block was discarded. */
  proseRemoved: boolean;
}

/**
 * Strip markdown artifacts from authored output.
 *
 * Two strategies, in order:
 *
 *  1. UNWRAP. If the output is a fenced block (optionally with prose around it),
 *     return what is inside the outermost fence. This is the common, benign
 *     case and it is exact — nothing is guessed at.
 *
 *  2. SWEEP. Otherwise, remove lines that are nothing but a fence marker. Only
 *     for non-Markdown targets, where such a line cannot be content. This is
 *     what catches the unbalanced fence that corrupted a Dart file, and it is
 *     also what a naive regex can never catch, because there is no matching
 *     pair to anchor on.
 *
 * Blank-line repair runs after a sweep: a fence sitting alone between two blank
 * lines leaves a doubled blank line behind when removed, and that doubling is
 * the "extra blank space" half of the reported symptom.
 */
export function sanitizeAuthoredText(raw: string, opts: SanitizeOptions = {}): SanitizedOutput {
  const text = raw.replace(/^﻿/, "");
  if (!text.trim()) return { text, fencesRemoved: 0, proseRemoved: false };
  const allowFences = opts.allowFences ?? targetAllowsFences(opts.path);

  const unwrapped = unwrapFencedBlock(text, allowFences);
  if (unwrapped) return unwrapped;

  // Markdown keeps its fences: without a wrapping pair to remove there is
  // nothing here that is safely distinguishable from content.
  if (allowFences) return { text, fencesRemoved: 0, proseRemoved: false };

  return sweepFenceLines(text);
}

/**
 * Return the contents of the outermost fenced block, when the output IS one.
 *
 * Requires a matching pair, so nothing is invented. Prose before the opening
 * fence and after the closing fence is discarded — that is the model narrating,
 * and writing it into a source file is the failure this exists to prevent.
 * Returns null when the shape does not apply, so the caller can fall through.
 *
 * `allowFences` (a Markdown target) makes this strictly narrower: prose outside
 * the fence is CONTENT there, not narration, so only whitespace may surround
 * the block. Without that distinction, authoring a README whose body happens to
 * start with a paragraph and contain one example block would return just the
 * example and silently delete the prose around it — a far worse failure than
 * the stray fence this module exists to remove.
 */
function unwrapFencedBlock(text: string, allowFences: boolean): SanitizedOutput | null {
  const lines = text.split("\n");
  const fenceIdx: number[] = [];
  for (let i = 0; i < lines.length; i += 1) if (isFenceLine(lines[i]!)) fenceIdx.push(i);
  if (fenceIdx.length < 2) return null;

  const open = fenceIdx[0]!;
  const close = fenceIdx[fenceIdx.length - 1]!;
  // Everything before the opening fence and after the closing one must be
  // discardable — blank, or a line of narration. A code line out there means
  // this is not a wrapped block and the sweep should handle it instead.
  const before = lines.slice(0, open);
  const after = lines.slice(close + 1);
  const discardable = (l: string) => isBlank(l) || (!allowFences && looksLikeNarration(l));
  if (!before.every(discardable) || !after.every(discardable)) return null;

  const inner = lines.slice(open + 1, close).join("\n");
  // An empty block is not an unwrap, it is a model that answered with nothing;
  // let the caller's own empty-output handling report that honestly.
  if (!inner.trim()) return null;
  return {
    text: inner,
    fencesRemoved: 2,
    proseRemoved: before.some((l) => !isBlank(l)) || after.some((l) => !isBlank(l)),
  };
}

/**
 * Remove the fence markers that CANNOT be content, and repair the blank line
 * each one leaves behind.
 *
 * Used when there is no wrapping pair to unwrap. Which markers qualify is
 * decided by position and parity, not by language — the point is to be right on
 * a stack this file has never heard of:
 *
 *   EDGE — a fence that is the first or last non-blank line of the reply. No
 *     language begins or ends a file, or an edit fragment, with a bare ```. This
 *     is the artifact a paired regex can never see, because its partner is
 *     missing, and it is what corrupted the observed Dart file.
 *
 *   ODD — after the edges, an odd number of fences left inside cannot be
 *     balanced, so at least one is spurious and none of them can be trusted as
 *     content.
 *
 * An EVEN number of interior fences is left ALONE. That is the case a
 * language-blind sweep gets wrong: a Python or Elixir docstring may legitimately
 * carry a fenced example at column zero, and an earlier version of this function
 * deleted exactly that. Leaving a balanced interior pair costs nothing when it
 * really was an artifact (the compiler complains and the run fixes it) and saves
 * a silent corruption when it was not.
 */
function sweepFenceLines(text: string): SanitizedOutput {
  const lines = text.split("\n");
  const fenceIdx: number[] = [];
  for (let i = 0; i < lines.length; i += 1) if (isFenceLine(lines[i]!)) fenceIdx.push(i);
  if (!fenceIdx.length) return { text, fencesRemoved: 0, proseRemoved: false };

  const firstContent = lines.findIndex((l) => !isBlank(l));
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!isBlank(lines[i]!)) { lastContent = i; break; }

  const doomed = new Set<number>();
  for (const i of fenceIdx) if (i === firstContent || i === lastContent) doomed.add(i);
  const interior = fenceIdx.filter((i) => !doomed.has(i));
  if (interior.length % 2 === 1) for (const i of interior) doomed.add(i);
  if (!doomed.size) return { text, fencesRemoved: 0, proseRemoved: false };

  const out: string[] = [];
  let fencesRemoved = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!doomed.has(i)) {
      out.push(lines[i]!);
      continue;
    }
    fencesRemoved += 1;
    // The fence sat alone between two blank lines: dropping it would leave the
    // two blanks adjacent, which is the stray whitespace users notice. Drop one.
    const prevBlank = out.length > 0 && isBlank(out[out.length - 1]!);
    const nextBlank = i + 1 < lines.length && isBlank(lines[i + 1]!);
    if (prevBlank && nextBlank) i += 1;
  }
  return { text: out.join("\n"), fencesRemoved, proseRemoved: false };
}

/**
 * The convenience form: just the cleaned text.
 *
 * Kept because most callers only want the bytes; the structured form is for the
 * one that reports what it removed.
 */
export function stripAuthoredArtifacts(raw: string, opts: SanitizeOptions = {}): string {
  return sanitizeAuthoredText(raw, opts).text;
}

/**
 * Whether an authored replacement is the draft with blank lines sprinkled in.
 *
 * The second half of the reported symptom. On the observed run the author was
 * asked to fix one line's indentation and returned the same code with a blank
 * line inserted between unrelated properties — repeatedly, each edit adding
 * another:
 *
 *     child: Column(              child: Column(
 *       mainAxisSize: …,     →
 *       crossAxis…: …,              mainAxisSize: …,
 *       children: [
 *                                   crossAxis…: …,
 *
 * That is not a better authoring of the change; it is drift. Detecting it in
 * general is hopeless, but this exact shape is decidable: if the two texts are
 * IDENTICAL once blank lines are ignored, then the only thing the author
 * contributed was blank lines, and the draft is the better bytes.
 *
 * Deliberately narrow. It fires only when the author changed nothing else, so it
 * can never discard real authoring work — if the author improved a single
 * character anywhere, the texts differ and the authored version stands.
 */
export function isBlankLineDriftOnly(authored: string, draft: string): boolean {
  if (!draft.trim() || authored === draft) return false;
  const withoutBlanks = (t: string) =>
    t.split("\n").filter((l) => l.trim() !== "").join("\n");
  if (withoutBlanks(authored) !== withoutBlanks(draft)) return false;
  const blanks = (t: string) => t.split("\n").filter((l) => l.trim() === "").length;
  return blanks(authored) > blanks(draft);
}
