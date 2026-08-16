/**
 * Tests for `assets_generator`'s real image backend (OpenRouter's image endpoint).
 *
 * All offline: `fetch` is stubbed. The points worth pinning down are that the
 * request goes to the IMAGE endpoint (not chat/completions), that per-model knobs
 * are forwarded rather than dropped, that a response without bytes fails loudly
 * instead of writing an empty asset, and that a missing API key still degrades to
 * the placeholder instead of erroring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_IMAGE_MODEL,
  createAssetsGeneratorTool,
  createOpenRouterImageBackend,
  ASSETS_AND_SVG,
  LOOP_SYSTEM_PROMPT,
} from "../dist/index.js";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

/** Stub `fetch`, recording every call. Returns a restore function. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function ctxFor(cwd) {
  return { cwd, log: () => {}, model: { id: "x", openRouterSlug: "x" } };
}

test("image backend posts to the IMAGE endpoint and decodes the bytes", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }));
  try {
    const backend = createOpenRouterImageBackend({ apiKey: "k" });
    const out = await backend({ kind: "image", prompt: "a red panda" }, ctxFor(os.tmpdir()));

    // Image generation is a DIFFERENT endpoint from chat — getting this wrong is
    // the whole reason this backend exists separately.
    assert.match(stub.calls[0].url, /\/images$/);
    assert.doesNotMatch(stub.calls[0].url, /chat\/completions/);
    assert.equal(stub.calls[0].init.headers.authorization, "Bearer k");
    assert.equal(stub.calls[0].body.prompt, "a red panda");
    assert.equal(stub.calls[0].body.model, DEFAULT_IMAGE_MODEL);

    assert.equal(Buffer.from(out.bytes).toString(), "fake-png-bytes");
    assert.equal(out.mimeType, "image/png");
    assert.equal(out.ext, "png");
  } finally {
    stub.restore();
  }
});

test("the default model is the configured one, and it stays overridable", async () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "sourceful/riverflow-v2-fast");

  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  try {
    // Pinned per backend...
    await createOpenRouterImageBackend({ apiKey: "k", model: "other/model" })(
      { kind: "image", prompt: "x" },
      ctxFor(os.tmpdir()),
    );
    assert.equal(stub.calls[0].body.model, "other/model");

    // ...and overridable per call, so one asset can use a heavier model.
    await createOpenRouterImageBackend({ apiKey: "k", model: "other/model" })(
      { kind: "image", prompt: "x", options: { model: "per/call" } },
      ctxFor(os.tmpdir()),
    );
    assert.equal(stub.calls[1].body.model, "per/call");
  } finally {
    stub.restore();
  }
});

test("per-model knobs are forwarded verbatim, not dropped", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  try {
    const backend = createOpenRouterImageBackend({
      apiKey: "k",
      defaults: { output_format: "png", aspect_ratio: "1:1" },
    });
    await backend(
      // Per-call options win over the backend defaults.
      { kind: "image", prompt: "x", options: { aspect_ratio: "16:9", seed: 7 } },
      ctxFor(os.tmpdir()),
    );

    const body = stub.calls[0].body;
    assert.equal(body.output_format, "png");
    assert.equal(body.aspect_ratio, "16:9");
    assert.equal(body.seed, 7);
  } finally {
    stub.restore();
  }
});

test("a jpeg response gets a .jpg extension, not .jpeg", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/jpeg" }] }));
  try {
    const out = await createOpenRouterImageBackend({ apiKey: "k" })(
      { kind: "image", prompt: "x" },
      ctxFor(os.tmpdir()),
    );
    assert.equal(out.ext, "jpg");
  } finally {
    stub.restore();
  }
});

test("a response with no image bytes fails loudly, naming what came back", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ revised_prompt: "nope" }] }));
  try {
    await assert.rejects(
      createOpenRouterImageBackend({ apiKey: "k" })({ kind: "image", prompt: "x" }, ctxFor(os.tmpdir())),
      // Writing a 0-byte asset and calling it generated would be far worse.
      /returned no image bytes.*revised_prompt/s,
    );
  } finally {
    stub.restore();
  }
});

test("an HTTP failure surfaces the status", async () => {
  const stub = stubFetch(() => jsonResponse({ error: "bad" }, false, 402));
  try {
    await assert.rejects(
      createOpenRouterImageBackend({ apiKey: "k" })({ kind: "image", prompt: "x" }, ctxFor(os.tmpdir())),
      /image request failed \(402\)/,
    );
  } finally {
    stub.restore();
  }
});

test("the tool writes a real generated image and does not call it a placeholder", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-real-"));
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }));
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: { apiKey: "k" } });
    const res = await tool.execute("a1", { kind: "image", prompt: "a red panda", name: "panda" }, ctxFor(tmp));

    assert.equal(res.details.placeholder, false);
    assert.doesNotMatch(res.output, /PLACEHOLDER/);
    assert.equal(res.details.uri, path.join(tmp, "assets", "panda.png"));
    assert.equal(await fs.readFile(res.details.uri, "utf8"), "fake-png-bytes");
    // Returned by reference, never inlined.
    assert.deepEqual(res.content, [{ type: "file", uri: res.details.uri, mimeType: "image/png" }]);
  } finally {
    stub.restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("with no API key the tool still runs, via a clearly-labelled placeholder", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-ph-"));
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  // Fail loudly if anything reaches the network on this path.
  const stub = stubFetch(() => { throw new Error("must not call the network without a key"); });
  try {
    const tool = createAssetsGeneratorTool();
    const res = await tool.execute("a1", { kind: "image", prompt: "a red panda" }, ctxFor(tmp));

    assert.equal(stub.calls.length, 0);
    assert.equal(res.details.placeholder, true);
    assert.match(res.output, /PLACEHOLDER ONLY/);
    assert.match(res.output, /do not present it as one/);
  } finally {
    stub.restore();
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("openRouterImage:false keeps the placeholder even when a key exists", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-off-"));
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "k";
  const stub = stubFetch(() => { throw new Error("must not call the network when disabled"); });
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: false });
    const res = await tool.execute("a1", { kind: "image", prompt: "x" }, ctxFor(tmp));
    assert.equal(stub.calls.length, 0);
    assert.equal(res.details.placeholder, true);
  } finally {
    stub.restore();
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("video/audio/3d are untouched — the image backend is image-only", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assets-other-"));
  const stub = stubFetch(() => { throw new Error("no network for non-image kinds"); });
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: { apiKey: "k" } });
    for (const kind of ["video", "audio", "3d"]) {
      const res = await tool.execute("a1", { kind, prompt: "x" }, ctxFor(tmp));
      assert.equal(res.details.placeholder, true, `${kind} must stay a placeholder`);
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The SVG rule: generate pixels, author vectors — and never spend a paid call on
// an animated SVG, whose flattened output has nothing an animation can target.
// ---------------------------------------------------------------------------

test("an animated-SVG request is declined with instructions, before any backend runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-svg-"));
  let backendCalls = 0;
  const tool = createAssetsGeneratorTool({
    backends: { image: async () => { backendCalls += 1; return { bytes: new Uint8Array([1]), mimeType: "image/png", ext: "png" }; } },
  });

  const res = await tool.execute("c1", {
    kind: "image",
    prompt: "an animated SVG of a rocket taking off for the hero",
  }, { cwd: dir, log: () => {} });

  assert.equal(backendCalls, 0, "no paid generation call is made");
  assert.equal(res.isError ?? false, false, "guidance, not an error — nothing here should be retried or escalated");
  assert.match(res.output, /NOT GENERATED/);
  // It must say what to do instead, concretely, or it just gets retried.
  assert.match(res.output, /Write it yourself with `write`/);
  assert.match(res.output, /prefers-reduced-motion/);
  assert.match(res.output, /currentColor/);
  assert.match(res.output, /Do NOT retry this call as-is/);
  // ...and the way out, if the user really did ask for this.
  assert.match(res.output, /If the USER explicitly asked for a generated SVG anyway/);
  assert.match(res.output, /`force: true`/);
  assert.equal(res.details.uri, "", "no file was written");
  assert.deepEqual(res.content, [], "and nothing is surfaced as an asset ref");

  // Nothing landed on disk.
  const entries = await fs.readdir(dir).catch(() => []);
  assert.deepEqual(entries, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test("force: an explicit user requirement outranks the steer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-force-"));
  let calls = 0;
  const tool = createAssetsGeneratorTool({
    backends: { image: async () => { calls += 1; return { bytes: new Uint8Array([1]), mimeType: "image/svg+xml", ext: "svg" }; } },
  });

  const res = await tool.execute("c1", {
    kind: "image", prompt: "an animated SVG logo", force: true,
  }, { cwd: dir, log: () => {} });

  // The guidance exists to stop a model wasting a call on an unusable artifact —
  // never to overrule the person who asked for it.
  assert.equal(calls, 1, "force generates");
  assert.doesNotMatch(res.output, /NOT GENERATED/);
  assert.ok(res.details.uri, "a real file was written");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the decline is narrow: static vectors and animated raster still generate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assets-svg-narrow-"));
  const calls = [];
  const tool = createAssetsGeneratorTool({
    backends: {
      image: async (req) => { calls.push(req.prompt); return { bytes: new Uint8Array([1]), mimeType: "image/svg+xml", ext: "svg" }; },
      video: async (req) => { calls.push(req.prompt); return { bytes: new Uint8Array([1]), mimeType: "video/mp4", ext: "mp4" }; },
    },
  });
  const ctx = { cwd: dir, log: () => {} };

  // A complex STATIC svg is a fair use of the generator.
  await tool.execute("c1", { kind: "image", prompt: "a complex decorative SVG blob background" }, ctx);
  // Motion words with no vector format named: that is a raster/video request.
  await tool.execute("c2", { kind: "image", prompt: "a photo of a rocket with motion blur" }, ctx);
  await tool.execute("c3", { kind: "video", prompt: "an animated loop of clouds drifting" }, ctx);
  assert.equal(calls.length, 3, "only animated *vector* requests are declined");

  // ...but the format option counts as naming the vector, not just the prompt.
  const viaOption = await tool.execute("c4", {
    kind: "image", prompt: "a spinner that rotates continuously", options: { format: "svg" },
  }, ctx);
  assert.match(viaOption.output, /NOT GENERATED/);
  assert.equal(calls.length, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("the prompts tell the model which side of the line a request falls on", () => {
  // Generate pixels nobody edits...
  assert.match(ASSETS_AND_SVG, /hero and section\n?\s*imagery/);
  assert.match(ASSETS_AND_SVG, /Generate ONCE and reuse/, "each call costs real money");
  // ...author anything themed, labelled or moving.
  assert.match(ASSETS_AND_SVG, /SVG IS CODE, SO PREFER WRITING IT/);
  assert.match(ASSETS_AND_SVG, /icons, logos and wordmarks/);
  assert.match(ASSETS_AND_SVG, /A complex STATIC decorative SVG is a fair thing to generate/);
  assert.match(ASSETS_AND_SVG, /The moment it needs to MOVE, do not/);
  // Practical shipping rules that keep a generated asset from wrecking the page.
  assert.match(ASSETS_AND_SVG, /aspect-ratio so the page does/);
  assert.match(ASSETS_AND_SVG, /A PLACEHOLDER IS NOT AN ASSET/);
  assert.ok(LOOP_SYSTEM_PROMPT.includes(ASSETS_AND_SVG), "the loop carries it verbatim");
});

/**
 * A generator sees only the prompt string — no conversation, no project
 * context. "a hero image" therefore produces something generic and unusable,
 * and the cost is a wasted generation plus a file the user rejects.
 */
test("a thin prompt gains craft hints, a rich one is left alone", async () => {
  const { enrichAssetPrompt } = await import("../dist/index.js");

  const thin = enrichAssetPrompt("image", "a red cube");
  assert.match(thin, /^a red cube\./, "the caller's intent must come first, verbatim");
  assert.match(thin, /composition and lighting/, "craft hints should be appended");

  // Hints are per-kind: audio needs mix and tempo, not composition.
  assert.match(enrichAssetPrompt("audio", "piano"), /tempo and key/);
  assert.match(enrichAssetPrompt("video", "a cube"), /consistent lighting/);

  // A model that already wrote a dense prompt is not second-guessed.
  const rich =
    "A weathered brass compass on a nautical chart, top-down macro shot, warm " +
    "afternoon window light, shallow depth of field, muted teal and amber palette";
  assert.equal(enrichAssetPrompt("image", rich), rich, "a rich prompt must pass through unchanged");
});

test("enrichment never invents subject matter", async () => {
  const { enrichAssetPrompt } = await import("../dist/index.js");
  // Hints must describe HOW to render, never WHAT to render — inventing content
  // would override what the user actually asked for.
  const out = enrichAssetPrompt("image", "logo");
  assert.match(out, /^logo\./);
  assert.doesNotMatch(out, /\b(cat|person|landscape|castle|robot)\b/i);
});
