/**
 * A step that runs out of its own step budget must NOT abandon the rest of the plan.
 *
 * The budget is PER STEP. Step 1 running long says nothing about whether step 2
 * can finish, so breaking out of the work loop on a budget truncation silently
 * dropped every remaining step of a plan the user had explicitly approved — the
 * run then summarized as if it were done.
 *
 * Only a user abort ("aborted") or a genuine hard error should stop the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LogStore,
  OpenRouterBridge,
  Orchestrator,
  PermissionGate,
  Registry,
  registerBuiltins,
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

/**
 * Which plan step this loop is currently on.
 *
 * Keyed on the LAST `ACTIVE STEP` marker across the whole conversation, not the
 * last user message: earlier steps' messages are threaded forward into later
 * steps, and the loop also injects its own wrap-up user message when the budget
 * runs low — so neither "first match" nor "last message" identifies the step.
 */
function activeStep(ctx) {
  const all = (ctx.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
    )
    .join("\n");
  return [...all.matchAll(/ACTIVE STEP: "([^"]+)"/g)].at(-1)?.[1] ?? "";
}


test("a step-budget truncation ends the hop honestly (v2: one work loop, no silent continuation)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-budget-"));
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });

  const llm = new OpenRouterBridge();
  let routerCalls = 0;
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "write_edit" : "summarise"}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "Ran until the budget ended." }]);
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "Two edits", summary: "",
          tasks: [
            { id: "t1", order: 1, title: "update alpha", summary: "", files: [], fileMutations: {}, complexity: "medium" },
            { id: "t2", order: 2, title: "update beta", summary: "", files: [], fileMutations: {}, complexity: "low" },
          ],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    return msg([{ type: "text", text: "ok" }]);
  };

  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "p1", name: "create_plan", arguments: { task: "update alpha and beta" } }], "tool_use") };
      return;
    }
    yield {
      type: "done",
      message: msg(
        [{ type: "toolCall", id: `w-${turn}`, name: "write", arguments: { path: path.join(tmp, `alpha-${turn}.txt`), content: `${turn}\n` } }],
        "tool_use",
      ),
    };
  };

  const orch = new Orchestrator({
    cwd: tmp, llm, registry: reg,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
  });

  const result = await orch.run("update alpha and beta", { maxStepsPerStep: 4 });

  // v2 semantics: the write_edit hop is ONE loop, so a truncation ends the run
  // HONESTLY (success=false + the step-budget error) rather than silently
  // continuing into the remaining plan tasks. What landed before the cut stays.
  assert.equal(result.success, false, "a truncated run must not look complete");
  assert.match(result.error ?? "", /step budget exhausted|budget/i, "the error names the budget");
  assert.equal(result.steps.length, 2, "both plan steps are still reported");
  assert.equal(result.steps[0].isCompleted, false, "step 1 is honestly unfinished");
  const wrote = await fs.readdir(tmp);
  assert.ok(wrote.some((f) => f.startsWith("alpha-")), "work that landed before the cut survives");
});
