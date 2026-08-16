/**
 * Unit tests for the media_analysis content-hash cache.
 *
 * Mirrors the read tool's comprehension reuse: same bytes + lens + prompt must
 * return the cached analysis without a provider call; different bytes, lens, or
 * prompt must miss and re-run. This is what stops a run that looks at a screen
 * twice from paying for it twice.
 *
 * Run via: npm test. Pure in-process — no LLM, no disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rememberMediaAnalysis,
  recallMediaAnalysis,
  forgetMediaAnalysis,
  clearMediaAnalysisMemory,
  hashImageBytes,
  hashPrompt,
} from "../dist/tools/builtin/media-analysis-reuse.js";

function setup() {
  // Each test starts clean so cache state cannot leak between tests.
  clearMediaAnalysisMemory();
}

test("recall returns the stored analysis on a hash + lens + prompt match", () => {
  setup();
  const h = hashImageBytes("png-bytes");
  const p = hashPrompt("describe this");
  rememberMediaAnalysis("/x.png", h, "ui", p, "a glassy hero");
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", p), "a glassy hero");
});

test("recall misses when the bytes changed (stale analysis is never served)", () => {
  setup();
  const h1 = hashImageBytes("v1");
  const h2 = hashImageBytes("v2");
  const p = hashPrompt("describe");
  rememberMediaAnalysis("/x.png", h1, "ui", p, "v1 analysis");
  assert.equal(recallMediaAnalysis("/x.png", h2, "ui", p), undefined);
});

test("recall misses when the lens differs — two questions about one image are distinct", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/x.png", h, "ui", p, "layout spec");
  assert.equal(recallMediaAnalysis("/x.png", h, "qa", p), undefined);
});

test("recall misses when the prompt differs — same lens, different question", () => {
  setup();
  const h = hashImageBytes("png");
  const p1 = hashPrompt("describe the layout");
  const p2 = hashPrompt("describe the colors");
  rememberMediaAnalysis("/x.png", h, "describe", p1, "layout answer");
  assert.equal(recallMediaAnalysis("/x.png", h, "describe", p2), undefined);
});

test("recall misses when the path differs even with identical bytes", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/a.png", h, "ui", p, "a");
  assert.equal(recallMediaAnalysis("/b.png", h, "ui", p), undefined);
});

test("re-analysis supersedes the prior entry for the same key", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/x.png", h, "ui", p, "first");
  rememberMediaAnalysis("/x.png", h, "ui", p, "second");
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", p), "second");
});

test("empty analyses are not stored (a blank result is not worth re-serving)", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/x.png", h, "ui", p, "  ");
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", p), undefined);
});

test("forgetMediaAnalysis drops every entry for a path", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/x.png", h, "ui", p, "ui analysis");
  rememberMediaAnalysis("/x.png", h, "describe", p, "describe analysis");
  forgetMediaAnalysis("/x.png");
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", p), undefined);
  assert.equal(recallMediaAnalysis("/x.png", h, "describe", p), undefined);
});

test("forgetMediaAnalysis leaves other paths untouched", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/a.png", h, "ui", p, "a");
  rememberMediaAnalysis("/b.png", h, "ui", p, "b");
  forgetMediaAnalysis("/a.png");
  assert.equal(recallMediaAnalysis("/a.png", h, "ui", p), undefined);
  assert.equal(recallMediaAnalysis("/b.png", h, "ui", p), "b");
});

test("clearMediaAnalysisMemory empties the whole cache", () => {
  setup();
  const h = hashImageBytes("png");
  const p = hashPrompt("look");
  rememberMediaAnalysis("/x.png", h, "ui", p, "stored");
  clearMediaAnalysisMemory();
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", p), undefined);
});

test("hashPrompt and hashImageBytes are stable for identical input", () => {
  assert.equal(hashPrompt("describe"), hashPrompt("describe"));
  assert.equal(hashImageBytes("bytes"), hashImageBytes("bytes"));
  assert.notEqual(hashPrompt("a"), hashPrompt("b"));
});

test("back-compat: rememberUiAnalysis / recallUiAnalysis round-trip via the general cache", async () => {
  clearMediaAnalysisMemory();
  const { rememberUiAnalysis, recallUiAnalysis } = await import(
    "../dist/tools/builtin/media-analysis-reuse.js"
  );
  const h = hashImageBytes("png");
  rememberUiAnalysis("/x.png", h, "ui analysis");
  assert.equal(recallUiAnalysis("/x.png", h), "ui analysis");
  // And it is reachable through the general API too.
  assert.equal(recallMediaAnalysis("/x.png", h, "ui", hashPrompt("")), "ui analysis");
});
