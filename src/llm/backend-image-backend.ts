/**
 * Backend-delegating image and video backends.
 *
 * Mirrors {@link createOpenRouterImageBackend} but, instead of calling
 * OpenRouter's `/images` directly, it delegates to a host-supplied
 * {@link BackendImageClient}. The host (OpenWaggleMain) wires this to its
 * `/turing-machine/images` proxy so image generation is authenticated (JWT) and
 * billed centrally through the backend, rather than each host holding an
 * OpenRouter key and calling the provider itself.
 *
 * The harness owns no HTTP client on purpose — this is the same pluggable-seam
 * pattern the rest of the harness uses (e.g. `AssetBackend`). The client returns
 * `{ b64_json, media_type }` (OpenRouter's image response shape); this module
 * decodes it to bytes exactly like the OpenRouter backend does, so the
 * `assets_generator` tool gets the same `{ bytes, mimeType, ext, summary }`.
 */
import type { ToolContext } from "../types.js";
import type {
  AssetBackend,
  AssetRequest,
  ResolvedAssetImage,
} from "../tools/builtin/assets-generator.js";
import { oneOrMany } from "../tools/builtin/assets-generator.js";

/** What a host's image client returns — OpenRouter's `data[0]` shape. */
export interface BackendImageData {
  b64_json?: string;
  media_type?: string;
  [key: string]: unknown;
}

/**
 * Host-supplied image client. Given a request, resolves image bytes (base64 +
 * mime) from the host's own backend (which handles auth + billing). Throws on
 * failure; the tool surfaces the error to the model.
 */
export type BackendImageClient = (
  request: BackendImageRequest,
  ctx: ToolContext,
) => Promise<BackendImageData | BackendImageData[]>;

/** What the host needs to generate an image. */
export interface BackendImageRequest {
  model: string;
  prompt: string;
  /** Per-call options merged over defaults and forwarded verbatim. */
  options: Record<string, unknown>;
  /**
   * Input/reference images for image-to-image work, already resolved to sendable
   * URLs (`http(s)://` or `data:`) with the role the caller declared. Absent for
   * plain text-to-image. Hosts proxying to OpenRouter's `/images` map these to
   * `input_references`; the ready-made array is on `options.input_references`
   * too, so a pass-through client needs no mapping code at all.
   */
  images?: ResolvedAssetImage[];
  /** How many images to produce (1-10). Also mirrored to `options.n` when > 1. */
  count?: number;
}

export interface BackendImageBackendConfig {
  /** The host's image client (calls the backend `/images` endpoint). */
  client: BackendImageClient;
  /** Default model when the call doesn't specify one. */
  model?: string;
  /** Default per-call options forwarded to the client. */
  defaults?: Record<string, unknown>;
}

function extForMime(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split("+")[0]?.trim().toLowerCase();
  if (!subtype) return "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

/**
 * Build an `image` {@link AssetBackend} that delegates to a host backend.
 * Drop-in replacement for {@link createOpenRouterImageBackend}: same return
 * contract, so `assets_generator` works unchanged.
 */
export function createBackendImageBackend(
  config: BackendImageBackendConfig,
): AssetBackend {
  return async (req: AssetRequest, ctx: ToolContext) => {
    const { model: perCallModel, ...rest } = {
      ...config.defaults,
      ...req.options,
    } as Record<string, unknown>;
    const model =
      (typeof perCallModel === "string" && perCallModel.trim()) ||
      config.model ||
      "backend-image";

    // Reference images and batch size go out BOTH as typed fields and folded
    // into `options`, so a host client that forwards `options` verbatim to
    // OpenRouter's `/images` gets image-to-image and `n` with no code change,
    // while one that inspects the request can read them off the typed fields.
    const count = req.count ?? 1;
    const options: Record<string, unknown> = {
      ...rest,
      ...(req.images?.length
        ? {
            input_references: req.images.map((img) => ({
              type: "image_url",
              image_url: { url: img.url },
            })),
          }
        : {}),
      ...(count > 1 ? { n: count } : {}),
    };

    const response = await config.client(
      {
        model,
        prompt: req.prompt,
        options,
        ...(req.images?.length ? { images: req.images } : {}),
        ...(count > 1 ? { count } : {}),
      },
      ctx,
    );

    // One image or many: `count > 1` comes back as an array. Filter to entries
    // that actually carry bytes so a partially-empty batch fails loudly rather
    // than writing a zero-byte file.
    const produced = (Array.isArray(response) ? response : [response]).filter(
      (d): d is BackendImageData & { b64_json: string } => typeof d?.b64_json === "string" && !!d.b64_json,
    );
    if (!produced.length) {
      // Loud failure, never a silent empty asset — the model must be able to
      // react (retry, or fall back to hand-authoring).
      const sample = Array.isArray(response) ? response[0] : response;
      throw new Error(
        `backend image client returned no bytes (expected b64_json; got keys: ${
          Object.keys(sample ?? {}).join(", ") || "none"
        })`,
      );
    }

    return oneOrMany(
      produced.map((data) => {
        const mimeType = data.media_type ?? "image/png";
        return {
          bytes: new Uint8Array(Buffer.from(data.b64_json, "base64")),
          mimeType,
          ext: extForMime(mimeType),
          summary: `Generated with ${model} (via backend) for: ${req.prompt}`,
        };
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/**
 * What a host's video client returns for ONE clip.
 *
 * Two shapes, because the two ways a video proxy can answer are genuinely
 * different and both are reasonable:
 *   - `b64_json` — the bytes inline, exactly like the image response. Simplest
 *     for a proxy that already buffers the clip.
 *   - `url` — an already-authenticated, directly-fetchable location. Preferred
 *     for anything large, and the shape a proxy lands on when it hands back a
 *     signed link rather than re-streaming megabytes through itself.
 * A client may return either; the backend below fetches a `url` for the caller
 * so `assets_generator` still receives bytes in hand.
 *
 * The host owns the async part. Video generation is submit → poll → download,
 * and the polling, auth and billing all live in the host's own service — the
 * client returns only when the clip is READY.
 */
export interface BackendVideoData {
  b64_json?: string;
  url?: string;
  media_type?: string;
  [key: string]: unknown;
}

/** Host-supplied video client. Resolves finished clips; throws on failure. */
export type BackendVideoClient = (
  request: BackendVideoRequest,
  ctx: ToolContext,
) => Promise<BackendVideoData | BackendVideoData[]>;

/** What the host needs to generate a video. */
export interface BackendVideoRequest {
  model: string;
  prompt: string;
  /** Per-call options merged over defaults and forwarded verbatim. */
  options: Record<string, unknown>;
  /**
   * Input images with the role the caller declared, already resolved to sendable
   * URLs. The role-split arrays a video provider actually distinguishes are ALSO
   * folded into `options` as `frame_images` / `input_references`, so a client
   * that forwards `options` verbatim needs no mapping code.
   */
  images?: ResolvedAssetImage[];
  /** How many clips to produce. Also mirrored to `options.n` when > 1. */
  count?: number;
}

export interface BackendVideoBackendConfig {
  /** The host's video client (calls the backend's video endpoint). */
  client: BackendVideoClient;
  /** Default model when the call doesn't specify one. */
  model?: string;
  /** Default per-call options forwarded to the client. */
  defaults?: Record<string, unknown>;
}

/**
 * Split input images into the two arrays a video provider distinguishes.
 *
 * This is the whole reason `start_frame`/`last_frame` exist as roles: they are
 * NOT style references. A frame pins the picture the clip literally opens or
 * closes on (so the model interpolates between two stills instead of inventing
 * motion from the prompt), while a reference only guides how it looks. Sending
 * a frame down the reference channel silently downgrades "animate exactly this"
 * to "make something similar", with nothing in the result saying so.
 *
 * `mask` has no meaning for video and rides along as a plain reference rather
 * than being dropped — the caller asked for the image to be considered.
 */
export function splitVideoImages(images: readonly ResolvedAssetImage[]): {
  frame_images: Array<Record<string, unknown>>;
  input_references: Array<Record<string, unknown>>;
} {
  const frame_images: Array<Record<string, unknown>> = [];
  const input_references: Array<Record<string, unknown>> = [];
  for (const img of images) {
    if (img.role === "start_frame" || img.role === "last_frame") {
      frame_images.push({
        type: "image_url",
        image_url: { url: img.url },
        frame_type: img.role === "start_frame" ? "first_frame" : "last_frame",
      });
    } else {
      input_references.push({ type: "image_url", image_url: { url: img.url } });
    }
  }
  return { frame_images, input_references };
}

/** Video extension from a reported media type; mp4 is the safe default. */
function extForVideoMime(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (!subtype) return "mp4";
  return subtype === "quicktime" ? "mov" : subtype;
}

/**
 * Build a `video` {@link AssetBackend} that delegates to a host backend.
 *
 * The counterpart of {@link createBackendImageBackend}, same contract: the tool
 * receives `{ bytes, mimeType, ext, summary }` and owns writing the file, so a
 * host swapping providers changes nothing downstream.
 */
export function createBackendVideoBackend(
  config: BackendVideoBackendConfig,
): AssetBackend {
  return async (req: AssetRequest, ctx: ToolContext) => {
    const { model: perCallModel, ...rest } = {
      ...config.defaults,
      ...req.options,
    } as Record<string, unknown>;
    const model =
      (typeof perCallModel === "string" && perCallModel.trim()) ||
      config.model ||
      "backend-video";

    const count = req.count ?? 1;
    const { frame_images, input_references } = splitVideoImages(req.images ?? []);
    const options: Record<string, unknown> = {
      ...rest,
      ...(frame_images.length ? { frame_images } : {}),
      ...(input_references.length ? { input_references } : {}),
      ...(count > 1 ? { n: count } : {}),
    };

    const response = await config.client(
      {
        model,
        prompt: req.prompt,
        options,
        ...(req.images?.length ? { images: req.images } : {}),
        ...(count > 1 ? { count } : {}),
      },
      ctx,
    );

    const entries = (Array.isArray(response) ? response : [response]).filter(
      (d): d is BackendVideoData =>
        !!d && (typeof d.b64_json === "string" ? !!d.b64_json : typeof d.url === "string" && !!d.url),
    );
    if (!entries.length) {
      const sample = Array.isArray(response) ? response[0] : response;
      throw new Error(
        `backend video client returned no clip (expected b64_json or url; got keys: ${
          Object.keys(sample ?? {}).join(", ") || "none"
        })`,
      );
    }

    const assets = [];
    for (const data of entries) {
      if (typeof data.b64_json === "string" && data.b64_json) {
        const mimeType = data.media_type ?? "video/mp4";
        assets.push({
          bytes: new Uint8Array(Buffer.from(data.b64_json, "base64")),
          mimeType,
          ext: extForVideoMime(mimeType),
          summary: `Generated with ${model} (via backend) for: ${req.prompt}`,
        });
        continue;
      }
      // A URL response: fetch it here so the tool's bytes-in-hand contract holds
      // whichever shape the host chose. A failure is loud — a clip the caller
      // cannot open is worse than a reported error.
      const res = await fetch(data.url as string, ctx.signal ? { signal: ctx.signal } : {});
      if (!res.ok) {
        throw new Error(`backend video download failed (${res.status}) for ${data.url}`);
      }
      const mimeType =
        data.media_type ?? res.headers.get("content-type")?.split(";")[0]?.trim() ?? "video/mp4";
      assets.push({
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType,
        ext: extForVideoMime(mimeType),
        summary: `Generated with ${model} (via backend) for: ${req.prompt}`,
      });
    }
    return oneOrMany(assets);
  };
}
