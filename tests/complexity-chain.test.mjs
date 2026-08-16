/**
 * End-to-end proof of the complexity-powered read→write chain, driven by a
 * permission callback that replicates OpenWaggleMain's policy verbatim
 * (src/main/adapters/turing/turing-classic-run.ts): pin `authorModel` when a
 * mutating write/edit arrives rated `high`.
 *
 * This is the whole loop with no human in it:
 *
 *   read  → rated `high` → stronger model comprehends, analysis appended
 *         → rating recorded as the path's floor
 *   edit  → arrives pre-rated `high`, source `tool-measured`
 *         → host pins authorModel → stronger model authors the bytes on disk
 *
 * All offline: one stub bridge serves the loop turns and all three internal
 * calls (rate / comprehend / author), told apart by system prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LogStore, PermissionGate, OpenRouterBridge, readTool, editTool, runToolLoop } from "../dist/index.js";

const CHEAP = "test/cheap";
const STRONG = "test/strong";
const ANCHOR = "export function acquire(lock) { return lock.tryTake(); }";
const A_DRAFT = "export function acquire(lock) { return lock.take(); } // model A's naive draft";
const B_AUTHORED = "export function acquire(lock) {\n  // Model B: preserves the non-blocking contract\n  return lock.tryTake() ?? retry(lock);\n}";
const ANALYSIS = "L1: acquire() must stay non-blocking; take() blocks and deadlocks the queue.";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A file dense enough to clear the staged read's cheap trivia prefilter. */
function sourceWithAnchor() {
  const lines = [ANCHOR];
  for (let i = 0; i < 60; i++) {
    lines.push(`export function fn${i}(a, b) { return spin(a) ? release(b, ${i}) : retry(a, b); }`);
  }
  return lines.join("\n");
}

test("complexity chain: a read-measured `high` drives the edit's authoring model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "complexity-chain-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, sourceWithAnchor(), "utf8");

  const internalCalls = [];
  const llm = new OpenRouterBridge();

  // All three internal LLM calls land here. Rate/comprehend route on their system
  // prompts; the authoring edit routes on the user message (stable across prompt
  // rewrites) — an edit carries "TEXT TO REPLACE".
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const userMsg = ctx.messages?.[0];
    const userText = typeof userMsg?.content === "string"
      ? userMsg.content
      : (userMsg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const kind = /judge how hard a source file/i.test(sys)
      ? "rate"
      : /stronger model in a two-stage read/i.test(sys)
        ? "comprehend"
        : /TEXT TO REPLACE/.test(userText)
          ? "author"
          : "unknown";
    internalCalls.push({ kind, model: model.openRouterSlug ?? model.id });
    const text = kind === "rate"
      ? "RATING: high | WHY: non-blocking lock contract"
      : kind === "comprehend"
        ? ANALYSIS
        : B_AUTHORED;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  // Model A: read the file, then edit it with a naive draft, then stop.
  let turn = 0;
  let readResultText = "";
  llm.stream = async function* (_model, ctx) {
    const base = {
      role: "assistant", content: [], model: CHEAP, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
    yield { type: "start", partial: base };
    turn += 1;
    if (turn === 1) {
      yield {
        type: "done",
        message: { ...base, stopReason: "tool_use", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: file } }] },
      };
      return;
    }
    if (turn === 2) {
      // Capture what the read actually fed back into the conversation.
      const last = ctx.messages[ctx.messages.length - 1];
      readResultText = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      yield {
        type: "done",
        message: {
          ...base, stopReason: "tool_use",
          content: [{ type: "toolCall", id: "t2", name: "edit", arguments: { path: file, oldString: ANCHOR, newString: A_DRAFT } }],
        },
      };
      return;
    }
    yield { type: "done", message: { ...base, content: [{ type: "text", text: "done" }] } };
  };

  // ---- OpenWaggleMain's permission policy, verbatim ----
  const requests = [];
  const gate = new PermissionGate("bypass", async (request) => {
    requests.push(request);
    const authorModel =
      request.kind === "tool" &&
      request.mutates &&
      (request.name === "write" || request.name === "edit") &&
      request.complexityRating === "high"
        ? STRONG
        : undefined;
    return { allowed: true, ...(authorModel ? { authorModel } : {}) };
  });

  const result = await runToolLoop({
    task: "make acquire() non-blocking",
    userMessage: "make acquire() non-blocking",
    tools: [readTool, editTool],
    model: { id: CHEAP, openRouterSlug: CHEAP, input: ["text"], output: ["text"] },
    toolModelCandidates: [CHEAP, STRONG],
    llm,
    permission: gate,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    maxSteps: 8,
  });

  assert.equal(result.error, undefined);

  // 1. The read escalated: rated by the cheap model, comprehended by the strong one.
  assert.deepEqual(
    internalCalls.map((c) => `${c.kind}:${c.model}`),
    [`rate:${CHEAP}`, `comprehend:${STRONG}`, `author:${STRONG}`],
    "expected rate(cheap) → comprehend(strong) → author(strong)",
  );

  // 2. Model A saw the raw bytes AND the analysis — the analysis is additive, so
  //    A can still produce a byte-exact anchor for the edit that follows.
  assert.match(readResultText, /ANALYSIS OF THE FILE ABOVE/);
  assert.match(readResultText, /non-blocking/);
  assert.ok(readResultText.includes(ANCHOR), "raw file bytes must survive verbatim");

  // 3. The edit inherited the floor the READ measured — this is the hand-off.
  const editReq = requests.find((r) => r.name === "edit");
  assert.ok(editReq, "the edit must reach the gate");
  assert.equal(editReq.complexityRating, "high");
  assert.equal(editReq.complexitySource, "tool-measured");

  // 4. Model B's bytes are on disk; Model A's draft was discarded.
  const onDisk = await fs.readFile(file, "utf8");
  assert.ok(onDisk.includes("Model B: preserves the non-blocking contract"), "Model B must have authored the replacement");
  assert.ok(!onDisk.includes("model A's naive draft"), "Model A's draft must NOT be written");
  assert.ok(!onDisk.includes(ANCHOR), "the anchor must have been replaced");
  assert.equal(result.writtenPaths.includes(file), true);

  await fs.rm(dir, { recursive: true, force: true });
});

test("complexity chain: a `low` rating leaves both halves inert", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "complexity-chain-low-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, sourceWithAnchor(), "utf8");

  const internalCalls = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (model, ctx) => {
    const kind = /judge how hard a source file/i.test(ctx.systemPrompt ?? "") ? "rate" : "other";
    internalCalls.push(kind);
    return {
      role: "assistant",
      content: [{ type: "text", text: "RATING: low | WHY: flat helpers" }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  let turn = 0;
  llm.stream = async function* () {
    const base = {
      role: "assistant", content: [], model: CHEAP, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
    yield { type: "start", partial: base };
    turn += 1;
    if (turn === 1) {
      yield { type: "done", message: { ...base, stopReason: "tool_use", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: file } }] } };
      return;
    }
    if (turn === 2) {
      yield {
        type: "done",
        message: { ...base, stopReason: "tool_use", content: [{ type: "toolCall", id: "t2", name: "edit", arguments: { path: file, oldString: ANCHOR, newString: A_DRAFT } }] },
      };
      return;
    }
    yield { type: "done", message: { ...base, content: [{ type: "text", text: "done" }] } };
  };

  const requests = [];
  const gate = new PermissionGate("bypass", async (request) => {
    requests.push(request);
    const authorModel =
      request.mutates && (request.name === "write" || request.name === "edit") && request.complexityRating === "high"
        ? STRONG
        : undefined;
    return { allowed: true, ...(authorModel ? { authorModel } : {}) };
  });

  await runToolLoop({
    task: "tweak acquire()",
    userMessage: "tweak acquire()",
    tools: [readTool, editTool],
    model: { id: CHEAP, openRouterSlug: CHEAP, input: ["text"], output: ["text"] },
    toolModelCandidates: [CHEAP, STRONG],
    llm,
    permission: gate,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    maxSteps: 8,
  });

  // Rated once, never comprehended, never authored.
  assert.deepEqual(internalCalls, ["rate"]);
  const editReq = requests.find((r) => r.name === "edit");
  assert.notEqual(editReq.complexityRating, "high");

  // Model A's own draft lands on disk — the cheap path is untouched by all this.
  const onDisk = await fs.readFile(file, "utf8");
  assert.ok(onDisk.includes("model A's naive draft"));
  await fs.rm(dir, { recursive: true, force: true });
});
