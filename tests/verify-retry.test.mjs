/**
 * A verify FAIL triggers a fresh cycle (instrument → run → inspect → decide),
 * bounded — not an immediate give-up at verified:false.
 *
 * This is the single verify path for every run shape (development, debugging,
 * QA/classic all flow through orchestrator.run), so the retry covers all three.
 * Two cases: (1) both attempts fail → run completes honestly at verified:false,
 * and the second attempt's first round carries the "FRESH VERIFY ATTEMPT" note;
 * (2) the retry SUCCEEDS — the first attempt produces nothing, the second
 * produces a valid bypass → verified:true.
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

function baseRegistry() {
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  return { registry, logStore };
}

test("on a failed first attempt, a FRESH second verify attempt runs and the run stays bounded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-retry-fail-"));
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
      // Never produce evidence or a bypass — every round just finishes.
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

  const { registry, logStore } = baseRegistry();
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  orch.projectCategory = "frontend";
  const result = await orch.run("Build a Hero", { skipPlan: true });

  // First attempt = maxRounds (5); a second attempt must have run on the fail.
  assert.ok(verifyOpenings.length > 5, `expected a second attempt (>5 rounds), got ${verifyOpenings.length}`);
  assert.ok(
    verifyOpenings.some((o) => /FRESH VERIFY ATTEMPT 2 of 2/.test(o)),
    "the retry's first round carries the fresh-attempt note",
  );
  // Bounded: the run completes honestly, no infinite loop, and not satisfied.
  assert.equal(result.success, true);
  assert.equal(result.verified, false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("the fresh attempt can succeed: attempt 1 produces nothing, attempt 2 verifies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-retry-ok-"));
  const target = path.join(dir, "Hero.tsx");
  let verifyTurns = 0;

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
      verifyTurns += 1;
      // First attempt (turns 1..5): nothing. From the second attempt (turn 6+),
      // certify the file static — a valid bypass the gate accepts.
      if (verifyTurns > 5) {
        yield {
          type: "done",
          message: msg([{
            type: "text",
            text: `DECLARE { "path": "${target}", "tier": "static", "method": "none", "reason": "generated fixture, no runtime behaviour" }`,
          }]),
        };
        return;
      }
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

  const { registry, logStore } = baseRegistry();
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  orch.projectCategory = "frontend";
  const result = await orch.run("Build a Hero", { skipPlan: true });

  assert.equal(result.success, true);
  assert.equal(result.verified, true, "the fresh second attempt verified the change");
  assert.ok(verifyTurns > 5, "the first attempt ran its course before the retry");

  await fs.rm(dir, { recursive: true, force: true });
});
