/**
 * Plan-first in write_edit, taught at every layer the model reads:
 *
 *  - the SYSTEM PROMPT states THE FLOW with the one-line-change case,
 *  - the TOOL DESCRIPTIONS the model chooses from state it too (the stock
 *    create_plan description licenses skipping the plan for a single-step
 *    change — in this categorizer it is rewritten to say FIRST, ALWAYS),
 *  - the runtime GUARD still refuses an edit issued before the plan, with a
 *    message that says nothing is lost and the plan may be a single step.
 *
 * Reproduces the field failure: a model that found its line and fired `edit`
 * immediately. The guard catches it; the prompt + descriptions now prevent
 * the wasted turn.
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
  writeTool,
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

/**
 * Router picks write_edit then summarises. The write_edit loop reproduces the
 * field failure: edit BEFORE create_plan (refused), then the plan, then the
 * same edit again (lands). Captures the tool defs and system prompt of the
 * write_edit hop, plus the toolResult fed back after the refused edit.
 */
function planFirstBridge(target) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  const seen = { writeToolDefs: null, writeSys: "", refusedResult: "", planRan: false };
  let routerCalls = 0;
  let turn = 0;

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      const order = ["write_edit", "summarise"];
      return msg([{ type: "text", text: `CATEGORY: ${order[Math.min(routerCalls - 1, 1)]}` }]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      seen.planRan = true;
      const plan = {
        plans: [{
          id: "p1", title: "The change", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update title", summary: "x",
            files: [target], fileMutations: { [target]: "edit" }, complexity: "low" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "Changed the title." }]);
    return msg([{ type: "text", text: "ok" }]);
  };

  llm.stream = async function* (model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    if (/WRITE\/EDIT categorizer/.test(sys)) {
      if (!seen.writeToolDefs) {
        seen.writeToolDefs = ctx.tools ?? [];
        seen.writeSys = sys;
      }
      const editArgs = { path: target, oldString: "Title: nnnn", newString: "Title: Delete Account" };
      const n = turn++;
      if (n === 0) {
        yield { type: "start", partial: msg([]) };
        yield { type: "done", message: toolMsg([["e1", "edit", editArgs]]) };
        return;
      }
      // Turn 2's context carries the toolResult of the refused edit.
      const results = JSON.stringify(ctx.messages?.map((m) => m.content ?? "") ?? "");
      if (results.includes("create_plan comes FIRST")) seen.refusedResult = results;
      if (n === 1) {
        yield { type: "start", partial: msg([]) };
        yield { type: "done", message: toolMsg([["p1", "create_plan", { task: "retitle" }]]) };
        return;
      }
      if (n === 2) {
        yield { type: "start", partial: msg([]) };
        yield { type: "done", message: toolMsg([["e2", "edit", editArgs]]) };
        return;
      }
      yield { type: "start", partial: msg([]) };
      yield { type: "done", message: toolMsg([["d1", "deliver", {
        writes: [{ tool: "edit", path: target, summary: "retitle" }], notes: "done",
      }]]) };
      return;
    }
    yield { type: "start", partial: msg([]) };
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  return { llm, seen };
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-first-"));
  const target = path.join(dir, "profile_screen.dart");
  await fs.writeFile(target, "Title: nnnn\n");
  const { llm, seen } = planFirstBridge(target);
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const orch = new Orchestrator({
    cwd: dir, llm, registry: reg,
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
  });
  return { dir, target, llm, seen, orch };
}

test("the write_edit prompt states THE FLOW: create_plan first, even for a one-line change", () => {
  const p = buildCategorizerSystemPrompt(
    { id: "write_edit", systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit },
    ["read", "write", "edit", "create_plan", "bash", "deliver"],
  );
  assert.match(p, /THE FLOW, EXACTLY: create_plan FIRST/);
  assert.match(p, /even for a one-line change/);
  assert.match(p, /REFUSES every write\/edit issued before create_plan/);
  assert.match(p, /no path to a file change that skips the plan/);
  assert.match(p, /ALL FILE CHANGES GO THROUGH `write`\/`edit`/, "no-bash-source-edits rule");
  assert.match(p, /Do NOT modify files with `bash`/, "explicitly forbids sed/rewrites via bash");
});

test("the write_edit hop's tool descriptions teach plan-first at the choosing layer", async () => {
  const { dir, seen, orch } = await setup();
  await orch.run("change the placeholder title to Delete Account");
  await fs.rm(dir, { recursive: true, force: true });

  assert.ok(seen.writeToolDefs?.length, "tool defs captured from the write_edit hop");
  const byName = Object.fromEntries(seen.writeToolDefs.map((t) => [t.name, t]));
  assert.match(
    byName.create_plan.description,
    /FIRST, ALWAYS — even for a single-file, one-line change/,
    "create_plan description drops the multi-step escape hatch here",
  );
  assert.doesNotMatch(
    byName.create_plan.description,
    /spans more than one file or more than one step/,
    "the stock escape hatch is rewritten inside write_edit",
  );
  assert.match(byName.create_plan.description, /every write\/edit is refused until this has succeeded/);
  for (const name of ["write", "edit"]) {
    assert.match(
      byName[name]?.description ?? "",
      /Plan-first: REFUSED until create_plan has succeeded/,
      `${name} description states the refusal`,
    );
  }
});

test("the stock write tool keeps its description outside write_edit (flat-loop semantics unchanged)", () => {
  assert.ok(!writeTool.description.includes("Plan-first"), "no categorizer-local clause leaks into the base tool");
});

test("an edit fired before the plan is refused with 'nothing is lost', then lands after create_plan", async () => {
  const { dir, target, seen, orch } = await setup();
  const result = await orch.run("change the placeholder title to Delete Account");

  assert.equal(result.success, true, `error=${result.error}`);
  assert.ok(seen.planRan, "create_plan ran");
  assert.match(seen.refusedResult, /create_plan comes FIRST/);
  assert.match(seen.refusedResult, /even a one-line change gets a plan/);
  assert.match(seen.refusedResult, /nothing is lost/);
  assert.equal(
    await fs.readFile(target, "utf8"),
    "Title: Delete Account\n",
    "the same edit landed after the plan",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("an edit is refused on EVERY attempt before the plan — there is no bypass", async () => {
  // STRICT plan-first: no with-nudges allowance. A model that keeps firing edit
  // without ever calling create_plan is refused each and every time, so no write/
  // edit can ever land outside a plan. (The bash-edit escape is separately closed
  // by the shell-authoring guard, so there is no side door either.)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-first-strict-"));
  const target = path.join(dir, "profile_screen.dart");
  await fs.writeFile(target, "Title: nnnn\n");
  const editArgs = { path: target, oldString: "Title: nnnn", newString: "Title: Delete Account" };

  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  const seen = { refusals: 0, planRan: false };
  let routerCalls = 0;
  let turn = 0;
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls === 1 ? "write_edit" : "summarise"}` }]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      seen.planRan = true;
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify({
        plans: [{ id: "p1", title: "x", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update title", summary: "x",
            files: [target], fileMutations: { [target]: "edit" }, complexity: "low" }] }],
        executionOrder: ["p1"],
      })}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "done." }]);
    return msg([{ type: "text", text: "ok" }]);
  };
  llm.stream = async function* (model, ctx) {
    yield { type: "start", partial: msg([]) };
    const results = JSON.stringify(ctx.messages?.map((m) => m.content ?? "") ?? "");
    if (/create_plan comes FIRST/.test(results)) seen.refusals += 1;
    const n = turn++;
    // Fires edit repeatedly and NEVER creates a plan.
    if (n < 3) {
      yield { type: "done", message: toolMsg([[`e${n}`, "edit", editArgs]]) };
      return;
    }
    yield { type: "done", message: toolMsg([["d1", "deliver", { writes: [{ tool: "edit", path: target, summary: "x" }], notes: "refused" }]]) };
  };

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const orch = new Orchestrator({ cwd: dir, llm, registry: reg, permission: new PermissionGate("bypass"), logStore: new LogStore() });
  await orch.run("change the placeholder title to Delete Account");

  assert.equal(seen.planRan, false, "the model never called create_plan");
  assert.equal(seen.refusals, 3, "every one of the three edits was refused — no bypass");
  assert.equal(await fs.readFile(target, "utf8"), "Title: nnnn\n", "the file was never edited without a plan");
  await fs.rm(dir, { recursive: true, force: true });
});
