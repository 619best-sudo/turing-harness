/**
 * Reasoning has to survive a COMPACT transcript.
 *
 * `transcriptMode: "compact"` used to seed BOTH emission axes off with no way to
 * override them, and the only thing that could turn them back on was a tool
 * call's permission decision — which happens inside the loop, after a turn has
 * already streamed. Two consequences, both silent:
 *
 *   - the first turn's thinking was always dropped, and
 *   - a turn that called no tools (a plain answer) emitted no thinking at all.
 *
 * A host on compact could set `thinkingLevel` and still see nothing, forever,
 * with no error anywhere. These tests pin the seed behaviour and the override.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LogStore, OpenRouterBridge, PermissionGate, runToolLoop } from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/** A model that thinks, then answers — no tool calls, like a plain reply. */
function thinkingOnlyLlm() {
  const llm = new OpenRouterBridge();
  llm.stream = async function* () {
    const partial = msg([]);
    yield { type: "start", partial };
    partial.content.push({ type: "thinking", thinking: "" });
    yield { type: "thinking_start", contentIndex: 0, partial };
    partial.content[0].thinking = "weighing the options";
    yield { type: "thinking_delta", contentIndex: 0, delta: "weighing the options", partial };
    yield { type: "thinking_end", contentIndex: 0, content: "weighing the options", partial };
    yield {
      type: "done",
      message: msg([
        { type: "thinking", thinking: "weighing the options" },
        { type: "text", text: "Here is the answer." },
      ]),
    };
  };
  return llm;
}

async function runWith(overrides) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-reasoning-"));
  const events = [];
  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [],
    model: { id: "x", openRouterSlug: "x" },
    llm: thinkingOnlyLlm(),
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: (e) => events.push(e),
    cwd: tmp,
    ...overrides,
  });
  return events;
}

/**
 * Did the STREAM carry thinking to the host? Deliberately scoped to the
 * `message_*` lifecycle — those are the events a UI renders live, and they are
 * what the emission flags gate. `turn_end` is a separate, unfiltered channel
 * (the finished message, which `HarnessAgent` folds into its render
 * transcript), so counting it here would test nothing.
 */
function sawThinking(events) {
  return events.some((e) => {
    if (e.type === "message_start" || e.type === "message_update" || e.type === "message_end") {
      const content = e.message?.content ?? [];
      if (content.some((entry) => entry.type === "thinking")) return true;
    }
    return e.assistantMessageEvent?.type?.startsWith?.("thinking_") ?? false;
  });
}

test("full transcript emits reasoning (the baseline)", async () => {
  assert.ok(sawThinking(await runWith({})), "default (full) should emit thinking");
});

test("compact suppresses reasoning by default — that is the documented trade", async () => {
  assert.equal(
    sawThinking(await runWith({ transcriptMode: "compact" })),
    false,
    "compact seeds emission off",
  );
});

test("compact + emitReasoning shows thinking on a turn that calls no tools", async () => {
  // The regression this file exists for. Before the fix `emitReasoning` was
  // ignored whenever transcriptMode was compact, so this run emitted nothing —
  // and with no tool call there was never a permission decision to fix it.
  assert.ok(
    sawThinking(await runWith({ transcriptMode: "compact", emitReasoning: true })),
    "an explicit emitReasoning must win over the compact default",
  );
});

test("emitReasoning:false wins over a full transcript too — the override is symmetric", async () => {
  assert.equal(
    sawThinking(await runWith({ transcriptMode: "full", emitReasoning: false })),
    false,
    "an explicit false must be honored, not just an explicit true",
  );
});

test("a model that returns no thinking is called out, not silently accepted", async () => {
  // The failure that cost the most to find: reasoning IS requested, the model
  // has no reasoning capability, so nothing ever comes back — and the symptom
  // (an empty reasoning pane) is identical to an emission bug. The loop has to
  // say which of the two it was.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-noreason-"));
  const logStore = new LogStore();
  const llm = new OpenRouterBridge();
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    yield { type: "done", message: msg([{ type: "text", text: "42." }]) };
  };
  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [],
    model: { id: "no-reasoning/model", openRouterSlug: "no-reasoning/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore,
    emit: () => {},
    cwd: tmp,
    reasoning: "medium",
  });

  const warning = logStore
    .search({ tags: ["reasoning"] })
    .find((entry) => entry.level === "warn");
  assert.ok(warning, "a requested-but-absent reasoning level must be logged");
  assert.match(warning.message, /no turn returned any thinking/);
  assert.match(warning.message, /no-reasoning\/model/, "the warning must name the model");
});

test("no false alarm when the model does return thinking", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-reason-ok-"));
  const logStore = new LogStore();
  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [],
    model: { id: "x", openRouterSlug: "x" },
    llm: thinkingOnlyLlm(),
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore,
    emit: () => {},
    cwd: tmp,
    reasoning: "medium",
  });
  assert.equal(
    logStore.search({ tags: ["reasoning"] }).filter((e) => e.level === "warn").length,
    0,
    "thinking arrived, so there is nothing to warn about",
  );
});

/**
 * The conversation categorizer must honour the configured reasoning level.
 *
 * The router sends chat-shaped prompts to the `conversation` categorizer, whose
 * loop turn is a USER-VISIBLE assistant reply — so it must carry the configured
 * reasoning effort, not a hardcoded "off". (The genuinely internal calls — the
 * router, the summary turn — stay off deliberately.)
 */
test("the conversation categorizer asks the model to reason", async () => {
  const { Orchestrator, LogStore: LS, PermissionGate: PG, Registry } = await import("../dist/index.js");

  const seen = [];
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({
    id: slug, openRouterSlug: slug, reasoning: true, maxTokens: 32000,
    input: ["text"], cost: { input: 0, output: 0 },
  });
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      return msg([{ type: "text", text: "CATEGORY: conversation" }]);
    }
    if (/closing summary/.test(sys)) {
      return msg([{ type: "text", text: "391" }]);
    }
    return msg([{ type: "text", text: "ok" }]);
  };
  llm.stream = async function* (_model, _context, options) {
    seen.push(options?.reasoning);
    yield { type: "start", partial: msg([]) };
    yield {
      type: "done",
      message: msg([{ type: "toolCall", id: "d1", name: "deliver", arguments: { summary: "391" } }]),
      ...(false ? {} : {}),
    };
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-conv-reasoning-"));
  const orchestrator = new Orchestrator({
    llm,
    registry: new Registry(),
    permission: new PG("bypass"),
    logStore: new LS(),
    cwd: tmp,
  });
  orchestrator.setReasoning("high", "prepare");

  await orchestrator.run("What is 17*23?");

  assert.ok(seen.length >= 1, "expected at least one conversational stream call");
  assert.equal(seen[0], "high", `conversation reply must pass the configured level, got ${seen[0]}`);
});

test("the conversation categorizer sends nothing when no level is configured", async () => {
  const { Orchestrator, LogStore: LS, PermissionGate: PG, Registry } = await import("../dist/index.js");

  const seen = [];
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({
    id: slug, openRouterSlug: slug, reasoning: true, maxTokens: 32000,
    input: ["text"], cost: { input: 0, output: 0 },
  });
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      return msg([{ type: "text", text: "CATEGORY: conversation" }]);
    }
    if (/closing summary/.test(sys)) {
      return msg([{ type: "text", text: "391" }]);
    }
    return msg([{ type: "text", text: "ok" }]);
  };
  llm.stream = async function* (_model, _context, options) {
    seen.push("reasoning" in (options ?? {}) ? options.reasoning : "<absent>");
    yield { type: "start", partial: msg([]) };
    yield { type: "done", message: msg([{ type: "toolCall", id: "d1", name: "deliver", arguments: { summary: "391" } }]) };
  };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-conv-none-"));
  const orchestrator = new Orchestrator({
    llm, registry: new Registry(), permission: new PG("bypass"), logStore: new LS(), cwd: tmp,
  });

  await orchestrator.run("What is 17*23?");

  // Omitted, not "off" — an absent field means "provider default", which is what
  // an unconfigured host should get.
  assert.equal(seen[0], "<absent>");
});

/**
 * Truncated / invalid tool-call arguments must be diagnosed accurately.
 *
 * Providers stream tool arguments as JSON fragments. When the stream is cut off
 * mid-arguments (`finish_reason: "length"`) the buffer will not parse, and the
 * old behaviour reported it as `missing required argument 'path'` — which is
 * false: the model DID send `path`. The model then re-sent an identical call and
 * failed identically, on a loop. The message has to say the arguments were
 * unreadable, and say so differently when the cause was the token limit.
 */
test("unparseable tool arguments are reported as unreadable, not missing", async () => {
  const readTool = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute() {
      throw new Error("must never execute — the guard should reject first");
    },
  };

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    if (turn === 1) {
      // A call whose argument buffer was cut off mid-JSON, exactly as the bridge
      // preserves it, with the length stop reason that caused it.
      const m = msg(
        [{ type: "toolCall", id: "c1", name: "read", arguments: { _raw: '{"path":"/tmp/a.t' } }],
        "length",
      );
      yield { type: "start", partial: m };
      yield { type: "done", message: m };
      return;
    }
    const done = msg([{ type: "text", text: "understood" }]);
    yield { type: "start", partial: done };
    yield { type: "done", message: done };
  };

  const results = [];
  await runWith({
    llm,
    tools: [readTool],
    emit: (e) => {
      if (e.type === "tool_execution_end") results.push(e.result);
    },
  });

  assert.equal(results.length, 1, "the guard should reject exactly one call");
  const text = JSON.stringify(results[0]);
  assert.match(text, /not valid JSON/, `expected an unreadable-arguments message, got: ${text}`);
  assert.match(text, /token limit/, "a length-truncated call should name the token limit");
  assert.doesNotMatch(text, /missing required argument/, "must not claim the argument was missing");
});

/**
 * A tool screenshot must survive a text-only run model.
 *
 * `browser_take_screenshot` output is re-surfaced as a user message. Handing it
 * verbatim to a blind model makes the provider reject the whole request, so a
 * browser session dies on its first screenshot. With a vision model configured
 * the image is described instead and the run continues.
 */
test("a tool image is described by the vision model for a blind run model", async () => {
  const { resolveModel } = await import("../dist/index.js");

  const screenshot = {
    name: "browser_take_screenshot",
    description: "screenshot the page",
    parameters: { type: "object", properties: {} },
    async execute() {
      return {
        output: "captured",
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/png", data: "aGk=" },
        ],
      };
    },
  };

  const seenByVision = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (model) => {
    seenByVision.push(model.id);
    return msg([{ type: "text", text: "A login page with an email field." }]);
  };
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    const m =
      turn === 1
        ? msg(
            [{ type: "toolCall", id: "c1", name: "browser_take_screenshot", arguments: {} }],
            "toolUse",
          )
        : msg([{ type: "text", text: "done" }]);
    yield { type: "start", partial: m };
    yield { type: "done", message: m };
  };

  const toolResults = [];
  await runWith({
    llm,
    tools: [screenshot],
    // Text-only, exactly like the app's driver. (Was mimo-v2.5 until a live
    // OpenRouter check showed it reads images — see the catalog entry.)
    model: resolveModel("poolside/laguna-xs-2.1"),
    visionModel: "anthropic/claude-sonnet-4.5",
    emit: (e) => {
      if (e.type === "turn_end") toolResults.push(...(e.toolResults ?? []));
    },
  });

  assert.deepEqual(seenByVision, ["anthropic/claude-sonnet-4.5"], "vision model should be used");

  const media = toolResults.filter((m) => m.role === "user");
  assert.match(
    JSON.stringify(media),
    /login page with an email field/,
    "the description must reach the conversation",
  );
  assert.equal(
    media.some((m) => m.content.some((c) => c.type === "image")),
    false,
    "no raw image may be handed to a text-only model",
  );
});
