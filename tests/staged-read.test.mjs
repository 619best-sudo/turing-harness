/**
 * Tests for the staged `read`: a two-step read that mirrors the write/edit
 * two-step. Stage 1 rates how hard the file just loaded is to reason about;
 * stage 2 escalates comprehension to a stronger model when the rating says the
 * current model shouldn't be trusted with it.
 *
 * Unlike write/edit — where the HOST decides escalation pre-flight via
 * `authorModel` — the read decision is made internally, so these tests assert
 * both that it fires without any host involvement and that it degrades to a
 * plain read whenever the plumbing is absent.
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 * All offline — a stub bridge stands in for both internal LLM calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  readTool,
  runToolLoop,
  CODE_RISK_SITES,
  CODE_RISK_FOR_RATING,
  CODE_RISK_FOR_COMPREHENSION,
  CODE_RISK_FOR_AUTHORING,
} from "../dist/index.js";

const CHEAP = "test/cheap";
const STRONG = "test/strong";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function usageWith(output) {
  return {
    input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/** A file long/dense enough to clear the cheap trivia prefilter. */
function complexSource() {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`export function fn${i}(a, b) { return acquire(a) ? release(b, ${i}) : retry(a, b); }`);
  }
  return lines.join("\n");
}

async function tmpFile(name, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "staged-read-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, contents, "utf8");
  return { dir, file };
}

/**
 * Stub bridge for the two internal calls the staged read makes. Distinguishes
 * them by system prompt (the rater judges difficulty; the comprehender analyzes)
 * and records every call so tests can assert how many were actually spent.
 */
function makeBridge({ rating = "high", why = "lock-free retry loop", analysis = "L3: acquire() may reenter." } = {}) {
  const llm = new OpenRouterBridge();
  const calls = [];
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const kind = /judge how hard a source file/i.test(sys) ? "rate" : "comprehend";
    calls.push({ kind, model: model.openRouterSlug ?? model.id });
    const text = kind === "rate" ? `RATING: ${rating} | WHY: ${why}` : analysis;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      model: kind === "rate" ? CHEAP : STRONG,
      api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, calls };
}

function ctxFor(llm, dir, extra = {}) {
  return {
    cwd: dir,
    model: { id: CHEAP, openRouterSlug: CHEAP, input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    ...extra,
  };
}

test("staged read: escalates comprehension when the file rates high", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const { llm, calls } = makeBridge();

  const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, {
    toolModelCandidates: [CHEAP, STRONG],
  }));

  assert.equal(res.isError ?? false, false);
  assert.deepEqual(calls.map((c) => c.kind), ["rate", "comprehend"]);
  // The escalation must go to a DIFFERENT, later-tier model than the reader.
  assert.equal(calls[1].model, STRONG);

  // Raw bytes survive verbatim — the analysis is additive, never a replacement.
  // Model A still has to emit a byte-exact `oldString` anchor from this output.
  assert.match(res.output, /1\texport function fn0/);
  assert.match(res.output, /ANALYSIS OF THE FILE ABOVE \(from test\/strong/);
  assert.match(res.output, /acquire\(\) may reenter/);

  // The measured rating is reported so the loop can raise the path's floor.
  assert.equal(res.measuredComplexity, "high");
  assert.equal(res.measuredPath, file);
  assert.equal(res.details.comprehendedBy, STRONG);
  assert.equal(res.details.complexityWhy, "lock-free retry loop");

  // Both internal calls are billed to the caller.
  assert.equal(res.usage.totalTokens > 0, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("staged read: a low rating leaves the read untouched", async () => {
  const { dir, file } = await tmpFile("plain.js", complexSource());
  const { llm, calls } = makeBridge({ rating: "low", why: "flat helpers" });

  const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, {
    toolModelCandidates: [CHEAP, STRONG],
  }));

  assert.deepEqual(calls.map((c) => c.kind), ["rate"]);
  assert.equal(res.measuredComplexity, "low");
  assert.equal(res.details.comprehendedBy, undefined);
  assert.doesNotMatch(res.output, /ANALYSIS OF THE FILE ABOVE/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("staged read: degrades to a plain read with no candidate pool", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const { llm, calls } = makeBridge();

  // No `toolModelCandidates` — a host that never wired escalation gets exactly
  // the old single-stage behavior, with no config flag involved.
  const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir));

  assert.equal(calls.length, 0);
  assert.equal(res.measuredComplexity, undefined);
  assert.match(res.output, /1\texport function fn0/);
  assert.doesNotMatch(res.output, /ANALYSIS OF THE FILE ABOVE/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("staged read: prefilter classifies trivial files with zero LLM calls", async () => {
  const { llm, calls } = makeBridge();
  const short = await tmpFile("short.js", "export const a = 1;\nexport const b = 2;\n");
  const json = await tmpFile("data.json", JSON.stringify({ k: complexSource() }, null, 2));

  for (const target of [short, json]) {
    const res = await readTool.execute("c1", { path: target.file }, ctxFor(llm, target.dir, {
      toolModelCandidates: [CHEAP, STRONG],
    }));
    assert.equal(res.measuredComplexity, "low");
    assert.doesNotMatch(res.output, /ANALYSIS OF THE FILE ABOVE/);
    await fs.rm(target.dir, { recursive: true, force: true });
  }
  assert.equal(calls.length, 0, "the prefilter must not spend a rater call");
});

test("staged read: a known rating skips the rater and escalates directly", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const { llm, calls } = makeBridge();

  const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, {
    toolModelCandidates: [CHEAP, STRONG],
    knownComplexity: "high",
  }));

  assert.deepEqual(calls.map((c) => c.kind), ["comprehend"], "re-rating a judged file wastes a call");
  assert.equal(res.measuredComplexity, "high");
  assert.match(res.output, /ANALYSIS OF THE FILE ABOVE/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("staged read: a rater failure degrades instead of failing the read", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const llm = new OpenRouterBridge();
  llm.complete = async () => { throw new Error("rater endpoint down"); };

  const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, {
    toolModelCandidates: [CHEAP, STRONG],
  }));

  // A read that dies takes the whole step with it, so rating failure must be
  // survivable — unlike authoring failure, which would write wrong bytes.
  assert.equal(res.isError ?? false, false);
  assert.match(res.output, /1\texport function fn0/);
  assert.equal(res.measuredComplexity, "low");
  await fs.rm(dir, { recursive: true, force: true });
});

test("loop: a measured rating becomes the floor for the next call on that path", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const { llm } = makeBridge();

  // Two turns: read the file, then edit it. The edit must arrive at the gate
  // already carrying the rating the read measured.
  let turn = 0;
  llm.stream = async function* () {
    const base = {
      role: "assistant", content: [], model: CHEAP, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
    yield { type: "start", partial: base };
    turn += 1;
    if (turn === 1) {
      yield {
        type: "done",
        message: {
          ...base,
          stopReason: "tool_use",
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: file } }],
        },
      };
      return;
    }
    if (turn === 2) {
      yield {
        type: "done",
        message: {
          ...base,
          stopReason: "tool_use",
          content: [{
            type: "toolCall", id: "t2", name: "edit",
            arguments: { path: file, oldString: "export function fn0", newString: "export function fn0Renamed" },
          }],
        },
      };
      return;
    }
    yield { type: "done", message: { ...base, content: [{ type: "text", text: "done" }] } };
  };

  const requests = [];
  const gate = new PermissionGate("bypass", async (req) => {
    requests.push(req);
    return { allowed: true };
  });

  const { editTool } = await import("../dist/index.js");
  const result = await runToolLoop({
    task: "rename fn0",
    userMessage: "rename fn0",
    tools: [readTool, editTool],
    model: { id: CHEAP, openRouterSlug: CHEAP, input: ["text"], output: ["text"] },
    toolModelCandidates: [CHEAP, STRONG],
    llm,
    permission: gate,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    maxSteps: 6,
  });

  assert.equal(result.error, undefined);
  const editReq = requests.find((r) => r.name === "edit");
  assert.ok(editReq, "the edit call must reach the gate");
  assert.equal(editReq.complexityRating, "high");
  // Reported honestly as measured off the real file, not mislabeled as inherited
  // from a plan the run never had.
  assert.equal(editReq.complexitySource, "tool-measured");
  assert.equal(editReq.complexity.signals.inheritedComplexity, "high");
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The shared risk enumeration: conditionals, return values, sync/async, loops,
// cross-file dependencies, libraries. Every model that looks at code — the rater,
// the comprehender, the authoring model, and the requesting model itself — must be
// aimed at the same six places, or the escalation spends money without buying
// attention where edits actually break.
// ---------------------------------------------------------------------------

test("the risk sites name the six places code breaks, in every framing", () => {
  for (const [label, text] of Object.entries({
    shared: CODE_RISK_SITES,
    rating: CODE_RISK_FOR_RATING,
    comprehension: CODE_RISK_FOR_COMPREHENSION,
    authoring: CODE_RISK_FOR_AUTHORING,
  })) {
    assert.match(text, /CONDITIONALS AND BRANCHES/, `${label} covers conditionals`);
    assert.match(text, /FUNCTIONS THAT RETURN A VALUE/, `${label} covers return values`);
    assert.match(text, /SYNC VS ASYNC/, `${label} covers sync\/async`);
    assert.match(text, /LOOPS AND ITERATION/, `${label} covers loops`);
    assert.match(text, /OTHER FILES THAT DEPEND ON THIS/, `${label} covers cross-file deps`);
    assert.match(text, /LIBRARIES AND EXTERNAL APIs/, `${label} covers libraries`);
  }
  // The specific failure modes, not just the headings.
  assert.match(CODE_RISK_SITES, /missing `await`/);
  assert.match(CODE_RISK_SITES, /can one\n?\s*fall off the end as undefined/);
  assert.match(CODE_RISK_SITES, /update its callers/);
  assert.match(CODE_RISK_SITES, /graph_memory/);
  assert.match(CODE_RISK_SITES, /version actually installed/);
});

test("each framing points its model at the right job", () => {
  // The rater judges difficulty by density of these, not by file length.
  assert.match(CODE_RISK_FOR_RATING, /Density of these, not line count/);
  // The comprehender must not pad: only the risks that are real in this file.
  assert.match(CODE_RISK_FOR_COMPREHENSION, /line numbers/);
  // The author must choose the safe reading when context is short.
  assert.match(CODE_RISK_FOR_AUTHORING, /writing\n?\s*something new, modifying what is there, or fixing a bug/);
  assert.match(CODE_RISK_FOR_AUTHORING, /correct under both readings/);
});

test("the rater and comprehension prompts carry the risk sites to the model", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const systems = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (model, ctx) => {
    systems.push(ctx.systemPrompt ?? "");
    const rate = /judge how hard a source file/i.test(ctx.systemPrompt ?? "");
    const text = rate ? "RATING: high | WHY: nested async branches" : "L3: acquire() may reenter.";
    return {
      role: "assistant", content: [{ type: "text", text }],
      model: rate ? CHEAP : STRONG, api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };

  await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { toolModelCandidates: [CHEAP, STRONG] }));

  assert.equal(systems.length, 2, "rate then comprehend");
  const [raterSystem, comprehendSystem] = systems;
  assert.match(raterSystem, /SYNC VS ASYNC/, "the rater is told what makes a file hard");
  assert.match(raterSystem, /RATING: <low\|medium\|high>/, "and still answers in one parseable line");
  assert.match(comprehendSystem, /OTHER FILES THAT DEPEND ON THIS/, "the analysis is aimed at the risk sites");
  assert.match(comprehendSystem, /do NOT summarize or restate the code/, "without restating the file");

  await fs.rm(dir, { recursive: true, force: true });
});

test("medium escalates too — low is the only rating that proceeds unaided", async () => {
  for (const rating of ["medium", "high"]) {
    const { dir, file } = await tmpFile(`m-${rating}.js`, complexSource());
    const { llm, calls } = makeBridge({ rating });
    const res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, {
      toolModelCandidates: [CHEAP, STRONG],
    }));
    assert.deepEqual(calls.map((c) => c.kind), ["rate", "comprehend"], `${rating} escalates`);
    assert.equal(res.measuredComplexity, rating);
    await fs.rm(dir, { recursive: true, force: true });
  }

  const { dir, file } = await tmpFile("low.js", complexSource());
  const { llm, calls } = makeBridge({ rating: "low" });
  await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { toolModelCandidates: [CHEAP, STRONG] }));
  assert.deepEqual(calls.map((c) => c.kind), ["rate"], "low spends nothing extra");
  await fs.rm(dir, { recursive: true, force: true });
});
