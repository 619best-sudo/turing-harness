/**
 * Model catalog + resolver.
 *
 * Any OpenRouter slug ("vendor/model") can be resolved to a {@link Model} on the
 * fly; the catalog just provides richer metadata (cost, context window,
 * modalities) for the models the harness knows about.
 */
import type { Model, Modality } from "../types.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function or(
  slug: string,
  name: string,
  opts: Partial<Model> & { input?: Modality[] } = {},
): Model {
  return {
    id: slug,
    name,
    api: "openrouter",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE,
    reasoning: opts.reasoning ?? true,
    input: opts.input ?? ["text", "image"],
    cost: opts.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? 200_000,
    maxTokens: opts.maxTokens ?? 32_000,
    openRouterSlug: slug,
    ...opts,
  };
}

/**
 * A small built-in catalog. Costs are indicative (USD per token) and can be
 * overridden by the consumer. Modalities gate model selection for attachments.
 */
export const MODEL_CATALOG: Record<string, Model> = {
  "xiaomi/mimo-v2.5": or("xiaomi/mimo-v2.5", "Xiaomi MiMo v2.5", {
    // OMNIMODAL INPUT — verified against OpenRouter (input_modalities
    // ["text","image","audio","video"], 1.05M context). This entry claimed
    // TEXT ONLY for months under a "verify before widening" hedge; the check
    // the old comment asked for finally ran and it is text-only no longer.
    // Native image input is what the QA hops pin this model for: captures pass
    // through untouched instead of detouring through a vision description —
    // and no modality lie means no provider 404 killing the run.
    input: ["text", "image", "audio", "video"],
    cost: { input: 1.4e-7, output: 2.8e-7, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_000,
  }),
  "tencent/hy3": or("tencent/hy3", "Tencent Hy3", {
    // TEXT ONLY — verified against OpenRouter (`input_modalities: ["text"]`).
    // Registered explicitly (rather than falling through to the permissive
    // unknown-slug default, which claims image support) so the harness's vision
    // guard correctly treats hy3 as blind: an image-bearing write escalated to
    // hy3 falls through to a vision-capable candidate instead of being sent to a
    // model that would reject the whole request.
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 32_000,
  }),
  "poolside/laguna-xs-2.1": or("poolside/laguna-xs-2.1", "Poolside Laguna XS 2.1", {
    // TEXT ONLY — verified against OpenRouter (`input_modalities: ["text"]`,
    // context 262_144). The OpenWaggleMain driver. Registered after a field run
    // died at its first `mobile look`: unregistered, the permissive default
    // claimed image support, the screenshot rode the next request, and OpenRouter
    // rejected the WHOLE request (404 "No endpoints found that support image
    // input") — an app already launched on the simulator was abandoned mid-inspect
    // because nobody navigated after the crash. Registered, the vision guard
    // routes tool screenshots to the configured vision model's description
    // instead, and the run keeps driving by the element tree.
    input: ["text"],
    contextWindow: 262_144,
  }),
  "poolside/laguna-s-2.1": or("poolside/laguna-s-2.1", "Poolside Laguna S 2.1", {
    // TEXT ONLY — verified against OpenRouter (`input_modalities: ["text"]`,
    // context 1_048_576). Same trap as laguna-xs above, one slug up: the
    // reproduce hop pins this model, and until this entry the first screenshot
    // there would kill the request the same way. Registered so the vision guard
    // treats it as blind and describes captures instead of serialising them.
    input: ["text"],
    contextWindow: 1_048_576,
  }),
  "openai/gpt-5-nano": or("openai/gpt-5-nano", "GPT-5 Nano", {
    // Verified against OpenRouter: input_modalities ["text","image","file"],
    // 400k context. Native vision — the reason the inspect hop pins it: its
    // currency is screenshots, which pass through untouched instead of being
    // rejected (text-only driver) or detoured through a vision description.
    input: ["text", "image", "file"],
    cost: { input: 5e-8, output: 4e-7, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
  }),
  "bytedance-seed/seed-2.0-mini": or("bytedance-seed/seed-2.0-mini", "Seed 2.0 Mini", {
    input: ["text", "image", "file"],
    contextWindow: 256_000,
    maxTokens: 32_000,
  }),
  "anthropic/claude-opus-4.8": or("anthropic/claude-opus-4.8", "Claude Opus 4.8", {
    input: ["text", "image", "file"],
    cost: { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite: 6.25e-6 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  }),
  "anthropic/claude-sonnet-4.5": or("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", {
    input: ["text", "image", "file"],
    cost: { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  }),
  "anthropic/claude-haiku-4.5": or("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", {
    input: ["text", "image"],
    cost: { input: 1e-6, output: 5e-6, cacheRead: 0.1e-6, cacheWrite: 1.25e-6 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }),
  "openai/gpt-5": or("openai/gpt-5", "GPT-5", {
    // No audio input — verified against OpenRouter.
    input: ["text", "image", "file"],
    cost: { input: 2.5e-6, output: 10e-6, cacheRead: 0.25e-6, cacheWrite: 0 },
  }),
  "google/gemini-2.5-pro": or("google/gemini-2.5-pro", "Gemini 2.5 Pro", {
    input: ["text", "image", "audio", "video", "file"],
    cost: { input: 1.25e-6, output: 10e-6, cacheRead: 0.31e-6, cacheWrite: 0 },
    contextWindow: 1_000_000,
  }),
  "google/gemini-2.5-flash": or("google/gemini-2.5-flash", "Gemini 2.5 Flash", {
    input: ["text", "image", "audio", "video", "file"],
    cost: { input: 0.3e-6, output: 2.5e-6, cacheRead: 0.075e-6, cacheWrite: 0 },
    contextWindow: 1_000_000,
  }),
  "google/gemini-3.7-flash": or("google/gemini-3.7-flash", "Gemini 3.7 Flash", {
    input: ["text", "image", "audio", "video", "file"],
    cost: { input: 0.3e-6, output: 2.5e-6, cacheRead: 0.075e-6, cacheWrite: 0 },
    contextWindow: 1_000_000,
  }),
};

/** Default models used per 4P phase when nothing else is specified. */
export const DEFAULT_PHASE_MODELS = {
  prepare: "xiaomi/mimo-v2.5",
  plan: "xiaomi/mimo-v2.5",
  perform: "xiaomi/mimo-v2.5",
  perfect: "xiaomi/mimo-v2.5",
  // NOTE: `phaseModelSlug` never indexes this key — it resolves a phase, then
  // falls back to a HOST-supplied `models.orchestrator`, then to the per-phase
  // entry above. So this entry is documentation of the default driver, not a
  // switch: changing it alone changes nothing, which is why the four phases
  // above moved with it.
  orchestrator: "xiaomi/mimo-v2.5",
} as const;

/**
 * Resolve a slug to a Model. Known slugs come from the catalog; unknown slugs get
 * a permissive default descriptor (all-modality, generous window) so any
 * OpenRouter model works without registration.
 */
export function resolveModel(slug: string): Model {
  const known = MODEL_CATALOG[slug];
  if (known) return known;
  return or(slug, slug, {
    input: ["text", "image", "audio", "video", "file"],
    reasoning: true,
  });
}

/** Register or override a model in the catalog. */
export function registerModel(model: Model): void {
  MODEL_CATALOG[model.openRouterSlug ?? model.id] = model;
}
