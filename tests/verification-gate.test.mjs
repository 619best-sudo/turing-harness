/**
 * Verify what you wrote — the post-development gate, as a pure state machine.
 *
 * Mirrors reproduction-gate.test.mjs: the gate is exercised directly, no LLM,
 * no network. The integration with the loop/orchestrator is covered elsewhere.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VerificationGate,
} from "../dist/orchestrator/verification-gate.js";

const newGate = (opts) => new VerificationGate(opts ?? {});

test("a run with no writes is satisfied immediately", () => {
  const gate = newGate();
  assert.equal(gate.isSatisfied(), true);
  assert.deepEqual(gate.gaps(), []);
});

test("a written runtime file is owed evidence until a check covers it", () => {
  const gate = newGate();
  gate.observeWritten("/p/Button.tsx");
  // Extension fallback → visual, so it is owed.
  assert.equal(gate.isSatisfied(), false);
  const [gap] = gate.gaps();
  assert.equal(gap.path, "/p/Button.tsx");
  assert.equal(gap.method, "visual");
});

test("an activity_inspect that EVALUATED the screen clears an owed runtime file", () => {
  const gate = newGate();
  gate.observeWritten("/p/Button.tsx");
  gate.observeCheck("activity_inspect", false, 2048, "**Page inspection**\nVERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);
  const report = gate.toReport();
  assert.deepEqual(report.checked.map((c) => c.path), ["/p/Button.tsx"]);
  assert.match(report.checked[0].tool, /activity_inspect/);
});

test("an activity_inspect that only CAPTURED is not evidence — same rule as a raw screenshot", () => {
  // `activity_inspect` analyses by default, so a result with no verdict in it means
  // the caller turned analysis off. That is a capture, and a capture nobody
  // evaluated verifies nothing — crediting it is how a UI change shipped with the
  // gate reporting success. Consistent with the raw-screenshot test below.
  const gate = newGate();
  gate.observeWritten("/p/Button.tsx");
  gate.observeCheck("activity_inspect", false, 2048, "screenshot captured");
  assert.equal(gate.isSatisfied(), false);
  gate.observeCheck("activity_inspect", false, 2048, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);
});

test("a FAILED verdict from activity_inspect is not evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/Button.tsx");
  gate.observeCheck("activity_inspect", false, 2048, "VERDICT: FAIL — the heading still reads the old copy");
  assert.equal(gate.isSatisfied(), false);
});

test("a capture on a run with no media_analysis still counts — the gate must stay satisfiable", () => {
  // When `media_analysis` is not in the registry, `activity_inspect` cannot produce
  // a verdict however it is called, and says so. Requiring one there would make the
  // gate impossible to satisfy through no fault of the model.
  const gate = newGate();
  gate.observeWritten("/p/Button.tsx");
  gate.observeCheck(
    "activity_inspect",
    false,
    2048,
    "**Screenshot captured but not analysed** — `media_analysis` is not available this run.",
  );
  assert.equal(gate.isSatisfied(), true);
});

test("a raw browser screenshot is NOT visual evidence on its own — it must be evaluated (media_analysis)", () => {
  // A screenshot is a CAPTURE, not an EVALUATION. Crediting browser_take_screenshot
  // alone would satisfy the gate for an unanalyzed capture (under-verification).
  // The model must evaluate the screenshot (media_analysis with a PASS verdict),
  // or use activity_inspect (the harness's capture+analyse tool). Pins the revert.
  const gate = newGate();
  gate.observeWritten("/p/index.html");
  gate.observeCheck("browser_take_screenshot", false, 4096, "screenshot bytes");
  assert.equal(gate.isSatisfied(), false, "a raw screenshot does not verify a visual change");
  // Evaluating it via media_analysis (PASS) is what clears the file.
  gate.observeCheck("media_analysis", false, 512, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true, "media_analysis evaluation clears it");
});

test("media_analysis only counts as evidence on VERDICT: PASS", () => {
  const gate = newGate();
  gate.observeWritten("/p/Card.tsx");

  gate.observeCheck("media_analysis", false, 512, "VERDICT: FAIL - wrong color");
  assert.equal(gate.isSatisfied(), false);

  gate.observeCheck("media_analysis", false, 512, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);
});

test("a bash result counts as evidence only on a passing signal", () => {
  const gate = newGate();
  gate.observeWritten("/p/logic.ts");

  gate.observeCheck("bash", false, 200, "Error: test failed");
  assert.equal(gate.isSatisfied(), false);

  gate.observeCheck("bash", false, 200, "3 passed, 0 failed");
  assert.equal(gate.isSatisfied(), true);
});

test("errored or empty tool results are not evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/x.tsx");
  gate.observeCheck("activity_inspect", true, 0, "");
  assert.equal(gate.isSatisfied(), false);
  gate.observeCheck("activity_inspect", false, 0, "");
  assert.equal(gate.isSatisfied(), false);
});

test("MCP-prefixed tool names count (vendor__activity_inspect)", () => {
  const gate = newGate();
  gate.observeWritten("/p/screen.tsx");
  gate.observeCheck("vendor__activity_inspect", false, 1024, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);
});

test("a static file declared with a reason bypasses verification", () => {
  const gate = newGate();
  gate.observeWritten("/p/README.md");
  gate.declare([
    { path: "/p/README.md", tier: "static", method: "none", reason: "docs only" },
  ]);
  assert.equal(gate.isSatisfied(), true);
  const report = gate.toReport();
  assert.deepEqual(report.certified, [{ path: "/p/README.md", reason: "docs only" }]);
  assert.deepEqual(report.checked, []);
});

test("declare with method:none and a reason bypasses even a runtime extension", () => {
  const gate = newGate();
  gate.observeWritten("/p/util.ts");
  gate.declare([{ path: "/p/util.ts", method: "none", reason: "pure refactor, no behaviour change" }]);
  assert.equal(gate.isSatisfied(), true);
});

test("an undeclared .md file is bypassed by the extension fallback", () => {
  const gate = newGate();
  gate.observeWritten("/p/notes.md");
  assert.equal(gate.isSatisfied(), true);
  assert.deepEqual(gate.toReport().certified.map((c) => c.path), ["/p/notes.md"]);
});

test("re-writing a verified path resets its evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/a.tsx");
  gate.observeCheck("activity_inspect", false, 1024, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);

  gate.observeWritten("/p/a.tsx");
  assert.equal(gate.isSatisfied(), false);
  assert.equal(gate.gaps().length, 1);
});

test("a logic file is owed evidence and cleared by the trace loop", () => {
  const gate = newGate();
  gate.observeWritten("/p/handler.ts");
  assert.equal(gate.gaps()[0].method, "logic");
  gate.observeCheck("activity_collect", false, 800, "trace lines...");
  assert.equal(gate.isSatisfied(), true);
});

test("gaps carry a diff excerpt to focus the check", () => {
  const gate = newGate();
  gate.observeWritten(
    "/p/a.tsx",
    `--- a.tsx\n+++ a.tsx\n-export const Old = () => null;\n+export const New = ({label}) => <button>{label}</button>;`,
  );
  const [gap] = gate.gaps();
  assert.ok(gap.diffExcerpt.includes("+export const New"));
});

test("toReport splits checked / certified / unverified correctly", () => {
  const gate = newGate();
  gate.observeWritten("/p/checked.tsx");
  gate.observeWritten("/p/certified.md");
  gate.observeWritten("/p/unverified.ts");
  gate.declare([{ path: "/p/certified.md", tier: "static", reason: "docs" }]);
  gate.observeCheck("activity_inspect", false, 1024, "VERDICT: PASS");

  const report = gate.toReport();
  assert.deepEqual(report.checked.map((c) => c.path), ["/p/checked.tsx"]);
  assert.deepEqual(report.certified.map((c) => c.path), ["/p/certified.md"]);
  assert.deepEqual(report.unverified.map((c) => c.path), ["/p/unverified.ts"]);
});

test("a failed check does NOT clear evidence it never set, and stays unverified", () => {
  const gate = newGate();
  gate.observeWritten("/p/x.tsx");
  gate.observeCheck("media_analysis", false, 100, "VERDICT: FAIL");
  assert.equal(gate.isSatisfied(), false);
  assert.equal(gate.toReport().unverified.length, 1);
});

test("a retroactive none/static declaration does NOT demote an already-checked file", () => {
  // Report honesty: once a file has real evidence, a later "actually it needs
  // no check" cannot relabel it certified — that would hide a checked file as a skip.
  const gate = newGate();
  gate.observeWritten("/p/x.tsx");
  gate.observeCheck("activity_inspect", false, 1024, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true);
  gate.declare([{ path: "/p/x.tsx", tier: "static", method: "none", reason: "retroactive" }]);
  const report = gate.toReport();
  assert.deepEqual(report.checked.map((c) => c.path), ["/p/x.tsx"], "stays checked");
  assert.deepEqual(report.certified, [], "not demoted to certified");
});

test("maxRounds defaults to 5 (instrument/run/inspect/decide + a fix round) and is configurable", () => {
  assert.equal(newGate().maxRounds, 5);
  assert.equal(newGate({ maxRounds: 1 }).maxRounds, 1);
});

test("a declaration for a path that was never written is ignored", () => {
  const gate = newGate();
  gate.declare([{ path: "/p/never-written.ts", method: "none", reason: "n/a" }]);
  assert.equal(gate.isSatisfied(), true); // nothing owed
  assert.deepEqual(gate.toReport().certified, []);
});

test("a curl HTTP 200 is endpoint evidence (the verify message tells the model to curl)", () => {
  const gate = newGate();
  gate.observeWritten("/p/route.ts");
  gate.declare([{ path: "/p/route.ts", method: "endpoint" }]);
  assert.equal(gate.gaps()[0].method, "endpoint");
  assert.equal(gate.isSatisfied(), false);

  // A curl response line — previously ignored because BASH_PASS only matches
  // test-runner signals. This is the gap: the verify message says to curl.
  gate.observeCheck("bash", false, 64, "HTTP/1.1 200 OK");
  assert.equal(gate.isSatisfied(), true, "HTTP/1.1 200 OK should clear an endpoint file");
});

test("a bare 2xx status code (curl -w http_code) is endpoint evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/api.ts");
  gate.declare([{ path: "/p/api.ts", method: "endpoint" }]);
  gate.observeCheck("bash", false, 8, "204");
  assert.equal(gate.isSatisfied(), true);
});

test("a JSON success body counts as endpoint evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/handler.ts");
  gate.declare([{ path: "/p/handler.ts", method: "endpoint" }]);
  gate.observeCheck("bash", false, 80, '{"status":"ok","uptime":42}');
  assert.equal(gate.isSatisfied(), true);
});

test("a 4xx/5xx HTTP response is NOT evidence", () => {
  const gate = newGate();
  gate.observeWritten("/p/route.ts");
  gate.declare([{ path: "/p/route.ts", method: "endpoint" }]);
  gate.observeCheck("bash", false, 64, "HTTP/1.1 500 Internal Server Error");
  assert.equal(gate.isSatisfied(), false);
});

test("a curl HTTP 200 does NOT clear an owed logic file", () => {
  // A 200 OK proves the route answers, not that the logic behind it is correct.
  const gate = newGate();
  gate.observeWritten("/p/billing.ts"); // .ts → logic by extension
  gate.observeCheck("bash", false, 64, "HTTP/1.1 200 OK");
  assert.equal(gate.isSatisfied(), false, "HTTP success is endpoint-only evidence");
});
