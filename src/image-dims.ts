/**
 * Image format + dimension sniffing for inlined (base64) images,
 * dependency-free. Shared by the loop (stamping saved captures) and the mobile
 * visual-tap tool (converting analysis positions into logical points).
 *
 * Mobile-mcp screenshots arrive at arbitrary, call-to-call-inconsistent scales
 * — 185px, 375px, 486px wide for the same 402pt screen — and, as a real run
 * proved, sometimes WITHOUT a `mimeType` on the image block at all. So the
 * format is sniffed from the magic bytes, never trusted from the label.
 */
export type SniffedImageFormat = "png" | "jpeg" | "webp";

/** Read the format off the decoded header bytes; the mimeType is only a hint. */
export function sniffImageFormat(data: string, mimeType = ""): SniffedImageFormat | undefined {
  const buf = Buffer.from(data.slice(0, 32), "base64");
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (/png/i.test(mimeType)) return "png";
  if (/jpe?g/i.test(mimeType)) return "jpeg";
  if (/webp/i.test(mimeType)) return "webp";
  return undefined;
}

/**
 * Pixel dimensions from the image header. PNG: the IHDR chunk carries
 * width/height at a fixed offset. JPEG: walk the marker segments to the first
 * SOF frame. WebP: the VP8X/VP8/VP8L chunk carries the canvas size. Anything
 * unparseable yields null — callers treat dimensions as optional metadata.
 */
export function imagePixelDimensions(
  data: string,
  mimeType: string,
): { width: number; height: number } | null {
  const fmt = sniffImageFormat(data, mimeType);
  if (!fmt) return null;
  try {
    const buf = Buffer.from(data.slice(0, 512), "base64");
    if (fmt === "png" && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (fmt === "jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1]!;
        // SOF0..SOF15 except DHT/JPG/DAC: the frame header.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    if (fmt === "webp" && buf.length >= 30) {
      const chunk = buf.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        // Canvas size: 24-bit little-endian, stored minus one.
        const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
        const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
        return { width: w, height: h };
      }
      if (chunk === "VP8 ") {
        // Lossy: frame size after the 20-byte chunk/keyframe preamble.
        return { width: buf.readUInt16LE(26), height: buf.readUInt16LE(28) };
      }
      if (chunk === "VP8L") {
        // Lossless: 14 bits width / height packed after the signature byte.
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* dimensions are best-effort metadata */
  }
  return null;
}
