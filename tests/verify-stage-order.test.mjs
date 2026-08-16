/**
 * Order enforcement in the staged verify loop.
 *
 * The spine (instrument → run → inspect → decide) is only as good as the model
 * following the order. The derailment this guards: a run that instruments, then
 * IMMEDIATELY `activity_cleanup`s before capturing anything, leaving nothing to
 * RUN/INSPECT — so it declares done on the analyzer. The runner now REFUSES an
 * early `activity_cleanup` / `remove_log {all:true}` until a capture exists (and
 * lifts the block at DECIDE). This test drives the orchestrator and asserts the
 * refusal lands as an error tool result during a verify round.
 *
 * Stub LLM, offline.
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

test("a premature activity_cleanup during verify is refused before any capture", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-order-"));
  const target = path.join(dir, "Hero.tsx");
  const cleanupResults = [];

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
      // Record any cleanup tool result we have already seen.
      for (const m of ctx.messages ?? []) {
        if (m.role === "toolResult" && m.toolName === "activity_cleanup") {
          cleanupResults.push({ isError: !!m.isError, content: JSON.stringify(m.content) });
        }
      }
      // First verify turn: attempt a PREMATURE cleanup (no capture yet).
      if (cleanupResults.length === 0) {
        const args = { traceId: "turing-trace-deadbeef" };
        yield { type: "toolCall_delta", toolCallId: "c1", delta: { name: "activity_cleanup" } };
        yield { type: "toolCall_delta", toolCallId: "c1", delta: { arguments: JSON.stringify(args) } };
        yield {
          type: "done",
          message: { ...msg([{ type: "toolCall", id: "c1", name: "activity_cleanup", arguments: args }]), stopReason: "tool_use" },
        };
        return;
      }
      // Subsequent verify turns: stop.
      yield { type: "done", message: msg([{ type: "text", text: "(continuing)" }]) };
      return;
    }
    // Work loop: write the file once, then finish.
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
  orch.projectCategory = "frontend"; // .tsx → visual gap → staged verify engages

  await orch.run("Build a Hero", { skipPlan: true });

  assert.ok(cleanupResults.length >= 1, "the model attempted a cleanup during verify");
  const first = cleanupResults[0];
  assert.equal(first.isError, true, "the premature cleanup must be refused, not executed");
  assert.match(first.content, /Not yet/, "the refusal redirects to RUN/INSPECT first");

  await fs.rm(dir, { recursive: true, force: true });
});
