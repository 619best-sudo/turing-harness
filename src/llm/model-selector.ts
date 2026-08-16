/**
 * Complexity estimation + model selection (req #7).
 *
 * The orchestrator uses this to pick a model per phase/tool call when the
 * permission callback doesn't pin one. Selection is driven by:
 *   - operation complexity (tool breadth, context size, mutation, attachments)
 *   - required input modalities (an audio attachment forces an audio-capable model)
 */
import type { Attachment, Complexity, MediaRef, Modality, Model } from "../types.js";
import { MODEL_CATALOG, resolveModel } from "./models.js";

export interface ComplexityInput {
  /** Number of tools available/likely for the operation. */
  toolCount?: number;
  /** Characters of prompt/context (proxy for token load). */
  contextChars?: number;
  /** Whether the operation mutates state. */
  mutates?: boolean;
  /** Attachments/refs involved (weight by size & modality). */
  attachments?: Attachment[];
  refs?: MediaRef[];
  /** Explicit bump, e.g. the plan phase is inherently harder. */
  bias?: number;
}

/** Compute a 0..1 complexity score plus the signals behind it. */
export function estimateComplexity(input: ComplexityInput): Complexity {
  const toolBreadth = Math.min((input.toolCount ?? 0) / 12, 1);
  const contextSize = Math.min((input.contextChars ?? 0) / 60_000, 1);
  const attachmentCount = (input.attachments?.length ?? 0) + (input.refs?.length ?? 0);
  const attachmentWeight = Math.min(attachmentCount / 4, 1);
  const mutation = input.mutates ? 1 : 0;

  // Weighted blend; mutations and planning bias raise the floor.
  let score =
    0.3 * toolBreadth +
    0.3 * contextSize +
    0.2 * attachmentWeight +
    0.2 * mutation +
    (input.bias ?? 0);
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    signals: { toolBreadth, contextSize, attachmentWeight, mutation: input.mutates ?? false },
  };
}

/** Modalities required by a set of attachments/refs. */
export function requiredModalities(attachments?: Attachment[], refs?: MediaRef[]): Modality[] {
  const mods = new Set<Modality>(["text"]);
  const add = (mime: string | undefined, type?: string) => {
    if (mime?.startsWith("image/") || type === "image") mods.add("image");
    else if (mime?.startsWith("audio/") || type === "audio") mods.add("audio");
    else if (mime?.startsWith("video/") || type === "video") mods.add("video");
    else mods.add("file");
  };
  for (const a of attachments ?? []) add(a.mimeType, a.type);
  for (const r of refs ?? []) add(r.mimeType);
  return [...mods];
}

export interface SelectModelInput extends ComplexityInput {
  /** Preferred slug (from permission decision or phase default). Wins if capable. */
  preferred?: string;
  /** Candidate slugs to choose from when picking by complexity. */
  candidates?: string[];
  /** Precomputed complexity (skips re-estimation). */
  complexity?: Complexity;
}

/**
 * Tiered fallbacks used when no explicit candidate list is provided. Ordered
 * cheap → capable; selection walks up the tiers as complexity rises.
 *
 * All three tiers are the same model today, so this pool escalates to nothing —
 * a host that wants real escalation supplies `toolModelCandidates` or a
 * `routeModel`. That is deliberate, and it has to stay in step with
 * `DEFAULT_PHASE_MODELS`: if these tiers named a WEAKER model than the driver,
 * the staged read would "escalate" a hard file DOWNWARD — the tier id differs
 * from the driver's, so the `escalatedId === currentId` short-circuit would not
 * catch it, and a file judged beyond the driver would be explained by something
 * smaller.
 */
const COMPLEXITY_TIERS: string[] = [
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5",
];

function supportsModalities(model: Model, needed: Modality[]): boolean {
  return needed.every((m) => m === "text" || model.input.includes(m));
}

/**
 * Select a model. Precedence:
 *   1. `preferred` slug, if it supports the required modalities.
 *   2. cheapest candidate/tier that (a) supports the modalities and
 *      (b) matches the complexity tier.
 */
export function selectModel(input: SelectModelInput): { model: Model; complexity: Complexity } {
  const complexity = input.complexity ?? estimateComplexity(input);
  const needed = requiredModalities(input.attachments, input.refs);

  if (input.preferred) {
    const m = resolveModel(input.preferred);
    if (supportsModalities(m, needed)) return { model: m, complexity };
  }

  const pool = (input.candidates?.length ? input.candidates : COMPLEXITY_TIERS)
    .map(resolveModel)
    .filter((m) => supportsModalities(m, needed));

  const usable = pool.length ? pool : selectFallbackByModality(needed);

  // Map complexity to a tier index across the usable pool.
  const idx = Math.min(usable.length - 1, Math.floor(complexity.score * usable.length));
  const chosen = usable[idx] ?? usable[usable.length - 1];
  return { model: chosen!, complexity };
}

/** When no tier supports the needed modalities, scan the whole catalog. */
function selectFallbackByModality(needed: Modality[]): Model[] {
  const all = Object.values(MODEL_CATALOG).filter((m) => supportsModalities(m, needed));
  if (all.length) return all.sort((a, b) => a.cost.input - b.cost.input);
  // Last resort: a permissive resolved model (Gemini handles every modality).
  return [resolveModel("google/gemini-2.5-pro")];
}
