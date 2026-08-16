/**
 * Content-hash reuse for `media_analysis`.
 *
 * `media_analysis` was fire-and-forget: every call re-read the file from disk
 * and re-asked the model, even when the same image had been analysed moments
 * before under the same lens and the same prompt. A run that looks at a screen
 * with `lens:"ui"` and then again with `lens:"qa"` correctly pays twice (the
 * question differs), but a run that describes the same screen twice with the
 * same words should not — and an earlier version of this module only cached the
 * single `lens:"ui"` sliver the design-reference synthesizer wanted, leaving
 * every other lens to re-run.
 *
 * This mirrors the read tool's comprehension reuse (`comprehension.ts`):
 * process-local, keyed on content hash, superseded on re-analysis, unbounded
 * but tiny (a run analyses a handful of distinct attachments).
 *
 * The key is `path + fileHash + lens + promptHash`. The lens and prompt are
 * part of the key because two different questions about the same bytes are two
 * different analyses; the file hash is part of it because an analysis of
 * different bytes would read as current and mislead the next consumer.
 */
import { createHash } from "node:crypto";
import type { MediaLens } from "./media-analysis.js";

interface RememberedMediaAnalysis {
  /** SHA-1 of the attachment bytes the analysis was produced from. */
  fileHash: string;
  /** The lens the analysis ran under. */
  lens: MediaLens;
  /** SHA-1 of the prompt text the analysis answered. */
  promptHash: string;
  /** The model's analysis, verbatim. */
  analysis: string;
}

/** Composite key: everything that distinguishes one analysis from another. */
function keyOf(path: string, fileHash: string, lens: MediaLens, promptHash: string): string {
  return `${path}\u0001${fileHash}\u0001${lens}\u0001${promptHash}`;
}

const mediaAnalysisByKey = new Map<string, RememberedMediaAnalysis>();

/** SHA-1 of arbitrary bytes, matching `comprehension.hashContent`'s shape. */
export function hashImageBytes(bytes: Buffer | string): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** SHA-1 of the prompt text, so two questions about the same image do not collide. */
export function hashPrompt(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex");
}

/**
 * Record an analysis so a later call for the same bytes + lens + prompt returns
 * it without a provider round-trip. Empty analyses are not stored: a blank
 * result is not worth re-serving, and recording it would mask a transient
 * failure as a permanent one.
 */
export function rememberMediaAnalysis(
  path: string,
  fileHash: string,
  lens: MediaLens,
  promptHash: string,
  analysis: string,
): void {
  if (!analysis.trim()) return;
  mediaAnalysisByKey.set(keyOf(path, fileHash, lens, promptHash), {
    fileHash,
    lens,
    promptHash,
    analysis,
  });
}

/**
 * Recall an analysis for `path` under `lens`/`prompt`, but only if the bytes
 * still match `fileHash`. Returns `undefined` on any mismatch — a stale
 * analysis of a different image would mislead the caller.
 */
export function recallMediaAnalysis(
  path: string,
  fileHash: string,
  lens: MediaLens,
  promptHash: string,
): string | undefined {
  const entry = mediaAnalysisByKey.get(keyOf(path, fileHash, lens, promptHash));
  if (!entry || entry.fileHash !== fileHash) return undefined;
  return entry.analysis;
}

/**
 * Drop every analysis for `path` once the attachment has been replaced — they
 * describe the old bytes. Kept for symmetry with `comprehension.ts`'s
 * `forgetComprehension`, for callers that track attachment replacement.
 */
export function forgetMediaAnalysis(path: string): void {
  for (const k of mediaAnalysisByKey.keys()) {
    if (k.startsWith(`${path}\u0001`)) mediaAnalysisByKey.delete(k);
  }
}

/** Test seam. Clears every cached analysis. */
export function clearMediaAnalysisMemory(): void {
  mediaAnalysisByKey.clear();
}

// ---------------------------------------------------------------------------
// Back-compat alias for the prior UI-only API.
//
// The original module cached only `lens:"ui"` single-image analyses and exposed
// `rememberUiAnalysis`/`recallUiAnalysis`. Nothing internal calls those after
// the general cache replaced them, but the names are kept as thin wrappers so a
// host that imported them keeps compiling and behaves identically.
// ---------------------------------------------------------------------------

/**
 * Record a UI-lens analysis. Kept as a back-compat wrapper over the general
 * cache; prefer {@link rememberMediaAnalysis}.
 *
 * @deprecated use {@link rememberMediaAnalysis} with the lens and prompt hash.
 */
export function rememberUiAnalysis(path: string, fileHash: string, analysis: string): void {
  rememberMediaAnalysis(path, fileHash, "ui", hashPrompt(""), analysis);
}

/**
 * Recall a UI-lens analysis for `path` if the bytes match. Kept as a back-compat
 * wrapper; prefer {@link recallMediaAnalysis}.
 *
 * Note: the original accepted only (path, fileHash) and returned the single
 * stored UI analysis. The general cache is also keyed on the prompt, so this
 * wrapper recalls the analysis stored with an empty prompt — which is what
 * {@link rememberUiAnalysis} stores. Existing callers that stored via the old
 * API continue to hit.
 *
 * @deprecated use {@link recallMediaAnalysis} with the lens and prompt hash.
 */
export function recallUiAnalysis(path: string, fileHash: string): string | undefined {
  return recallMediaAnalysis(path, fileHash, "ui", hashPrompt(""));
}
