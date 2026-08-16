/**
 * `HarnessAgent.prompt(..., { planMode })` in v2.
 *
 * `create_plan` ALWAYS runs inside write_edit; planMode only controls whether
 * the user reviews the plan (the CARD, via the host's planApproval callback).
 * These tests pin what `prompt()` passes to `run`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HarnessAgent } from "../dist/index.js";

/** Minimal AgentHost that records the options `prompt()` passes to `run`. */
function recordingHost() {
  const calls = [];
  return {
    calls,
    subscribe: () => () => {},
    async run(task, opts) {
      calls.push({ task, opts });
      return { summary: "done", steps: [], messages: [], usage: {}, refs: [] };
    },
    orchestrator: { setModel() {}, setReasoning() {} },
  };
}

test("a plain prompt runs without the plan card", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("add a health endpoint");
  assert.equal(host.calls[0].opts.planMode, false, "no card unless planMode is set");
});

test("planMode turns the plan review card on", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("build me a landing page", undefined, { planMode: true });
  assert.equal(host.calls[0].opts.planMode, true);
});

test("planMode: false is explicit, not just absent", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("t", undefined, { planMode: false });
  assert.equal(host.calls[0].opts.planMode, false);
});

test("plan mode is per-prompt, not sticky", async () => {
  const host = recordingHost();
  const agent = new HarnessAgent(host);
  await agent.prompt("one", undefined, { planMode: true });
  await agent.prompt("two");
  assert.deepEqual(
    host.calls.map((c) => c.opts.planMode),
    [true, false],
  );
});
