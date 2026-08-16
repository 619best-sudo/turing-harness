/**
 * Reproduce before you edit — as a gate, not a sentence.
 *
 * The prompt has told the model this for a long time and it is routinely ignored.
 * The run that forced this: a Flutter bug fix with a device server, `playwright`,
 * `chrome-devtools` all connected (`connectedMcp: 3, mcpFails: 0`) and the whole
 * `activity_*` toolkit registered — and it went read → grep → edit without once
 * driving the app or instrumenting the flow. Nothing was missing. The rule simply
 * was not binding, because a rule the model can silently skip is a suggestion.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ReproductionGate,
  instrumentationTarget,
  isMutationTool,
  isReproductionTool,
  isTraceOpenTool,
  parseReproduceDeclaration,
  shellAuthoringTarget,
} from "../dist/orchestrator/reproduction-gate.js";

const bugFix = () => new ReproductionGate({ enabled: true });

test("a bug-fix run cannot edit before it has observed anything", () => {
  const gate = bugFix();
  const verdict = gate.check("edit");

  assert.equal(verdict.kind, "block");
  // The refusal has to teach, or the model just retries the same call.
  assert.match(verdict.message, /activity_inspect/);
  assert.match(verdict.message, /activity_trace_start/);
  assert.match(verdict.message, /ask_user_question/);
});

test("a capture of the running system lifts the gate", () => {
  const gate = bugFix();
  gate.observe("activity_inspect", false, 4096);

  assert.equal(gate.check("edit").kind, "allow");
  assert.equal(gate.check("write").kind, "allow");
});

test("collected trace output lifts it too — the no-MCP route", () => {
  // This is the one that matters for a run with no device or browser attached:
  // `activity_trace_start` → place `__t()` → `activity_collect` needs nothing
  // connected, so "I had no tools" is never a reason to skip reproduction.
  const gate = bugFix();
  gate.observe("activity_collect", false, 800);
  assert.equal(gate.check("edit").kind, "allow");
});

test("a failed or empty capture is not evidence", () => {
  // A trace that collected nothing means the instrumentation never ran. Treating
  // that as reproduction would let the gate pass on the strength of a tool call
  // that proved nothing.
  const failed = bugFix();
  failed.observe("activity_inspect", true, 4096);
  assert.equal(failed.check("edit").kind, "block");

  const empty = bugFix();
  empty.observe("activity_collect", false, 0);
  assert.equal(empty.check("edit").kind, "block");
});

test("asking the user for steps is a legitimate way out", () => {
  // The guidance already says: if you cannot trigger it, ask rather than guess.
  // The gate has to honour its own escape hatch or it punishes the right move.
  const gate = bugFix();
  gate.observe("ask_user_question", false, 120);
  assert.equal(gate.check("edit").kind, "allow");
});

test("it gives up rather than deadlocking a model that cannot comply", () => {
  // A gate with no ceiling is worse than no gate: the run burns its budget on
  // refusals and ends with nothing, which beats an unverified fix for nobody.
  const gate = bugFix();
  assert.equal(gate.check("edit").kind, "block");
  assert.equal(gate.check("edit").kind, "block");
  assert.equal(gate.check("edit").kind, "allow", "third attempt proceeds");
});

test("it is inert unless the run is a bug fix", () => {
  // A greenfield feature has nothing to reproduce; blocking its first write
  // would be nonsense.
  const gate = new ReproductionGate({ enabled: false });
  assert.equal(gate.check("edit").kind, "allow");
  assert.equal(gate.check("write").kind, "allow");
});

test("it guards only mutations, never reads", () => {
  const gate = bugFix();
  for (const t of ["read", "grep", "bash", "ls", "activity_inspect"]) {
    assert.equal(gate.check(t).kind, "allow", `${t} must never be gated`);
  }
});

test("MCP name prefixes do not smuggle a tool past the classifier", () => {
  // Tools arrive namespaced by their server, so matching on the bare name only
  // would silently stop recognising captures the moment they came from an MCP.
  assert.equal(isReproductionTool("activity_inspect"), true);
  assert.equal(isReproductionTool("vendor__activity_inspect"), true);
  assert.equal(isReproductionTool("read"), false);
  assert.equal(isMutationTool("edit"), true);
  assert.equal(isMutationTool("write"), true);
  assert.equal(isMutationTool("read"), false);
});

// ---- straightforward-fix declaration (smart skip) ----

test("a declared straightforward fix lifts the gate without any evidence", () => {
  const gate = bugFix();
  gate.declareStraightforward("one-line typo in a copy string, no runtime behaviour");
  assert.equal(gate.check("edit").kind, "allow");
  assert.equal(gate.check("write").kind, "allow");
});

test("the block message teaches the DECLARE_REPRODUCE escape", () => {
  const gate = bugFix();
  const verdict = gate.check("edit");
  assert.equal(verdict.kind, "block");
  assert.match(verdict.message, /DECLARE_REPRODUCE/);
});

test("toReport records a declared skip (auditable, not silent)", () => {
  const gate = bugFix();
  gate.declareStraightforward("constant change, no flow involved");
  const report = gate.toReport();
  assert.equal(report.reproduced, false);
  assert.equal(report.declaredStraightforward.reason, "constant change, no flow involved");
});

test("toReport records a maxBlocks give-up distinctly from a declared skip", () => {
  const gate = new ReproductionGate({ enabled: true, maxBlocks: 1 });
  gate.check("edit"); // first block (blocks becomes 1, hits ceiling)
  gate.check("edit"); // now allowed past
  const report = gate.toReport();
  assert.equal(report.declaredStraightforward, undefined);
  assert.equal(report.gaveUpAfterBlocks, 1);
});

test("a capture still wins, and the report says reproduced", () => {
  const gate = bugFix();
  gate.observe("activity_inspect", false, 2048);
  const report = gate.toReport();
  assert.equal(report.reproduced, true);
  assert.equal(report.declaredStraightforward, undefined);
});

test("parseReproduceDeclaration extracts the reason", () => {
  const text = 'some preamble\nDECLARE_REPRODUCE { "reason": "config tweak" }\nrest';
  assert.deepEqual(parseReproduceDeclaration(text), { reason: "config tweak" });
});

test("parseReproduceDeclaration returns undefined on malformed/missing", () => {
  assert.equal(parseReproduceDeclaration("no declaration here"), undefined);
  assert.equal(parseReproduceDeclaration('DECLARE_REPRODUCE { not json }'), undefined);
  assert.equal(parseReproduceDeclaration('DECLARE_REPRODUCE { "reason": "" }'), undefined);
});

test("parseReproduceDeclaration does not match the verify gate's DECLARE keyword", () => {
  // The two loops run at different times; their keywords must not collide.
  assert.equal(parseReproduceDeclaration('DECLARE { "path": "/x", "method": "none" }'), undefined);
});

// ---------------------------------------------------------------------------
// The bash escape hatch. The gate blocks `write`/`edit`, but a model committed
// to a fix can author through `bash` (sed/heredoc/python write) — bypassing both
// the gate and the authoring model. The gate now treats a bash command that
// authors source as a mutation too, so the escape path is blocked regardless of
// `authorOnlyWrites`. These pin that, including the exact `pathlib` form a real
// run used to escape.
// ---------------------------------------------------------------------------

test("shellAuthoringTarget recognises the bash source-write forms", () => {
  assert.ok(shellAuthoringTarget("bash", { command: "sed -i 's/a/b/' src/app.ts" }));
  assert.ok(shellAuthoringTarget("bash", { command: "echo x > src/app.ts" }));
  // The exact form the run used to escape: a python heredoc with pathlib write_text.
  assert.deepEqual(
    shellAuthoringTarget("bash", { command: "python3 << 'EOF'\nfrom pathlib import Path\nPath('lib/a.dart').write_text('x')\nEOF" }),
    { path: "lib/a.dart", form: "python pathlib write" },
  );
});

test("shellAuthoringTarget is null for a non-authoring bash command and for non-bash tools", () => {
  assert.equal(shellAuthoringTarget("bash", { command: "npm run build" }), null);
  assert.equal(shellAuthoringTarget("bash", { command: "grep -r foo src/" }), null);
  assert.equal(shellAuthoringTarget("read", { path: "/x" }), null);
  assert.equal(shellAuthoringTarget("bash", {}), null);
});

test("a bug-fix run blocks a bash source-write before it has observed anything", () => {
  const gate = bugFix();
  // The exact escape path from the reported run: pathlib write_text of a .dart file.
  const verdict = gate.check("bash", { command: "python3 << 'EOF'\nfrom pathlib import Path\nPath('lib/a.dart').write_text('fixed')\nEOF" });
  assert.equal(verdict.kind, "block");
  assert.match(verdict.message, /authoring file contents through the shell/);
  assert.match(verdict.message, /lib\/a\.dart/);
  assert.match(verdict.message, /reproduce the bug first/i);
});

test("a non-authoring bash command is never blocked by the gate", () => {
  const gate = bugFix();
  // build/grep/mkdir must pass even before reproduction — the gate guards source
  // writes, not legitimate shell use.
  assert.equal(gate.check("bash", { command: "npm run build" }).kind, "allow");
  assert.equal(gate.check("bash", { command: "mkdir -p dist" }).kind, "allow");
});

test("observing the bug lifts the gate for a bash source-write too", () => {
  const gate = bugFix();
  gate.observe("activity_inspect", false, 500);
  const verdict = gate.check("bash", { command: "echo x > src/app.ts" });
  assert.equal(verdict.kind, "allow", "after reproduction, a shell write is no longer blocked by THIS gate");
});

// ---------------------------------------------------------------------------
// The instrumentation window. The gate's own no-MCP remedy is
// `activity_trace_start` → place `__t()` with `edit` → run → `activity_collect`,
// and that middle step is an `edit` the gate was refusing — so the recommended
// route was unreachable and the model fell back to the blind fix once maxBlocks
// gave up. A probe edit is now allowed while a trace is open, and ONLY a probe
// edit: the exemption requires a probe delta and that no real code moved.
// ---------------------------------------------------------------------------

const OPEN = (gate) => {
  gate.observe("activity_trace_start", false, 900);
  return gate;
};

test("isTraceOpenTool matches the trace opener, under an MCP prefix too", () => {
  assert.equal(isTraceOpenTool("activity_trace_start"), true);
  assert.equal(isTraceOpenTool("vendor__activity_trace_start"), true);
  assert.equal(isTraceOpenTool("activity_collect"), false);
});

test("opening a trace is NOT evidence on its own", () => {
  // A trace that never ran proves nothing — only `activity_collect` with output
  // does. Otherwise one free call would buy a blind fix.
  const gate = OPEN(bugFix());
  assert.equal(gate.toReport().reproduced, false);
  assert.equal(gate.check("edit", { path: "lib/a.dart", oldString: "final x = 1;", newString: "final x = 2;" }).kind, "block");
});

test("with a trace open, an edit that only places __t() probes is allowed", () => {
  // The step the gate used to make impossible.
  const gate = OPEN(bugFix());
  const verdict = gate.check("edit", {
    path: "lib/screens/lead_list/lead_list_screen.dart",
    oldString: "  void reload() {",
    newString: '  void reload() {\n    console.log("TURING_TRACE reload entered", {"count": leads.length});',
  });
  assert.equal(verdict.kind, "allow");
});

test("a prefix log line (and a small block of them) can be inserted too", () => {
  // Instrumentation is now a `TURING_TRACE` print line the model writes; a pure
  // insertion of one — or a small block — must pass the gate, or the first
  // instrumentation is refused and the route is dead again.
  const gate = OPEN(bugFix());
  const probe = [
    'print("TURING_TRACE reload entered");',
    'print("TURING_TRACE reload done", {"count": leads.length});',
  ].join("\n");
  const verdict = gate.check("edit", {
    path: "lib/main.dart",
    oldString: "import 'dart:async';",
    newString: `import 'dart:async';\n\n${probe}`,
  });
  assert.equal(verdict.kind, "allow");
});

test("removing probes is allowed too — cleanup must not be gated", () => {
  const gate = OPEN(bugFix());
  const verdict = gate.check("edit", {
    path: "lib/a.dart",
    oldString: '  final x = compute();\n  console.log("TURING_TRACE computed", {"x": x});',
    newString: "  final x = compute();",
  });
  assert.equal(verdict.kind, "allow");
  // The whole-anchor deletion form: `newString: ""` is a strip, not a missing
  // argument, so it must not be confused with authorOnly's absent replacement.
  assert.equal(
    gate.check("edit", { path: "lib/a.dart", oldString: '  console.log("TURING_TRACE computed");', newString: "" }).kind,
    "allow",
  );
});

test("a FIX wearing a probe is still refused — the exemption cannot smuggle code", () => {
  // The failure this whole gate exists for: the real change (a rewritten
  // condition) with a `__t()` line stapled on. The anchor's code line does not
  // survive into the replacement, so it is not instrumentation.
  const gate = OPEN(bugFix());
  const verdict = gate.check("edit", {
    path: "lib/a.dart",
    oldString: "    if (!_enrichmentStatusChanged(existing, lead)) return;",
    newString:
      '    console.log("TURING_TRACE reload compare", {"existing": existing});\n' +
      "    if (existing != null && !_enrichmentStatusChanged(existing, lead)) return;",
  });
  assert.equal(verdict.kind, "block");
  assert.match(verdict.message, /a fix, not instrumentation/);
  assert.match(verdict.message, /activity_collect/);
});

test("an instrumentation edit spends no refusal and does not lift the gate", () => {
  // Instrumenting must not burn the maxBlocks budget (or two probe edits would
  // exhaust it and the third fix would sail through unobserved), and must not
  // count as evidence.
  const gate = OPEN(bugFix());
  for (const point of ["a", "b", "c"]) {
    assert.equal(
      gate.check("edit", { path: "lib/a.dart", oldString: "  loop();", newString: `  loop();\n  console.log("TURING_TRACE ${point}");` }).kind,
      "allow",
    );
  }
  const report = gate.toReport();
  assert.equal(report.blocks, 0, "probe edits are not refusals");
  assert.equal(report.reproduced, false, "instrumenting is not observing");
  // ...and the fix itself is still refused until the trace is collected.
  assert.equal(gate.check("edit", { path: "lib/a.dart", oldString: "  loop();", newString: "  loopOnce();" }).kind, "block");
  gate.observe("activity_collect", false, 400);
  assert.equal(gate.check("edit", { path: "lib/a.dart", oldString: "  loop();", newString: "  loopOnce();" }).kind, "allow");
});

test("no trace open means no exemption — probes come after activity_trace_start", () => {
  // The `__TRACE` id comes FROM the tool, so instrumenting first is the wrong
  // order; the refusal names the opener.
  const gate = bugFix();
  const verdict = gate.check("edit", {
    path: "lib/a.dart",
    oldString: "  run();",
    newString: '  run();\n  console.log("TURING_TRACE ran");',
  });
  assert.equal(verdict.kind, "block");
  assert.match(verdict.message, /activity_trace_start/);
});

test("the exemption never covers write or a shell probe write", () => {
  // A whole-file `write` carries no anchor to compare against, and the shell is
  // not how probes go in.
  const gate = OPEN(bugFix());
  assert.equal(gate.check("write", { path: "lib/a.dart", content: 'console.log("TURING_TRACE x");\nfinal a = 1;' }).kind, "block");
  assert.equal(gate.check("bash", { command: `sed -i 's/run()/console.log("TURING_TRACE x") run()/' lib/a.dart` }).kind, "block");
});

test("instrumentationTarget classifies insert, strip, fix and unusable payloads", () => {
  assert.deepEqual(
    instrumentationTarget("edit", { path: "a.ts", oldString: "go();", newString: 'go();\nconsole.log("TURING_TRACE went");' }),
    { path: "a.ts", kind: "insert" },
  );
  assert.deepEqual(
    instrumentationTarget("edit", { path: "a.ts", oldString: 'go();\nconsole.log("TURING_TRACE went");', newString: "go();" }),
    { path: "a.ts", kind: "strip" },
  );
  // No probe delta ⇒ ordinary edit.
  assert.equal(instrumentationTarget("edit", { path: "a.ts", oldString: "go();", newString: "stop();" }), null);
  // Nothing to judge at all.
  assert.equal(instrumentationTarget("edit", { path: "a.ts", oldString: "go();" }), null);
  assert.equal(instrumentationTarget("write", { path: "a.ts", content: 'console.log("TURING_TRACE x");' }), null);
});

test("authorOnlyWrites: the gate judges the `probe` channel by the same rule", () => {
  // Under that mode the schema drops `newString` and `probe` carries the verbatim
  // probe text. The gate and the `edit` tool share one predicate, so a probe the
  // tool would write is a probe the gate lets through — and vice versa.
  const gate = OPEN(bugFix());
  assert.equal(
    gate.check("edit", { path: "lib/a.dart", oldString: "  run();", probe: '  run();\n  console.log("TURING_TRACE ran");' }).kind,
    "allow",
  );
  assert.equal(
    gate.check("edit", { path: "lib/a.dart", oldString: "  run();", probe: "  runOnce();" }).kind,
    "block",
    "a fix in the probe channel is refused by the gate too, not just by the tool",
  );
  assert.deepEqual(
    instrumentationTarget("edit", { path: "a.ts", oldString: "go();", probe: 'go();\nconsole.log("TURING_TRACE went");' }),
    { path: "a.ts", kind: "insert" },
  );
});

test("the report names the files instrumented under the exemption", () => {
  const gate = OPEN(bugFix());
  gate.check("edit", { path: "lib/a.dart", oldString: "  run();", newString: '  run();\n  console.log("TURING_TRACE a");' });
  gate.check("edit", { path: "lib/a.dart", oldString: "  step();", newString: '  step();\n  console.log("TURING_TRACE b");' });
  gate.check("edit", { path: "lib/b.dart", oldString: "  tick();", newString: '  tick();\n  console.log("TURING_TRACE c");' });
  const report = gate.toReport();
  assert.equal(report.traceOpened, true);
  assert.deepEqual(report.instrumentedForTrace, ["lib/a.dart", "lib/b.dart"], "deduped, in order");
});

test("a feature run is unaffected by the instrumentation logic", () => {
  const gate = new ReproductionGate({ enabled: false });
  assert.equal(gate.check("edit", { path: "a.ts", oldString: "x", newString: "y" }).kind, "allow");
  assert.deepEqual(gate.toReport().instrumentedForTrace, undefined);
});



// ---------------------------------------------------------------------------
// Loop integration: the two gates must not work against each other. A probe edit
// is a real successful mutation, so the loop fed it to the VERIFY gate as a path
// owing runtime evidence — a debt on a change that is about to be stripped, which
// would hold the run open to prove out logging it is going to delete.
// ---------------------------------------------------------------------------

test("an instrumentation edit owes the verify gate nothing, but is still tracked for stripping", async () => {
  const { runToolLoop, LogStore, OpenRouterBridge, PermissionGate, createCodingTools } = await import(
    "../dist/index.js"
  );
  const { VerificationGate } = await import("../dist/orchestrator/verification-gate.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "repro-verify-"));
  const target = nodePath.join(dir, "screen.tsx");
  await fs.writeFile(target, "function render() {\n  const rows = load();\n  return rows;\n}\n");

  const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const msg = (content, stopReason = "stop") => ({
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage, stopReason, timestamp: 0,
  });

  // Two calls: the probe edit, then a real fix. Only the fix should owe evidence.
  const calls = [
    { id: "c1", name: "edit", arguments: { path: target, oldString: "  const rows = load();", newString: '  const rows = load();\n  console.log("TURING_TRACE loaded", { n: rows.length });' } },
    { id: "c2", name: "edit", arguments: { path: target, oldString: "  return rows;", newString: "  return rows ?? [];" } },
  ];
  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    const call = calls[turn++];
    yield call
      ? { type: "done", message: msg([{ type: "toolCall", ...call }], "tool_use") }
      : { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const verificationGate = new VerificationGate({});
  // Evidence already in hand, so the reproduce gate is not what is under test here.
  const gate = new ReproductionGate({ enabled: true });
  gate.observe("activity_inspect", false, 512);

  const loop = await runToolLoop({
    task: "fix the empty-rows crash",
    userMessage: "go",
    tools: createCodingTools().filter((t) => t.name === "edit"),
    model: { id: "driver/model" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    isBugFix: true,
    reproductionGate: gate,
    verificationGate,
  });

  assert.equal(turn, 3, "both edits ran");
  const onDisk = await fs.readFile(target, "utf8");
  assert.match(onDisk, /console\.log\("TURING_TRACE loaded"/, "the probe landed");
  assert.match(onDisk, /rows \?\? \[\]/, "the fix landed");

  // The verify gate knows about the FIX only — one path, one debt, not two entries
  // and not a debt created by instrumenting.
  const report = verificationGate.toReport();
  const owed = [...report.unverified, ...report.checked, ...report.certified].map((e) => e.path);
  assert.deepEqual(owed, [target], "the file is owed evidence once, for the fix");

  // ...and the probe is still recorded for the strip pass, which is the other half:
  // exempting it from verification must not exempt it from cleanup.
  assert.ok(loop.instrumentedPaths.includes(target), "still tracked for stripping");
});

// ---------------------------------------------------------------------------
// "An empty capture is not evidence" — for real this time.
//
// Found by driving the gate against real OpenWaggle source: a trace that
// collected NOTHING lifted the gate. `outputChars > 0` cannot catch it, because
// `activity_collect` on a dry trace returns a whole paragraph SAYING it found
// nothing ("no trace lines yet. Either the instrumented code has not run, or the
// `__t()` helper is not writing…"). The length test passed on the explanation.
// The counts the tools already publish are the honest signal.
// ---------------------------------------------------------------------------

/** The real shape `activity_collect` returns for a dry trace. */
const DRY_COLLECT_OUTPUT =
  "**Trace:** `t-1` — no trace lines yet.\n**File:** `/tmp/t-1.log`\n\n" +
  "Either the instrumented code has not run, or its stdout is not reaching the trace file — a line is collected only if it contains the `TURING_TRACE` prefix.\n" +
  "Check that a `TURING_TRACE …` line was placed at the flow point and that the app's stdout is piped into the trace file (run it via `activity_trace_start`), then run the flow and collect again.";

test("a capture reporting captured:0 does NOT lift the gate, however much prose it returns", () => {
  const gate = bugFix();
  gate.observe("activity_collect", false, DRY_COLLECT_OUTPUT.length, {
    traceId: "t-1", traceFile: "/tmp/t-1.log", totalLines: 0, traceLines: 0, captured: 0,
  });
  assert.ok(DRY_COLLECT_OUTPUT.length > 200, "the dry output is long — length alone cannot judge it");
  assert.equal(gate.check("edit").kind, "block", "a dry trace is not reproduction");
  assert.equal(gate.toReport().reproduced, false);
});

test("a capture reporting captured > 0 DOES lift the gate", () => {
  const gate = bugFix();
  gate.observe("activity_collect", false, 400, { traceId: "t-1", totalLines: 2, traceLines: 1, captured: 1 });
  assert.equal(gate.check("edit").kind, "allow");
  assert.equal(gate.toReport().reproduced, true);
});

test("`captured` is read on its own, not inferred from the tool's other counts", () => {
  // The case that killed the name-matching version: a dry trace with ONE
  // unrelated line already in the file. "every count is zero" reads it as a real
  // capture; "any count is zero" would reject the healthy {totalLines:2,
  // traceLines:1} above. Only the tool knows which number means "observed".
  const gate = bugFix();
  gate.observe("activity_collect", false, 342, { totalLines: 1, traceLines: 0, captured: 0 });
  assert.equal(gate.check("edit").kind, "block");
});

test("the contract holds across every capture tool", () => {
  for (const tool of ["activity_collect", "activity_tail_file", "activity_study", "activity_inspect"]) {
    const dry = bugFix();
    dry.observe(tool, false, 300, { captured: 0 });
    assert.equal(dry.check("edit").kind, "block", `${tool} captured:0 is not evidence`);

    const wet = bugFix();
    wet.observe(tool, false, 300, { captured: 3 });
    assert.equal(wet.check("edit").kind, "allow", `${tool} captured:3 is evidence`);
  }
});

test("a capture tool that does not publish `captured` behaves exactly as before", () => {
  // Opt-in: a host tool or an MCP capture server knows nothing about this field,
  // and absence is not a claim of having found nothing. Note `fileLogLines: 0`
  // here — a plausible zero the old name-matching rule would have choked on.
  const gate = bugFix();
  gate.observe("vendor__activity_inspect", false, 2048, { surface: "mobile", fileLogLines: 0 });
  assert.equal(gate.check("edit").kind, "allow");
  // ...and no details at all is unchanged too.
  const bare = bugFix();
  bare.observe("activity_inspect", false, 2048);
  assert.equal(bare.check("edit").kind, "allow");
});

// ---------------------------------------------------------------------------
// The disposition a host actually renders.
//
// From the observed run: it explored, was refused a premature fix, never
// instrumented, never collected, wrote no file — and reported
// `disposition: "completed"`. The prose summary said "the bug remains unverified
// and unreproduced"; the machine-readable field, which is what a UI switches on
// and what the next run reads as history, said the opposite.
// ---------------------------------------------------------------------------

test("a bug-fix run that observed nothing and changed nothing is not `completed`", async () => {
  const { Orchestrator } = await import("../dist/index.js");
  // buildRunThreadSnapshot is internal; exercise it through the shape it is given.
  // The rule: no reproduction, no ask, no declaration, no writes => not completed.
  const { buildRunThreadSnapshotForTest } = await import("../dist/orchestrator/orchestrator.js").then(
    (m) => ({ buildRunThreadSnapshotForTest: m.buildRunThreadSnapshotForTest }),
  );
  assert.ok(buildRunThreadSnapshotForTest, "the builder is exported for testing");

  const emptyRun = buildRunThreadSnapshotForTest({
    task: "fix the polling status bug",
    route: "task",
    success: true,
    summary: "I read the files but did not reproduce the bug. No changes were made.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    writtenPaths: [],
    reproduction: { reproduced: false, askedUser: false, blocks: 2, traceOpened: true, gaveUpAfterBlocks: 2 },
  });
  assert.equal(emptyRun.disposition, "failed", "nothing observed and nothing changed is not a completed run");
  assert.equal(emptyRun.reproduction.reproduced, false, "and the report is carried so a host can see why");
  assert.ok(Orchestrator, "sanity: the module loaded");
});

test("a bug fix that reproduced, or that shipped a fix, still completes", async () => {
  const { buildRunThreadSnapshotForTest: build } = await import("../dist/orchestrator/orchestrator.js");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const base = { task: "t", route: "task", success: true, summary: "s", usage };

  // Observed the bug and fixed it.
  assert.equal(
    build({ ...base, writtenPaths: ["/p/a.ts"], reproduction: { reproduced: true, askedUser: false, blocks: 1 } }).disposition,
    "completed",
  );
  // Did not reproduce, but work landed: `verified`/`reproduction` carry the caveat,
  // and calling this failed would be wrong — a fix did ship.
  assert.equal(
    build({ ...base, writtenPaths: ["/p/a.ts"], reproduction: { reproduced: false, askedUser: false, blocks: 2, gaveUpAfterBlocks: 2 } }).disposition,
    "completed",
  );
  // Asked the user for steps, wrote nothing: the ball is with the user, not a failure.
  assert.equal(
    build({ ...base, writtenPaths: [], reproduction: { reproduced: false, askedUser: true, blocks: 0 } }).disposition,
    "completed",
  );
  // A declared-straightforward skip, wrote nothing: an auditable no-op, not a failure.
  assert.equal(
    build({ ...base, writtenPaths: [], reproduction: { reproduced: false, askedUser: false, blocks: 0, declaredStraightforward: { reason: "typo" } } }).disposition,
    "completed",
  );
  // Not a bug fix at all (no report): untouched behaviour.
  assert.equal(build({ ...base, writtenPaths: [] }).disposition, "completed");
});
