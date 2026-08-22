/**
 * QA is two jobs, and they were one category.
 *
 * From the run that forced this: a bug report entered at `activity_inspect` —
 * hop 0, no read pass, nothing written — and the hop spent eight and a half
 * minutes making 25 `read`s, 6 `grep`s and 6 `bash`es without one driving or
 * capture call, then ended without delivering. It was holding a prompt about
 * judging changes, on a run where no change existed, with no files handed to it
 * because there was no previous hop to hand any.
 *
 * Split in two:
 *   read → activity_reproduce → write_edit → activity_inspect
 *
 *   - `activity_reproduce` runs BEFORE the fix. Input: read's code summary.
 *     Output: a `repro-report` — the symptom as observed, the evidence, the lines
 *     to change. No verdict, because there is nothing yet to pass judgement on.
 *   - `activity_inspect` runs AFTER. Input: the writes that landed. Output: an
 *     `inspect-report` with a pass/fail verdict.
 *
 * Both share ONE tool surface (`toolScope`), and neither may be a run's entry.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CATEGORIZER_PROMPTS,
  LogStore,
  Registry,
  buildCategorizerSystemPrompt,
  createDefaultCategorizers,
  createDeliverTool,
  deliverSchemaFor,
  enforceNoShellAuthoring,
  enforceObserveFirst,
  isBuildOnlyCommand,
  isObservationCall,
  isObservationTool,
  isRuntimeCommand,
  deriveFallbackDeliverable,
  entryCategories,
  createCategorizerSetup,
  registerBuiltins,
} from "../dist/index.js";

const CATS = createDefaultCategorizers();
const cat = (id) => CATS.find((c) => c.id === id);

// ---------------------------------------------------------------------------
// The contract of each role
// ---------------------------------------------------------------------------

test("the two QA hops have opposite inputs and opposite outputs", () => {
  const repro = cat("activity_reproduce");
  const inspect = cat("activity_inspect");

  // Reproduction is fed by reading; verification is fed by writing.
  assert.deepEqual(repro.accepts.from, ["read"]);
  assert.ok(inspect.accepts.from.includes("write_edit"));
  assert.deepEqual(inspect.accepts.tools, ["write", "edit"], "verification sees the actual edits");

  // A repro report carries evidence; only an inspect report carries a verdict.
  const reproSchema = deliverSchemaFor(repro);
  const inspectSchema = deliverSchemaFor(inspect);
  assert.ok(reproSchema.properties.reproduced, "reproduction says whether it was seen");
  assert.ok(reproSchema.properties.suspects, "reproduction names the lines to fix");
  assert.ok(!reproSchema.properties.verdict, "a pass BEFORE the fix must not be able to say 'pass'");
  assert.ok(inspectSchema.properties.verdict);

  // And the fixer receives both.
  assert.ok(cat("write_edit").accepts.from.includes("activity_reproduce"));
  assert.ok(cat("write_edit").accepts.from.includes("activity_inspect"));
});

test("neither QA hop can start a run", () => {
  const setup = createCategorizerSetup({ categories: CATS });
  const entries = entryCategories(setup).map((c) => c.id);
  assert.deepEqual(entries, ["conversation", "read", "write_edit"]);
  assert.ok(!entries.includes("activity_reproduce"), "reproducing needs read's files first");
  assert.ok(!entries.includes("activity_inspect"), "verifying needs a change to measure");
});

test("the reproduce hop inherits the whole QA tool surface without re-declaring it", () => {
  // auto mode: the legacy heuristic scoping this test originally pinned. Under
  // the default "selection" mode a connected external MCP reaches no hop until
  // it is named (see category-leaks.test.mjs) — but a SELECTED server must
  // still reach the reproduce hop through the very same toolScope seam, which
  // the second registry below pins.
  const reg = new Registry({ externalMcpScoping: "auto" });
  registerBuiltins(reg, { logStore: new LogStore() });
  const browser = ["browser_navigate", "browser_click", "browser_take_screenshot", "browser_snapshot"].map(
    (name) => ({
      name,
      description: `${name.replace(/_/g, " ")} in the page`,
      parameters: { type: "object", properties: {} },
      async execute() {
        return {};
      },
    }),
  );
  reg.add({ id: "mcp:chrome", kind: "mcp", source: "external", name: "chrome-devtools", tools: browser });

  // `toolScope` is the seam: the tools say "activity_inspect" and never have to
  // learn a second id.
  assert.equal(cat("activity_reproduce").toolScope, "activity_inspect");
  const scoped = reg.getToolsForCategorizer(cat("activity_reproduce").toolScope).map((t) => t.name);
  for (const name of ["browser_navigate", "browser_take_screenshot", "activity_trace_start", "drive", "mobile"]) {
    assert.ok(scoped.includes(name), `${name} reaches the reproduce hop`);
  }

  // Selection mode: a composer-selected server rides the same seam.
  const reg2 = new Registry();
  registerBuiltins(reg2, { logStore: new LogStore() });
  reg2.add({ id: "mcp:chrome", kind: "mcp", source: "external", name: "chrome-devtools", tools: browser });
  reg2.selectExternalMcps(["chrome-devtools"], ["conversation", "read", "write_edit", "activity_inspect"]);
  const scoped2 = reg2.getToolsForCategorizer(cat("activity_reproduce").toolScope).map((t) => t.name);
  for (const name of ["browser_navigate", "browser_take_screenshot", "drive", "mobile"]) {
    assert.ok(scoped2.includes(name), `${name} reaches the reproduce hop when selected`);
  }
});

test("the reproduce prompt is about seeing the defect, not judging a change", () => {
  const p = buildCategorizerSystemPrompt({
    id: "activity_reproduce",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_reproduce,
    children: ["write_edit"],
  });
  assert.match(p, /ACTIVITY REPRODUCE categorizer/);
  assert.match(p, /There is NO fix yet and nothing to verify/);
  assert.match(p, /IF YOU CANNOT REPRODUCE IT, SAY SO/);
  assert.match(p, /whole-file analyses are ALREADY IN YOUR CONTEXT/, "the handed analyses are named");
  assert.match(p, /going back for more of them is how this hop turns into a second\s+read pass/);
  // It must not carry the verify half's instructions.
  assert.ok(!/VERDICT: pass \| fail/.test(p), "no verdict in the pre-fix pass");
});

// ---------------------------------------------------------------------------
// Observe-first
// ---------------------------------------------------------------------------

const t = (name, over = {}) => ({
  name,
  description: `${name} does a thing`,
  parameters: { type: "object", properties: {} },
  async execute() {
    return { output: "ok" };
  },
  ...over,
});

const call = (tool, args = {}) => tool.execute("id", args, { cwd: process.cwd() });

test("reproduced:true demands evidence — a launched process nobody drove is corrected", async () => {
  // The field run this replays: the app was launched through the trace, the
  // agent REASONED about navigating to the reported screen, never made one
  // mobile/drive call, collected nothing, and delivered `reproduced: true`
  // from analysis plus glimpsed log lines. The gate now refuses once (go
  // drive it), then corrects the re-issue to an honest false.
  const box = { delivered: false };
  const collect = t("activity_collect", {
    async execute() {
      return { output: "no lines yet", details: { captured: 0 } };
    },
  });
  const tools = enforceObserveFirst(
    [t("bash"), t("mobile"), t("activity_trace_start"), t("add_log"), collect, createDeliverTool(cat("activity_reproduce"), box)],
    { probesBeforeLaunch: true },
  );
  const T = (n) => tools.find((x) => x.name === n);

  await call(T("activity_trace_start"), {});
  await call(T("add_log"), { path: "/a.dart" });
  await call(T("bash"), { command: "flutter run -d sim" }); // observed: a process ran
  await call(T("activity_collect"), { traceId: "t1" }); // captured: 0

  const first = await call(T("deliver"), { reproduced: true, symptom: "status never repaints" });
  assert.equal(first.isError, true, "refused once: nobody drove the app");
  assert.match(first.output, /nobody drove it/);
  assert.match(first.output, /mobile \{ action: "look" \}/, "names how to start walking");
  assert.equal(box.delivered, false);

  // The re-issue goes through — corrected to the honest report.
  const second = await call(T("deliver"), { reproduced: true, symptom: "status never repaints" });
  assert.notEqual(second.isError, true, "the re-issue is not blocked");
  assert.equal(box.delivered, true);
  assert.equal(box.deliverable.reproduced, false, "corrected: not witnessed");
  assert.match(box.deliverable.symptom, /NOT DRIVEN/, "the symptom says what is missing");
});

test("evidence unlocks reproduced:true — a drive or a collected probe line", async () => {
  const walk = async (collectCaptured, useMobile) => {
    const box = { delivered: false };
    const collect = t("activity_collect", {
      async execute() {
        return { output: "lines", details: { captured: collectCaptured } };
      },
    });
    const tools = enforceObserveFirst(
      [t("bash"), t("mobile"), t("activity_trace_start"), t("add_log"), collect, createDeliverTool(cat("activity_reproduce"), box)],
      { probesBeforeLaunch: true },
    );
    const T = (n) => tools.find((x) => x.name === n);
    await call(T("activity_trace_start"), {});
    await call(T("add_log"), { path: "/a.dart" });
    await call(T("bash"), { command: "flutter run -d sim" });
    if (useMobile) await call(T("mobile"), { action: "look" });
    await call(T("activity_collect"), { traceId: "t1" });
    const res = await call(T("deliver"), { reproduced: true, symptom: "saw it" });
    return { res, box };
  };

  // A VISIBLE defect: no probes collect, but the screen was walked and captured.
  const visible = await walk(0, true);
  assert.notEqual(visible.res.isError, true, "a driven/captured UI is evidence");
  assert.equal(visible.box.deliverable.reproduced, true, "not corrected");

  // An INVISIBLE defect: no screenshot proves anything, but the probes printed.
  const invisible = await walk(3, false);
  assert.notEqual(invisible.res.isError, true, "collected probe lines are evidence");
  assert.equal(invisible.box.deliverable.reproduced, true, "not corrected");
});

test("a QA hop's deliver is refused once until it has observed something", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([t("read"), t("grep"), t("drive"), createDeliverTool(cat("activity_reproduce"), box)]);
  const deliver = tools.find((x) => x.name === "deliver");
  assert.match(deliver.description, /Refused once if you have not yet RUN or CAPTURED anything/);

  // Reading and grepping is not observing.
  await call(tools.find((x) => x.name === "read"));
  await call(tools.find((x) => x.name === "grep"));
  const refused = await call(deliver, { reproduced: true, symptom: "x" });
  assert.equal(refused.isError, true);
  assert.match(refused.output, /has not observed the software running/);
  assert.equal(box.delivered, false, "nothing was captured from the refused call");

  // One observation is enough.
  await call(tools.find((x) => x.name === "drive"));
  const ok = await call(deliver, { reproduced: true, symptom: "the status never repaints" });
  assert.equal(ok.isError ?? false, false);
  assert.equal(box.delivered, true);
});

test("the refusal is one turn, never a deadlock", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([t("drive"), createDeliverTool(cat("activity_reproduce"), box)]);
  const deliver = tools.find((x) => x.name === "deliver");

  assert.equal((await call(deliver, { reproduced: false, symptom: "could not reach the screen" })).isError, true);
  // Re-issued: it goes through, so a hop that genuinely cannot observe — no
  // device, no credentials — still lands its honest report.
  const second = await call(deliver, { reproduced: false, symptom: "could not reach the screen" });
  assert.equal(second.isError ?? false, false);
  assert.equal(box.delivered, true);
});

test("the guard does not arm when the hop cannot observe anything", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([t("read"), t("grep"), createDeliverTool(cat("activity_reproduce"), box)]);
  const first = await call(tools.find((x) => x.name === "deliver"), { reproduced: false, symptom: "x" });
  assert.equal(first.isError ?? false, false, "no observation tool in the hop ⇒ nothing to demand");
  assert.equal(box.delivered, true);
});

test("what counts as observing", () => {
  for (const name of [
    "drive",
    "mobile",
    "browser_navigate",
    "chrome__browser_take_screenshot",
    "activity_collect",
    "activity_inspect",
    "media_analysis",
    "bash",
    "lighthouse_audit",
    "performance_start_trace",
  ]) {
    assert.equal(isObservationTool(name), true, `${name} observes`);
  }
  for (const name of ["read", "grep", "ls", "file_memory", "graph_memory", "create_plan", "write", "edit", "deliver"]) {
    assert.equal(isObservationTool(name), false, `${name} does not observe`);
  }
});

test("a hop that ended without delivering reports NOT reproduced, never a confirmed symptom", () => {
  const fallback = deriveFallbackDeliverable(cat("activity_reproduce"), {
    writtenPaths: [],
    readPaths: ["/a.dart", "/b.dart"],
    finalText: "I believe the bug is in the polling service.",
  });
  assert.equal(fallback.reproduced, false, "nobody confirmed it, so it is not confirmed");
  assert.match(fallback.symptom, /deliver was not called/);
  assert.deepEqual(fallback.suspects, [{ path: "/a.dart" }, { path: "/b.dart" }]);

  const empty = deriveFallbackDeliverable(cat("activity_reproduce"), {
    writtenPaths: [],
    readPaths: [],
    finalText: "",
  });
  assert.equal(empty.reproduced, false);
  assert.match(empty.symptom, /ended without reporting what it saw/);
});

// ---------------------------------------------------------------------------
// Observing means RUNNING it — from the run where the guard was satisfied by a
// `find`, and cleanup became the way out
// ---------------------------------------------------------------------------

/**
 * The sequence, node by node, from the session that prompted this:
 *
 *   53 activity_trace_start            instrumenting
 *   54 add_log                         one probe landed
 *   55-58 add_log ×4                   all refused ("not log-only")
 *   59 bash: find -name "*test*"       ← marked the hop as having "observed"
 *   61 bash: flutter devices           found a booted iPhone simulator
 *   62 activity_cleanup                stripped its own probes, having run nothing
 *   65 deliver { reproduced: true }    a code analysis, reported as a sighting
 *
 * Its own reasoning at 62: "I should use the iPhone simulator to reproduce the
 * bug. However, I need to check if there's a way to run the app."
 */
test("a shell command counts only when it RUNS the software", () => {
  for (const cmd of [
    'find . -name "*test*" -type f',
    "ls -la /app",
    "cd /app && flutter devices",
    "adb devices",
    "flutter build apk",
    "tsc --noEmit",
    "cargo check",
    "which flutter",
    "cat pubspec.yaml",
  ]) {
    assert.equal(isRuntimeCommand(cmd), false, `must not count: ${cmd}`);
  }
  for (const cmd of [
    "cd /app && flutter run -d 1234",
    "flutter test",
    "npm test",
    "npm run dev",
    "pytest -k polling",
    "go test ./...",
    "cargo run",
    "curl -s localhost:3000/api/leads",
    "xcrun simctl launch booted com.app",
    "adb shell am start -n com.app/.Main",
    "make test",
    "bundle exec rspec",
    "npx playwright test",
  ]) {
    assert.equal(isRuntimeCommand(cmd), true, `must count: ${cmd}`);
  }
  // A build proves it compiles, which is the false confidence the guard rejects.
  assert.equal(isRuntimeCommand("flutter build ios --release"), false);
  // The args decide for bash, and only for bash.
  assert.equal(isObservationCall("bash", { command: "find . -name x" }), false);
  assert.equal(isObservationCall("bash", { command: "flutter test" }), true);
  assert.equal(isObservationCall("chrome__browser_take_screenshot", {}), true);
  assert.equal(isObservationCall("read", { path: "/a" }), false);
  // Name-only callers still see bash as capable of observing.
  assert.equal(isObservationTool("bash"), true);
});

test("probes may not be stripped before the flow has run", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([
    t("bash"), t("mobile"), t("activity_trace_start"), t("add_log"),
    t("activity_cleanup"), t("activity_collect"),
    createDeliverTool(cat("activity_reproduce"), box),
  ]);
  const T = (n) => tools.find((x) => x.name === n);

  await call(T("activity_trace_start"), { hint: "polling" });
  await call(T("add_log"), { path: "/a.dart" });
  // The three shell calls the real run made. None of them runs the app.
  await call(T("bash"), { command: 'find /app -name "*test*" -type f' });
  await call(T("bash"), { command: "ls -la /app" });
  await call(T("bash"), { command: "cd /app && flutter devices" });

  const cleanup = await call(T("activity_cleanup"), { traceId: "t1" });
  assert.equal(cleanup.isError, true, "node 62: refused");
  assert.match(cleanup.output, /recorded nothing/);
  assert.match(cleanup.output, /startCommand/, "names the launch-through-trace road");

  const delivered = await call(T("deliver"), { reproduced: true, symptom: "status never repaints" });
  assert.equal(delivered.isError, true, "node 65: refused");
  assert.match(delivered.output, /Listing devices or searching for test files is not running it/);
  assert.equal(box.delivered, false);

  // The recovery it was being steered to.
  await call(T("mobile"), { action: "launch" });
  await call(T("activity_collect"), { traceId: "t1" });
  assert.notEqual((await call(T("activity_cleanup"), { traceId: "t1" })).isError, true, "cleanup after running is fine");
  const ok = await call(T("deliver"), { reproduced: true, symptom: "status never repaints" });
  assert.equal(ok.isError ?? false, false);
  assert.equal(box.deliverable.reproduced, true, "the claim stands because it was observed");
});

test("cleanup is never a deadlock, and an unearned reproduction is corrected", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([
    t("mobile"), t("add_log"), t("activity_cleanup"),
    createDeliverTool(cat("activity_reproduce"), box),
  ]);
  const T = (n) => tools.find((x) => x.name === n);

  await call(T("add_log"), { path: "/a.dart" });
  assert.equal((await call(T("activity_cleanup"), {})).isError, true, "first cleanup refused");
  assert.notEqual((await call(T("activity_cleanup"), {})).isError, true, "re-issued cleanup proceeds");

  assert.equal((await call(T("deliver"), { reproduced: true, symptom: "the early return skips notifyListeners" })).isError, true);
  const second = await call(T("deliver"), { reproduced: true, symptom: "the early return skips notifyListeners" });
  assert.equal(second.isError ?? false, false, "a hop that cannot run still lands its report");
  // The one thing that must not survive: a defect claimed as witnessed by a pass
  // that witnessed nothing.
  assert.equal(box.deliverable.reproduced, false);
  assert.match(box.deliverable.symptom, /NOT OBSERVED/);
  assert.match(box.deliverable.symptom, /the early return skips notifyListeners/, "the analysis itself is kept");
});

test("cleanup is untouched when no probe was ever placed", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([t("mobile"), t("activity_cleanup"), createDeliverTool(cat("activity_inspect"), box)]);
  const cleanup = await call(tools.find((x) => x.name === "activity_cleanup"), {});
  assert.notEqual(cleanup.isError, true, "nothing to protect, nothing to refuse");
});

test("every driving category asks at a UI wall instead of dying on it", () => {
  // The field run (session 6f38e661): the reproduce hop READ that the app uses
  // Auth0, concluded "I can't run the full app", never launched the simulator,
  // never called ask_user_question, and spent the pass reverse-engineering
  // mockability. A wall is a question for the user — met by driving, not
  // convicted from source. Taught in the QA asking slot, the shared driving
  // guidance (so write_edit and any custom driving category get it too), and
  // each hop's own procedure.
  const build = (id, children) =>
    buildCategorizerSystemPrompt({ id, systemPrompt: DEFAULT_CATEGORIZER_PROMPTS[id], children });

  for (const id of ["activity_reproduce", "activity_inspect"]) {
    const p = build(id, ["write_edit"]);
    assert.match(p, /A WALL MET WHILE DRIVING/, `${id}: the asking slot names the wall case`);
    assert.match(p, /BLOCKED IN THE UI/, `${id}: the driving guidance carries the protocol`);
    assert.match(p, /ask_user_question` AT THE WALL|ask_user_question` with the/, `${id}: ask AT the wall`);
    assert.match(p, /do (?:that one|the) step themselves/, `${id}: the user can drive one step`);
    // Anti-pre-judgment: never decide from code that the run is impossible.
    assert.match(
      p,
      /login exists SOMEWHERE, not that (your|YOUR) run will meet it|pre-judge the wall from the/,
      `${id}: reading code is not a verdict on the run`,
    );
  }

  const repro = build("activity_reproduce", ["write_edit"]);
  assert.match(repro, /A WALL IS A QUESTION, NOT A VERDICT/);
  assert.match(repro, /LAUNCH FIRST and see/, "walls are settled by meeting them, not by reading");

  const inspect = build("activity_inspect", ["write_edit"]);
  assert.match(inspect, /pre-judge the\n?\s*wall from the code/i);

  // The shared driving guidance reaches the work pass too.
  const work = build("write_edit", ["activity_inspect"]);
  assert.match(work, /BLOCKED IN THE UI/, "write_edit carries the same wall protocol");
});

test("the reproduce prompt says what to do when add_log refuses, and not to strip early", () => {
  const p = buildCategorizerSystemPrompt({
    id: "activity_reproduce",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_reproduce,
    children: ["write_edit"],
  });
  assert.match(p, /A LOG-ONLY EDIT IS ONE INSERTED LINE/);
  assert.match(p, /do not rewrite the function around the probe/);
  assert.match(p, /NEVER STRIP PROBES YOU HAVE NOT RUN/);
  assert.match(p, /the harness knows\s+whether this pass ran anything/);
});

test("the reproduce prompt launches the app THROUGH the trace, and carries the repro spine", () => {
  // Six field runs against one Flutter bug produced six empty trace files: every
  // one launched the app OUTSIDE the trace (`mobile launch` of an installed
  // build, a bare `flutter run` in bash), so probe output went where
  // `activity_collect` never reads. The prompt now makes startCommand the
  // launch vehicle, and the ordered spine states it where prose cannot be
  // skipped past.
  const p = buildCategorizerSystemPrompt({
    id: "activity_reproduce",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_reproduce,
    children: ["write_edit"],
  });
  assert.match(p, /THE REPRO SEQUENCE — seven steps/, "the ordered spine is attached");
  assert.match(p, /\b3\. PROBE\b/, "probes come BEFORE the launch");
  assert.match(p, /\b4\. LAUNCH\b/, "the launch attaches to the open session");
  assert.match(p, /activity_trace_start\ { startCommand:/, "step LAUNCH names the startCommand form");
  assert.match(p, /attaches to the SAME session/, "relaunch keeps the probe marker");
  assert.match(p, /only road probe output has to the\s+trace file/, "and says WHY: that pipe is the evidence road");
  assert.match(p, /LAUNCHING IS NOT REPRODUCING/, "launch alone is not a reproduction");
  assert.match(
    p,
    /mobile \{action:\\"launch\\"\} of an installed build|of the installed build/,
    "warns against outside-the-trace launches",
  );
  assert.match(p, /STEP 4 — INSTRUMENT THEN LAUNCH THROUGH THE TRACE/);
  assert.match(p, /re-issu\w+ `activity_trace_start` with `startCommand`/, "the relaunch road is named");

  // The verify pass keeps its own spine — the two must not collapse into one.
  const w = buildCategorizerSystemPrompt({
    id: "write_edit",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit,
    children: ["activity_inspect"],
  });
  assert.match(w, /THE QA SEQUENCE — eight steps/, "write_edit still carries the QA spine");
});

test("the reproduce hop refuses a build-only bash call once, the verify hop does not", async () => {
  // `flutter build web`, three times, in one field run — an artifact on disk
  // while the defect stayed unobserved. One-shot in the reproduce hop only:
  // the verify sequence has an explicit BUILD step before its run. The rule is
  // about the ACT, not the stack — every ecosystem's build shape is covered.
  const bash = t("bash");
  const buildCmd = "cd /app && flutter build web --release";

  const reproTools = enforceObserveFirst([bash], { probesBeforeLaunch: true });
  const first = await call(reproTools.find((x) => x.name === "bash"), { command: buildCmd });
  assert.equal(first.isError, true, "build-only in the reproduce hop is refused");
  assert.match(first.output, /BUILDS but runs nothing/);
  assert.match(first.output, /startCommand/, "points at the launch-through-trace road");
  const second = await call(reproTools.find((x) => x.name === "bash"), { command: buildCmd });
  assert.notEqual(second.isError, true, "one-shot: the re-issue goes through");

  const verifyTools = enforceObserveFirst([bash], { probesBeforeLaunch: false });
  const verifyRun = await call(verifyTools.find((x) => x.name === "bash"), { command: buildCmd });
  assert.notEqual(verifyRun.isError, true, "the verify hop's BUILD step is legitimate");

  // A command that runs after building is not build-only.
  const reproTools2 = enforceObserveFirst([bash], { probesBeforeLaunch: true });
  const mixed = await call(reproTools2.find((x) => x.name === "bash"), {
    command: "cd /app && flutter build web --release && flutter run -d chrome",
  });
  assert.notEqual(mixed.isError, true, "build && run is a run, not a build");

  // A TEST command is named as what it is. The field run interrupted
  // `flutter test` with "you are about to run the app" and the model spent a
  // turn parsing the mismatch; the advice is only usable if it names the
  // thing it interrupted.
  const reproTools3 = enforceObserveFirst(
    [bash, t("activity_trace_start"), t("add_log")],
    { probesBeforeLaunch: true },
  );
  const testRun = await call(reproTools3.find((x) => x.name === "bash"), {
    command: "cd /app && flutter test --no-pub 2>&1 | tail -20",
  });
  assert.equal(testRun.isError, true, "a first test run with no probes is still interrupted once");
  assert.match(testRun.output, /TEST suite/, "names the test suite, not 'the app'");
  assert.match(testRun.output, /legitimate way to run it/, "a test exercising the path counts as a run");
});

test("build-only and run detection are stack-balanced, not Flutter-shaped", async () => {
  // The rule must hold on a native-android, native-iOS, backend or plain-web
  // project exactly as it does on the Flutter one the field run happened on.
  assert.equal(isBuildOnlyCommand("cd /app && go build ./..."), true, "go build is a build");
  assert.equal(isBuildOnlyCommand("xcodebuild -workspace App.xcworkspace -scheme App"), true, "xcodebuild is a build");
  assert.equal(isBuildOnlyCommand("./gradlew assembleRelease"), true, "gradle assemble is a build");
  assert.equal(isBuildOnlyCommand("swift build"), true, "swift build is a build");
  assert.equal(isBuildOnlyCommand("mvn package -DskipTests"), true, "maven package is a build");
  assert.equal(isBuildOnlyCommand("cargo build --release"), true, "cargo build is a build");

  // Runs that build on the way are runs, and other stacks' launches are runs.
  assert.equal(isBuildOnlyCommand("npx react-native run-ios"), false, "RN launches the app");
  assert.equal(isBuildOnlyCommand("expo start"), false, "expo starts the dev server");
  assert.equal(isRuntimeCommand("npx react-native run-ios --simulator 'iPhone 17 Pro'"), true);
  assert.equal(isRuntimeCommand("npx expo start --port 8081"), true);
  assert.equal(isRuntimeCommand("uvicorn app.main:app --reload"), false, "pre-existing scope: only listed shapes");
});

// ---------------------------------------------------------------------------
// A QA hop may not reach into the source tree
// ---------------------------------------------------------------------------

/**
 * From the run after the split landed. The reproduce hop never instrumented and
 * never launched anything; it explored with `find`/`ls`/`cat`, and then:
 *
 *   git checkout lib/providers/leads_provider.dart lib/services/…       reverted work
 *   cat /tmp/fix.patch                                                  built a patch
 *   python3 << 'PYTHON' … open('lib/providers/leads_provider.dart','w')  authored the fix
 *
 * Both QA prompts say at length that they do not author product code, and neither
 * hop holds `write` or `edit`. `bash` is a global tool and does not care.
 */
const CWD = "/Users/x/app";
const shell = {
  name: "bash",
  description: "Run a shell command.",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  async execute(_id, args) {
    return { output: `ran: ${args.command}` };
  },
};
const runShell = (command) => {
  const [guarded] = enforceNoShellAuthoring([shell], CWD);
  return guarded.execute("id", { command }, { cwd: CWD });
};

test("the shell may not author project source in a QA hop", async () => {
  const py = await runShell(
    `cd ${CWD} && python3 << 'PYTHON'\nwith open('lib/providers/leads_provider.dart','w') as f:\n    f.write('x')\nPYTHON`,
  );
  assert.equal(py.isError, true);
  assert.match(py.output, /does not author product code/);
  assert.match(py.output, /add_log/, "names the tool that owns probes");
  assert.match(py.output, /write_edit/, "names the hop that owns the fix");

  for (const cmd of [
    "sed -i '' 's/a/b/' lib/main.dart",
    "cat > lib/main.dart << 'EOF'\nvoid main(){}\nEOF",
    "echo 'x' >> lib/main.dart",
  ]) {
    assert.equal((await runShell(cmd)).isError, true, cmd);
  }
});

test("the shell may not undo work in a QA hop", async () => {
  const revert = await runShell(`cd ${CWD} && git checkout lib/providers/leads_provider.dart`);
  assert.equal(revert.isError, true);
  assert.match(revert.output, /does not undo work/);
  for (const cmd of ["git restore lib/main.dart", "git reset --hard HEAD", "git clean -fd", "git stash"]) {
    assert.equal((await runShell(cmd)).isError, true, cmd);
  }
});

test("everything a QA hop legitimately needs the shell for still works", async () => {
  for (const cmd of [
    // Exploring.
    "find . -name '*.dart' | head -20",
    "ls -la test/",
    "mkdir -p test",
    "cat lib/providers/leads_provider.dart | sed -n '536,573p'",
    // Inspecting without changing.
    "git diff lib/providers/leads_provider.dart",
    "git status",
    "git stash list",
    // The thing this hop is FOR.
    `cd ${CWD} && flutter test`,
    `cd ${CWD} && flutter run -d 123`,
    "curl -s localhost:3000/api",
    // Scratch space outside the project is still writable.
    "cat > /tmp/scratch.dart << 'EOF'\nvoid main(){}\nEOF",
    "python3 -c \"print(1+1)\"",
  ]) {
    const res = await runShell(cmd);
    assert.equal(res.isError ?? false, false, `${cmd} must be allowed`);
  }
});

// ---------------------------------------------------------------------------
// Probes are a decision, and the launch is the deadline
// ---------------------------------------------------------------------------

/**
 * From the run that finally launched the app. It found a simulator, ran
 * `flutter run --flavor staging` — and then reasoned: "I'm realizing that
 * reproducing this bug visually is quite complex: it requires having leads in
 * enriching status, seeing that the status doesn't update…". That is exactly what
 * probes are for, realised one step too late, and it went back to reading source
 * and then to `flutter build ios`, where the run was stopped by hand.
 *
 * A probe has to be compiled in, so the launch is the last moment the choice is
 * cheap. The guard interrupts there, once, and makes it a choice rather than an
 * omission.
 */
const reproTools = (extra = []) =>
  enforceObserveFirst(
    [
      t("read"), t("grep"), t("bash"), t("mobile"), t("drive"),
      t("activity_trace_start"), t("add_log"), t("activity_collect"),
      ...extra,
    ],
    { probesBeforeLaunch: true },
  );

test("launching with no probes is interrupted once, as a choice", async () => {
  const box = { delivered: false };
  const tools = reproTools([createDeliverTool(cat("activity_reproduce"), box)]);
  const T = (n) => tools.find((x) => x.name === n);

  // The exploration from the real run: neither of these is a launch.
  await call(T("bash"), { command: "ls -la /app" });
  await call(T("bash"), { command: "fvm flutter devices" });

  const launch = await call(T("bash"), { command: "fvm flutter run --flavor staging -d 'iPhone 17 Pro'" });
  assert.equal(launch.isError, true);
  assert.match(launch.output, /no probes in it/);
  assert.match(launch.output, /VISIBLE on screen/, "the visible branch is named");
  assert.match(launch.output, /VALUE THAT NEVER ARRIVES/, "so is the invisible one");
  assert.match(launch.output, /compiled in/, "and why the deadline is now");

  // Visible defect: re-issue, go CAPTURE the screen, deliver. Never a deadlock.
  const again = await call(T("bash"), { command: "fvm flutter run --flavor staging -d 'iPhone 17 Pro'" });
  assert.equal(again.isError ?? false, false);
  await call(T("mobile"), { action: "look" }); // the capture that is the evidence
  const delivered = await call(T("deliver"), { reproduced: true, symptom: "the row never repaints" });
  assert.equal(delivered.isError ?? false, false);
  assert.equal(box.deliverable.reproduced, true, "the capture counted as witnessing");
});

test("instrumenting first means never being interrupted", async () => {
  const box = { delivered: false };
  // The invisible-defect shape: the probes' collected lines are the evidence.
  const collect = t("activity_collect", {
    async execute() {
      return { output: "3 trace lines", details: { captured: 3 } };
    },
  });
  const tools = enforceObserveFirst(
    [
      t("read"), t("grep"), t("bash"), t("mobile"), t("drive"),
      t("activity_trace_start"), t("add_log"), collect,
      createDeliverTool(cat("activity_reproduce"), box),
    ],
    { probesBeforeLaunch: true },
  );
  const T = (n) => tools.find((x) => x.name === n);

  await call(T("activity_trace_start"), { hint: "polling" });
  await call(T("add_log"), { path: "/a.dart" });
  assert.equal((await call(T("bash"), { command: "fvm flutter run -d sim" })).isError ?? false, false);
  await call(T("activity_collect"), { traceId: "t1" });
  const delivered = await call(T("deliver"), {
    reproduced: true,
    symptom: "status never repaints; the log shows notifyListeners skipped",
  });
  assert.equal(delivered.isError ?? false, false);
  assert.equal(box.deliverable.reproduced, true);
});

test("a build is neither a launch nor an observation", async () => {
  const box = { delivered: false };
  const tools = reproTools([createDeliverTool(cat("activity_reproduce"), box)]);
  const T = (n) => tools.find((x) => x.name === n);
  // `flutter build` proves it compiles. The FIRST one is refused once with the
  // launch-through-trace road named; the re-issue goes through — and even then
  // it does not satisfy the deliver guard, because an artifact is not an
  // observation.
  const first = await call(T("bash"), { command: "fvm flutter build ios --debug" });
  assert.equal(first.isError, true, "the first build-only call is interrupted once");
  assert.match(first.output, /BUILDS but runs nothing/);
  assert.equal((await call(T("bash"), { command: "fvm flutter build ios --debug" })).isError ?? false, false);
  assert.equal((await call(T("deliver"), { reproduced: true, symptom: "x" })).isError, true);
});

test("the verify hop is never asked about probes", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst(
    [t("bash"), t("add_log"), t("activity_trace_start"), createDeliverTool(cat("activity_inspect"), box)],
    { probesBeforeLaunch: false },
  );
  // Verification measures a change; it runs the suite without instrumenting.
  const res = await call(tools.find((x) => x.name === "bash"), { command: "flutter test" });
  assert.equal(res.isError ?? false, false);
});

test("a hop that cannot instrument is not asked to", async () => {
  const box = { delivered: false };
  const tools = enforceObserveFirst([t("bash"), createDeliverTool(cat("activity_reproduce"), box)], {
    probesBeforeLaunch: true,
  });
  const res = await call(tools.find((x) => x.name === "bash"), { command: "curl -s localhost:3000" });
  assert.equal(res.isError ?? false, false);
});

test("the prompt makes the visible/invisible call before the launch", () => {
  const p = buildCategorizerSystemPrompt({
    id: "activity_reproduce",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_reproduce,
    children: ["write_edit"],
  });
  // The procedure is numbered and ordered, and the order is the fix: classify,
  // prove you can run it, THEN instrument — the two failures this came from were
  // instrumenting something that could not run, and running something with no
  // probes in it.
  const steps = [...p.matchAll(/^STEP (\d) — ([A-Z][^.,]*)/gm)].map((m) => `${m[1]}:${m[2]}`);
  // Eight now: the enforced handshake (who makes the defect happen) comes before
  // the classification, because it decides whether this pass drives at all.
  assert.equal(steps.length, 8, `expected eight steps, got ${steps.join(" | ")}`);
  assert.match(steps[0], /0:WHO MAKES IT HAPPEN/);
  assert.match(steps[1], /1:CLASSIFY THE SYMPTOM/);
  assert.match(steps[2], /2:ESTABLISH THAT YOU CAN RUN IT/);
  assert.match(steps[3], /3:WALLS/);
  assert.match(steps[4], /4:INSTRUMENT THEN LAUNCH THROUGH THE TRACE/);
  assert.match(steps[5], /5:DRIVE IT TO THE SYMPTOM/);
  assert.match(steps[6], /6:READ THE EVIDENCE/);
  assert.match(steps[7], /7:LOCALISE/);
  assert.match(p, /VISIBLE\s+— wrong text/);
  assert.match(p, /INVISIBLE\s+— a value that never arrives/);
  assert.match(p, /not hard, it is impossible/);
  assert.match(p, /a\s+probe has to be in the code that\s+gets built/);
  // Step 2 exists because instrumenting first and discovering you cannot run it
  // wasted a whole pass.
  assert.match(p, /Do not instrument code you cannot\s+execute/);
  // Project-independent: it says where to LOOK for the run command, and never
  // names a framework's.
  assert.match(p, /never from memory, and never a command you invented/);
  assert.match(p, /README, CLAUDE\.md \/ AGENTS\.md, a Makefile/);
  assert.match(p, /BUILDS ONLY \(build \/ assemble \/ compile \/ archive \/ typecheck\) is not a way/);
  for (const framework of ["flutter ", "npm run", "pnpm ", "pytest", "cargo ", "gradlew"]) {
    assert.ok(
      !p.slice(p.indexOf("STEP 2"), p.indexOf("STEP 5")).includes(framework),
      `the procedure must not name ${framework} — it is project-independent`,
    );
  }
  // Every instrumentation tool is named, with what it is for and its key args —
  // a run that never logged anything reasoned its way there without ever
  // mentioning a probe tool.
  assert.match(p, /THE INSTRUMENTATION TOOLS — what each one is for/);
  for (const [name, shape] of [
    ["activity_trace_start", /Opens the session/],
    ["add_log", /\{path, oldString, newString\}/],
    ["remove_log", /Takes a probe back out[\s\S]{0,40}\{all: true\}/],
    ["activity_collect", /Reads back what the probes PRINTED/],
    ["activity_study", /find the root cause/],
    ["activity_search", /HARNESS's own activity log/],
    ["activity_tags", /lists the tags that exist/],
    ["activity_tail_file", /a log the harness never wrote/],
    ["activity_cleanup", /strips the probes `add_log` placed, and names any it could not/],
  ]) {
    assert.match(p, new RegExp(`\`${name}\``), `${name} must be named`);
    assert.match(p, shape, `${name}'s purpose must be stated`);
  }
  assert.match(p, /start → add → run → collect → study → cleanup/, "and the order they go in");
  // Each is also named at the step that uses it.
  assert.match(p, /`remove_log \{logId\}` takes it back out/);
  assert.match(p, /`activity_collect \{traceId\}`/);
  assert.match(p, /`activity_cleanup \{traceId\}`/);

  // The invariants are stated once, as rules, not buried inside a step.
  assert.match(p, /RULES THAT HOLD AT EVERY STEP/);
  for (const rule of [
    /A LOG-ONLY EDIT IS ONE INSERTED LINE/,
    /NEVER STRIP PROBES YOU HAVE NOT RUN/,
    /THE SHELL RUNS THINGS HERE; IT DOES NOT WRITE THEM/,
    /IF YOU CANNOT REPRODUCE IT, SAY SO/,
  ]) {
    assert.match(p, rule);
  }
});
