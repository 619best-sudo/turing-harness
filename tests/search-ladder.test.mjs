/**
 * The file-search ladder:
 *
 *   1. memory index first  — a shell search before memory was ever asked
 *   2. a better query      — memory found nothing; the query is the usual cause
 *   3. shell search        — only after ~3 empty memory queries (or a cold index)
 *
 * Memory is the fast path, but a sparse or brand-new project must never stop the
 * work — the ladder's job is to stop the GUESSING, then get out of the way.
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
  Registry,
  registerBuiltins,
  runToolLoop,
  SearchLadderAdvisor,
  isEmptyMemoryResult,
  isColdIndex,
  isDiscoveryCall,
  isShellSearchCall,
  FILE_SEARCH_LADDER,
} from "../dist/index.js";

const MEMORY_TOOLS = ["file_memory", "graph_memory", "project_memory", "read", "grep", "bash"];

/** A file_memory search call + its result text. */
function search(id, query, text) {
  return [
    [{ id, name: "file_memory", arguments: { action: "search", query } }],
    [{ toolCallId: id, isError: false, text }],
  ];
}

const EMPTY = "(no matching files)\nNext: retry with ONE distinctive term";

test("a shell search issued before memory gets pointed at the index, once", () => {
  const ladder = new SearchLadderAdvisor();
  const call = { id: "g1", name: "grep", arguments: { pattern: "AuthMiddleware", path: "." } };

  const [advice] = ladder.observe([call], [{ toolCallId: "g1", isError: false, text: "src/a.ts:1" }], MEMORY_TOOLS);
  assert.equal(advice.kind, "memory-first");
  assert.match(advice.note, /file_memory/);
  assert.ok(advice.note.includes("AuthMiddleware"), "the suggested query reuses the real search term");
  assert.match(advice.note, /blast_radius/, "and points at the graph for the rest of the change set");

  // Nagging is worse than useless: the note fires exactly once per loop.
  assert.deepEqual(ladder.observe([{ ...call, id: "g2" }], [{ toolCallId: "g2" }], MEMORY_TOOLS), []);
});

test("no memory tools, no memory-first note — the ladder never suggests what the run lacks", () => {
  const ladder = new SearchLadderAdvisor();
  const advice = ladder.observe(
    [{ id: "g1", name: "bash", arguments: { command: "grep -rn 'foo' src" } }],
    [{ toolCallId: "g1", isError: false, text: "" }],
    ["bash", "read"],
  );
  assert.deepEqual(advice, []);
});

test("empty memory queries earn better queries first, then the shell", () => {
  const ladder = new SearchLadderAdvisor();

  const first = ladder.observe(...search("s1", "the thing that handles auth", EMPTY), MEMORY_TOOLS);
  assert.equal(first[0].kind, "broaden");
  assert.match(first[0].note, /ONE distinctive term/);
  assert.match(first[0].note, /a default, not a gate/, "advice, not law");
  assert.equal(ladder.shellFallbackAuthorized, false);

  const second = ladder.observe(...search("s2", "auth", EMPTY), MEMORY_TOOLS);
  assert.equal(second[0].kind, "broaden");

  // Third empty query: memory is sparse here. Authorize the shell, concretely.
  const third = ladder.observe(...search("s3", "AuthGuard", EMPTY), MEMORY_TOOLS);
  assert.equal(third[0].kind, "shell-fallback");
  assert.equal(ladder.shellFallbackAuthorized, true);
  assert.match(third[0].note, /come back empty 3 times/);
  assert.ok(third[0].note.includes("AuthGuard"), "the recipe searches for what memory could not find");
  assert.match(third[0].note, /node_modules/, "and says what to skip");
  assert.match(third[0].note, /refresh/, "and sends the found path back into the index");

  // Having just been sent to the shell, using the shell is not a violation.
  assert.deepEqual(
    ladder.observe(
      [{ id: "g9", name: "grep", arguments: { pattern: "AuthGuard" } }],
      [{ toolCallId: "g9", isError: false, text: "hit" }],
      MEMORY_TOOLS,
    ),
    [],
  );
});

test("a memory query that finds something produces no advice at all", () => {
  const ladder = new SearchLadderAdvisor();
  const hit = "- src/auth/middleware.ts\n  Express auth middleware | role=middleware";
  assert.deepEqual(ladder.observe(...search("s1", "auth", hit), MEMORY_TOOLS), []);
  // And with memory already consulted, a follow-up shell sweep is legitimate.
  assert.deepEqual(
    ladder.observe(
      [{ id: "g1", name: "grep", arguments: { pattern: "requireAuth" } }],
      [{ toolCallId: "g1", isError: false, text: "hit" }],
      MEMORY_TOOLS,
    ),
    [],
  );
});

test("a cold index short-circuits straight to refresh-or-shell", () => {
  const ladder = new SearchLadderAdvisor();
  const [advice] = ladder.observe(
    [{ id: "s1", name: "file_memory", arguments: { action: "search", query: "auth" } }],
    [{ toolCallId: "s1", isError: false, text: "Indexed files: 0\nStale files: 0" }],
    MEMORY_TOOLS,
  );
  assert.equal(advice.kind, "shell-fallback");
  assert.match(advice.note, /EMPTY index/);
  assert.match(advice.note, /refresh/);
  assert.equal(ladder.shellFallbackAuthorized, true, "no point spending 3 queries on an empty index");
});

test("failed memory calls belong to the fallback advisor, not this one", () => {
  const ladder = new SearchLadderAdvisor();
  const advice = ladder.observe(
    [{ id: "s1", name: "file_memory", arguments: { action: "search" } }],
    [{ toolCallId: "s1", isError: true, text: "search requires `query`." }],
    MEMORY_TOOLS,
  );
  assert.deepEqual(advice, []);
});

test("classification: what counts as discovery, and what counts as a shell search", () => {
  assert.ok(isDiscoveryCall({ id: "1", name: "file_memory", arguments: { query: "x" } }));
  assert.ok(isDiscoveryCall({ id: "1", name: "graph_memory", arguments: { action: "blast_radius", path: "a" } }));
  // Re-indexing and health checks are not attempts to find something, so they
  // must not burn the memory budget.
  assert.ok(!isDiscoveryCall({ id: "1", name: "file_memory", arguments: { action: "refresh", paths: ["a"] } }));
  assert.ok(!isDiscoveryCall({ id: "1", name: "graph_memory", arguments: { action: "stats" } }));
  assert.ok(!isDiscoveryCall({ id: "1", name: "project_memory", arguments: { action: "get" } }));

  assert.ok(isShellSearchCall({ id: "1", name: "grep", arguments: { pattern: "x" } }));
  assert.ok(isShellSearchCall({ id: "1", name: "bash", arguments: { command: "find . -name '*.ts'" } }));
  assert.ok(isShellSearchCall({ id: "1", name: "bash_readonly", arguments: { command: "rg -n foo src" } }));
  assert.ok(!isShellSearchCall({ id: "1", name: "bash", arguments: { command: "npm test" } }));
  assert.ok(!isShellSearchCall({ id: "1", name: "read", arguments: { path: "a.ts" } }));
});

test("emptiness detection covers every way a memory tool says 'nothing here'", () => {
  assert.ok(isEmptyMemoryResult("(no matching files)"));
  assert.ok(isEmptyMemoryResult("(no matching symbols)"));
  assert.ok(isEmptyMemoryResult("(no entry for src/x.ts)"));
  assert.ok(isEmptyMemoryResult("(no matching file graph node)"));
  assert.ok(isEmptyMemoryResult("Matches: 0\nPreview:"));
  assert.ok(isEmptyMemoryResult(""));
  assert.ok(isEmptyMemoryResult(undefined));
  assert.ok(isEmptyMemoryResult("Target: a.ts\nState: fresh\nDirect dependencies: 0\nTransitive dependencies: 0"));

  assert.ok(!isEmptyMemoryResult("- src/a.ts\n  does a thing"));
  assert.ok(!isEmptyMemoryResult("Matches: 3\nPreview: foo, bar"));
  assert.ok(!isEmptyMemoryResult("Target: a.ts\nDirect dependencies: 2\nTransitive dependencies: 0"));

  assert.ok(isColdIndex("Indexed files: 0"));
  assert.ok(!isColdIndex("Indexed files: 412\nStale files: 0"));
});

test("the prompt states the same ladder the advisor suggests", () => {
  // Prompt and runtime must not drift: both name memory first, ~3 attempts, then
  // the shell — and both frame it as a default the model may override.
  assert.match(FILE_SEARCH_LADDER, /file_memory/);
  assert.match(FILE_SEARCH_LADDER, /graph_memory/);
  assert.match(FILE_SEARCH_LADDER, /3 empty memory queries/);
  assert.match(FILE_SEARCH_LADDER, /COLD/);
});

// --- integration: the ladder inside a real loop -----------------------------

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/** A stand-in file_memory whose index has nothing for this query. */
const emptyFileMemory = {
  name: "file_memory",
  description: "search the file index",
  parameters: { type: "object", properties: { action: { type: "string" }, query: { type: "string" } }, required: [] },
  mutates: false,
  async execute() {
    return { output: "(no matching files)" };
  },
};

test("a loop that greps first is told to use the index, then sent back to the shell once it is empty", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-ladder-"));
  await fs.writeFile(path.join(tmp, "a.ts"), "export const AuthGuard = 1;\n");

  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  const tools = [...registry.allTools(), emptyFileMemory];

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    // Turn 1 grabs the shell straight away; turns 2-4 query the empty index.
    if (turn === 1) {
      yield {
        type: "done",
        message: msg([{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "AuthGuard", path: tmp } }], "tool_use"),
      };
      return;
    }
    if (turn <= 4) {
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: `s${turn}`, name: "file_memory", arguments: { action: "search", query: `AuthGuard${turn}` } }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const result = await runToolLoop({
    task: "find AuthGuard",
    userMessage: "go",
    tools,
    model: { id: "x", openRouterSlug: "x" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
  });

  const injected = result.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? "")))
    .join("\n");

  assert.match(injected, /you searched the filesystem with `grep` without asking memory first/);
  assert.match(injected, /come back empty 3 times/, "and after 3 empty queries the shell is authorized");
  assert.ok(injected.indexOf("before asking memory") < injected.indexOf("come back empty"), "in ladder order");

  await fs.rm(tmp, { recursive: true, force: true });
});
