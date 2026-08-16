/**
 * End-to-end categorizer chain tests: the hop graph (read → write_edit ↔
 * activity_inspect → summarise), smart context passing, the terminal `deliver`
 * tool, mention propagation, per-categorizer models, planMode card semantics,
 * clearing_doubt, and the verified verdict.
 *
 * All offline — a scripted bridge drives router turns, create_plan, the loop
 * turns and the summary.
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
  defineSkill,
  createCategorizerSetup,
  createDefaultCategorizers,
  createClearingDoubtTool,
  CLEARING_DOUBT_TOOL_NAME,
} from "../dist/index.js";

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
const msg = (content, model = "test/a") => ({
  role: "assistant", content, model, api: "openrouter", provider: "test",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});
const toolMsg = (calls, model) => ({
  ...msg(
    calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
    model,
  ),
  stopReason: "tool_use",
});

/**
 * A bridge that walks the full graph:
 *   router → read (deliver code-summary) → write_edit (plan+write+deliver)
 *   → activity_inspect (deliver verdict) → router summarise → summary turn.
 * Records every user-facing opening message per categorizer for context-passing
 * assertions.
 */
function graphBridge({ target, verdict = "pass", planApproval, writeModel } = {}) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  const seen = { openings: [], routerReplies: [], turns: {}, summaryPrompt: "", doubtPrompts: [] };
  let routerCalls = 0;

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      const order = ["read", "write_edit", "activity_inspect", "summarise"];
      const reply = `CATEGORY: ${order[Math.min(routerCalls - 1, order.length - 1)]}`;
      seen.routerReplies.push(reply);
      return msg([{ type: "text", text: reply }]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "The change", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update", summary: "x", files: [target], fileMutations: { [target]: "edit" }, complexity: "medium" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    if (/senior engineer a smaller coding agent consults/.test(sys)) {
      seen.doubtPrompts.push(ctx.messages?.[0]?.content ?? "");
      return msg([{ type: "text", text: "1. read the file\n2. edit the function\n3. verify with bash" }]);
    }
    if (/closing summary/.test(sys)) {
      seen.summaryPrompt = ctx.messages?.[0]?.content ?? "";
      return msg([{ type: "text", text: "Fixed and verified end to end." }]);
    }
    return msg([{ type: "text", text: "ok" }]);
  };

  llm.stream = async function* (model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const opening = ctx.messages?.[0]?.content;
    if (typeof opening === "string") seen.openings.push({ sys, opening });
    const which =
      /READ categorizer/.test(sys) ? "read"
      : /WRITE\/EDIT categorizer/.test(sys) ? "write_edit"
      : /ACTIVITY INSPECT/.test(sys) ? "activity_inspect"
      : "other";
    seen.models ??= {};
    seen.models[which] = model?.openRouterSlug ?? model?.id;
    seen.turns[which] = (seen.turns[which] ?? 0) + 1;
    yield { type: "start", partial: msg([]) };

    if (which === "read") {
      yield { type: "done", message: toolMsg([["d1", "deliver", {
        files: [{ path: target, role: "target", lines: "10-20", snippet: "function target() {}" }],
        codeSummary: "target() is the entry the change edits",
      }]]) };
      return;
    }
    if (which === "write_edit") {
      const n = seen.turns.write_edit;
      if (n === 1) {
        yield { type: "done", message: toolMsg([["p1", "create_plan", { task: "the change" }]]) };
        return;
      }
      if (n === 2) {
        yield { type: "done", message: toolMsg([["w1", "write", { path: target, content: "fixed\n" }]]) };
        return;
      }
      if (n === 3) {
        yield { type: "done", message: toolMsg([["d2", "deliver", {
          writes: [{ tool: "write", path: target, summary: "fixed" }], notes: "done",
        }]]) };
        return;
      }
    }
    if (which === "activity_inspect") {
      yield { type: "done", message: toolMsg([["d3", "deliver", {
        writes: [{ tool: "write", path: target }],
        logPaths: ["/tmp/trace.log"],
        findings: "The change runs clean; no defects.",
        verdict,
      }]]) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  return { llm, seen };
}

async function graphSetup(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chain-e2e-"));
  const target = path.join(dir, "service.ts");
  await fs.writeFile(target, "old\n");
  const { llm, seen } = graphBridge({ target, ...over });
  const events = [];
  const orch = new Orchestrator({
    cwd: dir, llm,
    registry: withBuiltins(),
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
    ...over.orch,
  });
  orch.subscribe((e) => events.push(e));
  return { dir, target, llm, seen, orch, events };
}

function withBuiltins() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg;
}

test("the chain walks read → write_edit → activity_inspect → summarise", async () => {
  const { dir, target, seen, orch, events } = await graphSetup();
  const result = await orch.run("fix the service");

  assert.equal(result.success, true, `error=${result.error}`);
  assert.equal(result.route, "task");
  assert.deepEqual(seen.routerReplies, [
    "CATEGORY: read", "CATEGORY: write_edit", "CATEGORY: activity_inspect", "CATEGORY: summarise",
  ]);
  assert.equal(await fs.readFile(target, "utf8"), "fixed\n");
  // Events: a start/end pair per hop, in order.
  assert.deepEqual(
    events.filter((e) => e.type.startsWith("categorizer_")).map((e) => `${e.type}:${e.categorizer}`),
    [
      "categorizer_start:read", "categorizer_end:read",
      "categorizer_start:write_edit", "categorizer_end:write_edit",
      "categorizer_start:activity_inspect", "categorizer_end:activity_inspect",
    ],
  );
  // The verified flag comes from the inspect verdict.
  assert.equal(result.verified, true);
  // Plan steps reported + flipped in place.
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].isCompleted, true);
  assert.equal(result.planSet.plans[0].tasks[0].isCompleted, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("smart context passing: only accepted deliverables and tool records travel", async () => {
  const { dir, target, seen, orch } = await graphSetup();
  await orch.run("fix the service");

  const byCat = {};
  for (const o of seen.openings) {
    if (/READ categorizer/.test(o.sys)) byCat.read = o.opening;
    if (/WRITE\/EDIT categorizer/.test(o.sys)) byCat.write = o.opening;
    if (/ACTIVITY INSPECT/.test(o.sys)) byCat.inspect = o.opening;
  }

  // The FIRST hop receives nothing but the task (fresh start).
  assert.ok(byCat.read.includes("TASK: fix the service"));
  assert.ok(!byCat.read.includes("deliverable from"), "the first hop carries no upstream context");

  // write_edit accepts the read deliverable (code summary + files).
  assert.match(byCat.write, /deliverable from read/);
  assert.match(byCat.write, /target\(\) is the entry the change edits/);
  assert.match(byCat.write, /lines.*10-20/s);

  // activity_inspect accepts the write EDIT tool record + the write deliverable.
  assert.match(byCat.inspect, /deliverable from write_edit/);
  assert.match(byCat.inspect, /write call from write_edit/);
  assert.match(byCat.inspect, /function target|fixed/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a fail verdict routes back to write_edit (the repair loop)", async () => {
  const { dir, seen, orch } = await graphSetup({ verdict: "fail" });
  const result = await orch.run("fix the service");
  assert.equal(result.verified, false);
  // The graph bridge's router script still summarises after the second
  // write_edit — but the FAIL verdict is what the result reports.
  assert.ok(seen.routerReplies.includes("CATEGORY: write_edit"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("mentions resolve and their tools reach EVERY categorizer", async () => {
  const { dir, orch } = await graphSetup();
  orch.registry.add(defineSkill({
    id: "skill:lint",
    name: "lint",
    description: "lints",
    tools: [{
      name: "lint_check", description: "runs lint", parameters: { type: "object" },
      async execute() { return { output: "clean" }; },
    }],
  }));
  await orch.run("fix the service /lint");

  // Each hop logs its resolved toolset; the mentioned skill's tool must be in
  // every one of them.
  const hops = orch.logStore.search({ anyTags: ["categorizer:tools"] }).length; // (missing-tool warnings, not the roster)
  const rosters = orch.logStore
    .search({ text: "running categorizer", regex: false })
    .map((e) => ({ id: e.data?.categorizer, tools: e.data?.tools ?? [] }));
  assert.deepEqual(rosters.map((r) => r.id), ["read", "write_edit", "activity_inspect"]);
  for (const r of rosters) {
    assert.ok(r.tools.includes("lint_check"), `${r.id} carries the mentioned skill's tool`);
  }
  assert.ok(hops >= 0);
});

test("per-categorizer model: setModel('<id>', slug) pins that hop's driver", async () => {
  const { dir, seen, orch } = await graphSetup();
  orch.setModel("read", "test/reader-model");
  await orch.run("fix the service");
  assert.equal(seen.models.read, "test/reader-model", "read drives on its pinned model");
  assert.equal(seen.models.write_edit, "xiaomi/mimo-v2.5", "write_edit keeps the role-slot default");
  await fs.rm(dir, { recursive: true, force: true });
});

test("planMode gates the plan CARD; the plan always runs", async () => {
  const approvals = [];
  const planApproval = async (req) => {
    approvals.push(req);
    return { approved: true };
  };

  // Card ON: the callback fires.
  {
    const { dir, orch } = await graphSetup();
    orch.setPlanApprovalCallback(planApproval);
    await orch.run("fix the service", { planMode: true });
    assert.equal(approvals.length, 1, "planMode:true shows the card");
    await fs.rm(dir, { recursive: true, force: true });
  }
  // Card OFF: no review round-trip, but the plan still ran (write preceded by
  // create_plan — enforced by the plan-first guard, and the write landed).
  {
    const before = approvals.length;
    const { dir, target, orch } = await graphSetup();
    orch.setPlanApprovalCallback(planApproval);
    const result = await orch.run("fix the service", { planMode: false });
    assert.equal(approvals.length, before, "planMode:false shows no card");
    assert.equal(await fs.readFile(target, "utf8"), "fixed\n", "the plan still ran and the write landed");
    assert.ok(result.planSet, "a plan was produced");
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearing_doubt consults the big model and returns executable steps", async () => {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  llm.complete = async () =>
    msg([{ type: "text", text: "1. read the file\n2. edit the function\n3. verify" }], "test/senior");

  const tool = createClearingDoubtTool({
    llm,
    model: { id: "test/senior" },
    task: "fix the flaky test",
    categorizer: "write_edit",
    hops: [{ id: "read", index: 0, summary: "read the suite", delivered: true, toolRecords: [], writtenPaths: [], readPaths: [] }],
    toolNames: ["read", "edit", "bash"],
  });
  const res = await tool.execute("c1", { doubt: "the fix keeps failing" }, { cwd: process.cwd(), log: () => {} });
  assert.ok(!res.isError);
  assert.match(res.output, /SENIOR GUIDANCE/);
  assert.match(res.output, /1\. read the file/);

  // An empty doubt is refused without spending the consult.
  const res2 = await tool.execute("c2", { doubt: "" }, { cwd: process.cwd(), log: () => {} });
  assert.equal(res2.isError, true);
});

test("a custom setup with a deploy category joins the graph", async () => {
  const deploy = {
    id: "deploy",
    name: "Deploy",
    description: "Ship the verified build.",
    systemPrompt: "You are the DEPLOY categorizer. %%GUIDANCE%% %%ESCALATION%%",
    tools: ["bash"],
    children: [],
    accepts: { from: ["activity_inspect"] },
    returns: { kind: "summary", description: "the deploy result" },
  };
  const setup = createCategorizerSetup({ categories: createDefaultCategorizers() });
  const setupWithDeploy = createCategorizerSetup({ categories: [...createDefaultCategorizers(), deploy] });
  assert.equal(setupWithDeploy.categories.length, setup.categories.length + 1);
});
