// Smoke check: does the v2 categorizer chain run end-to-end with a stub LLM?
// Scenario: "update the service file" → router picks write_edit → create_plan
// → write → deliver → router summarises → summary turn.
//   node tests/smoke-run.test.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, PermissionGate, OpenRouterBridge, LogStore, Registry, registerBuiltins } from "../dist/index.js";

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-smoke-"));
const target = path.join(tmp, "service.ts");
await fs.writeFile(target, "old-content\n");

const reg = new Registry();
registerBuiltins(reg, { logStore: new LogStore() });

const llm = new OpenRouterBridge();
let routerCalls = 0;
let planTurnDone = false;
let writeTurnDone = false;

// complete(): router turns, create_plan's internal planner call, the summary.
llm.complete = async (_model, ctx) => {
  const sys = ctx.systemPrompt ?? "";
  if (/CATEGORIZER ROUTER/.test(sys)) {
    routerCalls++;
    // First routing: the work pass. After it: nothing left to do.
    const text = routerCalls <= 1 ? "CATEGORY: write_edit" : "CATEGORY: summarise";
    return { role: "assistant", content: [{ type: "text", text }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
  }
  if (/breaking a task into an ordered implementation plan/.test(sys)) {
    // create_plan's planner call.
    const plan = {
      plans: [{
        id: "p1", title: "The change", summary: "x",
        tasks: [{
          id: "t1", order: 1, title: "update service", summary: "x",
          files: [target], fileMutations: { [target]: "edit" }, complexity: "high",
        }],
      }],
      executionOrder: ["p1"],
    };
    return { role: "assistant", content: [{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
  }
  // Summary turn.
  return { role: "assistant", content: [{ type: "text", text: "I updated the service file as requested." }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
};

// stream(): drives the write_edit categorizer's loop turns.
llm.stream = async function* (_model, ctx) {
  const mk = (content, stopReason) => ({
    type: "done",
    message: { role: "assistant", content, model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason, timestamp: 0 },
  });
  yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
  // The verify hop the chain adds after a write (route-policy FLOOR 0): this
  // stub has no app to run, so it delivers an honest empty report. The
  // observe-first guard refuses the first one and passes the re-issue.
  if (/ACTIVITY INSPECT/.test(ctx.systemPrompt ?? "")) {
    yield mk([{ type: "toolCall", id: "qa", name: "deliver", arguments: { writes: [], logPaths: [], findings: "nothing to run in this smoke stub" } }], "tool_use");
    return;
  }
  // Turn 1: create_plan (always first in write_edit).
  if (!planTurnDone) {
    planTurnDone = true;
    yield mk([{ type: "toolCall", id: "c0", name: "create_plan", arguments: { task: "update the service file" } }], "tool_use");
    return;
  }
  // Turn 2: the write itself.
  if (!writeTurnDone) {
    writeTurnDone = true;
    yield mk([{ type: "toolCall", id: "c1", name: "write", arguments: { path: target, content: "new-content\n" } }], "tool_use");
    return;
  }
  // Turn 3: deliver the write report (terminal).
  yield mk([{ type: "toolCall", id: "c2", name: "deliver", arguments: { writes: [{ tool: "write", path: target, summary: "updated" }], notes: "done" } }], "tool_use");
};

const orch = new Orchestrator({
  cwd: tmp, llm, registry: reg,
  permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
  logStore: new LogStore(),
});

const result = await orch.run("update the service file");
const onDisk = await fs.readFile(target, "utf8");

test("smoke: the categorizer chain completes a write task", () => {
  assert.equal(result.success, true, `success (error=${result.error})`);
  assert.equal(result.route, "task");
  assert.equal(result.steps.length, 1, "one plan step recorded");
  assert.equal(result.steps[0]?.isCompleted, true, "step isCompleted true");
  assert.equal(result.steps[0]?.complexity, "high", "step complexity high");
  assert.equal(onDisk, "new-content\n", "file written");
  assert.ok(typeof result.summary === "string" && result.summary.length > 0, "summary present");
});
