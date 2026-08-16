/**
 * A long-running tool must be able to say what it is doing.
 *
 * Before this, a tool call was opaque between `tool_execution_start` and
 * `tool_execution_end`: a host could only render an indefinite spinner, so a tool
 * that waits on the user or polls a file looked identical to a wedged one. Tools
 * now get `ctx.progress()`, which emits `tool_execution_update` carrying the SAME
 * toolCallId so a host can render it against the right call.
 *
 * Offline: a scripted fake LLM calls one tool that reports progress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runToolLoop, PermissionGate, LogStore, Registry, resolveModel } from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant", content, api: "openrouter", provider: "openrouter",
    model: "fake/model", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/** A tool that reports progress, then finishes. */
function reportingTool(onExecute) {
  return {
    name: "slow_thing",
    description: "Reports progress while it works.",
    mutates: false,
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id, _args, ctx) {
      onExecute?.(ctx);
      ctx.progress?.({ stage: "one", message: "step one" });
      ctx.progress?.({ stage: "two", message: "waiting on you", waiting: true, percent: 0.5 });
      return { output: "done" };
    },
  };
}

/** Fake LLM: one tool call on the first turn, then a final answer. */
function fakeLLM(toolName) {
  return {
    resolveModel: (slug) => resolveModel(slug),
    async complete(_model, context) {
      const used = context.messages.some((m) => m.role === "toolResult");
      return used
        ? assistant([{ type: "text", text: "VERDICT: PASS" }])
        : assistant([{ type: "toolCall", id: "call-1", name: toolName, arguments: {} }], "toolUse");
    },
    async *stream(model, context) {
      const msg = await this.complete(model, context);
      yield { type: "start", partial: msg };
      yield { type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg };
    },
  };
}

/** Drive the v2 tool loop directly with the given tool + fake LLM. */
async function loopWithTool(tool, task) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tool-progress-"));
  const llm = fakeLLM(tool.name);
  const events = [];
  await runToolLoop({
    task,
    systemPrompt: "test loop",
    userMessage: task,
    tools: [tool],
    model: llm.resolveModel("fake/model"),
    llm,
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
    emit: (e) => events.push(e),
    cwd,
  });
  return { events, cwd };
}

test("progress from inside a tool reaches the host as tool_execution_update", async () => {
  const { events, cwd } = await loopWithTool(reportingTool(), "do the slow thing");

  const updates = events.filter((e) => e.type === "tool_execution_update");
  assert.equal(updates.length, 2, "both reports are emitted");

  // Correlated to the call, so a host can render them against the right card.
  assert.ok(updates.every((u) => u.toolCallId === "call-1"));
  assert.ok(updates.every((u) => u.toolName === "slow_thing"));

  assert.deepEqual(updates[0].progress, { stage: "one", message: "step one" });
  // `waiting` is the distinction a spinner cannot express: blocked on the user.
  assert.deepEqual(updates[1].progress, {
    stage: "two", message: "waiting on you", waiting: true, percent: 0.5,
  });

  // Ordering matters to a host reducer: start → updates → end.
  const order = events
    .filter((e) => e.type.startsWith("tool_execution_"))
    .map((e) => e.type);
  assert.deepEqual(order, [
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_update",
    "tool_execution_end",
  ]);

  await fs.rm(cwd, { recursive: true, force: true });
});

test("progress reported after the call settles is dropped, not emitted out of order", async () => {
  // A tool that leaks its progress callback past its own return — e.g. an
  // un-awaited timer. An update arriving after `tool_execution_end` would make a
  // host re-open a finished tool card, so the emitter is disarmed on settle.
  let leaked;
  const leakyTool = {
    name: "leaky_thing",
    description: "Keeps a reference to progress after returning.",
    mutates: false,
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id, _args, ctx) {
      leaked = ctx.progress;
      ctx.progress?.({ message: "during" });
      return { output: "done" };
    },
  };

  const { events, cwd } = await loopWithTool(leakyTool, "do the leaky thing");
  const before = events.filter((e) => e.type === "tool_execution_update").length;
  assert.equal(before, 1, "the in-call report is emitted");

  leaked?.({ message: "after the end" });
  const after = events.filter((e) => e.type === "tool_execution_update").length;
  assert.equal(after, before, "a post-settle report is dropped");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("a tool that never reports still runs — progress is optional", async () => {
  const silentTool = {
    name: "silent_thing",
    description: "Reports nothing.",
    mutates: false,
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      return { output: "quiet success" };
    },
  };

  const { events, cwd } = await loopWithTool(silentTool, "do the silent thing");

  assert.equal(events.filter((e) => e.type === "tool_execution_update").length, 0);
  const end = events.find((e) => e.type === "tool_execution_end");
  assert.ok(end, "the call still completes normally");
  assert.equal(end.isError, false);

  await fs.rm(cwd, { recursive: true, force: true });
});

test("ctx.progress is present for tools in the flat work loop too", async () => {
  // Two execution paths build a ToolContext (phase-runner and loop). A tool that
  // only gets `progress` on one of them would silently go quiet depending on the
  // run mode, so assert the context itself.
  let sawProgress;
  const { cwd } = await loopWithTool(
    reportingTool((ctx) => {
      sawProgress = typeof ctx.progress === "function";
    }),
    "do the slow thing",
  );
  assert.equal(sawProgress, true, "the work loop must supply ctx.progress");

  await fs.rm(cwd, { recursive: true, force: true });
});
