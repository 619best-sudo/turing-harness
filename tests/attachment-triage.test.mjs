/**
 * Tests for the attachment triage pre-pass: what the harness LEARNS from an
 * image before any work starts, and when it learns it.
 *
 * Two things the run depends on and neither is recoverable later:
 *
 *  1. VERBATIM TEXT. The triage's `describe` pass answers "what is this for" —
 *     a paraphrase, which is right for routing and wrong for content. When the
 *     attachment is reference material (a spec, a table of copy) or a defect
 *     report (an error dialog), the value IS the exact strings: the error code
 *     to grep for, the heading to reproduce character for character. So a
 *     second `ocr` pass runs for those categories and its output — not the
 *     paraphrase — becomes the media fact the authoring pass sees. A
 *     `ui-replicate` mockup is exempt: it is handed to a vision model at write
 *     time, which reads the copy off the image itself.
 *
 *  2. WHEN. The run-level pass only sees the attachments that existed at the
 *     start. A file the user drops onto a plan STEP while reviewing arrives
 *     later — and it is the attachment they chose most deliberately, so it gets
 *     the same treatment rather than reaching the work loop undifferentiated.
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
  registerBuiltins,
} from "../dist/index.js";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "test/cheap", api: "openrouter",
    provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/**
 * A harness wired to a stub bridge. `onAnalysis(lens)` returns the analysis text
 * for a media_analysis call; `turns` is the list of assistant turns the work
 * loop streams. Every lens call is recorded on `seen.lenses`.
 */
function makeOrchestrator({ dir, onAnalysis, turns, plan }) {
  const seen = { lenses: [], authoringPrompts: [], stepMessages: [] };
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text", "image"] });

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const reply = (text) => ({
      role: "assistant", content: [{ type: "text", text }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    });

    if (/router at the front/.test(sys)) return reply("ROUTE: TASK\nBUGFIX: NO");
    if (/precise media analyst/.test(sys)) {
      seen.lenses.push("describe");
      return reply(onAnalysis("describe"));
    }
    if (/You are an OCR engine/.test(sys)) {
      seen.lenses.push("ocr");
      return reply(onAnalysis("ocr"));
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      return reply(JSON.stringify(plan));
    }
    if (/written to disk verbatim/.test(sys)) {
      seen.authoringPrompts.push(JSON.stringify(ctx.messages));
      return reply("ok");
    }
    return reply("done");
  };

  let turn = 0;
  llm.stream = async function* (_model, ctx) {
    const last = ctx.messages[ctx.messages.length - 1];
    if (last?.role === "user" && typeof last.content === "string") seen.stepMessages.push(last.content);
    turn += 1;
    yield { type: "start", partial: assistant([]) };
    const next = turns[turn - 1];
    yield { type: "done", message: next ? next() : assistant([{ type: "text", text: "done" }]) };
  };

  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap", prepare: "test/cheap" },
    // Route writes to an authoring model so the authoring pass actually runs —
    // that pass is where `mediaFact` is consumed, so it is the only place the
    // triaged text is observable.
    routeModel: () => "test/author",
  });
  return { orch, seen };
}

/** A `write` the router will escalate (a `low` rating is never routed). */
function writeCall(target) {
  return assistant([{
    type: "toolCall", id: "w1", name: "write",
    arguments: { path: target, content: "DRAFT", complexity: "high" },
  }], "tool_use");
}

async function mkdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "triage-"));
}

// ---------------------------------------------------------------------------
// Verbatim text
// ---------------------------------------------------------------------------

test("an informational attachment gets a second OCR pass, and its verbatim text is what reaches the write", async () => {
  const dir = await mkdir();
  const shot = path.join(dir, "spec.png");
  await fs.writeFile(shot, "PNG");
  const target = path.join(dir, "out.ts");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: (lens) =>
      lens === "describe"
        ? "A screenshot of a spec sheet listing configuration values.\nCATEGORY: informational"
        : "MAX_RETRIES = 7\nTIMEOUT_MS = 4500\nCATEGORY: informational",
    plan: {
      plans: [{
        id: "plan-1", title: "Apply", summary: "apply the spec",
        tasks: [{
          id: "t1", order: 1, title: "Apply the values", summary: "use the spec values",
          files: [target], fileMutations: { [target]: "write" }, complexity: "low",
        }],
      }],
      executionOrder: ["plan-1"],
    },
    turns: [() => writeCall(target)],
  });

  await orch.run("apply the attached spec", {
    images: [{ path: shot, mimeType: "image/png" }],
    skipPlan: true,
  });

  assert.deepEqual(seen.lenses, ["describe", "ocr"], "route first, then read the text exactly");
  const authoring = seen.authoringPrompts.join("\n");
  assert.match(authoring, /MAX_RETRIES = 7/, "the exact values, not a description of them");
  assert.match(authoring, /TIMEOUT_MS = 4500/);
  assert.doesNotMatch(authoring, /screenshot of a spec sheet/, "the paraphrase is superseded, not appended");
});

test("a ui-bug screenshot is OCR'd too — the error text is the point of it", async () => {
  const dir = await mkdir();
  const shot = path.join(dir, "bug.png");
  await fs.writeFile(shot, "PNG");
  const target = path.join(dir, "Checkout.tsx");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: (lens) =>
      lens === "describe"
        ? "The checkout page rendering an error banner over the form.\nCATEGORY: ui-bug"
        : "Error 0x8007: payment provider unreachable\nCATEGORY: ui-bug",
    plan: { plans: [], executionOrder: [] },
    turns: [() => writeCall(target)],
  });

  await orch.run("fix what this screenshot shows", {
    images: [{ path: shot, mimeType: "image/png" }],
    skipPlan: true,
  });

  assert.deepEqual(seen.lenses, ["describe", "ocr"]);
  assert.match(
    seen.authoringPrompts.join("\n"),
    /0x8007/,
    "the code the run has to search for survives triage",
  );
});

test("a ui-replicate mockup is NOT OCR'd — the vision authoring pass reads it directly", async () => {
  const dir = await mkdir();
  const mockup = path.join(dir, "hero.png");
  await fs.writeFile(mockup, "PNG");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: () => "A dark two-column hero with a pill CTA.\nCATEGORY: ui-replicate",
    plan: { plans: [], executionOrder: [] },
    turns: [() => assistant([{ type: "text", text: "ok" }])],
  });

  await orch.run("build this hero", {
    images: [{ path: mockup, mimeType: "image/png" }],
    skipPlan: true,
  });

  assert.deepEqual(seen.lenses, ["describe"], "a second paid call here buys nothing");
});

test("an OCR failure degrades to the describe analysis rather than failing the run", async () => {
  const dir = await mkdir();
  const shot = path.join(dir, "note.png");
  await fs.writeFile(shot, "PNG");
  const target = path.join(dir, "migrate.ts");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: (lens) => {
      if (lens === "ocr") throw new Error("provider exploded");
      return "Notes about the migration order.\nCATEGORY: informational";
    },
    plan: { plans: [], executionOrder: [] },
    turns: [() => writeCall(target)],
  });

  const res = await orch.run("use the attached notes", {
    images: [{ path: shot, mimeType: "image/png" }],
    skipPlan: true,
  });

  assert.ok(!res.error, "an enrichment failure is not a run failure");
  assert.deepEqual(seen.lenses, ["describe", "ocr"]);
  assert.match(
    seen.authoringPrompts.join("\n"),
    /migration order/,
    "the fallback fact still reaches the write",
  );
});

// ---------------------------------------------------------------------------
// When: attachments the user pins during plan review
// ---------------------------------------------------------------------------

test("a file the user pins to a step during review is triaged before that step runs", async () => {
  const dir = await mkdir();
  const pinned = path.join(dir, "pinned.png");
  await fs.writeFile(pinned, "PNG");
  const target = path.join(dir, "Card.tsx");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: (lens) =>
      lens === "describe"
        ? "A console screenshot of the failing request.\nCATEGORY: informational"
        : "GET /api/cards 502 Bad Gateway\nCATEGORY: informational",
    plan: {
      plans: [{
        id: "plan-1", title: "Card", summary: "fix the card",
        tasks: [{
          id: "t1", order: 1, title: "Fix the card", summary: "handle the failure",
          files: [target], fileMutations: { [target]: "write" }, complexity: "low",
        }],
      }],
      executionOrder: ["plan-1"],
    },
    turns: [
      () => assistant([{
        type: "toolCall", id: "p1", name: "create_plan",
        arguments: { task: "fix the card", context: "the card fails to load" },
      }], "tool_use"),
      // Ends the planning loop; the write below then happens in the STEP loop,
      // which is the only place the step's own attachment is in scope.
      () => assistant([{ type: "text", text: "plan ready" }]),
      () => writeCall(target),
    ],
  });

  // The host approves the plan and attaches a file to step t1 — the review
  // round-trip, which happens after the run-level triage has already finished.
  orch.setPlanApprovalCallback(async () => ({
    approved: true,
    stepEdits: [{ taskId: "t1", attachments: [{ path: pinned, note: "the failing request" }] }],
  }));

  // No run-level images at all: everything below is the review attachment.
  await orch.run("fix the card", { skipPlan: false });

  assert.deepEqual(seen.lenses, ["describe", "ocr"], "the review attachment is understood, not just carried");
  const stepMsg = seen.stepMessages.find((m) => /FILES THE USER ATTACHED TO THIS STEP/.test(m));
  assert.ok(stepMsg, "the step message lists it");
  assert.match(stepMsg, /the failing request/, "the plan's why-this-step note survives");
  assert.match(stepMsg, /informational/, "alongside what the triage found it to BE");
  assert.match(seen.authoringPrompts.join("\n"), /502 Bad Gateway/, "its verbatim text reaches the write");
});

test("an attachment already triaged at run level is not paid for twice", async () => {
  const dir = await mkdir();
  const shot = path.join(dir, "shared.png");
  await fs.writeFile(shot, "PNG");
  const target = path.join(dir, "a.ts");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: (lens) =>
      lens === "describe" ? "Reference data.\nCATEGORY: informational" : "ROWS=12\nCATEGORY: informational",
    plan: {
      plans: [{
        id: "plan-1", title: "T", summary: "s",
        tasks: [{
          id: "t1", order: 1, title: "Do it", summary: "s",
          files: [target], fileMutations: { [target]: "write" }, complexity: "low",
        }],
      }],
      executionOrder: ["plan-1"],
    },
    turns: [
      () => assistant([{
        type: "toolCall", id: "p1", name: "create_plan",
        arguments: { task: "do it", context: "c" },
      }], "tool_use"),
      // Ends the planning loop; the write below then happens in the STEP loop,
      // which is the only place the step's own attachment is in scope.
      () => assistant([{ type: "text", text: "plan ready" }]),
      () => writeCall(target),
    ],
  });

  // The same file the run already carries is also pinned to the step.
  orch.setPlanApprovalCallback(async () => ({
    approved: true,
    stepEdits: [{ taskId: "t1", attachments: [{ path: shot, note: "same file" }] }],
  }));

  await orch.run("do it", { images: [{ path: shot, mimeType: "image/png" }], skipPlan: false });

  assert.deepEqual(seen.lenses, ["describe", "ocr"], "one triage for one file, however many places it appears");
});

test("a step attachment with no mimeType is classified, not fatal", async () => {
  const dir = await mkdir();
  const pinned = path.join(dir, "shot.png");
  await fs.writeFile(pinned, "PNG");
  const target = path.join(dir, "B.tsx");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: () => "text\nCATEGORY: informational",
    plan: {
      plans: [{
        id: "plan-1", title: "T", summary: "s",
        tasks: [{
          id: "t1", order: 1, title: "Do", summary: "s",
          files: [target], fileMutations: { [target]: "write" }, complexity: "high",
        }],
      }],
      executionOrder: ["plan-1"],
    },
    turns: [
      () => assistant([{
        type: "toolCall", id: "p1", name: "create_plan",
        arguments: { task: "do", context: "c" },
      }], "tool_use"),
      () => assistant([{ type: "text", text: "plan ready" }]),
      () => writeCall(target),
    ],
  });

  // A host UI dropping a file onto a step sends what it has — often just a path
  // and a note. `mimeType` is typed required, but the type cannot enforce
  // anything across that boundary, and an absent one used to take the whole run
  // down at step time, minutes after the user attached the file.
  orch.setPlanApprovalCallback(async () => ({
    approved: true,
    stepEdits: [{ taskId: "t1", attachments: [{ path: pinned, note: "look at this" }] }],
  }));

  const res = await orch.run("do it", { skipPlan: false });

  assert.ok(!res.error, "a missing mimeType must not end the run");
  assert.equal(res.steps[0]?.isCompleted, true);
  assert.deepEqual(seen.lenses, ["describe", "ocr"], "it is derived from the extension and treated as an image");
});

test("triage can be turned off wholesale", async () => {
  const dir = await mkdir();
  const shot = path.join(dir, "x.png");
  await fs.writeFile(shot, "PNG");

  const { orch, seen } = makeOrchestrator({
    dir,
    onAnalysis: () => "irrelevant\nCATEGORY: informational",
    plan: { plans: [], executionOrder: [] },
    turns: [() => assistant([{ type: "text", text: "ok" }])],
  });
  orch.config.autoTriageAttachments = false;

  await orch.run("look", { images: [{ path: shot, mimeType: "image/png" }], skipPlan: true });
  assert.deepEqual(seen.lenses, [], "opt-out means no analysis calls at all");
});
