/**
 * What the harness is willing to write from an authoring model's reply.
 *
 * The two-step mutation contract tells a second model "output ONLY the raw file
 * contents — no markdown code fences, no commentary". Models comply at very
 * different rates, and the harness has to be robust to that: it is meant to work
 * with whatever model a user prefers, not only the obedient ones.
 *
 * The old stripper matched exactly one shape — a perfectly balanced fence with
 * nothing around it — so every other shape was written into the user's source
 * verbatim. On a Dart file that produced a bare ``` in the middle of a widget
 * tree (a syntax error) plus stray blank lines, over four consecutive authored
 * edits, while the driver tried to repair a file the harness kept corrupting.
 *
 * Every "model emits" case below is a shape that used to survive into the file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isBlankLineDriftOnly,
  isFenceLine,
  sanitizeAuthoredText,
  stripAuthoredArtifacts,
  targetAllowsFences,
} from "../dist/tools/builtin/authored-output.js";

const dart = (raw) => stripAuthoredArtifacts(raw, { path: "lib/profile.dart" });

// ---- the shapes that used to get written into source ------------------------

test("a balanced fence is unwrapped", () => {
  assert.equal(dart("```dart\nfoo();\n```"), "foo();");
});

test("leading or trailing whitespace around the fence does not defeat it", () => {
  assert.equal(dart("\n```dart\nfoo();\n```"), "foo();");
  assert.equal(dart("```dart\nfoo();\n```\n\n"), "foo();");
});

test("narration around the block is discarded, not written", () => {
  assert.equal(dart("Here is the replacement:\n```dart\nfoo();\n```"), "foo();");
  assert.equal(dart("```dart\nfoo();\n```\nThat should do it."), "foo();");
});

test("an UNBALANCED fence is removed — the case no paired regex can catch", () => {
  // This is what actually corrupted the file: there is no matching partner to
  // anchor on, so a pair-matching regex leaves it in place.
  assert.equal(dart("foo();\n```"), "foo();");
  assert.equal(dart("```dart\nfoo();"), "foo();");
});

test("a tilde fence and a spaced info string are both handled", () => {
  assert.equal(dart("~~~dart\nfoo();\n~~~"), "foo();");
  assert.equal(dart("```dart \nfoo();\n```"), "foo();");
});

test("the exact corruption from the observed run is cleaned", () => {
  // Reproduced from the file the run left behind:
  //   1145  'Delete Account?',
  //   1146
  //   1147  ```
  //   1148  style: TextStyle(
  const wrecked = "                  'Delete Account?',\n\n```\n                  style: TextStyle(";
  assert.equal(
    dart(wrecked),
    "                  'Delete Account?',\n\n                  style: TextStyle(",
  );
});

test("removing a fence does not leave the blank line it sat on", () => {
  // The "extra blank space" half of the report: a fence alone between two blank
  // lines leaves them adjacent when removed.
  assert.equal(dart("a;\n\n```\n\nb;"), "a;\n\nb;");
  // But a blank line that was already there on its own is untouched.
  assert.equal(dart("a;\n\nb;"), "a;\n\nb;");
});

// ---- and what must NOT be touched ------------------------------------------

test("ordinary code is returned byte-for-byte", () => {
  const code = "void main() {\n  runApp(const App());\n}\n";
  assert.equal(dart(code), code);
});

test("a fence inside a doc comment survives", () => {
  // Written ` * ```ts`, so the line is not ONLY a fence marker.
  const doc = "/**\n * ```ts\n * foo()\n * ```\n */\nexport const x = 1;";
  assert.equal(stripAuthoredArtifacts(doc, { path: "a.ts" }), doc);
});

test("indentation and trailing newlines are preserved exactly", () => {
  const fragment = "    const a = 1;\n    const b = 2;\n";
  assert.equal(dart(fragment), fragment);
});

test("an empty reply stays empty, so the caller can report it honestly", () => {
  // `completeWithRetry` has real handling for an empty author reply — a retry,
  // then a specific error. What must never happen is an empty reply arriving as
  // something non-empty, because then it gets WRITTEN.
  assert.equal(dart(""), "");
  assert.equal(dart("   \n  "), "   \n  ");
  // An empty fenced block is an empty answer wearing a fence. Reducing it to ""
  // routes it into that same handling instead of writing "```dart" into a file.
  assert.equal(dart("```dart\n\n```"), "");
});

// ---- markdown, where a fence IS content ------------------------------------

test("markdown targets are recognised", () => {
  for (const p of ["README.md", "docs/a.MDX", "x.markdown"]) assert.equal(targetAllowsFences(p), true, p);
  for (const p of ["a.dart", "a.ts", "Makefile", undefined]) assert.equal(targetAllowsFences(p), false, String(p));
});

test("a README keeps its prose AND its example fences", () => {
  // The dangerous over-reach: unwrapping here would return just the example and
  // silently delete the surrounding documentation.
  const body = "intro\n\n```js\nx\n```\n\nmore";
  assert.equal(stripAuthoredArtifacts(body, { path: "README.md" }), body);
});

test("a README wrapped in an outer fence is still unwrapped", () => {
  assert.equal(
    stripAuthoredArtifacts("```markdown\n# Title\n\ntext\n```", { path: "README.md" }),
    "# Title\n\ntext",
  );
});

test("an unbalanced fence in markdown is left alone — it may be content", () => {
  const partial = "# Title\n\n```js\nunclosed";
  assert.equal(stripAuthoredArtifacts(partial, { path: "README.md" }), partial);
});

// ---- reporting -------------------------------------------------------------

test("the sanitizer reports what it removed", () => {
  const clean = sanitizeAuthoredText("foo();", { path: "a.dart" });
  assert.equal(clean.fencesRemoved, 0);
  assert.equal(clean.proseRemoved, false);

  const wrapped = sanitizeAuthoredText("Here you go:\n```dart\nfoo();\n```", { path: "a.dart" });
  assert.equal(wrapped.fencesRemoved, 2);
  assert.equal(wrapped.proseRemoved, true, "so a silent rewrite is never invisible");

  const stray = sanitizeAuthoredText("foo();\n```", { path: "a.dart" });
  assert.equal(stray.fencesRemoved, 1);
});

test("isFenceLine matches only whole-line markers", () => {
  assert.equal(isFenceLine("```"), true);
  assert.equal(isFenceLine("  ```dart  "), true);
  assert.equal(isFenceLine("~~~"), true);
  assert.equal(isFenceLine("````"), true);
  assert.equal(isFenceLine(" * ```ts"), false);
  assert.equal(isFenceLine("const s = '```';"), false);
  assert.equal(isFenceLine("```js const x = 1"), false, "an info string with spaces is not a bare fence");
});

// ---- blank-line drift ------------------------------------------------------

test("the draft wins when the author only added blank lines", () => {
  // Observed: asked to fix one line's indentation, the author returned the same
  // code with a blank line between unrelated properties — four edits in a row,
  // each adding another.
  const draft = "mainAxisSize: MainAxisSize.min,\ncrossAxisAlignment: CrossAxisAlignment.start,\nchildren: [";
  const drifted = "mainAxisSize: MainAxisSize.min,\n\ncrossAxisAlignment: CrossAxisAlignment.start,\n\nchildren: [";
  assert.equal(isBlankLineDriftOnly(drifted, draft), true);
});

test("real authoring work is never discarded as drift", () => {
  const draft = "const a = 1;";
  // A genuine change, even a one-character one, means the author contributed
  // something and its version must stand.
  assert.equal(isBlankLineDriftOnly("const a = 2;", draft), false);
  assert.equal(isBlankLineDriftOnly("const a = 1;\nconst b = 2;", draft), false);
  // Same text: nothing to choose between them.
  assert.equal(isBlankLineDriftOnly(draft, draft), false);
  // FEWER blank lines is the author tidying up, which is work — keep it.
  assert.equal(isBlankLineDriftOnly("a;\nb;", "a;\n\nb;"), false);
  // No draft to fall back to.
  assert.equal(isBlankLineDriftOnly("a;", ""), false);
});

// ---- language independence -------------------------------------------------
//
// The harness ships on its own and has to hold up on stacks this file has never
// heard of. Both heuristics below were measured wrong before they were general:
// a "does it contain code punctuation?" prose test DELETED real YAML and Go
// lines, and a blanket fence sweep CORRUPTED Python and Elixir docstrings.

test("content outside a fence is never discarded, whatever the language", () => {
  // `name: app` and `package main` carry no braces or semicolons. An earlier
  // version read them as English and deleted them.
  assert.equal(
    stripAuthoredArtifacts("name: app\n```yaml\nversion: 1\n```", { path: "a.yml" }),
    "name: app\nversion: 1",
  );
  assert.equal(
    stripAuthoredArtifacts("package main\n```go\nfunc main() {}\n```", { path: "a.go" }),
    "package main\nfunc main() {}",
  );
});

test("a balanced fence INSIDE a docstring is left alone", () => {
  // Python and Elixir both put fenced examples at column zero inside a doc
  // string. A language-blind sweep deleted them; parity is what saves them.
  const py = '"""\nExample:\n\n```\nfoo()\n```\n"""\nimport os';
  assert.equal(stripAuthoredArtifacts(py, { path: "a.py" }), py);
  const ex = '@doc """\n```\niex> foo()\n```\n"""\ndef foo, do: 1';
  assert.equal(stripAuthoredArtifacts(ex, { path: "a.ex" }), ex);
});

test("an UNBALANCED fence is still removed in those same languages", () => {
  // Parity protects real content without protecting the artifact.
  assert.equal(stripAuthoredArtifacts('import os\n```', { path: "a.py" }), "import os");
  assert.equal(stripAuthoredArtifacts('name: app\n```', { path: "a.yml" }), "name: app");
});

test("languages with no code punctuation survive untouched", () => {
  for (const [path, body] of [
    ["a.rb", 'def run\n  puts "hi"\nend'],
    ["a.sh", "echo hello\nls -la"],
    ["Dockerfile", "FROM node:20\nRUN npm ci"],
    ["a.sql", "SELECT id FROM users\nORDER BY id"],
  ]) {
    assert.equal(stripAuthoredArtifacts(body, { path }), body, path);
  }
});

test("narration is recognised by sentence shape, not by punctuation absence", () => {
  // Multi-word AND sentence-terminated. `dependencies:` is one word, so it is
  // never mistaken for narration even though it ends in a colon.
  assert.equal(
    stripAuthoredArtifacts("dependencies:\n```yaml\n  a: 1\n```", { path: "a.yml" }),
    "dependencies:\n  a: 1",
  );
  assert.equal(
    stripAuthoredArtifacts("Here is the updated file:\n```yaml\nname: app\n```", { path: "a.yml" }),
    "name: app",
  );
});
