/**
 * The staged verify spine must work for ALL three run shapes from the same
 * backbone: development (write → verify), DEBUGGING (reproduce → fix → verify),
 * and QA (verify existing behaviour with NO write/edit).
 *
 * QA is the new one: the gate used to key off written files only, so a pure
 * "QA this" request skipped instrument→wait→inspect→decide entirely. These
 * tests pin that a QA request now engages the staged spine (with QA wording:
 * observe, don't edit; report a verdict, don't fix) even when nothing was
 * written, and that a bug-fix run reaches the same spine after its fix.
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

/** Router reply with the four classification lines. */
const router = (route, bugfix, qa) =>
  `ROUTE: ${route}\nBUGFIX: ${bugfix}\nQA: ${qa}\nUNSPECIFIED: NO`;

/** A registry whose fake `activity_inspect` returns a successful capture, so a
 * bug-fix run can satisfy the reproduce gate without a real browser/device. */
function registryWithFakeInspect() {
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

test("QA request with NO write/edit engages the staged verify spine", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-verify-"));
  const verifyOpenings = [];

  const llm = new OpenRouterBridge();
  llm.complete = async (_m, ctx) =>
    msg([{ type: "text", text: /router at the front/i.test(String(ctx.systemPrompt ?? "")) ? router("TASK", "NO", "YES") : "done" }]);
  llm.stream = async function* (_model, ctx) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: msg([]) };
    if (/VERIFY THE REQUESTED BEHAVIOUR/.test(opening)) {
      verifyOpenings.push(opening);
      // Never produce a PASS — each round just finishes, so the spine advances
      // purely on the round budget and ends at DECIDE.
      yield { type: "done", message: msg([{ type: "text", text: "(still checking)" }]) };
      return;
    }
    // Work loop: NO write/edit — pure QA. Just finish.
    yield { type: "done", message: msg([{ type: "text", text: "investigated the target" }]) };
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
  orch.projectCategory = "mobile"; // a screen app → the QA gap is VISUAL

  const result = await orch.run("QA the delete-account dialog", { skipPlan: true });
  assert.equal(result.success, true, "an unsatisfied QA gate must not fail the run");
  assert.ok(verifyOpenings.length >= 2, `QA engaged multiple staged rounds, got ${verifyOpenings.length}`);
  assert.match(verifyOpenings[0], /OBSERVE THE TARGET BEHAVIOUR/, "first QA round is the observe/instrument stage");
  assert.match(verifyOpenings[0], /do NOT edit the user's source/i, "QA is observe-only");
  assert.match(verifyOpenings[verifyOpenings.length - 1], /DECIDE/, "last QA round forces a verdict");
  assert.match(verifyOpenings[verifyOpenings.length - 1], /do NOT edit the code yourself/i, "QA decide reports, does not fix");

  await fs.rm(dir, { recursive: true, force: true });
});

test("a non-QA request is NOT routed as QA (router default-off, no QA spine)", async () => {
  // Same stub, but the router says QA: NO. The verify message should be the
  // normal VERIFY WHAT YOU WROTE form, not the QA form — and only if something
  // was written. Here nothing is written, so no verify round fires at all.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-negative-"));
  let sawQaHeader = false;
  let sawAnyVerify = false;

  const llm = new OpenRouterBridge();
  llm.complete = async (_m, ctx) =>
    msg([{ type: "text", text: /router at the front/i.test(String(ctx.systemPrompt ?? "")) ? router("TASK", "NO", "NO") : "done" }]);
  llm.stream = async function* (_model, ctx) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: msg([]) };
    if (/VERIFY/.test(opening)) {
      sawAnyVerify = true;
      if (/VERIFY THE REQUESTED BEHAVIOUR/.test(opening)) sawQaHeader = true;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
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
  await orch.run("look at the project", { skipPlan: true });
  assert.equal(sawAnyVerify, false, "no write → no verify round for a non-QA task");
  assert.equal(sawQaHeader, false, "a non-QA request never gets the QA header");

  await fs.rm(dir, { recursive: true, force: true });
});

test("debugging: a bug-fix run reaches the staged verify spine after the fix", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "debug-verify-"));
  const target = path.join(dir, "fix.ts");
  // Pre-create the file so the `edit` (oldString "a" → "b") succeeds and lands a
  // real written-path gap for the verify spine to pick up.
  await fs.writeFile(target, "a\n");
  const verifyOpenings = [];

  const llm = new OpenRouterBridge();
  llm.complete = async (_m, ctx) =>
    msg([{ type: "text", text: /router at the front/i.test(String(ctx.systemPrompt ?? "")) ? router("TASK", "YES", "NO") : "done" }]);
  let reproduced = false;
  llm.stream = async function* (_model, ctx) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: msg([]) };
    if (/VERIFY WHAT YOU WROTE/.test(opening)) {
      verifyOpenings.push(opening);
      yield { type: "done", message: msg([{ type: "text", text: "(verifying)" }]) };
      return;
    }
    // Work loop: reproduce (evidence) THEN edit the fix in one turn. The edit
    // leaves a real gap (no method:none declaration) so the staged verify spine
    // actually engages afterwards.
    if (!reproduced) {
      reproduced = true;
      const eArgs = { path: target, oldString: "a", newString: "b" };
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { name: "test-mcp__activity_inspect" } };
      yield { type: "toolCall_delta", toolCallId: "i1", delta: { arguments: JSON.stringify({ url: "http://x" }) } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { name: "edit" } };
      yield { type: "toolCall_delta", toolCallId: "e1", delta: { arguments: JSON.stringify(eArgs) } };
      yield {
        type: "done",
        message: { ...msg([{ type: "toolCall", id: "i1", name: "test-mcp__activity_inspect", arguments: { url: "http://x" } }, { type: "toolCall", id: "e1", name: "edit", arguments: eArgs }]), stopReason: "tool_use" },
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const { registry, logStore } = registryWithFakeInspect();
  const orch = new Orchestrator({ cwd: dir, llm, registry, permission: new PermissionGate("bypass"), logStore, autoTriageAttachments: false });
  const result = await orch.run("fix the crash", { skipPlan: true, isBugFix: true });

  assert.equal(result.success, true);
  assert.ok(result.reproduction, "reproduce gate ran on a bug-fix");
  assert.equal(result.reproduction.reproduced, true, "the bug was observed before the edit");
  assert.ok(verifyOpenings.length >= 2, `the fix went through the staged verify spine, got ${verifyOpenings.length}`);
  assert.match(verifyOpenings[0], /INSTRUMENT/, "the fix's verify spine starts at INSTRUMENT");
  assert.match(verifyOpenings[verifyOpenings.length - 1], /DECIDE/, "and forces a verdict at the end");
  // Debugging is NOT QA: the header is the normal VERIFY WHAT YOU WROTE form.
  for (const o of verifyOpenings) assert.match(o, /VERIFY WHAT YOU WROTE/);

  await fs.rm(dir, { recursive: true, force: true });
});
