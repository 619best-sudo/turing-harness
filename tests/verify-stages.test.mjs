/**
 * The staged verify flow — instrument → run → inspect → decide.
 *
 * The old verify round dumped every route into one message and let the model
 * pick; a disoriented model picked badly (re-read, or drove a UI it could not
 * reach) and shipped changes nobody observed. The tracker now picks ONE stage
 * per round so the model is nudged through the spine. These tests pin the
 * derivation and the per-stage message focus, plus the contract that the legacy
 * combined message is composed from the same slices (cannot drift).
 *
 * Imports from the built dist (npm test builds first). Pure unit, no LLM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VerifyStageTracker,
  buildStageMessage,
  buildFullVerificationMessage,
} from "../dist/orchestrator/verify-stages.js";

const visualGap = { path: "/p/Screen.tsx", method: "visual" };
const logicGap = { path: "/p/hydration.ts", method: "logic" };
const endpointGap = { path: "/p/handler.ts", method: "endpoint" };

const agentHandoff = { mode: "agent", surfaces: { browser: false, mobile: false } };
const userHandoff = { mode: "user", surfaces: { browser: false, mobile: false }, evidenceDir: "/evidence" };

const ctx = (gaps, handoff, round = 0, maxRounds = 5) => ({ gaps, handoff, round, maxRounds });

// ---- stage derivation --------------------------------------------------------

test("agent: visual/logic gaps start at INSTRUMENT", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
  assert.equal(t.stage({ gaps: [logicGap], round: 0, maxRounds: 5 }), "instrument");
});

test("agent: after the gap is probed, advance to RUN; after a capture, INSPECT", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  t.onInstrumented(visualGap.path);
  assert.equal(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }), "run");
  t.onCapture();
  assert.equal(t.isCaptured(), true);
  assert.equal(t.stage({ gaps: [visualGap], round: 2, maxRounds: 5 }), "inspect");
});

test("the last allowed round forces DECIDE even mid-spine", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  // Nothing instrumented, nothing captured — but it is the final round.
  assert.equal(t.stage({ gaps: [visualGap], round: 4, maxRounds: 5 }), "decide");
});

test("endpoint gaps skip INSTRUMENT (no line to probe) and go to RUN", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  assert.equal(t.stage({ gaps: [endpointGap], round: 0, maxRounds: 5 }), "run");
});

test("a real edit resets progress: captured→instrument again (re-verify after a fix)", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  t.onInstrumented(logicGap.path);
  t.onCapture();
  assert.equal(t.stage({ gaps: [logicGap], round: 2, maxRounds: 5 }), "inspect");
  // A fix lands → the bytes the capture proved are gone.
  t.onWritten(logicGap.path);
  assert.equal(t.isCaptured(), false);
  assert.equal(t.stage({ gaps: [logicGap], round: 3, maxRounds: 5 }), "instrument");
});

test("user mode skips RUN: after instrumenting, the model goes to INSPECT (the orchestrator waits)", () => {
  const t = new VerifyStageTracker({ mode: "user" });
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
  t.onInstrumented(visualGap.path);
  // No capture yet, but user mode never emits a RUN stage for the model.
  assert.equal(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }), "inspect");
});

test("initialInstrumented seeds the set (probes from a reproduce-first work loop carry over)", () => {
  const t = new VerifyStageTracker({ mode: "agent", initialInstrumented: [logicGap.path] });
  assert.equal(t.stage({ gaps: [logicGap], round: 0, maxRounds: 5 }), "run");
});

// ---- per-stage message focus -------------------------------------------------

test("every stage message keeps the VERIFY WHAT YOU WROTE anchor + names the gap", () => {
  for (const stage of ["instrument", "run", "inspect", "decide"]) {
    const m = buildStageMessage(stage, ctx([logicGap], agentHandoff));
    assert.match(m, /VERIFY WHAT YOU WROTE/, `${stage} keeps the anchor`);
    assert.match(m, /\/p\/hydration\.ts/, `${stage} names the gap`);
  }
});

test("INSTRUMENT routes visual+logic to logs and names the trace loop tools", () => {
  const m = buildStageMessage("instrument", ctx([visualGap], agentHandoff));
  assert.match(m, /activity_trace_start/);
  assert.match(m, /add_log/);
  assert.match(m, /VISUAL INCLUDED/i);
});

test("INSTRUMENT in USER mode tells the model to STOP and let the user run it", () => {
  const m = buildStageMessage("instrument", ctx([visualGap], userHandoff));
  assert.match(m, /STOP/);
  assert.match(m, /do NOT drive the app yourself/i);
});

test("RUN (agent) names the collect loop and the green-tests caveat", () => {
  const m = buildStageMessage("run", ctx([logicGap], agentHandoff));
  assert.match(m, /EXERCISE the changed path/);
  assert.match(m, /activity_collect/);
  assert.match(m, /passing test suite says nothing broke/);
});

test("INSPECT names collect/study and the visual judge for a visual gap", () => {
  const m = buildStageMessage("inspect", ctx([visualGap], agentHandoff));
  assert.match(m, /activity_collect|activity_study/);
  assert.match(m, /activity_inspect/);
  assert.match(m, /read where the trail STOPS/i);
});

test("INSPECT makes activity_inspect the SINGLE QA and requires the build ready first", () => {
  const m = buildStageMessage("inspect", ctx([visualGap], agentHandoff));
  assert.match(m, /activity_inspect.*IS the QA/i);
  assert.match(m, /same check a second time/i);
  assert.match(m, /BUILD MUST BE READY FIRST/i);
  assert.match(m, /still compiling|stale already-running instance/i);
});

test("RUN_ORDER defers visual QA to verify's activity_inspect (no double-QA, build-ready-first)", async () => {
  const { RUN_ORDER } = await import("../dist/phases/prompts.js");
  // The work step's job is stated as a boundary, not a preference: it builds,
  // the verify pass does QA. Both halves matter — a run that reads only the
  // first half stops without building, and one that reads only the second does
  // the QA twice.
  assert.match(RUN_ORDER, /THIS STEP BUILDS; THE VERIFY PASS DOES QA/);
  assert.match(RUN_ORDER, /same QA done\s+twice/);
  // And the refusals behind it are named, so a block is recognised as the rule
  // rather than as a broken tool.
  assert.match(RUN_ORDER, /the harness refuses them/);
  assert.match(RUN_ORDER, /never capture a build you did not make/i);
  assert.match(RUN_ORDER, /refuses a stale capture/);
  // The detail lives in THE QA SEQUENCE; the map only points at it.
  assert.match(RUN_ORDER, /THE QA SEQUENCE/);
});

test("DECIDE names the verdict, the fix-and-restart-spine branch, and probe stripping", () => {
  const m = buildStageMessage("decide", ctx([logicGap], agentHandoff));
  assert.match(m, /VERIFIED/);
  assert.match(m, /FAIL/);
  assert.match(m, /spine restarts\s+at BUILD/i);
  assert.match(m, /remove_log|activity_cleanup/);
});

test("DECIDE offers the adjudication path for a FAIL on intended states", () => {
  // A real run verified a dialog title, the analyst FAILED the screen on the
  // intended "Confirm disabled until email typed" state, and the loop demanded
  // a rebuild that could only reproduce the same FAIL. DECIDE must sanction the
  // exit: re-inspect once with the state stated, else close via DECLARE.
  const m = buildStageMessage("decide", ctx([visualGap], agentHandoff));
  assert.match(m, /INTENDED states/i);
  assert.match(m, /re-run `activity_inspect` ONCE/i);
  assert.match(m, /Do not rebuild for a failure that is the app working/);
  assert.match(m, /DECLARE \{ path, method:"none"/);
  // QA mode reports a verdict and owns no gap to close, so the path stays out.
  const qa = buildStageMessage("decide", { ...ctx([visualGap], agentHandoff), qa: true });
  assert.doesNotMatch(qa, /INTENDED states/i);
});

test("DECIDE in a bug-fix run carries the fix-or-revert contract with the trace", () => {
  const m = buildStageMessage("decide", { ...ctx([logicGap], agentHandoff), isBugFix: true });
  assert.match(m, /Bug-fix contract/i);
  assert.match(m, /REPRODUCE/);
  assert.match(m, /revert the attempted fix/i);
  assert.match(m, /activity_study/);
  assert.match(m, /restarts at BUILD/i);
  // Without the flag, the debug contract stays out of the message.
  const plain = buildStageMessage("decide", ctx([logicGap], agentHandoff));
  assert.doesNotMatch(plain, /Bug-fix contract/);
});

// ---- combined message is composed of the same slices ------------------------

test("the combined message carries the instrument + run + inspect phrases together", () => {
  // This is the legacy test seam's shape; it must not lose a route when a stage
  // was extracted. reproduce-first-cycle asserts the detailed phrases; this is a
  // structural guard that all four slices are present in one call.
  const m = buildFullVerificationMessage(ctx([logicGap], agentHandoff));
  assert.match(m, /INSTRUMENT/);
  assert.match(m, /\bRUN\b/);
  assert.match(m, /INSPECT/);
  assert.match(m, /DECIDE/);
  assert.match(m, /Reading the source is NOT a check/);
});

// ---- QA mode (verify existing behaviour, no write) --------------------------

test("QA agent mode: instrument (global) → run → inspect → decide", () => {
  const t = new VerifyStageTracker({ mode: "agent", qa: true });
  // Round 0: set up observation.
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
  // Any probe anywhere advances (QA's target spans files, not one path).
  t.onInstrumented("/p/some/other/file.dart");
  assert.equal(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }), "run");
  t.onCapture();
  assert.equal(t.stage({ gaps: [visualGap], round: 2, maxRounds: 5 }), "inspect");
  assert.equal(t.stage({ gaps: [visualGap], round: 4, maxRounds: 5 }), "decide");
});

test("QA user mode skips RUN (the orchestrator waits) and goes instrument → inspect", () => {
  const t = new VerifyStageTracker({ mode: "user", qa: true });
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
  t.onInstrumented("/p/anywhere.dart");
  assert.equal(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }), "inspect");
});

test("QA header says VERIFY THE REQUESTED BEHAVIOUR; non-QA keeps VERIFY WHAT YOU WROTE", () => {
  const qa = buildStageMessage("instrument", { ...ctx([visualGap], agentHandoff), qa: true });
  const non = buildStageMessage("instrument", ctx([visualGap], agentHandoff));
  assert.match(qa, /VERIFY THE REQUESTED BEHAVIOUR/);
  assert.match(qa, /do NOT edit the user's source/i);
  assert.match(non, /VERIFY WHAT YOU WROTE/);
  assert.doesNotMatch(non, /VERIFY THE REQUESTED BEHAVIOUR/);
});

test("QA instrument tells the model to OBSERVE (not modify); QA decide reports and does not fix", () => {
  const ins = buildStageMessage("instrument", { ...ctx([visualGap], agentHandoff), qa: true });
  assert.match(ins, /OBSERVE THE TARGET BEHAVIOUR/);
  const dec = buildStageMessage("decide", { ...ctx([visualGap], agentHandoff), qa: true });
  assert.match(dec, /PASS/);
  assert.match(dec, /FAIL/);
  assert.match(dec, /do NOT edit the code yourself/i);
});

// ---- order enforcement: premature strip guard + stage wording ----------------

test("INSTRUMENT and RUN messages forbid a premature strip and a premature 'done'", () => {
  const ins = buildStageMessage("instrument", ctx([visualGap], agentHandoff));
  assert.match(ins, /do NOT `activity_cleanup`/);
  assert.match(ins, /do NOT declare the change verified\/done/i);
  const run = buildStageMessage("run", ctx([visualGap], agentHandoff));
  assert.match(run, /do NOT declare the change verified\/done/i);
  assert.match(run, /a green build\/analyzer is NOT a capture/i);
});

test("RUN message for a mobile app pins the device and forbids a browser/web run", () => {
  const mobileHandoff = { mode: "agent", surfaces: { browser: false, mobile: true } };
  const run = buildStageMessage("run", ctx([visualGap], mobileHandoff));
  assert.match(run, /MOBILE app/i);
  assert.match(run, /`-d chrome`/);
  assert.match(run, /Do NOT[^]*run it on a browser/i);
  // A web-only run must not be handed the mobile pin.
  const webRun = buildStageMessage("run", ctx([visualGap], { mode: "agent", surfaces: { browser: true, mobile: false } }));
  assert.doesNotMatch(webRun, /This is a MOBILE app/);
});

test("RUN message requires a FRESH build (not a stale already-running app)", () => {
  const run = buildStageMessage("run", ctx([visualGap], { mode: "agent", surfaces: { browser: false, mobile: true } }));
  assert.match(run, /MUST CONTAIN YOUR CHANGE/i);
  assert.match(run, /stale/i);
  assert.match(run, /HOT-RESTART|hot-restart/i);
  assert.match(run, /Do NOT just foreground/i);
});

test("RUN message tells the agent to ask_user_question (with attachment) when stuck on an input", () => {
  const run = buildStageMessage("run", ctx([visualGap], { mode: "agent", surfaces: { browser: false, mobile: true } }));
  assert.match(run, /STUCK ON A SCREEN OR AN INPUT/i);
  assert.match(run, /Playwright \/ the mobile_\* toolkit/);
  assert.match(run, /curl/);
  assert.match(run, /ask_user_question/);
  assert.match(run, /ATTACH/i);
  assert.match(run, /file to upload|credentials/i);
  assert.match(run, /Do NOT guess credentials or invent inputs/i);
});

test("the work-loop web prompt tells the agent to ask + attach when automation is blocked on an input", async () => {
  const { WEB_AND_SCRAPING } = await import("../dist/phases/prompts.js");
  assert.match(WEB_AND_SCRAPING, /WHERE TO STOP AND ASK/);
  assert.match(WEB_AND_SCRAPING, /ask_user_question/);
  assert.match(WEB_AND_SCRAPING, /ATTACH/i);
  assert.match(WEB_AND_SCRAPING, /file to upload|cookie\/token|2FA/i);
});

test("blockPrematureStrip refuses cleanup / remove_log{all} before a capture, allows after", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  assert.ok(t.blockPrematureStrip("activity_cleanup", {}), "activity_cleanup blocked before capture");
  assert.ok(t.blockPrematureStrip("remove_log", { all: true }), "remove_log{all} blocked before capture");
  assert.ok(
    t.blockPrematureStrip("mcp__x__activity_cleanup", {}),
    "blocked under an MCP prefix too",
  );
  // A single-logId remove (repositioning) is always allowed.
  assert.equal(t.blockPrematureStrip("remove_log", { logId: "log-1" }), null);
  // Unrelated tools are never blocked.
  assert.equal(t.blockPrematureStrip("bash", { command: "x" }), null);
  // After a capture, stripping is allowed (it is DECIDE's job).
  t.onCapture();
  assert.equal(t.blockPrematureStrip("activity_cleanup", {}), null);
});

test("blockPrematureStrip lifts at DECIDE even without a capture (a failed run must still clean up)", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  t.setCurrentStage("instrument");
  assert.ok(t.blockPrematureStrip("activity_cleanup", {}), "blocked at instrument");
  t.setCurrentStage("decide");
  assert.equal(t.blockPrematureStrip("activity_cleanup", {}), null, "allowed at decide even with no capture");
});

// ---- BUILD stage (write → build → instrument → run → inspect → decide) -------

test("instrument comes BEFORE build — probes must be in the binary before it launches", () => {
  const t = new VerifyStageTracker({ mode: "agent", buildRequired: true });
  // Instrument first even with a build debt open: probes are source edits.
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
  t.onInstrumented(visualGap.path);
  assert.equal(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }), "build");
  t.onBuildOk();
  assert.equal(t.stage({ gaps: [visualGap], round: 2, maxRounds: 5 }), "run");
});

test("a repair edit re-arms the BUILD debt (fix → rebuild → re-verify)", () => {
  const t = new VerifyStageTracker({ mode: "agent", buildRequired: true });
  t.onBuildOk();
  t.onInstrumented(visualGap.path);
  t.onCapture();
  assert.equal(t.stage({ gaps: [visualGap], round: 2, maxRounds: 6 }), "inspect");
  // The fix lands → probes are gone AND the build is stale. Instrument first
  // (the new bytes may need new probes), then rebuild.
  t.onWritten(visualGap.path);
  assert.equal(t.stage({ gaps: [visualGap], round: 3, maxRounds: 6 }), "instrument");
});

test("endpoint-only gaps skip BUILD (curl an already-running server)", () => {
  const t = new VerifyStageTracker({ mode: "agent", buildRequired: true });
  assert.equal(t.stage({ gaps: [endpointGap], round: 0, maxRounds: 5 }), "run");
});

test("BUILD is skipped in USER mode (the user builds and runs the app)", () => {
  const t = new VerifyStageTracker({ mode: "user", buildRequired: true });
  assert.equal(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }), "instrument");
});

test("the last allowed round forces DECIDE even with an open BUILD debt", () => {
  const t = new VerifyStageTracker({ mode: "agent", buildRequired: true });
  assert.equal(t.stage({ gaps: [visualGap], round: 4, maxRounds: 5 }), "decide");
});

test("BUILD message: background build + LISTEN, install-not-artifact, enforced refusal", () => {
  const mobileHandoff = { mode: "agent", surfaces: { browser: false, mobile: true } };
  const m = buildStageMessage("build", ctx([visualGap], mobileHandoff));
  assert.match(m, /BUILD — get the change onto the surface/i);
  assert.match(m, /background: true/);
  assert.match(m, /waitMs: 300000/);
  assert.match(m, /LISTENING, not by polling/i);
  assert.doesNotMatch(m, /tail -n/, "no tail-polling taught");
  assert.match(m, /installs\s+NOTHING/i);
  assert.match(m, /capture attempted before a build\+install lands is REFUSED/i);
  assert.match(m, /NOT a capture and NOT verification/i);
});

test("BUILD message in a bug-fix run pins the fixed binary", () => {
  const mobileHandoff = { mode: "agent", surfaces: { browser: false, mobile: true } };
  const m = buildStageMessage("build", { ...ctx([visualGap], mobileHandoff), isBugFix: true });
  assert.match(m, /bug-fix run/i);
  assert.match(m, /FIXED binary/i);
});

test("the combined message carries the BUILD slice first", () => {
  const m = buildFullVerificationMessage(ctx([visualGap], agentHandoff));
  assert.match(m, /BUILD — get the change onto the surface/i);
  assert.ok(
    m.indexOf("BUILD —") < m.indexOf("INSTRUMENT —"),
    "build slice precedes instrument in the combined message",
  );
});

// ---- repair round (VERDICT: FAIL → fix → spine restarts at BUILD) ------------

test("failureReasons turn the round message into a REPAIR round; consumed once", () => {
  const t = new VerifyStageTracker({ mode: "agent", buildRequired: true });
  t.noteFailure(["VERDICT: FAIL — title still reads 'Delete Account'"]);
  const [reason] = t.takeFailure();
  assert.equal(reason, "VERDICT: FAIL — title still reads 'Delete Account'");
  const m = buildStageMessage("build", { ...ctx([visualGap], agentHandoff), failureReasons: [reason] });
  assert.match(m, /REPAIR — the previous round ended VERDICT: FAIL/i);
  assert.match(m, /title still reads/i);
  assert.match(m, /`edit`\/`write`/);
  assert.match(m, /RESTARTS at BUILD/i);
  // takeFailure drains: the next round is a normal stage message.
  assert.deepEqual(t.takeFailure(), []);
  const plain = buildStageMessage("build", ctx([visualGap], agentHandoff));
  assert.doesNotMatch(plain, /REPAIR/);
});

test("a REPAIR round refuses the pointless rebuild when every failing item is intended state", () => {
  // The loop this run died in: the FAIL was the intended disabled Confirm
  // button, so a rebuild reproduced the same FAIL forever. The repair preamble
  // must offer the exit BEFORE the fix-and-rebuild instruction binds.
  const m = buildStageMessage("build", {
    ...ctx([visualGap], agentHandoff),
    failureReasons: ['major: the "Confirm" button is disabled'],
  });
  const adjudicateAt = m.indexOf("Do not rebuild");
  const fixAt = m.indexOf("Fix it:");
  assert.ok(adjudicateAt > -1, "the preamble names the adjudication exit");
  assert.ok(fixAt > -1 && adjudicateAt > fixAt, "the exit follows the fix instruction");
  assert.match(m, /reproduces the same FAIL forever/);
  assert.match(m, /DECLARE \{ path, method:"none", reason \}/);
});

test("noteFailure keeps at most 6 reasons", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  t.noteFailure(Array.from({ length: 9 }, (_, i) => `reason ${i}`));
  assert.equal(t.takeFailure().length, 6);
});

// ---- premature-capture guard (the LOG step must actually happen) -----------

test("blockPrematureCapture refuses a screenshot while runtime gaps owe probes", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  const stage = t.stage({ gaps: [visualGap, logicGap], round: 0, maxRounds: 5 });
  assert.equal(stage, "instrument");
  t.setCurrentStage(stage);
  // The exact last-run failure: inspect (and raw screenshots) before ANY add_log.
  const refusal = t.blockPrematureCapture("activity_inspect");
  assert.ok(refusal, "activity_inspect refused with zero probes");
  assert.match(refusal, /INSTRUMENT stage/);
  assert.match(refusal, /add_log/);
  assert.match(refusal, new RegExp(visualGap.path.replace(/\//g, "\\/")));
  assert.ok(t.blockPrematureCapture("mcp__x__browser_take_screenshot"), "refused under an MCP prefix");
  assert.ok(t.blockPrematureCapture("browser_snapshot"), "raw browser capture refused");
  // Non-capture tools pass: placing probes, running bash, collecting the trace.
  assert.equal(t.blockPrematureCapture("add_log"), null);
  assert.equal(t.blockPrematureCapture("bash"), null);
  assert.equal(t.blockPrematureCapture("activity_collect"), null);
});

test("blockPrematureCapture lifts once every runtime gap path is probed", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  t.setCurrentStage(t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }));
  t.onInstrumented(visualGap.path);
  assert.equal(t.blockPrematureCapture("activity_inspect"), null, "probed → capture allowed");
  // A later real edit re-owes the probe (and the build).
  t.onWritten(visualGap.path);
  t.setCurrentStage(t.stage({ gaps: [visualGap], round: 1, maxRounds: 6 }));
  assert.ok(t.blockPrematureCapture("activity_inspect"), "edit re-owes instrumentation");
});

test("blockPrematureCapture is inert outside the instrument stage, for endpoint-only gaps, and in QA", () => {
  const t = new VerifyStageTracker({ mode: "agent" });
  // Endpoint-only gaps never open instrument debt.
  t.setCurrentStage(t.stage({ gaps: [endpointGap], round: 0, maxRounds: 5 }));
  assert.equal(t.blockPrematureCapture("activity_inspect"), null);
  // Other stages: the orchestrator advanced past instrument.
  t.stage({ gaps: [visualGap], round: 0, maxRounds: 5 });
  t.onInstrumented(visualGap.path);
  t.setCurrentStage(t.stage({ gaps: [visualGap], round: 1, maxRounds: 5 }));
  assert.equal(t.blockPrematureCapture("activity_inspect"), null);
  t.setCurrentStage("decide");
  assert.equal(t.blockPrematureCapture("activity_inspect"), null);
  // QA observes existing behaviour — not held to the probe-first contract.
  const qa = new VerifyStageTracker({ mode: "agent", qa: true });
  qa.setCurrentStage(qa.stage({ gaps: [visualGap], round: 0, maxRounds: 5 }));
  assert.equal(qa.blockPrematureCapture("activity_inspect"), null);
});


