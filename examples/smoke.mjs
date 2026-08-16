/**
 * End-to-end smoke demo with a scripted fake LLM (no network).
 * Exercises the v2 categorizer chain: router → write_edit
 * (create_plan → write → deliver), summarise, permission modes, events.
 *
 * Run:  node examples/smoke.mjs
 */
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const msg = (content, model = "fake/model") => ({
  role: "assistant", content, api: "openrouter", provider: "openrouter",
  model, usage: zero, stopReason: "stop", timestamp: Date.now(),
});
const toolMsg = (calls) => ({
  ...msg(calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))),
  stopReason: "tool_use",
});

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "turing-smoke-"));
const target = path.join(tmp, "service.ts");
await fs.writeFile(target, "old\n");

// --- A fake bridge: router picks write_edit, the loop plans→writes→delivers ---
let routerCalls = 0;
let turn = 0;
const llm = {
  resolveModel: (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] }),
  async complete(model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "write_edit" : "summarise"}` }], model?.id);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "The change", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update", summary: "x", files: [target], fileMutations: { [target]: "edit" }, complexity: "medium" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }], model?.id);
    }
    if (/closing summary/.test(sys)) {
      return msg([{ type: "text", text: "Updated the service file and verified nothing was left behind." }], model?.id);
    }
    return msg([{ type: "text", text: "ok" }], model?.id);
  },
  async *stream(model) {
    turn += 1;
    yield { type: "start", partial: msg([], model?.id) };
    if (turn === 1) {
      yield { type: "done", reason: "toolUse", message: toolMsg([["p1", "create_plan", { task: "update the service" }]]) };
      return;
    }
    if (turn === 2) {
      yield { type: "done", reason: "toolUse", message: toolMsg([["w1", "write", { path: target, content: "new\n" }]]) };
      return;
    }
    yield { type: "done", reason: "toolUse", message: toolMsg([["d1", "deliver", { writes: [{ tool: "write", path: target, summary: "updated" }], notes: "done" }]]) };
  },
};

// --- Permission: allow everything, count the gates ---
const gates = [];
const harness = new Harness({
  llm,
  cwd: tmp,
  permissionMode: "ask-all",
  permissionCallback: async (req) => { gates.push(req.name); return { allowed: true }; },
});

const events = [];
harness.subscribe((e) => events.push(e.type));

const result = await harness.run("update the service file");

// --- Assertions over the v2 flow ---
assert.equal(result.success, true, `error=${result.error}`);
assert.equal(result.route, "task");
assert.equal(await fs.readFile(target, "utf8"), "new\n", "the write landed");
assert.equal(result.steps.length, 1, "one plan step");
assert.equal(result.steps[0].isCompleted, true, "step completed");
assert.ok(result.summary.length > 0, "summary produced");
assert.deepEqual(
  events.filter((t) => t.startsWith("categorizer_")),
  ["categorizer_start", "categorizer_end"],
  "one hop, start+end events",
);
assert.ok(gates.includes("write"), "the write was permission-gated");
assert.ok(gates.includes("create_plan"), "the plan ran (always, in write_edit)");

console.log("✔ v2 categorizer chain smoke passed");
console.log("  hops:     write_edit → summarise");
console.log("  gates:   ", gates.join(", "));
console.log("  summary: ", result.summary);
await fs.rm(tmp, { recursive: true, force: true });
await harness.dispose();
