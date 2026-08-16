/**
 * The agent has to be teachable across runs.
 *
 * `project_memory` always existed; nothing ever said what belonged in it. So the
 * loop would be corrected ("pull the colors from the tokens file, not hex"),
 * comply, finish — and the next run would make the identical mistake, because
 * the correction lived in a chat transcript the next run never sees. The user
 * experiences that as an agent that cannot be taught.
 *
 * Two signals are worth a write and both are cheap to spot as they happen: the
 * user saying the same thing twice, and a tool failing the same way twice.
 * These pin that the guidance names both, says what NOT to store, and reaches
 * every phase that could observe either signal.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_LEARNING,
  createProjectMemoryTool,
} from "../dist/index.js";
import { WORK_PROMPT, READ_PROMPT, INSPECT_PROMPT, CATEGORIZER_PROMPTS, buildWorkPrompt, buildPhaseLikePrompt } from "./helpers/v2-prompts.mjs";

test("both learning signals are named, with the user-correction case called out", () => {
  assert.match(PROJECT_LEARNING, /A STANDING PREFERENCE/);
  assert.match(PROJECT_LEARNING, /A CORRECTION —/);
  assert.match(PROJECT_LEARNING, /THE SAME FAILURE TWICE/);
  // A correction outranks a volunteered preference — you already proved you'd get it wrong.
  assert.match(PROJECT_LEARNING, /already proved you would\s+get it wrong/);
});

test("the user's own example is the worked example", () => {
  // "pull colors from the colors file" is exactly the correction that used to
  // evaporate at the end of a run.
  assert.match(PROJECT_LEARNING, /use the tokens file,/);
  assert.match(PROJECT_LEARNING, /raw hex in a component is wrong here/);
});

test("a repeated tool failure is stored as the fix, not the symptom", () => {
  assert.match(PROJECT_LEARNING, /playwright needs the dev\s+server already running/);
  assert.match(PROJECT_LEARNING, /Record the RESOLVED FIX and its cause/);
  assert.match(
    PROJECT_LEARNING,
    /symptom with no cause and no fix is worse than nothing/,
    "the anti-pattern is named, not just the rule",
  );
});

test("it says what NOT to store, or the memory fills with noise", () => {
  assert.match(PROJECT_LEARNING, /anything the code already states/);
  assert.match(PROJECT_LEARNING, /it cannot go stale/, "why code beats a note");
  assert.match(PROJECT_LEARNING, /this task's\n?\s*specifics/);
  assert.match(PROJECT_LEARNING, /no keys, tokens, credentials, personal data/);
});

test("stale facts are corrected rather than accumulated", () => {
  assert.match(PROJECT_LEARNING, /newest wins/);
  assert.match(PROJECT_LEARNING, /a memory nobody updates is a memory nobody trusts/);
});

test("reading is not the point — applying is", () => {
  // The failure one step past "never learned it": learned it and built against it anyway.
  assert.match(PROJECT_LEARNING, /THEN APPLY IT/);
  assert.match(PROJECT_LEARNING, /worse than never having read it/);
  // And it is read before planning, not discovered at the end.
  assert.match(PROJECT_LEARNING, /READ ONCE, at the very start/);
});

test("the tool description carries the same two signals", () => {
  // A model that never reads the guidance block still sees the tool.
  const { description } = createProjectMemoryTool();
  assert.match(description, /STANDING PREFERENCE/);
  assert.match(description, /RESOLVED FAILURE/);
  assert.match(description, /never the/, "symptom is excluded at the tool too");
});

test("it reaches every phase that can observe a correction or a failure", () => {
  for (const phase of ["prepare", "plan", "perform", "perfect"]) {
    assert.match(
      buildPhaseLikePrompt(phase, ["read", "project_memory"]),
      /LEARNING ACROSS RUNS/,
      `${phase} carries it`,
    );
  }
  assert.match(buildWorkPrompt(["read", "project_memory"]), /LEARNING ACROSS RUNS/);
});

test("and is absent when there is no memory tool to write to", () => {
  assert.doesNotMatch(buildWorkPrompt(["read", "write", "bash"]), /LEARNING ACROSS RUNS/);
});

test("it stays compact — it rides on every run that has memory", () => {
  assert.ok(PROJECT_LEARNING.length < 3300, `${PROJECT_LEARNING.length} chars`);
});

// ---------------------------------------------------------------------------
// Call discipline.
//
// The waste here is structural, not a habit: the orchestrator runs ONE SUB-LOOP
// PER PLAN STEP, each with a fresh conversation. "Read it at the start of a run"
// therefore reads as "at the start of every step" — so a 6-step plan paid for
// six identical reads of facts that cannot change while the run executes. Every
// call is a whole model turn.
// ---------------------------------------------------------------------------

test("the budget is stated per RUN, and explicitly not per step", () => {
  assert.match(PROJECT_LEARNING, /CALL IT TWICE A RUN, NOT TWICE A STEP/);
  assert.match(PROJECT_LEARNING, /do NOT re-read per step, per file, or after an edit/);
  // The reason, so it is not followed as an arbitrary quota.
  assert.match(PROJECT_LEARNING, /these\s+facts do not change while you work/);
  assert.match(PROJECT_LEARNING, /Every call is a whole model turn/);
});

test("reads are one call, not both `get` and `recall`", () => {
  assert.match(PROJECT_LEARNING, /READ ONCE, at the very start/);
  assert.match(PROJECT_LEARNING, /one or the\s+other, not both/);
});

test("writes are batched into a single call at the end", () => {
  assert.match(PROJECT_LEARNING, /WRITE ONCE, at the end/);
  assert.match(PROJECT_LEARNING, /do not stop to record each one/);
  // With the one exception that costs nothing extra, because you act on it anyway.
  assert.match(PROJECT_LEARNING, /correction that changes what you are\s+about to do/);
});

test("writing nothing is the expected outcome, not a failure to comply", () => {
  // Otherwise a quota reads as a requirement and the model invents a fact to fill it.
  assert.match(PROJECT_LEARNING, /Nothing to record is the normal case/);
  assert.match(PROJECT_LEARNING, /an empty write is still a\s+paid turn/);
  assert.match(PROJECT_LEARNING, /rather than inventing a fact to justify the call/);
});
