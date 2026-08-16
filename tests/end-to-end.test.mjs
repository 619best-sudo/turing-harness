/**
 * End-to-end: do the pieces built in isolation actually work TOGETHER, and does a
 * third party's tools get treated as first-class when the user loads them?
 *
 * Every other test file pins one tool's behaviour. This one runs a whole
 * `Orchestrator.run` and asserts the seams hold across it:
 *
 *   attachment → media_analysis (ui lens) → create_plan (routes the mockup to the
 *   step that needs it, host approves + adds a note) → per-step work loop → write
 *   escalated to a vision model because the step carries an image → isCompleted
 *   flipped on the plan → summary.
 *
 * Plus the extensibility contract: a skill and an MCP-shaped provider registered
 * by the host must resolve into phase toolsets, be callable inside the loop, be
 * listable, survive removal, and — for a server that connects mid-run — appear
 * without restarting the loop.
 *
 * All offline: a stub bridge stands in for every model call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LogStore,
  OpenRouterBridge,
  Orchestrator,
  PermissionGate,
  Registry,
  defineSkill,
  registerBuiltins,
  runToolLoop,
} from "../dist/index.js";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const VISION = { id: "test/vision", openRouterSlug: "test/vision", input: ["text", "image"] };
const CHEAP = { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"] };

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "test/cheap", api: "openrouter",
    provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

// ---------------------------------------------------------------------------
// The whole flow, one run
// ---------------------------------------------------------------------------

test("a mockup flows through analysis → plan → step → vision-authored write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-e2e-"));
  const mockup = path.join(dir, "hero.png");
  await fs.writeFile(mockup, "PNG-BYTES");
  const target = path.join(dir, "Hero.tsx");

  const seen = { lenses: [], authoredBy: [], planPrompts: [] };
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => (slug === "test/vision" ? VISION : { id: slug, openRouterSlug: slug, input: ["text"] });

  // complete(): the intent router, media_analysis, create_plan, authoring, summary.
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const reply = (text) => ({
      role: "assistant", content: [{ type: "text", text }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    });

    if (/router at the front/.test(sys)) return reply("TASK");

    // media_analysis, through whichever lens was asked for.
    if (/UI analyst/.test(sys)) {
      seen.lenses.push("ui");
      return reply("Hero: 2-column, dark bg #0b0b0f, 48px heading, CTA pill radius 999px.");
    }

    // create_plan: route the mockup to the hero step.
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      seen.planPrompts.push(ctx.messages[0].content);
      return reply(JSON.stringify({
        plans: [{
          id: "plan-1", title: "Hero", summary: "build the hero from the mockup",
          tasks: [{
            id: "t1", order: 1, title: "Build the hero", summary: "2-column hero per the mockup",
            files: [target], fileMutations: { [target]: "write" }, complexity: "high",
            verification: "matches the mockup at 1440px",
            attachments: [{ path: mockup, note: "the hero being built" }],
          }],
        }],
        executionOrder: ["plan-1"],
      }));
    }

    // The authoring pass for the write — routes on the minimal format contract.
    if (/written to disk verbatim/.test(sys)) {
      seen.authoredBy.push(model.openRouterSlug ?? model.id);
      assert.match(sys, /written to disk verbatim/, "authoring format contract present");
      return reply("export const Hero = () => <section className=\"hero\" />;");
    }

    return reply("Built the hero section from the attached mockup.");
  };

  // stream(): the work turns. Look at the mockup, plan, then write.
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: assistant([]) };
    if (turn === 1) {
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "m1", name: "media_analysis",
        arguments: { prompt: "what does this hero contain?", file: mockup, lens: "ui" },
      }], "tool_use") };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "p1", name: "create_plan",
        arguments: { task: "build the hero", context: "dark 2-column hero per the mockup" },
      }], "tool_use") };
      return;
    }
    if (turn === 3) {
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "w1", name: "write",
        arguments: { path: target, content: "DRAFT", images: [mockup] },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: assistant([{ type: "text", text: "done" }]) };
  };

  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });

  const approvals = [];
  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    toolModelCandidates: ["test/cheap", "test/vision"],
    models: { plan: "test/cheap", perform: "test/cheap" },
  });

  const result = await orch.run("Build the hero from the attached mockup", {
    images: [{ path: mockup, mimeType: "image/png" }],
    planApproval: async (req) => {
      approvals.push(req);
      return { approved: true, stepEdits: [{ taskId: "t1", notes: "Keep the CTA above the fold." }] };
    },
  });

  // 1. The mockup was actually LOOKED at, through the rebuild-spec lens.
  assert.deepEqual(seen.lenses, ["ui"]);

  // 2. The planner was told what the run carries, so it could route it.
  assert.ok(seen.planPrompts[0].includes(mockup), "the planner sees the attachment");
  assert.match(seen.planPrompts[0], /ATTACHMENTS/);

  // 3. The plan reached the host for approval, and the host's note stuck to the step.
  assert.equal(approvals.length, 1);
  const task = result.planSet.plans[0].tasks[0];
  assert.equal(task.userNotes, "Keep the CTA above the fold.");
  assert.equal(task.attachments[0].path, mockup, "routed to the step that needs it");

  // 4. The write escalated to a VISION model because the step carries an image —
  //    with no host `authorModel` pinned anywhere in this run.
  assert.deepEqual(seen.authoredBy, ["test/vision"]);
  assert.equal(await fs.readFile(target, "utf8"), 'export const Hero = () => <section className="hero" />;');

  // 5. Completion is the harness's, and it flipped once the step's loop ended.
  assert.equal(task.isCompleted, true);
  assert.equal(result.steps[0].isCompleted, true);
  assert.equal(result.steps[0].complexity, "high");

  // 6. The run reports what a user reads.
  assert.match(result.summary, /hero/i);
  assert.equal(result.success, true);
  assert.ok(result.usage.totalTokens >= 0);

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Third-party providers: skills and MCP servers the user loads
// ---------------------------------------------------------------------------

/** A skill the host registers, scoped to two phases. */
const designSkill = defineSkill({
  id: "skill:design",
  name: "design-tokens",
  description: "Reads the project's design tokens.",
  phases: ["plan", "perform"],
  tools: [{
    name: "design_tokens",
    description: "Return the project's design tokens.",
    parameters: { type: "object", properties: { scope: { type: "string" } } },
    async execute() {
      return { output: "primary=#0b0b0f radius=999px", details: { primary: "#0b0b0f" } };
    },
  }],
});

/** An MCP-shaped provider (what `addMcpServer` produces once connected). */
function fakeMcpProvider(calls) {
  return {
    id: "mcp:figma",
    kind: "mcp",
    source: "external",
    name: "figma",
    description: "Figma file access.",
    tools: [{
      name: "figma_get_frame",
      description: "Fetch a frame from a Figma file.",
      mutates: false,
      parameters: { type: "object", properties: { frame: { type: "string" } }, required: ["frame"] },
      async execute(_id, args) {
        calls.push(args.frame);
        return { output: `frame ${args.frame}: 1440x900, dark` };
      },
    }],
  };
}

test("a user-loaded skill and MCP server are first-class: listed, phase-scoped, removable", async () => {
  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  registry.add(designSkill);
  registry.add(fakeMcpProvider([]));

  // Listed alongside the builtins, with their own source + kind.
  const listed = registry.list();
  const skill = listed.find((p) => p.id === "skill:design");
  const mcp = listed.find((p) => p.id === "mcp:figma");
  assert.equal(skill.kind, "skill");
  assert.equal(skill.source, "external");
  assert.equal(mcp.kind, "mcp");
  assert.ok(mcp.tools.some((t) => t.name === "figma_get_frame"));

  // Phase scoping is honoured: the skill declared plan+perform and appears in
  // exactly those, so a host's routing is not silently ignored.
  const inPhase = (phase, name) => registry.selectPhaseTools(phase).some((t) => t.name === name);
  assert.ok(inPhase("plan", "design_tokens"));
  assert.ok(inPhase("perform", "design_tokens"));
  assert.ok(!inPhase("prepare", "design_tokens"));

  // An external provider is removable, and takes its tools with it.
  assert.equal(await registry.remove("mcp:figma"), true);
  assert.ok(!registry.allTools().some((t) => t.name === "figma_get_frame"));
  // A second removal is honest about there being nothing to remove.
  assert.equal(await registry.remove("mcp:figma"), false);
});

test("third-party tools are callable in the loop, and a mid-run server is picked up", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-e2e-mcp-"));
  const figmaCalls = [];
  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  registry.add(designSkill);

  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: assistant([]) };
    if (turn === 1) {
      // A skill tool, called like any other.
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "s1", name: "design_tokens", arguments: { scope: "hero" },
      }], "tool_use") };
      return;
    }
    if (turn === 2) {
      // The MCP server connected between turns; its tool must be reachable now
      // without restarting the loop.
      registry.add(fakeMcpProvider(figmaCalls));
      yield { type: "done", message: assistant([{ type: "text", text: "checking the frame next" }]) };
      return;
    }
    yield { type: "done", message: assistant([{ type: "text", text: "done" }]) };
  };

  // First loop: the skill tool runs.
  const first = await runToolLoop({
    task: "read the tokens",
    userMessage: "go",
    tools: registry.allTools(),
    resolveTools: () => registry.allTools(),
    model: CHEAP,
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    registry,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
  });
  const skillResult = first.messages.find((m) => m.role === "toolResult" && m.toolName === "design_tokens");
  assert.ok(skillResult, "the skill tool executed");
  assert.match(skillResult.content[0].text, /primary=#0b0b0f/);

  // The mid-run registration is visible to the NEXT turn's tool list, which is
  // the whole point of `resolveTools`.
  assert.ok(registry.allTools().some((t) => t.name === "figma_get_frame"));

  // Second loop: the newly-connected MCP tool is callable.
  let called = false;
  llm.stream = async function* () {
    yield { type: "start", partial: assistant([]) };
    if (!called) {
      called = true;
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "f1", name: "figma_get_frame", arguments: { frame: "hero" },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: assistant([{ type: "text", text: "done" }]) };
  };
  const second = await runToolLoop({
    task: "read the frame",
    userMessage: "go",
    tools: registry.allTools(),
    resolveTools: () => registry.allTools(),
    model: CHEAP,
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    registry,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
  });
  assert.deepEqual(figmaCalls, ["hero"], "the MCP tool ran with its real arguments");
  assert.ok(second.messages.some((m) => m.role === "toolResult" && m.toolName === "figma_get_frame"));

  await fs.rm(dir, { recursive: true, force: true });
});

test("third-party tools pass through the permission gate like builtins", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-e2e-perm-"));
  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  registry.add(designSkill);

  const requests = [];
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: assistant([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: assistant([{
        type: "toolCall", id: "s1", name: "design_tokens", arguments: { scope: "hero" },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: assistant([{ type: "text", text: "ok" }]) };
  };

  const result = await runToolLoop({
    task: "tokens",
    userMessage: "go",
    tools: registry.allTools(),
    model: CHEAP,
    llm,
    permission: new PermissionGate("ask-all", async (req) => {
      requests.push(req);
      // A host must be able to DENY a third-party tool and have the run continue.
      return { allowed: false, reason: "not approved for this run" };
    }),
    registry,
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
  });

  assert.equal(requests.length, 1, "the skill tool was gated, not waved through");
  assert.equal(requests[0].name, "design_tokens");
  assert.equal(typeof requests[0].complexity.score, "number");
  const denied = result.messages.find((m) => m.role === "toolResult" && m.toolName === "design_tokens");
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not approved for this run/);

  await fs.rm(dir, { recursive: true, force: true });
});
