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

test("a step-budget truncation in step 1 still runs the remaining steps", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-budget-"));
  const betaMarker = path.join(tmp, "beta-ran.txt");

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });

  const llm = new OpenRouterBridge();
  llm.complete = async (_model, ctx) => {
    // The intent router must classify this as real work, not chat.
    if (/router at the front/.test(ctx.systemPrompt ?? "")) return msg([{ type: "text", text: "TASK" }]);
    return msg([{ type: "text", text: "Ran the plan." }]);
  };

  let planned = false;
  let alphaTurns = 0;
  let betaWrote = false;

  llm.stream = async function* (_model, ctx) {
    yield { type: "start", partial: msg([]) };

    if (!planned) {
      planned = true;
      const plan = {
        plans: [
          {
            id: "p1",
            title: "Two independent edits",
            summary: "",
            tasks: [
              { id: "t1", order: 1, title: "update alpha", summary: "", files: [], fileMutations: {}, complexity: "medium" },
              { id: "t2", order: 2, title: "update beta", summary: "", files: [], fileMutations: {}, complexity: "low" },
            ],
          },
        ],
        executionOrder: ["p1"],
      };
      yield { type: "done", message: msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]) };
      return;
    }

    const step = activeStep(ctx);

    // Step 1 never stops calling tools — it even ignores the loop's wrap-up
    // nudge — so it burns its whole budget and truncates. Each write targets a
    // fresh path: the loop dedups identical read-only calls, and a deduped call
    // would not consume budget the way a real one does.
    if (step === "update alpha") {
      alphaTurns += 1;
      yield {
        type: "done",
        message: msg(
          [{
            type: "toolCall",
            id: `alpha-${alphaTurns}`,
            name: "write",
            arguments: { path: path.join(tmp, `alpha-${alphaTurns}.txt`), content: `${alphaTurns}\n` },
          }],
          "tool_use",
        ),
      };
      return;
    }

    // Step 2 does one real write and then finishes cleanly.
    if (step === "update beta" && !betaWrote) {
      betaWrote = true;
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: "beta-1", name: "write", arguments: { path: betaMarker, content: "beta\n" } }],
          "tool_use",
        ),
      };
      return;
    }

    yield { type: "done", message: msg([{ type: "text", text: "Done." }]) };
  };

  const orch = new Orchestrator({
    cwd: tmp,
    llm,
    registry: reg,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
  });

  // A small budget so step 1 truncates quickly.
  const result = await orch.run("update alpha and beta", { maxStepsPerStep: 3 });

  // Both steps must be attempted — this is the regression.
  assert.equal(result.steps.length, 2, "step 2 must still run after step 1 truncates");
  assert.deepEqual(
    result.steps.map((s) => s.title),
    ["update alpha", "update beta"],
  );

  // Step 1 is reported honestly as unfinished, with the reason.
  assert.equal(result.steps[0].isCompleted, false);
  assert.match(result.steps[0].error ?? "", /step budget exhausted/);

  // Step 2 actually did its work.
  assert.equal(result.steps[1].isCompleted, true);
  assert.equal(await fs.readFile(betaMarker, "utf8"), "beta\n");

  await fs.rm(tmp, { recursive: true, force: true });
});
