/**
 * The reproduce-first cycle, end to end, through the real loop.
 *
 * Every other test in this area exercises a gate as a state machine. This one
 * runs the whole route the harness recommends — refuse the blind fix, open a
 * trace, place probes, RUN the code, collect what it wrote, then fix — with the
 * real `edit` tool writing real bytes and a real child process producing the
 * trace. That end-to-end path is where the two defects lived that no unit test
 * caught:
 *
 *   1. the probe helper silently wrote nothing in an ES module, so the trace
 *      collected zero lines, and
 *   2. an empty collect still lifted the gate, because a capture that found
 *      NOTHING returns a paragraph saying so and the gate only checked length.
 *
 * Both were invisible to a gate-level test and obvious the moment the code ran.
 *
 * Nothing here is specific to a project, a language dialect or a phrasing: the
 * fixture is generated, the probe anchor is derived from the file the run read,
 * and the traceId comes from the tool's own `details` rather than from parsing
 * its prose. The module system is a PARAMETER, because that is the axis defect 1
 * hid on — a suite that only ever wrote `.cjs` would still pass today.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  createCodingTools,
  runToolLoop,
} from "../dist/index.js";
import { createActivityMonitorTools } from "../dist/tools/builtin/activity-monitor.js";
import { traceMarker } from "../dist/probe-marker.js";
import { ReproductionGate } from "../dist/orchestrator/reproduction-gate.js";
import { VerificationGate } from "../dist/orchestrator/verification-gate.js";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const msg = (content, stopReason = "stop") => ({
  role: "assistant", content, model: "scripted/driver",
  api: "openrouter", provider: "scripted", usage, stopReason, timestamp: Date.now(),
});

/**
 * A project with a bug in it, reachable by running the entry point.
 *
 * The flow is ASYNC on purpose, and that is not decoration. The first version of
 * this fixture was a plain synchronous comparison in one file — and the run sailed
 * straight past the gate, correctly: the straightforwardness assessor lifts for a
 * single synchronous low-complexity file, so a trivial fix never pays for
 * reproduction. To exercise the ARMED gate the fixture has to be the kind of bug
 * the gate exists for, which is the kind the assessor refuses to wave through: a
 * runtime gap you cannot close by reading. Awaiting a resolution is the smallest
 * honest version of that.
 *
 * `ext` decides the module system, the axis the probe-write defect hid on.
 */
async function fixture(ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cycle-${ext}-`));
  const entry = path.join(dir, `app.${ext}`);
  const source = [
    "async function loadRerun(requestId) {",
    "  await new Promise((r) => setTimeout(r, 1));",
    "  return { id: requestId + '_rerun' };",
    "}",
    "",
    "async function resolveRow(requestId) {",
    "  const rerun = await loadRerun(requestId);",
    "  const resolved = requestId === rerun.id;",
    "  return resolved;",
    "}",
    "",
  ].join("\n");
  const invoke =
    ext === "cjs"
      ? "resolveRow('call_1').then((r) => console.log(r));\n"
      : "resolveRow('call_1').then((r) => console.log(r));\nexport {};\n";
  await fs.writeFile(entry, source + invoke);
  return { dir, entry, entryName: path.basename(entry) };
}

/** Text of a tool_execution_end event, whatever shape the result took. */
function resultText(result) {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result) ? result : (result?.content ?? []);
  return blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

/** Details of a tool_execution_end event, when the tool published any. */
function resultDetails(result) {
  return Array.isArray(result) || typeof result === "string" ? undefined : result?.details;
}

/**
 * Drive the full cycle for one module system. The driver is scripted, but every
 * value it needs is DISCOVERED from what the tools returned — the anchor from the
 * file it read, the traceId and the snippet from the trace tool's result — so the
 * test cannot pass by hardcoding what this particular run happens to produce.
 */
async function runCycle(ext) {
  const { dir, entry, entryName } = await fixture(ext);
  const logStore = new LogStore();
  const reproductionGate = new ReproductionGate({ enabled: true });
  const verificationGate = new VerificationGate({});

  const steps = [];
  let sourceText = "";
  let traceId;
  let snippet;
  let traceStartDetails;

  const llm = new OpenRouterBridge();
  // Any authoring/study escalation would be a network call. There is none here.
  llm.complete = async () => { throw new Error("no network in this test"); };

  // The route, as tool calls. Values marked `derive` are filled in from what the
  // preceding tools actually returned.
  const plan = [
    { what: "read the source", call: () => ({ name: "read", arguments: { path: entryName } }) },
    {
      what: "fix it blind",
      call: () => ({ name: "edit", arguments: { path: entryName, ...fixEdit() } }),
    },
    { what: "open a trace", call: () => ({ name: "activity_trace_start", arguments: { language: "javascript" } }) },
    // Logging goes through `add_log`, not `edit`. This is the step a real run
    // skipped — told that probe EDITS were allowed, it went back to reading source
    // instead — so it is now its own tool, with `edit`'s anchor shape and none of
    // `edit`'s machinery.
    {
      what: "add logs",
      call: () => ({
        name: "add_log",
        arguments: {
          traceId,
          path: entryName,
          oldString: "  const resolved = requestId === rerun.id;",
        newString:
          "  const resolved = requestId === rerun.id;\n" +
          `  console.log("${traceMarker(traceId)} row resolution", { requestId, rerunId: rerun.id, resolved });`,
        },
      }),
    },
    { what: "run the flow", call: () => ({ name: "bash", arguments: { command: `node ${entryName} >> ${traceStartDetails?.traceFile ?? "/dev/null"}` } }) },
    { what: "collect the trace", call: () => ({ name: "activity_collect", arguments: { traceId, waitMs: 1000 } }) },
    { what: "fix it, having observed it", call: () => ({ name: "edit", arguments: { path: entryName, ...fixEdit() } }) },
  ];

  /** The real change, anchored on a line the run actually read. */
  function fixEdit() {
    const anchor = sourceText.split("\n").map((l) => l.replace(/^\s*\d+\t/, ""))
      .find((l) => l.includes("requestId === rerun.id"));
    assert.ok(anchor, "the read surfaced the buggy line");
    return { oldString: anchor, newString: anchor.replace("requestId === rerun.id", "rerun.id.startsWith(requestId)") };
  }

  let i = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    const step = plan[i++];
    if (!step) {
      yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
      return;
    }
    const call = step.call();
    steps.push({ what: step.what, tool: call.name });
    yield { type: "done", message: msg([{ type: "toolCall", id: `c${i}`, ...call }], "tool_use") };
  };

  const results = [];
  const loop = await runToolLoop({
    task: "revisiting a thread shows an approved tool as still requested",
    userMessage: "fix it",
    tools: [...createCodingTools(), ...createActivityMonitorTools({ logStore })],
    model: { id: "scripted/driver" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore,
    emit: (e) => {
      if (e.type !== "tool_execution_end") return;
      const text = resultText(e.result);
      const details = resultDetails(e.result);
      results.push({ tool: e.toolName, isError: Boolean(e.isError), text, details });
      if (e.toolName === "read" && !e.isError) sourceText = text;
      if (e.toolName === "activity_trace_start" && !e.isError) {
        // From `details`, not from the prose: the tool's structured output is the
        // contract, its wording is not.
        traceId = details?.traceId;
        snippet = text.match(/```[a-z]*\n([\s\S]*?)```/)?.[1]?.trimEnd();
        traceStartDetails = details;
      }
    },
    cwd: dir,
    isBugFix: true,
    reproductionGate,
    verificationGate,
  });

  return {
    dir, entry, entryName, steps, results, loop,
    traceId, snippet, traceStartDetails,
    report: reproductionGate.toReport(),
    verify: verificationGate.toReport(),
    onDisk: await fs.readFile(entry, "utf8"),
  };
}

// `mjs` is the case that was broken; `cjs` is the case that masked it. Both must
// pass, and the test is written so neither is the privileged one.
for (const ext of ["mjs", "cjs"]) {
  test(`the full reproduce-first cycle works in a .${ext} project`, async () => {
    const r = await runCycle(ext);
    const [read, blindFix, traceStart, probe, run, collect, realFix] = r.results;

    assert.equal(r.loop.error, undefined, "the loop completed");
    assert.equal(read?.isError, false, "the read succeeded");

    // 1. The blind fix is refused, and the refusal teaches the route.
    assert.equal(blindFix?.isError, true, "an unobserved fix is refused");
    assert.match(blindFix.text, /activity_trace_start/, "the refusal names the trace route");

    // 2. The trace opens and hands back a usable id + snippet.
    assert.equal(traceStart?.isError, false);
    assert.ok(r.traceId, "the trace tool published a traceId in details");
    assert.ok(r.snippet?.includes("TURING_TRACE"), "the trace tool handed back the prefix convention");

    // 3. The logs go in through `add_log`, with the gate still armed.
    assert.equal(probe?.isError, false, "instrumenting is not blocked");
    assert.match(r.onDisk, /console\.log\("TURING_TRACE[_A-Za-z0-9-]* row resolution"/, "the probe reached disk");

    // 4. The instrumented code runs and the probe WRITES — the ESM defect.
    assert.equal(run?.isError, false, "the flow ran");
    assert.equal(collect?.isError, false);
    assert.ok(
      (collect.details?.traceLines ?? 0) > 0,
      `the trace captured probe output in .${ext} (got ${collect.details?.traceLines} lines) — ` +
        "zero here means the helper could not write, which is the ESM regression",
    );
    assert.match(collect.text, /row resolution/, "the captured line is the probe's");

    // 5. Only now is the fix allowed, and the report says the bug was observed.
    assert.equal(realFix?.isError, false, "after reproducing, the fix goes through");
    assert.match(r.onDisk, /rerun\.id\.startsWith\(requestId\)/, "the fix reached disk");
    assert.equal(r.report.reproduced, true);
    assert.equal(r.report.blocks, 1, "exactly one refusal — the route was not fought");
    assert.equal(r.report.traceOpened, true);

    // 6. The two gates do not double-count: the file owes evidence for the FIX,
    //    and instrumenting it did not add a second debt.
    const owed = [...r.verify.unverified, ...r.verify.checked, ...r.verify.certified];
    assert.equal(owed.length, 1, "one verification debt, for the fix — instrumenting owes nothing");
  });
}

test("a trace that captured nothing does NOT lift the gate, in a real run", async () => {
  // The same cycle with the probe never placed: the flow runs, the trace stays
  // dry, `activity_collect` succeeds with a long "found nothing" explanation, and
  // the fix must STILL be refused. This is defect 2 at the integration level —
  // where the gate sees a successful call with hundreds of characters of output.
  const { dir, entryName } = await fixture("mjs");
  const logStore = new LogStore();
  const reproductionGate = new ReproductionGate({ enabled: true });

  let traceId;
  const results = [];
  const llm = new OpenRouterBridge();
  llm.complete = async () => { throw new Error("no network in this test"); };
  const plan = [
    () => ({ name: "activity_trace_start", arguments: { language: "javascript" } }),
    // No probe edit at all — nothing will ever be written to the trace.
    () => ({ name: "bash", arguments: { command: `node ${entryName}` } }),
    () => ({ name: "activity_collect", arguments: { traceId, waitMs: 200 } }),
    () => ({ name: "edit", arguments: { path: entryName, oldString: "  return resolved;", newString: "  return Boolean(resolved);" } }),
  ];
  let i = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    const next = plan[i++];
    if (!next) { yield { type: "done", message: msg([{ type: "text", text: "done" }]) }; return; }
    yield { type: "done", message: msg([{ type: "toolCall", id: `c${i}`, ...next() }], "tool_use") };
  };

  await runToolLoop({
    task: "a bug", userMessage: "fix it",
    tools: [...createCodingTools(), ...createActivityMonitorTools({ logStore })],
    model: { id: "scripted/driver" }, llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore,
    emit: (e) => {
      if (e.type !== "tool_execution_end") return;
      const details = resultDetails(e.result);
      results.push({ tool: e.toolName, isError: Boolean(e.isError), text: resultText(e.result), details });
      if (e.toolName === "activity_trace_start" && !e.isError) traceId = details?.traceId;
    },
    cwd: dir, isBugFix: true, reproductionGate,
  });

  const collect = results.find((r) => r.tool === "activity_collect");
  const fix = results.find((r) => r.tool === "edit");
  // Tear the session down: an un-probed session left open is exactly the state that
  // must not leak into the next run (see STALE_TRACE_MS), and a test that leaks it
  // is a test that hides that.
  const cleanupTool = createActivityMonitorTools({ logStore }).find((t) => t.name === "activity_cleanup");
  await cleanupTool.execute("c", { traceId }, { cwd: dir, log: () => {} });
  assert.equal(collect?.isError, false, "collecting a dry trace is not an ERROR — that is the trap");
  assert.equal(collect.details?.traceLines, 0, "and it captured nothing");
  assert.ok(collect.text.length > 150, "while still returning plenty of prose");
  assert.equal(fix?.isError, true, "so the fix is still refused");
  assert.equal(reproductionGate.toReport().reproduced, false);
});

// ---------------------------------------------------------------------------
// The same loop, pointed at code that was just written.
//
// Verification is not a different skill from debugging: put logs into the flow,
// run it, read what came out. A passing test suite says nothing broke; it does not
// say the change works. So `activity_collect` has to satisfy the VERIFY gate for a
// logic file exactly as it satisfies the REPRODUCE gate for a bug — and the verify
// round's own instructions have to name that route, or the model reaches for a
// re-read and calls it a check.
// ---------------------------------------------------------------------------

test("instrumenting and collecting satisfies the verify gate for a logic change", async () => {
  const { dir, entry, entryName } = await fixture("mjs");
  const logStore = new LogStore();
  const verificationGate = new VerificationGate({});

  // Development already happened: a logic file was written and owes evidence.
  verificationGate.observeWritten(entry, "@@ -8,1 +8,1 @@\n-  const resolved = requestId === rerun.id;\n+  const resolved = rerun.id.startsWith(requestId);");
  assert.equal(verificationGate.isSatisfied(), false, "a written logic file owes a check");

  let traceId, traceFile;
  const results = [];
  const llm = new OpenRouterBridge();
  llm.complete = async () => { throw new Error("no network in this test"); };
  const plan = [
    () => ({ name: "activity_trace_start", arguments: { language: "javascript" } }),
    () => ({
      name: "add_log",
      arguments: {
        traceId, path: entryName,
        oldString: "  const resolved = requestId === rerun.id;",
        newString:
          "  const resolved = requestId === rerun.id;\n" +
          `  console.log("${traceMarker(traceId)} verify: resolution", { resolved });`,
      },
    }),
    () => ({ name: "bash", arguments: { command: `node ${entryName} >> ${traceFile ?? "/dev/null"}` } }),
    () => ({ name: "activity_collect", arguments: { traceId, waitMs: 1000 } }),
  ];
  let i = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    const next = plan[i++];
    if (!next) { yield { type: "done", message: msg([{ type: "text", text: "verified" }]) }; return; }
    yield { type: "done", message: msg([{ type: "toolCall", id: `v${i}`, ...next() }], "tool_use") };
  };

  const loop = await runToolLoop({
    task: "verify the resolution fix",
    userMessage: "verify what you wrote",
    tools: [...createCodingTools(), ...createActivityMonitorTools({ logStore })],
    model: { id: "scripted/driver" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore,
    emit: (e) => {
      if (e.type !== "tool_execution_end") return;
      const details = resultDetails(e.result);
      results.push({ tool: e.toolName, isError: Boolean(e.isError), text: resultText(e.result), details });
      if (e.toolName === "activity_trace_start" && !e.isError) { traceId = details?.traceId; traceFile = details?.traceFile; }
    },
    cwd: dir,
    verificationGate,
  });

  assert.equal(loop.error, undefined);
  const collect = results.find((r) => r.tool === "activity_collect");
  assert.equal(collect?.isError, false);
  assert.ok((collect.details?.captured ?? 0) > 0, "the probes recorded real values");
  assert.match(collect.text, /verify: resolution/);

  // The gate is satisfied by the CAPTURE, not by anything having been re-read.
  assert.equal(verificationGate.isSatisfied(), true, "a collected trace is a check");
  const report = verificationGate.toReport();
  assert.deepEqual(report.checked.map((c) => c.path), [entry]);
  assert.match(report.checked[0].tool, /activity_collect/);

  // Probing during verification must not create NEW verification debt — that would
  // be a gate that can never be satisfied, each check owing another check.
  assert.equal(report.unverified.length, 0, "instrumenting owes nothing itself");

  // ...and the probes it inserted are still tracked, so the pre-summary strip check
  // catches them even though a TOOL wrote them rather than an `edit`.
  assert.ok(loop.instrumentedPaths.includes(entry), "tool-placed probes are tracked for stripping");
});

test("the verify round's instructions send a logic change through the probe loop", async () => {
  const { buildVerificationMessageForTest: build } = await import("../dist/orchestrator/orchestrator.js");
  const msgText = build(
    [{ path: "/p/hydration.ts", method: "logic" }],
    { mode: "agent", surfaces: { browser: false, mobile: false } },
    0,
    3,
  );
  // The route has to be named in order, or the model substitutes a re-read.
  assert.match(msgText, /activity_trace_start/);
  assert.match(msgText, /add_log/);
  assert.match(msgText, /activity_collect/);
  assert.match(msgText, /EXERCISE the changed path/);
  // And it has to say why green tests are not the same as a working change.
  assert.match(msgText, /passing test suite says nothing broke/);
  assert.match(msgText, /Reading the source is NOT a check/);
});

test("a visual gap on a device surface says how the app GETS onto the device", async () => {
  // The gap this closes, from a real run: the model listed the devices, found a
  // booted iPhone simulator, reasoned "install the app, launch it, screenshot
  // it" — then ran `flutter build apk --debug`, which installs nothing. It timed
  // out, the model concluded the environment could not run the app, and the UI
  // change shipped unverified. The round said "capture a screen" and never said
  // how the screen gets there, which for a native app is the entire problem.
  const { buildVerificationMessageForTest: build } = await import("../dist/orchestrator/orchestrator.js");
  const msgText = build(
    [{ path: "/p/lib/screens/profile_screen.dart", method: "visual" }],
    { mode: "agent", surfaces: { browser: false, mobile: true } },
    0,
    3,
    // What the detector read out of THIS project — flavor and entrypoint
    // included, which no hardcoded default would have carried.
    [
      {
        command: "flutter run --flavor staging -t lib/main_staging.dart",
        source: "CLAUDE.md",
        kind: "device",
      },
    ],
  );
  assert.match(msgText, /BUILDS, INSTALLS AND LAUNCHES/, "states what the command must do");
  assert.match(msgText, /--flavor staging -t lib\/main_staging\.dart/, "quotes the project's own command");
  assert.match(msgText, /CLAUDE\.md/, "and where it came from");
  assert.match(msgText, /background: true/, "a cold build must not be run in the foreground");
  assert.match(msgText, /installs nothing/, "an artifact-only task is not a way onto a device");
  assert.match(msgText, /activity_inspect/);
});

test("with nothing declared, the round sends the model to read the project", async () => {
  const { buildVerificationMessageForTest: build } = await import("../dist/orchestrator/orchestrator.js");
  const msgText = build(
    [{ path: "/p/lib/screens/profile_screen.dart", method: "visual" }],
    { mode: "agent", surfaces: { browser: false, mobile: true } },
    0,
    3,
    [],
  );
  assert.match(msgText, /FIND IT rather than guessing/);
  // No command is invented. A confident wrong command is the failure being
  // avoided — an app with flavors rejects the generic one.
  assert.ok(!/flutter run|react-native run-|expo run:/.test(msgText), msgText);
});

test("the device precondition stays out of the way when it does not apply", async () => {
  const { buildVerificationMessageForTest: build } = await import("../dist/orchestrator/orchestrator.js");
  const noDevice = build(
    [{ path: "/p/Button.tsx", method: "visual" }],
    { mode: "agent", surfaces: { browser: true, mobile: false } },
    0,
    3,
  );
  assert.ok(!/flutter run -d/.test(noDevice), "a web-only run is not told about simulators");

  const logicOnly = build(
    [{ path: "/p/hydration.ts", method: "logic" }],
    { mode: "agent", surfaces: { browser: false, mobile: true } },
    0,
    3,
  );
  assert.ok(!/flutter run -d/.test(logicOnly), "a logic gap does not need the app on a screen");
});
