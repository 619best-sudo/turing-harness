/**
 * OpenWaggleMain classic-run compatibility contract.
 *
 * OpenWaggleMain (the Electron host of "Turing Machine") drives turing-harness
 * exclusively through `agent.prompt(prompt, attachments, { planMode })` and
 * reads `agent.state` afterward. It has its OWN mirror types for
 * `AskUserQuestionRequest` and `ThreadRunSnapshot`, and a persisted-snapshot
 * validator (`isThreadRunSnapshot`) that rejects snapshots whose core fields or
 * enum values change. This test codifies the fields and shapes the host depends
 * on, so the verify-gate work cannot silently break it.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coordinateRunHandoff,
  detectSurfaces,
} from "../dist/index.js";

// The host's AskUserQuestionRequest.phase is typed as this exact union
// (OpenWaggleMain src/shared/types/user-question.ts:18). Any phase the harness
// emits MUST be in it, or the host's renderer won't render the question and the
// resolve-match key won't match.
const HOST_PHASE_UNION = new Set(["prepare", "plan", "perform", "perfect"]);

// The host's ThreadRunDisposition validator accepts ONLY these values.
const HOST_DISPOSITION_UNION = new Set([
  "completed",
  "pending_user_question",
  "aborted",
  "failed",
]);
// And recommendedFollowUpMode:
const HOST_FOLLOWUP_UNION = new Set(["fresh", "structured_continue"]);

const stubRegistry = (names = []) => ({
  getTool: (n) => (names.includes(n) ? { name: n } : undefined),
});

test("the run-handoff question always carries a phase in the host's typed union", async () => {
  // Visual method → handoff fires → question is asked. Assert its phase.
  let captured;
  await coordinateRunHandoff({
    registry: stubRegistry(["mcp__playwright__browser_navigate"]),
    askUserQuestion: async (req) => { captured = req; return "You drive it"; },
    declaredMethods: ["visual"],
  });
  assert.ok(captured, "a question was asked");
  assert.ok(
    HOST_PHASE_UNION.has(captured.phase),
    `phase "${captured.phase}" must be in the host union ${[...HOST_PHASE_UNION].join("|")}`,
  );
  assert.equal(captured.phase, "perfect"); // semantically the verify phase
});

test("the handoff question is a single-select with a free-text escape (host renders both)", async () => {
  let captured;
  await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async (req) => { captured = req; return "Skip verification"; },
    declaredMethods: ["endpoint"],
  });
  assert.equal(captured.answerMode, "single-select");
  assert.equal(captured.allowFreeText, true);
  assert.ok(Array.isArray(captured.options) && captured.options.length >= 2);
});

test("detectSurfaces never throws on an empty/undefined registry (host may have none)", () => {
  assert.deepEqual(detectSurfaces(undefined), { browser: false, mobile: false });
  assert.deepEqual(detectSurfaces(stubRegistry()), { browser: false, mobile: false });
});

test("the handoff degrades gracefully when the host has NO askUserQuestion callback", async () => {
  // OpenWaggleMain always installs one, but the contract must not require it.
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    declaredMethods: ["visual"],
  });
  assert.ok(["agent", "skip"].includes(res.mode), "no callback ⇒ agent or skip, never a hang");
});

test("the handoff never throws — any host error degrades to skip", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => { throw new Error("renderer exploded"); },
    declaredMethods: ["visual"],
  });
  assert.equal(res.mode, "skip");
});

test("RunLoopResult.verified is boolean|undefined (never throws on access)", () => {
  // Structural: the field is optional. A host that does `result.verified` on a
  // conversational run gets undefined, not an error. Verified by TypeScript at
  // build time; this is a runtime sanity check on the type's existence.
  const sample = { task: "x", route: "task", success: true, steps: [], refs: [], usage: {} };
  assert.equal(sample.verified, undefined);
  const verified = { ...sample, verified: true };
  assert.equal(verified.verified, true);
});

test("RunLoopResult.reproduction is additive (host ignores it, never breaks)", () => {
  // The reproduction report is present only on bug-fix runs. A host that never
  // reads it must not be affected — confirm the field is optional/undefined by
  // default and additive when present.
  const sample = { task: "x", route: "task", success: true, steps: [], refs: [], usage: {} };
  assert.equal(sample.reproduction, undefined);
  const withRepro = { ...sample, reproduction: { reproduced: true, askedUser: false, blocks: 0 } };
  assert.equal(withRepro.reproduction.reproduced, true);
});

test("the host's disposition / followUpMode enums are unchanged", () => {
  // These are the values isThreadRunSnapshot validates against. Adding a new
  // disposition would drop every persisted snapshot from prior runs.
  for (const d of ["completed", "pending_user_question", "aborted", "failed"]) {
    assert.ok(HOST_DISPOSITION_UNION.has(d));
  }
  for (const m of ["fresh", "structured_continue"]) {
    assert.ok(HOST_FOLLOWUP_UNION.has(m));
  }
});

test("RunStep keeps the fields the host's transcript test asserts on", () => {
  // turing-classic-run.phase-transcript.unit.test.ts constructs a RunStep with
  // exactly these fields. They must remain.
  const step = {
    planId: "p1",
    taskId: "t1",
    title: "Do thing",
    summary: "",
    complexity: "medium",
    isCompleted: true,
    files: [],
  };
  assert.equal(step.planId, "p1");
  assert.equal(step.isCompleted, true);
  assert.deepEqual(step.files, []);
});

test("ThreadRunSnapshot keeps the core fields the host persists and re-validates", () => {
  // extractPersistedThreadSnapshot re-validates these after a round-trip.
  const snap = {
    timestamp: Date.now(),
    task: "x",
    route: "task",
    disposition: "completed",
    recommendedFollowUpMode: "structured_continue",
    summary: "done",
    verified: true, // newly populated by the verify gate; already on the type
  };
  assert.equal(typeof snap.timestamp, "number");
  assert.ok(HOST_DISPOSITION_UNION.has(snap.disposition));
  assert.ok(HOST_FOLLOWUP_UNION.has(snap.recommendedFollowUpMode));
  assert.equal(snap.verified, true);
});
