/**
 * A file change made through the shell — and the run that "finished" in the read
 * hop because of one.
 *
 * The failure, from a field run asked to change a dialog title:
 *
 *   hop 0: read
 *   [tool:bash_readonly] python3 -c "
 *       with open('…/profile_screen.dart', 'r') as f: content = f.read()
 *       new_content = content.replace("title: 'Delete account?',", …)
 *       with open('…/profile_screen.dart', 'w') as f: f.write(new_content)"
 *   read nominated summarise  ("The change has been made from 'Delete account?' …")
 *   run completed: 1 categorizer hop(s) [read], 0 written
 *
 * Three separate things had to be wrong for that to happen, and each is fixed
 * and pinned here:
 *
 *   1. `bash_readonly` — whose own description promises "Blocks file writes" —
 *      checked for shell redirection, `tee` and `rm`/`mv`/`cp`, and an
 *      interpreter is none of those. `detectShellAuthoring` had understood that
 *      exact command for months; it was simply never asked.
 *   2. The chain's shell-authoring guard was applied to the two QA hops BY ID.
 *      The read hop was not on the list, so `bash` there could author too.
 *   3. Nothing recorded the change. `writtenPaths` was fed only by `write`/`edit`,
 *      so the run believed it had written nothing — which left the verify floor
 *      (keyed off written files) inert, and let a run that had already modified
 *      the user's code end with no build, no capture and no verdict.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODING_TOOLS,
  LogStore,
  PermissionGate,
  applyPolicyToRouted,
  createDefaultCategorizers,
  detectShellAuthoring,
  enforceNoDesktopOpen,
  enforceNoShellAuthoring,
  runToolLoop,
  shellAuthoringTarget,
} from "../dist/index.js";

const CATS = createDefaultCategorizers();
const cat = (id) => CATS.find((c) => c.id === id);

/** The command from the run, verbatim in shape. */
const PYTHON_WRITE = (target) => `python3 -c "
import re

with open('${target}', 'r') as f:
    content = f.read()

new_content = content.replace(\\"title: 'Delete account?',\\", \\"title: 'Delete Your Account',\\")

with open('${target}', 'w') as f:
    f.write(new_content)

print('File updated successfully')
"`;

const t = (name, over = {}) => ({
  name,
  description: `${name} does a thing`,
  parameters: { type: "object", properties: {} },
  async execute() {
    return { output: "ok" };
  },
  ...over,
});

// ---------------------------------------------------------------------------
// 1. bash_readonly is read-only, including through an interpreter
// ---------------------------------------------------------------------------

test("bash_readonly refuses a python one-liner that writes a source file", async () => {
  // A real project path, not a temp one: scratch targets are legitimately
  // exempt (see the scratch test below), so the case being pinned has to name
  // source. The guard runs before exec, so the file need not exist.
  const target = "/Users/dev/cards_mobile_app/lib/screens/profile/profile_screen.dart";
  const bashRo = CODING_TOOLS.find((x) => x.name === "bash_readonly");
  const res = await bashRo.execute("id", { command: PYTHON_WRITE(target) }, { cwd: "/Users/dev/cards_mobile_app", log: () => {} });

  assert.equal(res.isError, true, "the write must not run");
  assert.match(res.output, /WRITES/);
  assert.match(res.output, /python inline write/);
  // It says WHY this matters, not just that it is refused: an unrecorded change
  // is worse than a refused one.
  assert.match(res.output, /nothing downstream builds it, runs it or verifies it/);
  assert.match(res.output, /nominate `write_edit`/);
});

test("read-only inspection still works — the guard is about writing, not about python", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-author-"));
  await fs.writeFile(path.join(dir, "a.dart"), "one\ntwo\n");
  const bashRo = CODING_TOOLS.find((x) => x.name === "bash_readonly");
  const ok = async (command) => {
    const res = await bashRo.execute("id", { command }, { cwd: dir, log: () => {} });
    assert.notEqual(res.isError, true, `${command} must be allowed: ${res.output}`);
  };
  await ok("wc -l a.dart");
  await ok('grep -n "two" a.dart');
  await ok(`python3 -c "print(open('${path.join(dir, "a.dart")}').read())"`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the detector sees every shell surface, not just the one called bash", () => {
  const cmd = PYTHON_WRITE("/proj/lib/x.dart");
  assert.ok(detectShellAuthoring(cmd), "the detector itself always understood this command");
  assert.ok(shellAuthoringTarget("bash", { command: cmd }));
  assert.ok(shellAuthoringTarget("bash_readonly", { command: cmd }), "bash_readonly is a shell too");
  assert.ok(shellAuthoringTarget("mcp__shell__bash", { command: cmd }), "an MCP spelling counts");
  assert.equal(shellAuthoringTarget("read", { command: cmd }), null);
});

// ---------------------------------------------------------------------------
// 2. The guard follows the CAPABILITY, not a list of hop ids
// ---------------------------------------------------------------------------

test("a categorizer with no write/edit refuses shell authoring and points at write_edit", async () => {
  const tools = enforceNoShellAuthoring([t("bash"), t("bash_readonly")], "/proj", { instead: "handoff" });
  for (const name of ["bash", "bash_readonly"]) {
    const res = await tools
      .find((x) => x.name === name)
      .execute("id", { command: PYTHON_WRITE("/proj/lib/x.dart") }, { cwd: "/proj" });
    assert.equal(res.isError, true, name);
    assert.match(res.output, /does not author product code/);
    assert.match(res.output, /nominating `write_edit`/);
    assert.match(res.output, /the run reports having changed nothing/);
  }
});

test("the QA hops keep their own advice — run it and look", async () => {
  const tools = enforceNoShellAuthoring([t("bash")], "/proj", { instead: "observe" });
  const res = await tools[0].execute("id", { command: PYTHON_WRITE("/proj/lib/x.dart") }, { cwd: "/proj" });
  assert.equal(res.isError, true);
  assert.match(res.output, /What is missing from this pass is one observation/);
});

test("a scratch file outside the project is nobody's business", async () => {
  const tools = enforceNoShellAuthoring([t("bash")], "/proj", { instead: "handoff" });
  const res = await tools[0].execute(
    "id",
    { command: PYTHON_WRITE(path.join(os.tmpdir(), "scratch.py")) },
    { cwd: "/proj" },
  );
  assert.notEqual(res.isError, true, "temp scripts are fine");
});

// ---------------------------------------------------------------------------
// 3. Whatever gets through is still ON THE RECORD
// ---------------------------------------------------------------------------

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test("a shell-authored file counts as a write, so the run knows it must be verified", async () => {
  // The backstop. Every gate above stands down eventually — by design, because a
  // gate that can wedge a run is worse than the run — so the last line of
  // defence is that the change is RECORDED. `writtenPaths` is what the verify
  // floor, the freshness gate and the run's own report all read.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-author-"));
  // The path the COMMAND names decides what is recorded, and a temp path is
  // deliberately exempt from authoring detection — so this names source, the way
  // the field run did.
  const target = "/Users/dev/cards_mobile_app/lib/screens/profile/profile_screen.dart";

  // An unguarded bash (a host's own tool, or the gate having stood down).
  const rawBash = t("bash", {
    async execute() {
      return { output: "File updated successfully" };
    },
  });

  let turn = 0;
  const llm = {
    resolveModel: (slug) => ({ id: slug, openRouterSlug: slug }),
    complete: async (model) => ({
      role: "assistant", content: [{ type: "text", text: "ok" }], model: model.openRouterSlug,
      api: "openrouter", provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    }),
  };
  llm.stream = async function* (model) {
    const mk = (content, stopReason) => ({
      role: "assistant", content, model: model.openRouterSlug ?? model.id, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason, timestamp: 0,
    });
    yield { type: "start", partial: mk([], "stop") };
    turn += 1;
    if (turn === 1) {
      yield { type: "done", message: mk([{ type: "toolCall", id: "b1", name: "bash", arguments: { command: PYTHON_WRITE(target) } }], "tool_use") };
      return;
    }
    yield { type: "done", message: mk([{ type: "text", text: "the change has been made" }], "stop") };
  };

  const logStore = new LogStore();
  const res = await runToolLoop({
    task: "change the delete account popup title",
    userMessage: "go",
    tools: [rawBash],
    model: { id: "test/xs", openRouterSlug: "test/xs" },
    llm,
    permission: new PermissionGate("bypass"),
    logStore,
    emit: () => {},
    cwd: dir,
    phase: "read",
  });

  assert.deepEqual(res.writtenPaths, [target], "the shell write is on the record");
  const note = logStore.entries.find((e) => e.tags?.includes("loop:shell-write"));
  assert.ok(note, "and it is logged as the irregularity it is");
  assert.match(note.message, /counted as a write so the run verifies it/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("…which is what makes the verify floor fire on it", () => {
  // The end of the chain of consequences: a recorded write means `summarise` is
  // not available until something has looked at it. With `writtenPaths` empty —
  // the old behaviour — this run ended in the read hop.
  const hop = (id, index, writtenPaths = []) => ({
    id, index, summary: `${id} ran`, delivered: true, toolRecords: [], writtenPaths, readPaths: [],
  });
  const decision = applyPolicyToRouted(
    {
      choices: [cat("activity_reproduce"), cat("write_edit"), cat("activity_inspect")],
      hops: [hop("read", 0, ["/proj/lib/profile_screen.dart"])],
      queue: [],
      writtenPaths: ["/proj/lib/profile_screen.dart"],
    },
    "summarise",
    "read nominated summarise",
    false,
  );
  assert.equal(decision.selection, "activity_inspect");
  assert.match(decision.reason, /nothing has verified/);
});

// ---------------------------------------------------------------------------
// And the prompt says so too
// ---------------------------------------------------------------------------

test("the read prompt states the rule and the handoff", async () => {
  const { DEFAULT_CATEGORIZER_PROMPTS, buildCategorizerSystemPrompt } = await import("../dist/index.js");
  const p = buildCategorizerSystemPrompt({
    id: "read",
    systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.read,
    children: ["activity_reproduce", "write_edit"],
  });
  assert.match(p, /READ-ONLY IS ABSOLUTE, AND IT INCLUDES THE SHELL/);
  assert.match(p, /python3 -c/);
  assert.match(p, /CHANGE DESCRIPTION, not the change/);
  assert.match(p, /Never report a change as made/);
});

// ---------------------------------------------------------------------------
// The desktop-open guard — one page, one opener, and it is not the user's
// browser.
//
// From the field: the write pass ran `bash open index.html` "to verify" — the
// page popped in the user's desktop browser, captured nothing — and the verify
// pass then opened the SAME page again through `drive`, the harness's own
// browser. Opening, driving and capturing belongs to exactly one pass, and it
// is the one whose capture can reach `media_analysis`.
// ---------------------------------------------------------------------------

test("a work pass popping the page in the user's desktop browser is refused and pointed at deliver", async () => {
  const tools = enforceNoDesktopOpen([t("bash")], "write_edit");
  const res = await tools[0].execute("id", { command: "open /Users/x/Projects/Test/index.html" }, { cwd: "/proj" });
  assert.equal(res.isError, true);
  assert.match(res.output, /refused ONCE/);
  assert.match(res.output, /DESKTOP browser/);
  assert.match(res.output, /VERIFY pass's job/);
  assert.match(res.output, /`deliver`/);
  // One-shot: the re-issue goes through (anti-deadlock, house style).
  const retry = await tools[0].execute("id", { command: "open /Users/x/Projects/Test/index.html" }, { cwd: "/proj" });
  assert.equal(retry.isError, undefined);
  assert.equal(retry.output, "ok");
});

test("a QA pass popping the desktop browser is pointed at its OWN browser (drive)", async () => {
  const tools = enforceNoDesktopOpen([t("bash")], "activity_inspect");
  const res = await tools[0].execute("id", { command: "xdg-open http://localhost:5173" }, { cwd: "/proj" });
  assert.equal(res.isError, true);
  assert.match(res.output, /drive \{ action: "open", url \}/);
});

test("the detector matches the cd-chained shape and ignores `open` mid-command", async () => {
  const tools = enforceNoDesktopOpen([t("bash")], "write_edit");
  const chained = await tools[0].execute("id", { command: "cd /Users/x/Projects/Test && open index.html" }, { cwd: "/proj" });
  assert.equal(chained.isError, true, "cd … && open is still a desktop open");
  // Fresh wrapper (refused budget is per-hop): a command that merely CONTAINS
  // the word must not be refused.
  const tools2 = enforceNoDesktopOpen([t("bash")], "write_edit");
  const mid = await tools2[0].execute("id", { command: 'echo "open the file" && ls' }, { cwd: "/proj" });
  assert.equal(mid.isError, undefined, "`open` mid-command is not a desktop open");
});
