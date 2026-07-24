/**
 * Tests for the multi-plan (PLANS_JSON), complexity-inheritance, common
 * handoff-parameter (uiSummary/toolChain/handoff), and QA-plan features.
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 *
 * All offline — a stub LLM drives a full Orchestrator.runChain with no network.
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
  defineSkill,
  PHASE_PROMPTS,
} from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function newRegistryWithBuiltins() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg;
}

/**
 * Stub that returns a two-plan PLANS_JSON. Each Perform pass writes to the one
 * file in its ACTIVE PLAN / allowlist, then finishes. Perfect passes.
 */
function makeMultiPlanStub({ fileA, fileB }) {
  const llm = new OpenRouterBridge();
  const openings = [];
  const msg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "x", api: "openrouter", provider: "x",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  llm.complete = async () => msg("TASK");
  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const opening = ctx.messages?.[0]?.content ?? "";
    openings.push({ sys, opening });
    const isPrepare = /PREPARE phase/.test(sys);
    const isPlan = /PLAN phase/.test(sys);
    const isPerform = /PERFORM phase/.test(sys);
    const isPerfect = /PERFECT phase/.test(sys);
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };

    if (isPerform && ctx.messages.length === 1) {
      // Write the file this plan owns — read the per-plan allowlist section, not
      // the whole opening (fileA also appears in the Prepare handoff of both).
      const allowlist = opening.split("PLAN FILES FOR DEVELOPMENT")[1] ?? opening;
      const target = allowlist.includes(fileB) ? fileB : fileA;
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `w-${target}`, name: "write", arguments: { path: target, content: "updated" } }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }

    if (isPrepare) {
      yield { type: "done", message: msg([
        "CATEGORY: backend",
        "PROJECT: Node library -> no runtime needed",
        "RUN: none (no runtime needed)", "STOP: none", "VERIFY: tests",
        "CAPABILITIES:", "none (built-in file/bash tools only)",
        "PROVIDER ASSIGNMENTS:", "PLAN => none", "PERFORM => none", "PERFECT => none",
        "FILE SEARCH:",
        `${fileA} | complexity=high | why=service module | blast=files=${fileA}; notes=core`,
        `${fileB} | complexity=low | why=config | blast=files=${fileB}`,
        "TOOL TRANSCRIPT:", `read | target=${fileA} | summary=Read the service`,
        "UI SUMMARY:", "Found the two files that matter.",
        "TOOL CHAIN:", `read | target=${fileA} | reasoning=core service | complexity=high`,
        "MEMORY UPDATES:", "none", "FILE MEMORY UPDATES:", "none",
        "SUMMARY: prepared a two-repo change",
      ].join("\n")) };
      return;
    }

    if (isPlan) {
      const plans = {
        plans: [
          {
            id: "plan-a", title: "Backend change", repo: "api",
            summary: "update the service",
            tasks: [{ id: "t1", order: 1, title: "edit service", summary: "change service", files: [fileA], fileMutations: { [fileA]: "write" }, complexity: "high" }],
          },
          {
            id: "plan-b", title: "Config change", repo: "web",
            summary: "update the config",
            tasks: [{ id: "t2", order: 1, title: "edit config", summary: "change config", files: [fileB], fileMutations: { [fileB]: "write" }, complexity: "low" }],
          },
        ],
        executionOrder: ["plan-a", "plan-b"],
      };
      yield { type: "done", message: msg([
        "CHAT SUMMARY:", "Two plans, run in order.",
        "PLANS_JSON:", JSON.stringify(plans),
        "PLAN:", "Plan A then Plan B.",
        "SUMMARY:", "A two-plan implementation.",
        "ACCEPTANCE:", "Both files updated.",
        "UI SUMMARY:", "Split into a **backend** and a **web** plan.",
        "TOOL CHAIN:", `read | target=${fileA} | reasoning=service | complexity=high`,
        "DEBUG_LOGS:", "read both files",
      ].join("\n")) };
      return;
    }

    if (isPerform) {
      yield { type: "done", message: msg([
        "SUMMARY:", "Updated the file for this plan.",
        "UI SUMMARY:", "Updated one file.",
        "TOOL CHAIN:", "write | reasoning=applied change | complexity=high",
        "CHANGES:", "wrote the file",
      ].join("\n")) };
      return;
    }

    if (isPerfect) {
      yield { type: "done", message: msg([
        "QA_PLAN:", JSON.stringify({ stack: "node", checks: [{ id: "c1", description: "files updated", method: "test", targets: [fileA, fileB], passed: true, evidence: "both present" }] }),
        "UI SUMMARY:", "Everything verified.",
        "TOOL CHAIN:", "test | reasoning=ran suite | complexity=low",
        "SUMMARY:", "Verified both files.",
        "VERDICT: PASS",
      ].join("\n")) };
      return;
    }
    yield { type: "done", message: msg("SUMMARY: done") };
  };
  return { llm, openings };
}

test("runChain executes one Perform per plan for a multi-plan (PLANS_JSON) task", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-mp-"));
  const fileA = path.join(tmp, "service.ts");
  const fileB = path.join(tmp, "config.ts");
  await fs.writeFile(fileA, "old-a");
  await fs.writeFile(fileB, "old-b");

  const { llm, openings } = makeMultiPlanStub({ fileA, fileB });
  const permissionRequests = [];
  const orch = new Orchestrator({
    cwd: tmp, llm, registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("bypass"), logStore: new LogStore(),
    maxChainIterations: 1,
  });
  orch.subscribe((e) => { if (e.type === "permission_request") permissionRequests.push(e.request); });

  const result = await orch.runChain("update both repos");

  // Plan produced a normalized two-plan PlanSet with execution order.
  const planSet = result.phases.plan?.planSet;
  assert.ok(planSet, "plan should produce a planSet");
  assert.equal(planSet.plans.length, 2, "two plans");
  assert.deepEqual(planSet.executionOrder, ["plan-a", "plan-b"]);

  // One Perform pass per plan → two ACTIVE PLAN openings.
  const performOpenings = [...new Set(openings.filter((o) => /PERFORM phase/.test(o.sys)).map((o) => o.opening))];
  assert.equal(performOpenings.length, 2, "two distinct Perform openings (one per plan)");
  assert.ok(performOpenings.some((o) => /ACTIVE PLAN.*Plan 1\/2/s.test(o)), "first Perform labelled plan 1/2");
  assert.ok(performOpenings.some((o) => /ACTIVE PLAN.*Plan 2\/2/s.test(o)), "second Perform labelled plan 2/2");

  // Both files were actually written.
  assert.equal(await fs.readFile(fileA, "utf8"), "updated");
  assert.equal(await fs.readFile(fileB, "utf8"), "updated");

  // Chain verified.
  assert.equal(result.success, true, "chain should verify");

  // Complexity inheritance: the write on the high-complexity fileA carried a
  // plan-task-sourced high rating on its permission request.
  const writeA = permissionRequests.find((r) => r.name === "write" && r.args?.path === fileA);
  assert.ok(writeA, "a write permission request for fileA");
  assert.equal(writeA.complexitySource, "plan-task");
  assert.equal(writeA.complexityRating, "high");
});

test("Perfect emits a normalized QA plan; every phase emits uiSummary + toolChain + handoff", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-mp-"));
  const fileA = path.join(tmp, "service.ts");
  const fileB = path.join(tmp, "config.ts");
  await fs.writeFile(fileA, "old-a");
  await fs.writeFile(fileB, "old-b");

  const { llm } = makeMultiPlanStub({ fileA, fileB });
  const orch = new Orchestrator({
    cwd: tmp, llm, registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("bypass"), logStore: new LogStore(),
    maxChainIterations: 1,
  });
  const result = await orch.runChain("update both repos");

  const prepare = result.phases.prepare;
  const perfect = result.phases.perfect;

  // Common handoff params on Prepare.
  assert.match(prepare?.uiSummary ?? "", /Found the two files/);
  assert.ok(prepare?.toolChain?.length, "prepare toolChain populated");
  assert.equal(prepare?.toolChain?.[0]?.complexity, "high");
  assert.equal(prepare?.handoff?.from, "prepare");
  assert.equal(prepare?.handoff?.to, "plan");

  // Perfect QA plan.
  assert.equal(perfect?.qaPlan?.stack, "node");
  assert.equal(perfect?.qaPlan?.checks?.length, 1);
  assert.equal(perfect?.qaPlan?.checks?.[0]?.method, "test");
  assert.equal(perfect?.qaPlan?.checks?.[0]?.passed, true);
});

test("prompts define the 4P contract, multi-plan output, QA plan, and common handoff params", () => {
  for (const p of ["prepare", "plan", "perform", "perfect"]) {
    assert.match(PHASE_PROMPTS[p], /THE 4P CONTRACT/, `${p} carries the shared 4P contract`);
    assert.match(PHASE_PROMPTS[p], /COMMON HANDOFF OUTPUTS/, `${p} carries the common handoff spec`);
    assert.match(PHASE_PROMPTS[p], /UI SUMMARY:/, `${p} emits UI SUMMARY`);
    assert.match(PHASE_PROMPTS[p], /TOOL CHAIN:/, `${p} emits TOOL CHAIN`);
  }
  assert.match(PHASE_PROMPTS.plan, /PLANS_JSON:/);
  assert.match(PHASE_PROMPTS.plan, /execution order/i);
  assert.match(PHASE_PROMPTS.plan, /"complexity" is exactly one of/);
  assert.match(PHASE_PROMPTS.perfect, /QA_PLAN:/);
  assert.match(PHASE_PROMPTS.perfect, /a plan-like handoff PERFORM can execute directly/);
  assert.match(PHASE_PROMPTS.perform, /EXECUTE TASKS IN ORDER/);
});

test("phase output contracts are consistent: shared SUMMARY/UI SUMMARY/TOOL CHAIN trailer, no redundant markers", () => {
  for (const p of ["prepare", "plan", "perform", "perfect"]) {
    // The single shared trailer, identical in every phase.
    assert.match(PHASE_PROMPTS[p], /SUMMARY:/, `${p} has SUMMARY`);
    assert.match(PHASE_PROMPTS[p], /UI SUMMARY:/, `${p} has UI SUMMARY`);
    assert.match(PHASE_PROMPTS[p], /TOOL CHAIN:/, `${p} has TOOL CHAIN`);
    assert.match(PHASE_PROMPTS[p], /three COMMON HANDOFF OUTPUTS/, `${p} references the shared trailer`);
    // Redundant / superseded markers must NOT be part of any phase's contract.
    assert.doesNotMatch(PHASE_PROMPTS[p], /"CHAT SUMMARY:"/, `${p} must not emit CHAT SUMMARY`);
    assert.doesNotMatch(PHASE_PROMPTS[p], /"TOOL TRANSCRIPT:"/, `${p} must not emit TOOL TRANSCRIPT`);
    assert.doesNotMatch(PHASE_PROMPTS[p], /"DEBUG_LOGS:"/, `${p} must not emit DEBUG_LOGS`);
  }
});

function makeReasoningStub() {
  const llm = new OpenRouterBridge();
  llm.complete = async () => ({ role: "assistant", content: [{ type: "text", text: "TASK" }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 });
  llm.stream = async function* () {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal reasoning here" },
        { type: "text", text: "CATEGORY: backend\nPROJECT: Node library\nSUMMARY: done\nUI SUMMARY: done\nTOOL CHAIN: none" },
      ],
      model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
    yield { type: "start", partial: { ...message, content: [] } };
    yield { type: "done", message };
  };
  return llm;
}

async function runPrepareWithDecision(decision) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-emit-"));
  const orch = new Orchestrator({
    cwd: tmp, llm: makeReasoningStub(), registry: newRegistryWithBuiltins(),
    // ask-all → the phase permission callback is consulted for every phase.
    permission: new PermissionGate("ask-all", async () => decision),
    logStore: new LogStore(),
  });
  const emitted = [];
  orch.subscribe((e) => { if (e.type === "message_end") emitted.push(e.message); });
  await orch.runPhase("prepare", "inspect");
  return emitted;
}

test("permission decision transcript/reasoning flags gate UI emission", async () => {
  const hasText = (msgs) => msgs.some((m) => m.content?.some((c) => c.type === "text"));
  const hasThinking = (msgs) => msgs.some((m) => m.content?.some((c) => c.type === "thinking"));

  // transcript:false → compact: only tool calls reach the UI (no text, no thinking).
  const compact = await runPrepareWithDecision({ allowed: true, transcript: false });
  assert.equal(hasText(compact), false, "compact must not emit text");
  assert.equal(hasThinking(compact), false, "compact must not emit reasoning");

  // transcript:true + reasoning:false → full text, but reasoning stripped.
  const noReasoning = await runPrepareWithDecision({ allowed: true, transcript: true, reasoning: false });
  assert.equal(hasText(noReasoning), true, "full transcript emits text");
  assert.equal(hasThinking(noReasoning), false, "reasoning:false strips thinking");

  // both true → text AND reasoning emitted.
  const both = await runPrepareWithDecision({ allowed: true, transcript: true, reasoning: true });
  assert.equal(hasText(both), true, "both → text emitted");
  assert.equal(hasThinking(both), true, "both → reasoning emitted");
});

test("defineSkill builds a phase-scoped skill provider", () => {
  const reg = new Registry();
  const tool = {
    name: "docs_fetch", description: "fetch reference docs",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute() { return { output: "ok" }; },
  };
  const item = reg.add(defineSkill({
    id: "skill:docs", name: "docs-helper",
    description: "reference docs for planning", phases: ["plan"], tools: [tool],
  }));
  assert.equal(item.kind, "skill");
  assert.deepEqual(item.phases, ["plan"]);
  assert.equal(item.tools[0].mutates, false);
  assert.deepEqual(reg.getToolsForPhase("plan").map((t) => t.name).includes("docs_fetch"), true);
  assert.equal(reg.getToolsForPhase("perform").some((t) => t.name === "docs_fetch"), false);
});
