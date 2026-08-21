/**
 * Argument names the model uses versus the ones the schema declares.
 *
 * Across four consecutive runs a driver called `read` with `end`, `endLine`,
 * `end_line` and `start_line`. Every one was refused — correctly, since an
 * ignored window argument silently returns a different part of the file — and
 * every refusal cost a turn. The next run made the same call again, because the
 * refusal answered which NAMES exist ("read accepts: limit, offset, path") and
 * the mistake was not a name: the driver was thinking in a line RANGE while the
 * schema was an offset and a COUNT.
 *
 * Three layers, in order of how little they interpret:
 *
 *   1. The schema resolves spelling variants — `old_string` is `oldString`.
 *   2. A tool declares `argAliases` for exact synonyms of its own fields.
 *   3. Where the conversion is arithmetic rather than a rename, the tool declares
 *      the field and does the arithmetic — `read` now takes `endLine`.
 *
 * And when a name is corrected TWICE in one categorizer, the note stops repeating
 * itself and restates the whole signature.
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
  Registry,
  registerBuiltins,
  renameNote,
  resolveArgAliases,
  resolveToolAlias,
  suggestToolName,
  unknownArgumentKeys,
} from "../dist/index.js";

const reg = new Registry();
registerBuiltins(reg, { logStore: new LogStore() });
const tool = (name) => reg.getTool(name);
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));

test("the four spellings from the real runs all resolve", () => {
  for (const args of [
    { path: "/a", offset: 500, end: 560 },
    { path: "/a", offset: 500, endLine: 560 },
    { path: "/a", start_line: 500, end_line: 560 },
    { path: "/a", startLine: 500, endLine: 560 },
  ]) {
    const { args: fixed } = resolveArgAliases(tool("read"), args);
    assert.equal(sorted(fixed), sorted({ path: "/a", offset: 500, endLine: 560 }), JSON.stringify(args));
  }
});

test("spelling variants need no per-tool table — the schema decides", () => {
  assert.equal(
    sorted(resolveArgAliases(tool("edit"), { path: "/a", old_string: "x", new_string: "y" }).args),
    sorted({ path: "/a", oldString: "x", newString: "y" }),
  );
  assert.equal(resolveArgAliases(tool("edit"), { replace_all: true }).args.replaceAll, true);
  assert.equal(resolveArgAliases(tool("activity_collect"), { traceid: "t1" }).args.traceId, "t1");
  assert.equal(resolveArgAliases(tool("read"), { PATH: "/a" }).args.path, "/a");
});

test("declared synonyms across the tools a run actually leans on", () => {
  const cases = [
    ["grep", { query: "foo", dir: "/src", include: "*.dart" }, { pattern: "foo", path: "/src", glob: "*.dart" }],
    ["grep", { regex: "foo", filePattern: "*.ts" }, { pattern: "foo", glob: "*.ts" }],
    ["bash", { cmd: "ls -la" }, { command: "ls -la" }],
    ["bash", { script: "flutter test" }, { command: "flutter test" }],
    ["write", { filePath: "/a", contents: "x" }, { path: "/a", content: "x" }],
    ["edit", { file: "/a", old: "x", new: "y" }, { path: "/a", oldString: "x", newString: "y" }],
    ["edit", { path: "/a", find: "x", replacement: "y" }, { path: "/a", oldString: "x", newString: "y" }],
    ["add_log", { file: "/a", anchor: "x", newText: "y" }, { path: "/a", oldString: "x", newString: "y" }],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(sorted(resolveArgAliases(tool(name), args).args), sorted(expected), `${name} ${JSON.stringify(args)}`);
  }
});

test("what is NOT aliased, and why", () => {
  // A unit change is not a rename: reading `timeout: 30` as 30ms would kill the
  // command it was meant to allow.
  assert.deepEqual(resolveArgAliases(tool("bash"), { command: "x", timeout: 30 }).renamed, []);
  // `replace` depends on the VALUE's type — true means replaceAll, a string means
  // newString — so it is a guess, not a synonym.
  assert.deepEqual(resolveArgAliases(tool("edit"), { path: "/a", oldString: "x", replace: true }).renamed, []);
  // An unrelated key is left for unknown-key detection to report.
  assert.deepEqual(resolveArgAliases(tool("grep"), { pattern: "x", wibble: 1 }).renamed, []);
  // A rename never overwrites a field the model also sent under its real name.
  const both = resolveArgAliases(tool("read"), { path: "/a", offset: 1, startLine: 9 });
  assert.deepEqual(both.renamed, []);
  assert.equal(both.args.startLine, 9, "the stray key survives to be reported");
});

test("a resolved call no longer trips unknown-argument detection", () => {
  const raw = { path: "/a", offset: 500, end: 560 };
  assert.deepEqual(
    unknownArgumentKeys("read", tool("read").parameters, raw).map((u) => u.key),
    ["end"],
    "before: reported, and the call was refused",
  );
  const { args } = resolveArgAliases(tool("read"), raw);
  assert.deepEqual(unknownArgumentKeys("read", tool("read").parameters, args), [], "after: nothing to report");
});

test("read takes a range and converts it to a count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-range-"));
  const file = path.join(dir, "f.txt");
  await fs.writeFile(file, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"));
  const ctx = { cwd: dir, log: () => {} };
  const numbers = (res) =>
    (res.output ?? "")
      .split("\n")
      .filter((l) => /^\d+\t/.test(l))
      .map((l) => Number(l.split("\t")[0]));

  // The call that used to be refused.
  const range = await tool("read").execute("i", resolveArgAliases(tool("read"), { path: file, offset: 50, end: 55 }).args, ctx);
  assert.equal(range.isError ?? false, false);
  assert.deepEqual(numbers(range), [50, 51, 52, 53, 54, 55], "inclusive of both ends");

  // `limit` still means a count, and the two agree.
  const count = await tool("read").execute("i", { path: file, offset: 50, limit: 6 }, ctx);
  assert.deepEqual(numbers(count), numbers(range));

  // An endLine before the offset yields one line rather than an empty window.
  const inverted = await tool("read").execute("i", { path: file, offset: 50, endLine: 10 }, ctx);
  assert.deepEqual(numbers(inverted), [50]);

  // A name the schema still does not know is refused, as before — the point was
  // never to accept everything.
  const bogus = await tool("read").execute("i", { path: file, window: "50-55" }, ctx);
  assert.equal(bogus.isError, true);
  assert.match(bogus.output, /'endLine' \(the last line, inclusive\)/, "the refusal names the range form");

  await fs.rm(dir, { recursive: true, force: true });
});

test("the reminder escalates when saying it once did not work", () => {
  const first = renameNote("read", [{ from: "end", to: "endLine" }], false, tool("read").parameters);
  assert.match(first, /'end' → 'endLine' was applied and the call ran normally/);
  assert.ok(!/signature/.test(first), "the first correction stays short");

  const again = renameNote("read", [{ from: "end", to: "endLine" }], true, tool("read").parameters);
  assert.match(again, /more than once in this categorizer/);
  assert.match(again, /read\(\{ path: string, offset\?: number, limit\?: number, endLine\?: number \}\)/);

  const many = renameNote(
    "edit",
    [{ from: "old", to: "oldString" }, { from: "new", to: "newString" }],
    false,
    tool("edit").parameters,
  );
  assert.match(many, /does not have those arguments/);
  assert.match(many, /'old' → 'oldString'; 'new' → 'newString'/);
});

// ---------------------------------------------------------------------------
// The same problem one level up: the TOOL's name
// ---------------------------------------------------------------------------

/**
 * A run called `shell {command: "…"}` twice. `bash` was in its toolset the whole
 * time, and what came back was:
 *
 *     Unknown tool "shell". Did you mean "read"?
 *
 * — a suggestion from edit distance alone (four edits out of five characters),
 * and nonsense. Two turns gone, and the model then abandoned tools and wrote its
 * probes through `python3` heredocs instead.
 */
const KNOWN = ["bash", "read", "grep", "ls", "write", "edit", "add_log", "deliver"];

test("a tool name from another agent's vocabulary resolves to ours", () => {
  for (const [requested, expected] of [
    ["shell", "bash"],
    ["sh", "bash"],
    ["terminal", "bash"],
    ["exec", "bash"],
    ["run_command", "bash"],
    ["run-command", "bash"],
    ["RunCommand", "bash"],
    ["view", "read"],
    ["read_file", "read"],
    ["open_file", "read"],
    ["search", "grep"],
    ["ripgrep", "grep"],
    ["rg", "grep"],
    ["list_files", "ls"],
    ["write_file", "write"],
    ["create_file", "write"],
    ["edit_file", "edit"],
  ]) {
    assert.equal(resolveToolAlias(requested, KNOWN), expected, `${requested} → ${expected}`);
  }
});

test("only argument-compatible names are aliased", () => {
  // `apply_patch` carries a patch blob, not edit's anchor and replacement, so
  // renaming it would move the failure one step later instead of fixing it.
  assert.equal(resolveToolAlias("apply_patch", KNOWN), undefined);
  assert.equal(resolveToolAlias("wibble", KNOWN), undefined);
  // An alias for a tool this categorizer was not given is not a resolution.
  assert.equal(resolveToolAlias("shell", ["read", "grep"]), undefined);
  // A namespaced MCP twin is still the tool.
  assert.equal(resolveToolAlias("shell", ["chrome__bash", "read"]), "chrome__bash");
});

test("the suggester no longer offers a different word as a typo", () => {
  // Four edits out of five characters is not a typo. Long names keep the
  // generous budget; short ones do not.
  assert.notEqual(suggestToolName("shell", KNOWN), "read");
  // Real typos still resolve.
  assert.equal(suggestToolName("reed", KNOWN), "read");
  assert.equal(suggestToolName("grepp", KNOWN), "grep");
  assert.equal(suggestToolName("add_logs", KNOWN), "add_log");
});
