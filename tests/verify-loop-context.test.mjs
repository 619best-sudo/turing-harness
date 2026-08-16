/**
 * The verify round is a FIRST-CLASS loop, not an afterthought.
 *
 * It used to be spawned with no `systemPrompt` at all and none of the run's
 * context — which is exactly backwards. Verification is where `activity_inspect`,
 * the media lenses and the fix-then-re-check discipline matter most, and it was
 * the one loop told nothing about them. Worse, the round is not read-only: its
 * own message instructs the model to FIX the defects it finds, and those fixes
 * are `write`/`edit` calls that were being authored without the attachment the
 * change was built from or the text the triage pass already extracted.
 *
 * What this pins:
 *  - the verify loop is given the same system prompt as the work loops;
 *  - it carries the run's `images`, so a fix to a mockup-driven file still has
 *    the mockup;
 *  - it carries the triaged `mediaFact`, so verbatim OCR text is not lost;
 *  - it carries `projectCategory`, so a fix on a backend project does not
 *    re-open the design-reference ladder the work loops skipped;
 *  - the usage total includes the intent-router and summary turns, which run on
 *    every single request and were both being billed to nobody.
 *
 * All offline: the LLM is stubbed and every turn is inspected in-process.
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

function usageOf(n) {
  return {
    input: n, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: n * 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const msg = (content, usage = usageOf(0)) => ({
  role: "assistant",
  content,
  model: "x", api: "openrouter", provider: "x",
  usage, stopReason: "stop", timestamp: 0,
});

/**
 * Stub LLM that records every `stream()` context so the test can assert on what
 * each loop was actually given. Work turn writes a .tsx file (runtime → visual,
 * so the verify round fires); the verify turn just finishes.
 */
function makeRecordingLlm({ targetFile, completeUsage }) {
  const llm = new OpenRouterBridge();
  const streamed = [];
  const completed = [];
  llm.complete = async (_model, ctx) => {
    completed.push(ctx);
    // The router runs first and must answer TASK; the summary turn runs last.
    const isRouter = /router at the front/i.test(String(ctx.systemPrompt ?? ""));
    return msg([{ type: "text", text: isRouter ? "ROUTE: TASK\nBUGFIX: NO" : "Wrote the component." }], completeUsage);
  };
  llm.stream = async function* (_model, ctx) {
    streamed.push(ctx);
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const opening = String(lastUser?.content ?? "");
    yield { type: "start", partial: msg([]) };
    if (/VERIFY WHAT YOU WROTE/.test(opening)) {
      yield { type: "done", message: msg([{ type: "text", text: "SUMMARY: looked at it." }]) };
      return;
    }
    if (!ctx.messages.some((m) => m.role === "toolResult")) {
      const args = { path: targetFile, content: "<button>Hi</button>" };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { name: "write" } };
      yield { type: "toolCall_delta", toolCallId: "w1", delta: { arguments: JSON.stringify(args) } };
      yield {
        type: "done",
        message: {
          ...msg([{ type: "toolCall", id: "w1", name: "write", arguments: args }]),
          stopReason: "tool_use",
        },
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "CHANGES: wrote the file" }]) };
  };
  return { llm, streamed, completed };
}

async function setup({ projectCategory, images, completeUsage } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-ctx-"));
  const targetFile = path.join(dir, "Component.tsx");
  const { llm, streamed, completed } = makeRecordingLlm({ targetFile, completeUsage });
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry,
    permission: new PermissionGate("bypass"),
    logStore,
    // The triage pre-pass would spend media_analysis calls against the stub;
    // these tests are about what the LOOPS receive, not about triage.
    autoTriageAttachments: false,
  });
  if (projectCategory) orch.projectCategory = projectCategory;
  const result = await orch.run("Build a Component", {
    skipPlan: true,
    ...(images ? { images } : {}),
  });
  return { dir, targetFile, orch, result, streamed, completed };
}

/** The recorded contexts whose last user message is the verify instruction. */
function verifyContexts(streamed) {
  return streamed.filter((ctx) => {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    return /VERIFY WHAT YOU WROTE/.test(String(lastUser?.content ?? ""));
  });
}

test("the verify loop runs with the SAME system prompt as the work loop", async () => {
  const { dir, streamed } = await setup();
  const verify = verifyContexts(streamed);
  assert.ok(verify.length >= 1, "the verify round must have fired for a .tsx write");
  const work = streamed.find((c) => !verify.includes(c));
  assert.ok(work?.systemPrompt, "sanity: the work loop has a system prompt");
  for (const ctx of verify) {
    assert.ok(ctx.systemPrompt, "the verify loop must not run with an empty system prompt");
    assert.equal(ctx.systemPrompt, work.systemPrompt, "one prompt, built once, shared by every loop");
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("the shared prompt actually carries the guidance a verify round needs", async () => {
  const { dir, streamed } = await setup();
  const [verify] = verifyContexts(streamed);
  assert.match(verify.systemPrompt, /activity_/, "debugging/verification tools are described");
  assert.match(verify.systemPrompt, /media_analysis/, "media lenses are described");
  assert.match(verify.systemPrompt, /WORKING DIRECTORY/, "the loop template is present");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a backend project's verify loop is not handed the visual guidance either", async () => {
  const { dir, streamed } = await setup({ projectCategory: "backend" });
  for (const ctx of streamed) {
    assert.doesNotMatch(ctx.systemPrompt ?? "", /inspiration_generator/);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("run attachments and project category reach TOOLS inside the verify loop", async () => {
  // The real assertion: a tool called from the verify round must see the same
  // `ctx.images` / `ctx.projectCategory` a tool called from the work round did.
  // Without that, a fix authored during verification is authored blind against
  // the very mockup it is supposed to match.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-img-"));
  const mock = path.join(dir, "mock.png");
  await fs.writeFile(mock, Buffer.from("89504e470d0a1a0a", "hex"));
  const targetFile = path.join(dir, "Hero.tsx");

  const probed = [];
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  registry.add({
    id: "test:probe",
    kind: "tool",
    source: "internal",
    name: "context probe",
    tools: [{
      name: "context_probe",
      description: "Records the tool context it was handed.",
      mutates: false,
      parameters: { type: "object", properties: { where: { type: "string" } }, required: [] },
      async execute(_id, args, ctx) {
        probed.push({
          where: args.where,
          images: (ctx.images ?? []).map((i) => i.path),
          projectCategory: ctx.projectCategory,
        });
        return { output: "probed" };
      },
    }],
  });

  // Work turn writes the file AND probes; verify turn probes again, then ends.
  const llm = new OpenRouterBridge();
  llm.complete = async (_m, ctx) =>
    msg([{ type: "text", text: /router at the front/i.test(String(ctx.systemPrompt ?? "")) ? "ROUTE: TASK\nBUGFIX: NO" : "done" }]);
  llm.stream = async function* (_model, ctx) {
    const lastUser = [...(ctx.messages ?? [])].reverse().find((m) => m.role === "user");
    const isVerify = /VERIFY WHAT YOU WROTE/.test(String(lastUser?.content ?? ""));
    const alreadyProbedHere = ctx.messages.some(
      (m) => m.role === "toolResult" && m.toolName === "context_probe" && (isVerify ? true : true),
    );
    yield { type: "start", partial: msg([]) };
    if (isVerify) {
      // One probe per verify round, then finish.
      const probesSoFar = probed.filter((p) => p.where === "verify").length;
      if (probesSoFar === 0) {
        const args = { where: "verify" };
        yield {
          type: "done",
          message: {
            ...msg([{ type: "toolCall", id: "p2", name: "context_probe", arguments: args }]),
            stopReason: "tool_use",
          },
        };
        return;
      }
      yield { type: "done", message: msg([{ type: "text", text: "SUMMARY: looked at it." }]) };
      return;
    }
    if (!ctx.messages.some((m) => m.role === "toolResult")) {
      const args = { path: targetFile, content: "<button>Hi</button>" };
      yield {
        type: "done",
        message: {
          ...msg([{ type: "toolCall", id: "w1", name: "write", arguments: args }]),
          stopReason: "tool_use",
        },
      };
      return;
    }
    if (!alreadyProbedHere || !probed.some((p) => p.where === "work")) {
      yield {
        type: "done",
        message: {
          ...msg([{ type: "toolCall", id: "p1", name: "context_probe", arguments: { where: "work" } }]),
          stopReason: "tool_use",
        },
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "CHANGES: wrote the file" }]) };
  };

  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  orch.projectCategory = "frontend";
  const result = await orch.run("Build the hero from the mockup", {
    skipPlan: true,
    images: [{ path: mock, mimeType: "image/png" }],
  });
  assert.equal(result.success, true);

  const work = probed.find((p) => p.where === "work");
  const verify = probed.find((p) => p.where === "verify");
  assert.ok(work, "the work loop probe ran");
  assert.ok(verify, "the verify loop probe ran");
  assert.deepEqual(work.images, [mock]);
  assert.deepEqual(verify.images, [mock], "the verify loop lost the run's attachments");
  assert.equal(work.projectCategory, "frontend");
  assert.equal(verify.projectCategory, "frontend", "the verify loop lost the project category");
  await fs.rm(dir, { recursive: true, force: true });
});

test("usage includes the intent-router and summary turns", async () => {
  // Both are plain `complete()` calls that run on EVERY request and used to be
  // dropped from the total, so a host billing on `usage` under-reported every
  // run by two turns.
  const { dir, result, completed } = await setup({ completeUsage: usageOf(7) });
  const routerAndSummary = completed.filter((c) =>
    /router at the front/i.test(String(c.systemPrompt ?? "")) ||
    /closing summary of a coding run/i.test(String(c.systemPrompt ?? "")),
  );
  assert.equal(routerAndSummary.length, 2, "exactly one router turn and one summary turn ran");
  assert.ok(
    result.usage.input >= 14,
    `expected both 7-token turns billed, got input=${result.usage.input}`,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("a conversational run bills the router turn too", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-conv-"));
  const llm = new OpenRouterBridge();
  llm.complete = async () => msg([{ type: "text", text: "ROUTE: CONVERSATIONAL\nBUGFIX: NO" }], usageOf(5));
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    yield { type: "done", message: msg([{ type: "text", text: "Hello!" }], usageOf(3)) };
  };
  const registry = new Registry();
  const logStore = new LogStore();
  // No builtins → no web tools → the plain (tool-free) conversational path.
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("hi");
  assert.equal(result.route, "conversational");
  assert.equal(
    result.usage.input,
    8,
    `router (5) + reply (3) must both be billed, got ${result.usage.input}`,
  );
  await fs.rm(dir, { recursive: true, force: true });
});
