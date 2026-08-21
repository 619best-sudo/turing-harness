/**
 * The answer the user already gave, across hops.
 *
 * From a real run (`change title of delete account popup to be something else`):
 * the READ hop asked "What should the new title be for the delete account popup?",
 * the user answered "Test", read delivered — and then WRITE_EDIT asked "What
 * should the new title of the delete account popup be?". The same question, one
 * hop later, to the same user.
 *
 * Nothing carried the answer. Each hop is a fresh context whose opening restates
 * the ORIGINAL task ("something else" — unspecified forever), and the loop's
 * `clarification` string was hop-local: consumed by the authoring model inside
 * that hop and dropped at its end. `write_edit.accepts.tools` is empty, so no
 * ask_user_question record travelled either. The answer reached hop two only as
 * prose inside read's deliverable, which lost the argument against the verbatim
 * task line plus a page of guidance about asking when a value is unnamed.
 *
 * These tests cover both halves of the fix: the answer (and any file attached to
 * it) travels to every later hop, and the gate refuses a re-ask by handing back
 * the answer it is holding.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClarifyGate,
  LogStore,
  OpenRouterBridge,
  Orchestrator,
  PermissionGate,
  Registry,
  normalizeQuestion,
  registerBuiltins,
} from "../dist/index.js";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
const msg = (content, model = "test/a") => ({
  role: "assistant", content, model, api: "openrouter", provider: "test",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});
const toolMsg = (calls, model) => ({
  ...msg(calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })), model),
  stopReason: "tool_use",
});

function withBuiltins() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg;
}

/**
 * read asks the user for the missing value and delivers; write_edit then tries to
 * ask the SAME thing (paraphrased, as the real run did) before writing.
 */
function clarifyBridge({ target, answer, answerAttachments, reAsk = true }) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text", "image"] });
  const seen = { openings: [], turns: {}, asks: [], askResults: [] };
  let routerCalls = 0;

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      const order = ["read", "write_edit", "summarise"];
      return msg([{ type: "text", text: `CATEGORY: ${order[Math.min(routerCalls - 1, order.length - 1)]}` }]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "Retitle", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "retitle", summary: "x", files: [target], fileMutations: { [target]: "write" }, complexity: "low" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "Retitled the dialog." }]);
    return msg([{ type: "text", text: "ok" }]);
  };

  llm.stream = async function* (model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const opening = ctx.messages?.[0]?.content;
    if (typeof opening === "string") seen.openings.push({ sys, opening });
    const which = /READ categorizer/.test(sys) ? "read" : /WRITE\/EDIT categorizer/.test(sys) ? "write_edit" : "other";
    seen.turns[which] = (seen.turns[which] ?? 0) + 1;
    yield { type: "start", partial: msg([]) };

    if (which === "read") {
      if (seen.turns.read === 1) {
        yield { type: "done", message: toolMsg([["a1", "ask_user_question", {
          question: "What should the new title be for the delete account popup?",
          reason: "The current title is 'Delete account?'. You need to specify what to change it to.",
        }]]) };
        return;
      }
      yield { type: "done", message: toolMsg([["d1", "deliver", {
        files: [{ path: target, role: "view", lines: "10", snippet: "Text('Delete account?')" }],
        codeSummary: "The dialog title lives at line 10.",
      }]]) };
      return;
    }
    if (which === "write_edit") {
      // The re-ask comes first when scripted — the bug, reworded, exactly as the
      // real run did it. Then the ordinary write_edit sequence: plan, write,
      // deliver (a write before a plan is refused by the plan-first guard).
      const script = [
        ...(reAsk
          ? [["a2", "ask_user_question", {
              question: "What should the new title of the delete account popup be?",
              reason: "The task says 'something else' but does not say what.",
            }]]
          : []),
        ["p1", "create_plan", { task: "retitle the dialog" }],
        ["w1", "write", { path: target, content: "titled\n" }],
        ["d2", "deliver", { writes: [{ tool: "write", path: target, summary: "retitled" }], notes: "done" }],
      ];
      const step = script[Math.min(seen.turns.write_edit - 1, script.length - 1)];
      yield { type: "done", message: toolMsg([step]) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const askUserQuestion = async (request) => {
    seen.asks.push(request.question);
    return { text: answer, ...(answerAttachments ? { attachments: answerAttachments } : {}) };
  };
  return { llm, seen, askUserQuestion };
}

async function setup(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clarify-hop-"));
  const target = path.join(dir, "profile_screen.dart");
  await fs.writeFile(target, "old\n");
  const { llm, seen, askUserQuestion } = clarifyBridge({ target, answer: "Test", ...over });
  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry: withBuiltins(),
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
  });
  return { dir, target, seen, orch, askUserQuestion };
}

function openingFor(seen, label) {
  const re = label === "read" ? /READ categorizer/ : /WRITE\/EDIT categorizer/;
  return seen.openings.filter((o) => re.test(o.sys)).map((o) => o.opening);
}

test("an answered question reaches every later hop, ahead of the stale task text", async () => {
  const { dir, seen, orch, askUserQuestion } = await setup();
  const result = await orch.run("change title of delete account popup to be something else", { askUserQuestion });
  assert.equal(result.success, true, `error=${result.error}`);

  const [writeOpening] = openingFor(seen, "write_edit");
  assert.ok(writeOpening, "write_edit should have run");
  assert.match(writeOpening, /ALREADY ANSWERED BY THE USER/);
  assert.match(writeOpening, /What should the new title be for the delete account popup\?/);
  assert.match(writeOpening, /answered: Test/);
  assert.match(writeOpening, /OUTRANK the task text/);

  // The block must sit ABOVE the handed-over deliverable: the answer is not one
  // hop's finding, it is the user's instruction.
  assert.ok(
    writeOpening.indexOf("ALREADY ANSWERED") < writeOpening.indexOf("deliverable from read"),
    "the answer must precede upstream context",
  );

  // And the first hop, which asked it, is not told about its own question.
  const [readOpening] = openingFor(seen, "read");
  assert.ok(!readOpening.includes("ALREADY ANSWERED"), "the asking hop has the Q&A in its own transcript");

  await fs.rm(dir, { recursive: true, force: true });
});

test("re-asking an answered question is refused, with the answer handed back", async () => {
  const { dir, seen, orch, askUserQuestion } = await setup();
  const result = await orch.run("change title of delete account popup to be something else", { askUserQuestion });
  assert.equal(result.success, true, `error=${result.error}`);

  // The user is asked exactly once, by read. write_edit's paraphrase is refused
  // before it can reach the host.
  assert.deepEqual(seen.asks, ["What should the new title be for the delete account popup?"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a file attached to an answer travels with it", async () => {
  const png = path.join(os.tmpdir(), `clarify-mock-${process.pid}.png`);
  await fs.writeFile(png, "not-a-real-png");
  const { dir, seen, orch, askUserQuestion } = await setup({
    answer: "Use the copy in the mockup",
    answerAttachments: [{ path: png, mimeType: "image/png" }],
  });
  const result = await orch.run("change title of delete account popup to be something else", { askUserQuestion });
  assert.equal(result.success, true, `error=${result.error}`);

  const [writeOpening] = openingFor(seen, "write_edit");
  assert.match(writeOpening, /they attached:/);
  assert.ok(writeOpening.includes(png), "the attached file must be named to the later hop");

  await fs.rm(png, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
});

test("a hop that does not re-ask still gets the answer and writes once", async () => {
  const { dir, target, seen, orch, askUserQuestion } = await setup({ reAsk: false });
  const result = await orch.run("change title of delete account popup to be something else", { askUserQuestion });
  assert.equal(result.success, true, `error=${result.error}`);
  assert.equal(await fs.readFile(target, "utf8"), "titled\n");
  assert.deepEqual(seen.asks, ["What should the new title be for the delete account popup?"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("normalizeQuestion matches rewordings of the same question, not different ones", () => {
  const a = normalizeQuestion("What should the new title be for the delete account popup?");
  const b = normalizeQuestion("What should the new title of the delete account popup be?");
  assert.equal(a, b, "word order and filler must not change the key");
  assert.notEqual(a, normalizeQuestion("What colour should the delete button be?"));
  assert.notEqual(a, normalizeQuestion("Should the popup be removed entirely?"));
});

test("the gate refuses one re-ask, then stops interfering", () => {
  const gate = new ClarifyGate();
  gate.recordAnswer({ question: "What should the title be?", answer: "Test" });

  const first = gate.check("ask_user_question", { question: "What should the title be?" });
  assert.equal(first.kind, "block");
  assert.match(first.message, /already answered/);
  assert.match(first.message, /They answered: Test/);

  // A second attempt goes through: one refusal is the intervention, not a
  // deadlock — the same lesson `maxBlocks` encodes for the value gate.
  assert.equal(gate.check("ask_user_question", { question: "What should the title be?" }).kind, "allow");
  assert.equal(gate.toReport().reAsksRefused, 1);

  // A genuinely different question is never touched.
  assert.equal(gate.check("ask_user_question", { question: "Which file owns the dialog?" }).kind, "allow");
});

test("recording an answer satisfies the missing-value gate", () => {
  const gate = new ClarifyGate({ valueUnspecified: true });
  assert.equal(gate.check("write", { path: "/x" }).kind, "block", "a write before asking is refused");

  const armed = new ClarifyGate({ valueUnspecified: true });
  armed.recordAnswer({ question: "What should the title be?", answer: "Test" });
  assert.equal(armed.check("write", { path: "/x" }).kind, "allow", "the answer is what the gate was waiting for");
  assert.equal(armed.toReport().asked, true);
});

test("an answer carrying only files is still an answer", () => {
  const gate = new ClarifyGate();
  gate.recordAnswer({
    question: "Which mockup should this match?",
    answer: "(files only — see attachments)",
    attachments: [{ path: "/tmp/mock.png", mimeType: "image/png" }],
  });
  const decision = gate.check("ask_user_question", { question: "Which mockup should this match?" });
  assert.equal(decision.kind, "block");
  assert.match(decision.message, /\/tmp\/mock\.png/);
  assert.match(decision.message, /already in your attachment set/);
});
