/**
 * The QA gate, driven through the real `Orchestrator.run` loop.
 *
 * The unit tests in `qa-gate.test.mjs` pin the rules; this pins that the rules
 * are actually WIRED — that a call the gate refuses never reaches the tool, that
 * the refusal comes back to the model as an error result it can act on, and that
 * the state the rules depend on survives the hop from the work loop into the
 * verify pass (it lives in different loop invocations, which is exactly how a
 * per-loop gate would have missed it).
 *
 * The script replayed here is the observed failure, compressed: edit a file,
 * then reach straight for the device without building.
 *
 * Offline — stub LLM, no network.
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
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const msg = (content) => ({
  role: "assistant",
  content,
  model: "x", api: "openrouter", provider: "x",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});

/** A registry with a fake device server: launch, screenshot, tap. */
function newRegistry() {
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const executed = [];
  const fake = (name) => ({
    name,
    description: `Fake ${name} for tests.`,
    mutates: false,
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      executed.push(name);
      return { output: `ok (${name})`, details: { captured: 1 } };
    },
  });
  registry.add({
    id: "test:fake-mobile",
    kind: "mcp",
    source: "internal",
    name: "fake device server",
    tools: [
      fake("vendor__mobile_launch_app"),
      fake("vendor__activity_inspect"),
      fake("vendor__mobile_tap"),
      fake("vendor__browser_take_screenshot"),
    ],
  });
  return { registry, logStore, executed };
}

/**
 * A stub model that runs a fixed script of turns. Each entry is either a list of
 * tool calls or a final text. Records every tool RESULT it is handed, so the
 * test can see what came back.
 */
function scriptedLlm(turns) {
  const llm = new OpenRouterBridge();
  const seenResults = [];
  let turn = 0;
  llm.complete = async () => msg([{ type: "text", text: "TASK" }]);
  llm.stream = async function* (_model, ctx) {
    for (const m of ctx.messages ?? []) {
      if (m.role === "toolResult") {
        const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (!seenResults.some((r) => r.id === m.toolCallId)) {
          seenResults.push({ id: m.toolCallId, isError: !!m.isError, text });
        }
      }
    }
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    const raw = turns[Math.min(turn, turns.length - 1)];
    const n = turn;
    turn += 1;
    if (typeof raw === "string" || raw === undefined) {
      yield { type: "done", message: msg([{ type: "text", text: raw ?? "SUMMARY: done." }]) };
      return;
    }
    // Unique ids per turn: a repeated turn (the last entry replays for every
    // later round) must produce distinct call ids, or the results dedupe into
    // one and the test undercounts what actually happened.
    const step = raw.map((c) => ({ ...c, id: `${c.id}-${n}` }));
    const content = step.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args }));
    for (const c of step) {
      yield { type: "toolCall_delta", toolCallId: c.id, delta: { name: c.name } };
      yield { type: "toolCall_delta", toolCallId: c.id, delta: { arguments: JSON.stringify(c.args) } };
    }
    yield {
      type: "done",
      message: { role: "assistant", content, model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 },
    };
  };
  return { llm, seenResults };
}

async function project() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-gate-int-"));
  const file = path.join(dir, "screen.ts");
  await fs.writeFile(file, "export const title = 'Delete account?';\n");
  // A manifest so the refusal has a real project command to quote back.
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { ios: "react-native run-ios" } }, null, 2),
  );
  return { dir, file };
}

test("the observed failure is refused: edit, then screenshot the app nobody rebuilt", async () => {
  const { dir, file } = await project();
  const { registry, logStore, executed } = newRegistry();
  const { llm, seenResults } = scriptedLlm([
    // Turn 1: the edit.
    [{ id: "e1", name: "edit", args: { path: file, oldString: "Delete account?", newString: "lolo" } }],
    // Turn 2: straight to the device — launch the installed app and photograph it.
    [
      { id: "l1", name: "vendor__mobile_launch_app", args: { bundleId: "com.x.y" } },
      { id: "s1", name: "vendor__browser_take_screenshot", args: {} },
    ],
    "SUMMARY: stopped.",
  ]);
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore });
  await orch.run("change the title", { skipPlan: true, verify: false });

  assert.ok(!executed.includes("vendor__browser_take_screenshot"), "the screenshot tool never ran");
  assert.ok(!executed.includes("vendor__mobile_launch_app"), "and neither did the launch");
  const refusals = seenResults.filter((r) => r.isError);
  assert.ok(refusals.length >= 1, "the model was handed a refusal, not a silent drop");
  assert.match(refusals[0].text, /verify pass/, "and it says whose job QA is");
  assert.match(refusals[0].text, /activity_inspect/, "and names the tool to use instead");
  // The refusal is logged under its own tag, so a host can surface it.
  const tagged = logStore.all().filter((e) => (e.tags ?? []).includes("qa-gate"));
  assert.ok(tagged.length >= 1, "the refusal is on the log with a qa-gate tag");
});

test("before any edit, the same calls go through — that is reproduction, not QA", async () => {
  const { dir } = await project();
  const { registry, logStore, executed } = newRegistry();
  const { llm } = scriptedLlm([
    [
      { id: "l1", name: "vendor__mobile_launch_app", args: { bundleId: "com.x.y" } },
      { id: "s1", name: "vendor__browser_take_screenshot", args: {} },
    ],
    "SUMMARY: observed the bug.",
  ]);
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore });
  await orch.run("the delete dialog shows the wrong title", { skipPlan: true, verify: false, isBugFix: true });
  assert.deepEqual(executed, ["vendor__mobile_launch_app", "vendor__browser_take_screenshot"]);
});

test("the writes a WORK loop made are still remembered in the VERIFY pass", async () => {
  // The gate is run-scoped for exactly this: the edit happens in one loop
  // invocation and the capture in another. A per-loop gate would start the
  // verify pass believing nothing had been written and wave the stale capture
  // through — which is the bug, not a nuance.
  const { dir, file } = await project();
  const { registry, logStore, executed } = newRegistry();
  const { llm, seenResults } = scriptedLlm([
    [{ id: "e1", name: "edit", args: { path: file, oldString: "Delete account?", newString: "lolo" } }],
    "SUMMARY: changed the title.",
    // Every later turn (including every verify round) reaches for the device.
    [{ id: "s2", name: "vendor__activity_inspect", args: { target: "mobile" } }],
  ]);
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore });
  await orch.run("change the title", { skipPlan: true });
  // The FIRST thing the model gets back for that capture is the refusal — the
  // write it made in the previous loop is still on the record.
  assert.ok(seenResults[1], "a second tool result exists");
  assert.equal(seenResults[1].isError, true);
  // Instrument comes first now (probes must be in the binary before the launch),
  // so the FIRST refusal demands the probes; the stale-build rule still fires
  // once the instrument rule stands down.
  assert.match(seenResults[1].text, /INSTRUMENT stage/, "the first refusal demands the probes");
  assert.match(seenResults[1].text, /add_log/);
  // Bounded, not absolute: after `maxBlocks` refusals each rule stands down and
  // the call proceeds, so a model that cannot satisfy one still finishes. What is
  // NOT allowed is sailing through on the first try.
  const stale = seenResults.filter((r) => r.isError && /OLD build/.test(r.text));
  assert.ok(stale.length >= 1, "the stale-build rule still fires behind it");
  assert.ok(executed.length >= 1, "and does get through eventually — the rule stands down, never deadlocks");
});
