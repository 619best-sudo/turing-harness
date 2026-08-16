/**
 * The `compare` lens: replication fidelity.
 *
 * `qa` checks a screenshot against a written expectation. `compare` checks it
 * against the DESIGN ITSELF and returns geometry — per-region bounding boxes,
 * pixel deltas and a FIX line — because the consumer is the next write/edit, and
 * "the spacing looks off" is not something a model can act on.
 *
 * All offline: a stub bridge captures exactly what would go over the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenRouterBridge, createMediaAnalysisTool, lensSystemPrompt, resolveLens } from "../dist/index.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeBridge(replyText) {
  const llm = new OpenRouterBridge();
  const seen = [];
  llm.complete = async (model, ctx) => {
    seen.push({ model: model.openRouterSlug ?? model.id, ctx });
    return {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, seen };
}

async function fixtureDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-compare-"));
  const design = path.join(dir, "hero-design.png");
  const shot = path.join(dir, "screenshot.png");
  await fs.writeFile(design, PNG_BYTES);
  await fs.writeFile(shot, PNG_BYTES);
  return { dir, design, shot };
}

const ctxFor = (llm, dir) => ({ cwd: dir, llm, log: () => {} });

test("compare is a real lens, not silently downgraded to describe", () => {
  assert.equal(resolveLens("compare"), "compare");
  assert.notEqual(lensSystemPrompt("compare"), lensSystemPrompt("describe"));
});

test("the compare prompt demands boxes, pixel deltas and a fix per difference", () => {
  const p = lensSystemPrompt("compare");
  assert.match(p, /VERDICT: MATCH/);
  assert.match(p, /BOX:/);
  assert.match(p, /\[x, y, w, h\]/);
  assert.match(p, /DELTA:/);
  assert.match(p, /FIX:/);
  // Normalization: a 1440px design against a 1280px shot is not 160px of error.
  assert.match(p, /normalize/i);
  assert.match(p, /scale factor/i);
  // Noise control, so the report stays actionable.
  assert.match(p, /NOT VERIFIABLE HERE/);
});

test("`reference` puts the design first and labels both roles for the analyst", async () => {
  const { dir, design, shot } = await fixtureDir();
  const { llm, seen } = makeBridge("VERDICT: MISMATCH\nREGION: primary CTA");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute(
    "c1",
    { reference: design, file: shot, lens: "compare", prompt: "Does the hero match?" },
    ctxFor(llm, dir),
  );

  assert.equal(res.isError ?? false, false);
  // Order is the only channel for the roles — the design must lead.
  assert.deepEqual(res.details.analyzed.map((m) => m.path), [design, shot]);

  const text = seen[0].ctx.messages[0].content.find((c) => c.type === "text").text;
  assert.match(text, /1\. .*hero-design\.png — REFERENCE/);
  assert.match(text, /2\. .*screenshot\.png — IMPLEMENTATION/);
  // Explicit `reference` means no positional guess is being made.
  assert.doesNotMatch(text, /assumed from position/);
  assert.match(seen[0].ctx.systemPrompt, /visual diff engine/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("without `reference` the leading attachment is used, and the guess is disclosed", async () => {
  const { dir, design, shot } = await fixtureDir();
  const { llm, seen } = makeBridge("VERDICT: MATCH");
  const tool = createMediaAnalysisTool();

  await tool.execute("c1", { files: [design, shot], lens: "compare", prompt: "Match?" }, ctxFor(llm, dir));

  const text = seen[0].ctx.messages[0].content.find((c) => c.type === "text").text;
  assert.match(text, /REFERENCE.*assumed from position/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("compare with one attachment is refused rather than degrading into a description", async () => {
  const { dir, shot } = await fixtureDir();
  const { llm, seen } = makeBridge("should not be called");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file: shot, lens: "compare", prompt: "Match?" }, ctxFor(llm, dir));

  assert.equal(res.isError, true);
  assert.match(res.output, /needs two attachments/);
  assert.match(res.output, /`reference`/);
  assert.equal(seen.length, 0, "no provider call is spent on a diff with one side");
  await fs.rm(dir, { recursive: true, force: true });
});

test("both images ride the same request, which is what makes a diff possible", async () => {
  const { dir, design, shot } = await fixtureDir();
  const { llm, seen } = makeBridge("VERDICT: MATCH");
  const tool = createMediaAnalysisTool();

  await tool.execute(
    "c1",
    { reference: design, file: shot, lens: "compare", prompt: "Match?" },
    ctxFor(llm, dir),
  );

  assert.equal(seen[0].ctx.messages[0].content.filter((c) => c.type === "image").length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the roster is scoped to compare — other lenses are untouched", async () => {
  const { dir, design, shot } = await fixtureDir();
  const { llm, seen } = makeBridge("Two screenshots.");
  const tool = createMediaAnalysisTool();

  await tool.execute("c1", { files: [design, shot], prompt: "What changed?" }, ctxFor(llm, dir));

  const text = seen[0].ctx.messages[0].content.find((c) => c.type === "text").text;
  assert.doesNotMatch(text, /ATTACHMENTS, in order/);
  await fs.rm(dir, { recursive: true, force: true });
});
