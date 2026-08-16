/**
 * Straightforwardness assessor for the reproduce-before-edit gate.
 *
 * The assessor decides, from signals available AFTER the model has read files,
 * whether a bug fix is simple enough to skip reproduction (one source file, no
 * concurrency constructs, low declared complexity). These tests pin each signal
 * and the conservative combination — especially that the async/multi-file case
 * (the polling bug this was designed for) does NOT lift.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessStraightforward,
  scanForConcurrencyRisk,
  isSourceFile,
} from "../dist/index.js";
import { ReproductionGate } from "../dist/orchestrator/reproduction-gate.js";

// ---------------------------------------------------------------------------
// scanForConcurrencyRisk — the static async/concurrency detector
// ---------------------------------------------------------------------------

test("scanForConcurrencyRisk: flags JS/TS async constructs", () => {
  assert.equal(scanForConcurrencyRisk("await foo()"), true);
  assert.equal(scanForConcurrencyRisk("async function run() {}"), true);
  assert.equal(scanForConcurrencyRisk("Promise.all([...])"), true);
  assert.equal(scanForConcurrencyRisk("doThing().then(x => x)"), true);
  assert.equal(scanForConcurrencyRisk("setTimeout(fn, 100)"), true);
});

test("scanForConcurrencyRisk: flags the Dart constructs the polling bug used", () => {
  assert.equal(scanForConcurrencyRisk("Future<void> poll() async {}"), true);
  assert.equal(scanForConcurrencyRisk("Timer(Duration(seconds: 2), fn)"), true);
  assert.equal(scanForConcurrencyRisk("final c = Completer<int>();"), true);
  assert.equal(scanForConcurrencyRisk("Stream<List<int>> stream"), true);
});

test("scanForConcurrencyRisk: word-bounds the short identifiers", () => {
  // `await` inside `awaits` must NOT match.
  assert.equal(scanForConcurrencyRisk("const awaits = []"), false);
  // `Future` inside `FutureBuilder` IS a hit (word boundary before, letter after
  // — but \bFuture\b does not match inside FutureBuilder, which is correct: the
  // widget name alone is not async code).
  assert.equal(scanForConcurrencyRisk("class FutureBuilder extends StatelessWidget"), false);
});

test("scanForConcurrencyRisk: synchronous code is not flagged", () => {
  assert.equal(scanForConcurrencyRisk("<title>Solar System</title>"), false);
  assert.equal(scanForConcurrencyRisk("const x = 1 + 2;\nconsole.log(x);"), false);
  assert.equal(scanForConcurrencyRisk(""), false);
});

// ---------------------------------------------------------------------------
// isSourceFile
// ---------------------------------------------------------------------------

test("isSourceFile: source extensions count, logs/lockfiles don't", () => {
  assert.equal(isSourceFile("lib/app.dart"), true);
  assert.equal(isSourceFile("src/index.html"), true);
  assert.equal(isSourceFile("app.tsx"), true);
  assert.equal(isSourceFile("build.log"), false);
  assert.equal(isSourceFile("pnpm-lock.yaml"), true); // yaml is in the set
  assert.equal(isSourceFile("dist/bundle.js.map"), false);
});

// ---------------------------------------------------------------------------
// assessStraightforward — the combined verdict
// ---------------------------------------------------------------------------

test("assessStraightforward: returns undefined when nothing has been read yet", () => {
  assert.equal(assessStraightforward({}), undefined);
  assert.equal(assessStraightforward({ planTasks: [], readFiles: [] }), undefined);
});

test("assessStraightforward: one synchronous source file, low complexity → straightforward", () => {
  const v = assessStraightforward({
    planTasks: [{ files: ["index.html"], complexity: "low" }],
    readFiles: [{ path: "index.html", content: "<title>Hi</title>" }],
  });
  assert.ok(v?.straightforward, "a trivial single-file fix is straightforward");
  assert.match(v.reason, /one source file/i);
});

test("assessStraightforward: a single file with async constructs → NOT straightforward", () => {
  // The exact shape of the polling bug: one file, but it carries Future/Timer.
  const v = assessStraightforward({
    readFiles: [{ path: "polling.dart", content: "Future<void> poll() async { await refresh(); }" }],
  });
  assert.ok(v);
  assert.equal(v.straightforward, false, "async code keeps reproduction required");
  assert.match(v.reason, /concurrency/);
});

test("assessStraightforward: many source files → NOT straightforward (spread too wide)", () => {
  const v = assessStraightforward({
    planTasks: [
      { files: ["a.dart", "b.dart", "c.dart", "d.dart"], complexity: "low" },
    ],
  });
  assert.ok(v);
  assert.equal(v.straightforward, false, "a 4-file fix is not straightforward");
  assert.match(v.reason, /4 source file/);
});

test("assessStraightforward: planner-rated medium → NOT straightforward", () => {
  const v = assessStraightforward({
    planTasks: [{ files: ["one.ts"], complexity: "medium" }],
    readFiles: [{ path: "one.ts", content: "const x = 1;" }],
  });
  assert.ok(v);
  assert.equal(v.straightforward, false, "medium complexity keeps reproduction required");
});

test("assessStraightforward: the polling-status bug does NOT lift (multi-file + async)", () => {
  // The reported run: a polling bug touching lead_list_screen.dart + leads_provider.dart,
  // full of Future/Timer/polling. This is the regression this assessor exists to keep gated.
  const v = assessStraightforward({
    planTasks: [
      { files: ["lib/screens/lead_list/lead_list_screen.dart", "lib/providers/leads_provider.dart"], complexity: "high" },
    ],
    readFiles: [
      { path: "lib/screens/lead_list/lead_list_screen.dart", content: "Timer(Duration(seconds: 2), _poll)" },
    ],
  });
  assert.ok(v);
  assert.equal(v.straightforward, false);
});

test("assessStraightforward: two synchronous low files → still straightforward (the cap is 2)", () => {
  const v = assessStraightforward({
    planTasks: [{ files: ["a.ts", "b.ts"], complexity: "low" }],
    readFiles: [{ path: "a.ts", content: "const a = 1;" }, { path: "b.ts", content: "const b = 2;" }],
  });
  assert.equal(v?.straightforward, true, "two sync low files is within the straightforward threshold");
});

// ---------------------------------------------------------------------------
// ReproductionGate.assessAndLift — integration with the gate
// ---------------------------------------------------------------------------

test("assessAndLift lifts the gate for a straightforward fix (no model self-declaration)", () => {
  const gate = new ReproductionGate({ enabled: true });
  // Before assessment, an edit is blocked.
  assert.equal(gate.check("edit").kind, "block");
  const lifted = gate.assessAndLift(
    [{ files: ["index.html"], complexity: "low" }],
    [{ path: "index.html", content: "<title>x</title>" }],
  );
  assert.equal(lifted, true, "the assessor lifted the gate");
  assert.equal(gate.check("edit").kind, "allow", "the edit is now allowed");
});

test("assessAndLift does NOT lift for an async fix", () => {
  const gate = new ReproductionGate({ enabled: true });
  const lifted = gate.assessAndLift(undefined, [
    { path: "polling.dart", content: "Future<void> poll() async {}" },
  ]);
  assert.equal(lifted, false);
  assert.equal(gate.check("edit").kind, "block", "the gate stays armed for async fixes");
});

test("assessAndLift is a no-op once the gate is already lifted by evidence", () => {
  const gate = new ReproductionGate({ enabled: true });
  gate.observe("activity_inspect", false, 500); // evidence lifts it
  const lifted = gate.assessAndLift([{ files: ["x.ts"], complexity: "low" }], [{ path: "x.ts", content: "x" }]);
  assert.equal(lifted, false, "no re-lift after evidence");
});

test("assessAndLift is a no-op on a disabled (feature-run) gate", () => {
  const gate = new ReproductionGate({ enabled: false });
  const lifted = gate.assessAndLift([{ files: ["x.ts"], complexity: "low" }], [{ path: "x.ts", content: "x" }]);
  assert.equal(lifted, false);
});

test("toReport records when the lift was assessor-based", () => {
  const gate = new ReproductionGate({ enabled: true });
  gate.assessAndLift([{ files: ["index.html"], complexity: "low" }], [{ path: "index.html", content: "<t>x</t>" }]);
  const report = gate.toReport();
  assert.equal(report.assessedStraightforward, true);
  assert.ok(report.declaredStraightforward?.reason, "the evidence-backed reason is recorded");
});

// ---------------------------------------------------------------------------
// Block-time assessment via the read-files provider. The regression this guards:
// on the planless path the loop used to lift AFTER EACH READ, so reading a
// synchronous file FIRST lifted the gate before the model read the file carrying
// the async marker. The fix defers the planless assessment to BLOCK TIME (when an
// edit is about to be refused), so the assessor sees the FULL read set.
// ---------------------------------------------------------------------------

test("check() runs the assessor at block time via the read-files provider — sync-then-async does NOT lift", () => {
  const gate = new ReproductionGate({ enabled: true });
  const readContentByPath = new Map();
  gate.setReadFilesProvider(() => [...readContentByPath.entries()].map(([path, content]) => ({ path, content })));

  // The model reads a synchronous file first — on its own, simple.
  readContentByPath.set("/app/a.ts", "const greeting = hello;");
  // ...then reads the file that carries the async polling construct.
  readContentByPath.set("/app/b.dart", "Future<void> poll() async { Timer(Duration(seconds: 2), fn); }");

  // Now the edit: the gate runs the assessor with BOTH files at block time.
  // The old after-each-read lift would have lifted on a.ts and never seen b.dart.
  const verdict = gate.check("edit");
  assert.equal(verdict.kind, "block", "the async file read second must keep the gate armed");
});

test("check() lifts at block time for a genuinely simple single-file read", () => {
  const gate = new ReproductionGate({ enabled: true });
  const readContentByPath = new Map();
  gate.setReadFilesProvider(() => [...readContentByPath.entries()].map(([path, content]) => ({ path, content })));
  readContentByPath.set("/app/index.html", "<title>Solar System</title>");
  assert.equal(gate.check("edit").kind, "allow", "one trivial synchronous file lifts at block time");
});

test("check() is unaffected when no provider is registered (explicit assessAndLift still works)", () => {
  // The plan path and direct callers use assessAndLift directly, without a provider.
  const gate = new ReproductionGate({ enabled: true });
  assert.equal(gate.check("edit").kind, "block", "no provider, no prior lift → blocked");
  gate.assessAndLift([{ files: ["x.ts"], complexity: "low" }], [{ path: "x.ts", content: "const x = 1;" }]);
  assert.equal(gate.check("edit").kind, "allow", "explicit assessAndLift still lifts");
});


// ---------------------------------------------------------------------------
// Measured read complexity. Found by auditing a real bug fix: a 317-line
// hydration file with no async tokens was assessed straightforward and the gate
// lifted — on a bug whose real diagnosis took four files and instrumentation.
//
// The structural problem is that every other input here gets SAFER the less the
// model has looked at: file count is "files read so far", and the concurrency scan
// can only find what has been read. So read-one-file-then-edit — the exact pattern
// the gate exists to stop — presents as the simplest fix there is. The reader's
// measured rating is the one signal that describes the FILE rather than the run's
// progress through it.
// ---------------------------------------------------------------------------

test("a file measured above low on read keeps the gate armed", () => {
  const a = assessStraightforward({
    readFiles: [{ path: "src/message-hydration.ts", content: "function hydrate() { return 1; }", rating: "medium" }],
  });
  assert.equal(a.straightforward, false);
  assert.match(a.reason, /measured medium complexity on read/);
});

test("a measured-low single file still lifts, and the reason says so", () => {
  const a = assessStraightforward({
    readFiles: [{ path: "src/copy.ts", content: "export const TITLE = 'x';", rating: "low" }],
  });
  assert.equal(a.straightforward, true);
  assert.match(a.reason, /measured low on read/);
});

test("an unrated read behaves exactly as before (the rating is optional)", () => {
  const a = assessStraightforward({ readFiles: [{ path: "src/copy.ts", content: "export const TITLE = 'x';" }] });
  assert.equal(a.straightforward, true);
  assert.doesNotMatch(a.reason, /measured/);
});

test("the measured rating outranks a planner that called the work low", () => {
  // The planner rates before the code is seen; the reader rates the actual bytes.
  const a = assessStraightforward({
    planTasks: [{ files: ["src/hydration.ts"], complexity: "low" }],
    readFiles: [{ path: "src/hydration.ts", content: "function hydrate() {}", rating: "high" }],
  });
  assert.equal(a.straightforward, false);
  assert.match(a.reason, /measured high complexity on read/);
});

test("reading MORE files can no longer be what makes a fix look harder on its own", () => {
  // Two files, both genuinely trivial and measured low: still straightforward.
  // The point of the rating is that the verdict tracks the code, not the count.
  const a = assessStraightforward({
    readFiles: [
      { path: "src/a.ts", content: "export const A = 1;", rating: "low" },
      { path: "src/b.ts", content: "export const B = 2;", rating: "low" },
    ],
  });
  assert.equal(a.straightforward, true);
});
