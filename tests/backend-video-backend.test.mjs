/**
 * Tests for `createBackendVideoBackend` — the delegating VIDEO backend, the
 * counterpart of `createBackendImageBackend`. Generation is routed through the
 * host's own media proxy (which owns auth, billing, and the submit→poll→download
 * async dance); the harness calls no provider itself.
 *
 * The points worth pinning:
 *  - `start_frame`/`last_frame` land in `frame_images` with the right
 *    `frame_type`, NOT in `input_references` — that distinction is the whole
 *    reason the roles exist, and losing it silently downgrades "animate exactly
 *    this" to "make something similar".
 *  - Everything else (reference/style/mask) becomes `input_references`.
 *  - Both response shapes work: inline `b64_json` and a fetchable `url`.
 *  - `count` is forwarded and many clips come back as many files.
 *  - No clip → loud error, never a silent empty asset.
 *  - `assets_generator` resolves `backendVideo` for kind:"video" instead of
 *    writing a placeholder manifest.
 *
 * All offline: the host client is stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAssetsGeneratorTool,
  createBackendVideoBackend,
  splitVideoImages,
} from "../dist/index.js";

const MP4_B64 = Buffer.from("fake-mp4-bytes").toString("base64");

function ctxFor(cwd = "/tmp") {
  return { cwd, log: () => {} };
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "turing-video-"));
}

// ---------------------------------------------------------------------------
// splitVideoImages — the role → wire-field mapping
// ---------------------------------------------------------------------------

test("start_frame/last_frame become frame_images with the right frame_type", () => {
  const { frame_images, input_references } = splitVideoImages([
    { role: "start_frame", url: "data:image/png;base64,AAA", mimeType: "image/png", source: "a.png" },
    { role: "last_frame", url: "https://x/b.png", mimeType: "image/png", source: "https://x/b.png" },
  ]);
  assert.equal(input_references.length, 0);
  assert.deepEqual(frame_images, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" }, frame_type: "first_frame" },
    { type: "image_url", image_url: { url: "https://x/b.png" }, frame_type: "last_frame" },
  ]);
});

test("reference/style/mask become plain input_references, no frame_type", () => {
  const { frame_images, input_references } = splitVideoImages([
    { role: "reference", url: "u1", mimeType: "image/png", source: "1" },
    { role: "style", url: "u2", mimeType: "image/png", source: "2" },
    { role: "mask", url: "u3", mimeType: "image/png", source: "3" },
  ]);
  assert.equal(frame_images.length, 0);
  assert.equal(input_references.length, 3);
  for (const ref of input_references) {
    assert.equal(ref.type, "image_url");
    assert.equal("frame_type" in ref, false);
  }
});

test("a mixed set splits both ways in one call", () => {
  const { frame_images, input_references } = splitVideoImages([
    { role: "start_frame", url: "s", mimeType: "image/png", source: "s" },
    { role: "style", url: "y", mimeType: "image/png", source: "y" },
    { role: "last_frame", url: "l", mimeType: "image/png", source: "l" },
  ]);
  assert.equal(frame_images.length, 2);
  assert.equal(input_references.length, 1);
});

// ---------------------------------------------------------------------------
// createBackendVideoBackend
// ---------------------------------------------------------------------------

test("decodes b64_json to bytes with mimeType + ext", async () => {
  const calls = [];
  const backend = createBackendVideoBackend({
    client: async (req) => {
      calls.push(req);
      return { b64_json: MP4_B64, media_type: "video/mp4" };
    },
    model: "default-video",
  });
  const out = await backend({ kind: "video", prompt: "a slow pan", options: {} }, ctxFor());
  assert.equal(calls[0].model, "default-video");
  assert.equal(calls[0].prompt, "a slow pan");
  assert.equal(out.mimeType, "video/mp4");
  assert.equal(out.ext, "mp4");
  assert.ok(out.bytes instanceof Uint8Array);
  assert.match(out.summary, /via backend/);
});

test("the client receives frame_images on options, ready to forward verbatim", async () => {
  const seen = [];
  const backend = createBackendVideoBackend({
    client: async (req) => {
      seen.push(req);
      return { b64_json: MP4_B64 };
    },
    model: "m",
  });
  await backend(
    {
      kind: "video",
      prompt: "interpolate",
      options: { duration: 5 },
      images: [
        { role: "start_frame", url: "S", mimeType: "image/png", source: "s.png" },
        { role: "last_frame", url: "L", mimeType: "image/png", source: "l.png" },
      ],
    },
    ctxFor(),
  );
  const opts = seen[0].options;
  assert.equal(opts.duration, 5, "unrelated options still pass through");
  assert.equal(opts.frame_images.length, 2);
  assert.equal(opts.frame_images[0].frame_type, "first_frame");
  assert.equal(opts.frame_images[1].frame_type, "last_frame");
  assert.equal("input_references" in opts, false, "no references were supplied");
  // The typed channel carries the roles too, for a client that inspects instead
  // of forwarding.
  assert.equal(seen[0].images.length, 2);
  assert.equal(seen[0].images[0].role, "start_frame");
});

test("per-call options.model overrides the default", async () => {
  const seen = [];
  const backend = createBackendVideoBackend({
    client: async (req) => {
      seen.push(req);
      return { b64_json: MP4_B64 };
    },
    model: "default",
  });
  await backend({ kind: "video", prompt: "x", options: { model: "per-call" } }, ctxFor());
  assert.equal(seen[0].model, "per-call");
});

test("count > 1 is forwarded and every returned clip becomes an asset", async () => {
  const seen = [];
  const backend = createBackendVideoBackend({
    client: async (req) => {
      seen.push(req);
      return [{ b64_json: MP4_B64 }, { b64_json: MP4_B64 }, { b64_json: MP4_B64 }];
    },
    model: "m",
  });
  const out = await backend({ kind: "video", prompt: "x", options: {}, count: 3 }, ctxFor());
  assert.equal(seen[0].count, 3);
  assert.equal(seen[0].options.n, 3);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 3);
});

test("a url response is fetched so the tool still gets bytes in hand", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(Buffer.from("downloaded-clip"), {
      status: 200,
      headers: { "content-type": "video/quicktime" },
    });
  try {
    const backend = createBackendVideoBackend({
      client: async () => ({ url: "https://host/clip-1" }),
      model: "m",
    });
    const out = await backend({ kind: "video", prompt: "x", options: {} }, ctxFor());
    assert.equal(out.mimeType, "video/quicktime");
    assert.equal(out.ext, "mov");
    assert.equal(Buffer.from(out.bytes).toString(), "downloaded-clip");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed url download errors loudly rather than writing an empty clip", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  try {
    const backend = createBackendVideoBackend({
      client: async () => ({ url: "https://host/gone" }),
      model: "m",
    });
    await assert.rejects(
      () => backend({ kind: "video", prompt: "x", options: {} }, ctxFor()),
      /download failed \(404\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no clip in the response is a loud error, not a silent empty asset", async () => {
  const backend = createBackendVideoBackend({
    client: async () => ({ status: "queued" }),
    model: "m",
  });
  await assert.rejects(
    () => backend({ kind: "video", prompt: "x", options: {} }, ctxFor()),
    /returned no clip/,
  );
});

// ---------------------------------------------------------------------------
// Resolution inside assets_generator
// ---------------------------------------------------------------------------

test("assets_generator routes kind:video to backendVideo, not the placeholder", async () => {
  const cwd = await tmpdir();
  const seen = [];
  const tool = createAssetsGeneratorTool({
    backendVideo: createBackendVideoBackend({
      client: async (req) => {
        seen.push(req);
        return { b64_json: MP4_B64, media_type: "video/mp4" };
      },
      model: "host-video",
    }),
  });
  const res = await tool.execute(
    "v1",
    {
      kind: "video",
      prompt: "a camera push through a doorway, warm evening light, slow and steady",
      images: [{ path: "https://host/first.png", role: "start_frame" }],
    },
    ctxFor(cwd),
  );
  assert.equal(res.details.placeholder, false, "a real backend ran, so nothing is a placeholder");
  assert.doesNotMatch(res.output, /PLACEHOLDER ONLY/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.frame_images[0].frame_type, "first_frame");
  assert.ok(res.details.uri.endsWith(".mp4"), `expected an .mp4, got ${res.details.uri}`);
  const written = await fs.readFile(res.details.uri);
  assert.equal(written.toString(), "fake-mp4-bytes");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("with no backendVideo the placeholder still runs, and honours count", async () => {
  const cwd = await tmpdir();
  const tool = createAssetsGeneratorTool({});
  const res = await tool.execute(
    "v2",
    { kind: "video", prompt: "a slow pan across a quiet room at dawn", count: 3 },
    ctxFor(cwd),
  );
  assert.equal(res.details.placeholder, true);
  assert.match(res.output, /PLACEHOLDER ONLY/);
  assert.equal(res.details.files.length, 3, "count must not be silently collapsed to 1");
  await fs.rm(cwd, { recursive: true, force: true });
});

test("the video placeholder records the frame roles it was given", async () => {
  const cwd = await tmpdir();
  const tool = createAssetsGeneratorTool({});
  const res = await tool.execute(
    "v3",
    {
      kind: "video",
      prompt: "morph between the two frames",
      images: [
        { path: "https://host/a.png", role: "start_frame" },
        { path: "https://host/b.png", role: "last_frame" },
      ],
    },
    ctxFor(cwd),
  );
  const manifest = JSON.parse(await fs.readFile(res.details.uri, "utf8"));
  assert.deepEqual(
    manifest.images.map((i) => i.role),
    ["start_frame", "last_frame"],
  );
  await fs.rm(cwd, { recursive: true, force: true });
});
