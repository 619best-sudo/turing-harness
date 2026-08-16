/**
 * "Did you mean" suggestions for unknown tool calls.
 *
 * The model sometimes calls a tool name that is not registered — most often the
 * MCP SERVER's name (`playwright`) rather than the server's tool names
 * (`browser_navigate`, etc.), because the function-calling list is the only
 * channel that carries tool names. These tests pin the suggestion logic and the
 * loop-level recovery: the unknown-tool error must surface the closest real
 * name and the available roster so the model can re-issue the call instead of
 * guessing for a turn.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  levenshtein,
  suggestToolName,
  unknownToolMessage,
  unknownArgumentKeys,
  unknownArgumentMessage,
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  runToolLoop,
} from "../dist/index.js";

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

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

test("levenshtein: identical strings are distance 0", () => {
  assert.equal(levenshtein("read", "read"), 0);
});

test("levenshtein: a single-character typo is distance 1", () => {
  assert.equal(levenshtein("read", "raed"), 2);
  assert.equal(levenshtein("grep", "grpe"), 2);
});

test("levenshtein: the max bound short-circuits wildly-unrelated strings", () => {
  // Without a bound this is 16; with max=4 it bails to Infinity.
  assert.equal(levenshtein("aaaaaaaaaaaaaaaa", "zzzzzzzzzzzzzzzz", 4), Infinity);
});

// ---------------------------------------------------------------------------
// suggestToolName — typos
// ---------------------------------------------------------------------------

test("suggestToolName: a typo of a real tool suggests the real name", () => {
  const known = ["read", "write", "edit", "grep", "bash"];
  assert.equal(suggestToolName("rdit", known), "edit");
});

test("suggestToolName: an exact (case-insensitive) match returns no suggestion", () => {
  // The unknown-tool branch is only reached when no tool matched, so an exact
  // match would never be suggested in practice — but the contract must not
  // propose the very name that was just rejected.
  assert.equal(suggestToolName("READ", ["read", "write"]), undefined);
});

// ---------------------------------------------------------------------------
// suggestToolName — MCP server-name confusion (the observed failure)
// ---------------------------------------------------------------------------

test("suggestToolName: 'playwright' reaches for a browser tool by shared token", () => {
  // The real failure from the DB: the model called `playwright` against a set
  // of Playwright MCP tools. Pure edit-distance would never match (the strings
  // are too different in length); the shared-token / substring path is what
  // surfaces a browser tool.
  const known = [
    "browser_navigate", "browser_take_screenshot", "browser_find",
    "read", "write", "edit", "bash",
  ];
  const suggestion = suggestToolName("playwright", known);
  // `playwright` shares no >=4-char token with any of these, and is not a
  // substring of any — so there is genuinely no close match. This is the honest
  // result: the suggestion cannot rescue a pure server-name reach, and the
  // roster in the message (tested below) is what does.
  assert.equal(suggestion, undefined);
});

test("suggestToolName: 'browser' reaches for a browser tool by shared token", () => {
  // A category reach that DOES share a token (`browser` → `browser_navigate`).
  const known = [
    "browser_navigate", "browser_take_screenshot", "browser_find",
    "read", "write", "edit", "bash",
  ];
  const suggestion = suggestToolName("browser", known);
  assert.ok(suggestion, "a shared-token reach yields a suggestion");
  assert.match(suggestion, /^browser_/);
});

test("suggestToolName: a namespaced MCP name is suggested from the server prefix", () => {
  // `mcp__playwright__browser_navigate` contains `playwright` as a substring,
  // so `playwright` should reach it.
  const known = ["read", "write", "mcp__playwright__browser_navigate"];
  assert.equal(suggestToolName("playwright", known), "mcp__playwright__browser_navigate");
});

// ---------------------------------------------------------------------------
// unknownToolMessage — the model-facing recovery payload
// ---------------------------------------------------------------------------

test("unknownToolMessage: leads with the suggestion when one exists", () => {
  const msg = unknownToolMessage("rdit", ["read", "write", "edit"]);
  assert.match(msg, /Did you mean "edit"\?/);
  assert.match(msg, /Available tools:/);
  assert.match(msg, /Do not repeat the "rdit" call/);
});

test("unknownToolMessage: lists the available tools even with no close match", () => {
  // The `playwright` case: no suggestion, but the roster tells the model the
  // real names so it can pick `browser_navigate` and re-issue.
  const msg = unknownToolMessage("playwright", [
    "browser_navigate", "browser_take_screenshot", "browser_find", "read", "write",
  ]);
  assert.doesNotMatch(msg, /Did you mean/);
  assert.match(msg, /Available tools:.*browser_navigate/);
  assert.match(msg, /browser_take_screenshot/);
  assert.match(msg, /Do not repeat the "playwright" call/);
});

test("unknownToolMessage: caps a very large roster", () => {
  const known = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
  const msg = unknownToolMessage("nope", known);
  assert.match(msg, /\.\.\. \(.*more\)/);
});

// ---------------------------------------------------------------------------
// End-to-end: the loop surfaces the suggestion to the model
// ---------------------------------------------------------------------------

test("the loop returns a did-you-mean + roster when the model calls an unknown tool", async () => {
  let captured = null;
  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      // The model reaches for a tool name that is not registered.
      yield {
        type: "done",
        message: msg([{ type: "toolCall", id: "u1", name: "rdit", arguments: {} }], "tool_use"),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };
  llm.complete = async () => msg([{ type: "text", text: "ok" }]);

  const realRead = {
    name: "read",
    description: "read a file",
    parameters: { type: "object", properties: {} },
    mutates: false,
    async execute() {
      return { output: "file contents" };
    },
  };

  await runToolLoop({
    task: "do something",
    userMessage: "go",
    tools: [realRead, { name: "write", description: "write a file", parameters: { type: "object", properties: {} }, mutates: true, async execute() { return { output: "wrote" }; } }],
    model: { id: "test/driver", openRouterSlug: "test/driver" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: process.cwd(),
  }).then((result) => {
    // The unknown-tool result is in the message history; find it.
    const toolResults = result.messages.filter((m) => m.role === "toolResult");
    captured = toolResults.map((m) =>
      (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
    );
  });

  const unknownResult = captured.find((t) => t.includes("Unknown tool"));
  assert.ok(unknownResult, "the unknown-tool call produced a tool result");
  assert.match(unknownResult, /Did you mean "read"\?/, "the suggestion reaches the model");
  assert.match(unknownResult, /Available tools:/, "the roster reaches the model");
});

// ===========================================================================
// Unknown ARGUMENT keys — hallucinated / typo'd / cross-tool-conflated fields.
//
// The harness validated that required fields are present, but never that the
// fields the model SENT are real — so a fabricated property, a typo
// (`comand`), or a mix of two tools' fields was accepted silently. These pin
// the detection + the non-blocking warning that tells the model what the tool
// actually accepts.
// ===========================================================================

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string" },
    timeoutMs: { type: "number" },
    background: { type: "boolean" },
  },
  required: ["command"],
};

test("unknownArgumentKeys: a fabricated field is flagged", () => {
  // The model invented `timeout` (real field is `timeoutMs`).
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { command: "ls", timeout: 5000 });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].key, "timeout");
  assert.equal(unknown[0].suggestion, "timeoutMs", "the typo suggestion names the real field");
});

test("unknownArgumentKeys: a pure typo gets the closest real field", () => {
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { comand: "ls" });
  assert.equal(unknown[0].suggestion, "command");
});

test("unknownArgumentKeys: cross-tool conflation flags the foreign field", () => {
  // `bash({url, command})` — `url` is a browser-tool field, not bash's.
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { command: "curl", url: "http://x" });
  assert.deepEqual(unknown.map((u) => u.key), ["url"]);
});

test("unknownArgumentKeys: declared fields produce nothing", () => {
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { command: "ls", background: true });
  assert.equal(unknown.length, 0);
});

test("unknownArgumentKeys: runner-reserved keys (complexity/category/verify) are not flagged", () => {
  // These are harness-level signals read off call.arguments, not schema fields.
  // A self-rating on write/edit must not be flagged as a hallucination.
  const writeSchema = { type: "object", properties: { path: {}, content: {} }, required: ["path", "content"] };
  const unknown = unknownArgumentKeys(
    "write",
    writeSchema,
    { path: "f.ts", content: "x", complexity: "low", category: "code", verify: {} },
  );
  assert.equal(unknown.length, 0, "complexity/category/verify are reserved and never flagged");
});

test("unknownArgumentKeys: an unrelated field alongside reserved keys IS flagged", () => {
  // Reserved keys are excluded, but a genuine hallucination still gets caught.
  const writeSchema = { type: "object", properties: { path: {}, content: {} }, required: ["path", "content"] };
  const unknown = unknownArgumentKeys("write", writeSchema, { path: "f.ts", content: "x", complexity: "low", mode: "strict" });
  assert.deepEqual(unknown.map((u) => u.key), ["mode"]);
});

// ---------------------------------------------------------------------------
// Author-only mode: edit/write schemas deliberately OMIT newString/content (the
// authoring model writes the bytes), but the model may send them anyway. Those
// fields must NOT be flagged — the "re-issue the call" warning they produced
// was traced (in the OpenWaggleMain run DB) to the model re-issuing an IDENTICAL
// edit, which then failed "oldString not found" because the first one applied.
// ---------------------------------------------------------------------------

const EDIT_AUTHOR_ONLY_SCHEMA = {
  // Mirror of createEditTool(true): newString is intentionally absent.
  type: "object",
  properties: { path: {}, oldString: {}, complexity: {}, category: {}, images: {}, replaceAll: {} },
  required: ["path", "oldString"],
};
const WRITE_AUTHOR_ONLY_SCHEMA = {
  // Mirror of createWriteTool(true): content is intentionally absent.
  type: "object",
  properties: { path: {}, complexity: {}, category: {}, images: {} },
  required: ["path"],
};

test("unknownArgumentKeys: edit 'newString' under author-only schema is NOT flagged (regression: double-edit)", () => {
  const unknown = unknownArgumentKeys("edit", EDIT_AUTHOR_ONLY_SCHEMA, {
    path: "index.html", oldString: "<title>x</title>", newString: "<title>Home</title>",
    complexity: "low", category: "code",
  });
  assert.equal(unknown.length, 0, "newString is an authoring field the schema omits on purpose; flagging it made the model re-issue the same edit");
});

test("unknownArgumentKeys: write 'content' under author-only schema is NOT flagged", () => {
  const unknown = unknownArgumentKeys("write", WRITE_AUTHOR_ONLY_SCHEMA, {
    path: "f.ts", content: "export const x = 1;", complexity: "low", category: "code",
  });
  assert.equal(unknown.length, 0);
});

test("unknownArgumentKeys: a genuinely-unknown field on edit IS still flagged (exemption is narrow)", () => {
  // newString is exempt; a real hallucination (`mode`) is still caught.
  const unknown = unknownArgumentKeys("edit", EDIT_AUTHOR_ONLY_SCHEMA, {
    path: "f.ts", oldString: "x", newString: "y", mode: "strict",
  });
  assert.deepEqual(unknown.map((u) => u.key), ["mode"]);
});

test("unknownArgumentKeys: newString on a NON-edit tool IS still flagged (exemption is per-tool)", () => {
  // newString is only ever valid for edit; on bash it is a hallucination.
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { command: "ls", newString: "y" });
  assert.deepEqual(unknown.map((u) => u.key), ["newString"]);
});

test("unknownArgumentMessage: names the key, suggests the fix, lists accepted fields", () => {
  const unknown = unknownArgumentKeys("bash", BASH_SCHEMA, { comand: "ls" });
  const msg = unknownArgumentMessage("bash", BASH_SCHEMA, unknown);
  assert.match(msg, /'comand' is not recognised — did you mean 'command'\?/);
  assert.match(msg, /bash accepts: background, command, timeoutMs/);
  assert.match(msg, /Re-issue the call with only the fields listed above/);
});

test("unknownArgumentMessage: a pure fabrication (no close typo) says so plainly", () => {
  const unknown = [{ key: "random_flag" }];
  const msg = unknownArgumentMessage("bash", BASH_SCHEMA, unknown);
  assert.match(msg, /'random_flag' is not a field this tool accepts/);
  assert.doesNotMatch(msg, /did you mean/);
});

test("the loop appends an unknown-arg warning to the result WITHOUT blocking the call", async () => {
  // The call must still execute (non-blocking), and the result must carry the
  // warning so the model learns the schema. This is the contract that keeps
  // legitimate lenient calls working while surfacing hallucinations.
  let executed = false;
  let captured = null;
  const bash = {
    name: "bash",
    description: "run a command",
    parameters: BASH_SCHEMA,
    mutates: true,
    async execute(_id, args) {
      executed = true;
      return { output: `ran: ${args.command ?? "(none)"}` };
    },
  };
  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      // The model passes the real required field (`command`) PLUS a typo'd
      // duplicate (`comand`) and a foreign field (`url`). The required-field
      // check passes, the call runs, and the unknown-arg warning appends.
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls", comand: "ls", url: "http://x" } }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  const result = await runToolLoop({
    task: "do something",
    userMessage: "go",
    tools: [bash],
    model: { id: "test/driver", openRouterSlug: "test/driver" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: process.cwd(),
  });

  assert.equal(executed, true, "the call still ran (non-blocking)");
  const tr = result.messages.find((m) => m.role === "toolResult");
  captured = (tr?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.match(captured, /ran: ls/, "the tool's own output is present (the real `command` ran)");
  assert.match(captured, /'comand' is not recognised — did you mean 'command'\?/, "the typo warning reached the model");
  assert.match(captured, /'url' is not a field this tool accepts/, "the foreign-field warning reached the model");
  assert.match(captured, /bash accepts:/, "the accepted-fields list reached the model");
});

