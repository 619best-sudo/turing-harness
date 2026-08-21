/**
 * The run-scoped comprehension store — "analyse once per file, inject into the
 * tool chain".
 *
 * 1. A file a run has already handed to a stronger model is NEVER re-rated or
 *    re-comprehended for the same bytes: one rater + one comprehension per file
 *    per run, no matter how many windows or hops touch it afterwards.
 * 2. The analysis is injected ONCE PER DRIVER CONTEXT: within a loop a re-read
 *    gets a reuse note; a LATER loop's first read (e.g. write_edit after read)
 *    re-injects the full analysis from the store at zero model cost — the
 *    reasoning becomes tool-chain state, not a one-shot text blob.
 * 3. A `low` verdict is remembered so the file is never re-rated; a changed file
 *    invalidates and re-comprehends; a huge file (over the full-send cap) unions
 *    windowed comprehensions and honors a per-file cap (never a third).
 *
 * Run via: npm test. All offline — a stub bridge stands in for the model calls.
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
  Registry,
  registerBuiltins,
  readTool,
  runToolLoop,
} from "../dist/index.js";
import { ComprehensionStore } from "../dist/tools/builtin/comprehension.js";

const CHEAP = "test/cheap";
const STRONG = "test/strong";
const FULL_COMPREHENSION_MAX_CHARS = 80_000;

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

/** Dense but small enough that the whole file is sent to the analyst (full coverage). */
function complexSource() {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`export function fn${i}(a, b) { return acquire(a) ? release(b, ${i}) : retry(a, b); }`);
  }
  return lines.join("\n");
}

/** A file larger than the full-send cap, so comprehension is windowed. */
function hugeSource(lines = 6000) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(`export const value_${i} = acquire(compute(${i}, "payload-${i}-abcdefghijklmnop")) ? release(${i}) : retry(${i});`);
  }
  return out.join("\n");
}

async function tmpFile(name, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-store-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, contents, "utf8");
  return { dir, file };
}

/** Stub bridge for the read tool's two internal calls (rate + comprehend). */
function makeBridge({ rating = "high", why = "lock-free retry loop", analysis = "L3: acquire() may reenter; callers must not hold a lock across it." } = {}) {
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
    toolModelCandidates: [CHEAP, STRONG],
    task: "rename the export",
    ...extra,
  };
}

test("one file is comprehended once across many windowed reads, with a reuse note after", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const store = new ComprehensionStore();
  const { llm, calls } = makeBridge();

  // First read: the whole file (a window would trip the trivial prefilter and
  // never escalate). Full coverage is recorded, analysis emitted.
  let res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "categorizer:read" }));
  assert.match(res.output, /ANALYSIS OF THE FILE ABOVE/);
  assert.deepEqual(calls.map((c) => c.kind), ["rate", "comprehend"]);

  // Second read: a DIFFERENT window of the same unchanged file.
  res = await readTool.execute("c2", { path: file, offset: 30, limit: 8 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "categorizer:read" }));
  // No additional model calls: the whole-file analysis already answers this window.
  assert.equal(calls.length, 2, "no re-rate, no re-comprehension");
  // Same loop ⇒ a reuse note, NOT the analysis repeated.
  assert.match(res.output, /covers EVERY part of the file/);
  assert.ok(!res.output.includes("may reenter"), "analysis not re-emitted in the same loop");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a later loop's first read re-injects the analysis from the store, zero model calls", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const store = new ComprehensionStore();
  const { llm, calls } = makeBridge();

  // Hop 1 (read) comprehends the file.
  await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "categorizer:read" }));
  assert.equal(calls.length, 2);

  // Hop 2 (write_edit) has a FRESH driver whose context never contained the read
  // hop's transcript. Its first read of the file re-injects the full analysis
  // from the store — the reasoning reaches the tool chain — at zero model cost.
  const res = await readTool.execute("c2", { path: file, offset: 5, limit: 6 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "categorizer:write_edit" }));
  assert.equal(calls.length, 2, "no re-rate, no re-comprehension across hops");
  assert.match(res.output, /ANALYSIS OF THE FILE ABOVE/);
  assert.match(res.output, /may reenter/, "full analysis re-injected for the new driver");

  // A second read inside hop 2 is back to the reuse note (one injection per loop).
  const res2 = await readTool.execute("c3", { path: file, offset: 40, limit: 8 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "categorizer:write_edit" }));
  assert.match(res2.output, /covers EVERY part of the file/);
  assert.ok(!res2.output.includes("may reenter"), "not re-emitted twice in the same loop");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a low-rated file is never re-rated", async () => {
  const { dir, file } = await tmpFile("plain.js", complexSource());
  const store = new ComprehensionStore();
  const { llm, calls } = makeBridge({ rating: "low", why: "flat helpers" });

  let res = await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 1, "only a rating call");
  assert.ok(!res.output.includes("ANALYSIS"), "plain bytes, no analysis");

  res = await readTool.execute("c2", { path: file, offset: 20, limit: 8 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 1, "the stored low verdict is reused, never re-rated");
  assert.ok(!res.output.includes("ANALYSIS"), "still plain bytes");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a changed file invalidates the analysis and re-comprehends", async () => {
  const { dir, file } = await tmpFile("queue.js", complexSource());
  const store = new ComprehensionStore();
  const { llm, calls } = makeBridge();

  await readTool.execute("c1", { path: file }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 2);

  // Mutate the file (a write landed on it) → the stored hash no longer matches.
  await fs.writeFile(file, complexSource() + "\nexport const added = 1;\n", "utf8");
  const res = await readTool.execute("c2", { path: file }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 4, "the stale analysis was not reused — re-rated and re-comprehended");
  assert.match(res.output, /ANALYSIS OF THE FILE ABOVE/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a huge file unions windowed comprehensions and honors the per-file cap", async () => {
  const { dir, file } = await tmpFile("big.js", hugeSource());
  const store = new ComprehensionStore(2); // hard cap: never a third comprehension
  const { llm, calls } = makeBridge();

  // First window → comprehend.
  await readTool.execute("c1", { path: file, offset: 1, limit: 40 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 2, "rate + first window comprehension");
  // Second window (different) → one more comprehension (cap 2); the rating for
  // these bytes is already held, so the rater is not paid again.
  await readTool.execute("c2", { path: file, offset: 200, limit: 40 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 3, "rate + two window comprehensions");
  // Third window → budget exhausted: bytes + reuse note, never a third comprehension.
  const res = await readTool.execute("c3", { path: file, offset: 400, limit: 40 }, ctxFor(llm, dir, { comprehensionStore: store, loopLabel: "l" }));
  assert.equal(calls.length, 3, "the per-file comprehension cap held");
  assert.match(res.output, /covers EVERY part of the file/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("the loop re-visit advisor warns once when the driver re-reads a comprehended file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-revisit-"));
  const file = path.join(tmp, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");
  const store = new ComprehensionStore();

  const llm = new OpenRouterBridge();
  // The two internal read-tool calls (rate + comprehend) use `complete`.
  llm.complete = async (model) => ({
    role: "assistant",
    content: [{ type: "text", text: "high ? 'RATING: high | WHY: concurrency' : 'L3 may reenter'" }],
    model: model.openRouterSlug ?? model.id,
    api: "openrouter", provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });

  const seenNotes = [];
  let turn = 0;
  llm.stream = async function* (model, ctx) {
    yield { type: "start", partial: { role: "assistant", content: [] } };
    turn += 1;
    if (turn === 1) {
      // First read (full): comprehends the file.
      yield { type: "done", message: msg([{ type: "toolCall", id: "r1", name: "read", arguments: { path: file } }], "tool_use") };
      return;
    }
    if (turn === 2) {
      // Re-visit: a WINDOW of the already-comprehended file.
      yield { type: "done", message: msg([{ type: "toolCall", id: "r2", name: "read", arguments: { path: file, offset: 3, limit: 5 } }], "tool_use") };
      return;
    }
    // Final turn: no tools. Capture any injected ADVISOR note (the read tool's
    // reuse note also mentions "whole-file expert analysis", so match the
    // advisor's distinctive wording).
    for (const m of ctx.messages) {
      const text = Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        : "";
      if (text.toLowerCase().includes("do not keep reading windows of this file")) seenNotes.push(text);
    }
    yield { type: "done", message: msg([{ type: "text", text: "done." }]) };
  };

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const tools = reg.allTools();
  const result = await runToolLoop({
    task: "t",
    userMessage: "go",
    tools,
    model: { id: "x", openRouterSlug: "x" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
    toolModelCandidates: [CHEAP, STRONG],
    sharedComprehension: store,
    label: "categorizer:read",
  });

  assert.equal(seenNotes.length, 1, "the re-visit advisor fired exactly once");
  assert.match(seenNotes[0], /whole-file expert analysis/);
  assert.match(seenNotes[0], /do not keep reading windows/i);
  assert.equal(result.error, undefined);

  await fs.rm(tmp, { recursive: true, force: true });
});

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

{
  // Guard the huge-source constant against drifting unknowingly past/under the cap.
  assert.ok(hugeSource().length > FULL_COMPREHENSION_MAX_CHARS, "hugeSource must exceed the full-send cap");
}

test("all three read shapes — full file, one part, several parts — stay correct on one comprehension", async () => {
  // The user-facing contract for the staged read. Three shapes must all work,
  // and all three must be served from the SAME single comprehension of the file:
  //   1. read the COMPLETE file,
  //   2. read ONE part of the file (a window),
  //   3. read DIFFERENT parts of the SAME file (several windows).
  // The analysis is produced ONCE; every later read returns its OWN exact bytes
  // (window slicing is preserved, never substituted or dropped) plus a reuse
  // note, with no re-rate and no re-comprehension.
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push(`export function fn${i}(a, b) { return acquire(a) ? release(b, ${i}) : retry(a, b); }`);
  const { dir, file } = await tmpFile("modes.js", lines.join("\n"));
  const store = new ComprehensionStore();
  const { llm, calls } = makeBridge();
  const ctx = (label) => ({ ...ctxFor(llm, dir, { comprehensionStore: store, loopLabel: label }) });

  // Shape 1 — the COMPLETE file.
  const full = await readTool.execute("c1", { path: file }, ctx("l"));
  assert.match(full.output, /ANALYSIS OF THE FILE ABOVE/, "full read emits the analysis");
  assert.match(full.output, /fn79/, "full read returns the whole file");
  assert.equal(calls.length, 2, "one rate + one comprehend for the full read");

  // Shape 2 — ONE part of the file (a single window). Returns ITS bytes + note.
  const part = await readTool.execute("c2", { path: file, offset: 20, limit: 3 }, ctx("l"));
  assert.match(part.output, /fn19/, "starts at the requested offset");
  assert.match(part.output, /fn21/, "spans the requested limit");
  assert.ok(!/fn50/.test(part.output), "does not return bytes outside the window");
  assert.match(part.output, /covers EVERY part of the file/, "reuse note, not a second analysis");
  assert.equal(calls.length, 2, "no re-comprehension for one part");

  // Shape 3 — DIFFERENT parts of the same file (several windows).
  const partB = await readTool.execute("c3", { path: file, offset: 55, limit: 4 }, ctx("l"));
  assert.match(partB.output, /fn54/, "second window returns its own bytes");
  assert.ok(!/fn20/.test(partB.output), "second window is not confused with the first");
  const partC = await readTool.execute("c4", { path: file, offset: 1, limit: 2 }, ctx("l"));
  assert.match(partC.output, /fn0/, "third window returns its own bytes");
  assert.match(partC.output, /covers EVERY part of the file/, "still the reuse note");
  assert.equal(calls.length, 2, "several parts still cost a single comprehension");

  await fs.rm(dir, { recursive: true, force: true });
});

test("the re-visit advisor also fires on a FULL re-read of a comprehended file", async () => {
  // A full re-read of an already-comprehended file returns the same bytes and
  // the same analysis — just as redundant as a window. The advisor must catch it
  // too, without nagging the turn that FIRST emitted the analysis.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-revisit-full-"));
  const file = path.join(tmp, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");
  const store = new ComprehensionStore();

  const llm = new OpenRouterBridge();
  llm.complete = async (model) => ({
    role: "assistant",
    content: [{ type: "text", text: "RATING: high | WHY: concurrency" }],
    model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  const seenNotes = [];
  let turn = 0;
  llm.stream = async function* (model, ctx) {
    yield { type: "start", partial: msg([]) };
    turn += 1;
    if (turn === 1) {
      // FIRST read (full): emits the analysis. Must NOT be nagged.
      yield { type: "done", message: msg([{ type: "toolCall", id: "r1", name: "read", arguments: { path: file } }], "tool_use") };
      return;
    }
    if (turn === 2) {
      // FULL re-read of the same file.
      yield { type: "done", message: msg([{ type: "toolCall", id: "r2", name: "read", arguments: { path: file } }], "tool_use") };
      return;
    }
    for (const m of ctx.messages) {
      const text = Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
      if (text.toLowerCase().includes("re-reading it returns the same bytes")) seenNotes.push(text);
    }
    yield { type: "done", message: msg([{ type: "text", text: "done." }]) };
  };

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const result = await runToolLoop({
    task: "t", userMessage: "go", tools: reg.allTools(),
    model: { id: "x", openRouterSlug: "x" }, llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(), emit: () => {}, cwd: tmp,
    toolModelCandidates: [CHEAP, STRONG], sharedComprehension: store, label: "categorizer:read",
  });
  assert.equal(seenNotes.length, 1, "the full re-read was flagged once");
  assert.match(seenNotes[0], /re-reading it returns the same bytes/i);
  assert.equal(result.error, undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("the read-completion nudge fires once the loop has read many distinct files", async () => {
  // Opening NEW files is what still costs after comprehension; past a threshold
  // of distinct files with no deliver/write, the driver is told to wrap up.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-complete-"));
  const files = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(tmp, `f${i}.js`);
    await fs.writeFile(f, complexSource(), "utf8");
    files.push(f);
  }
  const store = new ComprehensionStore();
  const llm = new OpenRouterBridge();
  llm.complete = async (model) => ({
    role: "assistant",
    content: [{ type: "text", text: "RATING: high | WHY: concurrency" }],
    model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  const seenNotes = [];
  let turn = 0;
  llm.stream = async function* (model, ctx) {
    yield { type: "start", partial: msg([]) };
    turn += 1;
    if (turn <= files.length) {
      yield { type: "done", message: msg([{ type: "toolCall", id: `r${turn}`, name: "read", arguments: { path: files[turn - 1] } }], "tool_use") };
      return;
    }
    for (const m of ctx.messages) {
      const text = Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
      if (text.toLowerCase().includes("you have read 6 distinct files")) seenNotes.push(text);
    }
    yield { type: "done", message: msg([{ type: "text", text: "done." }]) };
  };
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const result = await runToolLoop({
    task: "t", userMessage: "go", tools: reg.allTools(),
    model: { id: "x", openRouterSlug: "x" }, llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(), emit: () => {}, cwd: tmp,
    toolModelCandidates: [CHEAP, STRONG], sharedComprehension: store, label: "categorizer:read",
  });
  assert.equal(seenNotes.length, 1, "the completion nudge fired exactly once");
  assert.match(seenNotes[0], /you have read 6 distinct files/);
  assert.match(seenNotes[0], /deliver now|make the change/);
  assert.equal(result.error, undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});
