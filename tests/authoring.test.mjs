/**
 * Tests for the authoring-model feature: when a TOOL-scoped permission decision
 * returns `authorModel`, a second model authors the on-disk bytes for write/edit
 * instead of the requesting model's draft.
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
} from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function usageWith(output) {
  return {
    input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

function newRegistryWithBuiltins() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg;
}

const MODEL_A = "test/model-a";
const MODEL_B = "test/model-b";

/**
 * Builds a stub bridge for a SINGLE-FILE write chain.
 *
 * - `stream` drives the phase turns. Prepare/Plan/Perfect return clean summaries.
 *   Perform's FIRST turn emits a single `write({path, content: DRAFT})` or
 *   `edit({path, oldString, newString})`; its SECOND turn (after the tool
 *   result) just closes with a summary.
 * - `complete` drives the authoring helper. It returns B_CONTENT (write) or
 *   B_REPLACEMENT (edit) plus a distinguishable usage so we can assert it was
 *   accounted into the chain total. It is also the bridge's `resolveModel`,
 *   which is permissive for unknown slugs.
 */
function makeStub({ mode, target, draft, oldString, bContent, bReplacement }) {
  const llm = new OpenRouterBridge();
  let performTurn = 0;
  const msg = (content) => ({
    role: "assistant",
    content: Array.isArray(content) ? content : [{ type: "text", text: content }],
    model: MODEL_A, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  const toolMsg = (content) => ({
    role: "assistant",
    content,
    model: MODEL_A, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
  });

  // The authoring helper uses llm.complete — Model B authors here. Route by the
  // user message (stable across prompt rewrites): an edit carries the anchor
  // ("TEXT TO REPLACE"), a write does not.
  llm.complete = async (_model, ctx) => {
    const userMsg = ctx.messages?.[0];
    const userText = typeof userMsg?.content === "string"
      ? userMsg.content
      : (userMsg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const isEdit = /TEXT TO REPLACE/.test(userText);
    const text = isEdit ? bReplacement : bContent;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      model: MODEL_B, api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };

  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const isPrepare = /PREPARE phase/.test(sys);
    const isPlan = /PLAN phase/.test(sys);
    const isPerform = /PERFORM phase/.test(sys);
    const isPerfect = /PERFECT phase/.test(sys);
    yield {
      type: "start",
      partial: {
        role: "assistant", content: [], model: MODEL_A, api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };

    if (isPrepare) {
      yield {
        type: "done",
        message: msg([
          "CATEGORY: backend",
          "PROJECT: Node library -> no runtime needed",
          "RUN: none", "STOP: none", "VERIFY: tests",
          "CAPABILITIES: none",
          "PROVIDER ASSIGNMENTS: PLAN => none, PERFORM => none, PERFECT => none",
          "FILE SEARCH:",
          `${target} | complexity=high | why=target file | blast=files=${target}`,
          "TOOL TRANSCRIPT:",
          `read | target=${target} | summary=Read the target`,
          "UI SUMMARY: Found the target file.",
          "TOOL CHAIN:",
          `read | target=${target} | reasoning=core | complexity=high`,
          "MEMORY UPDATES: none", "FILE MEMORY UPDATES: none",
          "SUMMARY: prepared a one-file change",
        ].join("\n")),
      };
      return;
    }

    if (isPlan) {
      const plan = {
        plans: [
          {
            id: "p1", title: "The change", summary: "update the file",
            tasks: [{
              id: "t1", order: 1, title: "update", summary: "change the file",
              files: [target], fileMutations: { [target]: mode }, complexity: "high",
            }],
          },
        ],
        executionOrder: ["p1"],
      };
      yield {
        type: "done",
        message: msg([
          "CHAT SUMMARY: One plan.",
          "PLANS_JSON:", JSON.stringify(plan),
          "PLAN: update the file.",
          "SUMMARY: A one-file implementation.",
          "ACCEPTANCE: file updated.",
          "UI SUMMARY: One file to change.",
          "TOOL CHAIN:",
          `read | target=${target} | reasoning=core | complexity=high`,
          "DEBUG_LOGS: read the file",
        ].join("\n")),
      };
      return;
    }

    if (isPerform) {
      performTurn += 1;
      if (performTurn === 1) {
        const call = mode === "edit"
          ? { type: "toolCall", id: "c1", name: "edit", arguments: { path: target, oldString, newString: draft } }
          : { type: "toolCall", id: "c1", name: "write", arguments: { path: target, content: draft } };
        yield { type: "done", message: toolMsg([call]) };
        return;
      }
      yield {
        type: "done",
        message: msg([
          "SUMMARY: Updated the file.",
          "UI SUMMARY: Updated the file.",
          "TOOL CHAIN: write | reasoning=applied | complexity=high",
          "CHANGES: wrote the file",
        ].join("\n")),
      };
      return;
    }

    if (isPerfect) {
      yield {
        type: "done",
        message: msg([
          "QA_PLAN:", JSON.stringify({ stack: "node", checks: [] }),
          "UI SUMMARY: Verified.",
          "TOOL CHAIN: test | reasoning=ran suite | complexity=low",
          "SUMMARY: Verified.",
          "VERDICT: PASS",
        ].join("\n")),
      };
      return;
    }
    yield { type: "done", message: msg("SUMMARY: done") };
  };

  return { llm };
}

async function runChainWithDecision(decision) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-auth-"));
  const target = path.join(tmp, "service.ts");
  await fs.writeFile(target, "LINE-A\nold-anchor\nLINE-C\n");

  const mode = decision.__mode ?? "write";
  const { llm } = makeStub({
    mode,
    target,
    draft: "MODEL_A_DRAFT",
    oldString: "old-anchor",
    bContent: "B_AUTHORED_FULL_CONTENT",
    bReplacement: "B_AUTHORED_REPLACEMENT",
  });

  const permissionCalls = [];
  const orch = new Orchestrator({
    cwd: tmp, llm, registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("ask-all", async (req) => {
      permissionCalls.push(req);
      return typeof decision === "function" ? decision(req) : decision;
    }),
    logStore: new LogStore(),
    maxChainIterations: 1,
  });

  const result = await orch.runChain("update the service");
  const onDisk = await fs.readFile(target, "utf8");
  return { result, onDisk, target, tmp, permissionCalls };
}

test("write + authorModel: Model B authors the file, not Model A", async () => {
  const { onDisk, result } = await runChainWithDecision({ allowed: true, authorModel: MODEL_B, __mode: "write" });
  assert.equal(onDisk, "B_AUTHORED_FULL_CONTENT",
    "disk must contain Model B's authored content, NOT Model A's draft");
  assert.notEqual(onDisk, "MODEL_A_DRAFT", "Model A's draft must not reach disk");
  assert.equal(result.success, true, "chain should succeed");
});

test("write + authorModel: Model B's authoring tokens are accounted in chain usage", async () => {
  const { result } = await runChainWithDecision({ allowed: true, authorModel: MODEL_B, __mode: "write" });
  // The authoring helper emitted a complete() call whose output token count was
  // bContent.length = 25. The phase turns return zero usage. So the chain total
  // must include exactly those authoring output tokens.
  assert.equal(result.usage.output, "B_AUTHORED_FULL_CONTENT".length,
    "chain usage.output must include Model B's authoring tokens");
  assert.ok(result.usage.cost.total > 0, "chain cost must reflect the authoring call");
});

test("edit + authorModel: Model B authors the replacement; anchor preserved", async () => {
  const { onDisk } = await runChainWithDecision({ allowed: true, authorModel: MODEL_B, __mode: "edit" });
  // old-anchor (Model A's anchor) is removed and B's replacement is inserted.
  assert.equal(onDisk, "LINE-A\nB_AUTHORED_REPLACEMENT\nLINE-C\n",
    "the anchor must be replaced with Model B's text, not Model A's draft");
  assert.ok(!onDisk.includes("MODEL_A_DRAFT"), "Model A's draft newString must not reach disk");
  assert.ok(!onDisk.includes("old-anchor"), "the anchor must have been replaced");
});

test("backward-compat: decision.model (no authorModel) writes Model A's bytes and only swaps the next turn", async () => {
  // decision.model has its original meaning ("B processes the result"). With no
  // authorModel, the write must put Model A's draft on disk.
  const { onDisk, result } = await runChainWithDecision({ allowed: true, model: MODEL_B, __mode: "write" });
  assert.equal(onDisk, "MODEL_A_DRAFT",
    "without authorModel, Model A's draft must be written");
  assert.equal(result.success, true);
});

test("authorModel is ignored for read (no authoring on non-mutating tools)", async () => {
  // A read decision with authorModel must not trigger authoring — read is not
  // write/edit. We can't easily get Perform to emit a read in this stub, so we
  // verify the runner never even resolves authorModel for non-mutating tools by
  // checking that a decision carrying authorModel on a read simply passes through
  // and the read returns disk bytes unchanged.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-auth-read-"));
  const target = path.join(tmp, "data.txt");
  await fs.writeFile(target, "ON-DISK-BYTES");

  const llm = new OpenRouterBridge();
  let performTurn = 0;
  const msg = (content) => ({
    role: "assistant",
    content: Array.isArray(content) ? content : [{ type: "text", text: content }],
    model: MODEL_A, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  // Authoring should never be invoked for a read. We can't assert complete()==0
  // because llm.complete has legitimate non-authoring callers (intent routing,
  // verdict elicitation). Instead we spy on tool executions: a read must not
  // trigger any write/edit, and the file must be unchanged. If authoring HAD
  // erroneously run, the file would contain this sentinel.
  llm.complete = async () => msg("SHOULD_NOT_BE_USED");
  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    yield { type: "start", partial: { role: "assistant", content: [], model: MODEL_A, api: "openrouter", provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (/PREPARE phase/.test(sys)) {
      yield { type: "done", message: msg([
        "CATEGORY: backend", "PROJECT: node", "RUN: none", "STOP: none", "VERIFY: tests",
        "CAPABILITIES: none", "PROVIDER ASSIGNMENTS: none",
        `FILE SEARCH: ${target} | complexity=low | why=data`,
        "TOOL TRANSCRIPT: none", "UI SUMMARY: found", "TOOL CHAIN: none",
        "MEMORY UPDATES: none", "FILE MEMORY UPDATES: none", "SUMMARY: prepared",
      ].join("\n")) };
      return;
    }
    if (/PLAN phase/.test(sys)) {
      const plan = { plans: [{ id: "p1", title: "x", summary: "x", tasks: [{ id: "t1", order: 1, title: "x", summary: "x", files: [target], fileMutations: { [target]: "read" }, complexity: "low" }] }], executionOrder: ["p1"] };
      yield { type: "done", message: msg(["PLANS_JSON:", JSON.stringify(plan), "SUMMARY: x", "UI SUMMARY: x", "ACCEPTANCE: x"]) };
      return;
    }
    if (/PERFORM phase/.test(sys)) {
      performTurn += 1;
      if (performTurn === 1) {
        yield { type: "done", message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: target } }], model: MODEL_A, api: "openrouter", provider: "test", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 } };
        return;
      }
      yield { type: "done", message: msg(["SUMMARY: read it", "UI SUMMARY: read it", "TOOL CHAIN: read | reasoning=core | complexity=low", "CHANGES: read"]) };
      return;
    }
    if (/PERFECT phase/.test(sys)) {
      yield { type: "done", message: msg(["UI SUMMARY: ok", "SUMMARY: ok", "VERDICT: PASS"]) };
      return;
    }
    yield { type: "done", message: msg("SUMMARY: done") };
  };

  const toolExecs = [];
  const orch = new Orchestrator({
    cwd: tmp, llm, registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("ask-all", async () => ({ allowed: true, authorModel: MODEL_B })),
    logStore: new LogStore(),
    maxChainIterations: 1,
  });
  orch.subscribe((e) => { if (e.type === "tool_execution_start") toolExecs.push(e.toolName); });

  await orch.runChain("read the data file");
  const onDisk = await fs.readFile(target, "utf8");
  assert.equal(onDisk, "ON-DISK-BYTES", "read must not mutate the file");
  assert.ok(!toolExecs.some((n) => n === "write" || n === "edit"),
    "no write/edit must execute on a read-only chain; got: " + JSON.stringify(toolExecs));
});

// ---------------------------------------------------------------------------
// The escalation contract, from the client's side: the permission request must
// carry the complexity the client decides on, and whatever model ends up
// authoring must be aimed at the places code actually breaks.
// ---------------------------------------------------------------------------

test("the write permission request carries the complexity the client decides on", async () => {
  const { permissionCalls } = await runChainWithDecision({ allowed: true, __mode: "write" });
  const write = permissionCalls.find((r) => r.name === "write");
  assert.ok(write, "the write call is gated");
  // Without a rating the client cannot tell a config tweak from a risky change,
  // and the escalate-or-accept decision degrades to a coin flip.
  assert.ok(["low", "medium", "high"].includes(write.complexityRating), `got ${write.complexityRating}`);
  assert.equal(write.complexityRating, "high", "the plan task rated this high, so the gate inherits high");
  assert.equal(write.complexitySource, "plan-task", "and says where the rating came from");
  assert.equal(typeof write.complexity.score, "number");
  assert.equal(write.mutates, true);
});

test("Model B gets the format contract AND the risk checklist for code write/edit", async () => {
  for (const mode of ["write", "edit"]) {
    const systems = [];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `harness-auth-sys-${mode}-`));
    const target = path.join(tmp, "service.ts");
    await fs.writeFile(target, "LINE-A\nold-anchor\nLINE-C\n");

    const { llm } = makeStub({
      mode, target, draft: "MODEL_A_DRAFT", oldString: "old-anchor",
      bContent: "B_AUTHORED_FULL_CONTENT", bReplacement: "B_AUTHORED_REPLACEMENT",
    });
    const inner = llm.complete;
    llm.complete = async (model, ctx, opts) => {
      systems.push(ctx.systemPrompt ?? "");
      return inner(model, ctx, opts);
    };

    const orch = new Orchestrator({
      cwd: tmp, llm, registry: newRegistryWithBuiltins(),
      permission: new PermissionGate("ask-all", async () => ({ allowed: true, authorModel: MODEL_B })),
      logStore: new LogStore(),
      maxChainIterations: 1,
    });
    await orch.runChain("update the service");

    // A `.ts` file is code, so the author gets the correctness checklist on top of
    // the format contract. The "prefer the boring version" closer stays gone — it
    // was the line that suppressed the work, not the enumeration.
    const authoring = systems.find((s) => /written to disk verbatim/.test(s));
    assert.ok(authoring, `${mode}: an authoring call happened`);
    assert.match(authoring, /written to disk verbatim/, `${mode}: format contract present`);
    assert.match(authoring, /no markdown code fences/, `${mode}: raw-output contract intact`);
    assert.match(authoring, /CONDITIONALS AND BRANCHES/, `${mode}: risk checklist present for code`);
    assert.match(authoring, /EXPENSIVE WORK/, `${mode}: cost/perf risks included`);
    assert.doesNotMatch(authoring, /prefer the boring/i, `${mode}: no 'be boring' framing`);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
