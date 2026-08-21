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
  const reg = new Registry();
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
  assert.match(p, /re-reading\s+it is how this hop turns into a second read pass/);
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
  assert.match(cleanup.output, /mobile \{action:"launch"\}/, "names how to run it");

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
