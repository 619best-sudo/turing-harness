/**
 * Visual guidance is dropped on a project with no UI.
 *
 * `assets_generator` and `inspiration_generator` already DECLINE a call on a
 * backend project at runtime, so nothing here is what makes the behaviour
 * correct — it is what stops the model spending a turn discovering it. A
 * project with no interface has nowhere to put a generated hero image and no
 * screen to look a design reference up for, so the paragraphs teaching it when
 * to reach for them are prompt budget spent on a tool that will refuse.
 *
 * The default (no category) must keep the blocks: an uncategorized project may
 * well have UI, and losing the guidance there would be the expensive direction
 * to err in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLoopSystemPrompt, buildPhaseSystemPrompt } from "../dist/index.js";

const TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "assets_generator",
  "inspiration_generator",
  "media_analysis",
  "ask_user_question",
];

/** Distinctive lines from the two visual blocks. */
const ASSETS_MARKER = /GENERATING ASSETS|assets_generator/;
const INSPIRATION_MARKER = /inspiration_generator/;

test("no category keeps the visual guidance (an unknown project may have UI)", () => {
  const prompt = buildLoopSystemPrompt(TOOLS);
  assert.match(prompt, ASSETS_MARKER);
  assert.match(prompt, INSPIRATION_MARKER);
});

test("frontend/mobile/games keep the visual guidance", () => {
  for (const projectCategory of ["frontend", "mobile", "games"]) {
    const prompt = buildLoopSystemPrompt(TOOLS, { projectCategory });
    assert.match(prompt, ASSETS_MARKER, `${projectCategory} lost the assets block`);
    assert.match(prompt, INSPIRATION_MARKER, `${projectCategory} lost the inspiration block`);
  }
});

test("backend drops both visual blocks", () => {
  const prompt = buildLoopSystemPrompt(TOOLS, { projectCategory: "backend" });
  assert.doesNotMatch(prompt, ASSETS_MARKER);
  assert.doesNotMatch(prompt, INSPIRATION_MARKER);
});

test("backend keeps everything that is NOT visual", () => {
  const prompt = buildLoopSystemPrompt(TOOLS, { projectCategory: "backend" });
  // The blocks a backend run needs most are untouched.
  assert.match(prompt, /VERIFY|verify/, "verification guidance must survive");
  assert.match(prompt, /ask_user_question/, "asking guidance must survive");
  assert.match(prompt, /HOW TO READ THE GUIDANCE BELOW/, "the contract must survive");
  assert.match(prompt, /PLANNING/, "the template body is intact");
});

test("the phase prompts gate the same way", () => {
  const perform = buildPhaseSystemPrompt("perform", TOOLS);
  assert.match(perform, ASSETS_MARKER);
  const performBackend = buildPhaseSystemPrompt("perform", TOOLS, { projectCategory: "backend" });
  assert.doesNotMatch(performBackend, ASSETS_MARKER);
  assert.doesNotMatch(performBackend, INSPIRATION_MARKER);
});

test("gating composes with tool-presence gating, it does not replace it", () => {
  // No visual tools attached at all → the blocks are already absent, and asking
  // for backend on top of that changes nothing (and must not throw).
  const bare = buildLoopSystemPrompt(["read", "write", "bash"]);
  assert.doesNotMatch(bare, ASSETS_MARKER);
  const bareBackend = buildLoopSystemPrompt(["read", "write", "bash"], {
    projectCategory: "backend",
  });
  assert.doesNotMatch(bareBackend, ASSETS_MARKER);
});

test("authorOnlyWrites still resolves alongside a category", () => {
  const prompt = buildLoopSystemPrompt(TOOLS, {
    projectCategory: "backend",
    authorOnlyWrites: true,
  });
  assert.doesNotMatch(prompt, /%%ESCALATION%%/, "the escalation slot must be filled");
  assert.doesNotMatch(prompt, /%%GUIDANCE%%/, "the guidance slot must be filled");
  assert.match(prompt, /REFUSES to author source/, "author-only escalation text is present");
});
