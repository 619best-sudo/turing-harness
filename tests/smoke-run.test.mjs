// Smoke check: does Orchestrator.run() work end-to-end with a stub LLM?
// Throws on any unexpected behavior; prints the result. Run:
//   node tests/smoke-run.test.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
let planTurnDone = false;
let workTurnDone = false;

// complete(): drives the run-summary turn (and intent routing).
llm.complete = async (_model, ctx) => {
  const sys = ctx.systemPrompt ?? "";
  // Intent router
  if (/router at the front/.test(sys)) {
    return { role: "assistant", content: [{ type: "text", text: "TASK" }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
  }
  // Summary turn
  return { role: "assistant", content: [{ type: "text", text: "I updated the service file as requested." }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
};

// stream(): drives the plan turn + the work step turn.
llm.stream = async function* (_model, ctx) {
  const userText = typeof ctx.messages?.[0]?.content === "string" ? ctx.messages[0].content : "";
  yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
  // First stream call = planning turn: emit a one-step plan.
  if (!planTurnDone) {
    planTurnDone = true;
    const plan = { plans: [{ id: "p1", title: "The change", summary: "x", tasks: [{ id: "t1", order: 1, title: "update service", summary: "x", files: [target], fileMutations: { [target]: "edit" }, complexity: "high" }] }], executionOrder: ["p1"] };
    yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: ["PLANS_JSON:", JSON.stringify(plan), "PLAN: update service.", "RUN SUMMARY: planning done."].join("\n") }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    return;
  }
  // Second stream call = work step: emit a write tool call, then on the next call close.
  if (!workTurnDone) {
    workTurnDone = true;
    yield { type: "done", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: target, content: "new-content\n" } }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 } };
    return;
  }
  yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "RUN SUMMARY: wrote the file." }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
};

const orch = new Orchestrator({
  cwd: tmp, llm, registry: reg,
  permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
  logStore: new LogStore(),
});

const result = await orch.run("update the service file");
const onDisk = await fs.readFile(target, "utf8");

console.log("success:", result.success);
console.log("route:", result.route);
console.log("steps:", JSON.stringify(result.steps, null, 2));
console.log("planSet?.plans[0].tasks[0].isCompleted:", result.planSet?.plans?.[0]?.tasks?.[0]?.isCompleted);
console.log("summary:", result.summary);
console.log("onDisk:", JSON.stringify(onDisk));
console.log("error:", result.error);

// Assertions
const checks = [];
checks.push(["success is true", result.success === true]);
checks.push(["route is task", result.route === "task"]);
checks.push(["one step recorded", result.steps.length === 1]);
checks.push(["step isCompleted true", result.steps[0]?.isCompleted === true]);
checks.push(["step complexity high", result.steps[0]?.complexity === "high"]);
checks.push(["plan task isCompleted marked", result.planSet?.plans?.[0]?.tasks?.[0]?.isCompleted === true]);
checks.push(["file written", onDisk === "new-content\n"]);
checks.push(["summary present", typeof result.summary === "string" && result.summary.length > 0]);

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.log("\nFAILED CHECKS:");
  for (const [name] of failed) console.log("  ✗", name);
  process.exit(1);
} else {
  console.log("\nALL SMOKE CHECKS PASSED ✓");
}
