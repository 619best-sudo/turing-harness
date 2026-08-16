// The QA gate: WHEN a run may look at a screen, and what it must have done first.
//
// Every case here is lifted from one observed run — a one-line Flutter dialog
// title change that edited, ran the analyzer, launched the ALREADY-INSTALLED
// app, screenshotted the iOS home screen, tapped three guessed coordinates, and
// reported the change verified. The prompts forbade all of that in full prose.
// These assert the version that can actually stop the call.
import test from "node:test";
import assert from "node:assert/strict";

import {
  QaGate,
  callSurface,
  deployKind,
  isCaptureTool,
  isDriveTool,
  isInspectTool,
} from "../dist/index.js";

const EDIT = ["edit", { path: "/p/lib/profile.dart", oldString: "a", newString: "b" }];

/** Drive the gate through a call: check, then observe the (successful) result. */
function run(gate, name, args = {}) {
  const decision = gate.check(name, args);
  if (decision.kind === "allow") gate.observe(name, args, false);
  return decision;
}

// ---- classification --------------------------------------------------------

test("tools are classified by what they do, through any MCP prefix", () => {
  assert.ok(isCaptureTool("mobile_elements"), "the built-in look action is a capture");
  assert.ok(isCaptureTool("vendor__browser_take_screenshot"), "a server prefix does not smuggle it past");
  assert.ok(isCaptureTool("browser_take_screenshot"));
  assert.ok(isDriveTool("mobile_tap"));
  assert.ok(isDriveTool("playwright__browser_click"));
  assert.ok(isInspectTool("activity_inspect"));
  // A tool that is none of these is none of the gate's business.
  assert.ok(!isCaptureTool("read"));
  assert.ok(!isDriveTool("grep"));
  assert.ok(!isInspectTool("activity_collect"));
});

test("the surface is read from the call, not guessed", () => {
  assert.equal(callSurface("activity_inspect", { target: "mobile" }), "mobile");
  assert.equal(callSurface("activity_inspect", { bundleId: "com.x.y" }), "mobile");
  assert.equal(callSurface("activity_inspect", { url: "myapp://cards" }), "mobile", "a deep link is a device");
  assert.equal(callSurface("activity_inspect", { url: "http://localhost:3000" }), "browser");
  assert.equal(callSurface("mobile_tap", {}), "mobile");
  assert.equal(callSurface("browser_take_screenshot", {}), "browser");
  // Nothing to go on ⇒ `unknown`, which the freshness rule never blocks.
  assert.equal(callSurface("activity_inspect", {}), "unknown");
});

test("a device LAUNCH is a deploy; a build-only task is not", () => {
  // The distinction the failing run got wrong: `flutter build` makes an artifact
  // and installs nothing, so it cannot make a stale app fresh.
  assert.equal(deployKind("flutter run -d E25EC6B1"), "device");
  assert.equal(deployKind("npx react-native run-ios"), "device");
  assert.equal(deployKind("./gradlew installDebug"), "device");
  assert.equal(deployKind("flutter build ios --simulator"), null);
  assert.equal(deployKind("./gradlew assembleDebug"), null);
  assert.equal(deployKind("npm run dev"), "web");
  assert.equal(deployKind("flutter analyze lib/x.dart"), null, "an analyzer is not a deploy");
});

// ---- rule 1: QA belongs to the verify pass ---------------------------------

test("before any write, driving the app is allowed — that is reproduction", () => {
  const gate = new QaGate();
  assert.equal(run(gate, "mobile_launch_app", { bundleId: "com.x" }).kind, "allow");
  assert.equal(run(gate, "browser_take_screenshot", {}).kind, "allow");
  // A coordinate tap additionally needs a position analysis behind it (see the
  // blind-tap rule below) — an inspect before the tap provides one.
  assert.equal(run(gate, "activity_inspect", { target: "mobile" }).kind, "allow");
  assert.equal(run(gate, "browser_click", {}).kind, "allow");
});

test("after a write, a WORK loop may not do raw UI QA", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  const blocked = gate.check("browser_take_screenshot", {});
  assert.equal(blocked.kind, "block");
  assert.equal(blocked.reason, "scope");
  assert.match(blocked.message, /verify pass/);
  assert.match(blocked.message, /activity_inspect/, "it names the tool to use instead");
});

test("a screenshot rerouted through bash is refused like the tool it dodged", () => {
  // The observed escape: refused on `browser_take_screenshot`, the run said
  // "the harness keeps blocking screenshot" and captured via
  // `npx playwright screenshot <url> <file>` + a manual `media_analysis`. A
  // tool-name gate sees nothing in a bash command, so the command text is the
  // only signal that closes the route. Tight by design: a build or test
  // command must never match.
  for (const cmd of [
    "npx --yes playwright screenshot http://localhost:8177/index.html /tmp/sun-blood-red.png",
    "screencapture -x /tmp/shot.png",
    "xcrun simctl io E25EC6B1-342D-4CDE-9607-A09B5243E126 screenshot /tmp/shot.png",
    "adb exec-out screencap -p > /tmp/shot.png",
  ]) {
    // A fresh gate per command: scope stands down after maxBlocks refusals, and
    // the point here is the classification, not the counter.
    const gate = new QaGate();
    run(gate, ...EDIT);
    const d = gate.check("bash", { command: cmd });
    assert.equal(d.kind, "block", cmd);
    assert.equal(d.reason, "scope");
    assert.match(d.message, /raw screenshot wearing a shell/);
  }
  // Ordinary shell work — build, test, curl, a dev server — is untouched.
  const ordinary = new QaGate();
  run(ordinary, ...EDIT);
  for (const cmd of [
    "npm run build",
    "npx tsc --noEmit",
    "curl -s http://localhost:8177/index.html | grep sunGrad",
    "python3 -m http.server 8177",
    "npx playwright test",
  ]) {
    assert.equal(ordinary.check("bash", { command: cmd }).kind, "allow", cmd);
  }
});

test("a bash capture in the verify pass or before any write is allowed", () => {
  // Same boundaries as the tool rule: the verify pass IS the QA pass, and
  // before a write a capture is reproduction.
  const verifying = new QaGate();
  verifying.observe(...EDIT, false);
  verifying.setVerifyPass(true);
  assert.equal(
    verifying.check("bash", { command: "npx playwright screenshot http://localhost:8177/i.html /tmp/s.png" }).kind,
    "allow",
  );
  const fresh = new QaGate();
  assert.equal(
    fresh.check("bash", { command: "screencapture -x /tmp/shot.png" }).kind,
    "allow",
    "no writes yet — reproduction",
  );
});

test("the scope rule stands down inside the verify pass — that IS the QA pass", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.setVerifyPass(true);
  // Deploy first so the freshness rule (which stays armed) is satisfied.
  gate.observe("bash", { command: "flutter run -d abc" }, false);
  assert.equal(gate.check("browser_take_screenshot", {}).kind, "allow");
  // Coordinate tap: allowed once a position analysis backs it.
  assert.equal(gate.check("mobile_tap", { target: "120,40" }).kind, "block");
  gate.observe("activity_inspect", { target: "mobile" }, false);
  assert.equal(gate.check("mobile_tap", { target: "120,40" }).kind, "allow");
});

test("each rule stands down after maxBlocks, so a run is never wedged", () => {
  // The two rules are independent and counted separately, so a call can be
  // refused twice for scope and then twice more for freshness — but never
  // forever. A gate that could deadlock a run would be worse than no gate.
  const gate = new QaGate({ maxBlocks: 2 });
  gate.observe(...EDIT, false);
  const reasons = [];
  for (let i = 0; i < 5; i++) {
    const d = gate.check("mobile_elements", {});
    reasons.push(d.kind === "block" ? d.reason : "allow");
  }
  assert.deepEqual(reasons, ["scope", "scope", "stale", "stale", "allow"]);
});

// ---- rule 2: never photograph a build you did not make ---------------------

test("a device capture after an edit is refused until the app is rebuilt", () => {
  const gate = new QaGate({
    deviceCommands: [{ command: "flutter run -d <id>", source: "README.md", kind: "device" }],
  });
  gate.observe(...EDIT, false);
  const blocked = gate.check("activity_inspect", { target: "mobile", bundleId: "com.x" });
  assert.equal(blocked.kind, "block");
  assert.equal(blocked.reason, "stale");
  assert.match(blocked.message, /OLD build/);
  assert.match(blocked.message, /flutter run -d <id>/, "the project's OWN command is quoted back");
  assert.match(blocked.message, /README\.md/, "and where it came from");
  assert.match(blocked.message, /profile\.dart/, "and what changed since the last deploy");
});

test("a build-only command does NOT clear the freshness debt", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.observe("bash", { command: "flutter build ios --simulator --no-codesign" }, false);
  assert.equal(
    gate.check("activity_inspect", { target: "mobile" }).kind,
    "block",
    "an artifact nobody installed leaves the device on the old code",
  );
});

test("a real build+install clears it, and a later edit re-opens it", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.observe("bash", { command: "flutter run -d E25EC6B1" }, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "allow");
  assert.deepEqual(gate.stalePaths(), [], "the debt is cleared, not just suppressed");
  // Edit again → the app on the device is stale again.
  gate.observe(...EDIT, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "block");
});

test("mobile_install_app also counts as putting new bytes on the device", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.observe("vendor__mobile_install_app", { device: "d", bundleId: "com.x" }, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "allow");
});

test("an activity_trace_start that launches onto a device clears the freshness debt", () => {
  // The run that motivated this: the edit was rebuilt + reinstalled by a trace
  // session running `flutter run`, but the gate only saw `resetStreak()` and kept
  // refusing the capture as the OLD build. A trace whose startCommand deploys to a
  // device is a deploy by another name. (`activity_inspect` is used because, unlike
  // a raw capture tool, it is exempt from the scope rule and so isolates freshness.)
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "block");
  gate.observe("activity_trace_start", { startCommand: "flutter run -d E25EC6B1 --flavor staging" }, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "allow");
  assert.deepEqual(gate.stalePaths(), [], "the debt is cleared, not just suppressed");
});

test("an activity_trace_start that only starts a web dev server does not clear device debt", () => {
  // `npm run dev` boots a browser surface, not a device; the freshness rule does
  // not gate the browser, and it must not be abused to unblock a mobile capture.
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.observe("activity_trace_start", { startCommand: "npm run dev" }, false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "block");
});

test("a FAILED deploy command does not clear the debt", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.observe("bash", { command: "flutter run -d E25EC6B1" }, true);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "block");
});

test("a probe-only edit opens no freshness debt", () => {
  // Instrumentation is scaffolding the run is about to strip; holding a capture
  // hostage to rebuilding for it would make the instrument→run→inspect spine
  // the gate is protecting impossible to walk.
  const gate = new QaGate();
  gate.observe(
    "edit",
    { path: "/p/a.ts", oldString: "const x = 1;", newString: 'console.log("TURING_TRACE x", { x });\nconst x = 1;' },
    false,
  );
  assert.equal(gate.hasWrites(), false);
  assert.equal(gate.check("activity_inspect", { target: "mobile" }).kind, "allow");
});

test("the browser is not held to the device's freshness rule", () => {
  // A dev server hot-reloads and may have been started outside this run, so
  // "no server was started HERE" is not evidence of a stale page.
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  gate.setVerifyPass(true);
  assert.equal(gate.check("activity_inspect", { url: "http://127.0.0.1:5173" }).kind, "allow");
});

// ---- rule 2: coordinate taps are derived from a capture, never nudged ------

test("the observed nudge loop is refused: tap, screenshot, tap, screenshot, tap", () => {
  // Today's real run: activity_inspect once, then (350,55) → shot → (365,55) →
  // shot → (368,48) → shot — pixel-nudging an avatar it never localized.
  const gate = new QaGate();
  gate.setVerifyPass(true);
  // The inspect grants ONE derived tap.
  assert.equal(run(gate, "activity_inspect", { target: "mobile" }).kind, "allow");
  assert.equal(run(gate, "mobile_tap", { target: "350,55" }).kind, "allow");
  // Raw screenshots between taps do NOT re-earn the credit — looking is not
  // reading a position off the image.
  run(gate, "browser_take_screenshot", {});
  const nudged = gate.check("mobile_tap", { target: "365,55" });
  assert.equal(nudged.kind, "block");
  assert.equal(nudged.reason, "blind-tap");
  // The refusal must hand back the ROUTE, not just say no. That route is now
  // "describe the target and let the tool resolve it", with `look` as the way
  // to read exact coordinates when you really do want to pass them.
  assert.match(nudged.message, /action: "tap"/);
  assert.match(nudged.message, /action: "look"/);
  assert.match(nudged.message, /LOGICAL POINTS/);
  assert.match(nudged.message, /nudging/i);
  assert.match(nudged.message, /ask_user_question/);
});

test("an analysis re-arms the tap; the tap spends it — one tap per derivation", () => {
  const gate = new QaGate();
  gate.setVerifyPass(true);
  run(gate, "activity_inspect", { target: "mobile" });
  assert.equal(run(gate, "mobile_tap", { target: "1,1" }).kind, "allow");
  assert.equal(gate.check("mobile_tap", { target: "2,2" }).kind, "block");
  // `media_analysis` of a screenshot is a position derivation too.
  gate.observe("media_analysis", { lens: "qa" }, false);
  assert.equal(gate.check("mobile_tap", { target: "2,2" }).kind, "allow");
  // Non-tap drive tools are never refused by this rule.
  assert.equal(gate.check("mobile_swipe", { to: "up" }).kind, "allow");
  assert.equal(gate.check("browser_click", { element: "r1" }).kind, "allow");
});

test("the blind-tap rule stands down after maxBlocks — bounded, not absolute", () => {
  const gate = new QaGate({ maxBlocks: 2 });
  gate.setVerifyPass(true);
  assert.equal(gate.check("mobile_tap", { target: "1,1" }).kind, "block");
  assert.equal(gate.check("mobile_tap", { target: "2,2" }).kind, "block");
  assert.equal(gate.check("mobile_tap", { target: "3,3" }).kind, "allow");
});

// ---- rule 3: a wall is a question, not a puzzle ----------------------------

test("driving in circles produces one nudge naming ask_user_question", () => {
  const gate = new QaGate({ stuckAfter: 4 });
  gate.setVerifyPass(true); // driving is legitimate here; it is the going-nowhere that is not
  // Swipes, not coordinate taps: the blind-tap rule would refuse unbacked taps
  // before the streak could build, and this test is about the stuck nudge.
  for (let i = 0; i < 3; i++) run(gate, "mobile_swipe", { to: "up" });
  assert.equal(gate.stuckNote(), null, "not yet");
  run(gate, "mobile_elements", {});
  const note = gate.stuckNote();
  assert.ok(note, "the nudge fires once the streak is reached");
  assert.match(note, /ask_user_question/);
  assert.match(note, /login|attach/i, "it says what the wall usually is and how the user can answer");
  assert.equal(gate.stuckNote(), null, "and fires only once per streak");
});

test("asking, writing or deploying resets the stuck counter", () => {
  const gate = new QaGate({ stuckAfter: 3 });
  gate.setVerifyPass(true);
  for (let i = 0; i < 3; i++) run(gate, "mobile_elements", {});
  assert.ok(gate.stuckNote());
  gate.observe("ask_user_question", { question: "what are the creds?" }, false);
  assert.equal(gate.stats().driveStreak, 0);
  for (let i = 0; i < 2; i++) run(gate, "mobile_elements", {});
  assert.equal(gate.stuckNote(), null, "the streak restarted after the question");
});

// ---- everything else is none of its business -------------------------------

test("the gate has no opinion on reads, greps, builds or traces", () => {
  const gate = new QaGate();
  gate.observe(...EDIT, false);
  for (const name of ["read", "grep", "bash", "activity_collect", "activity_study", "write"]) {
    assert.equal(gate.check(name, {}).kind, "allow", `${name} is not gated`);
  }
});
