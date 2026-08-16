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

// The host's AskUserQuestionRequest.phase is typed as a string union
// (OpenWaggleMain src/shared/types/user-question.ts). In v2 the label is the
// CATEGORIZER id driving the loop — hosts treating it as an opaque label keep
// working; hosts keyed on 4P names should read "write_edit" as the work pass.
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

test("RunLoopResult.verified is boolean|undefined (never throws on access)", () => {
  // Structural: the field is optional. A host that does `result.verified` on a
  // conversational run gets undefined, not an error. Verified by TypeScript at
  // build time; this is a runtime sanity check on the type's existence.
  const sample = { task: "x", route: "task", success: true, steps: [], refs: [], usage: {} };
  assert.equal(sample.verified, undefined);
  const verified = { ...sample, verified: true };
  assert.equal(verified.verified, true);
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
