/**
 * Tests for `createBackendImageBackend` — the harness's delegating image backend
 * that routes `/images` through a host backend (OpenWaggleMain's
 * `/turing-machine/images` proxy) instead of calling OpenRouter directly.
 *
 * All offline: the host client is stubbed. The points worth pinning:
 *  - The stub client receives model/prompt/options and returns b64_json + media_type.
 *  - The backend decodes b64_json to bytes with the right mimeType + ext.
 *  - Per-call `options.model` overrides the default model; other options pass through.
 *  - Missing bytes → loud error (never a silent empty asset).
 *  - ctx.signal is forwarded to the client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAssetsGeneratorTool, createBackendImageBackend } from "../dist/index.js";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

function ctxFor() {
  return { cwd: "/tmp", log: () => {} };
}

test("decodes b64_json to bytes with mimeType + ext", async () => {
  const calls = [];
  const backend = createBackendImageBackend({
    client: async (req) => {
      calls.push(req);
      return { b64_json: PNG_B64, media_type: "image/png" };
    },
    model: "default-model",
  });
  const out = await backend(
    { kind: "image", prompt: "a red panda", options: {} },
    ctxFor(),
  );
  assert.deepEqual(calls[0].model, "default-model");
  assert.equal(calls[0].prompt, "a red panda");
  assert.equal(out.mimeType, "image/png");
  assert.equal(out.ext, "png");
  assert.ok(out.bytes instanceof Uint8Array);
  assert.equal(out.bytes.byteLength, Buffer.from(PNG_B64, "base64").byteLength);
  assert.match(out.summary, /via backend/);
});

test("media_type falls back to image/png; ext derived from mime", async () => {
  const backend = createBackendImageBackend({
    client: async () => ({ b64_json: PNG_B64, media_type: "image/jpeg" }),
    model: "m",
  });
  const out = await backend({ kind: "image", prompt: "x", options: {} }, ctxFor());
  assert.equal(out.mimeType, "image/jpeg");
  assert.equal(out.ext, "jpg"); // jpeg -> jpg
});

test("per-call options.model overrides default; other options forwarded", async () => {
  const seen = [];
  const backend = createBackendImageBackend({
    client: async (req) => {
      seen.push(req);
      return { b64_json: PNG_B64, media_type: "image/png" };
    },
    model: "default-model",
    defaults: { aspect_ratio: "1:1" },
  });
  await backend(
    {
      kind: "image",
      prompt: "p",
      options: { model: "per-call-model", seed: 7 },
    },
    ctxFor(),
  );
  assert.equal(seen[0].model, "per-call-model"); // overridden
  // defaults merged then per-call wins; seed forwarded, default aspect_ratio kept
  assert.equal(seen[0].options.seed, 7);
  assert.equal(seen[0].options.aspect_ratio, "1:1");
});

test("missing b64_json → loud error, never empty bytes", async () => {
  const backend = createBackendImageBackend({
    client: async () => ({ media_type: "image/png" }), // no b64_json
    model: "m",
  });
  await assert.rejects(
    () => backend({ kind: "image", prompt: "x", options: {} }, ctxFor()),
    /no bytes/,
  );
});

test("ctx.signal is forwarded to the client", async () => {
  let seenSignal;
  const backend = createBackendImageBackend({
    client: async (_req, ctx) => {
      seenSignal = ctx.signal;
      return { b64_json: PNG_B64, media_type: "image/png" };
    },
    model: "m",
  });
  const ac = new AbortController();
  await backend(
    { kind: "image", prompt: "x", options: {} },
    { ...ctxFor(), signal: ac.signal },
  );
  assert.equal(seenSignal, ac.signal);
});

// ---- Integration: the tool resolves `backendImage` ahead of OpenRouter/placeholder ----

test("tool picks backendImage over OpenRouter and the placeholder, and writes real bytes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-backend-img-"));
  // Both an OpenRouter key AND a stub that would throw are present; if the tool
  // chose OpenRouter (or the placeholder) the test fails loudly. The host
  // backend-image client is the ONLY path that should run.
  let clientCalled = 0;
  const tool = createAssetsGeneratorTool({
    openRouterImage: { apiKey: "would-be-used-if-backendImage-absent" },
    backendImage: createBackendImageBackend({
      client: async (req) => {
        clientCalled++;
        // A thin prompt is enriched with craft hints before it reaches the
        // backend — the generator sees only this string, so "a red panda"
        // alone generates poorly. The caller's words must still lead.
        assert.match(req.prompt, /^a red panda\./);
        assert.match(req.prompt, /composition and lighting/);
        return { b64_json: PNG_B64, media_type: "image/png" };
      },
      model: "backend-model",
    }),
  });
  try {
    const res = await tool.execute(
      "a1",
      { kind: "image", prompt: "a red panda", name: "panda" },
      { ...ctxFor(), cwd: tmp },
    );
    assert.equal(clientCalled, 1); // backendImage ran exactly once
    assert.equal(res.details.placeholder, false); // NOT the placeholder
    assert.doesNotMatch(res.output, /PLACEHOLDER|placeholder/i);
    assert.equal(await fs.readFile(res.details.uri, "utf8"), "fake-png-bytes");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("tool falls back to the placeholder when backendImage is absent and no key is set", async () => {
  // Sanity that the resolution chain still degrades correctly without backendImage.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-no-backend-"));
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const tool = createAssetsGeneratorTool(); // no backendImage, no key
    const res = await tool.execute(
      "a1",
      { kind: "image", prompt: "x" },
      { ...ctxFor(), cwd: tmp },
    );
    assert.equal(res.details.placeholder, true);
  } finally {
    if (saved) process.env.OPENROUTER_API_KEY = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
