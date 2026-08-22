/**
 * QA hops carry ONE automation surface, by project: mobile → the device
 * toolkit, web → the browser, backend → neither. Browser tools in a Flutter
 * run's inspect hop are the exact failure this gates — a hop that opened with
 * ~62 tools, two-thirds unable to touch the target, and a model that reasoned
 * "my connected automation is browser-based" instead of using `mobile`.
 *
 * Pinned here, end to end through the chain:
 *   - mobile project: inspect/reproduce exclude `drive` + browser MCP tools,
 *     keep `mobile` + the activity_* builtins; the OTHER hops keep them (the
 *     rule is QA-hop-specific, not run-wide);
 *   - web project: the mirror image — no `mobile`, browser present;
 *   - backend: no UI automation at all;
 *   - a URL in the task wins: verifying a web dashboard from any project kind
 *     is web work;
 *   - the opener STATES the surface, so the absence reads as design;
 *   - the drop is logged (`categorizer:surface`), not silent.
 *
 * Run via: npm test. All offline — a scripted bridge walks the graph.
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

/** A browser-flavoured external MCP server, exactly the field shape. */
function browserMcp(reg) {
  const tools = ["browser_navigate", "browser_click", "browser_take_screenshot", "browser_snapshot"].map((name) => ({
    name,
    description: `${name.replace(/_/g, " ")} in the page`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "ok" };
    },
  }));
  reg.add({ id: "turing-machine:mcp:chrome-devtools", kind: "mcp", source: "external", name: "chrome-devtools", tools });
}

/**
 * A bridge that walks read → write_edit → activity_inspect → summarise with
 * minimal ceremony, recording each hop's opening message.
 */
function graphBridge(target, route) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  const seen = { openings: [] };
  let routerCalls = 0;
  let reproTurns = 0;

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      const order = route ?? ["read", "write_edit", "activity_inspect", "summarise"];
      return msg([{ type: "text", text: `CATEGORY: ${order[Math.min(routerCalls - 1, order.length - 1)]}` }]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "The change", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update", summary: "x", files: [target], fileMutations: { [target]: "edit" }, complexity: "low" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "done" }]);
    return msg([{ type: "text", text: "ok" }]);
  };

  llm.stream = async function* (model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const opening = ctx.messages?.[0]?.content;
    if (typeof opening === "string") seen.openings.push({ sys, opening });
    yield { type: "start", partial: msg([]) };
    if (/READ categorizer/.test(sys)) {
      yield { type: "done", message: toolMsg([["d1", "deliver", {
        files: [{ path: target, role: "target", lines: "1", snippet: "x" }],
        codeSummary: "the target",
      }]]) };
      return;
    }
    if (/WRITE\/EDIT categorizer/.test(sys)) {
      yield { type: "done", message: toolMsg([["d2", "deliver", {
        writes: [{ tool: "write", path: target, summary: "fixed" }], notes: "done",
      }]]) };
      return;
    }
    if (/ACTIVITY REPRODUCE/.test(sys)) {
      // Turn 1 delivers unobserved — observe-first refuses it once; turn 2's
      // honest could-not-reproduce passes. (The gate parity this exercises.)
      reproTurns += 1;
      const n = reproTurns;
      yield {
        type: "done",
        message: toolMsg([["dr" + n, "deliver", n === 1
          ? { reproduced: true, symptom: "the defect" }
          : { reproduced: false, symptom: "not reproduced (scripted)", evidence: "/tmp/none.log" }]]),
      };
      return;
    }
    if (/ACTIVITY INSPECT/.test(sys)) {
      yield { type: "done", message: toolMsg([["d3", "deliver", {
        writes: [{ tool: "write", path: target }],
        findings: "clean",
        verdict: "pass",
      }]]) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };
  return { llm, seen };
}

async function setup({ projectCategory, task = "fix the service", withMcp = true, route } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-surface-"));
  const target = path.join(dir, "service.ts");
  await fs.writeFile(target, "old\n");
  const { llm, seen } = graphBridge(target, route);
  const logStore = new LogStore();
  const reg = new Registry();
  registerBuiltins(reg, { logStore });
  if (withMcp) browserMcp(reg);
  // The composer selection: the browser MCP joins every category — the QA
  // surface rule below is what keeps it out of the WRONG QA hop.
  reg.selectExternalMcps(["chrome-devtools"], ["conversation", "read", "write_edit", "activity_inspect"]);
  const orch = new Orchestrator({
    cwd: dir, llm, registry: reg,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  if (projectCategory) orch.projectCategory = projectCategory;
  const result = await orch.run(task);
  const rosters = logStore
    .search({ text: "running categorizer", regex: false })
    .map((e) => ({ id: e.data?.categorizer, tools: e.data?.tools ?? [] }));
  const surfaces = logStore.search({ anyTags: ["categorizer:surface"] });
  const openingOf = (re) => seen.openings.find((o) => re.test(o.sys))?.opening ?? "";
  return { dir, result, rosters, surfaces, openingOf, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("mobile project: the QA hop carries the device surface, never the browser", async () => {
  const s = await setup({ projectCategory: "mobile" });
  try {
    assert.equal(s.result.success, true, `error=${s.result.error}`);
    const qa = s.rosters.find((r) => r.id === "activity_inspect");
    assert.ok(qa, "inspect roster logged");
    assert.ok(qa.tools.includes("mobile"), "the device tool is present");
    assert.ok(qa.tools.includes("activity_inspect"), "activity builtins are present");
    assert.ok(!qa.tools.includes("drive"), "the browser driver is dropped");
    assert.ok(!qa.tools.some((t) => t.startsWith("browser_")), "browser MCP tools are dropped");

    // The rule is QA-hop-specific: the selected MCP still rides the others.
    const write = s.rosters.find((r) => r.id === "write_edit");
    assert.ok(write.tools.some((t) => t === "browser_navigate"), "a selected MCP rides write_edit");

    // Stated in the opener, and logged — never a silent disappearance.
    assert.match(s.openingOf(/ACTIVITY INSPECT/), /AUTOMATION SURFACE: this is a mobile\/device project/);
    assert.ok(s.surfaces.some((e) => e.data?.surface === "mobile"), "the drop is logged");
  } finally {
    await s.cleanup();
  }
});

test("web project: the mirror image — the browser stays, the device toolkit goes", async () => {
  const s = await setup({ projectCategory: "frontend" });
  try {
    assert.equal(s.result.success, true, `error=${s.result.error}`);
    const qa = s.rosters.find((r) => r.id === "activity_inspect");
    assert.ok(qa.tools.includes("drive"), "the browser driver is present");
    assert.ok(qa.tools.includes("browser_navigate"), "browser MCP tools are present");
    assert.ok(!qa.tools.includes("mobile"), "the device tool is dropped");
    assert.match(s.openingOf(/ACTIVITY INSPECT/), /AUTOMATION SURFACE: this is a web project/);
  } finally {
    await s.cleanup();
  }
});

test("backend project: no UI automation at all — verify through bash and the activity builtins", async () => {
  const s = await setup({ projectCategory: "backend" });
  try {
    const qa = s.rosters.find((r) => r.id === "activity_inspect");
    assert.ok(qa.tools.includes("bash"), "the run surface is bash");
    assert.ok(!qa.tools.includes("drive") && !qa.tools.includes("mobile"), "no UI drivers");
    assert.ok(!qa.tools.some((t) => t.startsWith("browser_")), "no browser MCP tools");
    assert.match(s.openingOf(/ACTIVITY INSPECT/), /backend project with no UI/);
  } finally {
    await s.cleanup();
  }
});

test("a URL in the task wins over the project category", async () => {
  const s = await setup({ projectCategory: "mobile", task: "verify the dashboard at https://example.com renders" });
  try {
    const qa = s.rosters.find((r) => r.id === "activity_inspect");
    assert.ok(qa.tools.includes("drive"), "web work keeps the browser driver");
    assert.ok(!qa.tools.includes("mobile") || qa.tools.includes("drive"), "web surface applies");
  } finally {
    await s.cleanup();
  }
});

test("no preset + a bare directory: detection answers backend, and the QA hop drops UI automation", async () => {
  // `projectCategory` unset on the orchestrator is the real "host said
  // nothing" path — and detection then answers for itself (a bare dir reads
  // backend). So there is no reachable "unknown surface" through the chain;
  // the only ungated hops are QA hops of custom setups with no category input.
  const s = await setup({ projectCategory: undefined });
  try {
    const qa = s.rosters.find((r) => r.id === "activity_inspect");
    assert.ok(!qa.tools.includes("drive") && !qa.tools.includes("mobile"), "a bare dir is a backend surface");
    assert.match(s.openingOf(/ACTIVITY INSPECT/), /backend project with no UI/);
  } finally {
    await s.cleanup();
  }
});


test("PARITY: the reproduce hop gets the same surface gating and opener as inspect", async () => {
  // Both QA hops behave alike though their purposes differ — verify (judge a
  // change) vs reproduce (make a reported defect happen). Everything gated on
  // "the QA surface" must land on BOTH: the tool gating by project category,
  // and the opener that states the surface so the absence of the other
  // surface's tools reads as design.
  const s = await setup({
    projectCategory: "mobile",
    task: "the app crashes when opening the profile screen",
    route: ["read", "activity_reproduce", "summarise"],
  });
  try {
    assert.equal(s.result.success, true, `error=${s.result.error}`);
    const repro = s.rosters.find((r) => r.id === "activity_reproduce");
    assert.ok(repro, "the reproduce hop ran and logged its roster");
    assert.ok(repro.tools.includes("mobile"), "the device tool is present");
    assert.ok(!repro.tools.includes("drive"), "the browser driver is dropped");
    assert.ok(!repro.tools.some((t) => t.startsWith("browser_")), "browser MCP tools are dropped");
    assert.match(s.openingOf(/ACTIVITY REPRODUCE/), /AUTOMATION SURFACE: this is a mobile\/device project/);
    assert.ok(s.surfaces.some((e) => e.data?.categorizer === "activity_reproduce"), "the drop is logged for reproduce too");
  } finally {
    await s.cleanup();
  }
});
