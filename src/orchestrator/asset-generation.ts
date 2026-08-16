/**
 * Auto-generate the image/video/audio assets a design reference calls for.
 *
 * When {@link triageImageAttachment} (inspiration) or the design skill produces a
 * section blueprint for a fresh UI build, the blueprint's `elements` describe the
 * roles each region needs — including media roles ("product photo", "background
 * video", "voiceover"). The authoring pass that writes the UI otherwise sees only
 * the structural reference and has to either invent a placeholder or author the
 * media blind. This module reads those media roles off the blueprint and fulfills
 * them up front via `assets_generator`, so the write can embed real paths.
 *
 * The same "prompt advice does not bind" lesson that made the harness auto-invoke
 * `inspiration_generator` applies here: telling the model to call
 * `assets_generator` is a suggestion it can skip, and the observed failure was UI
 * shipped with `placeholder.png`-style holes because the model never generated the
 * imagery the design implied. Fulfilling the need here guarantees the assets exist
 * when one is achievable.
 *
 * Bounded and resilient by design: at most {@link MAX_NEEDS} generations per fresh
 * build, deduped by role; the `assets_generator` tool not being registered, a
 * missing backend (→ a flagged placeholder), or any single generation failure
 * skips that need and never blocks the write.
 */
import type { AgentTool, LLMBridge, LogEntry, Usage } from "../types.js";
import type { LogStore } from "../logging/logger.js";
import type { Registry } from "../registry/registry.js";

export type GeneratedAssetKind = "image" | "video" | "audio";

/** One asset the harness generated to fulfill a blueprint media role. */
export interface GeneratedAssetRef {
  /** Path/URI the authoring pass embeds (e.g. an `<img src>`/`<video src>`). */
  path: string;
  kind: GeneratedAssetKind;
  /** The element role this was generated for (e.g. "product photo"). */
  role: string;
  /** True when `assets_generator` wrote a stand-in (no real backend). */
  placeholder?: boolean;
}

/** A media need detected on a blueprint element, ready to generate. */
export interface MediaNeed {
  kind: GeneratedAssetKind;
  role: string;
  prompt: string;
}

/** Cap on generations per fresh UI build, to bound cost. */
const MAX_NEEDS = 8;

// Roles that map to a generatable asset. Checked as substrings, case-insensitive.
// Deliberately EXCLUDES "animation" (that is the blueprint's motion spec, not an
// asset) and "icon"/"logo" (project-specific marks a generator cannot produce).
const VIDEO_TOKENS = ["video", "background-video", "cinemagraph", "clip", "footage", "movie"];
const AUDIO_TOKENS = ["audio", "sound", "music", "voiceover", "voice-over", "narration", "soundtrack", "ambience"];
const IMAGE_TOKENS = [
  "image", "photo", "picture", "illustration", "thumbnail", "hero-image",
  "product-image", "background-image", "imagery",
];

/** Substring-classify an element role into a generatable kind. */
function classifyRole(role: string): GeneratedAssetKind | undefined {
  const r = role.toLowerCase();
  // Video/audio before image: a compound role like "background video" should not
  // be caught by an image token, and the video/audio token sets are disjoint from
  // the image one anyway.
  if (VIDEO_TOKENS.some((t) => r.includes(t))) return "video";
  if (AUDIO_TOKENS.some((t) => r.includes(t))) return "audio";
  if (IMAGE_TOKENS.some((t) => r.includes(t))) return "image";
  return undefined;
}

/** Read the role-ish string off a loose blueprint element (tries common keys). */
function elementRole(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const o = el as Record<string, unknown>;
  for (const k of ["role", "type", "kind", "name"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** An aspect-ratio hint if the element carries one (e.g. "16/9", "1:1"). */
function aspectFromElement(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const o = el as Record<string, unknown>;
  for (const k of ["aspect", "aspectRatio", "ratio"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Build the generation prompt for one media need from its section context. */
function buildPrompt(
  kind: GeneratedAssetKind,
  role: string,
  sectionName: string,
  sectionDesc: string,
  category: string,
  task: string,
  aspect: string | undefined,
): string {
  const where = [category && category !== "section" ? category : "", sectionName].filter(Boolean).join(" — ");
  const article = /^[aeiou]/i.test(role) ? "An" : "A";
  const parts = [
    `${article} ${role} for ${where || "the UI"}.`,
    sectionDesc ? `Section: ${sectionDesc}.` : "",
    `Project context: ${task}.`,
    aspect ? `Aspect ratio ${aspect}.` : "",
    kind === "image"
      ? "Generate a single cohesive image; no text overlays unless the role demands copy."
      : kind === "video"
        ? "A short, seamless, loopable clip suited as a background/hero video."
        : "A short audio clip suited to the role (background music / voiceover / ambience).",
  ].filter(Boolean);
  return parts.join(" ");
}

/** Filename slug for the generated asset, derived from its role. */
function slug(role: string): string {
  return (
    role
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "asset"
  );
}

/**
 * Scan blueprint sections for media-bearing elements and return the distinct
 * asset needs (deduped by kind+role, capped at {@link MAX_NEEDS}).
 */
export function extractMediaNeeds(sections: unknown[], task: string): MediaNeed[] {
  const needs: MediaNeed[] = [];
  const seen = new Set<string>();
  for (const sec of sections) {
    if (typeof sec !== "object" || sec === null) continue;
    const s = sec as Record<string, unknown>;
    const elements = Array.isArray(s.elements) ? s.elements : [];
    const sectionName = typeof s.name === "string" ? s.name : "";
    const sectionDesc = typeof s.description === "string" ? s.description : "";
    const category = typeof s.category === "string" ? s.category : "";
    for (const el of elements) {
      const role = elementRole(el);
      if (!role) continue;
      const kind = classifyRole(role);
      if (!kind) continue;
      const key = `${kind}:${role.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needs.push({
        kind,
        role,
        prompt: buildPrompt(kind, role, sectionName, sectionDesc, category, task, aspectFromElement(el)),
      });
      if (needs.length >= MAX_NEEDS) return needs;
    }
  }
  return needs;
}

/**
 * Fulfill the media needs a design reference describes: call `assets_generator`
 * once per need and collect the paths it wrote. Returns the generated asset refs
 * (each flagged when the tool wrote a placeholder) plus accumulated token usage.
 *
 * No-op (returns empty) when there are no media needs, when `assets_generator` is
 * not registered, or on abort. A single need's failure skips only that need.
 */
export async function generateAssetsFromReference(input: {
  sections: unknown[];
  task: string;
  registry: Registry;
  cwd: string;
  llm: LLMBridge;
  logStore: LogStore;
  signal?: AbortSignal;
}): Promise<{ assets: GeneratedAssetRef[]; usage?: Usage }> {
  const needs = extractMediaNeeds(input.sections, input.task);
  if (!needs.length) return { assets: [] };
  let tool: AgentTool | undefined;
  try {
    tool = input.registry.getTool("assets_generator");
  } catch {
    tool = undefined;
  }
  if (!tool) return { assets: [] };

  const ctx = {
    cwd: input.cwd,
    llm: input.llm,
    registry: input.registry,
    ...(input.signal ? { signal: input.signal } : {}),
    log: (e: LogEntry) => input.logStore.append(e),
  };
  const assets: GeneratedAssetRef[] = [];
  let usage: Usage | undefined;
  for (const need of needs) {
    if (input.signal?.aborted) break;
    try {
      const res = await tool.execute(
        `asset-need-${need.kind}-${need.role}`,
        { kind: need.kind, prompt: need.prompt, name: slug(need.role) },
        ctx,
      );
      if (res.usage) usage = usage ? addUsage(usage, res.usage) : res.usage;
      const details = res.details as {
        uri?: string;
        placeholder?: boolean;
        files?: Array<{ uri?: string }>;
      } | undefined;
      const files = details?.files;
      const fileList =
        files && files.length
          ? files
          : typeof details?.uri === "string"
            ? [{ uri: details.uri }]
            : [];
      for (const f of fileList) {
        if (typeof f.uri === "string" && f.uri.trim()) {
          assets.push({
            path: f.uri.trim(),
            kind: need.kind,
            role: need.role,
            ...(details?.placeholder ? { placeholder: true } : {}),
          });
        }
      }
    } catch {
      // One asset's failure never fails the build; skip it.
    }
  }
  return { assets, ...(usage ? { usage } : {}) };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
