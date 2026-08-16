/**
 * The conversational path may look things up — but must not touch the project.
 *
 * `classifyIntent` routes anything needing no PROJECT work to the conversational
 * reply, and that set is wider than small talk: "what's the current React
 * release?", "is this library maintained?", "what changed in Node 24?" all land
 * here. With no tools at all the model could only answer them from weights, so a
 * stale answer arrived stated confidently with nothing marking it stale.
 *
 * These pin both halves: lookup tools reach the path when the host registered
 * them, and NOTHING else does — a `read` or `grep` here would quietly turn the
 * cheap path into a second work loop with no budget or plan around it.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATIONAL_LOOKUP,
  CONVERSATIONAL_PROMPT,
  LogStore,
  OpenRouterBridge,
  Orchestrator,
  PermissionGate,
  Registry,
} from "../dist/index.js";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "test/cheap", api: "openrouter",
    provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

const stubTool = (name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: { query: { type: "string" } } },
  async execute() {
    return { output: `${name} result` };
  },
});

/**
 * Run one conversational turn. `extraTools` are registered as a provider, so the
 * orchestrator resolves them exactly as it would a host's real web provider.
 */
async function conversationalTurn({ extraTools = [], userText = "what is the latest react release?" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-lookup-"));
  const seen = { systems: [], toolsOffered: [], calledTools: [] };

  const llm = new OpenRouterBridge();
  // classifyIntent uses complete(); force the CONVERSATIONAL route.
  llm.complete = async (model) => {
    return msg([{ type: "text", text: "CONVERSATIONAL" }]);
  };

  let turn = 0;
  llm.stream = async function* (model, ctx, opts) {
    turn += 1;
    seen.systems.push(ctx.systemPrompt ?? "");
    seen.toolsOffered.push((opts?.tools ?? ctx.tools ?? []).map?.((t) => t.name) ?? []);
    yield { type: "start", partial: msg([]) };
    if (turn === 1 && extraTools.length) {
      yield { type: "done", message: msg([{
        type: "toolCall", id: "s1", name: "web_search", arguments: { query: "latest react release" },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "React 19 is current." }]) };
  };

  const registry = new Registry();
  if (extraTools.length) {
    registry.add({
      id: "test:web", kind: "mcp", source: "internal", name: "web",
      description: "web", tools: extraTools,
    });
  }

  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap", prepare: "test/cheap" },
  });

  const result = await orch.run(userText);
  return { seen, result };
}

test("with no web tools registered, the conversational path is unchanged — no tools, base prompt", async () => {
  const { seen } = await conversationalTurn();
  assert.equal(seen.systems.length, 1, "one turn, no loop");
  assert.equal(seen.systems[0], CONVERSATIONAL_PROMPT, "the base prompt is used verbatim");
  assert.doesNotMatch(seen.systems[0], /LOOKING THINGS UP/);
});

test("with web tools registered, the conversational path gains lookup", async () => {
  const { seen } = await conversationalTurn({ extraTools: [stubTool("web_search"), stubTool("web_fetch")] });
  assert.match(seen.systems[0], /LOOKING THINGS UP/, "the lookup clause is appended");
  assert.match(seen.systems[0], /You are a helpful, friendly coding assistant/, "on top of the base prompt");
});

test("the lookup clause keeps the no-project-access guarantee explicit", () => {
  assert.match(CONVERSATIONAL_LOOKUP, /does NOT extend to the user's project/);
  assert.match(CONVERSATIONAL_LOOKUP, /have not read their files/);
  // And it discourages searching for stable knowledge, so "hi" stays one turn.
  assert.match(CONVERSATIONAL_LOOKUP, /Do NOT search for stable conceptual questions/);
});

test("ONLY lookup tools reach the conversational path — never project tools", async () => {
  // The allowlist is the point: a read/grep here would make the cheap path a
  // second, unbounded work loop.
  const { seen } = await conversationalTurn({
    extraTools: [stubTool("web_search"), stubTool("read"), stubTool("grep"), stubTool("bash"), stubTool("write")],
  });
  const offered = seen.toolsOffered.flat();
  assert.ok(offered.length, "the turn was actually offered tools (guards against a vacuous assertion)");
  assert.ok(offered.includes("web_search"), "lookup is offered");
  for (const forbidden of ["read", "grep", "bash", "write"]) {
    assert.ok(!offered.includes(forbidden), `${forbidden} is NOT offered to a conversational turn`);
  }
});

test("an MCP-namespaced web tool is recognised too", async () => {
  const { seen } = await conversationalTurn({ extraTools: [stubTool("server__web_search")] });
  assert.match(seen.systems[0], /LOOKING THINGS UP/, "namespaced lookup still enables the clause");
});
