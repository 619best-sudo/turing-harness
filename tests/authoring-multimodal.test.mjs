/**
 * Focused unit tests for the multimodal authoring path: when `images` are
 * supplied, the authoring helper builds a `UserContent[]` with image blocks and
 * calls the LLM with a vision-style system prompt; the model authors the file
 * bytes (write) or replacement text (edit) FROM the images.
 *
 * These tests exercise the authoring functions directly (not the orchestrator
 * loop), so they stay stable across the loop refactor.
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { authorFileContent, authorEditReplacement } from "../dist/tools/builtin/authoring.js";
import { CODING_TOOLS, OpenRouterBridge } from "../dist/index.js";

const writeTool = CODING_TOOLS.find((t) => t.name === "write");

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A recording stub LLMBridge: captures the last `complete` call's model, system
 * prompt, and user-message content, then returns fixed authored text + usage.
 */
function recordingLlm(text) {
  const calls = [];
  return {
    calls,
    complete: async (model, ctx) => {
      const userMsg = (ctx.messages ?? [])[0] ?? {};
      calls.push({
        model,
        systemPrompt: ctx.systemPrompt ?? "",
        content: userMsg.content,
      });
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        model: model.openRouterSlug ?? model.id,
        api: "openrouter",
        provider: "test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
      };
    },
    stream: async function* () {},
    resolveModel: (slug) => ({
      id: slug,
      openRouterSlug: slug,
      api: "openrouter",
      provider: "test",
      input: ["text", "image"],
      output: ["text"],
      reasoning: false,
    }),
  };
}

/** Make a tiny fake "image" file (not a real image — the stub doesn't care). */
async function makeImageFile(ext = "png") {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-mmi-"));
  const file = path.join(tmp, `mockup.${ext}`);
  await fs.writeFile(file, Buffer.from("FAKE-IMAGE-BYTES"));
  return file;
}

test("authorFileContent: without images stays plain-text (string content, AUTHOR_SYSTEM)", async () => {
  const llm = recordingLlm("AUTHORED_TEXT");
  await authorFileContent({
    llm,
    model: { id: "m", openRouterSlug: "m", api: "openrouter", provider: "x", input: ["text"], output: ["text"], reasoning: false },
    path: "/x/a.ts",
    task: "do the thing",
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(typeof llm.calls[0].content, "string", "no images → string user message");
  // Both image and non-image authoring share one minimal format contract now.
  assert.match(llm.calls[0].systemPrompt, /written to disk verbatim/);
});

test("authorFileContent: with images builds a UserContent[] with image blocks + vision system prompt", async () => {
  const img = await makeImageFile("png");
  const llm = recordingLlm("VISION_AUTHORED_HTML");
  const res = await authorFileContent({
    llm,
    model: { id: "m", openRouterSlug: "m", api: "openrouter", provider: "x", input: ["text", "image"], output: ["text"], reasoning: false },
    path: "/x/index.html",
    task: "build the landing page from the mockup",
    images: [{ path: img, mimeType: "image/png" }],
  });

  assert.equal(res.text, "VISION_AUTHORED_HTML");
  assert.equal(llm.calls.length, 1);
  const content = llm.calls[0].content;
  assert.ok(Array.isArray(content), "images → content-blocks array");
  const textBlock = content.find((c) => c.type === "text");
  const imageBlock = content.find((c) => c.type === "image");
  assert.ok(textBlock, "must include a text instruction block");
  assert.ok(imageBlock, "must include an image block");
  assert.equal(imageBlock.mimeType, "image/png");
  assert.ok(imageBlock.data.length > 0, "image block must carry base64 bytes");
  assert.match(textBlock.text, /build the landing page from the mockup/, "task instruction must be present");
  assert.match(textBlock.text, /Author this file from the image/i, "image intro prefix must be present");
  // Image and non-image authoring share one format contract now.
  assert.match(llm.calls[0].systemPrompt, /written to disk verbatim/);
});

test("authorEditReplacement: with images authors the replacement from the image, anchor preserved", async () => {
  const img = await makeImageFile("jpg");
  const llm = recordingLlm("VISION_REPLACEMENT");
  const res = await authorEditReplacement({
    llm,
    model: { id: "m", openRouterSlug: "m", api: "openrouter", provider: "x", input: ["text", "image"], output: ["text"], reasoning: false },
    path: "/x/index.html",
    oldString: "<div class='hero'>OLD</div>",
    currentContent: "<body><div class='hero'>OLD</div></body>",
    images: [{ path: img, mimeType: "image/jpeg" }],
  });

  assert.equal(res.text, "VISION_REPLACEMENT");
  const content = llm.calls[0].content;
  assert.ok(Array.isArray(content), "images → content-blocks array");
  const textBlock = content.find((c) => c.type === "text");
  const imageBlock = content.find((c) => c.type === "image");
  assert.ok(imageBlock, "must include an image block");
  assert.equal(imageBlock.mimeType, "image/jpeg");
  assert.match(textBlock.text, /TEXT TO REPLACE/, "anchor instructions preserved");
  assert.match(textBlock.text, /Author this file from the image/i, "image intro present");
  assert.match(llm.calls[0].systemPrompt, /written to disk verbatim/, "shared format contract used for edit-from-image too");
});

test("authorFileContent: multiple images produce one image block each", async () => {
  const img1 = await makeImageFile("png");
  const img2 = await makeImageFile("png");
  const llm = recordingLlm("X");
  await authorFileContent({
    llm,
    model: { id: "m", openRouterSlug: "m", api: "openrouter", provider: "x", input: ["text", "image"], output: ["text"], reasoning: false },
    path: "/x/x.ts",
    images: [
      { path: img1, mimeType: "image/png" },
      { path: img2, mimeType: "image/png" },
    ],
  });
  const imageBlocks = llm.calls[0].content.filter((c) => c.type === "image");
  assert.equal(imageBlocks.length, 2, "one image block per supplied image");
});

test("authorFileContent: an unreadable image is skipped, the rest still reach the model", async () => {
  const good = await makeImageFile("png");
  const llm = recordingLlm("X");
  await authorFileContent({
    llm,
    model: { id: "m", openRouterSlug: "m", api: "openrouter", provider: "x", input: ["text", "image"], output: ["text"], reasoning: false },
    path: "/x/x.ts",
    images: [
      { path: "/definitely/does/not/exist.png", mimeType: "image/png" },
      { path: good, mimeType: "image/png" },
    ],
  });
  const imageBlocks = llm.calls[0].content.filter((c) => c.type === "image");
  assert.equal(imageBlocks.length, 1, "unreadable image dropped, readable one kept");
});

// ---------------------------------------------------------------------------
// Vision escalation and the empty-response retry.
//
// The gap this closes: authoring only ran when the HOST pinned `authorModel`, so
// a run with attachments but no permission callback collected the images and then
// wrote the text-only draft anyway — "here is the mockup, build it" quietly became
// "build it from the words".
// ---------------------------------------------------------------------------

const VISION = { id: "test/vision", openRouterSlug: "test/vision", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function bridgeReturning(texts) {
  const llm = new OpenRouterBridge();
  const calls = [];
  let i = 0;
  llm.resolveModel = (slug) =>
    slug === "test/vision" ? VISION : { id: slug, openRouterSlug: slug, input: ["text"] };
  llm.complete = async (model, ctx) => {
    calls.push({ model: model.openRouterSlug ?? model.id, ctx });
    const text = texts[Math.min(i, texts.length - 1)];
    i += 1;
    return {
      role: "assistant", content: [{ type: "text", text }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
      stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, calls };
}

test("an attached image escalates authoring to a vision model with no host callback", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-esc-"));
  const shot = path.join(dir, "hero.png");
  await fs.writeFile(shot, "PNG");
  const target = path.join(dir, "Hero.tsx");

  const { llm, calls } = bridgeReturning(["export const Hero = () => <section/>;"]);
  const logs = [];
  const res = await writeTool.execute("c1", { path: target, content: "DRAFT" }, {
    cwd: dir, llm, log: (e) => logs.push(e),
    // No ctx.authorModel: the host pinned nothing. The images are what escalate.
    images: [{ path: shot, mimeType: "image/png" }],
    toolModelCandidates: ["test/cheap", "test/vision"],
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"] },
  });

  assert.equal(calls.length, 1, "the vision model authored the bytes");
  assert.equal(calls[0].model, "test/vision", "a text-only candidate cannot see the mockup");
  // Vision and non-vision authoring share one minimal format contract now.
  assert.match(calls[0].ctx.systemPrompt, /written to disk verbatim/);
  assert.equal(await fs.readFile(target, "utf8"), "export const Hero = () => <section/>;");
  assert.ok(logs.some((e) => e.tags?.includes("vision")), "the escalation is auditable");
  await fs.rm(dir, { recursive: true, force: true });
});

test("no images, no escalation — a plain write still writes the draft", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-none-"));
  const target = path.join(dir, "a.ts");
  const { llm, calls } = bridgeReturning(["AUTHORED"]);
  await writeTool.execute("c1", { path: target, content: "DRAFT" }, {
    cwd: dir, llm, log: () => {},
    toolModelCandidates: ["test/cheap", "test/vision"],
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"] },
  });
  assert.equal(calls.length, 0, "nothing to see means nothing to escalate");
  assert.equal(await fs.readFile(target, "utf8"), "DRAFT");
  await fs.rm(dir, { recursive: true, force: true });
});

test("an empty authoring response is retried once instead of failing the turn", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-retry-"));
  const target = path.join(dir, "a.ts");
  // First attempt comes back empty (truncated/refused); the second succeeds.
  const { llm, calls } = bridgeReturning(["", "export const ok = 1;"]);

  const res = await writeTool.execute("c1", { path: target, content: "DRAFT" }, {
    cwd: dir, llm, log: () => {},
    authorModel: { id: "test/author", openRouterSlug: "test/author", input: ["text"] },
  });

  assert.equal(calls.length, 2, "one retry, not a failed tool call the model must re-issue");
  // The retry nudges rather than repeating verbatim — an identical temperature-0
  // request tends to reproduce an identical empty answer.
  const retryText = JSON.stringify(calls[1].ctx.messages.at(-1).content);
  assert.match(retryText, /Your last response was empty/);
  assert.equal(res.isError ?? false, false);
  assert.equal(await fs.readFile(target, "utf8"), "export const ok = 1;");
  // Both attempts were paid for, so both are billed.
  assert.equal(res.usage.totalTokens, 4);
  await fs.rm(dir, { recursive: true, force: true });
});

test("two empty responses still fail loudly, and write nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-retry-fail-"));
  const target = path.join(dir, "a.ts");
  const { llm, calls } = bridgeReturning(["", ""]);
  const res = await writeTool.execute("c1", { path: target, content: "DRAFT" }, {
    cwd: dir, llm, log: () => {},
    authorModel: { id: "test/author", openRouterSlug: "test/author", input: ["text"] },
  });
  assert.equal(calls.length, 2, "one retry, not an unbounded loop");
  assert.equal(res.isError, true);
  assert.match(res.output, /returned empty content/);
  // Never silently falls back to Model A's draft: the contract is "B authors".
  await assert.rejects(fs.readFile(target, "utf8"), "nothing was written");
  assert.equal(res.details.draft, "DRAFT", "the draft survives for diagnostics");
  await fs.rm(dir, { recursive: true, force: true });
});
