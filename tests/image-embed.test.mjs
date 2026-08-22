/**
 * The conversation gets a bounded derivative of a capture; disk keeps the
 * original.
 *
 * From the field: a 1206×2622 simulator screenshot is 1.2-2MB of PNG,
 * ~1.6-2.7MB of base64 in the request body, and the 1MB-bounded chat proxy
 * rejected the next request outright (413 "request entity too large"). Two
 * runs died on their FIRST capture, app launched, nobody at the wheel. These
 * tests pin the contract that prevents the third:
 *
 *   - the embedded image is JPEG, ≤1024 on its long edge, and smaller than
 *     the original;
 *   - an already-small capture passes through untouched (compression is not
 *     worth a quality loss);
 *   - the file persisted to .turing/screenshots is the FULL-RESOLUTION
 *     original — media_analysis and the final report judge the real pixels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Jimp } from "jimp";
import {
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  runToolLoop,
  downscaleForEmbed,
  EMBED_MAX_EDGE,
} from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/**
 * A screenshot-shaped PNG: phone-portrait dimensions with photo-like content —
 * a random RGB lattice upscaled smoothly. Two non-choices, both learned the
 * hard way: flat solid colour and clean gradients compress to a few KB and
 * sail under the passthrough bound (real captures do not), while per-pixel
 * salt noise is JPEG's worst case and trips the never-embed-bigger guard on
 * purpose. A smooth lattice is PNG's worst case and JPEG's best — exactly the
 * asymmetry the encoder is trusted with in the field, at the field's sizes.
 */
async function screenshotPng(width = 1206, height = 2622) {
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lattice = new Jimp({ width: Math.ceil(width / 8), height: Math.ceil(height / 8), color: 0xffffffff });
  const d = lattice.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 40 + rnd() * 180;
    d[i + 1] = 50 + rnd() * 150;
    d[i + 2] = 80 + rnd() * 160;
    d[i + 3] = 255;
  }
  lattice.resize({ w: width, h: height });
  return lattice.getBuffer("image/png");
}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const byteLen = (s) => Math.ceil((s.length * 3) / 4);

test("a large capture is embedded as a bounded JPEG", async () => {
  const png = await screenshotPng();
  const original = { type: "image", data: b64(png), mimeType: "image/png" };
  assert.ok(byteLen(original.data) > 200 * 1024, "fixture must be past the passthrough bound");

  const stats = [];
  const [out] = await downscaleForEmbed([original], { log: (s) => stats.push(s) });

  assert.equal(out.mimeType, "image/jpeg", "the embed is JPEG");
  const decoded = await Jimp.fromBuffer(Buffer.from(out.data, "base64"));
  assert.ok(
    decoded.width <= EMBED_MAX_EDGE && decoded.height <= EMBED_MAX_EDGE,
    `long edge must be ≤${EMBED_MAX_EDGE}, got ${decoded.width}×${decoded.height}`,
  );
  // Aspect preserved: 1206×2622 → 471×1024, not squashed.
  const ratio = decoded.width / decoded.height;
  assert.ok(Math.abs(ratio - 1206 / 2622) < 0.02, `aspect preserved (${ratio.toFixed(3)})`);
  assert.ok(byteLen(out.data) < byteLen(original.data), "embed must be smaller than the original");
  assert.equal(stats.length, 1, "one compress stat logged");
  assert.ok(stats[0].after < stats[0].before, "the stat must show the shrink");
});

test("an already-small capture passes through untouched", async () => {
  const img = new Jimp({ width: 400, height: 200, color: 0x336699ff });
  const png = await img.getBuffer("image/png");
  const original = { type: "image", data: b64(png), mimeType: "image/png" };

  const [out] = await downscaleForEmbed([original]);

  assert.equal(out, original, "no re-encode for a small, light capture");
});

/**
 * The loop-level contract: what the MODEL sees is the bounded JPEG, what
 * media_analysis gets by path is the full-resolution original. If both sides
 * ever become the same compressed bytes, the report silently judges a lesser
 * copy than the device produced — nobody would notice from the transcript.
 */
test("the loop embeds the JPEG but persists the full-resolution original", async () => {
  const png = await screenshotPng();
  const screenshot = {
    name: "browser_take_screenshot",
    description: "screenshot the page",
    parameters: { type: "object", properties: {} },
    async execute() {
      return {
        output: "captured",
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/png", data: b64(png) },
        ],
      };
    },
  };

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    const m =
      turn === 1
        ? msg([{ type: "toolCall", id: "c1", name: "browser_take_screenshot", arguments: {} }], "toolUse")
        : msg([{ type: "text", text: "done" }]);
    yield { type: "start", partial: m };
    yield { type: "done", message: m };
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-image-embed-"));
  const { resolveModel } = await import("../dist/index.js");
  const toolResults = [];
  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [screenshot],
    // Vision-capable, so the image passes through to the model as an image
    // (the path where request bytes are decided).
    model: resolveModel("anthropic/claude-sonnet-4.5"),
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    cwd: tmp,
    emit: (e) => {
      if (e.type === "turn_end") toolResults.push(...(e.toolResults ?? []));
    },
  });

  // The follow-up user message is the embed the request will carry.
  const media = toolResults.filter((m) => m.role === "user");
  const blocks = media.flatMap((m) => m.content ?? []).filter((c) => c.type === "image");
  assert.equal(blocks.length, 1, "one embedded image");
  assert.equal(blocks[0].mimeType, "image/jpeg", "the embed must be the compressed JPEG");
  const embedded = await Jimp.fromBuffer(Buffer.from(blocks[0].data, "base64"));
  assert.ok(
    embedded.width <= EMBED_MAX_EDGE && embedded.height <= EMBED_MAX_EDGE,
    `embedded image must be ≤${EMBED_MAX_EDGE} on its long edge`,
  );

  // The file on disk is the ORIGINAL capture.
  const dir = path.join(tmp, ".turing", "screenshots");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png"));
  assert.equal(files.length, 1, "the full-resolution PNG is persisted");
  const saved = await Jimp.fromBuffer(await fs.readFile(path.join(dir, files[0])));
  assert.equal(saved.width, 1206, "persisted capture keeps full width");
  assert.equal(saved.height, 2622, "persisted capture keeps full height");
});
