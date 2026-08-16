/**
 * `HarnessAgent.prompt(..., { planMode })`.
 *
 * The agent deliberately runs the flat loop with `skipPlan: true`: a single ask
 * ("find a price on this site") should not be split into plan tasks that each
 * restart from scratch. But a host with a plan-mode affordance in its UI needs
 * to opt back in per prompt, and before this there was no way to — the flag was
 * hardcoded, so the toggle had nothing to talk to.
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
    async runChain() {
      throw new Error("not used");
    },
    async runPhase() {
      throw new Error("not used");
    },
    orchestrator: { setModel() {}, setReasoning() {} },
  };
}

test("a plain prompt still skips the planning turn", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("add a health endpoint");
  assert.equal(host.calls[0].opts.skipPlan, true, "the flat loop stays the default");
});

test("planMode runs the planning turn", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("build me a landing page", undefined, { planMode: true });
  // `skipPlan: false` is what makes the orchestrator plan first and then run one
  // sub-loop per step — which is what surfaces the plan for approval.
  assert.equal(host.calls[0].opts.skipPlan, false);
});

test("planMode: false is explicit, not just absent", async () => {
  const host = recordingHost();
  await new HarnessAgent(host).prompt("t", undefined, { planMode: false });
  assert.equal(host.calls[0].opts.skipPlan, true);
});

test("plan mode is per-prompt, not sticky", async () => {
  // A host toggle can be flipped between sends; one planned run must not turn
  // every later run into a planned one.
  const host = recordingHost();
  const agent = new HarnessAgent(host);
  await agent.prompt("one", undefined, { planMode: true });
  await agent.prompt("two");
  assert.deepEqual(
    host.calls.map((c) => c.opts.skipPlan),
    [false, true],
  );
});
