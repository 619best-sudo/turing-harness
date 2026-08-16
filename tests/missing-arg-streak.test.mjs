/**
 * Repeated empty/missing-required-argument tool calls must escalate.
 *
 * A model that emits `bash {}` over and over burns turns one rejected call at a
 * time: the rejections are interspersed with successful reads, so the all-error
 * stall guard never fires. Observed in a real run: 8 `bash {}` calls in a row.
 * The loop now tracks a per-tool streak of missing-arg rejections and, from the
 * 2nd onward, tells the model to re-issue ONE well-formed call or stop calling
 * tools. Run via `npm test`. Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  Registry,
  registerBuiltins,
  runToolLoop,
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
function tools() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg.allTools();
}

test("a streak of empty-arg bash calls escalates; a single miss does not", async () => {
  const llm = new OpenRouterBridge();
  let n = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    n += 1;
    if (n <= 3) {
      // Three empty bash calls in a row — each missing `command`.
      yield { type: "done", message: msg([{ type: "toolCall", id: `b-${n}`, name: "bash", arguments: {} }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const result = await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: tools(),
    model: { id: "x", openRouterSlug: "x" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: process.cwd(),
  });

  const texts = result.messages
    .filter((m) => m.role === "toolResult")
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text));

  // The first rejection is the plain missing-arg message.
  assert.match(texts[0], /missing required argument 'command'/);
  assert.doesNotMatch(texts[0], /in a row/, "the first miss does not escalate");

  // By the third consecutive empty call, the streak nudge is appended.
  const escalated = texts.find((t) => /3 times in a row/.test(t));
  assert.ok(escalated, "the streak escalated by the 3rd consecutive empty call");
  assert.match(escalated, /STOP calling tools/, "the escalation tells the model to stop or reformulate");
});

test("a well-formed call resets the streak", async () => {
  const llm = new OpenRouterBridge();
  let n = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    n += 1;
    if (n === 1) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "b-1", name: "bash", arguments: {} }], "tool_use") };
      return;
    }
    if (n === 2) {
      // A well-formed bash call resets the streak…
      yield { type: "done", message: msg([{ type: "toolCall", id: "b-2", name: "bash", arguments: { command: "echo hi" } }], "tool_use") };
      return;
    }
    if (n === 3) {
      // …so this next empty call is treated as a FIRST miss again (no escalation).
      yield { type: "done", message: msg([{ type: "toolCall", id: "b-3", name: "bash", arguments: {} }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const result = await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: tools(),
    model: { id: "x", openRouterSlug: "x" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: process.cwd(),
  });

  const empties = result.messages
    .filter((m) => m.role === "toolResult")
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text))
    .filter((t) => /missing required argument/.test(t));
  assert.equal(empties.length, 2);
  // Neither empty call escalated, because the streak reset between them.
  for (const t of empties) {
    assert.doesNotMatch(t, /in a row/);
  }
});
