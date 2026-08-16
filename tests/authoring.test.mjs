/**
 * Tests for the authoring-model feature: when a TOOL-scoped permission decision
 * returns `authorModel`, a second model authors the on-disk bytes for write/edit
 * instead of the requesting model's draft.
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 *
 * All offline — a stub LLM drives a full categorizer chain with no network.
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
  let routerCalls = 0;
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return msg(`CATEGORY: ${routerCalls <= 1 ? "write_edit" : "summarise"}`);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{ id: "p1", title: "The change", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "update", summary: "x", files: [target], fileMutations: { [target]: mode }, complexity: "high" }] }],
        executionOrder: ["p1"],
      };
      return msg(`PLANS_JSON:\n${JSON.stringify(plan)}`);
    }
    if (/closing summary/.test(sys)) {
      return msg("Chain summary.");
    }
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
    yield {
      type: "start",
      partial: {
        role: "assistant", content: [], model: MODEL_A, api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
    // The v2 chain runs ONE write_edit categorizer loop. Turn 0 plans, turn 1
    // mutates, turn 2 delivers.
    performTurn += 1;
    if (performTurn === 1) {
      yield { type: "done", message: toolMsg([{ type: "toolCall", id: "c-plan", name: "create_plan", arguments: { task: "update the service" } }]) };
      return;
    }
    if (performTurn === 2) {
      const call = mode === "edit"
        ? { type: "toolCall", id: "c1", name: "edit", arguments: { path: target, oldString, newString: draft } }
        : { type: "toolCall", id: "c1", name: "write", arguments: { path: target, content: draft } };
      yield { type: "done", message: toolMsg([call]) };
      return;
    }
    if (performTurn === 3) {
      yield { type: "done", message: toolMsg([{ type: "toolCall", id: "c2", name: "deliver", arguments: { writes: [{ tool: mode, path: target }], notes: "done" } }]) };
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
  });

  const result = await orch.run("update the service");
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
  // write/edit. The v2 route: read categorizer, one read tool call, deliver.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-auth-read-"));
  const target = path.join(tmp, "data.txt");
  await fs.writeFile(target, "ON-DISK-BYTES");

  const llm = new OpenRouterBridge();
  const msg = (content) => ({
    role: "assistant",
    content: Array.isArray(content) ? content : [{ type: "text", text: content }],
    model: MODEL_A, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  const toolMsg = (content) => ({
    role: "assistant", content, model: MODEL_A, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
  });
  // Authoring should never be invoked for a read; if it were, the sentinel
  // would land in an LLM call we assert never carries it.
  let authoringCalls = 0;
  let routerCalls = 0;
  llm.complete = async (_m, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return msg(`CATEGORY: ${routerCalls <= 1 ? "read" : "summarise"}`);
    }
    if (/closing summary/.test(sys)) return msg("read ok");
    authoringCalls += 1;
    return msg("SHOULD_NOT_BE_USED");
  };
  let turn = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    turn += 1;
    if (turn === 1) {
      yield { type: "done", message: toolMsg([{ type: "toolCall", id: "r1", name: "read", arguments: { path: target } }]) };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: toolMsg([{ type: "toolCall", id: "r2", name: "deliver", arguments: { files: [{ path: target }], codeSummary: "read it" } }]) };
      return;
    }
    yield { type: "done", message: msg("done") };
  };

  const toolExecs = [];
  const orch = new Orchestrator({
    cwd: tmp, llm, registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("ask-all", async () => ({ allowed: true, authorModel: MODEL_B })),
    logStore: new LogStore(),
  });
  orch.subscribe((e) => {
    if (e.type === "tool_execution_end" && e.toolName === "read") toolExecs.push(e);
  });
  const result = await orch.run("read the data file");
  const onDisk = await fs.readFile(target, "utf8");

  assert.equal(onDisk, "ON-DISK-BYTES", "the read must not mutate the file");
  assert.ok(toolExecs.length >= 1, "the read call executed");
  assert.equal(authoringCalls, 0, "no authoring pass may run for a read-only route");
  assert.equal(result.success, true);
});

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
    });
    await orch.run("update the service");

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
