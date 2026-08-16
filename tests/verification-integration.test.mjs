/**
 * Verify-what-you-wrote gate — integration with the flat `run()` loop.
 *
 * Drives `Orchestrator.run` with a stub LLM (no network) through the verify
 * phase: a work loop writes a runtime file, the verify phase fires, and the
 * model either certifies the file static (→ verified: true) or never does
 * (→ verified: false, but the run still succeeds — verification is non-fatal).
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Harness,
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

/**
 * Stub LLM. Forces TASK route via complete(). In stream():
 *   - first work turn: emit a `write` tool call for the target file
 *   - second turn onward: if the opening mentions "VERIFY WHAT YOU WROTE",
 *     emit a DECLARE block (certify static) — else a plain text finish.
 * `certify` controls whether the verify turn declares the file static.
 */
function makeStubLlm({ targetFile, certify, verifyArg }) {
  const llm = new OpenRouterBridge();
  const openings = [];
  llm.complete = async () => msg([{ type: "text", text: "TASK" }]);
  llm.stream = async function* (_model, ctx, _opts) {
    // The verify message is the LAST user message (prior messages carry the
    // original task as messages[0]). Detect the verify turn by scanning back.
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    openings.push(opening);
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    const isVerifyTurn = /VERIFY WHAT YOU WROTE/.test(opening);
    if (isVerifyTurn && certify) {
      yield {
        type: "done",
        message: msg([{
          type: "text",
          text: `DECLARE { "path": "${targetFile}", "tier": "static", "method": "none", "reason": "generated fixture, no runtime behaviour" }\nSUMMARY: certified static.`,
        }]),
      };
      return;
    }
    if (isVerifyTurn) {
      // Negative path: model does nothing useful, just finishes.
      yield { type: "done", message: msg([{ type: "text", text: "SUMMARY: done." }]) };
      return;
    }
    // Work turn: write the target file once, then finish on the next turn.
    if (!ctx.messages.some((m) => m.role === "toolResult")) {
      const args = { path: targetFile, content: "<button>Hi</button>", ...(verifyArg ? { verify: verifyArg } : {}) };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { name: "write" } };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { arguments: JSON.stringify(args) } };
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "w1", name: "write", arguments: args }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "CHANGES: wrote the file" }]) };
  };
  return { llm, openings };
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-int-"));
  const targetFile = path.join(dir, "Component.tsx");
  const { llm, openings } = makeStubLlm({ targetFile, certify: true });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  return { dir, targetFile, orch, openings };
}

/** A registry with the builtins PLUS a fake reproduction tool that succeeds.
 * Uses the MCP-prefixed name `test-mcp__activity_inspect` (the gate matches
 * `endsWith("__activity_inspect")`) so it doesn't collide with the builtin
 * `activity_inspect`, and a bug-fix test gets real evidence without a browser. */
function newRegistryWithFakeInspect() {
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  registry.add({
    id: "test:fake-inspect",
    kind: "tool",
    source: "internal",
    name: "fake activity_inspect",
    tools: [{
      name: "test-mcp__activity_inspect",
      description: "Fake activity_inspect for tests.",
      mutates: false,
      parameters: { type: "object", properties: { url: { type: "string" } }, required: [] },
      async execute() { return { output: "captured: screenshot taken, console ok" }; },
    }],
  });
  return { registry, logStore };
}

test("a runtime file certified static in the verify phase → verified: true", async () => {
  const { dir, targetFile, orch } = await setup();
  const result = await orch.run("Build a Component", { skipPlan: true });
  assert.equal(result.route, "task");
  assert.equal(result.success, true);
  assert.equal(result.verified, true, "gate should be satisfied by the DECLARE");
  assert.ok(result.verification, "verification report present");
  assert.deepEqual(
    result.verification.certified.map((c) => c.path),
    [targetFile],
    "file listed as certified",
  );
  assert.deepEqual(result.verification.unverified, []);
});

test("verify: false disables the gate entirely (verified undefined, no report)", async () => {
  const { dir, targetFile, orch } = await setup();
  const result = await orch.run("Build a Component", { skipPlan: true, verify: false });
  assert.equal(result.success, true);
  assert.equal(result.verified, undefined);
  assert.equal(result.verification, undefined);
});

test("negative path: model never verifies → verified: false but run still succeeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-neg-"));
  const targetFile = path.join(dir, "Widget.tsx");
  const { llm } = makeStubLlm({ targetFile, certify: false });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Build a Widget", { skipPlan: true });
  assert.equal(result.success, true, "verification failure must NOT fail the run");
  assert.equal(result.verified, false);
  assert.ok(result.verification.unverified.length >= 1, "file reported unverified in the structured report");
  assert.deepEqual(
    result.verification.unverified.map((u) => u.path),
    [targetFile],
    "the unverified file is named",
  );
});

test("a static-only write (.md) skips the verify loop entirely and verifies true", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-md-"));
  const targetFile = path.join(dir, "README.md");
  const { llm } = makeStubLlm({ targetFile, certify: false });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Write a README", { skipPlan: true });
  assert.equal(result.success, true);
  assert.equal(result.verified, true, "static file is auto-certified by the fallback");
});

test("the thread snapshot carries verified for the host", async () => {
  const { dir, targetFile, orch } = await setup();
  const result = await orch.run("Build a Component", { skipPlan: true });
  assert.equal(typeof result.threadSnapshot?.verified, "boolean");
  assert.equal(result.threadSnapshot.verified, true);
});

test("conversational route does not run the gate (verified undefined)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-conv-"));
  const llm = new OpenRouterBridge();
  // Force conversational route.
  llm.complete = async () => msg([{ type: "text", text: "CONVERSATIONAL" }]);
  llm.stream = async function* () {
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    yield { type: "done", message: msg([{ type: "text", text: "It's a button." }]) };
  };
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("What is a button?");
  assert.equal(result.route, "conversational");
  assert.equal(result.verified, undefined);
});

// ---- up-front per-file declaration at write time ----

test("a verify arg on the write call classifies the file up front (no verify loop needed)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-upfront-"));
  const targetFile = path.join(dir, "Component.tsx");
  // The model declares method:"none" WITH the write — a tiny change that needs
  // no runtime check. certify:false so we know the gate was satisfied by the
  // up-front declaration, NOT by a retroactive DECLARE in the verify phase.
  const { llm } = makeStubLlm({
    targetFile,
    certify: false,
    verifyArg: { method: "none", reason: "generated fixture, no runtime behaviour" },
  });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Build a Component", { skipPlan: true });
  assert.equal(result.success, true);
  assert.equal(result.verified, true, "up-front declaration satisfies the gate");
  assert.deepEqual(result.verification.certified.map((c) => c.path), [targetFile]);
  assert.deepEqual(result.verification.unverified, []);
});

test("a verify arg of method:none WITHOUT a reason is rejected (no silent skip)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-noreason-"));
  const targetFile = path.join(dir, "Component.tsx");
  const { llm } = makeStubLlm({
    targetFile,
    certify: false,
    verifyArg: { method: "none" }, // no reason — must be ignored
  });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Build a Component", { skipPlan: true });
  assert.equal(result.verified, false, "a reasonless none declaration does NOT bypass");
  assert.ok(result.verification.unverified.length >= 1);
});

test("an up-front visual declaration is honored (file owed visual evidence)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-visual-"));
  const targetFile = path.join(dir, "Component.tsx");
  const { llm } = makeStubLlm({
    targetFile,
    certify: false,
    verifyArg: { method: "visual" }, // declares it needs a visual check
  });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Build a Component", { skipPlan: true });
  // Declared visual but the model never ran a visual check → unverified.
  assert.equal(result.verified, false);
  const uv = result.verification.unverified.find((u) => u.path === targetFile);
  assert.equal(uv.method, "visual");
});

// ---- debugging flow: reproduce gate persists across steps + report surfaces ----

test("bug-fix: the reproduction report surfaces on RunLoopResult", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-repro-report-"));
  const targetFile = path.join(dir, "fix.ts");
  const llm = new OpenRouterBridge();
  llm.complete = async () => msg([{ type: "text", text: "TASK" }]);
  let sawMutation = false;
  llm.stream = async function* (_model, ctx, _opts) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    // Verify turn → declare the file static to finish.
    if (/VERIFY WHAT YOU WROTE/.test(opening)) {
      yield { type: "done", message: msg([{ type: "text", text: `DECLARE { "path": "${targetFile}", "tier": "static", "method": "none", "reason": "config" }` }]) };
      return;
    }
    // First work turn: observe the bug, THEN edit.
    if (!sawMutation) {
      sawMutation = true;
      // emit a reproduction tool (evidence) + edit in one turn
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { name: "test-mcp__activity_inspect" } };
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { arguments: JSON.stringify({ url: "http://x" }) } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { name: "edit" } };
      const eArgs = { path: targetFile, oldString: "a", newString: "b", verify: { method: "none", reason: "config" } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { arguments: JSON.stringify(eArgs) } };
      yield {
        type: "done",
        message: { role: "assistant", content: [
          { type: "toolCall", id: "i1", name: "test-mcp__activity_inspect", arguments: { url: "http://x" } },
          { type: "toolCall", id: "e1", name: "edit", arguments: eArgs },
        ], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 },
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };
  const { registry, logStore } = newRegistryWithFakeInspect();
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore });
  const result = await orch.run("Fix the bug", { skipPlan: true, isBugFix: true });
  assert.ok(result.reproduction, "reproduction report present on a bug-fix run");
  assert.equal(result.reproduction.reproduced, true, "bug was observed before editing");
  // Non-bug-fix runs get no report.
  const result2 = await orch.run("Fix the bug", { skipPlan: true });
  assert.equal(result2.reproduction, undefined, "no report on a non-bug-fix run");
});

test("bug-fix: the gate does NOT re-block a second edit in the same work loop", async () => {
  // Two edits to two files in ONE work loop; the first is preceded by evidence.
  // The second edit must NOT be re-blocked (the gate saw evidence this loop).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-repro-twostep-"));
  const f1 = path.join(dir, "a.ts");
  const f2 = path.join(dir, "b.ts");
  const llm = new OpenRouterBridge();
  llm.complete = async () => msg([{ type: "text", text: "TASK" }]);
  let editCount = 0;
  const blockedEdits = [];
  llm.stream = async function* (_model, ctx, _opts) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (/VERIFY WHAT YOU WROTE/.test(opening)) {
      yield { type: "done", message: msg([{ type: "text", text: `DECLARE { "path": "${f1}", "tier": "static", "method": "none", "reason": "r" }\nDECLARE { "path": "${f2}", "tier": "static", "method": "none", "reason": "r" }` }]) };
      return;
    }
    // Detect a refused edit in the tool results (the block verdict is an error result).
    for (const m of ctx.messages ?? []) {
      if (m.role === "toolResult" && m.isError && /this run is fixing a REPORTED BUG/.test(JSON.stringify(m.content))) {
        const tc = (ctx.messages ?? []).find((x, i) => x.role === "assistant" && (ctx.messages[i + 1] === m || ctx.messages.slice(i + 1).some(n => n === m)));
        blockedEdits.push(true);
      }
    }
    if (editCount === 0) {
      editCount++;
      const iArgs = { url: "http://x" };
      const e1 = { path: f1, oldString: "a", newString: "b", verify: { method: "none", reason: "fix1" } };
      const e2 = { path: f2, oldString: "a", newString: "b", verify: { method: "none", reason: "fix2" } };
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { name: "test-mcp__activity_inspect" } };
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { arguments: JSON.stringify(iArgs) } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { name: "edit" } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { arguments: JSON.stringify(e1) } };
      yield { type: "toolCall_delta", toolCallId: "e2", delta: { name: "edit" } };
      yield { type: "toolCall_delta", toolCallId: "e2", delta: { arguments: JSON.stringify(e2) } };
      yield { type: "done", message: { role: "assistant", content: [
        { type: "toolCall", id: "i1", name: "test-mcp__activity_inspect", arguments: iArgs },
        { type: "toolCall", id: "e1", name: "edit", arguments: e1 },
        { type: "toolCall", id: "e2", name: "edit", arguments: e2 },
      ], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 } };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };
  const { registry, logStore } = newRegistryWithFakeInspect();
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore });
  const result = await orch.run("Fix bugs in two files", { skipPlan: true, isBugFix: true });
  assert.equal(result.success, true);
  assert.equal(result.reproduction.reproduced, true);
  assert.deepEqual(blockedEdits, [], "the second edit was not re-blocked after evidence was seen");
});
