/**
 * The escalation ladder for a tool that keeps failing:
 *
 *   1. bash fallback — a concrete shell recipe for that tool's own arguments
 *   2. ask the user   — only once the shell can't do it either
 *   3. honest stop    — only when there is no human to ask
 *
 * The harness must exhaust its own capability before spending the user's
 * attention, and must never stall out silently on a blocked operation.
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
  ToolFallbackAdvisor,
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

function allTools() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg.allTools();
}

/** Text of every user message in a context, joined. */
function userText(ctx) {
  return (ctx.messages ?? [])
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).map((c) => c.text ?? "")))
    .join("\n");
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

test("a repeatedly failing write gets a bash recipe for its own path, then succeeds through it", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-fb-write-"));
  // A directory where the file should be: `write` to it always fails.
  const blocked = path.join(tmp, "blocked");
  await fs.mkdir(blocked);

  const llm = new OpenRouterBridge();
  let writes = 0;
  let advice = "";
  let shelled = false;
  llm.stream = async function* (_model, ctx) {
    const text = userText(ctx);
    if (!advice && /has now failed/.test(text)) advice = text.slice(text.indexOf("NOTE: `write`"));
    yield { type: "start", partial: msg([]) };

    // Once advised, do what the note says: go through bash.
    if (advice && !shelled) {
      shelled = true;
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: "b-1", name: "bash", arguments: { command: `printf 'ok\\n' > ${tmp}/out.txt` } }],
          "tool_use",
        ),
      };
      return;
    }
    if (shelled) {
      yield { type: "done", message: msg([{ type: "text", text: "Wrote it with the shell." }]) };
      return;
    }

    writes += 1;
    yield {
      type: "done",
      message: msg(
        [{ type: "toolCall", id: `w-${writes}`, name: "write", arguments: { path: blocked, content: "x" } }],
        "tool_use",
      ),
    };
  };

  const result = await runToolLoop(loopInput(tmp, llm, allTools()));

  // Advice arrived after repeated failure — not on the first one.
  assert.ok(writes >= 2, `write was retried before advice, got ${writes}`);
  const injected = result.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? "")))
    .join("\n");
  assert.match(injected, /`write` has now failed \d+ times/);
  assert.match(injected, /Fall back to `bash`/);
  assert.match(injected, /cat > /, "the recipe is concrete");
  assert.ok(injected.includes(blocked), "the recipe names the real target path");
  // And the shell fallback actually accomplished the work.
  assert.equal(await fs.readFile(path.join(tmp, "out.txt"), "utf8"), "ok\n");

  await fs.rm(tmp, { recursive: true, force: true });
});

test("an MCP browser tool that keeps failing is escalated to the user once bash can't fix it", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-fb-mcp-"));

  // A stand-in for a playwright MCP tool whose server is down.
  const brokenMcp = {
    name: "browser_navigate",
    description: "navigate the browser",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    mutates: true,
    async execute() {
      return { output: "MCP call failed: server not connected", isError: true };
    },
  };

  const llm = new OpenRouterBridge();
  let calls = 0;
  llm.stream = async function* () {
    calls += 1;
    yield { type: "start", partial: msg([]) };
    yield {
      type: "done",
      message: msg(
        [{ type: "toolCall", id: `m-${calls}`, name: "browser_navigate", arguments: { url: "http://localhost:5173" } }],
        "tool_use",
      ),
    };
  };

  const result = await runToolLoop(loopInput(tmp, llm, [...allTools(), brokenMcp]));

  const injected = result.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? "")))
    .join("\n");
  // Rung 1: a browser-shaped tool gets browser-shaped shell advice.
  assert.match(injected, /Fall back to `bash`/);
  assert.match(injected, /curl -sS/);
  assert.ok(injected.includes("http://localhost:5173"), "advice names the real URL");
  // Rung 2: the model ignored it and kept failing, so it is told to ask the user.
  assert.match(injected, /call `ask_user_question`/);
  assert.match(injected, /what you already tried/);
  // The loop still ends (stall guard), rather than retrying forever.
  assert.match(result.error ?? "", /loop stalled/);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("advisor skips rungs the run cannot offer: no shell, no human channel", () => {
  const calls = [{ id: "1", name: "write", arguments: { path: "/x/y.ts" } }];
  const results = [{ toolCallId: "1", isError: true }];

  // No bash and no ask_user_question: straight to an honest stop, and it never
  // suggests a shell the run does not have.
  const bare = new ToolFallbackAdvisor();
  assert.deepEqual(bare.observe(calls, results, ["write", "read"]), []); // first failure: no advice yet
  const [only] = bare.observe(calls, results, ["write", "read"]);
  assert.equal(only.kind, "abandon");
  assert.doesNotMatch(only.note, /bash/);

  // A read-only shell cannot stand in for a write, so the write escalates to the
  // human instead of being handed an impossible recipe.
  const ro = new ToolFallbackAdvisor();
  ro.observe(calls, results, ["write", "bash_readonly", "ask_user_question"]);
  const [second] = ro.observe(calls, results, ["write", "bash_readonly", "ask_user_question"]);
  assert.equal(second.kind, "escalate");
  assert.match(second.note, /ask_user_question/);

  // A success clears the streak: a tool that works again is not escalated.
  const ok = new ToolFallbackAdvisor();
  ok.observe(calls, results, ["write", "bash"]);
  ok.observe(calls, [{ toolCallId: "1", isError: false }], ["write", "bash"]);
  assert.deepEqual(ok.observe(calls, results, ["write", "bash"]), []);
});
