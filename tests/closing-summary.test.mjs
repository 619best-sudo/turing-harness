/**
 * Who writes the run's closing turn, and what it is asked to write.
 *
 * Two things used to go wrong on a read-only run, and they compounded:
 *
 *   1. A lone `conversation` hop had its `deliver` argument promoted verbatim to
 *      be the whole run's summary, skipping the summary turn entirely. `deliver`
 *      is hop-scoped by design — a handoff note to the next categorizer — so the
 *      run ended with nothing addressed to the user.
 *   2. The summary turn only knew how to summarize *work* ("summarize the work
 *      just done", "FILES CHANGED", 2-6 sentences). Pointing it at a run that
 *      answered a question would have thrown the answer away and narrated the
 *      looking instead.
 *
 * So the summary turn always runs, and on a run that changed nothing it is told
 * to ANSWER rather than to summarize. Both halves are pinned here, plus the
 * fallback that keeps a failed summary turn from ending the run in silence.
 *
 * All offline.
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
} from "../dist/index.js";
import { makeChainBridge, minimalPlan, writeEditScript } from "./helpers/chain-stub.mjs";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const msg = (content, stopReason = "stop") => ({
  role: "assistant", content, model: "test/cheap", api: "openrouter",
  provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
});

const DELIVER_NOTE = "HOP_SCOPED_DELIVER_NOTE — the handoff, not the answer.";
const COMPOSED = "COMPOSED_CLOSING_TURN — the answer addressed to the user.";

/**
 * One `conversation` hop that ends in `deliver`. `summaryReply` decides what the
 * summary turn returns — pass `null` to make that call fail.
 */
async function conversationRun({ summaryReply = COMPOSED } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "closing-summary-"));
  const seen = { summarySystems: [], summaryUsers: [] };

  const llm = new OpenRouterBridge();
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      return msg([{ type: "text", text: "CATEGORY: conversation" }]);
    }
    if (/closing summary/.test(sys)) {
      seen.summarySystems.push(sys);
      seen.summaryUsers.push(ctx.messages?.map((m) => m.content).join("\n") ?? "");
      if (summaryReply === null) throw new Error("summary turn is down");
      return msg([{ type: "text", text: summaryReply }]);
    }
    return msg([{ type: "text", text: "ok" }]);
  };

  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: msg([{
        type: "toolCall", id: "d1", name: "deliver", arguments: { summary: DELIVER_NOTE },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const orch = new Orchestrator({
    cwd: dir, llm, registry: new Registry(),
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap", prepare: "test/cheap" },
  });

  const events = [];
  orch.subscribe((e) => {
    if (e.type === "run_summary") events.push(e);
  });

  const result = await orch.run("in our harness, is deliver heuristics or semantics?");
  await fs.rm(dir, { recursive: true, force: true });
  return { result, seen, events };
}

test("a conversation-only run still gets a composed closing turn, not deliver's own note", async () => {
  const { result, seen, events } = await conversationRun();

  assert.equal(seen.summarySystems.length, 1,
    "the summary turn runs even when `conversation` was the only hop");
  assert.equal(result.summary, COMPOSED);
  assert.notEqual(result.summary, DELIVER_NOTE,
    "deliver is hop-scoped — it must never stand in as the run's closing turn");
  assert.equal(events.length, 1, "exactly one run_summary for the run");
  assert.equal(events[0].summary, COMPOSED);
});

test("the closing turn on a read-only run is told to ANSWER, not to summarize work", async () => {
  const { seen } = await conversationRun();
  const sys = seen.summarySystems[0];
  const user = seen.summaryUsers[0];

  assert.match(sys, /has to ANSWER it/,
    "a run that changed nothing was asked a question — the closing turn must answer it");
  assert.doesNotMatch(sys, /2-6 sentences/,
    "the work-report length cap must not clamp an answer");
  assert.match(user, /Answer the user's request/);
  assert.doesNotMatch(user, /Summarize the work just done/);

  // The record still has to reach it — an answer with no evidence is invention.
  assert.match(user, /WHAT EACH STEP DELIVERED/);
  assert.ok(user.includes(DELIVER_NOTE),
    "deliver's note is the summary turn's evidence, even though it is not the output");
});

test("a run that changed files keeps the work-report closing turn", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "closing-summary-write-"));
  const target = path.join(dir, "app.txt");
  const { llm, calls } = makeChainBridge({
    routerChoices: ["write_edit", "summarise"],
    planJson: minimalPlan(target, "write"),
    summaryText: "Wrote app.txt.",
    turns: writeEditScript({
      type: "toolCall", id: "w1", name: "write",
      arguments: { path: target, content: "hello" },
    }),
  });

  const orch = new Orchestrator({
    cwd: dir, llm, registry: new Registry(),
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap", prepare: "test/cheap" },
  });
  const result = await orch.run("write the app file");

  const summaryCtx = calls.complete.find((c) => /closing summary/.test(c.systemPrompt ?? ""));
  assert.ok(summaryCtx, "the summary turn ran");
  assert.match(summaryCtx.systemPrompt, /2-6 sentences/,
    "a run with writes reports the work, in the tight form");
  assert.doesNotMatch(summaryCtx.systemPrompt, /has to ANSWER it/);
  assert.equal(result.summary, "Wrote app.txt.");
  await fs.rm(dir, { recursive: true, force: true });
});

test("if the closing turn itself fails, the run falls back to a hop's note rather than going silent", async () => {
  const { result, events } = await conversationRun({ summaryReply: null });

  assert.equal(result.summary, DELIVER_NOTE,
    "a step-scoped answer beats no answer when the summary model is unreachable");
  assert.equal(events.length, 1, "the run still emits its one closing statement");
});
