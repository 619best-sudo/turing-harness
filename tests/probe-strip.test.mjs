/**
 * Instrumentation that outlives the run that placed it.
 *
 * From the field: a run was stopped by hand while the chain's cleanup pass was
 * still going — `end loop: cleanup:strip-probes error=aborted` — and 24 probe
 * lines stayed behind in three files. The cleanup was a MODEL loop, so it was as
 * abortable as the run it followed, and the moment a user stops a run is exactly
 * the moment probes are most likely to be left.
 *
 * The next run then read those lines as product code. Its write hop authored a
 * fix whose `oldString` contained another session's
 * `print("TURING_TRACE_7c62b2c4 …")`, because that line was genuinely in the file.
 *
 * So the strip is deterministic first: whole-line probes come out by rule, with
 * no model and nothing to abort. Only a probe ENTANGLED with code needs judgement.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PROBE_MARKER_RE, stripProbeLines, traceMarker } from "../dist/index.js";

const MARK = traceMarker("turing-trace-7c62b2c4");

test("whole-line probes are removed, in any language's log call", () => {
  const source = [
    "void reload() {",
    `    print("${MARK} reload start leadId=$leadId");`,
    "    final lead = await get();",
    `    console.log(\`${MARK} tick\`)`,
    `    fmt.Println("${MARK} go")`,
    `    puts "${MARK} ruby"`,
    `    NSLog(@"${MARK} objc");`,
    `    // ${MARK} a note the run left behind`,
    `    # ${MARK} python note`,
    "    return lead;",
    "}",
  ].join("\n");

  const result = stripProbeLines(source);
  assert.equal(result.removed, 7);
  assert.deepEqual(result.mixed, []);
  assert.ok(!PROBE_MARKER_RE.test(result.content), "no marker survives");
  // Everything else is byte-identical, in order.
  assert.deepEqual(result.content.split("\n"), [
    "void reload() {",
    "    final lead = await get();",
    "    return lead;",
    "}",
  ]);
});

test("a probe entangled with code is reported, never guessed at", () => {
  // Removing the probe here means re-authoring the statement — a judgement call,
  // so the line stays and the caller is told where it is.
  const source = [
    "if (a) {",
    `  if (x) { print("${MARK} early"); return; }`,
    `  final keep = 1; // ${MARK} trailing`,
    "}",
  ].join("\n");
  const result = stripProbeLines(source);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.mixed, [2, 3]);
  assert.equal(result.content, undefined, "nothing rewritten when nothing is removable");
});

test("a file with no probes is untouched", () => {
  const clean = "void main() {\n  print('hello');\n}\n";
  const result = stripProbeLines(clean);
  assert.deepEqual(result, { removed: 0, mixed: [], emptiedBlocks: [] });
  assert.equal(result.content, undefined);
});

test("the real file's shape: seven standalone probes, all of them go", () => {
  // Modelled on lib/providers/leads_provider.dart as the aborted run left it.
  const source = [
    "  Future<Lead> reload(String leadId, {bool setCurrent = true}) async {",
    `    print("${MARK} reload start leadId=$leadId setCurrent=$setCurrent");`,
    "    final lead = await _repository.getLeadDetail(leadId);",
    "    Lead? existing;",
    "    for (final l in _leads) {",
    "      if (l.id == leadId) { existing = l; break; }",
    "    }",
    `      print("${MARK} reload injecting unloaded leadId=\${lead.id}");`,
    "    final statusUnchanged = existing != null && !_changed(existing, lead);",
    "    if (!setCurrent && statusUnchanged) {",
    `      print("${MARK} reload skipNotify leadId=$leadId");`,
    "      return lead;",
    "    }",
    "    notifyListeners();",
    "    return lead;",
    "  }",
  ].join("\n");
  const result = stripProbeLines(source);
  assert.equal(result.removed, 3);
  assert.deepEqual(result.mixed, []);
  assert.ok(!PROBE_MARKER_RE.test(result.content));
  // The code around them survives exactly, including the early return the probe
  // was sitting inside of.
  assert.match(result.content, /if \(!setCurrent && statusUnchanged\) \{\n {6}return lead;\n {4}\}/);
});

test("a block the removal emptied is reported, not rewritten", () => {
  // Found by doing it for real: stripping 24 probes from a live project left two
  // `} else { }` husks, because the instrumenting run had added those branches for
  // no purpose but to host a probe.
  const source = [
    "if (timer == null) {",
    "  start();",
    `} else {`,
    `  print("${MARK} timerAlreadyRunning");`,
    "}",
  ].join("\n");
  const result = stripProbeLines(source);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.emptiedBlocks, [3], "the `} else {` line is named");
  // The husk is left in place: whether it should collapse depends on the code
  // around it, which is a judgement, not a rule.
  assert.match(result.content, /\} else \{\n\}/);
});

test("a block that still has code in it is not reported as emptied", () => {
  const source = [
    "if (a) {",
    `  print("${MARK} one");`,
    "  doWork();",
    "}",
  ].join("\n");
  const result = stripProbeLines(source);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.emptiedBlocks, []);
  assert.match(result.content, /if \(a\) \{\n {2}doWork\(\);\n\}/);
});
