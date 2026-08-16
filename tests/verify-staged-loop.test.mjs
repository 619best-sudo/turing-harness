/**
 * The orchestrator drives verify rounds through the STAGES.
 *
 * Unit tests cover the tracker's logic and the per-stage message content; this
 * proves the WIRING: the orchestrator constructs a {@link VerifyStageTracker},
 * asks it for the stage each round, and sends a focused stage message — so a run
 * that never satisfies the gate is nudged INSTRUMENT → … → DECIDE across rounds,
 * not handed every route at once. That staged nudge is the whole point of the
 * change: it is what stops a disoriented model re-reading the file or driving a
 * UI it cannot reach.
 *
 * Stub LLM, no network. The model writes a visual file, then "does nothing" each
 * verify round (so the gate never clears); we assert the recorded verify-round
 * openings start at INSTRUMENT and end at DECIDE.
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
  role: "assistant", content,
  model: "x", api: "openrouter", provider: "x",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});

test("the orchestrator drives verify rounds through the stages (instrument … decide)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-staged-loop-"));
  const target = path.join(dir, "Hero.tsx");
  const verifyOpenings = [];

  const llm = new OpenRouterBridge();
  llm.complete = async () => msg([{ type: "text", text: "TASK" }]);
  llm.stream = async function* (_model, ctx) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield {
      type: "start",
      partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 },
    };
    if (/VERIFY WHAT YOU WROTE/.test(opening)) {
      verifyOpenings.push(opening);
      // Never satisfy the gate: each round just finishes. The tracker then
      // advances the stage across rounds purely on the round budget.
      yield { type: "done", message: msg([{ type: "text", text: "(still checking)" }]) };
      return;
    }
    if (!ctx.messages.some((m) => m.role === "toolResult")) {
      const args = { path: target, content: "<button>Hi</button>" };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { name: "write" } };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { arguments: JSON.stringify(args) } };
      yield { type: "done", message: { ...msg([{ type: "toolCall", id: "w1", name: "write", arguments: args }]), stopReason: "tool_use" } };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "CHANGES: wrote the file" }]) };
  };

  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  orch.projectCategory = "frontend"; // so a .tsx write is a VISUAL gap → needs a running app

  const result = await orch.run("Build a Hero", { skipPlan: true });
  assert.equal(result.success, true, "an unsatisfied gate must not fail the run");
  assert.ok(verifyOpenings.length >= 2, `expected multiple verify rounds, got ${verifyOpenings.length}`);
  assert.match(verifyOpenings[0], /INSTRUMENT/, "the first verify round targets the INSTRUMENT stage");
  assert.match(
    verifyOpenings[verifyOpenings.length - 1],
    /DECIDE/,
    "the last verify round targets the DECIDE stage (budget forces a verdict)",
  );
  // Every round carries the anchor, so hosts/tests that detect the verify turn still work.
  for (const o of verifyOpenings) assert.match(o, /VERIFY WHAT YOU WROTE/);

  await fs.rm(dir, { recursive: true, force: true });
});
