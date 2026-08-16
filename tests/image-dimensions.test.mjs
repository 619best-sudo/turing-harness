/**
 * Screenshot dimension metadata — the fix for the pixel-ratio spiral.
 *
 * A real run received a device-server screenshot downscaled to 185×402 px of a
 * 402×874 pt screen, asked `media_analysis` for the element position, got
 * "(860,100) in image pixels" — impossible for a 185px-wide image — and spent
 * its remaining turns reconciling four incompatible number systems (`sips`,
 * `mobile_get_screen_size`, the analysis, the tap tool) before giving up on
 * navigation. The harness now stamps each persisted capture with its real
 * pixel dimensions and the conversion rule, and every analysis lens must state
 * the dimensions it actually sees before reporting any coordinate.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { imagePixelDimensions } from "../dist/orchestrator/loop.js";
import { LENS_SYSTEM } from "../dist/tools/builtin/media-analysis.js";

/** Minimal PNG header: signature + IHDR with the given dimensions. */
function pngHeader(width, height) {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  b.writeUInt32BE(13, 8); // IHDR length
  b.set(Buffer.from("IHDR"), 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString("base64");
}

/** Minimal JPEG: SOI → APP0 (16 bytes) → SOF0 with the given dimensions. */
function jpegHeader(width, height) {
  const sof = Buffer.alloc(17);
  sof.set([0xff, 0xc0], 0);
  sof.writeUInt16BE(15, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16, 0x00), sof]).toString("base64");
}

test("PNG dimensions are read from the IHDR chunk", () => {
  assert.deepEqual(imagePixelDimensions(pngHeader(1206, 2622), "image/png"), { width: 1206, height: 2622 });
  // The exact scale that broke the run.
  assert.deepEqual(imagePixelDimensions(pngHeader(185, 402), "image/png"), { width: 185, height: 402 });
});

test("JPEG dimensions are read from the first SOF frame", () => {
  assert.deepEqual(imagePixelDimensions(jpegHeader(185, 402), "image/jpeg"), { width: 185, height: 402 });
  assert.deepEqual(imagePixelDimensions(jpegHeader(486, 1080), "image/jpg"), { width: 486, height: 1080 });
});

test("dimensions are sniffed from magic bytes — a missing mimeType does not break them", () => {
  // The exact production failure: the device server returns image blocks with NO
  // mimeType field. The dims parser keyed on the label and returned null,
  // which killed mobile_tap_visual with "could not read the screenshot's
  // pixel dimensions from its header" on a perfectly good JPEG.
  assert.deepEqual(imagePixelDimensions(jpegHeader(375, 812), ""), { width: 375, height: 812 });
  assert.deepEqual(imagePixelDimensions(pngHeader(375, 812), ""), { width: 375, height: 812 });
  // A LYING mimeType loses to the bytes.
  assert.deepEqual(imagePixelDimensions(jpegHeader(375, 812), "image/png"), { width: 375, height: 812 });
});

test("unknown or truncated formats yield null, never a guess", () => {
  assert.equal(imagePixelDimensions(Buffer.from("GIF89a").toString("base64"), "image/gif"), null);
  assert.equal(imagePixelDimensions("AAAA", "image/png"), null, "not a PNG header");
  // Bytes beat a lying label: PNG bytes under a jpeg mime still read as PNG.
  assert.deepEqual(imagePixelDimensions(pngHeader(10, 10), "image/jpeg"), { width: 10, height: 10 });
});

test("every analysis lens must state real dimensions and bound its coordinates", () => {
  for (const [lens, prompt] of Object.entries(LENS_SYSTEM)) {
    assert.match(prompt, /pixel dimensions of the image you\s+actually see/i, `${lens} demands the real dimensions`);
    assert.match(prompt, /within those\s+bounds/i, `${lens} bounds coordinates to the image`);
    assert.match(prompt, /raw image pixels/i, `${lens} forbids coordinate-system guessing`);
  }
});
