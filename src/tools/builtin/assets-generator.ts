/**
 * Internal tool: assets_generator (req #6).
 *
 * Generates image / video / audio / 3d assets. Generation backends are pluggable:
 * pass your own {@link AssetBackend} functions (calling whatever provider you use).
 * When a modality has no backend configured, a deterministic local placeholder is
 * written so the 4P pipeline still runs end-to-end (and Perfect can audit it).
 *
 * The tool returns the asset by reference (address + summary), never inlining the
 * bytes into the tool result, per req #7.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AgentTool, MediaRef, ToolContext } from "../../types.js";
import { callOpenRouterImages, resolveOpenRouterApiKey } from "../../llm/openrouter.js";

export type AssetKind = "image" | "video" | "audio" | "3d";

/**
 * Per-kind quality defaults appended to a THIN prompt.
 *
 * A generator sees only the prompt string — no conversation, no project
 * context — so "a hero image" yields something generic and unusable. The tool
 * schema asks the model for a dense prompt, but models under-specify anyway,
 * and the cost of a bad generation is a wasted call plus a file the user has to
 * reject.
 *
 * These are deliberately about CRAFT (framing, lighting, fidelity), never about
 * subject matter: inventing content would override what was actually asked for.
 * They are appended only when the prompt is short enough to be under-specified,
 * so a model that wrote a rich prompt is left alone.
 */
const PROMPT_QUALITY_HINTS: Record<AssetKind, string> = {
  image:
    "High detail, deliberate composition and lighting, coherent colour palette, " +
    "clean edges, no text artifacts, no watermark.",
  video:
    "Smooth natural motion, stable framing, consistent lighting and subject " +
    "identity across frames, no flicker or warping.",
  audio:
    "Clean mix, consistent tempo and key throughout, no clipping or background " +
    "noise, natural stereo image.",
  "3d": "Clean topology, sensible scale and proportions, no stray geometry.",
};

/**
 * Words below which a prompt is treated as under-specified. Chosen so a single
 * short phrase ("a red cube") is enriched while a written-out description
 * (roughly a sentence or more of real detail) is left untouched.
 */
const THIN_PROMPT_WORD_COUNT = 12;

/** Append craft hints to a prompt that is too thin to generate well from. */
export function enrichAssetPrompt(kind: AssetKind, prompt: string): string {
  const trimmed = prompt.trim();
  const words = trimmed.split(/\s+/u).filter(Boolean).length;
  if (words >= THIN_PROMPT_WORD_COUNT) return trimmed;
  const hint = PROMPT_QUALITY_HINTS[kind];
  return hint ? `${trimmed}. ${hint}` : trimmed;
}

/**
 * What an input image is FOR. Generation providers treat reference images very
 * differently depending on the job, and the role is the only thing that tells a
 * backend which slot to put the image in:
 *
 * - `reference` — the default: an image the generation should be based on
 *   (image-to-image, a remix, an edit, a subject to keep consistent).
 * - `start_frame` / `last_frame` — video only: the frames the clip opens and
 *   closes on. A first/last-frame pair is how a video model is asked to
 *   interpolate BETWEEN two stills rather than invent motion from a prompt.
 * - `mask` — the region to change (inpainting); everything else is preserved.
 * - `style` — borrow the palette/texture/rendering, not the subject.
 */
export type AssetImageRole = "reference" | "start_frame" | "last_frame" | "mask" | "style";

/** An input image as the CALLER supplies it: a path, an http(s) URL, or a data URL. */
export interface AssetImageInput {
  /** Local path (absolute or cwd-relative), an `http(s)://` URL, or a `data:` URL. */
  path: string;
  /** What the image is for. Defaults to `reference`. */
  role?: AssetImageRole;
}

/**
 * An input image after the tool resolved it — ready for a backend to send with
 * no filesystem access of its own. Local files become `data:` URLs (providers
 * cannot read the host's disk); remote URLs are passed through untouched,
 * because a URL is cheaper over the wire than the base64 of the same bytes.
 */
export interface ResolvedAssetImage {
  role: AssetImageRole;
  /** Ready to send: an `http(s)://` URL or a `data:<mime>;base64,...` URL. */
  url: string;
  mimeType: string;
  /** The path/URL exactly as the caller gave it (for logs and error messages). */
  source: string;
}

export interface AssetRequest {
  kind: AssetKind;
  prompt: string;
  /** Output directory (absolute or relative to cwd). Defaults to `<cwd>/assets`. */
  outDir?: string;
  /** Optional filename (without extension). */
  name?: string;
  /** Modality-specific options (size, duration, voice, format...). */
  options?: Record<string, unknown>;
  /**
   * Input images, already resolved to sendable URLs. Present when the caller
   * asked for image-to-image work: a remix or edit of an existing picture, a
   * style or subject to stay consistent with, a video's start/last frame, an
   * inpainting mask. Empty/absent for pure text-to-media generation.
   */
  images?: ResolvedAssetImage[];
  /**
   * How many assets to produce in this one call (1-10, default 1). Generating a
   * set in a single call is both cheaper and more coherent than N calls — the
   * provider produces variants of the SAME prompt.
   */
  count?: number;
}

/** One generated asset's bytes, as a backend returns them. */
export interface GeneratedAsset {
  bytes: Uint8Array;
  mimeType: string;
  ext: string;
  summary?: string;
}

/** One file the tool wrote for this call. */
export interface AssetFile {
  uri: string;
  mimeType: string;
  size: number;
}

export interface AssetResult {
  uri: string;
  mimeType: string;
  size: number;
  summary: string;
  /** True when no host backend was configured and a stand-in file was written. */
  placeholder?: boolean;
  /**
   * EVERY file this call wrote, in order. `uri`/`mimeType`/`size` above mirror
   * `files[0]` so single-asset callers are unaffected; a `count > 1` call is the
   * only reason this is longer than one entry. Absent when nothing was written
   * (a declined call).
   */
  files?: AssetFile[];
}

/**
 * A backend produces the bytes for one asset kind.
 *
 * Returning an ARRAY is how a backend satisfies `req.count > 1`. Returning a
 * single object stays valid and means "one asset" — every backend written
 * before multi-asset support keeps working unchanged.
 */
export type AssetBackend = (
  req: AssetRequest,
  ctx: ToolContext,
) => Promise<GeneratedAsset | GeneratedAsset[]>;

export interface AssetBackends {
  image?: AssetBackend;
  video?: AssetBackend;
  audio?: AssetBackend;
  "3d"?: AssetBackend;
}

// ---------------------------------------------------------------------------
// Deterministic placeholders (used when no backend is configured)
// ---------------------------------------------------------------------------

function hashColor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `#${h.slice(0, 6)}`;
}

const placeholderBackends: Required<AssetBackends> = {
  async image(req) {
    // One stand-in per requested asset, each seeded differently, so a `count: 3`
    // call still returns three distinct files and the caller's downstream logic
    // (a gallery, a variant picker) exercises the real shape offline.
    const total = req.count ?? 1;
    return oneOrMany(Array.from({ length: total }, (_v, i) => {
      const color = hashColor(`${req.prompt}#${i}`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${color}"/><text x="256" y="256" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle" dominant-baseline="middle">${escapeXml(req.prompt).slice(0, 60)}</text></svg>`;
      return {
        bytes: new TextEncoder().encode(svg),
        mimeType: "image/svg+xml",
        ext: "svg",
        summary: `Placeholder image for: ${req.prompt}`,
      };
    }));
  },
  // The non-image placeholders honour `count` for the same reason the image one
  // does: a caller that asked for three and silently received one exercises a
  // shape it will not meet against a real backend.
  async audio(req) {
    // Minimal valid silent WAV (44-byte header + tiny data chunk).
    return oneOrMany(Array.from({ length: req.count ?? 1 }, () => ({
      bytes: silentWav(),
      mimeType: "audio/wav",
      ext: "wav",
      summary: `Placeholder silent audio for: ${req.prompt}`,
    })));
  },
  async video(req) {
    // No trivially-valid tiny mp4; emit a manifest describing the intended video.
    // The manifest records the resolved frame roles too, so a run that asked for
    // first/last-frame interpolation can see offline that the roles arrived.
    return oneOrMany(Array.from({ length: req.count ?? 1 }, (_v, i) => {
      const manifest = JSON.stringify(
        {
          kind: "video-placeholder",
          prompt: req.prompt,
          options: req.options,
          index: i,
          ...(req.images?.length
            ? { images: req.images.map((img) => ({ role: img.role, source: img.source })) }
            : {}),
        },
        null,
        2,
      );
      return {
        bytes: new TextEncoder().encode(manifest),
        mimeType: "application/json",
        ext: "video.json",
        summary: `Placeholder video manifest for: ${req.prompt}`,
      };
    }));
  },
  "3d": async (req) => {
    // A tiny valid OBJ (unit triangle) as a stand-in 3d asset.
    const obj = "o placeholder\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    return oneOrMany(Array.from({ length: req.count ?? 1 }, () => ({
      bytes: new TextEncoder().encode(obj),
      mimeType: "model/obj",
      ext: "obj",
      summary: `Placeholder 3d object for: ${req.prompt}`,
    })));
  },
};

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
}

function silentWav(): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true); writeStr(36, "data"); view.setUint32(40, 0, true);
  return header;
}

// ---------------------------------------------------------------------------
// OpenRouter image backend
// ---------------------------------------------------------------------------

/**
 * Default image-generation model.
 *
 * Riverflow is an image generation/editing model billed per output image, so the
 * `-fast` variant is the sane default: asset generation happens inside a work
 * loop that may retry, and the slow/expensive variant is not worth it unless the
 * caller asks for it.
 */
export const DEFAULT_IMAGE_MODEL = "sourceful/riverflow-v2-fast";

/** Generation can be slow; well past a normal chat timeout, but still bounded. */
const IMAGE_TIMEOUT_MS = 180_000;

export interface OpenRouterImageBackendConfig {
  /** Model slug. Defaults to {@link DEFAULT_IMAGE_MODEL}. */
  model?: string;
  /** Falls back to `OPENROUTER_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Extra body fields sent on every call (aspect ratio, output format, …). */
  defaults?: Record<string, unknown>;
}

/** Map a reported media type to a file extension. */
function extForMime(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split("+")[0]?.trim().toLowerCase();
  if (!subtype) return "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

/**
 * A real `image` backend backed by OpenRouter's image endpoint.
 *
 * The tool's contract is bytes-in-hand, so this decodes `b64_json` here rather
 * than passing a URL along — the tool is what owns writing the file.
 *
 * Per-call `options` are merged over `defaults` and forwarded verbatim, because
 * the useful knobs are model-specific and an allowlist here would silently drop
 * whatever the caller actually asked for. `model` may be overridden per call.
 */
export function createOpenRouterImageBackend(
  config: OpenRouterImageBackendConfig = {},
): AssetBackend {
  return async (req, ctx) => {
    const { model: perCallModel, ...rest } = { ...config.defaults, ...req.options } as Record<
      string,
      unknown
    >;
    const model =
      (typeof perCallModel === "string" && perCallModel.trim()) ||
      config.model ||
      DEFAULT_IMAGE_MODEL;

    const response = await callOpenRouterImages(
      {
        ...rest,
        model,
        prompt: req.prompt,
        // Explicit args win over `options`: `images`/`count` are the typed,
        // validated surface, while `options` is the untyped escape hatch. A
        // caller who set both meant the specific one.
        ...(req.images?.length ? { input_references: toInputReferences(req.images) } : {}),
        ...((req.count ?? 1) > 1 ? { n: req.count } : {}),
      },
      {
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        timeoutMs: IMAGE_TIMEOUT_MS,
      },
    );

    // Read EVERY entry, not just the first: `n > 1` is answered with a longer
    // `data` array, and taking `data[0]` alone would silently bill the caller
    // for images it never receives.
    const produced = (response.data ?? []).filter((d) => typeof d.b64_json === "string" && d.b64_json);
    if (!produced.length) {
      // Say what actually came back: a silent empty asset is far worse than a
      // loud failure the model can react to.
      throw new Error(
        `${model} returned no image bytes (expected data[].b64_json; got keys: ${Object.keys(
          response.data?.[0] ?? response,
        ).join(", ") || "none"})`,
      );
    }

    return oneOrMany(
      produced.map((d) => {
        const mimeType = d.media_type ?? "image/png";
        return {
          bytes: new Uint8Array(Buffer.from(d.b64_json as string, "base64")),
          mimeType,
          ext: extForMime(mimeType),
          summary: `Generated with ${model} for: ${req.prompt}`,
        };
      }),
    );
  };
}

/**
 * Return a lone asset as a bare object rather than a one-element array.
 *
 * The tool normalizes both, so this is purely for anyone calling a backend
 * DIRECTLY: the overwhelmingly common case is one asset, and it should keep the
 * shape it has always had. Only a genuine batch produces an array.
 */
export function oneOrMany(assets: GeneratedAsset[]): GeneratedAsset | GeneratedAsset[] {
  return assets.length === 1 ? assets[0]! : assets;
}

/**
 * OpenRouter's `/images` reference-image wire format.
 *
 * The endpoint takes a flat, ordered `input_references` array — it has no slot
 * for a role, so the role rides in `req.images` for backends that DO (a video
 * provider with distinct first/last-frame parameters) and only affects ordering
 * here: `start_frame` first, `last_frame` last, so a model that interprets
 * position at least sees the intended sequence.
 */
function toInputReferences(images: readonly ResolvedAssetImage[]): Array<Record<string, unknown>> {
  const rank: Record<AssetImageRole, number> = {
    start_frame: 0,
    reference: 1,
    style: 2,
    mask: 3,
    last_frame: 4,
  };
  return [...images]
    .sort((a, b) => rank[a.role] - rank[b.role])
    .map((img) => ({ type: "image_url", image_url: { url: img.url } }));
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface AssetsGeneratorConfig {
  /**
   * Per-kind generation backends. This is the seam for the host's provider — the
   * harness deliberately ships NO real generator, because image/video/audio APIs
   * (OpenRouter, Runware, Replicate, fal, a self-hosted model...) differ in wire
   * format, auth, and polling semantics, and guessing one wrong is worse than
   * having none. The host owns the request; the tool owns everything around it
   * (output paths, naming, writing bytes, returning the asset by reference).
   *
   * A kind with no backend falls back to a deterministic placeholder so the
   * pipeline still runs offline — and says so loudly in the tool output, so a
   * placeholder is never silently mistaken for a generated asset.
   */
  backends?: AssetBackends;
  /**
   * Resolve a backend per call instead of pinning one per kind. Use when the
   * provider depends on runtime state — a user setting, which API key is
   * present, or a per-request `options.provider`. Consulted BEFORE `backends`;
   * returning undefined falls through to `backends`, then to the placeholder.
   */
  resolveBackend?: (req: AssetRequest, ctx: ToolContext) => AssetBackend | undefined;
  /**
   * Host-supplied image backend that delegates to the host's OWN image service
   * (e.g. OpenWaggleMain's `/turing-machine/images` proxy, which authenticates
   * via JWT and bills centrally). Consulted BEFORE the built-in OpenRouter
   * backend, AFTER `resolveBackend`/`backends`. Prefer this over
   * `openRouterImage` when the host wants image gen routed through its backend
   * rather than calling OpenRouter directly from the harness. `image` only.
   */
  backendImage?: AssetBackend;
  /** Default output directory relative to cwd. */
  defaultOutDir?: string;
  /**
   * Built-in OpenRouter backend for the `image` kind, used when nothing above
   * supplies one. It is only engaged if an API key is resolvable, so offline and
   * test runs still fall through to the placeholder instead of failing on a call
   * that could never have succeeded. Pass `false` to disable it outright, or a
   * config object to pin the model / key / per-call defaults.
   *
   * `image` only: OpenRouter's image endpoint does not produce video, audio, or
   * 3d, and those kinds keep their placeholders until a host supplies a backend
   * (see {@link backendVideo}).
   */
  openRouterImage?: OpenRouterImageBackendConfig | false;
  /**
   * Host-supplied VIDEO backend, the exact counterpart of {@link backendImage}:
   * it delegates to the host's own media service (OpenWaggleMain's
   * `/turing-machine/videos` proxy), which authenticates and bills centrally.
   * Consulted for `kind: "video"` after `resolveBackend`/`backends` and before
   * the placeholder.
   *
   * This is the seam that makes the tool's `start_frame`/`last_frame` roles
   * real. The harness deliberately calls no video provider itself — video
   * generation is asynchronous (submit → poll → download), and the polling,
   * auth and billing belong to the host that already owns them for images.
   * Build one with `createBackendVideoBackend`, which maps the roles onto the
   * `frame_images` / `input_references` shape the proxy forwards.
   */
  backendVideo?: AssetBackend;
}

export function createAssetsGeneratorTool(config: AssetsGeneratorConfig = {}): AgentTool<any, AssetResult> {
  // Built once: the backend is stateless, and resolving the key per call would
  // let a run start with a real generator and silently degrade to placeholders.
  const openRouterImageConfig = config.openRouterImage;
  const openRouterImage =
    openRouterImageConfig === false ||
    !resolveOpenRouterApiKey(openRouterImageConfig?.apiKey)
      ? undefined
      : createOpenRouterImageBackend(openRouterImageConfig ?? {});

  return {
    name: "assets_generator",
    title: "Generate images, video or icons",
    actionParam: "kind",
    actionTitles: {
      image: "Generate an image",
      video: "Generate a video",
      audio: "Generate audio",
      "3d": "Generate a 3D asset",
    },
    description:
      "Generate an image, video, audio, or 3d asset from a text prompt — the visual/media material a site or " +
      "component needs: hero and section imagery, photographic or illustrative content, textures and background " +
      "art, video loops, voiceover, sound effects. Returns the asset by reference (path + summary), not inline " +
      "bytes. NOT for vector work you should author yourself: icons, logos, UI chrome, diagrams, charts, and " +
      "ANY SVG that will be animated — write those as SVG/CSS with `write`, because generated vector output is " +
      "unlabelled path soup that cannot be themed, targeted or animated. A complex STATIC decorative SVG is a " +
      "fair use of this tool; the moment it needs to move, hand-author it instead.",
    mutates: true,
    categorizers: ["write_edit"],
    complexityHint: 0.6,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video", "audio", "3d"], description: "Asset type to generate." },
        prompt: {
          type: "string",
          description:
            "FULL generation prompt — a generator sees only this string, never the conversation, so a " +
            "terse prompt produces a generic asset. Write one or two dense sentences covering, as they " +
            "apply: subject and action; setting; composition and camera (shot size, angle, lens); " +
            "lighting and time of day; colour palette and mood; art style or medium; and level of " +
            "detail. For AUDIO, describe instrumentation, tempo/BPM, key or mood, and length. For " +
            "VIDEO, add camera motion and what changes over the shot. State what to EXCLUDE only if it " +
            "matters. Do not write 'a logo' or 'background music' — say exactly which one.",
        },
        name: { type: "string", description: "Optional output filename (no extension)." },
        outDir: { type: "string", description: "Output directory (default <cwd>/assets)." },
        images: {
          type: "array",
          description:
            "INPUT images to generate FROM — use this whenever the request is grounded in a picture that " +
            "already exists rather than described from nothing. Each entry is {path, role}. `path` is a " +
            "local file (an attachment, an earlier generation, a screenshot), an http(s) URL, or a data " +
            "URL. `role` says what the image is FOR: \"reference\" (default) to remix/edit/extend it or " +
            "keep a subject consistent, \"style\" to borrow only its palette and rendering, \"mask\" for the " +
            "region to change, and — for kind:\"video\" — \"start_frame\"/\"last_frame\" to hand the model the " +
            "stills the clip must open and close on so it interpolates between them instead of inventing " +
            "motion. The `prompt` still says what should CHANGE; the images say what to change.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Local path, http(s) URL, or data URL." },
              role: {
                type: "string",
                enum: ["reference", "start_frame", "last_frame", "mask", "style"],
                description: "What this image is for. Default \"reference\".",
              },
            },
            required: ["path"],
          },
        },
        count: {
          type: "number",
          description:
            "How many assets to produce from this one prompt (1-10, default 1). Ask for several when you " +
            "want VARIANTS to choose between, or a SET that must look like it belongs together (a row of " +
            "section backgrounds, avatars for a team page): one call produces them from the same prompt, " +
            "which is both cheaper and more coherent than repeating the call. Every file is returned. " +
            "Do not inflate it — each asset is billed.",
        },
        options: { type: "object", description: "Backend-specific options (size, duration, voice...)." },
        force: {
          type: "boolean",
          description:
            "Generate even when this tool would normally steer you elsewhere (an animated SVG, which comes " +
            "back as an unanimatable path blob). Set it when the USER asked for exactly this anyway — their " +
            "request outranks the default — and say in your summary that the result will need hand-authoring " +
            "to move.",
        },
      },
      required: ["kind", "prompt"],
    },
    async execute(_id, args, ctx): Promise<{ output: string; details: AssetResult; content: any[] }> {
      const kind = args.kind as AssetKind;
      // Resolve input images BEFORE anything else spends a call: a mistyped
      // reference path is the caller's error to fix, and finding out after a
      // paid generation has already run is the expensive ordering.
      let images: ResolvedAssetImage[];
      try {
        images = await resolveAssetImages(args.images, ctx.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: `NOT GENERATED — ${message}`,
          details: { uri: "", mimeType: "", size: 0, summary: message },
          content: [],
        };
      }
      const req: AssetRequest = {
        kind,
        // Thin prompts generate poorly, and the generator sees nothing but this
        // string. Craft hints are appended only when the prompt is short.
        prompt: enrichAssetPrompt(kind, String(args.prompt)),
        outDir: args.outDir ? String(args.outDir) : undefined,
        name: args.name ? String(args.name) : undefined,
        options: (args.options as Record<string, unknown>) ?? {},
        ...(images.length ? { images } : {}),
        count: clampCount(args.count),
      };
      // A non-UI (backend) project has no interface to drop generated visual
      // assets into, so a generation call is wasted work (and a placeholder the
      // model might ship). Decline before spending a backend call. Not an error:
      // the model should read this as guidance, not a tool failure to retry.
      if (ctx.projectCategory === "backend") {
        const result: AssetResult = {
          uri: "",
          mimeType: "",
          size: 0,
          summary: `assets_generator is for UI projects; this project is categorized as backend (no UI).`,
          placeholder: true,
        };
        return {
          output: result.summary,
          details: result,
          content: [],
        };
      }
      // An animated SVG is the one request where generating is strictly worse than
      // writing: the output would be path soup with no targetable structure, so the
      // animation still has to be hand-authored afterwards and the generation call
      // is pure waste. Decline BEFORE spending it — and not as an error, so the
      // loop reads it as guidance rather than a tool to retry or escalate.
      // The steer is a default, not a veto: an explicit `force` (the user asked for
      // this anyway) proceeds. The guidance only exists to stop a model spending a
      // paid call on an artifact it cannot use — never to overrule the person.
      const animatedVector = args.force === true ? undefined : detectAnimatedVectorRequest(req);
      if (animatedVector) {
        ctx.log({
          timestamp: Date.now(),
          level: "info",
          tags: ["tool:assets_generator", "asset:declined"],
          message: `declined animated-vector generation; steered to hand-authored SVG: ${req.prompt.slice(0, 80)}`,
        });
        return {
          output: animatedVector,
          details: {
            uri: "",
            mimeType: "image/svg+xml",
            size: 0,
            summary: "Declined: an animated SVG must be authored as code, not generated.",
          },
          content: [],
        };
      }

      // Resolution: per-call resolver → per-kind backend → the host's own media
      // service (`backendImage` / `backendVideo`) → built-in OpenRouter (image
      // only, key permitting) → placeholder.
      const hostBackend =
        config.resolveBackend?.(req, ctx) ??
        config.backends?.[kind] ??
        (kind === "image"
          ? (config.backendImage ?? openRouterImage)
          : kind === "video"
            ? config.backendVideo
            : undefined);
      const backend = hostBackend ?? placeholderBackends[kind];
      const usingPlaceholder = !hostBackend;

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:assets_generator", "mutation", `asset:${kind}`],
        message: `generate ${kind}: ${req.prompt}${usingPlaceholder ? " (placeholder backend)" : ""}`,
      });

      // A backend may answer with one asset or many (`count`). Normalize to a
      // list so the write-out path is identical either way.
      const produced = await backend(req, ctx);
      const assets = Array.isArray(produced) ? produced : [produced];
      if (!assets.length) throw new Error(`${kind} backend returned no assets`);

      const outDir = path.isAbsolute(req.outDir ?? "")
        ? (req.outDir as string)
        : path.join(ctx.cwd, req.outDir ?? config.defaultOutDir ?? "assets");
      await fs.mkdir(outDir, { recursive: true });
      const base = (req.name ?? slug(req.prompt)) || "asset";

      const files: AssetFile[] = [];
      for (const [i, asset] of assets.entries()) {
        // First file keeps the plain name so single-asset paths are unchanged;
        // the rest are suffixed rather than overwriting each other.
        const file = path.join(outDir, `${base}${i === 0 ? "" : `-${i + 1}`}.${asset.ext}`);
        await fs.writeFile(file, asset.bytes);
        files.push({ uri: file, mimeType: asset.mimeType, size: asset.bytes.byteLength });
      }

      const first = files[0]!;
      const result: AssetResult = {
        uri: first.uri,
        mimeType: first.mimeType,
        size: first.size,
        summary: assets[0]!.summary ?? `Generated ${kind} for: ${req.prompt}`,
        placeholder: usingPlaceholder,
        files,
      };
      const list = files.map((f) => `${f.uri} (${f.size} bytes)`).join(", ");
      const many = files.length > 1 ? `${files.length} ${kind}s` : kind;
      return {
        // The placeholder warning is part of the LLM-facing output on purpose: a
        // model that thinks it generated a real asset will happily ship it.
        output: usingPlaceholder
          ? `PLACEHOLDER ONLY — no ${kind} generation backend is configured, so stand-in file(s) were written: ${list}. NOT a generated ${kind}; do not present it as one.`
          : `Generated ${many} → ${list}. ${result.summary}`,
        details: result,
        // Surface the assets by reference (address, not bytes) for downstream phases (req #7).
        content: files.map((f) => ({ type: "file", uri: f.uri, mimeType: f.mimeType })),
      };
    },
  };
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Providers cap batch size around ten; anything outside that is a caller slip. */
export const MAX_ASSET_COUNT = 10;

/** Clamp `count` into 1..{@link MAX_ASSET_COUNT}, tolerating junk (→ 1). */
export function clampCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_ASSET_COUNT, Math.max(1, Math.floor(n)));
}

/** Roles a caller may name; anything else is treated as a plain reference. */
const IMAGE_ROLES: readonly AssetImageRole[] = [
  "reference",
  "start_frame",
  "last_frame",
  "mask",
  "style",
];

/** Above this an input image is refused: base64 inflates ~33% and providers cap
 *  request size well below where a raw photo dump would land. */
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Turn the caller's `images` argument into references a backend can send.
 *
 * Local files are read and inlined as `data:` URLs — a generation provider has
 * no access to the host's disk, so passing a path through would produce a call
 * that silently ignores the reference (the worst outcome: a paid generation
 * that looks nothing like the input, with nothing saying why). Remote and
 * `data:` URLs pass through untouched.
 *
 * Throws with a specific message on an unreadable or oversized path, so the
 * caller can fix the argument instead of paying for a call it will not like.
 */
export async function resolveAssetImages(
  value: unknown,
  cwd: string,
): Promise<ResolvedAssetImage[]> {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: ResolvedAssetImage[] = [];
  for (const entry of raw) {
    // Accept both {path, role} and a bare string, because a model that reads
    // "an array of images" often sends the plain paths.
    const source = typeof entry === "string" ? entry : String((entry as AssetImageInput)?.path ?? "");
    if (!source.trim()) throw new Error(`an entry in \`images\` has no \`path\``);
    const declared = typeof entry === "string" ? undefined : (entry as AssetImageInput)?.role;
    const role: AssetImageRole =
      declared && IMAGE_ROLES.includes(declared) ? declared : "reference";

    if (/^data:/i.test(source)) {
      const mimeType = source.slice(5).split(";")[0]?.trim() || "image/png";
      out.push({ role, url: source, mimeType, source });
      continue;
    }
    if (/^https?:\/\//i.test(source)) {
      out.push({ role, url: source, mimeType: guessImageMime(source), source });
      continue;
    }

    const abs = path.isAbsolute(source) ? source : path.join(cwd, source);
    let bytes: Buffer;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_INPUT_IMAGE_BYTES) {
        throw new Error(
          `input image ${source} is ${Math.round(stat.size / 1024 / 1024)}MB, over the ${
            MAX_INPUT_IMAGE_BYTES / 1024 / 1024
          }MB limit — downscale it or pass a URL instead`,
        );
      }
      bytes = await fs.readFile(abs);
    } catch (err) {
      if (err instanceof Error && err.message.includes("over the")) throw err;
      throw new Error(`input image not readable: ${source} (resolved to ${abs})`);
    }
    const mimeType = guessImageMime(abs);
    out.push({ role, url: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType, source });
  }
  return out;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function guessImageMime(file: string): string {
  const ext = path.extname(file.split("?")[0] ?? file).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}

/** Names a vector format explicitly — the only case where "don't generate" applies. */
const VECTOR_RE = /\bsvgs?\b|\bvector\b/i;
/**
 * Asks for motion. Verb forms and named UI motion only — a bare noun like "wave"
 * or an adjective like "dynamic" describes a static picture, and declining those
 * would block legitimate generation. `spinner` earns its place as a noun because a
 * spinner is defined by spinning.
 */
const MOTION_RE = new RegExp(
  [
    "\\banimat(e|es|ed|ing|ion|ions)\\b",
    "\\bkeyframes?\\b",
    "\\btransition(s|ing)?\\b",
    "\\bmorph(s|ing)?\\b",
    "\\bspinner\\b",
    // Motion verbs, in the forms that actually assert movement.
    "\\b(rotat|puls|bounc|wobbl|orbit|shimmer|flicker|blink|drift|float|swing|sway|scal|zoom|slid|spin)(e|es|ed|ing|s|ning)\\b",
    "\\bfad(e|es|ing) (in|out)\\b",
    "\\bslide (in|out|up|down)\\b",
    "\\b(typewriter|marquee|parallax)\\b",
    "\\bhover (effect|state|animation)\\b",
    "\\bscroll[- ]?(triggered|linked|driven)\\b",
    "\\bloop(s|ing|ed)? (in|on)?\\s*(the )?(svg|vector)\\b",
    "\\bmoving parts\\b",
    "\\bcontinuously\\b",
  ].join("|"),
  "i",
);

/**
 * The guidance returned instead of generating, when the request is for an SVG that
 * has to move. Concrete on purpose: a decline that does not say what to do instead
 * just gets retried.
 */
export function detectAnimatedVectorRequest(req: AssetRequest): string | undefined {
  if (req.kind !== "image") return undefined;
  const text = `${req.prompt} ${JSON.stringify(req.options ?? {})}`;
  const wantsVector = VECTOR_RE.test(text) || String(req.options?.["format"] ?? "").toLowerCase().includes("svg");
  if (!wantsVector || !MOTION_RE.test(text)) return undefined;

  return [
    "NOT GENERATED — this asks for an SVG that animates, and generating one would waste the call: image models",
    "emit a single flattened path blob with no ids, groups or semantic structure, so there is nothing for a",
    "keyframe or a transition to target. You would still have to author the animation by hand afterwards.",
    "",
    "Write it yourself with `write` instead — this is the case where hand-authored SVG is simply better:",
    "- give every moving part its own element with an `id`/`class`, and group related parts in `<g>`, so CSS or JS",
    "  can address them individually;",
    "- animate with CSS `@keyframes` / `transition` on `transform` and `opacity` (they are compositor-friendly);",
    "  avoid animating `width`/`height`/`x`/`y`, which force layout;",
    "- use `currentColor` and CSS custom properties for fills so the graphic inherits the site's theme;",
    "- add `<title>` (and `role=\"img\"` + `aria-label` where it conveys meaning), or `aria-hidden=\"true\"` if it is",
    "  purely decorative;",
    "- wrap the motion in `@media (prefers-reduced-motion: reduce)` so it can be turned off;",
    "- set a `viewBox` and let it scale, rather than pinning pixel dimensions.",
    "",
    "Do NOT retry this call as-is. If what you actually want is a STATIC illustration to sit behind or beside",
    "the animated parts, call again describing that static image (raster is fine for it), and animate the",
    "wrapper in CSS.",
    "",
    "If the USER explicitly asked for a generated SVG anyway, they outrank this default: call again with",
    "`force: true`, and tell them in your summary that the output will need hand-authoring before it can move.",
  ].join("\n");
}
