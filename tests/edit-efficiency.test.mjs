/**
 * Efficiency + edit-correctness fixes drawn from a real app run
 * ("change sun color to blood yellow"):
 *
 *  1. read's deliverable snippets were fed through the attached-FILE cache, so
 *     write_edit's offset read came back as read's SUMMARY (the short-circuit
 *     ignores offset/limit) and the model fell back to `bash sed -n` to see
 *     its own lines — the same file was read 5+ times. Snippets now flow via
 *     `handoffSnippets`: authoring-context only, labeled; a `read` executes
 *     for real.
 *  2. An edit without newString escalated authoring; Model B burned 32k
 *     output tokens on reasoning and returned no content; the tool errored
 *     with no self-serve path. Now the runaway retries once at LOW effort,
 *     and the failure message names the escape (re-issue with newString).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Orchestrator,
  PermissionGate,
  OpenRouterBridge,
  LogStore,
  Registry,
  registerBuiltins,
  DEFAULT_CATEGORIZER_PROMPTS,
  buildCategorizerSystemPrompt,
  runToolLoop,
  createWriteTool,
  createEditTool,
} from "../dist/index.js";

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
const msg = (content) => ({
  role: "assistant", content, model: "test/a", api: "openrouter", provider: "test",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});
const toolMsg = (calls) => ({
  ...msg(calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))),
  stopReason: "tool_use",
});

// ---------------------------------------------------------------------------
// 1. handoff snippets never satisfy a read
// ---------------------------------------------------------------------------

test("a handoff snippet is not served to read — the hop gets real file bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eff-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, "Line A: #ff2200\nLine B: #cc0000\n");

  let seenToolResult = "";
  let turn = 0;
  const llm = new OpenRouterBridge();
  llm.stream = async function* (model, ctx) {
    if (turn > 0) {
      // The second turn's context carries the read's toolResult.
      seenToolResult = JSON.stringify(ctx.messages ?? []);
      yield { type: "start", partial: msg([]) };
      yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
      return;
    }
    turn += 1;
    yield { type: "start", partial: msg([]) };
    yield { type: "done", message: toolMsg([["r1", "read", { path: target, offset: 1, limit: 2 }]]) };
  };
  llm.complete = async () => msg([{ type: "text", text: "ok" }]);

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  await runToolLoop({
    task: "change the color",
    systemPrompt: "You are the WRITE/EDIT categorizer test stub.",
    userMessage: "edit the file",
    tools: [reg.getTool("read")],
    model: { id: "test/a", openRouterSlug: "test/a", input: ["text"] },
    llm,
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
    cwd: dir,
    handoffSnippets: [
      { path: target, content: "read pass: sun colors are red, change to blood yellow" },
    ],
    emit: () => {},
  });

  assert.ok(seenToolResult.includes("Line A: #ff2200"), "the read returned the file's real bytes");
  assert.ok(
    !seenToolResult.includes("returned from the handoff cache"),
    "the snippet was never served as file content",
  );
  assert.ok(
    !seenToolResult.includes("read pass: sun colors"),
    "no snippet text leaks into the read result",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. authoring runaway retries at low effort
// ---------------------------------------------------------------------------

function runawayBridge(secondReply) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"], reasoning: true });
  const calls = [];
  llm.complete = async (model, ctx, opts) => {
    calls.push({ opts });
    if (calls.length === 1) {
      // The runaway: 32k tokens of reasoning, zero content.
      return {
        ...msg([{ type: "thinking", thinking: "let me think about colors...".repeat(50) }]),
        stopReason: "length",
        usage: { ...zeroUsage(), output: 32000, totalTokens: 32000 },
      };
    }
    return secondReply(calls.length);
  };
  return { llm, calls };
}

/** Shared ctx for direct write/edit execution (the escalation requires an authorModel). */
const authorCtx = (dir, llm, task = "recolour the sun") => ({
  cwd: dir,
  log: () => {},
  llm,
  task,
  registry: new Registry(),
  authorModel: { id: "test/model-b", openRouterSlug: "test/model-b", input: ["text"], reasoning: true },
  authoringContext: { task },
});

test("reasoning-runaway retries once at LOW effort and the write lands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eff-"));
  const target = path.join(dir, "out.txt");
  const { llm, calls } = runawayBridge(() =>
    msg([{ type: "text", text: "written by the big model" }]));

  const write = createWriteTool(true); // authorOnly: Model B authors the bytes
  const res = await write.execute("w1", { path: target, complexity: "low", category: "code" }, authorCtx(dir, llm));

  assert.ok(!res.isError, `write should succeed: ${res.output}`);
  assert.equal(calls.length, 2, "exactly one retry");
  assert.equal(calls[1].opts.reasoning, "low", "the retry runs at LOW reasoning effort");
  assert.equal(await fs.readFile(target, "utf8"), "written by the big model");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a runaway that survives the low-effort retry fails with both attempts named", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eff-"));
  const target = path.join(dir, "out.txt");
  const { llm, calls } = runawayBridge(() =>
    msg([{ type: "thinking", thinking: "still thinking".repeat(50) }]));

  const write = createWriteTool(true);
  const res = await write.execute("w1", { path: target, complexity: "high", category: "code" }, authorCtx(dir, llm));

  assert.ok(res.isError, "both attempts empty ⇒ tool error");
  assert.match(res.output, /only reasoning and no content on both attempts/);
  assert.match(res.output, /LOW reasoning effort/);
  assert.match(res.output, /re-issue the write WITH explicit `content`/, "self-serve escape named");
  assert.equal(calls.length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the edit escalation failure names the newString self-serve path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eff-"));
  const target = path.join(dir, "page.html");
  await fs.writeFile(target, 'stroke="#cc0000"\n');
  const { llm } = runawayBridge(() =>
    msg([{ type: "thinking", thinking: "cannot stop thinking".repeat(50) }]));

  // authorOnly edit (the app's mode): the caller supplies only the anchor and
  // Model B authors the replacement — the exact call shape from the field run.
  const edit = createEditTool(true);
  const res = await edit.execute("e1", {
    path: target, oldString: 'stroke="#cc0000"', complexity: "low", category: "code",
  }, authorCtx(dir, llm));

  assert.ok(res.isError);
  assert.match(res.output, /re-issue the edit WITH an explicit `newString`/);
  assert.match(res.output, /no authoring model involved/);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. the prompt teaches anchors-from-file + supply-newString
// ---------------------------------------------------------------------------

test("write_edit teaches anchors from the file and newString on known replacements", () => {
  const p = buildCategorizerSystemPrompt(
    { id: "write_edit", systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit },
    ["read", "write", "edit", "create_plan", "bash", "deliver"],
  );
  assert.match(p, /ANCHORS COME FROM THE FILE, NOT THE SUMMARY/);
  assert.match(p, /SUPPLY\s+`newString` whenever you know the replacement/);
  assert.match(p, /wasteful for a one-line change/);
});
