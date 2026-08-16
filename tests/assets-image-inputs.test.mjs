/**
 * Tests for `assets_generator`'s IMAGE INPUTS and BATCH output.
 *
 * Two capabilities that only exist together, because both are about generating
 * from something other than a bare sentence:
 *
 *  - `images` — the picture the generation is based on. A local path has to be
 *    inlined as a data URL (a provider cannot read the host's disk), an http URL
 *    has to be passed through untouched (cheaper than base64), and an unreadable
 *    path has to fail BEFORE a paid call rather than after one that quietly
 *    ignored the reference.
 *  - `count` — several assets from one prompt. The failure this pins down is the
 *    one that costs money silently: a provider billing for `n` images while the
 *    tool reads `data[0]` and drops the rest.
 *
 * All offline: `fetch` and the host client are stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAssetsGeneratorTool,
  createOpenRouterImageBackend,
  createBackendImageBackend,
  resolveAssetImages,
  clampCount,
  ASSETS_AND_SVG,
} from "../dist/index.js";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function ctxFor(cwd) {
  return { cwd, log: () => {}, model: { id: "x", openRouterSlug: "x" } };
}

async function mktmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "assets-inputs-"));
}

// ---------------------------------------------------------------------------
// Resolving the caller's `images` argument
// ---------------------------------------------------------------------------

test("a local path is read and inlined as a data URL", async () => {
  const tmp = await mktmp();
  const file = path.join(tmp, "hero.png");
  await fs.writeFile(file, Buffer.from(PNG_B64, "base64"));

  const [img] = await resolveAssetImages([{ path: file }], tmp);
  assert.equal(img.role, "reference", "role defaults to reference");
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.source, file, "the original path is kept for logs/errors");
  assert.ok(img.url.startsWith("data:image/png;base64,"), "a provider cannot read the host disk");
  assert.equal(img.url.split(",")[1], PNG_B64);
});

test("a relative path resolves against cwd", async () => {
  const tmp = await mktmp();
  await fs.mkdir(path.join(tmp, "art"), { recursive: true });
  await fs.writeFile(path.join(tmp, "art", "a.jpg"), Buffer.from(PNG_B64, "base64"));

  const [img] = await resolveAssetImages(["art/a.jpg"], tmp);
  assert.equal(img.mimeType, "image/jpeg");
  assert.ok(img.url.startsWith("data:image/jpeg;base64,"));
});

test("http(s) and data URLs pass through untouched", async () => {
  const tmp = await mktmp();
  const resolved = await resolveAssetImages(
    [
      { path: "https://example.com/photo.webp", role: "style" },
      { path: "data:image/gif;base64,AAAA" },
    ],
    tmp,
  );
  assert.equal(resolved[0].url, "https://example.com/photo.webp", "a URL is cheaper than its base64");
  assert.equal(resolved[0].mimeType, "image/webp");
  assert.equal(resolved[0].role, "style");
  assert.equal(resolved[1].url, "data:image/gif;base64,AAAA");
  assert.equal(resolved[1].mimeType, "image/gif");
});

test("an unknown role falls back to reference rather than being sent through", async () => {
  const [img] = await resolveAssetImages([{ path: "https://x/a.png", role: "wat" }], "/tmp");
  assert.equal(img.role, "reference");
});

test("video frame roles survive resolution", async () => {
  const resolved = await resolveAssetImages(
    [
      { path: "https://x/first.png", role: "start_frame" },
      { path: "https://x/last.png", role: "last_frame" },
    ],
    "/tmp",
  );
  assert.deepEqual(resolved.map((i) => i.role), ["start_frame", "last_frame"]);
});

test("an unreadable reference is refused BEFORE any generation call", async () => {
  const tmp = await mktmp();
  let backendCalls = 0;
  const tool = createAssetsGeneratorTool({
    backends: {
      image: async () => {
        backendCalls += 1;
        return { bytes: new Uint8Array([1]), mimeType: "image/png", ext: "png" };
      },
    },
  });

  const res = await tool.execute(
    "a1",
    { kind: "image", prompt: "remix this", images: [{ path: "nope/missing.png" }] },
    ctxFor(tmp),
  );

  assert.equal(backendCalls, 0, "paying for a call that ignores the reference is the failure mode");
  assert.match(res.output, /NOT GENERATED/);
  assert.match(res.output, /not readable/);
  assert.match(res.output, /missing\.png/, "name the path so the caller can fix it");
  assert.equal(res.details.uri, "");
});

// ---------------------------------------------------------------------------
// The OpenRouter wire format
// ---------------------------------------------------------------------------

test("input images go out as input_references in OpenRouter's shape", async () => {
  const tmp = await mktmp();
  const file = path.join(tmp, "src.png");
  await fs.writeFile(file, Buffer.from(PNG_B64, "base64"));
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }));
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: { apiKey: "k" } });
    await tool.execute(
      "a1",
      {
        kind: "image",
        prompt: "make this scene look like a watercolour painting at dusk with soft light",
        images: [{ path: file }, { path: "https://example.com/style.jpg", role: "style" }],
      },
      ctxFor(tmp),
    );

    const refs = stub.calls[0].body.input_references;
    assert.equal(refs.length, 2);
    assert.equal(refs[0].type, "image_url");
    assert.ok(refs[0].image_url.url.startsWith("data:image/png;base64,"));
    assert.equal(refs[1].image_url.url, "https://example.com/style.jpg");
  } finally {
    stub.restore();
  }
});

test("start_frame is ordered first and last_frame last", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  try {
    const backend = createOpenRouterImageBackend({ apiKey: "k" });
    await backend(
      {
        kind: "image",
        prompt: "interpolate",
        images: [
          { role: "last_frame", url: "https://x/z.png", mimeType: "image/png", source: "z" },
          { role: "start_frame", url: "https://x/a.png", mimeType: "image/png", source: "a" },
        ],
      },
      ctxFor(os.tmpdir()),
    );
    const urls = stub.calls[0].body.input_references.map((r) => r.image_url.url);
    assert.deepEqual(urls, ["https://x/a.png", "https://x/z.png"]);
  } finally {
    stub.restore();
  }
});

test("no images means no input_references key at all", async () => {
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  try {
    const backend = createOpenRouterImageBackend({ apiKey: "k" });
    await backend({ kind: "image", prompt: "a red panda" }, ctxFor(os.tmpdir()));
    assert.ok(!("input_references" in stub.calls[0].body));
    assert.ok(!("n" in stub.calls[0].body), "n is only sent when more than one is asked for");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

test("count sends n and writes EVERY image the provider returned", async () => {
  const tmp = await mktmp();
  const stub = stubFetch(() =>
    jsonResponse({
      data: [
        { b64_json: Buffer.from("one").toString("base64"), media_type: "image/png" },
        { b64_json: Buffer.from("two").toString("base64"), media_type: "image/png" },
        { b64_json: Buffer.from("three").toString("base64"), media_type: "image/png" },
      ],
    }),
  );
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: { apiKey: "k" } });
    const res = await tool.execute(
      "a1",
      { kind: "image", prompt: "an avatar", name: "avatar", count: 3 },
      ctxFor(tmp),
    );

    assert.equal(stub.calls[0].body.n, 3);
    assert.equal(res.details.files.length, 3, "billing for three and keeping one is the bug");
    assert.deepEqual(
      res.details.files.map((f) => path.basename(f.uri)),
      ["avatar.png", "avatar-2.png", "avatar-3.png"],
      "the first keeps the plain name; the rest are suffixed, never overwritten",
    );
    assert.equal(res.details.uri, res.details.files[0].uri, "uri mirrors files[0]");
    assert.equal(await fs.readFile(res.details.files[1].uri, "utf8"), "two");
    assert.equal(await fs.readFile(res.details.files[2].uri, "utf8"), "three");
    // Every asset is addressable downstream, not just the first.
    assert.equal(res.content.length, 3);
    assert.deepEqual(res.content.map((c) => c.uri), res.details.files.map((f) => f.uri));
    assert.match(res.output, /3 images/);
  } finally {
    stub.restore();
  }
});

test("a single asset keeps the old single-file shape", async () => {
  const tmp = await mktmp();
  const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }));
  try {
    const tool = createAssetsGeneratorTool({ openRouterImage: { apiKey: "k" } });
    const res = await tool.execute("a1", { kind: "image", prompt: "a panda", name: "p" }, ctxFor(tmp));
    assert.equal(res.details.uri, path.join(tmp, "assets", "p.png"));
    assert.equal(res.details.files.length, 1);
    assert.equal(res.content.length, 1);
  } finally {
    stub.restore();
  }
});

test("the placeholder backend still honours count, so offline runs see the real shape", async () => {
  const tmp = await mktmp();
  const tool = createAssetsGeneratorTool({ openRouterImage: false });
  const res = await tool.execute("a1", { kind: "image", prompt: "x", name: "ph", count: 2 }, ctxFor(tmp));
  assert.equal(res.details.placeholder, true);
  assert.equal(res.details.files.length, 2);
  const [a, b] = await Promise.all(res.details.files.map((f) => fs.readFile(f.uri, "utf8")));
  assert.notEqual(a, b, "distinct stand-ins, not the same file twice");
  assert.match(res.output, /PLACEHOLDER ONLY/);
});

test("count is clamped to the 1-10 the providers accept", () => {
  assert.equal(clampCount(undefined), 1);
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(-4), 1);
  assert.equal(clampCount(2.7), 2);
  assert.equal(clampCount(50), 10);
  assert.equal(clampCount("nonsense"), 1);
});

// ---------------------------------------------------------------------------
// The host-delegating backend gets the same capability
// ---------------------------------------------------------------------------

test("the host image client receives references and n, typed and in options", async () => {
  const seen = [];
  const backend = createBackendImageBackend({
    client: async (req) => {
      seen.push(req);
      return [
        { b64_json: Buffer.from("a").toString("base64"), media_type: "image/png" },
        { b64_json: Buffer.from("b").toString("base64"), media_type: "image/png" },
      ];
    },
    model: "m",
  });

  const out = await backend(
    {
      kind: "image",
      prompt: "remix",
      options: {},
      count: 2,
      images: [{ role: "reference", url: "https://x/a.png", mimeType: "image/png", source: "a" }],
    },
    { cwd: "/tmp", log: () => {} },
  );

  // Typed, for a client that inspects the request...
  assert.equal(seen[0].count, 2);
  assert.equal(seen[0].images.length, 1);
  // ...and folded into `options`, so a client that forwards options verbatim to
  // OpenRouter's /images gets image-to-image with no mapping code.
  assert.equal(seen[0].options.n, 2);
  assert.equal(seen[0].options.input_references[0].image_url.url, "https://x/a.png");

  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
});

test("a host client returning a bare object still means one asset", async () => {
  const backend = createBackendImageBackend({
    client: async () => ({ b64_json: PNG_B64, media_type: "image/png" }),
    model: "m",
  });
  const out = await backend({ kind: "image", prompt: "x", options: {} }, { cwd: "/tmp", log: () => {} });
  assert.ok(!Array.isArray(out));
  assert.equal(out.ext, "png");
});

test("an all-empty batch fails loudly instead of writing zero-byte files", async () => {
  const backend = createBackendImageBackend({
    client: async () => [{ media_type: "image/png" }, {}],
    model: "m",
  });
  await assert.rejects(
    () => backend({ kind: "image", prompt: "x", options: {} }, { cwd: "/tmp", log: () => {} }),
    /no bytes/,
  );
});

// ---------------------------------------------------------------------------
// The model is told these exist
// ---------------------------------------------------------------------------

test("the assets guidance teaches generating FROM an image and asking for a set", () => {
  assert.match(ASSETS_AND_SVG, /GENERATE FROM AN IMAGE/);
  assert.match(ASSETS_AND_SVG, /start_frame/);
  assert.match(ASSETS_AND_SVG, /last_frame/);
  assert.match(ASSETS_AND_SVG, /role:"mask"|role:\\"mask\\"/);
  assert.match(ASSETS_AND_SVG, /`count`/);
});

test("the tool schema advertises images and count", () => {
  const tool = createAssetsGeneratorTool({ openRouterImage: false });
  const props = tool.parameters.properties;
  assert.equal(props.images.type, "array");
  assert.deepEqual(props.images.items.properties.role.enum, [
    "reference",
    "start_frame",
    "last_frame",
    "mask",
    "style",
  ]);
  assert.equal(props.count.type, "number");
});
