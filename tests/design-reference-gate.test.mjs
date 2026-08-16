/**
 * Reference-sourcing gate for UI writes — the structural fix for the gap the
 * prompt-level advice ("call inspiration_generator") does not bind.
 *
 * The gate lives in `loop.ts` and engages only for a FRESH UI build: a `write`
 * to a UI/SVG path that does NOT already exist, with no image attached and no
 * prior design reference. In that case it auto-invokes `inspiration_generator`,
 * falling back to the design skill when that returns no match. Every other
 * write/edit — image attached, existing file, logic path — must NOT fire it, or
 * the gate would add a spurious LLM call to every ordinary UI edit.
 *
 * These tests pin the gate by counting how many `llm.complete` calls a single
 * `write` produces: one (just the authoring pass) when the gate is correctly
 * inactive, more than one when it fires (inspiration/skill + authoring).
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCodingTools,
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  runToolLoop,
} from "../dist/index.js";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/**
 * Drive ONE write call through the loop. Returns the prompts each `llm.complete`
 * call saw — so a test can tell whether the gate fired (inspiration/skill prompt
 * appears before the authoring prompt).
 */
async function runWrite({ target, fileExists = false, task = "Build a landing page" }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
  const abs = path.isAbsolute(target) ? target : path.join(dir, target);
  if (fileExists) await fs.writeFile(abs, "<div>old</div>");

  const completeCalls = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (model, ctx) => {
    const c = ctx.messages[0]?.content;
    completeCalls.push({
      model: model.openRouterSlug ?? model.id,
      system: ctx.systemPrompt ?? "",
      text: typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    });
    return {
      role: "assistant",
      content: [{ type: "text", text: "<title>Built</title>\n" }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "c1", name: "write", arguments: { path: abs } }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  const tools = createCodingTools({ authorOnlyWrites: true }).filter((t) => t.name === "write");

  await runToolLoop({
    task,
    userMessage: "go",
    tools,
    model: { id: "driver/model", openRouterSlug: "driver/model" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
  });

  await fs.rm(dir, { recursive: true, force: true });
  return { completeCalls };
}

// ---------------------------------------------------------------------------
// The gate must be INACTIVE for everything that is not a fresh UI build.
// ---------------------------------------------------------------------------

test("a write to an EXISTING UI file does NOT fire the gate (file is its own reference)", async () => {
  const r = await runWrite({ target: "page.html", fileExists: true });
  // Exactly one complete call: the authoring pass. No inspiration/skill preamble.
  assert.equal(r.completeCalls.length, 1, "only the authoring pass ran; the gate stayed inactive");
});

test("an image-attached UI write does NOT fire the gate (image is the reference)", async () => {
  // The image-present case is handled by REPLICATE_FROM_IMAGE in authoring, not
  // by the gate. We simulate attachment by passing images on the loop input.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-img-"));
  const target = path.join(dir, "fresh.html");
  const img = path.join(dir, "mock.png");
  await fs.writeFile(img, "PNG");

  const completeCalls = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (model, ctx) => {
    completeCalls.push({ model: model.openRouterSlug ?? model.id });
    return {
      role: "assistant", content: [{ type: "text", text: "<title>X</title>\n" }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "c1", name: "write", arguments: { path: target } }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  const tools = createCodingTools({ authorOnlyWrites: true }).filter((t) => t.name === "write");
  await runToolLoop({
    task: "replicate this page",
    userMessage: "go",
    tools,
    model: { id: "driver/model", openRouterSlug: "driver/model" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    images: [{ path: img, mimeType: "image/png" }],
  });

  await fs.rm(dir, { recursive: true, force: true });
  // The gate is image-gated OUT, so only the authoring pass runs.
  assert.equal(completeCalls.length, 1, "image-attached write did not fire the gate");
});

test("a write to a NON-UI path (logic) does NOT fire the gate", async () => {
  const r = await runWrite({ target: "logic.ts", task: "add a helper" });
  assert.equal(r.completeCalls.length, 1, "logic write did not fire the gate");
});

// ---------------------------------------------------------------------------
// The gate FIRES for the one case it exists for: a fresh UI build, no image.
// ---------------------------------------------------------------------------

test("a fresh UI write with no image FIRES the gate (design skill runs before authoring)", async () => {
  const r = await runWrite({ target: "fresh.html", fileExists: false, task: "Build a landing page" });
  // More than one complete call: the design skill (no inspiration registered in
  // this run) plus the authoring pass. This is the gate doing its job — the
  // authoring model is NOT writing blind.
  assert.ok(
    r.completeCalls.length >= 2,
    `expected the gate to fire (>=2 complete calls: skill + authoring), got ${r.completeCalls.length}`,
  );
  // And the first call's system prompt should be the design-skill prompt, not
  // the authoring format contract.
  assert.match(r.completeCalls[0].system, /design skill/i, "the design skill ran first");
});
