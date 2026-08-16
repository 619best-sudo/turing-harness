/**
 * `ask_user_question` — the escape hatch from guessing.
 *
 * Two failure modes pull in opposite directions: an agent that never asks builds a
 * day of work on an architecture the user did not want; an agent that asks
 * constantly hands back the job it was given. So what is tested here is the shape
 * of a *good* question — offered choices with their trade-offs, one recommendation,
 * an honest phase label — plus the plumbing that makes the answer come back into
 * the same conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASKING_THE_USER,
  LOOP_SYSTEM_PROMPT,
  LogStore,
  PHASE_PROMPTS,
  Registry,
  askUserQuestionTool,
  registerBuiltins,
  sanitizeChoices,
} from "../dist/index.js";

const ctx = (extra = {}) => ({ cwd: process.cwd(), log: () => {}, ...extra });

test("it is reachable from every phase, not just planning", () => {
  // A question that can only be asked while PLANNING cannot be asked at the moment
  // it usually arises: mid-implementation, when the ambiguity actually bites.
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  for (const phase of ["prepare", "plan", "perform", "perfect"]) {
    assert.ok(
      reg.selectPhaseTools(phase).some((t) => t.name === "ask_user_question"),
      `missing in ${phase}`,
    );
  }
});

test("the question reports the phase it actually came from", async () => {
  const seen = [];
  await askUserQuestionTool.execute(
    "c1",
    { question: "Which datastore?" },
    ctx({ phase: "perform", askUserQuestion: async (req) => { seen.push(req); return "Postgres"; } }),
  );
  assert.equal(seen[0].phase, "perform", "a mislabeled question is one a host routes wrong");

  // No phase in context: the historical default, rather than inventing one.
  const fallback = [];
  await askUserQuestionTool.execute(
    "c2",
    { question: "Which datastore?" },
    ctx({ askUserQuestion: async (req) => { fallback.push(req); return "x"; } }),
  );
  assert.equal(fallback[0].phase, "plan");
});

test("choices carry their trade-offs, and exactly one recommendation", async () => {
  const seen = [];
  const res = await askUserQuestionTool.execute(
    "c1",
    {
      question: "Which datastore should the API use?",
      reason: "It decides the migration story and I cannot cheaply undo it later.",
      answerMode: "single-select",
      options: [
        { label: "Postgres", description: "Relational, migrations included; needs a running service", recommended: true },
        { label: "SQLite", description: "Zero setup, single file; painful once you need concurrency" },
      ],
    },
    ctx({ phase: "plan", askUserQuestion: async (req) => { seen.push(req); return "Postgres"; } }),
  );

  const req = seen[0];
  // Labels stay a plain string[] so existing hosts keep rendering; the rich form
  // rides alongside for hosts that can show the trade-off.
  assert.deepEqual(req.options, ["Postgres", "SQLite"]);
  assert.equal(req.choices[0].description, "Relational, migrations included; needs a running service");
  assert.equal(req.choices[0].recommended, true);
  assert.equal(req.choices[1].recommended, undefined);
  assert.equal(req.answerMode, "single-select");

  // The answer comes back as this call's result, in the same conversation.
  assert.match(res.output, /User answered: Postgres/);
  assert.doesNotMatch(res.output ?? "", /error/i);
});

test("offering choices without an answerMode still renders as a picker", async () => {
  const seen = [];
  await askUserQuestionTool.execute(
    "c1",
    { question: "Which?", options: ["A", "B"] },
    ctx({ askUserQuestion: async (req) => { seen.push(req); return "A"; } }),
  );
  // Dropping the picker because the model forgot one field would waste the whole
  // point of offering options.
  assert.equal(seen[0].answerMode, "single-select");
  assert.deepEqual(seen[0].options, ["A", "B"]);
});

test("sanitizeChoices accepts both shapes and refuses to recommend twice", () => {
  assert.deepEqual(sanitizeChoices(["A", "  B  ", "", 7]), [{ label: "A" }, { label: "B" }]);

  // Two recommendations recommend nothing: the first wins, the rest are stripped.
  const many = sanitizeChoices([
    { label: "A", recommended: true },
    { label: "B", recommended: true },
  ]);
  assert.deepEqual(many, [{ label: "A", recommended: true }, { label: "B" }]);

  // Capped: past six, a "simplifying" picker is a second problem.
  assert.equal(sanitizeChoices(Array.from({ length: 9 }, (_, i) => `opt${i}`)).length, 6);

  // Junk in, nothing out — never a malformed option.
  assert.equal(sanitizeChoices([{ description: "no label" }, null, 3]), undefined);
  assert.equal(sanitizeChoices("nope"), undefined);
  assert.equal(sanitizeChoices([]), undefined);
});

test("with no host callback the question rides out on details, choices intact", async () => {
  const res = await askUserQuestionTool.execute(
    "c1",
    {
      question: "Migrate the old rows or start clean?",
      options: [{ label: "Migrate", description: "Keeps history; slower rollout", recommended: true }, "Start clean"],
    },
    ctx({ phase: "perform" }),
  );

  assert.equal(res.details.kind, "ask_user_question");
  assert.deepEqual(res.details.options, ["Migrate", "Start clean"]);
  assert.equal(res.details.choices[0].recommended, true);
  // The text form has to carry the trade-offs too — a host that only logs the
  // output should still show the user something answerable.
  assert.match(res.output, /Migrate \(recommended\) — Keeps history/);
});

test("a missing question is a clear error, not a blank prompt to the user", async () => {
  const res = await askUserQuestionTool.execute("c1", {}, ctx());
  assert.equal(res.isError, true);
  assert.match(res.output, /missing required argument 'question'/);
});

test("a host that aborts the question is surfaced, not swallowed", async () => {
  const res = await askUserQuestionTool.execute(
    "c1",
    { question: "?" },
    ctx({ askUserQuestion: async () => { throw new Error("user closed the dialog"); } }),
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /user closed the dialog/);
  assert.match(res.output, /Ask again or proceed without this clarification/);
});

test("the guidance draws the line between their decisions and yours", () => {
  // Ask about what only the user knows...
  assert.match(ASKING_THE_USER, /ARCHITECTURE you are about to commit to/);
  assert.match(ASKING_THE_USER, /two honest readings/);
  assert.match(ASKING_THE_USER, /IRREVERSIBLE or destructive/);
  assert.match(ASKING_THE_USER, /ACCESS only they can give/);
  assert.match(ASKING_THE_USER, /not context to acknowledge/);
  // ...decide everything the code knows yourself.
  assert.match(ASKING_THE_USER, /DO NOT ASK when you can settle it yourself/);
  assert.match(ASKING_THE_USER, /permission to do work the user ALREADY asked for/);
  assert.match(ASKING_THE_USER, /try, and cheaply reverse/);
  // Ask in a form answerable in one click.
  assert.match(ASKING_THE_USER, /Offer OPTIONS whenever you can name the paths/);
  assert.match(ASKING_THE_USER, /recommended:true/);
  assert.match(ASKING_THE_USER, /KEEP WORKING on whatever is not blocked/);
  assert.match(ASKING_THE_USER, /their answer outranks your earlier judgement/);
  // The two places it comes up most, including the plan-review overlap.
  assert.match(ASKING_THE_USER, /do not ask a question the plan review already puts in front of them/);
  assert.match(ASKING_THE_USER, /ask them to\n?\s*exercise the app/);

  assert.ok(LOOP_SYSTEM_PROMPT.includes(ASKING_THE_USER));
  for (const phase of ["plan", "perform"]) {
    assert.ok(PHASE_PROMPTS[phase].includes(ASKING_THE_USER), `missing from ${phase}`);
  }
});

// ---------------------------------------------------------------------------
// A picker must never be a cage.
//
// The model enumerates the paths it can see. The answer the user wants is often
// the one it could not see ("neither — reuse the existing queue"). With options
// and no box, that user has to pick something wrong or kill the run, and the
// model never learns what they actually meant. So every call carrying choices
// also carries `allowFreeText`, and hosts are expected to render both.
// ---------------------------------------------------------------------------

test("a question with options always allows free text as well", async () => {
  let seen;
  await askUserQuestionTool.execute(
    "q1",
    {
      question: "Which datastore?",
      options: [
        { label: "Postgres", description: "relational, migrations", recommended: true },
        { label: "SQLite", description: "no server" },
      ],
    },
    { askUserQuestion: async (req) => { seen = req; return "neither — reuse the queue"; } },
  );
  assert.equal(seen.allowFreeText, true, "the escape hatch is on");
  assert.equal(seen.answerMode, "single-select");
  assert.equal(seen.choices.length, 2);
});

test("multi-select also carries the free-text escape", async () => {
  let seen;
  await askUserQuestionTool.execute(
    "q1",
    { question: "Which targets?", answerMode: "multi-select", options: ["web", "ios"] },
    { askUserQuestion: async (req) => { seen = req; return "web"; } },
  );
  assert.equal(seen.allowFreeText, true);
  assert.equal(seen.answerMode, "multi-select");
});

test("a pure text question does not set the flag — there is nothing to escape from", async () => {
  let seen;
  await askUserQuestionTool.execute(
    "q1",
    { question: "What should the service be called?" },
    { askUserQuestion: async (req) => { seen = req; return "billing"; } },
  );
  assert.equal(seen.allowFreeText, undefined);
  assert.equal(seen.answerMode, undefined);
});

test("the callback-less fallback tells the host free text is allowed", async () => {
  const res = await askUserQuestionTool.execute(
    "q1",
    { question: "Which datastore?", options: ["Postgres", "SQLite"] },
    {},
  );
  assert.equal(res.details.allowFreeText, true);
  assert.match(res.output, /may also type an answer of their own/);
});
