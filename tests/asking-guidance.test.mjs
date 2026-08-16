/**
 * Per-category `ask_user_question` scoping: each categorizer's prompt teaches
 * what the tool is FOR in that category — read asks only for the intent that
 * gates relevance, write_edit only for what execution needs, activity_inspect
 * only for QA/automation realities — plus the universal in-doubt/need-help
 * clause. Custom categorizers get a sane generic via the same slot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCategorizerSystemPrompt, DEFAULT_CATEGORIZER_PROMPTS } from "../dist/index.js";

const build = (id, toolNames = ["ask_user_question", "deliver"]) =>
  buildCategorizerSystemPrompt({ id, systemPrompt: DEFAULT_CATEGORIZER_PROMPTS[id] }, toolNames);

test("read: asks only for the intent that gates reading relevance, never for what the repo answers", () => {
  const p = build("read");
  assert.match(p, /ASKING THE USER HERE/);
  assert.match(p, /RELEVANCE of your read/);
  assert.match(p, /INTENT when the prompt is ambiguous/);
  assert.match(p, /WHICH target when several could be meant/);
  assert.match(p, /Never ask for anything the repo answers/);
  assert.ok(!p.includes("EXECUTE the task"), "the write_edit scoping must not leak into read");
});

test("write_edit: asks only for what execution needs, with the unnamed-value rule enforced", () => {
  const p = build("write_edit");
  assert.match(p, /ASKING THE USER HERE/);
  assert.match(p, /EXECUTE the task/);
  assert.match(p, /VALUE the request never names/);
  assert.match(p, /refused until you have asked/);
  assert.match(p, /ACT on it/);
  assert.match(p, /Never ask what the code answers/);
});

test("activity_inspect: asks only for QA/automation realities only the user knows", () => {
  const p = build("activity_inspect");
  assert.match(p, /ASKING THE USER HERE/);
  assert.match(p, /QA\/automation realities only the user knows/);
  assert.match(p, /REPRO steps/);
  assert.match(p, /WHO drives/);
  assert.match(p, /what FIXED means/);
  assert.match(p, /WHICH surface/);
  assert.match(p, /Never ask for what a capture or a log answers/);
});

test("conversation: ask almost nothing — at most one short question", () => {
  const p = build("conversation");
  assert.match(p, /ask almost nothing/);
  assert.match(p, /ONE short question/);
  assert.match(p, /answer the most useful reading/);
});

test("every category carries the universal clause: in doubt, or beyond the model, ask", () => {
  for (const id of ["conversation", "read", "write_edit", "activity_inspect"]) {
    const p = build(id);
    assert.match(p, /UNIVERSAL \(every category\)/, `${id}: universal clause present`);
    assert.match(p, /genuinely IN DOUBT/, `${id}: in-doubt rule present`);
    assert.match(p, /beyond you/, `${id}: model-needs-help rule present`);
    assert.match(p, /clearing_doubt/, `${id}: doubt-vs-help split names clearing_doubt`);
  }
});

test("the asking slot is always resolved — no marker survives the build", () => {
  for (const id of ["conversation", "read", "write_edit", "activity_inspect"]) {
    assert.doesNotMatch(build(id), /%%ASKING%%/, `${id}: slot filled`);
  }
});

test("a custom categorizer using the slot gets the generic scoping", () => {
  const p = buildCategorizerSystemPrompt(
    { id: "deploy", systemPrompt: "You deploy things. %%ASKING%%" },
    ["bash", "deliver"],
  );
  assert.match(p, /decisions and facts only the USER holds/);
  assert.match(p, /UNIVERSAL \(every category\)/);
  assert.doesNotMatch(p, /%%ASKING%%/);
});
