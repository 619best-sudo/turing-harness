/**
 * Compress tool-produced images for the conversation embed.
 *
 * Why this exists, from two field runs that died the same death: a simulator
 * screenshot is a 1206×2622 PNG — 1.2 to 2.05MB on disk, ~1.6 to 2.7MB as
 * base64 in a request body. The chat proxy in front of the model bounds
 * request bodies (1MB in dev), so the FIRST capture of the QA hop killed the
 * run: HTTP 413 "request entity too large", the app already launched, nobody
 * at the wheel. Bytes are also money — vision tokens scale with pixels, and a
 * full-resolution screenshot re-priced itself on every turn it stayed in
 * history.
 *
 * So the embed the model reasons over is a bounded derivative:
 *
 *   full-resolution original  →  `.turing/screenshots/` on disk (the copy
 *                                `media_analysis` and the final report use)
 *   ≤1024px JPEG (quality 82) →  the conversation (what the model sees and
 *                                what every later request re-sends)
 *
 * A 1024px JPEG of a UI screen is ~80-200KB — under the proxy bound with
 * room for several captures in one history, and a fraction of the vision
 * tokens of the original. 1024px is deliberately generous for reading text in
 * a screenshot; the element tree rides alongside anyway, so the embed is for
 * JUDGING the screen, not for OCR it cannot be spared from.
 *
 * Rules, in order:
 *   - already small (≤1024 on both axes AND ≤200KB): passed through untouched
 *     — re-encoding a small image only loses quality;
 *   - the compressed result must actually be smaller; if it is not (a
 *     pathological image), the original is kept;
 *   - ANY failure (decode, missing library) keeps the original. Compression
 *     is an optimization: it must never be why a capture is lost or a run
 *     dies — the exact failure this module exists to prevent.
 *
 * `jimp` is imported lazily so the harness keeps its zero-hard-dependency
 * contract: a host that vendors `dist/` without running its installer still
 * runs, just with full-size embeds.
 */
import type { ImageContent } from "./types.js";
import { imagePixelDimensions } from "./image-dims.js";

/** Longest edge of an embedded image. Screenshots keep readable UI text. */
export const EMBED_MAX_EDGE = 1024;
/**
 * JPEG quality for the embed. Not passed to the encoder: jimp's typed options
 * reject a bare `{ quality }` across its per-mime generic, and its default was
 * measured to BE 80 (byte-identical output) — the constant documents intent.
 */
export const EMBED_JPEG_QUALITY = 80;
/** Images already this small (bytes) and this small (edges) pass through. */
export const EMBED_PASSTHROUGH_BYTES = 200 * 1024;

/** What one downscale attempt did, for the run log. */
export interface EmbedCompressStat {
  tool: string;
  before: number;
  after: number;
  width?: number;
  height?: number;
}

/**
 * Compress images for embedding in the conversation. Never throws, never
 * drops an image: on any problem the original block is returned as-is.
 *
 * The `log` callback (optional) is called once per image that was actually
 * recompressed, with before/after byte sizes — the run log is where a
 * "why is the screenshot blurry" question gets answered six months from now.
 */
export async function downscaleForEmbed(
  images: readonly ImageContent[],
  opts: {
    log?: (stat: EmbedCompressStat) => void;
  } = {},
): Promise<ImageContent[]> {
  const out: ImageContent[] = [];
  for (let i = 0; i < images.length; i++) {
    out.push(await downscaleOne(images[i]!, opts));
  }
  return out;
}

async function downscaleOne(
  img: ImageContent,
  opts: { log?: (stat: EmbedCompressStat) => void },
): Promise<ImageContent> {
  const originalBytes = Math.ceil((img.data.length * 3) / 4); // base64 → bytes
  const dims = imagePixelDimensions(img.data, img.mimeType);

  // Small on both axes and already light: re-encoding buys nothing and costs
  // quality. (Unknown dimensions — a format the sniffer cannot read — fall
  // through to the compress attempt rather than skipping it.)
  if (
    dims &&
    dims.width <= EMBED_MAX_EDGE &&
    dims.height <= EMBED_MAX_EDGE &&
    originalBytes <= EMBED_PASSTHROUGH_BYTES
  ) {
    return img;
  }

  try {
    // Lazy by design — see the module comment. A missing library must not be
    // a missing screenshot.
    const { Jimp } = await import("jimp");
    const decoded = await Jimp.fromBuffer(Buffer.from(img.data, "base64"));
    if (decoded.width <= EMBED_MAX_EDGE && decoded.height <= EMBED_MAX_EDGE && originalBytes <= EMBED_PASSTHROUGH_BYTES) {
      return img;
    }
    decoded.scaleToFit({ w: EMBED_MAX_EDGE, h: EMBED_MAX_EDGE });
    // JPEG has no alpha; a transparent asset would composite against black on
    // some encoders. Flatten to white so transparency reads as "empty", which
    // is what it looks like on every screen the model is comparing against.
    // (v1 has no `flatten`; compositing onto a white canvas is the operation.)
    // The explicit alias/casts are for jimp's dual type declarations, which
    // make two instances of the same class nominally unrelated to tsc.
    type JimpImage = InstanceType<typeof Jimp>;
    let toEncode = decoded as JimpImage;
    if (decoded.hasAlpha()) {
      const white = new Jimp({ width: decoded.width, height: decoded.height, color: 0xffffffff });
      white.composite(decoded, 0, 0);
      toEncode = white as JimpImage;
    }
    const jpeg = await toEncode.getBuffer("image/jpeg");
    const after = jpeg.length;
    if (after >= originalBytes) return img; // pathological: keep the original
    opts.log?.({
      tool: "image",
      before: originalBytes,
      after,
      width: decoded.width,
      height: decoded.height,
    });
    return { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return img;
  }
}
