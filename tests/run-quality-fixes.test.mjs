/**
 * Regressions from one observed run, each one a mechanism that failed silently.
 *
 * The run: a small copy change on a mobile app. It spent ~28 calls finding the
 * file, wrote a value nobody asked for, re-edited the same six lines four times,
 * and finished without ever looking at the screen — while every individual tool
 * call reported success. Nothing threw. That is what makes these worth pinning:
 * each failure below is invisible from the outside.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { literalOnlyReplacement, grepTool, readTool, editTool } from "../dist/tools/builtin/coding.js";
import { VerificationGate } from "../dist/orchestrator/verification-gate.js";
import { ClarifyGate } from "../dist/orchestrator/clarify-gate.js";
import { needsRunningApp } from "../dist/orchestrator/run-handoff.js";

/**
 * Project dirs created by this file, removed when the process exits.
 *
 * Without this every run leaves its fixtures behind, and they accumulate: this
 * repo's older suites have left thousands of dirs in tmpdir since July, and a
 * tmpdir with ~90k entries slows `mkdtemp` enough to push a neighbouring test
 * past its deadline. A test that litters makes an unrelated test flaky.
 */
const TMP_DIRS = [];
process.on("exit", () => {
  for (const dir of TMP_DIRS) {
    try {
      syncFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; a leftover dir must never fail the run
    }
  }
});

async function tmpProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turing-rq-"));
  TMP_DIRS.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf8");
  }
  return dir;
}

const ctx = (cwd) => ({ cwd, log: () => {} });

// ---------------------------------------------------------------------------
// grep: the regex flavour, and "no matches" meaning what it says
// ---------------------------------------------------------------------------

test("grep supports alternation — the fallback engine must not be basic regex", async () => {
  // BSD `grep -rn` is BRE, where `|` is a literal pipe. A pattern the tool's own
  // description promises returned exit 1, which the tool then reported as
  // "(no matches)" — a search that silently answers "it is not there".
  const dir = await tmpProject({ "src/a.txt": "alpha value\n", "src/b.txt": "beta value\n" });
  const res = await grepTool.execute("t", { pattern: "alpha|beta", path: dir }, ctx(dir));
  assert.ok(!res.isError, "alternation must not error");
  assert.match(res.output, /alpha/, "the first branch must match");
  assert.match(res.output, /beta/, "the second branch must match");
});

test("grep reports a real failure as a failure, never as (no matches)", async () => {
  // An unparseable regex is exit 2. The old test was `code > 1`, which also let a
  // `maxBuffer` overrun through, because its `code` is the STRING
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER and `"ERR_…" > 1` is false.
  const dir = await tmpProject({ "src/a.txt": "x\n" });
  const res = await grepTool.execute("t", { pattern: "a(", path: dir }, ctx(dir));
  assert.equal(res.isError, true, "a broken pattern is an error");
  assert.doesNotMatch(res.output, /\(no matches\)/);
  assert.match(res.output, /NOT "no matches"/i, "it must say the search did not complete");
});

test("grep does not return the harness's own generated index as a search result", async () => {
  // A symbol index mentions every symbol in the project, so before it was excluded
  // a search for any symbol returned its index entries and nothing else — which
  // reads as "there are no real call sites".
  const dir = await tmpProject({
    "lib/widget.dart": "void showThing() {}\n",
    ".turing/graph.json": JSON.stringify({ nodes: { "symbol:showThing": { symbol: "showThing" } } }),
  });
  const res = await grepTool.execute("t", { pattern: "showThing", path: dir }, ctx(dir));
  assert.match(res.output, /widget\.dart/, "real source must be found");
  assert.doesNotMatch(res.output, /graph\.json/, "the generated index must not appear");
});

// ---------------------------------------------------------------------------
// read: an ignored window argument returns the wrong lines
// ---------------------------------------------------------------------------

test("read refuses an undeclared argument instead of silently returning line 1", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const dir = await tmpProject({ "a.txt": body });
  const file = path.join(dir, "a.txt");

  const bad = await readTool.execute("t", { path: file, start_line: 30 }, ctx(dir));
  assert.equal(bad.isError, true, "an unrecognised window argument must not be ignored");
  assert.doesNotMatch(bad.output, /line 1\b/, "it must not return the top of the file");
  assert.match(bad.output, /'offset'/, "it must name the argument that does exist");

  const good = await readTool.execute("t", { path: file, offset: 30, limit: 2 }, ctx(dir));
  assert.ok(!good.isError, good.output);
  assert.match(good.output, /30\tline 30/);
  assert.doesNotMatch(good.output, /line 1\b/);
});

// ---------------------------------------------------------------------------
// edit: the model's literal bytes, and argument types
// ---------------------------------------------------------------------------

test("literalOnlyReplacement recognises a text/number change and nothing else", () => {
  // Only literals differ, structure identical → verbatim.
  assert.equal(literalOnlyReplacement(`Text('Old title')`, `Text('New title')`), true);
  assert.equal(literalOnlyReplacement(`padding: 8`, `padding: 16`), true);
  assert.equal(literalOnlyReplacement(`color: "#fff"`, `color: "#000"`), true);
  // Re-indentation is not a structural change.
  assert.equal(literalOnlyReplacement(`  Text('a')`, `Text('b')`), true);

  // Structure changed → must still go to the authoring model.
  assert.equal(literalOnlyReplacement(`Text('a')`, `Column(children: [Text('a')])`), false);
  assert.equal(literalOnlyReplacement(`if (a) return 1;`, `if (a && b) return 1;`), false);
  // A literal REMOVED or added is a structural difference, not a substitution.
  assert.equal(literalOnlyReplacement(`f('a', 'b')`, `f('a')`), false);
  // No change at all is not a literal edit.
  assert.equal(literalOnlyReplacement(`Text('a')`, `Text('a')`), false);
  // An identifier rename is code, not copy.
  assert.equal(literalOnlyReplacement(`const a = 1;`, `const b = 1;`), false);
  // A number inside an identifier is not a literal.
  assert.equal(literalOnlyReplacement(`const w1 = 'x';`, `const w2 = 'x';`), false);
});

test("a literal-only edit writes the model's bytes verbatim, with no authoring pass", async () => {
  // The failure this prevents: the driver said 'New title', the authoring model was
  // handed the anchor plus an ambiguous task, and wrote something else — twice.
  const dir = await tmpProject({ "app.dart": `Text(\n  'Old title',\n)\n` });
  const file = path.join(dir, "app.dart");
  let authoringCalled = false;
  const res = await editTool.execute(
    "t",
    { path: file, oldString: "'Old title'", newString: "'New title'" },
    {
      cwd: dir,
      log: () => {},
      // A bridge IS available and a model IS routed — the exact configuration in
      // which the draft used to be discarded.
      llm: { complete: async () => { authoringCalled = true; return { role: "assistant", content: [{ type: "text", text: "'Something Else'" }], usage: null }; } },
      model: { id: "driver", input: ["text"] },
      routeModel: () => "author/model",
    },
  );
  assert.ok(!res.isError, res.output);
  assert.equal(authoringCalled, false, "a literal change must not be re-authored");
  assert.equal(await fs.readFile(file, "utf8"), `Text(\n  'New title',\n)\n`);
  assert.match(res.output, /verbatim/i, "the result must say the bytes were written as specified");
});

test("edit coerces an unambiguous non-string newString (one-element string array) and applies it", async () => {
  // A model that sends newString as `["new"]` has said exactly what it wants written
  // — the shape is wrong, the intent is not. Join it (and surface a NOTE) instead of
  // refusing and burning a turn. The old `String(["new"])` silently became `"new"`
  // with no signal; the NOTE is what makes that visible rather than silent.
  const dir = await tmpProject({ "a.txt": "old\n" });
  const file = path.join(dir, "a.txt");
  const res = await editTool.execute("t", { path: file, oldString: "old", newString: ["new"] }, ctx(dir));
  assert.ok(!res.isError, res.output);
  assert.equal(await fs.readFile(file, "utf8"), "new\n", "the joined string is written");
  assert.match(res.output, /arrived as array of 1 strings/i, "the result notes the coercion");
});

test("edit still refuses a genuinely ambiguous non-string newString", async () => {
  // An array of non-text values has no single unambiguous reading — refuse it and
  // leave the file untouched, rather than guess what the model meant.
  const dir = await tmpProject({ "a.txt": "old\n" });
  const file = path.join(dir, "a.txt");
  const res = await editTool.execute("t", { path: file, oldString: "old", newString: [{ x: 1 }, { y: 2 }] }, ctx(dir));
  assert.equal(res.isError, true);
  assert.match(res.output, /must be a STRING/);
  assert.equal(await fs.readFile(file, "utf8"), "old\n", "the file must be untouched");
});

// ---------------------------------------------------------------------------
// verification gate: which files owe a look
// ---------------------------------------------------------------------------

test("on a screen-rendering project, a source change owes a VISUAL check", () => {
  // The whole chain that failed: a mobile source file fell back to `logic`, so the
  // gate asked for a logic check, the model ran the analyzer and the test runner,
  // `needsRunningApp` saw no `visual` method so the user was never offered the
  // handoff, and the change shipped with nobody having looked at it.
  for (const category of ["frontend", "mobile", "games"]) {
    const gate = new VerificationGate({ projectCategory: category });
    gate.observeWritten("/app/lib/thing.dart");
    const [gap] = gate.gaps();
    assert.equal(gap?.method, "visual", `${category} source must owe a visual check`);
    assert.equal(needsRunningApp([gap.method]), true, `${category} must trigger the running-app handoff`);
  }
});

test("on a backend project the same file owes a logic check, not a screenshot", () => {
  const gate = new VerificationGate({ projectCategory: "backend" });
  gate.observeWritten("/app/service.py");
  assert.equal(gate.gaps()[0]?.method, "logic");
});

test("markup and component files are visual with no category at all", () => {
  const gate = new VerificationGate();
  for (const p of ["/p/a.css", "/p/b.html", "/p/C.tsx", "/p/d.vue"]) gate.observeWritten(p);
  assert.deepEqual(gate.gaps().map((g) => g.method), ["visual", "visual", "visual", "visual"]);
});

// ---------------------------------------------------------------------------
// clarify gate: ask before inventing a value
// ---------------------------------------------------------------------------

test("the clarify gate refuses the first WRITE when the router says the value is unspecified", () => {
  const gate = new ClarifyGate({ valueUnspecified: true, task: "change the heading" });
  assert.equal(gate.active, true);
  // Reads are never blocked — finding the file is exactly what should happen first.
  assert.equal(gate.check("read", { path: "a" }).kind, "allow");
  assert.equal(gate.check("grep", { pattern: "a" }).kind, "allow");

  const blocked = gate.check("edit", { path: "a", oldString: "x", newString: "y" });
  assert.equal(blocked.kind, "block");
  assert.match(blocked.message, /ask_user_question/);

  // Bounded: a second mutation proceeds, so a model that will not ask is not
  // deadlocked and the run still reports honestly.
  assert.equal(gate.check("edit", { path: "a" }).kind, "allow");
});

test("the clarify gate does NOT block read-only shell exploration", () => {
  // A live run's FIRST turn was `bash {command: "find . -name '*.dart'"}` and the
  // gate refused it, because `bash` carries the loop's `mutates` flag. The model
  // then asked its question having read nothing — so it could not offer the current
  // value or any options, which is what the refusal message asks it to do.
  const gate = new ClarifyGate({ valueUnspecified: true, task: "change the heading" });
  for (const command of [
    "find . -type f -name '*.dart' | head -50",
    "ls -la lib/screens",
    "grep -rn 'Delete' lib",
    "cat lib/main.dart",
    "npm test",
  ]) {
    assert.equal(gate.check("bash", { command }).kind, "allow", `must allow: ${command}`);
  }
  // But a shell command that AUTHORS source is a write, and is refused.
  const blocked = gate.check("bash", { command: "sed -i '' 's/a/b/' lib/main.dart" });
  assert.equal(blocked.kind, "block", "a shell write is still a write");
});

test("the refusal does not echo a host preamble back at the model", () => {
  // One host passes its whole runtime context as `task` — MCP tool listings,
  // transcript rules, then the user's line at the end. Quoting that verbatim put
  // 3.6KB of tool names inside a refusal about a missing value.
  const preamble = [
    "Use the following Turing Machine runtime context while working on the task.",
    "",
    "CONNECTED MCP TOOLS: mobile_list_available_devices, mobile_launch_app, ...",
    "",
    "USER TASK:",
    "",
    "change title of delete account popup",
  ].join("\n");
  const gate = new ClarifyGate({ valueUnspecified: true, task: preamble });
  const blocked = gate.check("edit", { path: "a" });
  assert.equal(blocked.kind, "block");
  assert.doesNotMatch(blocked.message, /CONNECTED MCP TOOLS/, "the preamble must not be quoted");
  assert.doesNotMatch(blocked.message, /The request was:/, "and it must not be quoted at all when it is not the request");
  // A genuine short request still gets quoted, because that IS useful.
  const short = new ClarifyGate({ valueUnspecified: true, task: "change the heading" });
  assert.match(short.check("edit", { path: "a" }).message, /The request was: "change the heading"/);
});

test("asking the user satisfies the clarify gate for the rest of the run", () => {
  const gate = new ClarifyGate({ valueUnspecified: true, task: "change the heading" });
  gate.observe("ask_user_question");
  assert.equal(gate.check("edit", { path: "a" }).kind, "allow");
  assert.equal(gate.toReport().asked, true);
});

test("the clarify gate is inert unless the router armed it, and stands down for attachments", () => {
  assert.equal(new ClarifyGate().active, false);
  assert.equal(new ClarifyGate({ valueUnspecified: false }).active, false);
  // An attachment is usually the missing specification.
  assert.equal(new ClarifyGate({ valueUnspecified: true, hasAttachments: true }).active, false);
  const inert = new ClarifyGate({ valueUnspecified: false });
  assert.equal(inert.check("edit", { path: "a" }).kind, "allow");
});

// ---------------------------------------------------------------------------
// authoring routing: the category the host routes on
// ---------------------------------------------------------------------------

test("an undeclared UI edit routes with a category, on any stack", async () => {
  // `routeModel` used to be called with `category` OMITTED whenever the model had
  // not declared one — so the authoring PROMPT was told "this is ui work" while the
  // model that would carry it out was chosen with no category at all. A host
  // routing table keyed on category could not see UI work in the common case.
  const dir = await tmpProject({ "lib/home_screen.dart": "Text('a')\nColumn(children: [])\n" });
  const file = path.join(dir, "lib/home_screen.dart");
  const routeCalls = [];
  await editTool.execute(
    "t",
    // Structural change, so it does NOT take the literal-only shortcut and really
    // goes through authoring.
    { path: file, oldString: "Column(children: [])", newString: "Row(children: [Text('b')])" },
    {
      cwd: dir,
      log: () => {},
      projectCategory: "mobile",
      llm: { complete: async () => ({ role: "assistant", content: [{ type: "text", text: "Row(children: [Text('b')])" }], usage: null }) },
      model: { id: "driver", input: ["text"] },
      routeModel: (req) => { routeCalls.push(req); return "author/model"; },
    },
  );
  const write = routeCalls.find((r) => r.kind === "write");
  assert.ok(write, "the authoring model must be routed");
  assert.equal(write.category, "ui", "a mobile screen is ui work, declared or not");
});

test("a declared category still wins over the inferred one", async () => {
  const dir = await tmpProject({ "lib/home_screen.dart": "Text('a')\nColumn(children: [])\n" });
  const file = path.join(dir, "lib/home_screen.dart");
  const routeCalls = [];
  await editTool.execute(
    "t",
    { path: file, oldString: "Column(children: [])", newString: "Row(children: [Text('b')])", category: "code" },
    {
      cwd: dir,
      log: () => {},
      projectCategory: "mobile",
      declaredCategory: "code",
      llm: { complete: async () => ({ role: "assistant", content: [{ type: "text", text: "Row(children: [Text('b')])" }], usage: null }) },
      model: { id: "driver", input: ["text"] },
      routeModel: (req) => { routeCalls.push(req); return "author/model"; },
    },
  );
  assert.equal(routeCalls.find((r) => r.kind === "write")?.category, "code");
});

test("a backend project's source is NOT reclassified as ui", async () => {
  const dir = await tmpProject({ "svc/handler.ts": "const a = 1;\nfunction go() { return 2; }\n" });
  const file = path.join(dir, "svc/handler.ts");
  const routeCalls = [];
  await editTool.execute(
    "t",
    { path: file, oldString: "function go() { return 2; }", newString: "function go() { return compute(); }" },
    {
      cwd: dir,
      log: () => {},
      projectCategory: "backend",
      llm: { complete: async () => ({ role: "assistant", content: [{ type: "text", text: "function go() { return compute(); }" }], usage: null }) },
      model: { id: "driver", input: ["text"] },
      routeModel: (req) => { routeCalls.push(req); return "author/model"; },
    },
  );
  assert.equal(routeCalls.find((r) => r.kind === "write")?.category, "code");
});

// ---------------------------------------------------------------------------
// read comprehension: aimed at the task and the kind of file
// ---------------------------------------------------------------------------

test("a UI file's comprehension gets interface risks, not the logic enumeration", async () => {
  // A UI file read during a copy change used to come back with a seven-point audit
  // of await usage, loop bounds and blast radius — accurate about the file,
  // irrelevant to the change, and repeated on every re-read.
  const { comprehendFile } = await import("../dist/tools/builtin/comprehension.js");
  const seen = {};
  const llm = {
    complete: async (_m, c) => {
      seen.system = c.systemPrompt;
      return { role: "assistant", content: [{ type: "text", text: "analysis" }], usage: null };
    },
  };
  await comprehendFile({
    llm,
    model: { id: "strong" },
    path: "/p/home_screen.dart",
    content: "x",
    rating: "high",
    category: "ui",
    task: "change the heading",
  });
  assert.match(seen.system, /INTERFACE code/, "interface framing must be used");
  assert.match(seen.system, /WHAT RENDERS WHAT/);
  assert.doesNotMatch(seen.system, /SYNC VS ASYNC/, "the logic enumeration must not be included");
  assert.match(seen.system, /LEAD WITH THE TASK/, "the task must be told to come first");
});

test("a code file still gets the logic enumeration", async () => {
  const { comprehendFile } = await import("../dist/tools/builtin/comprehension.js");
  const seen = {};
  const llm = {
    complete: async (_m, c) => {
      seen.system = c.systemPrompt;
      return { role: "assistant", content: [{ type: "text", text: "analysis" }], usage: null };
    },
  };
  await comprehendFile({
    llm,
    model: { id: "strong" },
    path: "/p/queue.ts",
    content: "x",
    rating: "high",
    category: "code",
  });
  assert.match(seen.system, /SYNC VS ASYNC/);
  assert.doesNotMatch(seen.system, /INTERFACE code/);
});

// ---------------------------------------------------------------------------
// plan steps: each step is its own prompt, with its own image
// ---------------------------------------------------------------------------

test("a step attachment is ROUTED to that step's files, so many run images cannot drown it", async () => {
  // A step's own images are merged with every run-wide image before the work loop
  // sees them. With eight uploaded mockups that is nine candidates, and without
  // routing evidence the scope came out AMBIGUOUS and passed NO image — the step
  // the user pinned a design to authored from prose.
  const { scopeImagesForTarget } = await import("../dist/multimodal/attachment-routing.js");

  // What `stepImageRefs` now produces for a step: {files:["src/Hero.tsx"],
  // attachments:[{path:"Frame 12.png", note:"the hero"}]} — a filename with no
  // distinctive token, which is what real design exports look like.
  const stepImage = {
    path: "/up/Frame 12.png",
    mimeType: "image/png",
    targets: ["src/Hero.tsx"],
    label: "the hero",
  };
  const runImages = Array.from({ length: 8 }, (_, i) => ({
    path: `/up/Frame ${20 + i}.png`,
    mimeType: "image/png",
  }));

  const scoped = scopeImagesForTarget("src/Hero.tsx", [stepImage, ...runImages]);
  assert.equal(scoped.reason, "routed", "the step's own attachment must win outright");
  assert.deepEqual(scoped.images.map((i) => i.path), ["/up/Frame 12.png"]);

  // The old `stepImageRefs` returned only {path, mimeType} — it dropped BOTH the
  // routing target and the note. With neither, the set is indistinguishable.
  const before = scopeImagesForTarget(
    "src/Hero.tsx",
    [{ path: stepImage.path, mimeType: stepImage.mimeType }, ...runImages],
  );
  assert.equal(before.reason, "ambiguous");
  assert.deepEqual(before.images, [], "which is why the step got no image at all");

  // The note alone is worth carrying: even unrouted, a note whose words match the
  // target wins on affinity. Dropping `label` threw that away too.
  const labelOnly = scopeImagesForTarget(
    "src/Hero.tsx",
    [{ path: stepImage.path, mimeType: stepImage.mimeType, label: "the hero" }, ...runImages],
  );
  assert.equal(labelOnly.reason, "affinity");
});

test("a step's image is excluded from contention for another step's file", async () => {
  const { scopeImagesForTarget } = await import("../dist/multimodal/attachment-routing.js");
  const heroImage = { path: "/up/a.png", mimeType: "image/png", targets: ["src/Hero.tsx"] };
  const loose = { path: "/up/b.png", mimeType: "image/png" };
  const scoped = scopeImagesForTarget("src/Pricing.tsx", [heroImage, loose]);
  assert.equal(scoped.reason, "sole", "the routed image is out of contention, leaving one candidate");
  assert.deepEqual(scoped.images.map((i) => i.path), ["/up/b.png"]);
});

test("one verification clears EVERY step's owed file, not just the step that ran the check", () => {
  // Verification is run-level: all steps run, then one verify pass. The gate does
  // not attribute a check to a file, so a single passing capture credits every
  // owed file of every step. Documented as the cheap direction to err in — but on
  // a multi-step plan it means steps 2..N can inherit step 1's evidence.
  const gate = new VerificationGate({ projectCategory: "frontend" });
  gate.observeWritten("/p/Hero.tsx");
  gate.observeWritten("/p/Pricing.tsx");
  gate.observeWritten("/p/Footer.tsx");
  assert.equal(gate.gaps().length, 3);
  gate.observeCheck("activity_inspect", false, 2048, "VERDICT: PASS");
  assert.equal(gate.isSatisfied(), true, "one check satisfies all three");
  assert.deepEqual(gate.toReport().checked.map((c) => c.path).sort(), [
    "/p/Footer.tsx",
    "/p/Hero.tsx",
    "/p/Pricing.tsx",
  ]);
});

// ---------------------------------------------------------------------------
// read comprehension: is the analysis actually usable?
// ---------------------------------------------------------------------------

test("the comprehension model receives NUMBERED source, so its citations are navigable", async () => {
  // The full-file branch used to send the RAW file. A model with no line numbers
  // estimates them, and on a 1,280-line file every citation came back approximate
  // and wrong by up to 275 lines — under a banner telling the reader the numbers
  // were authoritative.
  const { readTool } = await import("../dist/tools/builtin/coding.js");
  const { clearComprehensionMemory } = await import("../dist/tools/builtin/comprehension.js");
  clearComprehensionMemory();

  // A file with enough shape that the cheap prefilter does not call it trivial.
  const body = [
    "class Screen {",
    ...Array.from({ length: 60 }, (_, i) =>
      `  void step${i}() { if (cond$${i}) { doWork(); } else { fallback(); } }`),
    "}",
  ].join("\n");
  const dir = await tmpProject({ "screen.dart": body });
  const file = path.join(dir, "screen.dart");

  const seen = [];
  const llm = {
    complete: async (_m, c) => {
      const text = (c.messages[0].content ?? "");
      seen.push(typeof text === "string" ? text : JSON.stringify(text));
      return {
        role: "assistant",
        content: [{ type: "text", text: "RATING: high | WHY: dense branching" }],
        usage: null,
      };
    },
  };
  await readTool.execute("t", { path: file }, {
    cwd: dir,
    log: () => {},
    llm,
    model: { id: "reader", openRouterSlug: "reader" },
    routeModel: () => "stronger/model",
  });

  // The comprehension call is the one that carries CONTENTS. Every prompt that
  // includes the file must include it line-numbered.
  const withContents = seen.filter((t) => t.includes("class Screen"));
  assert.ok(withContents.length > 0, "the file must reach the escalation call");
  for (const prompt of withContents) {
    assert.match(prompt, /1\tclass Screen/, "the source must be line-numbered");
    assert.match(prompt, /\n30\t/, "interior lines must carry their numbers too");
  }
});

test("the comprehension prompt forbids padded sections, speculative risk and guessed lines", async () => {
  const { comprehendFile } = await import("../dist/tools/builtin/comprehension.js");
  const seen = {};
  const llm = {
    complete: async (_m, c) => {
      seen.system = c.systemPrompt;
      return { role: "assistant", content: [{ type: "text", text: "a" }], usage: null };
    },
  };
  await comprehendFile({ llm, model: { id: "s" }, path: "/p/a.ts", content: "x", rating: "high", category: "code" });
  assert.match(seen.system, /SEARCH ORDER, NOT AN OUTLINE/, "must forbid a heading per checklist item");
  assert.match(seen.system, /PRESENT-TENSE RISKS ONLY/, "must forbid hypothetical-future-edit risk");
  assert.match(seen.system, /Never write an approximate or guessed line/, "must forbid ~N citations");
  assert.match(seen.system, /LEAD WITH THE TASK/);
});

test("a literal-only edit KEEPS the analysis; a structural edit drops it", async () => {
  const { editTool } = await import("../dist/tools/builtin/coding.js");
  const { rememberComprehension, recallComprehension, clearComprehensionMemory, hashContent } =
    await import("../dist/tools/builtin/comprehension.js");

  const start = `Text(\n  'Old',\n)\n`;
  for (const [label, edit, expectKept] of [
    ["literal", { oldString: "'Old'", newString: "'New'" }, true],
    ["structural", { oldString: "Text(\n  'Old',\n)", newString: "Column(children: [Text('Old')])" }, false],
  ]) {
    clearComprehensionMemory();
    const dir = await tmpProject({ "a.dart": start });
    const file = path.join(dir, "a.dart");
    rememberComprehension(file, {
      rating: "high",
      analysis: "the analysis",
      model: "strong",
      fileHash: hashContent(start),
      coveredRange: "full",
    });
    const res = await editTool.execute("t", { path: file, ...edit }, ctx(dir));
    assert.ok(!res.isError, `${label}: ${res.output}`);
    const after = recallComprehension(file);
    if (expectKept) {
      assert.ok(after, "a literal change must keep the analysis");
      assert.equal(after.analysis, "the analysis");
      assert.equal(
        after.fileHash,
        hashContent(await fs.readFile(file, "utf8")),
        "and re-anchor it to the new bytes so the reuse gate hits",
      );
    } else {
      assert.equal(after, undefined, "a structural change must drop the analysis");
    }
  }
});

// ---------------------------------------------------------------------------
// getting the app onto a device: not by launching it three times
// ---------------------------------------------------------------------------

test("an identical background command is not launched twice", async () => {
  // A run launched three BYTE-IDENTICAL `flutter run` commands at one simulator,
  // then had to `pkill -f flutter` twice. Each returned "readiness is not confirmed
  // yet", which is honest and which the model read as "that did not work".
  const { bashTool } = await import("../dist/tools/builtin/coding.js");
  const dir = await tmpProject({ "noop.txt": "x" });
  const c = { cwd: dir, log: () => {} };
  // A command that stays alive and prints nothing a ready-pattern would match.
  const command = "sleep 30";

  const first = await bashTool.execute("a", { command, background: true, pollMs: 300 }, c);
  assert.ok(!first.isError, first.output);
  assert.match(first.output, /Started background command/);

  const second = await bashTool.execute("b", { command, background: true, pollMs: 300 }, c);
  assert.match(second.output, /ALREADY RUNNING/, "the duplicate must be refused");
  assert.equal(second.details?.alreadyRunning, true);
  assert.equal(second.details?.pid, first.details?.pid, "and point at the SAME process");
  assert.match(second.output, /log/i, "and hand back the log to poll");

  // Whitespace-only reformatting is still the same command.
  const third = await bashTool.execute("c", { command: "sleep   30", background: true, pollMs: 300 }, c);
  assert.match(third.output, /ALREADY RUNNING/);

  // A deliberate restart (different command text) is NOT blocked.
  const restart = await bashTool.execute(
    "d",
    { command: "pkill -f 'sleep 30' || true; sleep 31", background: true, pollMs: 300 },
    c,
  );
  assert.match(restart.output, /Started background command/, "an explicit restart must still run");

  // And `force` is the documented escape hatch.
  const forced = await bashTool.execute("e", { command: "sleep 32", background: true, pollMs: 300 }, c);
  assert.match(forced.output, /Started background command/);
  const forcedDup = await bashTool.execute(
    "f",
    { command: "sleep 32", background: true, pollMs: 300, force: true },
    c,
  );
  assert.match(forcedDup.output, /Started background command/, "force spawns a second copy");
});

// ---------------------------------------------------------------------------
// a transport fault must not read as a wrong tool name
// ---------------------------------------------------------------------------

test("call-framing leaked into the tool name is reported as malformed, not unknown", async () => {
  const { unknownToolMessage, nameBeforeFraming } = await import("../dist/orchestrator/tool-suggest.js");
  const known = ["bash", "read", "edit", "mobile_take_screenshot", "mobile_click_on_screen_at_coordinates"];

  // The four shapes seen in one real run.
  for (const [requested, expected] of [
    ["bash<|tool_call_begin|>cat /var/x.log 2>&1 | head -50</arg_value>", "bash"],
    ['mobile_take_screenshot<|tool_call_begin|>{"device": "ABC"}', "mobile_take_screenshot"],
    ['mobile_click_on_screen_at_coordinates<|tool_call_begin|><|tool_call_argument_begin|>{"x": 1}<|tool_call_end|>', "mobile_click_on_screen_at_coordinates"],
    ['mobile_click_on_screen_at_coordinates<|tool_call_begin|>{"x": 2}<|tool_call_end|>', "mobile_click_on_screen_at_coordinates"],
  ]) {
    assert.equal(nameBeforeFraming(requested, known), expected, requested);
    const msg = unknownToolMessage(requested, known);
    assert.match(msg, /arrived malformed/, "it must be named as a transport fault");
    assert.match(msg, new RegExp(`The tool you meant is "${expected}"`));
    assert.doesNotMatch(msg, /^Unknown tool/, "not a bare unknown-tool dead end");
  }

  // A genuinely wrong name is still handled the old way.
  const wrong = unknownToolMessage("playwright", known);
  assert.match(wrong, /^Unknown tool "playwright"/);
  assert.equal(nameBeforeFraming("playwright", known), undefined);
  // Framing around a name that is NOT registered must not be invented into one.
  assert.equal(nameBeforeFraming("not_a_tool<|tool_call_begin|>{}", known), undefined);
});

test("a framed name whose ARGUMENTS survived is repaired and the call runs", async () => {
  // The half this used to get wrong. `read<|channel|>clipboard` arrived with a
  // complete `{path, offset, limit}` and was rejected anyway, under a message
  // asserting the arguments were empty — which was false. The model re-issued it
  // three different ways across three turns before one got through.
  const { LogStore, OpenRouterBridge, PermissionGate, Registry, runToolLoop } = await import("../dist/index.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "framing-recover-"));
  const file = path.join(dir, "note.txt");
  await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

  const ran = [];
  const tool = {
    name: "read_note",
    description: "test tool",
    mutates: false,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, args) {
      ran.push(args);
      return { output: `read ${args.path}` };
    },
  };

  let turn = 0;
  const llm = new OpenRouterBridge();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  llm.stream = async function* () {
    const base = { model: "x", api: "openrouter", provider: "x", usage: zero, timestamp: 0 };
    yield { type: "start", partial: { role: "assistant", content: [], ...base, stopReason: "stop" } };
    if (turn++ === 0) {
      const name = "read_note<|channel|>clipboard";
      const args = { path: file };
      yield { type: "toolCall_delta", toolCallId: "t1", delta: { name } };
      yield { type: "toolCall_delta", toolCallId: "t1", delta: { arguments: JSON.stringify(args) } };
      yield { type: "done", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name, arguments: args }], ...base, stopReason: "tool_use" } };
      return;
    }
    yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "done" }], ...base, stopReason: "stop" } };
  };

  const logStore = new LogStore();
  const result = await runToolLoop({
    llm,
    permission: new PermissionGate("bypass"),
    registry: new Registry(),
    logStore,
    emit: () => {},
    cwd: dir,
    model: { id: "x", openRouterSlug: "x", input: ["text"], output: ["text"] },
    tools: [tool],
    task: "read the note",
    systemPrompt: "s",
    userMessage: "go",
  });

  assert.deepEqual(ran, [{ path: file }], "the call ran once, with its original arguments");
  const results = result.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.some((m) => m.isError), false, "and was never refused");
  assert.ok(
    logStore.all().some((e) => (e.tags ?? []).includes("tools:framing-recovered")),
    "the repair is on the log, naming what arrived",
  );
  await fs.rm(dir, { recursive: true, force: true });
});
