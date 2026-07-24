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
  "poolside/laguna-xs-2.1": or("poolside/laguna-xs-2.1", "Laguna XS 2.1", {
    input: ["text", "image", "file"],
    contextWindow: 256_000,
    maxTokens: 32_000,
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
    input: ["text", "image", "audio", "file"],
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
};

/** Default models used per 4P phase when nothing else is specified. */
export const DEFAULT_PHASE_MODELS = {
  prepare: "poolside/laguna-xs-2.1",
  plan: "poolside/laguna-xs-2.1",
  perform: "poolside/laguna-xs-2.1",
  perfect: "poolside/laguna-xs-2.1",
  orchestrator: "poolside/laguna-xs-2.1",
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
