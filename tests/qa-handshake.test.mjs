/**
 * Who does the QA — and the run that had to ask.
 *
 * The failure, from a development run on a Flutter app: the delete-account
 * dialog's title was changed in two files, the chain summarised, and the report
 * could say only that the files "were written to but does not indicate what the
 * new title value is or whether any verification was performed". No build, no
 * launch, no capture — and `ask_user_question` was never called once in the
 * whole run. `activity_inspect` was write_edit's only child and was never
 * entered.
 *
 * Three things had to be true for that to stop happening, and all three are
 * here:
 *
 *   1. FLOOR 0 — files written and never looked at cannot summarise. The verify
 *      hop is entered instead (route-policy).
 *   2. THE HANDSHAKE — that hop opens by asking the USER who does the QA (agent
 *      / they do it / skip), and nothing builds, runs, drives, captures or
 *      instruments until they have answered. Then the answer is obeyed.
 *   3. THE WALL NUDGE — a driving streak that is not moving the screen is told
 *      to ask rather than keep tapping, because a login is a question and not a
 *      puzzle.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODING_TOOLS,
  DEFAULT_CATEGORIZER_SETUP,
  LogStore,
  PermissionGate,
  applyPolicyToRouted,
  classifyQaMode,
  createDefaultCategorizers,
  createDeliverTool,
  decideFromDriver,
  enforceObserveFirst,
  enforceQaHandshake,
  nudgeAtWalls,
  qaModeFromClarifications,
  isOversizedRequestError,
  recallQaMode,
  runToolLoop,
  sleepThenTailTarget,
} from "../dist/index.js";

const CATS = createDefaultCategorizers();
const cat = (id) => CATS.find((c) => c.id === id);

const t = (name, over = {}) => ({
  name,
  description: `${name} does a thing`,
  parameters: { type: "object", properties: {} },
  async execute() {
    return { output: "ok" };
  },
  ...over,
});

const call = (tool, args = {}) => tool.execute("id", args, { cwd: process.cwd() });

/** An ask_user_question stand-in that answers the way a host with a callback does. */
const asker = (answer) =>
  t("ask_user_question", {
    async execute(_id, args) {
      return {
        output: `User answered: ${answer}\n(clarification for: ${args.question ?? "q"})`,
        details: { kind: "ask_user_question", answered: true, question: args.question ?? "q" },
      };
    },
  });

const qaTools = (answer, over = {}) => {
  const box = {};
  const asked = [];
  const ask = asker(answer);
  const spy = {
    ...ask,
    async execute(id, args, ctx) {
      asked.push(args.question ?? "");
      return ask.execute(id, args, ctx);
    },
  };
  const tools = enforceQaHandshake(
    [
      spy,
      t("bash"),
      t("mobile"),
      t("drive"),
      t("activity_inspect"),
      t("activity_trace_start"),
      t("media_analysis"),
      t("read"),
      t("add_log"),
    ],
    { box, ...over },
  );
  return { box, asked, T: (n) => tools.find((x) => x.name === n) };
};

// ---------------------------------------------------------------------------
// 1. The floor: written and unlooked-at work cannot summarise
// ---------------------------------------------------------------------------

const hop = (id, index, writtenPaths = []) => ({
  id,
  index,
  summary: `${id} ran`,
  delivered: true,
  toolRecords: [],
  writtenPaths,
  readPaths: [],
});

test("a development run that wrote files cannot summarise — it verifies first", () => {
  const decision = applyPolicyToRouted(
    {
      choices: [cat("activity_inspect")],
      hops: [hop("read", 0), hop("write_edit", 1, ["/lib/profile_screen.dart"])],
      queue: [],
      writtenPaths: ["/lib/profile_screen.dart"],
      // NOT a bug fix — this is the ordinary development task the old floors
      // never covered.
    },
    "summarise",
    "looks done",
    false,
  );
  assert.equal(decision.selection, "activity_inspect");
  assert.equal(decision.source, "policy");
  assert.match(decision.reason, /nothing has verified/);
});

test("the driver nominating summarise after its own writes is floored too", () => {
  const decision = decideFromDriver({
    choices: [cat("activity_inspect")],
    hops: [hop("write_edit", 0, ["/a.dart"])],
    queue: ["summarise"],
    writtenPaths: ["/a.dart"],
  });
  assert.equal(decision.selection, "activity_inspect");
  assert.equal(decision.source, "policy");
});

test("the floor is spent once the writes have been looked at", () => {
  const looked = {
    choices: [cat("write_edit")],
    hops: [hop("write_edit", 0, ["/a.dart"]), hop("activity_inspect", 1)],
    queue: [],
    writtenPaths: ["/a.dart"],
  };
  assert.equal(applyPolicyToRouted(looked, "summarise", "verified", false).selection, "summarise");

  // …and re-armed by the next write: a repair round owes a second look.
  const wroteAgain = {
    ...looked,
    choices: [cat("activity_inspect")],
    hops: [...looked.hops, hop("write_edit", 2, ["/a.dart"])],
  };
  assert.equal(applyPolicyToRouted(wroteAgain, "summarise", "fixed it", false).selection, "activity_inspect");
});

test("the floor stays out of the way of runs that owe nothing", () => {
  const base = {
    choices: [cat("activity_inspect")],
    hops: [hop("read", 0)],
    queue: [],
    writtenPaths: [],
  };
  // A read-only run ("explain the auth flow") ends when it is done.
  assert.equal(applyPolicyToRouted(base, "summarise", "r", false).selection, "summarise");
  // verify:false turns the whole thing off.
  assert.equal(
    applyPolicyToRouted(
      { ...base, hops: [hop("write_edit", 0, ["/a.dart"])], writtenPaths: ["/a.dart"], preferInspect: false },
      "summarise",
      "r",
      false,
    ).selection,
    "summarise",
  );
  // A setup with no verify hop cannot be sent to one.
  assert.equal(
    applyPolicyToRouted(
      { ...base, choices: [cat("write_edit")], hops: [hop("write_edit", 0, ["/a.dart"])], writtenPaths: ["/a.dart"] },
      "summarise",
      "r",
      false,
    ).selection,
    "summarise",
  );
});

// ---------------------------------------------------------------------------
// 2. The handshake
// ---------------------------------------------------------------------------

test("nothing runs, drives or instruments until the user has said who does the QA", async () => {
  for (const [name, args] of [
    ["bash", { command: "flutter run -d sim" }],
    ["mobile", { action: "launch" }],
    ["drive", { action: "open" }],
    ["activity_inspect", { expected: "the new title" }],
    ["add_log", { path: "/a.dart" }],
  ]) {
    // A fresh gate per tool: the refusal budget is per hop, and what is being
    // checked here is the SET of tools it covers.
    const { T } = qaTools("you do it");
    const res = await call(T(name), args);
    assert.equal(res.isError, true, `${name} must wait for the handshake`);
    assert.match(res.output, /who does\s+the QA|who does the QA/);
    assert.match(res.output, /You verify it/);
    assert.match(res.output, /Skip QA/);
  }

  // Orienting is still allowed — the gate is about RUNNING, not about looking
  // at source, and a shell command that runs nothing is not running anything.
  const { T } = qaTools("you do it");
  assert.notEqual((await call(T("read"), { path: "/a.dart" })).isError, true);
  assert.notEqual((await call(T("bash"), { command: "git status" })).isError, true);
});

test("the answer unlocks the pass when the user hands QA to the agent", async () => {
  const { T, box, asked } = qaTools("you verify it");
  await call(T("ask_user_question"), { question: "Who should verify this change?" });
  assert.equal(box.mode, "agent");
  assert.equal(asked.length, 1);
  assert.notEqual((await call(T("bash"), { command: "flutter run -d sim" })).isError, true);
  assert.notEqual((await call(T("activity_inspect"), {})).isError, true);
});

test("SKIP means nothing runs at all, and the hop says so instead", async () => {
  const { T, box } = qaTools("skip qa for now");
  await call(T("ask_user_question"), { question: "Who verifies this?" });
  assert.equal(box.mode, "skip");

  const res = await call(T("bash"), { command: "flutter run -d sim" });
  assert.equal(res.isError, true);
  assert.match(res.output, /SKIP QA/);
  assert.match(res.output, /no `verdict`/);
  assert.equal((await call(T("mobile"), { action: "launch" })).isError, true);
  assert.equal((await call(T("activity_inspect"), {})).isError, true);
});

test("MANUAL keeps the agent off the app but leaves it judging the evidence", async () => {
  const { T, box } = qaTools("I'll verify it myself");
  await call(T("ask_user_question"), { question: "Who verifies this?" });
  assert.equal(box.mode, "user");

  const drive = await call(T("mobile"), { action: "launch" });
  assert.equal(drive.isError, true, "the app is theirs to run");
  assert.match(drive.output, /requestAttachments/, "it is told how to get evidence back");
  assert.equal((await call(T("bash"), { command: "flutter run -d sim" })).isError, true);

  // Judging what they send back is exactly what this hop still does.
  assert.notEqual((await call(T("media_analysis"), { files: ["/shot.png"] })).isError, true);
  assert.notEqual((await call(T("add_log"), { path: "/a.dart" })).isError, true);
});

test("an answer given earlier in the run is not asked for again", async () => {
  const { T, box, asked } = qaTools("you do it", {
    priorAnswers: [{ question: "Who should do the QA on this change?", answer: "skip it this time" }],
  });
  assert.equal(box.mode, "skip", "the earlier answer stands on a repair round");
  const res = await call(T("mobile"), { action: "launch" });
  assert.equal(res.isError, true);
  assert.match(res.output, /SKIP QA/, "obeyed without re-asking");
  assert.equal(asked.length, 0);
});

test("the gate cannot deadlock a hop that will not ask", async () => {
  const { T } = qaTools("you do it", { maxBlocks: 2 });
  assert.equal((await call(T("mobile"), { action: "launch" })).isError, true);
  assert.equal((await call(T("mobile"), { action: "launch" })).isError, true);
  // Stood down: the run proceeds rather than spinning at the gate.
  assert.notEqual((await call(T("mobile"), { action: "launch" })).isError, true);
});

test("a hop with no way to ask is not held hostage to the question", async () => {
  const box = {};
  const tools = enforceQaHandshake([t("mobile"), t("bash")], { box });
  const res = await tools.find((x) => x.name === "mobile").execute("id", { action: "launch" }, {});
  assert.notEqual(res.isError, true);
});

test("a delegated QA pass owes no observation of its own at deliver", async () => {
  // enforceObserveFirst refuses an unobserved `deliver` — correct when the
  // agent is the one verifying, wrong when the user took the surface or waved
  // QA off. The two wrappers share the mode for exactly this.
  const box = {};
  const deliverBox = { delivered: false };
  const tools = enforceObserveFirst([t("mobile"), createDeliverTool(cat("activity_inspect"), deliverBox)], {
    qaMode: () => box.mode,
  });
  const deliver = tools.find((x) => x.name === "deliver");

  const refused = await call(deliver, { findings: "nothing run" });
  assert.equal(refused.isError, true, "an agent-driven pass still owes evidence");

  box.mode = "skip";
  const allowed = await call(deliver, { findings: "QA skipped at the user's request" });
  assert.notEqual(allowed.isError, true);
  assert.equal(deliverBox.delivered, true);
});

// ---------------------------------------------------------------------------
// 2b. The same handshake in the REPRODUCE hop — it drives the app too
// ---------------------------------------------------------------------------

test("the reproduce hop asks who makes the defect happen before it launches anything", async () => {
  for (const [name, args] of [
    ["bash", { command: "flutter run -d sim" }],
    ["mobile", { action: "launch" }],
    ["activity_trace_start", { startCommand: "flutter run" }],
    ["add_log", { path: "/a.dart" }],
  ]) {
    const { T } = qaTools("you do it", { role: "reproduce" });
    const res = await call(T(name), args);
    assert.equal(res.isError, true, `${name} must wait for the handshake`);
    assert.match(res.output, /who makes the defect happen/);
    assert.match(res.output, /You reproduce it/);
    assert.match(res.output, /straight to the fix/);
    // The verify wording must not leak into the pre-fix pass: there is nothing
    // to verify yet.
    assert.ok(!res.output.includes("Skip QA"), "asked about reproduction, not about QA of a change");
  }
});

test("SKIP in the reproduce hop hands the fixer an honest hypothesis", async () => {
  const { T, box } = qaTools("skip it, go straight to the fix", { role: "reproduce" });
  await call(T("ask_user_question"), { question: "Who should reproduce this bug?" });
  assert.equal(box.mode, "skip");

  const res = await call(T("mobile"), { action: "launch" });
  assert.equal(res.isError, true);
  assert.match(res.output, /straight to the fix/);
  assert.match(res.output, /reproduced: false/);
  assert.match(res.output, /suspects/);
});

test("MANUAL in the reproduce hop keeps the agent off their app but working from what they send", async () => {
  const { T, box } = qaTools("I'll reproduce it myself", { role: "reproduce" });
  await call(T("ask_user_question"), { question: "Who reproduces this?" });
  assert.equal(box.mode, "user");

  const drive = await call(T("mobile"), { action: "tap" });
  assert.equal(drive.isError, true);
  assert.match(drive.output, /requestAttachments/);
  assert.match(drive.output, /INVISIBLE defect/, "a screenshot of a normal screen proves nothing");
  assert.notEqual((await call(T("media_analysis"), { files: ["/shot.png"] })).isError, true);
});

test("a skipped reproduction still cannot claim the defect was witnessed", async () => {
  // The observe-first correction is what stops "we skipped it" becoming
  // "reproduced: true" in the fixer's input.
  const box = { mode: "skip" };
  const deliverBox = { delivered: false };
  const tools = enforceObserveFirst([t("mobile"), createDeliverTool(cat("activity_reproduce"), deliverBox)], {
    probesBeforeLaunch: true,
    qaMode: () => box.mode,
  });
  const deliver = tools.find((x) => x.name === "deliver");

  await call(deliver, { reproduced: true, symptom: "status never repaints", logPaths: [], suspects: [] });
  assert.equal(deliverBox.delivered, true, "not refused — nobody asked it to run anything");
  assert.equal(deliverBox.deliverable.reproduced, false, "corrected: nothing was witnessed");
  assert.match(deliverBox.deliverable.symptom, /NOT OBSERVED/);

  // Whereas when the USER drove, they ARE the witness and the claim stands.
  const userBox = { mode: "user" };
  const userDeliverBox = { delivered: false };
  const userTools = enforceObserveFirst(
    [t("mobile"), createDeliverTool(cat("activity_reproduce"), userDeliverBox)],
    { probesBeforeLaunch: true, qaMode: () => userBox.mode },
  );
  await call(userTools.find((x) => x.name === "deliver"), {
    reproduced: true,
    symptom: "they saw the status stay stale",
    logPaths: [],
    suspects: [],
  });
  assert.equal(userDeliverBox.deliverable.reproduced, true, "the user's report is evidence");
});

test("who is at the keyboard carries between the two passes; a skip does not", () => {
  // Who drives is a fact about the run — asking it again per hop is an
  // interrogation.
  assert.equal(recallQaMode({ reproduce: "user" }, "verify"), "user");
  assert.equal(recallQaMode({ verify: "agent" }, "reproduce"), "agent");
  // "skip the reproduction, I know what's broken" is not permission to ship the
  // fix unverified.
  assert.equal(recallQaMode({ reproduce: "skip" }, "verify"), undefined);
  assert.equal(recallQaMode({ verify: "skip" }, "reproduce"), undefined);
  // The role's own answer always wins.
  assert.equal(recallQaMode({ reproduce: "skip", verify: "agent" }, "reproduce"), "skip");
  assert.equal(recallQaMode(undefined, "verify"), undefined);
});

test("an earlier answer is recalled per role, never across the two questions", () => {
  const entries = [
    { question: "Who should reproduce this bug?", answer: "skip it" },
    { question: "What should the dialog title say?", answer: "Delete account?" },
  ];
  assert.equal(qaModeFromClarifications(entries, "reproduce"), "skip");
  assert.equal(qaModeFromClarifications(entries, "verify"), undefined, "the repro answer is not a QA answer");
  assert.equal(
    qaModeFromClarifications([{ question: "Who verifies this change?", answer: "you do it" }], "verify"),
    "agent",
  );
});

// ---------------------------------------------------------------------------
// 4. A driver that calls NOTHING is the one case no gate can see
// ---------------------------------------------------------------------------

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A bridge whose turns are scripted; records the user messages the loop injects. */
function scriptedLlm(turns) {
  const injected = [];
  const llm = {
    resolveModel: (slug) => ({ id: slug, openRouterSlug: slug }),
    complete: async (model) => ({
      role: "assistant", content: [{ type: "text", text: "ok" }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    }),
  };
  let turn = 0;
  llm.stream = async function* (model, ctx) {
    const last = ctx.messages[ctx.messages.length - 1];
    if (last?.role === "user") {
      const text = typeof last.content === "string"
        ? last.content
        : (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      injected.push(text);
    }
    const mk = (content, stopReason) => ({
      role: "assistant", content, model: model.openRouterSlug ?? model.id, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
    });
    yield { type: "start", partial: mk([], "stop") };
    const scripted = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    yield { type: "done", message: scripted(mk) };
  };
  return { llm, injected, turnsTaken: () => turn };
}

const inspectDef = DEFAULT_CATEGORIZER_SETUP.categories.find((c) => c.id === "activity_inspect");

const runQaLoop = async (turns, phase = "activity_inspect") => {
  const deliverBox = { delivered: false };
  const { llm, injected, turnsTaken } = scriptedLlm(turns);
  await runToolLoop({
    task: "change the delete-account dialog title",
    userMessage: "verify the change",
    tools: [t("mobile"), asker("you do it"), createDeliverTool(inspectDef, deliverBox)],
    model: { id: "test/xs", openRouterSlug: "test/xs" },
    llm,
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
    emit: () => {},
    cwd: process.cwd(),
    phase,
    label: `categorizer:${phase}`,
  });
  return { deliverBox, injected, turns: turnsTaken() };
};

test("a QA hop that answers with prose and calls nothing is sent back to step 0", async () => {
  // The field failure this pins: FLOOR 0 routed a finished write pass into
  // activity_inspect, the hop opened with 62 tools, and five seconds later it
  // "ended without calling deliver". ZERO tool calls — so the handshake gate,
  // observe-first and the freshness check all stayed silent, because every one
  // of them keys off a tool call. Prose is now answered, not accepted.
  const { injected, turns } = await runQaLoop([
    (mk) => mk([{ type: "text", text: "The change looks correct — the title was updated in both files." }], "stop"),
    (mk) => mk([{ type: "toolCall", id: "q", name: "ask_user_question", arguments: { question: "Who verifies this?" } }], "tool_use"),
    (mk) => mk([{ type: "toolCall", id: "d", name: "deliver", arguments: { findings: "the user is verifying it" } }], "tool_use"),
  ]);
  assert.ok(turns > 1, "the hop did not end on the prose turn");
  const note = injected.find((m) => /STEP 0/.test(m));
  assert.ok(note, `expected a step-0 re-prompt, got: ${JSON.stringify(injected)}`);
  assert.match(note, /ask_user_question/);
  assert.match(note, /you do it \/ they do it themselves \/ skip this pass/);
  assert.match(note, /Analysis in prose is not any of those three/);
});

test("the re-prompt is bounded — an honest empty hop still ends", async () => {
  const { injected, turns } = await runQaLoop([
    (mk) => mk([{ type: "text", text: "I cannot reach the app." }], "stop"),
  ]);
  // Two re-prompts, then the loop ends as it always did and the chain derives
  // its fallback deliverable. A gate that could not give up would be worse.
  assert.equal(turns, 3);
  assert.equal(injected.filter((m) => /STEP 0/.test(m)).length, 2);
});

test("the conversational path is untouched — prose IS the answer there", async () => {
  // One turn, no tools, no loop. A re-prompt here would turn "hi" into three
  // model calls, which is the opposite of what that path is for.
  const { injected, turns } = await runQaLoop(
    [(mk) => mk([{ type: "text", text: "Yes — Dart is null-safe by default since 2.12." }], "stop")],
    "conversation",
  );
  assert.equal(turns, 1);
  assert.equal(injected.filter((m) => /STEP 0/.test(m)).length, 0);
});

test("a delivered hop is never re-prompted", async () => {
  const { deliverBox, injected } = await runQaLoop([
    (mk) => mk([{ type: "toolCall", id: "d", name: "deliver", arguments: { findings: "checked it" } }], "tool_use"),
  ]);
  assert.equal(deliverBox.delivered, true);
  assert.equal(injected.filter((m) => /STEP 0/.test(m)).length, 0);
});

// ---------------------------------------------------------------------------
// Reading the user's words
// ---------------------------------------------------------------------------

test("the three answers are recognised in the words users actually use", () => {
  for (const text of ["skip", "Skip QA", "no qa needed", "don't verify it", "skip it, not needed"]) {
    assert.equal(classifyQaMode(text), "skip", text);
  }
  for (const text of ["I'll verify it myself", "manually", "I will check it", "let the user drive", "by hand"]) {
    assert.equal(classifyQaMode(text), "user", text);
  }
  for (const text of ["you verify it", "agent", "go ahead", "you drive", "automate it"]) {
    assert.equal(classifyQaMode(text), "agent", text);
  }
  // "skip it, I'll look later" carries both signals; the one that stops the
  // agent driving wins.
  assert.equal(classifyQaMode("skip it, I'll look later myself"), "skip");
  assert.equal(classifyQaMode(""), undefined);
  assert.equal(classifyQaMode(undefined), undefined);
});

test("the run's earlier Q&A is searched for the handshake, newest first", () => {
  assert.equal(
    qaModeFromClarifications([
      { question: "What should the dialog title say?", answer: "Delete account?" },
      { question: "Who should verify this change?", answer: "you do it" },
    ]),
    "agent",
  );
  // An unrelated Q&A is not mistaken for the handshake.
  assert.equal(
    qaModeFromClarifications([{ question: "What should the dialog title say?", answer: "skip the icon" }]),
    undefined,
  );
  assert.equal(qaModeFromClarifications(undefined), undefined);
});

// ---------------------------------------------------------------------------
// 3. A wall is a question, not a puzzle
// ---------------------------------------------------------------------------

test("two automation calls that go nowhere earn a nudge to ask, not a refusal", async () => {
  const stuck = t("mobile", {
    async execute() {
      return { output: "tap: element not found" };
    },
  });
  const tools = nudgeAtWalls([stuck, asker("use test@example.com")]);
  const mobile = tools.find((x) => x.name === "mobile");

  const first = await call(mobile, { action: "tap", target: "continue" });
  assert.ok(!first.output.includes("STUCK?"), "one miss is not a wall");
  const second = await call(mobile, { action: "tap", target: "continue" });
  assert.notEqual(second.isError, true, "a nudge never blocks the call");
  assert.match(second.output, /STUCK\? ASK, DO NOT KEEP TAPPING/);
  assert.match(second.output, /ask_user_question/);
  // The three shapes an answer can take — including the user doing that step.
  assert.match(second.output, /type the VALUE/);
  assert.match(second.output, /ATTACH the/);
  assert.match(second.output, /DO that one step themselves/);
});

test("asking ends the streak, and progress never gets nudged", async () => {
  let fail = true;
  const flaky = t("drive", {
    async execute() {
      return fail ? { output: "could not find the field", isError: true } : { output: "clicked" };
    },
  });
  const tools = nudgeAtWalls([flaky, asker("the password is hunter2")]);
  const drive = tools.find((x) => x.name === "drive");
  const ask = tools.find((x) => x.name === "ask_user_question");

  await call(drive, {});
  await call(ask, { question: "what is the password?" }); // the exit — streak over
  const afterAsk = await call(drive, {});
  assert.ok(!(afterAsk.output ?? "").includes("STUCK?"), "asking resets the count");

  fail = false;
  for (let i = 0; i < 5; i += 1) {
    const res = await call(drive, {});
    assert.ok(!res.output.includes("STUCK?"), "a pass that is getting somewhere is left alone");
  }
});

test("the nudge is bounded — it advises, it never becomes the transcript", async () => {
  const stuck = t("mobile", {
    async execute() {
      return { output: "no such element" };
    },
  });
  const tools = nudgeAtWalls([stuck], { maxNudges: 1 });
  const mobile = tools.find((x) => x.name === "mobile");
  await call(mobile, {});
  assert.match((await call(mobile, {})).output, /STUCK\?/);
  await call(mobile, {});
  assert.ok(!(await call(mobile, {})).output.includes("STUCK?"), "one nudge per cap, then silence");
});

// ---------------------------------------------------------------------------
// 5. Surviving the request that was too big
// ---------------------------------------------------------------------------

test("a 413 is a hiccup, not the end of the run", async () => {
  // The field failure: the verify hop asked the handshake, got "You verify it",
  // launched the app on the simulator — and then polled the build log three
  // times. The next request came back `OpenRouter stream failed (413): request
  // entity too large`, which ended the hop and the run, discarding a written
  // change and a user's answer over a problem whose whole remedy is "send less".
  const chatty = t("mobile", {
    async execute() {
      return { output: `screen dump\n${"x".repeat(30_000)}` };
    },
  });
  let turn = 0;
  const { llm } = scriptedLlm([
    (mk) => {
      turn += 1;
      // Fat tool results build the history that makes the request too big…
      if (turn <= 12) {
        return mk([{ type: "toolCall", id: `m${turn}`, name: "mobile", arguments: { action: "tap", target: `row ${turn}` } }], "tool_use");
      }
      // …then the provider rejects it once…
      if (turn === 13) {
        const m = mk([], "error");
        m.errorMessage = 'OpenRouter stream failed (413): {"statusCode":413,"message":"request entity too large"}';
        return m;
      }
      // …and the compacted retry gets through.
      return mk([{ type: "toolCall", id: "d", name: "deliver", arguments: { findings: "verified after the retry" } }], "tool_use");
    },
  ]);
  const deliverBox = { delivered: false };
  const logStore = new LogStore();
  const res = await runToolLoop({
    task: "verify the title change",
    userMessage: "go",
    tools: [chatty, createDeliverTool(inspectDef, deliverBox)],
    model: { id: "test/s", openRouterSlug: "test/s" },
    llm,
    permission: new PermissionGate("bypass"),
    logStore,
    emit: () => {},
    cwd: process.cwd(),
    phase: "activity_inspect",
  });
  assert.equal(deliverBox.delivered, true, `the hop finished on the retry (error=${res.error})`);
  assert.ok(!res.error, `no run-ending error, got: ${res.error}`);
  const note = logStore.entries.find((e) => e.tags?.includes("loop:oversized-request"));
  assert.ok(note, "the retry is on the record");
  assert.match(note.message, /compacted to [\d,]+ and retrying \(1\/2/);
});

test("errors a smaller request cannot fix are still fatal", () => {
  for (const m of [
    'OpenRouter stream failed (413): {"message":"request entity too large"}',
    "Error: maximum context length is 128000 tokens",
    "context_length_exceeded",
    "prompt is too long",
  ]) {
    assert.equal(isOversizedRequestError(m), true, m);
  }
  for (const m of [
    "OpenRouter stream failed (401): no auth credentials found",
    "OpenRouter stream failed (429): rate limited",
    "OpenRouter stream failed (400): invalid tool call",
    "socket hang up",
    undefined,
  ]) {
    assert.equal(isOversizedRequestError(m), false, String(m));
  }
});

test("sleep-and-tail polling is refused and pointed at waitMs", async () => {
  // The three calls that inflated the history in that run.
  assert.ok(sleepThenTailTarget("sleep 30 && tail -50 /tmp/turing-harness-bg/bash-123.log"));
  assert.ok(sleepThenTailTarget("sleep 60 && tail -80 /tmp/x.log"));
  assert.ok(sleepThenTailTarget("sleep 5; cat build.out"));
  // …and the legitimate shapes that must keep working.
  assert.equal(sleepThenTailTarget("tail -n 30 /tmp/x.log"), undefined, "reading a log once is fine");
  assert.equal(sleepThenTailTarget("sleep 20"), undefined, "waiting for a device to boot is fine");
  assert.equal(sleepThenTailTarget('grep -m5 -E "Error" /tmp/x.log'), undefined, "asking for one thing is fine");

  const bash = CODING_TOOLS.find((x) => x.name === "bash");
  const res = await bash.execute("id", { command: "sleep 30 && tail -50 /tmp/x.log" }, {
    cwd: process.cwd(),
    log: () => {},
  });
  assert.equal(res.isError, true);
  assert.match(res.output, /re-issue the ORIGINAL command/);
  assert.match(res.output, /waitMs/);
  assert.match(res.output, /does not start a second one|not start a second one/);
});
