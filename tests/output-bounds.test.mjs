/**
 * No single tool result may be large enough to end the run.
 *
 * The failure this closes, from a real run: a `grep` with no `path` recursed a
 * whole repo — node_modules included — and returned 11.3 MB. That was appended
 * to the conversation verbatim, and the NEXT request came back
 * `OpenRouter stream failed (413)` — Payload Too Large. Ten tool calls, every
 * one of them successful, no stall, no step cap: the run simply died of one
 * unbounded result.
 *
 * Three layers now, deliberately overlapping:
 *   1. `grep` caps matches at the source and skips vendored trees.
 *   2. `bash` caps its own output.
 *   3. the LOOP caps every tool result, including from MCP tools we do not own.
 *
 * Layer 3 is the one that matters most: the tools that can do this are not only
 * ours.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CODING_TOOLS, LogStore, OpenRouterBridge, PermissionGate, runToolLoop } from "../dist/index.js";

const grepTool = CODING_TOOLS.find((t) => t.name === "grep");
const bashTool = CODING_TOOLS.find((t) => t.name === "bash");

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const msg = (content, stopReason = "stop") => ({
  role: "assistant", content, model: "x", api: "openrouter",
  provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
});

// ---------------------------------------------------------------------------
// 3. The loop's own ceiling — the general safety net.
// ---------------------------------------------------------------------------

test("a huge result from ANY tool is bounded before it enters the conversation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-"));
  // Stands in for an MCP tool we do not control.
  const firehose = {
    name: "firehose",
    description: "returns far too much",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "BEGIN\n" + "x".repeat(5_000_000) + "\nEND" };
    },
  };

  let sentToModel = 0;
  const llm = new OpenRouterBridge();
  let done = false;
  llm.stream = async function* (_m, ctx) {
    sentToModel = JSON.stringify(ctx.messages).length;
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "f1", name: "firehose", arguments: {} }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  const result = await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [firehose],
    model: { id: "m", openRouterSlug: "m" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
  });

  const toolMsg = result.messages.find((m) => m.role === "toolResult");
  const text = toolMsg.content.map((c) => c.text).join("");
  assert.ok(text.length < 30_000, `bounded to ${text.length} chars`);
  assert.ok(sentToModel < 200_000, `context stayed small (${sentToModel} chars)`);
});

test("the truncation notice tells the model it is NOT seeing everything", async () => {
  // Silence is the dangerous part: a model that gets a partial result and is not
  // told will act as though it saw the whole thing.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-notice-"));
  const firehose = {
    name: "firehose",
    description: "x",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "HEAD\n" + "y".repeat(1_000_000) + "\nTAIL" };
    },
  };
  const llm = new OpenRouterBridge();
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "f1", name: "firehose", arguments: {} }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };
  const result = await runToolLoop({
    task: "t", userMessage: "go", tools: [firehose],
    model: { id: "m", openRouterSlug: "m" }, llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(), emit: () => {}, cwd: dir,
  });
  const text = result.messages.find((m) => m.role === "toolResult").content.map((c) => c.text).join("");
  assert.match(text, /characters omitted from the middle/);
  assert.match(text, /You are NOT seeing the whole/);
  assert.match(text, /Narrow the call/);
  // Head and tail both survive — the ends are where the meaning is.
  assert.match(text, /^HEAD/);
  assert.match(text, /TAIL$/);
});

// ---------------------------------------------------------------------------
// 1. grep at the source.
// ---------------------------------------------------------------------------

test("grep skips vendored trees instead of searching them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-grep-"));
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "const chottu_link = 1\n");
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "b.js"), "chottu_link\n".repeat(500));

  const res = await grepTool.execute("g1", { pattern: "chottu_link" }, { cwd: dir, log: () => {} });
  assert.match(res.output, /src\/a\.ts/, "project code is searched");
  assert.doesNotMatch(res.output, /node_modules/, "vendored code is not");
});

test("grep truncation says there are more matches, so 'all uses' is not assumed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-grep2-"));
  await fs.writeFile(path.join(dir, "big.txt"), "needle here\n".repeat(80_000));
  const res = await grepTool.execute("g1", { pattern: "needle" }, { cwd: dir, log: () => {} });
  assert.ok(res.output.length < 40_000, `capped to ${res.output.length}`);
  assert.match(res.output, /There are MORE\s+matches than this/);
});

test("an empty grep is still a result, not an error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-grep3-"));
  await fs.writeFile(path.join(dir, "a.txt"), "nothing\n");
  const res = await grepTool.execute("g1", { pattern: "zzz-absent" }, { cwd: dir, log: () => {} });
  assert.equal(res.output, "(no matches)");
  assert.ok(!res.isError, "no-match must not read as a failed search");
});

// ---------------------------------------------------------------------------
// 2. bash.
// ---------------------------------------------------------------------------

test("bash keeps the head and the tail of a large output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-bash-"));
  const res = await bashTool.execute(
    "b1",
    { command: `echo FIRSTLINE; for i in $(seq 1 60000); do echo "filler line $i"; done; echo LASTLINE` },
    { cwd: dir, log: () => {} },
  );
  assert.ok(res.output.length < 40_000, `capped to ${res.output.length}`);
  assert.match(res.output, /FIRSTLINE/, "head kept — what it started doing");
  assert.match(res.output, /LASTLINE/, "tail kept — the exit summary");
  assert.match(res.output, /omitted from the middle/);
});

test("small outputs are untouched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bounds-bash2-"));
  const res = await bashTool.execute("b1", { command: "echo hello" }, { cwd: dir, log: () => {} });
  assert.equal(res.output, "hello");
});
