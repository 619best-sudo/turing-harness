/**
 * The loop is completion-driven, not step-counted.
 *
 * 1. A model that keeps doing NEW, successful work runs as long as it needs —
 *    well past the old hardcoded caps (12 per step / 50 per loop) — and ends only
 *    when it stops calling tools. Nothing is truncated.
 * 2. A model that CANNOT converge still ends: repeating the same call, or failing
 *    every call, trips the stall guard, which nudges first and then stops with a
 *    reason naming the pattern (never a budget number).
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
  runToolLoop,
  isNonFatalLoopError,
  LOOP_STALLED,
} from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

function loopInput(tmp, llm, tools) {
  return {
    task: "t",
    userMessage: "go",
    tools,
    model: { id: "x", openRouterSlug: "x" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
  };
}

function tools() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg.allTools();
}

test("a long run of real work is never cut by a step cap", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-nocap-"));
  const WRITES = 80; // far beyond the old 12/50 defaults

  const llm = new OpenRouterBridge();
  let n = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (n < WRITES) {
      n += 1;
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: `w-${n}`, name: "write", arguments: { path: path.join(tmp, `f-${n}.txt`), content: `${n}\n` } }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "All done." }]) };
  };

  const result = await runToolLoop(loopInput(tmp, llm, tools()));

  assert.equal(result.error, undefined, "no truncation error");
  assert.equal(n, WRITES, "every step ran");
  assert.equal(result.finalText, "All done.", "the model got to finish with its own summary");
  assert.equal((await fs.readdir(tmp)).length, WRITES);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("a loop that repeats the same call is nudged, then stopped as stalled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-stall-"));
  const target = path.join(tmp, "same.txt");
  await fs.writeFile(target, "hello\n");

  const llm = new OpenRouterBridge();
  let turns = 0;
  let nudged = false;
  llm.stream = async function* (_model, ctx) {
    turns += 1;
    // The guard's nudge arrives as a user message before the stop.
    const text = (ctx.messages ?? [])
      .filter((m) => m.role === "user")
      .flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).map((c) => c.text ?? "")))
      .join("\n");
    if (/made no progress/.test(text)) nudged = true;
    yield { type: "start", partial: msg([]) };
    yield {
      type: "done",
      message: msg([{ type: "toolCall", id: `r-${turns}`, name: "read", arguments: { path: target } }], "tool_use"),
    };
  };

  const result = await runToolLoop(loopInput(tmp, llm, tools()));

  assert.match(result.error ?? "", new RegExp(LOOP_STALLED));
  assert.doesNotMatch(result.error ?? "", /budget/, "stalls are reported as stalls, not budgets");
  assert.ok(nudged, "the model was warned before the loop gave up");
  assert.ok(turns < 12, `stopped promptly, took ${turns} turns`);
  // A stall ends this loop but must not be treated as a broken run.
  assert.equal(isNonFatalLoopError(result.error), true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("a loop whose every tool call fails is stopped instead of retrying forever", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-fail-"));

  const llm = new OpenRouterBridge();
  let turns = 0;
  llm.stream = async function* () {
    turns += 1;
    yield { type: "start", partial: msg([]) };
    // A fresh path each turn, so this is NOT repetition — only failure.
    yield {
      type: "done",
      message: msg(
        [{ type: "toolCall", id: `r-${turns}`, name: "read", arguments: { path: path.join(tmp, `missing-${turns}.txt`) } }],
        "tool_use",
      ),
    };
  };

  const result = await runToolLoop(loopInput(tmp, llm, tools()));

  assert.match(result.error ?? "", new RegExp(`${LOOP_STALLED}.*failed`));
  assert.ok(turns < 12, `stopped promptly, took ${turns} turns`);

  await fs.rm(tmp, { recursive: true, force: true });
});
