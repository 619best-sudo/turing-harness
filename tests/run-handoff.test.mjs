/**
 * The verification run-handoff: build → ask-who-runs-it → drive-or-wait.
 *
 * Pure logic only — no LLM, no network. The stub "registry" only implements
 * getTool(), which is all detectSurfaces reads.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coordinateRunHandoff,
  detectSurfaces,
  needsRunningApp,
} from "../dist/orchestrator/run-handoff.js";
import { setLocalDeviceProbe } from "../dist/devices/local-devices.js";

// `coordinateRunHandoff` counts a booted simulator/emulator as a mobile surface
// even with no device MCP, so on a developer machine with one running these
// assertions would flip. Pin the inventory empty; the case where a local device
// IS present has its own test below.
setLocalDeviceProbe(async () => []);

/** Minimal registry stub: getTool returns truthy only for names in `names`. */
const stubRegistry = (names = []) => ({
  getTool: (n) => (names.includes(n) ? { name: n } : undefined),
});

test("detectSurfaces: none connected → both false", () => {
  assert.deepEqual(detectSurfaces(stubRegistry([])), { browser: false, mobile: false });
  assert.deepEqual(detectSurfaces(undefined), { browser: false, mobile: false });
});

test("detectSurfaces: playwright navigate present → browser true", () => {
  assert.deepEqual(
    detectSurfaces(stubRegistry(["mcp__playwright__browser_navigate"])),
    { browser: true, mobile: false },
  );
});

test("detectSurfaces: a device server present → mobile true", () => {
  assert.deepEqual(
    detectSurfaces(stubRegistry(["mobile_take_screenshot", "mobile_launch_app"])),
    { browser: false, mobile: true },
  );
});

test("needsRunningApp: only visual/endpoint require it", () => {
  assert.equal(needsRunningApp(["logic", "none", undefined]), false);
  assert.equal(needsRunningApp(["logic", "visual"]), true);
  assert.equal(needsRunningApp(["endpoint"]), true);
});

test("no question asked when no running app is needed (logic/static)", async () => {
  let asked = false;
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => { asked = true; return ""; },
    declaredMethods: ["logic", "none"],
  });
  assert.equal(asked, false);
  assert.equal(res.mode, "agent"); // verify loop proceeds directly
});

test("agent-drive when user picks 'You drive it'", async () => {
  let captured;
  const res = await coordinateRunHandoff({
    registry: stubRegistry(["mcp__playwright__browser_navigate"]),
    askUserQuestion: async (req) => { captured = req; return "You drive it"; },
    declaredMethods: ["visual"],
  });
  assert.equal(res.mode, "agent");
  assert.equal(res.surfaces.browser, true);
  assert.equal(captured.phase, "perfect"); // must stay in the host's typed union
  assert.equal(captured.answerMode, "single-select");
  assert.ok(captured.options.includes("You drive it"));
});

test("user-runs mode when user picks 'I'll run it myself'", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => "I'll run it myself",
    declaredMethods: ["visual"],
    evidenceDir: "/tmp/evidence",
  });
  assert.equal(res.mode, "user");
  assert.equal(res.evidenceDir, "/tmp/evidence");
});

test("user free-text with a path is captured as userEvidencePath", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => "/Users/me/app/debug.log",
    declaredMethods: ["endpoint"],
  });
  assert.equal(res.mode, "user");
  assert.equal(res.userEvidencePath, "/Users/me/app/debug.log");
});

test("skip mode when user picks 'Skip verification'", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => "Skip verification",
    declaredMethods: ["visual"],
  });
  assert.equal(res.mode, "skip");
});

test("degrades to agent when no askUserQuestion callback is installed", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry(["mcp__playwright__browser_navigate"]),
    declaredMethods: ["visual"],
  });
  assert.equal(res.mode, "agent");
});

test("degrades to skip when the host throws/aborts the question", async () => {
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => { throw new Error("user aborted"); },
    declaredMethods: ["visual"],
  });
  assert.equal(res.mode, "skip");
});

test("handoff options omit 'You drive it' when no surface is connected", async () => {
  let captured;
  await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async (req) => { captured = req; return "Skip verification"; },
    declaredMethods: ["visual"],
  });
  assert.ok(!captured.options.includes("You drive it"));
  assert.ok(captured.options.includes("I'll run it myself"));
  assert.ok(captured.options.includes("Skip verification"));
});

test("a booted simulator is a mobile surface even with no device MCP", async (t) => {
  // `activity_inspect` drives simctl/adb directly, so reporting `mobile: false`
  // here would withhold the mobile guidance from the verify round on exactly the
  // setup that needs it — the one where nothing is wired up yet.
  setLocalDeviceProbe(async () => [
    { id: "SIM-1", name: "iPhone 17 Pro", platform: "ios", state: "booted" },
  ]);
  t.after(() => setLocalDeviceProbe(async () => []));

  let captured;
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async (req) => { captured = req; return "You drive it"; },
    declaredMethods: ["visual"],
  });
  assert.equal(res.surfaces.mobile, true);
  assert.ok(captured.options.includes("You drive it"), "driving it is offered");
});

test("aborted signal short-circuits to skip", async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await coordinateRunHandoff({
    registry: stubRegistry([]),
    askUserQuestion: async () => "You drive it",
    declaredMethods: ["visual"],
    signal: controller.signal,
  });
  assert.equal(res.mode, "skip");
});
