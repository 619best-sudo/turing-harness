/**
 * Per-target attachment routing.
 *
 * The run keeps a LIVE image set (attachments from the prompt, from a plan step,
 * from an `ask_user_question` answer). Every one of those used to be unioned into
 * every `write`/`edit` call, which is correct for the common single-mockup run and
 * wrong the moment a run carries more than one screen: authoring `Login.tsx` with
 * the login, settings AND checkout mockups attached produces a file that borrows
 * from all three. A design reference is only a reference for the file it depicts.
 *
 * So an image reaches a write only when the run can say WHY it belongs to that
 * file, in this order:
 *
 *   1. `call-named` — the call passed `images`. The model looked at the analyses
 *      and chose; nothing is added to that choice and nothing is substituted for
 *      it. This is the authoritative channel and always wins.
 *   2. `routed`     — the attachment declares `targets` (a planner routing a
 *      mockup to the step that builds it, a host binding a file up front).
 *   3. `affinity`   — the attachment's filename/label and the target path share a
 *      distinctive token (`login-screen.png` → `src/screens/Login.tsx`), and the
 *      match is a strict winner. Free, and right often enough to be worth trying.
 *   4. `sole`       — one candidate in the whole run. The single-mockup case: no
 *      ambiguity exists, so no evidence is required.
 *   5. `ambiguous`  — several candidates and no way to tell them apart. NO image
 *      is passed, and the caller is told what the choice was. Authoring from the
 *      wrong reference is a worse failure than authoring from prose, because the
 *      output looks deliberate.
 *
 * An attachment routed to a DIFFERENT target is never a candidate here — that
 * exclusion is the whole point, and it holds even when it leaves this call with
 * nothing.
 */

import type { LiveImage } from "../types.js";

export type { LiveImage };

export type ImageScopeReason = "call-named" | "routed" | "affinity" | "sole" | "ambiguous" | "none";

export interface ImageScope {
  /** The images this call should author from. Empty for `ambiguous`/`none`. */
  images: LiveImage[];
  reason: ImageScopeReason;
  /**
   * Populated only for `ambiguous`: the paths that were in contention, so the
   * caller can name them back to the model and let it pick.
   */
  candidates?: string[];
}

/** Tokens that describe every mockup ever exported and so distinguish none of them. */
const NOISE = new Set([
  "screen", "screens", "page", "pages", "view", "views", "mock", "mockup", "mockups",
  "design", "designs", "ref", "reference", "final", "copy", "image", "img", "images",
  "screenshot", "screenshots", "ui", "ux", "figma", "export", "frame", "asset", "assets",
  "light", "dark", "mobile", "desktop", "tablet", "web", "app", "new", "old", "draft",
  "src", "app", "lib", "components", "component", "pages", "index", "main",
  "png", "jpg", "jpeg", "webp", "gif", "svg", "pdf", "tsx", "jsx", "ts", "js", "vue",
  "svelte", "dart", "swift", "kt", "html", "css", "scss",
]);

/**
 * Split a path into comparable tokens: path separators, punctuation and camelCase
 * boundaries all break, everything lowercases, noise and pure numbers drop.
 * `src/screens/LoginScreen.tsx` → `login`; `login-screen-v2.png` → `login`.
 */
export function tokenize(raw: string): Set<string> {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !NOISE.has(w) && !/^\d+$/.test(w) && !/^v\d+$/.test(w));
  return new Set(words);
}

/** Compare two file paths ignoring `./`, leading slashes and separator direction. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * Does `declared` (a target on an attachment) refer to `target` (the file being
 * written)? True on an exact normalized match, or when one path ends with the
 * other on a segment boundary — a plan routes `src/screens/Login.tsx` while the
 * call writes an absolute path, and those are the same file.
 */
export function targetMatches(declared: string, target: string): boolean {
  const a = normalizePath(declared);
  const b = normalizePath(target);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Affinity score: how many distinctive tokens the attachment and the target share. */
function affinityScore(image: LiveImage, target: string): number {
  const imageTokens = tokenize(`${image.path} ${image.label ?? ""}`);
  if (imageTokens.size === 0) return 0;
  const targetTokens = tokenize(target);
  let score = 0;
  for (const t of targetTokens) if (imageTokens.has(t)) score += 1;
  return score;
}

/**
 * Decide which of the run's live images this write/edit should author from.
 *
 * @param target     the file being written.
 * @param live       the run's live attachment set.
 * @param callNamed  images the call named explicitly; authoritative when present.
 */
export function scopeImagesForTarget(
  target: string,
  live: readonly LiveImage[],
  callNamed: readonly LiveImage[] = [],
): ImageScope {
  // 1. The model chose. Its choice is the answer — the live set does not get to
  //    add to it, because "I want this one mockup" and "I want this one plus the
  //    two the run happens to be holding" are different instructions.
  if (callNamed.length) return { images: [...callNamed], reason: "call-named" };
  if (!live.length) return { images: [], reason: "none" };

  // 2. Explicit routing. An attachment bound to this file wins outright; one
  //    bound elsewhere is removed from contention entirely, which is what keeps a
  //    sibling screen's mockup out of this file.
  const routed = live.filter((img) => img.targets?.some((t) => targetMatches(t, target)));
  if (routed.length) return { images: routed, reason: "routed" };
  const unrouted = live.filter((img) => !img.targets?.length);
  if (!unrouted.length) return { images: [], reason: "none" };

  // 3. Name affinity, and only when it is a strict winner: two images tying on
  //    "login" is not evidence, it is a coin toss with extra steps.
  const scored = unrouted.map((img) => ({ img, score: affinityScore(img, target) }));
  const best = Math.max(...scored.map((s) => s.score));
  if (best > 0) {
    const winners = scored.filter((s) => s.score === best);
    if (winners.length === 1) return { images: [winners[0]!.img], reason: "affinity" };
  }

  // 4. One candidate, no ambiguity to resolve — the ordinary single-mockup run.
  if (unrouted.length === 1) return { images: [unrouted[0]!], reason: "sole" };

  // 5. Several, indistinguishable. Pass none and report the contention.
  return { images: [], reason: "ambiguous", candidates: unrouted.map((i) => i.path) };
}

/**
 * The note handed back to the model when routing came out `ambiguous`. It names
 * the candidates and the one argument that resolves it, so the next attempt is a
 * choice rather than a retry.
 */
export function ambiguityNote(target: string, candidates: readonly string[]): string {
  return (
    `${candidates.length} reference images are attached to this run and none of them is bound to ${target}, ` +
    `so this call authored WITHOUT one rather than mixing designs that belong to different files. ` +
    `If one of these is the design for ${target}, re-issue the call with images: ["<the one>"]:\n` +
    candidates.map((c) => `  - ${c}`).join("\n")
  );
}
