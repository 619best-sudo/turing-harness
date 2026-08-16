/**
 * RUN_ORDER — the block that says WHAT TO RUN WHEN.
 *
 * Every other guidance block is organised by topic and none of them says when it
 * is that block's turn, so the sequence had to be inferred. These tests pin the
 * sequence itself: the forks, their order, and the fact that it leads the prompt
 * rather than sitting halfway down it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUN_ORDER,
  LOOP_SYSTEM_PROMPT,
  GUIDELINE_CONTRACT,
  MEDIA_UNDERSTANDING,
  buildLoopSystemPrompt,
  buildPhaseSystemPrompt,
} from "../dist/index.js";

test("the loop carries the run order verbatim, right after the contract", () => {
  assert.ok(LOOP_SYSTEM_PROMPT.includes(RUN_ORDER), "the loop carries it verbatim");
  const contractAt = LOOP_SYSTEM_PROMPT.indexOf(GUIDELINE_CONTRACT);
  const orderAt = LOOP_SYSTEM_PROMPT.indexOf(RUN_ORDER);
  const mediaAt = LOOP_SYSTEM_PROMPT.indexOf(MEDIA_UNDERSTANDING);
  assert.ok(contractAt < orderAt, "the contract frames the guidance, so it comes first");
  assert.ok(orderAt < mediaAt, "the map precedes the blocks it is a map of");
});

test("the sequence is stated in order: attachments, project, fork, verify, cleanup", () => {
  const steps = [
    /1\. ATTACHMENTS FIRST/,
    /2\. UNDERSTAND THE PROJECT/,
    /3\. FORK/,
    /4\. VERIFY BY OBSERVATION/,
    /5\. BEFORE THE SUMMARY, STRIP INSTRUMENTATION/,
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = RUN_ORDER.search(step);
    assert.ok(at > cursor, `${step} must come after the step before it`);
    cursor = at;
  }
});

test("the fork names both paths and what decides between them", () => {
  assert.match(RUN_ORDER, /FIXING SOMETHING BROKEN/);
  assert.match(RUN_ORDER, /BUILDING SOMETHING NEW/);
  // Debugging is observe-then-edit, and the chain is given in call order.
  const chain = ["activity_trace_start", "add_log", "RUN THE FLOW", "activity_collect", "activity_study"];
  let cursor = -1;
  for (const call of chain) {
    const at = RUN_ORDER.indexOf(call);
    assert.ok(at > cursor, `${call} must appear in call order`);
    cursor = at;
  }
});

test("step 4 routes QA to the verify pass and forbids the early self-check", async () => {
  // The sun-color run read the OLD bullets ("a screen → screenshot it, then
  // media_analysis") as license to start browser QA in the work loop, before
  // the verify pass began — and when refused, it rerouted via a bash CLI
  // capture. The imperative itself must now point at activity_inspect and name
  // the reroute as the same violation.
  assert.match(RUN_ORDER, /Do not open a browser, navigate,\s+screenshot/);
  assert.match(RUN_ORDER, /runs FOR you — not a\s+route you drive\./);
  assert.match(RUN_ORDER, /routing around a refusal/);
  assert.match(RUN_ORDER, /npx playwright screenshot/);
});

test("the build fork branches on reference, non-UI, and UI-without-reference", () => {
  assert.match(RUN_ORDER, /a reference image for THIS file/);
  assert.match(RUN_ORDER, /not UI \(backend, CLI, data, lib\)/);
  assert.match(RUN_ORDER, /UI with NO reference for it/);
});

test("multiple attachments are kept apart — the sharpness rule is in the prompt", () => {
  assert.match(RUN_ORDER, /KEEP MULTIPLE ATTACHMENTS APART/);
  assert.match(RUN_ORDER, /images: \["<the one for this file>"\]/);
  assert.match(RUN_ORDER, /never authored from designs that belong to other files|never authored from designs/);
});

test("verification is routed by what changed, and names compare vs qa", () => {
  assert.match(RUN_ORDER, /VERIFY BY OBSERVATION/);
  assert.match(RUN_ORDER, /never by re-reading the file you just wrote/);
  assert.match(RUN_ORDER, /lens:"compare" with the/);
  assert.match(RUN_ORDER, /lens:"qa" with/);
  assert.match(RUN_ORDER, /`curl`/, "a backend change is verified by calling it");
});

test("the run order names no visual tool, so a backend prompt stays clean", () => {
  // The visual ladder is dropped for a backend project. A map that hard-coded
  // `inspiration_generator` would reintroduce it into exactly the prompt that
  // deliberately excludes it — so the map points at the block instead.
  assert.doesNotMatch(RUN_ORDER, /inspiration_generator/);
  assert.doesNotMatch(RUN_ORDER, /assets_generator/);
  const backend = buildLoopSystemPrompt(undefined, { projectCategory: "backend" });
  assert.ok(backend.includes(RUN_ORDER), "the map is still carried on a backend run");
  assert.doesNotMatch(backend, /inspiration_generator/);
});

test("perform carries the map too — the phase that does the work", () => {
  const perform = buildPhaseSystemPrompt("perform");
  assert.ok(perform.includes(RUN_ORDER));
});

test("the map defers detail rather than restating it", () => {
  // A map that grows into a second copy of every block is a maintenance trap: the
  // two drift, and the model gets contradictory instructions. Keep it short.
  assert.ok(RUN_ORDER.length < MEDIA_UNDERSTANDING.length, "the index stays smaller than the chapter");
});

// ---- QA_SEQUENCE — the eight-step verification procedure ---------------------

test("QA_SEQUENCE states the eight steps in order, with the automation step", async () => {
  // The sun-color run walked every gap this pins: it inspected a file:// URL
  // before any server existed, opened the trace AFTER inspecting, started the
  // server three times, and took its own raw screenshots beside activity_inspect.
  // The sequence is now numbered 1-8 and each step names its predecessor's gate.
  const { QA_SEQUENCE } = await import("../dist/phases/prompts.js");
  const steps = [
    /1\. LOG /,
    /2\. BUILD /,
    /3\. RUN /,
    /4\. AUTOMATE /,
    /5\. INSPECT /,
    /6\. LOGS /,
    /7\. DECIDE /,
    /8\. CLEANUP /,
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = QA_SEQUENCE.search(step);
    assert.ok(at > cursor, `${step} must come after the step before it`);
    cursor = at;
  }
  assert.match(QA_SEQUENCE, /eight steps, IN THIS ORDER/);
});

test("QA_SEQUENCE forbids the out-of-order moves real runs made", async () => {
  const { QA_SEQUENCE } = await import("../dist/phases/prompts.js");
  // Inspect only after the run is up and carrying the new build.
  assert.match(QA_SEQUENCE, /never before the run is up/);
  assert.match(QA_SEQUENCE, /photographs no screen or the OLD code/);
  // Probes are source edits: LOG precedes BUILD so they are in the binary.
  assert.match(QA_SEQUENCE, /they must be in the binary before it launches/);
  // The surface starts exactly once — no file:// and no second server.
  assert.match(QA_SEQUENCE, /EXACTLY ONCE/);
  assert.match(QA_SEQUENCE, /NEVER a\s+`file:\/\/` URL/);
  assert.match(QA_SEQUENCE, /NEVER a second/);
  // New UI is judged on visual scope, not just presence.
  assert.match(QA_SEQUENCE, /positioning and\s+alignment, colors, spacing and sizing/);
  // A FAIL mutates files and restarts the sequence — quality is the exit.
  assert.match(QA_SEQUENCE, /mutate the files/);
  assert.match(QA_SEQUENCE, /RESTARTS at step 2/);
  assert.match(QA_SEQUENCE, /Quality is the exit condition/);
});
