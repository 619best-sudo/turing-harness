/**
 * Unit tests for the 4P harness handoff, tool guards, and presets.
 *
 * Run via: npm test (which builds first, then runs `node --test`).
 *
 * Coverage:
 *   - Tool-arg guards firing for empty/required args
 *   - Phase prompts containing the discipline/efficiency rules we shipped
 *   - Project presets having the right phase-tool policy
 *   - PHASE_DEFAULT_TOOLS complete
 *   - Integration: handoff opening message shape when running through
 *     Orchestrator with a stub LLM (no network)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PHASE_PROMPTS,
  PHASE_DEFAULT_TOOLS,
  DEFAULT_PHASE_MODELS,
  PROJECT_PRESETS,
  resolveModel,
  selectModel,
  Harness,
  Orchestrator,
  PermissionGate,
  OpenRouterBridge,
  LogStore,
  Registry,
  registerBuiltins,
  parseConcernLines,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Build a Registry with the built-in coding tools registered. */
function newRegistryWithBuiltins() {
  const reg = new Registry();
  const logStore = new LogStore();
  registerBuiltins(reg, { logStore });
  return reg;
}

/**
 * Stub LLM: first call (initial user turn) emits ONE tool call to a real
 * file. Prepare/Plan/Perfect emit `read`; Perform emits `write` so we can
 * verify ALREADY WRITTEN propagates to the next iteration. Subsequent turns
 * emit a text-only assistant message. The first user message of every call
 * is captured so the handoff can be asserted on.
 */
function makeStubLlm({ projectFile }) {
  const llm = new OpenRouterBridge();
  const openings = [];
  llm.stream = async function* (_model, ctx, _opts) {
    const opening = ctx.messages?.[0]?.content ?? "";
    openings.push(opening);
    const sys = ctx.systemPrompt ?? "";
    const isPrepare = /PREPARE phase/.test(sys);
    const isPlan = /PLAN phase/.test(sys);
    const isPerform = /PERFORM phase/.test(ctx.systemPrompt ?? "");
    const isPerfect = /PERFECT phase/.test(sys);
    if (ctx.messages.length === 1) {
      yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
      const toolName = isPerform ? "write" : "read";
      const args = isPerform ? { path: projectFile, content: "<h1>x</h1>" } : { path: projectFile };
      yield { type: "toolCall_delta", toolCallId: "t1", delta: { name: toolName } };
      yield { type: "toolCall_delta", toolCallId: "t1", delta: { arguments: JSON.stringify(args) } };
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: toolName, arguments: args }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: isPrepare
            ? [
                "CATEGORY: frontend",
                "PROJECT: static HTML site (no package.json) -> static file server",
                "RUN: python3 -m http.server 8080",
                "STOP: pkill -f \"http.server 8080\"",
                "VERIFY: browser MCP at http://127.0.0.1:8080",
                "CAPABILITIES:",
                "- browser MCP: verify rendered pages",
                "PROVIDER ASSIGNMENTS:",
                "PLAN => builtin:project_memory",
                "PERFORM => builtin:assets_generator",
                "PERFECT => builtin:media_analysis",
                "FILE SEARCH:",
                `${projectFile} | complexity=medium | why=Primary task file | blast=files=${projectFile}; notes=entrypoint`,
                "TOOL TRANSCRIPT:",
                `read | target=${projectFile} | summary=Read the primary task file`,
                "MEMORY UPDATES:",
                "none",
                "FILE MEMORY UPDATES:",
                "none",
                "SUMMARY: prepared the focused file shortlist",
              ].join("\n")
            : isPlan
              ? "PLAN: 1. inspect the focused file shortlist\nACCEPTANCE: file shortlist is reused"
              : isPerform
                ? "CHANGES: none"
                : isPerfect
                  ? "VERDICT: PASS"
                  : "SUMMARY: done",
        }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };
  return { llm, openings };
}

/**
 * Scriptable stub: `script` is an array of turns. Each turn is either
 * `{ tool, args }` (emit one tool call) or `{ text }` (emit a final text
 * message). Turns are consumed in order; once exhausted a default text turn
 * ends the phase. Used to drive a single phase deterministically.
 */
function makeScriptedLlm(script) {
  const llm = new OpenRouterBridge();
  let i = 0;
  llm.stream = async function* (_model, _ctx, _opts) {
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    const turn = script[i++] ?? { text: "SUMMARY: done\nVERDICT: PASS" };
    if (turn.tool) {
      const id = `t${i}`;
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id, name: turn.tool, arguments: turn.args ?? {} }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: turn.text ?? "SUMMARY: done" }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };
  return llm;
}

function newOrch(cwd, llm) {
  return new Orchestrator({
    cwd,
    llm,
    registry: newRegistryWithBuiltins(),
    permission: new PermissionGate("allow-all"),
    logStore: new LogStore(),
  });
}

function newOrchWithFakeMemoryTools(cwd, llm, counters) {
  const registry = newRegistryWithBuiltins();
  registry.add({
    id: "test:memory",
    kind: "tool",
    source: "internal",
    name: "memory_test",
    tools: [
      {
        name: "file_memory",
        description: "Fake file memory refresh tool for tests.",
        mutates: false,
        phases: ["prepare", "plan", "perform", "perfect"],
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
            path: { type: "string" },
          },
          required: ["action", "path"],
        },
        async execute() {
          counters.file += 1;
          return { output: "file_memory refreshed" };
        },
      },
      {
        name: "graph_memory",
        description: "Fake graph memory refresh tool for tests.",
        mutates: false,
        phases: ["prepare", "plan", "perform", "perfect"],
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
            path: { type: "string" },
          },
          required: ["action", "path"],
        },
        async execute() {
          counters.graph += 1;
          return { output: "graph_memory refreshed" };
        },
      },
    ],
  });
  return new Orchestrator({
    cwd,
    llm,
    registry,
    permission: new PermissionGate("allow-all"),
    logStore: new LogStore(),
  });
}

// ---------------------------------------------------------------------------
// Runner-level tool-call hardening + success-only handover
// ---------------------------------------------------------------------------

test("runner rejects empty-arg bash before execution in perform (no exec, self-correctable)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const orch = newOrch(tmp, makeScriptedLlm([{ tool: "bash", args: {} }, { text: "SUMMARY: done" }]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });
  const r = await orch.runPhase("perform", "noop");
  assert.equal(ends.length, 1, "the empty bash call is surfaced as one execution end");
  assert.equal(ends[0].isError, true, "empty bash is rejected as an error");
  // A rejected call must not contribute a discovered/written path.
  assert.equal(r.discoveredPaths, undefined);
  assert.equal(r.writtenPaths, undefined);
});

test("runner rejects bash({timeoutMs}) with missing command in perform", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const orch = newOrch(tmp, makeScriptedLlm([{ tool: "bash", args: { timeoutMs: 120000 } }, { text: "done" }]));
  const texts = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") texts.push(JSON.stringify(e.result)); });
  await orch.runPhase("perform", "noop");
  assert.match(texts.join(""), /missing required argument 'command'/);
});

test("edit with empty newString (deletion) is not rejected as a missing argument", async () => {
  // An empty string is a legitimate, intentional value (here: delete the
  // matched span). The required-arg gate must treat only absent (undefined/
  // null) values as missing, not empty strings — otherwise every deletion is
  // wrongly blocked with "edit: missing required argument 'newString'".
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "deleteme.txt");
  await fs.writeFile(file, "keep\nREMOVE-ME\nkeep\n");
  const orch = newOrch(
    tmp,
    makeScriptedLlm([
      { tool: "edit", args: { path: file, oldString: "REMOVE-ME\n", newString: "" } },
      { text: "SUMMARY: done" },
    ]),
  );
  const ends = [];
  orch.subscribe((e) => {
    if (e.type === "tool_execution_end") ends.push(e);
  });
  await orch.runPhase("perform", "noop");
  const editEnd = ends.find((e) => e.toolName === "edit");
  assert.ok(editEnd, "the edit call should have executed");
  assert.equal(editEnd.isError, false, "an empty newString (deletion) must not be treated as a missing argument");
  const after = await fs.readFile(file, "utf8");
  assert.equal(after, "keep\nkeep\n", "the matched span was deleted");
});

test("edit with a genuinely absent oldString is still rejected", async () => {
  // Only ABSENT required args (undefined/null) are "missing". The model
  // omitting oldString entirely is a real error the gate must still catch.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "x.txt");
  await fs.writeFile(file, "hi");
  const orch = newOrch(
    tmp,
    makeScriptedLlm([
      { tool: "edit", args: { path: file, newString: "bye" } },
      { text: "done" },
    ]),
  );
  const texts = [];
  orch.subscribe((e) => {
    if (e.type === "tool_execution_end") texts.push(JSON.stringify(e.result));
  });
  await orch.runPhase("perform", "noop");
  assert.match(texts.join(""), /missing required argument 'oldString'/);
});

test("successful read populates readPaths handover; not writtenPaths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "a.txt");
  await fs.writeFile(file, "hello");
  const orch = newOrch(tmp, makeScriptedLlm([{ tool: "read", args: { path: file } }, { text: "SUMMARY: done" }]));
  const r = await orch.runPhase("prepare", "noop");
  assert.ok(r.readPaths?.includes(file), "read path should be in readPaths");
  assert.ok(r.discoveredPaths?.includes(file), "read path should be in discoveredPaths");
  assert.equal(r.writtenPaths, undefined, "a read must not appear as written");
});

test("successful read does not trigger file_memory or graph_memory refresh", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "readme.txt");
  await fs.writeFile(file, "hello");
  const counters = { file: 0, graph: 0 };
  const orch = newOrchWithFakeMemoryTools(
    tmp,
    makeScriptedLlm([{ tool: "read", args: { path: file } }, { text: "SUMMARY: done" }]),
    counters,
  );
  await orch.runPhase("prepare", "noop");
  assert.equal(counters.file, 0, "read should not refresh file_memory");
  assert.equal(counters.graph, 0, "read should not refresh graph_memory");
});

test("successful edit does not trigger file_memory or graph_memory refresh", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "editme.txt");
  await fs.writeFile(file, "before");
  const counters = { file: 0, graph: 0 };
  const orch = newOrchWithFakeMemoryTools(
    tmp,
    makeScriptedLlm([
      { tool: "edit", args: { path: file, oldString: "before", newString: "after" } },
      { text: "SUMMARY: done" },
    ]),
    counters,
  );
  await orch.runPhase("perform", "noop");
  assert.equal(counters.file, 0, "edit should not refresh file_memory");
  assert.equal(counters.graph, 0, "edit should not refresh graph_memory");
});

test("write surfaces unified diff metadata for transcript UIs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "notes.txt");
  await fs.writeFile(file, "alpha\nbeta\n", "utf8");
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "write", args: { path: file, content: "alpha\ngamma\n" } },
    { text: "CHANGES: updated notes" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });

  await orch.runPhase("perform", "update the notes file");

  const writeEnd = ends.find((e) => e.toolName === "write");
  assert.ok(writeEnd, "write result should be surfaced");
  assert.equal(writeEnd.isError, false);
  assert.match(String(writeEnd.result?.details?.diff ?? ""), /-beta/);
  assert.match(String(writeEnd.result?.details?.diff ?? ""), /\+gamma/);
  assert.equal(writeEnd.result?.details?.additions, 1);
  assert.equal(writeEnd.result?.details?.deletions, 1);
  assert.equal(writeEnd.result?.content?.[0]?.text, `Wrote ${file}`);
});

test("edit surfaces unified diff metadata for transcript UIs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "editme.txt");
  await fs.writeFile(file, "before\nline two\n", "utf8");
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "edit", args: { path: file, oldString: "before", newString: "after" } },
    { text: "CHANGES: edited file" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });

  await orch.runPhase("perform", "edit the file");

  const editEnd = ends.find((e) => e.toolName === "edit");
  assert.ok(editEnd, "edit result should be surfaced");
  assert.equal(editEnd.isError, false);
  assert.match(String(editEnd.result?.details?.diff ?? ""), /-before/);
  assert.match(String(editEnd.result?.details?.diff ?? ""), /\+after/);
  assert.equal(editEnd.result?.details?.additions, 1);
  assert.equal(editEnd.result?.details?.deletions, 1);
  assert.match(String(editEnd.result?.content?.[0]?.text ?? ""), /Edited /);
});

test("failed mutation does NOT pollute writtenPaths (success-only handover)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const ghost = path.join(tmp, "does-not-exist.txt");
  // edit on a nonexistent file fails → must not be recorded as written.
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "edit", args: { path: ghost, oldString: "a", newString: "b" } },
    { text: "CHANGES: none" },
  ]));
  const r = await orch.runPhase("perform", "noop");
  assert.ok(!(r.writtenPaths ?? []).includes(ghost), "failed edit must not be in writtenPaths");
});

test("a generated asset (details.uri) reaches writtenPaths and the summary covers it", async () => {
  // The gap this closes: assets_generator writes its file and reports the path as
  // details.uri, but it is neither in MUTATING_TOOLS nor does it take a file_path
  // argument — so the loop's arg-based path capture never saw it, the generated
  // asset was missing from writtenPaths, and the run summary (the only context the
  // next prompt on the thread receives) dropped every generation the run did.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const generated = path.join(tmp, "assets", "hero.png");

  // Registry with a fake generation tool that mimics assets_generator's result
  // shape: details.uri = the written file, plus mimeType + summary. The capture
  // logic keys on details.uri (tool-name-agnostic), so a distinct name still
  // proves the fix without colliding with the real builtin.
  const registry = newRegistryWithBuiltins();
  registry.add({
    id: "test:assets",
    kind: "tool",
    source: "internal",
    name: "assets_test",
    tools: [{
      name: "fake_generator",
      description: "Fake generator for the writtenPaths test (mimics assets_generator result shape).",
      mutates: true,
      phases: ["perform", "perfect"],
      parameters: { type: "object", properties: { kind: { type: "string" }, prompt: { type: "string" } }, required: ["prompt"] },
      async execute() {
        return {
          output: `Generated image → ${generated}`,
          details: { uri: generated, mimeType: "image/png", size: 1234, summary: "Generated image for: hero" },
          content: [],
        };
      },
    }],
  });
  const llm = new OpenRouterBridge();
  let summaryPrompt = "";
  llm.stream = async function* (_model, ctx) {
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (ctx.messages.length === 1) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "fake_generator", arguments: { kind: "image", prompt: "hero" } }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CHANGES: generated the hero image" }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };
  // Capture the summary turn's user prompt (the second complete() call).
  llm.complete = async (_model, ctx) => {
    const content = ctx.messages?.[0]?.content ?? "";
    if (typeof content === "string") summaryPrompt = content;
    return { role: "assistant", content: [{ type: "text", text: "Generated the hero image at assets/hero.png." }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
  };

  const orch = new Orchestrator({ cwd: tmp, llm, registry, permission: new PermissionGate("allow-all"), logStore: new LogStore() });
  const r = await orch.run("generate a hero image", {});

  // 1. The generated asset path is captured as written (on the snapshot, which is
  //    what the next prompt's thread context receives).
  const written = r.threadSnapshot?.writtenPaths ?? [];
  assert.ok(written.includes(generated), `generated asset must be in threadSnapshot.writtenPaths (got ${JSON.stringify(written)})`);
  // 2. It is also surfaced as a ref (existing behavior, unchanged).
  assert.ok((r.refs ?? []).some((ref) => ref.uri === generated), "generated asset must be in refs");
  // 3. The summary turn was told about ASSETS GENERATED, so the carried summary
  //    can name the generation rather than dropping it.
  assert.match(summaryPrompt, /ASSETS GENERATED/);
  assert.match(summaryPrompt, /hero\.png/);
});

test("duplicate identical read is served from cache, not re-executed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "b.txt");
  await fs.writeFile(file, "payload-xyz");
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "read", args: { path: file } },
    { tool: "read", args: { path: file } },
    { text: "SUMMARY: done" },
  ]));
  const results = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") results.push(JSON.stringify(e.result)); });
  const result = await orch.runPhase("prepare", "noop");
  const readMessages = result.messages.filter((message) => message.role === "toolResult" && message.toolName === "read");
  assert.equal(results.length, 1, "only the first disk read should surface a visible execution event");
  assert.equal(readMessages.length, 2, "the model still receives both tool result messages");
  assert.match(String(readMessages[1]?.content?.[0]?.text ?? ""), /reusing the cached result/, "second identical read is deduplicated");
});

test("perform stops serving Plan handoff file contents after a successful mutation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<title>wewe</title>\n", "utf8");
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "read", args: { path: file } },
    { tool: "write", args: { path: file, content: "<title>Hello</title>\n" } },
    { tool: "read", args: { path: file } },
    { text: "CHANGES: updated title" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });

  const result = await orch.runPhase("perform", "change the HTML title", {
    attachedFileContents: [{ path: file, content: "1\t<title>wewe</title>" }],
    allowedWorkPaths: [file],
    plannedFileMutations: { [file]: "write" },
  });

  const readEnds = ends.filter((e) => e.toolName === "read");
  const readMessages = result.messages.filter((message) => message.role === "toolResult" && message.toolName === "read");
  assert.equal(readEnds.length, 1, "only the post-mutation disk read should surface a visible execution result");
  assert.equal(readMessages.length, 2, "both perform reads should produce tool result messages");
  assert.match(
    String(readMessages[0]?.content?.[0]?.text ?? ""),
    /handoff cache/,
    "the first read should come from the Plan handoff cache",
  );
  assert.doesNotMatch(
    String(readMessages[1]?.content?.[0]?.text ?? ""),
    /Plan -> Perform handoff cache/,
    "the post-write read must not reuse stale handoff contents",
  );
  assert.match(
    String(readMessages[1]?.content?.[0]?.text ?? ""),
    /1\t<title>Hello<\/title>/,
    "the post-write read should reflect the updated file on disk",
  );
});

test("bash background polling returns ready for long-running startup commands in perform", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const script = "console.log('ready in 120ms'); setInterval(() => {}, 1000);";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "bash", args: { command, background: true, pollMs: 2000, readyPattern: "ready in" } },
    { text: "SUMMARY: done" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });
  await orch.runPhase("perform", "start the dev server");

  const bashEnd = ends.find((e) => e.toolName === "bash");
  assert.ok(bashEnd, "bash result should be surfaced");
  assert.equal(bashEnd.isError, false);
  assert.equal(bashEnd.result?.details?.status ?? bashEnd.result?.status, "ready");
  assert.equal(bashEnd.result?.details?.background ?? bashEnd.result?.background, true);
  await stopBackgroundPid(bashEnd.result?.details?.pid ?? bashEnd.result?.pid);
});

test("bash background polling returns pending instead of hanging when startup has no completion signal yet in perform", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const script = "setInterval(() => {}, 1000);";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "bash", args: { command, background: true, pollMs: 700 } },
    { text: "SUMMARY: done" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });
  await orch.runPhase("perform", "start the dev server");

  const bashEnd = ends.find((e) => e.toolName === "bash");
  assert.ok(bashEnd, "bash result should be surfaced");
  assert.equal(bashEnd.isError, false);
  assert.equal(bashEnd.result?.details?.status ?? bashEnd.result?.status, "pending");
  assert.equal(bashEnd.result?.details?.background ?? bashEnd.result?.background, true);
  await stopBackgroundPid(bashEnd.result?.details?.pid ?? bashEnd.result?.pid);
});

test("bash background polling fails fast on failure patterns even if the process stays alive in perform", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const script = "console.error('Error: port 5173 already in use'); setInterval(() => {}, 1000);";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const orch = newOrch(tmp, makeScriptedLlm([
    { tool: "bash", args: { command, background: true, pollMs: 2000, failurePattern: "port 5173 already in use" } },
    { text: "SUMMARY: done" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });
  await orch.runPhase("perform", "start the dev server");

  const bashEnd = ends.find((e) => e.toolName === "bash");
  assert.ok(bashEnd, "bash result should be surfaced");
  assert.equal(bashEnd.isError, true);
  const bashDetails = bashEnd.result?.details ?? bashEnd.result;
  assert.equal(bashDetails?.status, "failed");
  assert.match(String(bashDetails?.failureMatch ?? ""), /port 5173 already in use/i);
  await stopBackgroundPid(bashDetails?.pid);
});

test("Plan opening surfaces FILES ALREADY READ from Prepare", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "c.txt");
  await fs.writeFile(file, "z");
  const openings = [];
  const llm = new OpenRouterBridge();
  let i = 0;
  llm.stream = async function* (_m, ctx) {
    openings.push(ctx.messages?.[0]?.content ?? "");
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    const isPrepare = /PREPARE phase/.test(ctx.systemPrompt ?? "");
    if (isPrepare && ctx.messages.length === 1) {
      yield { type: "done", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i++}`, name: "read", arguments: { path: file } }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0 } };
      return;
    }
    yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "SUMMARY: done\nPLAN: 1\nVERDICT: PASS" }], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
  };
  const orch = newOrch(tmp, llm);
  await orch.runChain("noop");
  const anyHasReadHandover = openings.some((o) => /FILES ALREADY READ/.test(o) && o.includes(file));
  assert.ok(anyHasReadHandover, "a later phase opening should list FILES ALREADY READ with the read file");
});

// ---------------------------------------------------------------------------
// Tool guards: empty args return a self-correctable error
// ---------------------------------------------------------------------------

test("read tool returns clear error on empty path", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("prepare", undefined);
  const read = all.find((t) => t.name === "read");
  assert.ok(read, "read tool should be present");
  const r = await read.execute("x", {}, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /missing required argument 'path'/);
});

// ---------------------------------------------------------------------------
// mark_concern_lines: parser, arg guards, accumulation, phase membership
// ---------------------------------------------------------------------------

test("parseConcernLines: expands ranges, lists, dedupes, sorts, skips junk", () => {
  assert.deepEqual(parseConcernLines("42-44"), [42, 43, 44], "range expands");
  assert.deepEqual(parseConcernLines("42,43,44"), [42, 43, 44], "list works");
  assert.deepEqual(parseConcernLines("44,42,43"), [42, 43, 44], "sorts ascending");
  assert.deepEqual(parseConcernLines("42-44,43"), [42, 43, 44], "dedupes across range+list");
  assert.deepEqual(parseConcernLines("1,3-5,7"), [1, 3, 4, 5, 7], "mixed range+list");
  assert.deepEqual(parseConcernLines("5-3"), [3, 4, 5], "reversed range expands to ascending");
  assert.deepEqual(parseConcernLines("1, 2 , 3"), [1, 2, 3], "tolerates whitespace");
  assert.deepEqual(parseConcernLines("0,abc,-2,3.5"), [], "skips non-positive/non-integer/non-range tokens");
  assert.deepEqual(parseConcernLines("3,abc,5"), [3, 5], "keeps valid tokens around junk");
  assert.deepEqual(parseConcernLines(""), [], "empty input yields empty");
  assert.deepEqual(parseConcernLines("   "), [], "whitespace-only yields empty");
});

test("mark_concern_lines resolves in all four phases", () => {
  const reg = newRegistryWithBuiltins();
  for (const phase of ["prepare", "plan", "perform", "perfect"]) {
    const all = reg.selectPhaseTools(phase, undefined);
    assert.ok(all.find((t) => t.name === "mark_concern_lines"), `mark_concern_lines should be available in ${phase}`);
  }
});

test("mark_concern_lines returns clear error on empty path", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("prepare", undefined);
  const tool = all.find((t) => t.name === "mark_concern_lines");
  assert.ok(tool, "mark_concern_lines should be present");
  const r = await tool.execute("x", { lines: "42-44" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /missing required argument 'path'/);
});

test("mark_concern_lines returns clear error on empty lines", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("prepare", undefined);
  const tool = all.find((t) => t.name === "mark_concern_lines");
  const r = await tool.execute("x", { path: "some/file.ts" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /missing required argument 'lines'/);
});

test("mark_concern_lines returns error when no line tokens parse", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("prepare", undefined);
  const tool = all.find((t) => t.name === "mark_concern_lines");
  const r = await tool.execute("x", { path: "f.ts", lines: "abc" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /could not parse any valid line numbers/);
});

test("mark_concern_lines parses range into sorted deduped details", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  const tool = all.find((t) => t.name === "mark_concern_lines");
  const r = await tool.execute(
    "x",
    { path: "f.ts", lines: "44,42-43", why: "entrypoint exports" },
    { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg },
  );
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.details.lines, [42, 43, 44]);
  assert.equal(r.details.why, "entrypoint exports");
  assert.match(r.details.path, /f\.ts$/);
});

test("successful mark_concern_lines populates lineConcerns handover", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "a.txt");
  await fs.writeFile(file, "line1\nline2\nline3\n");
  const orch = newOrch(
    tmp,
    makeScriptedLlm([
      { tool: "read", args: { path: file } },
      { tool: "mark_concern_lines", args: { path: file, lines: "1-2", why: "first two lines matter" } },
      { text: "SUMMARY: done" },
    ]),
  );
  const r = await orch.runPhase("prepare", "noop");
  assert.ok(Array.isArray(r.lineConcerns), "lineConcerns should be an array");
  assert.equal(r.lineConcerns.length, 1, "one concern entry");
  const concern = r.lineConcerns[0];
  assert.equal(concern.path, file, "concern path matches read path");
  assert.deepEqual(concern.lines, [1, 2], "lines parsed from range");
  assert.equal(concern.why, "first two lines matter", "why preserved");
});

test("mark_concern_lines may be omitted with no error", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "a.txt");
  await fs.writeFile(file, "hello");
  const orch = newOrch(tmp, makeScriptedLlm([{ tool: "read", args: { path: file } }, { text: "SUMMARY: done" }]));
  const r = await orch.runPhase("prepare", "noop");
  assert.equal(r.lineConcerns, undefined, "no mark_concern_lines call ⇒ no lineConcerns");
});

test("bash tool returns clear error on empty command in perform", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("perform", undefined);
  const bash = all.find((t) => t.name === "bash");
  assert.ok(bash, "bash tool should be present");
  const r = await bash.execute("x", {}, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /missing required argument 'command'/);
});

test("prepare only exposes read plus memory tools", () => {
  const session = new Harness().createSession();
  const all = session.toolsForPhase("prepare");
  assert.ok(all.find((t) => t.name === "read"), "prepare should expose read");
  assert.ok(!all.find((t) => t.name === "ls"), "prepare should not expose ls");
  assert.ok(!all.find((t) => t.name === "grep"), "prepare should not expose grep");
  assert.ok(!all.find((t) => t.name === "bash_readonly"), "prepare should not expose bash_readonly");
  assert.ok(!all.find((t) => t.name === "bash"), "prepare should not expose mutating bash");
  assert.ok(!all.find((t) => t.name === "activity_search"), "prepare should not expose the activity tools");
});

test("plan has bash_readonly and excludes mutating bash", () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  assert.ok(all.find((t) => t.name === "bash_readonly"), "plan should expose bash_readonly");
  assert.ok(!all.find((t) => t.name === "bash"), "plan should not expose mutating bash");
});

test("perfect exposes the activity tools individually, MCP-style", () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("perfect", undefined).map((t) => t.name);
  // One tool per step, so each debugging step is its own visible tool call.
  for (const name of ["activity_search", "activity_study", "activity_trace_start", "activity_collect", "activity_cleanup"]) {
    assert.ok(all.includes(name), `perfect should expose ${name}`);
  }
  assert.ok(!all.includes("activity_monitor"), "the monolithic action-switch tool is gone");
});

test("bash_readonly blocks mutating shell patterns", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  const bashReadonly = all.find((t) => t.name === "bash_readonly");
  assert.ok(bashReadonly, "bash_readonly should be present");

  const blocked = [
    "echo hi > out.txt",
    "mkdir tmp-dir",
    "npm install",
    "npx vite --port 5173",
    "nohup python3 -m http.server 8080 &",
  ];
  for (const command of blocked) {
    const r = await bashReadonly.execute("x", { command }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
    assert.equal(r.isError, true, `bash_readonly should block: ${command}`);
    assert.match(r.output, /blocked/i);
  }
});

test("bash_readonly allows read-only shell inspection", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  const bashReadonly = all.find((t) => t.name === "bash_readonly");
  assert.ok(bashReadonly, "bash_readonly should be present");
  const r = await bashReadonly.execute("x", { command: "printf inspect-ok" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, undefined);
  assert.equal(r.output, "inspect-ok");
});

test("bash_readonly allows /dev/null output suppression (it is not a file write)", async () => {
  // `cat f 2>/dev/null | head` was blocked as "redirection writes" because the `2>`
  // matched the write heuristic. Redirecting to /dev/null discards output — it never
  // writes a file — so it must read as the read-only inspection it is.
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  const bashReadonly = all.find((t) => t.name === "bash_readonly");
  assert.ok(bashReadonly, "bash_readonly should be present");
  const r = await bashReadonly.execute("x", { command: "printf suppress-ok 2>/dev/null | head -1" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.output, "suppress-ok");
});

test("bash_readonly accepts the `cmd` alias for `command`", async () => {
  // The "empty bash" calls seen in the field were the model naming the field `cmd`,
  // not omitting it: { cmd: "..." } arrived, `command` read as empty, the call was
  // rejected and retried — which looked like duplicate tool calls. Accept the alias.
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("plan", undefined);
  const bashReadonly = all.find((t) => t.name === "bash_readonly");
  assert.ok(bashReadonly, "bash_readonly should be present");
  const r = await bashReadonly.execute("x", { cmd: "printf alias-ok" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.equal(r.output, "alias-ok");
});

test("write tool returns clear error when path or content missing", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("perform", undefined);
  const write = all.find((t) => t.name === "write");
  assert.ok(write, "write tool should be present");
  const r1 = await write.execute("x", {}, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r1.isError, true);
  assert.match(r1.output, /missing required argument/);
  const r2 = await write.execute("x", { path: "/tmp/x" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r2.isError, true);
  assert.match(r2.output, /missing required argument/);
});

test("edit tool returns clear error when path/oldString/newString missing", async () => {
  const reg = newRegistryWithBuiltins();
  const all = reg.selectPhaseTools("perform", undefined);
  const edit = all.find((t) => t.name === "edit");
  assert.ok(edit, "edit tool should be present");
  const r = await edit.execute("x", { path: "/tmp/x" }, { cwd: process.cwd(), log: () => {}, llm: undefined, registry: reg });
  assert.equal(r.isError, true);
  assert.match(r.output, /missing required argument/);
});

// ---------------------------------------------------------------------------
// Phase prompts: discipline, efficiency, MCP-first
// ---------------------------------------------------------------------------

test("Prepare prompt: PATH DISCIPLINE + EFFICIENCY", () => {
  assert.match(PHASE_PROMPTS.prepare, /MEMORY FIRST/);
  assert.match(PHASE_PROMPTS.prepare, /USER-FACING UI SUMMARY STYLE/);
  assert.match(PHASE_PROMPTS.prepare, /Anchor the wording to the user's actual request and intent/);
  assert.match(PHASE_PROMPTS.prepare, /file_memory\.search/);
  assert.match(PHASE_PROMPTS.prepare, /graph_memory/);
  assert.match(PHASE_PROMPTS.prepare, /REGISTERED PROVIDERS/);
  assert.match(PHASE_PROMPTS.prepare, /PROVIDER SELECTION RULES/);
  assert.match(PHASE_PROMPTS.prepare, /Infer each provider's purpose from its id, name, description, phase list, and exposed tools/);
  assert.match(PHASE_PROMPTS.prepare, /PLAN = understanding, reading, research, dependency\/context gathering, design\/reference help/);
  assert.match(PHASE_PROMPTS.prepare, /PERFORM = implementation, mutation, generation, environment-specific execution support needed while making changes/);
  assert.match(PHASE_PROMPTS.prepare, /PERFECT = verification, observation, testing, runtime inspection, browser\/device automation, logs\/monitoring/);
  assert.match(PHASE_PROMPTS.prepare, /Do NOT hardcode by provider brand/);
  assert.match(PHASE_PROMPTS.prepare, /Do NOT assign the same provider to all phases unless/);
  assert.match(PHASE_PROMPTS.prepare, /Use ONLY these tools/);
  assert.match(PHASE_PROMPTS.prepare, /`bash`, `bash_readonly`, `ls`, and `grep` are unavailable in PREPARE/);
  assert.match(PHASE_PROMPTS.prepare, /PATH DISCIPLINE/);
  assert.match(PHASE_PROMPTS.prepare, /ABSOLUTE paths/);
  assert.match(PHASE_PROMPTS.prepare, /reuse that exact path string/i);
  assert.match(PHASE_PROMPTS.prepare, /EFFICIENCY/);
  assert.match(PHASE_PROMPTS.prepare, /PROVIDER ASSIGNMENTS:/);
  assert.match(PHASE_PROMPTS.prepare, /FILE SEARCH:/);
  assert.match(PHASE_PROMPTS.prepare, /TOOL CHAIN:/);
  assert.match(PHASE_PROMPTS.prepare, /CATEGORY:/);
  assert.match(PHASE_PROMPTS.prepare, /RUN:/);
  assert.match(PHASE_PROMPTS.prepare, /STOP:/);
  assert.match(PHASE_PROMPTS.prepare, /VERIFY:/);
  assert.match(PHASE_PROMPTS.prepare, /MEMORY UPDATES:/);
  assert.match(PHASE_PROMPTS.prepare, /FILE MEMORY UPDATES:/);
  assert.match(PHASE_PROMPTS.prepare, /CONFIRMED PATHS/);
  assert.doesNotMatch(PHASE_PROMPTS.prepare, /shell inspection/);
});

test("Perform/Perfect prompts recommend bash background polling for startup commands", () => {
  assert.match(PHASE_PROMPTS.perform, /background:true/);
  assert.match(PHASE_PROMPTS.perfect, /background:true/);
  assert.match(PHASE_PROMPTS.perfect, /readyPattern/);
});

test("Plan prompt: PATH DISCIPLINE + TRUST THE HANDOFF", () => {
  assert.match(PHASE_PROMPTS.plan, /bash_readonly/);
  assert.match(PHASE_PROMPTS.plan, /USER-FACING UI SUMMARY STYLE/);
  assert.match(PHASE_PROMPTS.plan, /three COMMON HANDOFF OUTPUTS/);
  assert.match(PHASE_PROMPTS.plan, /file_memory/);
  assert.match(PHASE_PROMPTS.plan, /graph_memory/);
  assert.match(PHASE_PROMPTS.plan, /PROVIDER ASSIGNMENTS/);
  assert.match(PHASE_PROMPTS.plan, /FILE SEARCH shortlist/);
  assert.match(PHASE_PROMPTS.plan, /PHASE INTENT FOR PROVIDERS/);
  assert.match(PHASE_PROMPTS.plan, /PLAN providers are for understanding, reading, research, context, and design\/reference help/);
  assert.match(PHASE_PROMPTS.plan, /PERFORM providers are for execution while implementing changes/);
  assert.match(PHASE_PROMPTS.plan, /PERFECT providers are for verification, observation, testing, runtime inspection, and environment-specific validation/);
  assert.match(PHASE_PROMPTS.plan, /Mutating `bash` is unavailable in PLAN/);
  assert.match(PHASE_PROMPTS.plan, /PATH DISCIPLINE/);
  assert.match(PHASE_PROMPTS.plan, /CONFIRMED PATHS/);
  assert.match(PHASE_PROMPTS.plan, /TRUST THE HANDOFF/);
  assert.match(PHASE_PROMPTS.plan, /Do NOT re-ls the project root/);
});

test("Perform prompt: WRITE EFFICIENCY + LEAVE PROJECT RUNNABLE + RETRY BEHAVIOR", () => {
  assert.match(PHASE_PROMPTS.perform, /graph_memory/);
  assert.match(PHASE_PROMPTS.perform, /USER-FACING UI SUMMARY STYLE/);
  assert.match(PHASE_PROMPTS.perform, /SUMMARY must clearly state what changed/);
  assert.match(PHASE_PROMPTS.perform, /WRITE EFFICIENCY/);
  assert.match(PHASE_PROMPTS.perform, /written exactly ONCE/);
  assert.match(PHASE_PROMPTS.perform, /Do NOT re-read a file immediately after writing/);
  assert.match(PHASE_PROMPTS.perform, /LEAVE THE PROJECT RUNNABLE/);
  assert.match(PHASE_PROMPTS.perform, /npm install/);
  assert.match(PHASE_PROMPTS.perform, /RETRY BEHAVIOR/);
  assert.match(PHASE_PROMPTS.perform, /VERIFICATION FEEDBACK/);
});

test("Perfect prompt: explicit mobile_* toolkit first + reject bash as UI verifier", () => {
  assert.match(PHASE_PROMPTS.perfect, /graph_memory/);
  assert.match(PHASE_PROMPTS.perfect, /USER-FACING UI SUMMARY STYLE/);
  assert.match(PHASE_PROMPTS.perfect, /first sentence must name the concrete reason/);
  assert.match(PHASE_PROMPTS.perfect, /mobile \{ action: "devices" \}/);
  // One tool, addressed by action — not fifteen tool names.
  assert.match(PHASE_PROMPTS.perfect, /mobile \{ action: "launch"/);
  assert.match(PHASE_PROMPTS.perfect, /mobile \{ action: "look"/);
  assert.match(PHASE_PROMPTS.perfect, /mobile \{ action: "tap"/);
  assert.match(PHASE_PROMPTS.perfect, /action: "apps"/);
  // The one rule that makes its coordinates land.
  assert.match(PHASE_PROMPTS.perfect, /exact coordinates/);
  assert.match(PHASE_PROMPTS.perfect, /TOOLS AVAILABLE THIS PHASE/);
  assert.match(PHASE_PROMPTS.perfect, /DO NOT substitute bash/);
  assert.match(PHASE_PROMPTS.perfect, /Bash CANNOT drive a simulator/);
  assert.match(PHASE_PROMPTS.perfect, /do NOT improvise with `open`, `curl`/);
  assert.match(PHASE_PROMPTS.perfect, /Never pass a UI\/mobile task solely because the source files look correct/);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test("mobile preset: perform excludes bash, perfect includes mobile + media_analysis", () => {
  const m = PROJECT_PRESETS.mobile.phaseTools;
  assert.ok(m.perform);
  assert.ok(m.perform.exclude?.includes("bash"), "mobile.perform should exclude bash");
  assert.ok(m.perfect);
  const prov = m.perfect.providers ?? [];
  // Built-in provider ids: the device toolkit is no longer a spawned MCP.
  // These must be the registry's real ids — `providers` is an exact-id lookup
  // that silently no-ops on a miss, so a stale name here disables the toolkit
  // without failing anything.
  assert.ok(prov.includes("builtin:mobile"), "mobile.perfect should include the built-in mobile toolkit");
  assert.ok(prov.includes("builtin:media_analysis"), "mobile.perfect should include media_analysis");
});

test("the mobile preset spawns no device MCP — mobilecli is built in", () => {
  const ids = (PROJECT_PRESETS.mobile.mcp ?? []).map((e) => e.id);
  assert.ok(!ids.includes("mobile"), "the external device-MCP server must be gone");
  assert.deepEqual(ids, ["context7"], "context7 is the only MCP the mobile preset still needs");
});

test("preset provider ids all resolve against the real registry", async () => {
  // The bug this pins: `providers: [...]` is an exact-id lookup into the
  // registry that silently returns nothing on a miss. `providers: ["mobile"]`
  // and `["media_analysis"]` were BOTH dead names once the ids became
  // `builtin:*` — the phase simply lost those tools with no error anywhere.
  const { Registry } = await import("../dist/registry/registry.js");
  const { registerBuiltins } = await import("../dist/tools/index.js");
  const registry = new Registry();
  registerBuiltins(registry, { logStore: { append() {}, search: () => [], tagHistogram: () => [] } });
  const known = new Set(registry.list().map((p) => p.id));

  for (const [name, preset] of Object.entries(PROJECT_PRESETS)) {
    const mcpIds = new Set((preset.mcp ?? []).map((e) => e.id));
    for (const [phase, spec] of Object.entries(preset.phaseTools ?? {})) {
      for (const pid of spec?.providers ?? []) {
        assert.ok(
          known.has(pid) || mcpIds.has(pid),
          `${name}.${phase} names provider "${pid}", which is neither a built-in provider id nor an MCP this preset declares`,
        );
      }
    }
  }
});

test("frontend preset: perform excludes bash, perfect has playwright + chrome-devtools", () => {
  const fe = PROJECT_PRESETS.frontend.phaseTools;
  assert.ok(fe.perform.exclude?.includes("bash"));
  const prov = fe.perfect.providers ?? [];
  assert.ok(prov.includes("playwright"));
  assert.ok(prov.includes("chrome-devtools"));
});

test("PHASE_DEFAULT_TOOLS has all four phases", () => {
  for (const p of ["prepare", "plan", "perform", "perfect"]) {
    assert.ok(PHASE_DEFAULT_TOOLS[p]?.length, `${p} should have default tools`);
  }
  assert.ok(PHASE_DEFAULT_TOOLS.prepare.includes("read"));
  assert.ok(PHASE_DEFAULT_TOOLS.prepare.includes("project_memory"));
  assert.ok(PHASE_DEFAULT_TOOLS.prepare.includes("file_memory"));
  assert.ok(PHASE_DEFAULT_TOOLS.prepare.includes("graph_memory"));
  assert.ok(!PHASE_DEFAULT_TOOLS.prepare.includes("bash_readonly"));
  assert.ok(!PHASE_DEFAULT_TOOLS.prepare.includes("ls"));
  assert.ok(!PHASE_DEFAULT_TOOLS.prepare.includes("grep"));
  assert.ok(!PHASE_DEFAULT_TOOLS.prepare.includes("bash"));
  assert.ok(PHASE_DEFAULT_TOOLS.plan.includes("bash_readonly"));
  assert.ok(PHASE_DEFAULT_TOOLS.plan.includes("file_memory"));
  assert.ok(PHASE_DEFAULT_TOOLS.plan.includes("graph_memory"));
  assert.ok(!PHASE_DEFAULT_TOOLS.plan.includes("bash"));
  assert.ok(PHASE_DEFAULT_TOOLS.perform.includes("file_memory"));
  assert.ok(PHASE_DEFAULT_TOOLS.perform.includes("graph_memory"));
  assert.ok(PHASE_DEFAULT_TOOLS.perfect.includes("graph_memory"));
});

test("default harness models and preset models use xiaomi/mimo-v2.5", () => {
  const DRIVER = "xiaomi/mimo-v2.5";
  for (const [phase, slug] of Object.entries(DEFAULT_PHASE_MODELS)) {
    assert.equal(slug, DRIVER, `${phase} default model should be the driver`);
  }
  for (const [category, preset] of Object.entries(PROJECT_PRESETS)) {
    for (const [phase, slug] of Object.entries(preset.models)) {
      assert.equal(slug, DRIVER, `${category}.${phase} preset model should be the driver`);
    }
  }

  const harness = new Harness();
  const session = harness.createSession();
  const agent = session.createAgent();
  assert.equal(agent.state.model, DRIVER, "agent fallback model should be the driver");
});

test("the driver model is registered, and text-only", () => {
  // An UNREGISTERED slug resolves to the permissive unknown-model default, which
  // claims image support. The modality list is what decides whether an image is
  // serialised into a request, so a blind driver advertised as sighted sends a
  // screenshot straight into a provider rejection and loses the whole turn —
  // which is exactly how a browser session died once already.
  const driver = resolveModel(DEFAULT_PHASE_MODELS.perform);
  assert.equal(driver.id, "xiaomi/mimo-v2.5");
  assert.deepEqual(driver.input, ["text"], "registered explicitly, not falling through to the default");
});

test("the fallback escalation tiers are never weaker than the driver", () => {
  // The staged read escalates a hard file to a stronger model. Its no-candidates
  // fallback pool must not name something smaller than the model doing the
  // reading: the ids would differ, so the `escalated === current` short-circuit
  // would not fire, and a file judged BEYOND the driver would be explained by
  // something weaker than the driver.
  const picked = selectModel({ complexity: { score: 1, signals: {} } }).model;
  assert.equal(picked.openRouterSlug ?? picked.id, DEFAULT_PHASE_MODELS.perform);
});

// ---------------------------------------------------------------------------
// Integration: handoff opening message shape (no network, stub LLM)
// ---------------------------------------------------------------------------

test("Orchestrator.runChain: every phase opening has WORKING DIRECTORY; never hallucinates /project or /workspace", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<h1>x</h1>");

  const { llm, openings } = makeStubLlm({ projectFile: file });
  const reg = newRegistryWithBuiltins();
  const orch = new Orchestrator({
    cwd: tmp,
    llm,
    registry: reg,
    permission: new PermissionGate("allow-all"),
    logStore: new LogStore(),
    maxChainIterations: 1,
  });
  await orch.runChain("noop");

  assert.ok(openings.length >= 3, `expected >=3 phase openings, got ${openings.length}`);
  // The opening is identical across all stream() calls within a single phase
  // (it's always ctx.messages[0]). To assert per-phase, dedupe by content.
  const unique = [...new Set(openings)];
  assert.ok(unique.length >= 3, `expected >=3 unique phase openings, got ${unique.length}`);
  for (const opening of unique) {
    assert.match(opening, /WORKING DIRECTORY/, "every opening must include WORKING DIRECTORY");
    assert.ok(opening.includes(tmp), `opening must include real cwd (${tmp})`);
    // Model-side hallucination patterns: real path lookups, not the literal
    // word "/project" appearing in the prompt's anti-pattern hint.
    assert.doesNotMatch(opening, /- \/project\//, "no /project/<x> hallucinated path");
    assert.doesNotMatch(opening, /- \/workspace\//, "no /workspace/<x> hallucinated path");
    assert.doesNotMatch(opening, /- "\/"/, "no empty-path hallucination");
  }
});

test("Orchestrator.runChain: downstream openings prefer structured file/provider handoff; PERFECT opening adds ALREADY WRITTEN", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<h1>x</h1>");

  const { llm, openings } = makeStubLlm({ projectFile: file });
  const reg = newRegistryWithBuiltins();
  const orch = new Orchestrator({
    cwd: tmp,
    llm,
    registry: reg,
    permission: new PermissionGate("allow-all"),
    logStore: new LogStore(),
    maxChainIterations: 1,
  });
  await orch.runChain("noop");

  // Dedupe by content (each phase may invoke stream() multiple times, all
  // sharing the same opening user message).
  const unique = [...new Set(openings)];
  // 0=PREPARE, 1=PLAN, 2=PERFORM, 3=PERFECT (in single iteration)
  const planOpening = unique[1] ?? "";
  const performOpening = unique[2] ?? "";
  const perfectOpening = unique[3] ?? "";
  assert.ok(planOpening, "plan opening must exist");
  assert.ok(performOpening, "perform opening must exist");
  assert.ok(perfectOpening, "perfect opening must exist");
  assert.match(planOpening, /CONFIRMED PATHS/);
  assert.match(planOpening, /PHASE PROVIDER ASSIGNMENTS/);
  assert.match(planOpening, /RELEVANT FILES FROM PREPARE/);
  assert.match(planOpening, /PREPARE TOOL TRANSCRIPT/);
  assert.doesNotMatch(planOpening, /RECENT TOOL OUTPUTS/);
  assert.match(planOpening, /index\.html/);
  // Perform wrote the file, so Perfect's opening must have ALREADY WRITTEN.
  assert.match(perfectOpening, /ALREADY WRITTEN THIS CHAIN/);
  assert.match(perfectOpening, /index\.html/);
});

test("runner rejects mistyped path when ls already confirmed the exact child path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const project = path.join(root, "shashankv-proj");
  const docs = path.join(project, ".github");
  const listed = path.join(docs, "copilot-instructions.md");
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(listed, "follow the repo rules");
  const typo = listed.replace("shashankv-proj", "shankankv-proj");

  const orch = newOrch(root, makeScriptedLlm([
    { tool: "ls", args: { path: docs } },
    { tool: "read", args: { path: typo } },
    { text: "CATEGORY: frontend\nPROJECT: static HTML site\nRUN: none (no runtime needed)\nSTOP: none\nVERIFY: static inspection\nCAPABILITIES:\nnone (built-in file/bash tools only)\nMEMORY UPDATES:\nnone\nSUMMARY: done" },
  ]));
  const ends = [];
  orch.subscribe((e) => { if (e.type === "tool_execution_end") ends.push(e); });
  const result = await orch.runPhase("prepare", "inspect the repo");

  assert.ok(result.discoveredPaths?.includes(listed), "ls should register the exact listed child path");
  const readError = ends.find((e) => e.toolName === "read");
  assert.ok(readError, "mistyped read should surface a tool result");
  assert.equal(readError.isError, true);
  assert.match(JSON.stringify(readError.result), /Reuse the exact listed path/);
  assert.match(JSON.stringify(readError.result), new RegExp(listed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/**
 * Prepare declares PROJECT (profile) + CAPABILITIES (mcp/skills) via markers.
 * These must thread into every later phase's opening, on top of the existing
 * path/read/write handoff.
 */
function makeProfileStub() {
  const llm = new OpenRouterBridge();
  const openings = [];
  const msg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "x", api: "openrouter", provider: "x",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  // classifyIntent uses complete() — force the TASK route (no network).
  llm.complete = async () => msg("TASK");
  llm.stream = async function* (_model, ctx, _opts) {
    const sys = ctx.systemPrompt ?? "";
    openings.push({ sys, opening: ctx.messages?.[0]?.content ?? "" });
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (/PREPARE phase/.test(sys)) {
      yield {
        type: "done",
        message: msg(
          `CATEGORY: frontend\nPROJECT: static HTML site (no package.json) -> static file server; do NOT use npm/expo/vite\nRUN: python3 -m http.server 8080\nSTOP: pkill -f "http.server 8080"\nVERIFY: browser MCP at http://127.0.0.1:8080\nCAPABILITIES:\n- browser MCP: verify rendered pages\nPROVIDER ASSIGNMENTS:\nPLAN => builtin:file_memory\nPERFORM => builtin:assets_generator\nPERFECT => builtin:media_analysis\nFILE SEARCH:\n${path.join(process.cwd(), "index.html")} | complexity=medium | why=landing page entrypoint | blast=files=${path.join(process.cwd(), "index.html")}; notes=entrypoint\nTOOL TRANSCRIPT:\nfile_memory | target=landing page | summary=Found the main page entrypoint\nMEMORY UPDATES:\n- static site served with python3 -m http.server 8080\nFILE MEMORY UPDATES:\nnone\nSUMMARY: a static site`,
        ),
      };
      return;
    }
    if (/PERFECT phase/.test(sys)) {
      yield { type: "done", message: msg("VERDICT: PASS") };
      return;
    }
    yield { type: "done", message: msg("PLAN: 1. edit index.html\nACCEPTANCE: renders") };
  };
  return { llm, openings };
}

function makeFollowUpContinuationStub(projectFile) {
  const llm = new OpenRouterBridge();
  const openings = [];
  let performWrites = 0;
  const msg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "x", api: "openrouter", provider: "x",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  llm.complete = async () => msg("TASK");
  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    openings.push({ sys, opening: ctx.messages?.[0]?.content ?? "" });
    const isPrepare = /PREPARE phase/.test(sys);
    const isPlan = /PLAN phase/.test(sys);
    const isPerform = /PERFORM phase/.test(sys);
    const isPerfect = /PERFECT phase/.test(sys);
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (isPerform && ctx.messages.length === 1) {
      performWrites += 1;
      const content = `run ${performWrites}`;
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `write-${performWrites}`, name: "write", arguments: { path: projectFile, content } }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    if (isPrepare) {
      yield {
        type: "done",
        message: msg(
          [
            "CATEGORY: backend",
            "PROJECT: Node library -> no runtime needed",
            "RUN: none (no runtime needed)",
            "STOP: none",
            "VERIFY: tests",
            "CAPABILITIES:",
            "none (built-in file/bash tools only)",
            "PROVIDER ASSIGNMENTS:",
            "PLAN => none",
            "PERFORM => none",
            "PERFECT => none",
            "FILE SEARCH:",
            `${projectFile} | complexity=medium | why=Primary file for the task | blast=files=${projectFile}; notes=entrypoint`,
            "TOOL TRANSCRIPT:",
            `read | target=${projectFile} | summary=Read the primary file`,
            "MEMORY UPDATES:",
            "none",
            "FILE MEMORY UPDATES:",
            "none",
            "SUMMARY: prepared the file for follow-up continuation testing",
          ].join("\n"),
        ),
      };
      return;
    }
    if (isPlan) {
      yield {
        type: "done",
        message: msg(
          [
            "CHAT SUMMARY:",
            "Planned a single-file update.",
            "PLAN_JSON:",
            JSON.stringify([
              {
                id: "step-1",
                title: "Update file",
                summary: "Update the main file once.",
                files: [projectFile],
                fileMutations: { [projectFile]: "edit" },
                changes: [`Update ${projectFile}`],
                tools: ["write"],
                verification: ["Confirm Perfect passes"],
                risks: ["Low"],
              },
            ]),
            "PLAN:",
            `1. Update \`${projectFile}\`.`,
            "SUMMARY:",
            `Plan an update for \`${projectFile}\`.`,
            "ACCEPTANCE:",
            "Perfect passes.",
            "DEBUG_LOGS:",
            `Read ${projectFile}.`,
          ].join("\n"),
        ),
      };
      return;
    }
    if (isPerform) {
      yield {
        type: "done",
        message: msg(
          [
            "CHAT SUMMARY:",
            "Updated the tracked file.",
            "SUMMARY:",
            `Updated \`${projectFile}\` for the task.`,
            "CHANGES:",
            `${projectFile} - wrote the new content`,
          ].join("\n"),
        ),
      };
      return;
    }
    if (isPerfect) {
      yield {
        type: "done",
        message: msg(
          [
            "CHAT SUMMARY:",
            "Verification passed.",
            "SUMMARY:",
            `Verified \`${projectFile}\` after the update.`,
            "VERDICT: PASS",
          ].join("\n"),
        ),
      };
      return;
    }
    yield { type: "done", message: msg("SUMMARY: done") };
  };
  return { llm, openings };
}

async function stopBackgroundPid(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

test("Orchestrator.runChain: PROJECT PROFILE + RUNBOOK + structured provider/file handoff from Prepare thread into plan/perform/perfect openings", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const { llm, openings } = makeProfileStub();
  const orch = newOrch(tmp, llm);

  const result = await orch.runChain("build a landing page");
  assert.equal(result.route, "task");

  const downstream = openings
    .filter((o) => /PLAN phase|PERFORM phase|PERFECT phase/.test(o.sys))
    .map((o) => o.opening);
  assert.ok(downstream.length >= 3, `expected >=3 downstream openings, got ${downstream.length}`);

  for (const opening of downstream) {
    assert.match(opening, /TOOLS AVAILABLE THIS PHASE/);
    assert.match(opening, /PROJECT PROFILE \(established by PREPARE/);
    assert.match(opening, /static HTML site \(no package\.json\)/);
    assert.match(opening, /PROJECT RUNBOOK/);
    assert.match(opening, /RUN: python3 -m http\.server 8080/);
    assert.match(opening, /VERIFY: browser MCP at http:\/\/127\.0\.0\.1:8080/);
    assert.match(opening, /CAPABILITIES AVAILABLE/);
    assert.match(opening, /browser MCP/);
    assert.match(opening, /PHASE PROVIDER ASSIGNMENTS/);
    assert.match(opening, /PLAN: builtin:file_memory/);
    assert.match(opening, /PERFECT: builtin:media_analysis/);
    assert.match(opening, /RELEVANT FILES FROM PREPARE/);
    assert.match(opening, /complexity=medium/);
    assert.match(opening, /PREPARE TOOL TRANSCRIPT|PLAN READ TRANSCRIPT/);
  }

  // And the profile/capabilities are exposed on the chain's PhaseResults.
  assert.match(result.phases.plan?.projectProfile ?? "", /static HTML site/);
  assert.match(result.phases.perform?.projectRunbook?.run ?? "", /python3 -m http\.server 8080/);
  assert.match(result.phases.perfect?.capabilities ?? "", /browser MCP/);
  assert.deepEqual(result.phases.plan?.providerAssignments, {
    plan: ["builtin:file_memory"],
    perform: ["builtin:assets_generator"],
    perfect: ["builtin:media_analysis"],
  });
  assert.equal(result.phases.plan?.relevantFiles?.[0]?.complexity, "medium");
  assert.match(result.phases.plan?.toolTranscript?.[0]?.summary ?? "", /Found the main page entrypoint/);
});

test("Session.runPhase prepare exposes registered provider metadata separately from executable tools", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const llm = new OpenRouterBridge();
  const openings = [];
  llm.stream = async function* (_model, ctx) {
    openings.push(ctx.messages?.[0]?.content ?? "");
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CATEGORY: backend\nPROJECT: Node library\nRUN: none (no runtime needed)\nSTOP: none\nVERIFY: tests\nCAPABILITIES:\nnone\nPROVIDER ASSIGNMENTS:\nPLAN => none\nPERFORM => none\nPERFECT => none\nFILE SEARCH:\nnone\nTOOL TRANSCRIPT:\nnone\nMEMORY UPDATES:\nnone\nFILE MEMORY UPDATES:\nnone\nSUMMARY: done" }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };
  const session = new Harness({ llm }).createSession({ cwd: tmp });
  session.addSkill({
    id: "skill:docs-helper",
    source: "external",
    name: "docs_helper",
    description: "Helps with docs",
    tools: [{
      name: "docs_lookup",
      description: "Look up docs",
      mutates: false,
      phases: ["plan"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { output: "ok" };
      },
    }],
  });
  const result = await session.runPhase("prepare", "inspect docs providers");
  const opening = openings[0] ?? "";
  const toolsSection = opening.match(/TOOLS AVAILABLE THIS PHASE[\s\S]*?(?=\n\n[A-Z][A-Z ]+\s*\(|\n\nREGISTERED PROVIDERS|$)/)?.[0] ?? "";
  assert.match(opening, /TOOLS AVAILABLE THIS PHASE/);
  assert.match(toolsSection, /read/);
  assert.doesNotMatch(toolsSection, /docs_lookup/, "registered provider tools should not become executable Prepare tools");
  assert.match(opening, /REGISTERED PROVIDERS/);
  assert.match(opening, /skill:docs-helper/);
  assert.match(opening, /docs_lookup/);
  assert.ok(result.registeredProvidersSeen?.some((provider) => provider.id === "skill:docs-helper"));
});

test("Session.runChain merges structured provider assignments into downstream phase tools", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const llm = new OpenRouterBridge();
  const msg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "x", api: "openrouter", provider: "x",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  llm.complete = async () => msg("TASK");
  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (/PREPARE phase/.test(sys)) {
      yield {
        type: "done",
        message: msg(
          "CATEGORY: backend\nPROJECT: Node library\nRUN: none (no runtime needed)\nSTOP: none\nVERIFY: tests\nCAPABILITIES:\n- docs helper\n- browser verifier\nPROVIDER ASSIGNMENTS:\nPLAN => skill:docs-helper\nPERFORM => none\nPERFECT => mcp:browser-verifier\nFILE SEARCH:\nnone\nTOOL TRANSCRIPT:\nnone\nMEMORY UPDATES:\nnone\nFILE MEMORY UPDATES:\nnone\nSUMMARY: done",
        ),
      };
      return;
    }
    if (/PLAN phase/.test(sys)) {
      yield { type: "done", message: msg("PLAN: 1. use docs helper\nACCEPTANCE: docs helper is available") };
      return;
    }
    if (/PERFORM phase/.test(sys)) {
      yield { type: "done", message: msg("CHANGES: none") };
      return;
    }
    yield { type: "done", message: msg("VERDICT: PASS") };
  };
  const session = new Harness({ llm }).createSession({ cwd: tmp });
  session.addSkill({
    id: "skill:docs-helper",
    source: "external",
    name: "docs_helper",
    description: "Helps plan with docs",
    tools: [{
      name: "docs_lookup",
      description: "Look up docs",
      mutates: false,
      phases: ["plan"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { output: "ok" };
      },
    }],
  });
  session.addProvider({
    id: "mcp:browser-verifier",
    kind: "mcp",
    source: "external",
    name: "browser_verifier",
    description: "Browser verification tools",
    tools: [{
      name: "browser_verify",
      description: "Verify browser state",
      mutates: false,
      phases: ["perfect"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { output: "ok" };
      },
    }],
  });

  await session.runChain("verify provider assignment merge");
  assert.ok(session.toolsForPhase("plan").some((tool) => tool.name === "read"), "built-in plan tools should remain");
  assert.ok(session.toolsForPhase("plan").some((tool) => tool.name === "docs_lookup"));
  assert.ok(session.toolsForPhase("perfect").some((tool) => tool.name === "activity_search"), "built-in perfect tools should remain");
  assert.ok(session.toolsForPhase("perfect").some((tool) => tool.name === "browser_verify"));
});

test("Session.runPhase exposes a cleaned narrative display summary for the host UI", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const llm = new OpenRouterBridge();
  llm.stream = async function* () {
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: [
            "CHAT SUMMARY:",
            "- Prepared the relevant UI files and reduced the visible execution chatter for this task.",
            "- This should stay compact in the app instead of echoing the handoff.",
            "SUMMARY:",
            "Relevant files: /abs/a.ts, /abs/b.ts, /abs/c.ts",
            "TOOL TRANSCRIPT:",
            "read | target=/abs/a.ts | summary=Read the file",
          ].join("\n"),
        }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };
  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const result = await session.runPhase("prepare", "inspect the repo");
  assert.equal(
    result.display?.summary,
    "Relevant files: /abs/a.ts, /abs/b.ts, /abs/c.ts",
  );
  assert.doesNotMatch(result.display?.summary ?? "", /TOOL TRANSCRIPT|SUMMARY:/);
});

test("Session.runPhase recovers the last structured summary when the model emits colon-less headers and repeated SUMMARY blocks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<!doctype html><title>Solar System</title>");
  const llm = new OpenRouterBridge();
  llm.stream = async function* () {
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: [
            "Preparing",
            "Analyzing project scope and dependencies",
            "",
            "PROJECT_MEMORY",
            "project_memory",
            "",
            "READ",
            file,
            "",
            "SUMMARY",
            `Task: Edit the title of \`${file}\`.`,
            "",
            "CATEGORY:",
            "frontend",
            "",
            "CHAT SUMMARY",
            "Found the HTML file and need the new title before editing.",
            "",
            "MEMORY UPDATES:",
            "none",
            "",
            "SUMMARY:",
            `User wants to edit the title in \`${file}\`. The current value is \`Solar System\`, and the desired replacement is still needed.`,
          ].join("\n"),
        }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };

  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const result = await session.runPhase("prepare", "edit the HTML title");

  assert.equal(
    result.summary,
    `User wants to edit the title in \`${file}\`. The current value is \`Solar System\`, and the desired replacement is still needed.`,
  );
  assert.equal(
    result.display?.summary,
    `User wants to edit the title in \`${file}\`. The current value is \`Solar System\`, and the desired replacement is still needed.`,
  );
  assert.doesNotMatch(result.summary, /PROJECT_MEMORY|READ|Analyzing project scope/);
});

test("Session.runPhase synthesizes a failed perform summary when tool work succeeds before the phase errors", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<!doctype html><title>Before</title>");
  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (turn === 1) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: file, content: "<!doctype html><title>After</title>" } }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield {
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        content: [],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "error", errorMessage: "browser screenshot failed", timestamp: 0,
      },
    };
  };

  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const result = await session.runPhase("perform", "update the title");

  assert.equal(result.error, "browser screenshot failed");
  assert.match(result.summary, /Implementation failed before completion/);
  assert.match(result.summary, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.summary, /Error: browser screenshot failed/);
  assert.equal(result.display?.summary, result.summary);
});

test("Session.runPhase guarantees a non-empty summary even when the final assistant text is empty", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const file = path.join(tmp, "index.html");
  await fs.writeFile(file, "<!doctype html><title>Before</title>");
  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (turn === 1) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: file, content: "<!doctype html><title>After</title>" } }],
          model: "x", api: "openrouter", provider: "x",
          usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        model: "x", api: "openrouter", provider: "x",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };

  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const result = await session.runPhase("perform", "update the title");

  assert.match(result.summary, /Implementation completed/);
  assert.match(result.summary, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.display?.summary, result.summary);
});

test("Session.runChain: Prepare can update stale project memory/file memory and reapply the corrected preset", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const indexFile = path.join(cwd, "index.html");
  await fs.writeFile(indexFile, "<!doctype html><title>x</title>");

  const llm = new OpenRouterBridge();
  const msg = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "x", api: "openrouter", provider: "x",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  llm.complete = async () => msg("TASK");
  llm.stream = async function* (_model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    yield { type: "start", partial: { role: "assistant", content: [], model: "x", api: "openrouter", provider: "x", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (/PREPARE phase/.test(sys)) {
      yield {
        type: "done",
        message: msg(
          `CATEGORY: frontend\nPROJECT: static HTML site (no package.json) -> static file server\nRUN: python3 -m http.server 8080\nSTOP: pkill -f "http.server 8080"\nVERIFY: browser MCP at http://127.0.0.1:8080\nCAPABILITIES:\n- browser MCP: verify rendered pages\nMEMORY UPDATES:\n- run with python3 -m http.server 8080\n- verify in a browser against index.html\nFILE MEMORY UPDATES:\n- ${indexFile} => Landing page HTML entrypoint. | tags=html,entry | role=entrypoint\nSUMMARY: static site rooted at index.html`,
        ),
      };
      return;
    }
    if (/PERFECT phase/.test(sys)) {
      yield { type: "done", message: msg("VERDICT: PASS") };
      return;
    }
    yield { type: "done", message: msg("PLAN: 1. keep index.html\nACCEPTANCE: renders") };
  };

  const harness = new Harness({ llm });
  const { session, memory, fileMemory } = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.ok(memory, "project memory should exist");
  assert.ok(fileMemory, "file memory should exist");
  await memory.setCategory("backend", { auto: false });

  const result = await session.runChain("build a landing page");
  assert.equal(result.route, "task");
  assert.equal(memory.category, "frontend", "Prepare should correct stale memory category");
  assert.ok(memory.recall({ text: "python3 -m http.server 8080" }).length >= 1, "Prepare memory updates should be persisted");
  assert.match(fileMemory.get(indexFile)?.summary ?? "", /Landing page HTML entrypoint/);
  assert.match(result.phases.plan?.projectProfile ?? "", /static HTML site/);
  assert.match(result.phases.perfect?.capabilities ?? "", /resolved provider|browser MCP/);

  await harness.closeSession(session.id);
});

test("prepare backfills provider assignments and relevant files when the model emits none", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const pubspec = path.join(tmp, "pubspec.yaml");
  await fs.writeFile(pubspec, "name: cards_mobile_app\ndependencies:\n  intercom_flutter: ^9.4.1\n");

  const llm = makeScriptedLlm([
    { tool: "read", args: { path: pubspec } },
    {
      text:
        "CATEGORY: mobile\n" +
        "PROJECT: Flutter mobile app\n" +
        "RUN: none (no runtime needed)\n" +
        "STOP: none\n" +
        "VERIFY: mobile verification\n" +
        "CAPABILITIES:\nnone\n" +
        "PROVIDER ASSIGNMENTS:\nnone\n" +
        "FILE SEARCH:\nnone\n" +
        "TOOL TRANSCRIPT:\nnone\n" +
        "MEMORY UPDATES:\nnone\n" +
        "FILE MEMORY UPDATES:\nnone\n" +
        "SUMMARY: done",
    },
  ]);

  const session = new Harness({ llm }).createSession({ cwd: tmp });
  session.addSkill({
    id: "skill:docs-helper",
    source: "external",
    name: "docs_helper",
    description: "Reference docs and specs during planning",
    tools: [{
      name: "docs_lookup",
      description: "Look up docs",
      mutates: false,
      phases: ["plan"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { output: "ok" };
      },
    }],
  });
  session.addProvider({
    id: "openwaggle:mcp:device-tools",
    kind: "mcp",
    source: "external",
    name: "device_tools",
    description: "Drive iOS/Android simulators and devices for mobile app verification",
    tools: [{
      name: "mobile_devices",
      description: "List simulators",
      mutates: false,
      phases: ["perform", "perfect"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { output: "ok" };
      },
    }],
  });

  const result = await session.runPhase("prepare", "Explain how Intercom is implemented in this mobile app");
  assert.equal(result.relevantFiles?.[0]?.path, pubspec);
  assert.ok(result.relevantFiles?.[0]?.complexity, "prepare should backfill a file complexity");
  assert.deepEqual(result.providerAssignments, {
    plan: ["skill:docs-helper"],
    perform: ["openwaggle:mcp:device-tools"],
    perfect: ["openwaggle:mcp:device-tools"],
  });
});

test("Session.runChain carries a structured thread snapshot into the next follow-up run", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const projectFile = path.join(tmp, "index.txt");
  await fs.writeFile(projectFile, "seed");
  const { llm, openings } = makeFollowUpContinuationStub(projectFile);
  const session = new Harness({ llm }).createSession({ cwd: tmp });

  const first = await session.runChain("build the first version");
  assert.equal(first.threadSnapshot?.disposition, "completed");
  assert.equal(first.threadSnapshot?.recommendedFollowUpMode, "structured_continue");
  assert.equal(first.threadSnapshot?.task, "build the first version");
  assert.equal(session.threadSnapshot?.task, "build the first version");

  const second = await session.runChain("refine the implementation");
  assert.equal(second.threadSnapshot?.task, "refine the implementation");

  const prepareOpenings = openings
    .filter((entry) => /PREPARE phase/.test(entry.sys))
    .map((entry) => entry.opening);
  assert.equal(prepareOpenings.length, 2);
  assert.match(prepareOpenings[1], /THREAD CONTEXT FROM THE PREVIOUS RUN/);
  assert.match(prepareOpenings[1], /Previous task: build the first version/);
  assert.match(prepareOpenings[1], /Previous disposition: completed/);
  assert.match(prepareOpenings[1], /Run summary: VERDICT: PASS/);
  assert.doesNotMatch(prepareOpenings[1], /Phase outcomes:/);
  assert.match(prepareOpenings[1], new RegExp(projectFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("HarnessAgent reset clears structured follow-up continuation state", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const projectFile = path.join(tmp, "index.txt");
  await fs.writeFile(projectFile, "seed");
  const { llm, openings } = makeFollowUpContinuationStub(projectFile);
  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const agent = session.createAgent();

  await agent.prompt("build the first version");
  assert.equal(agent.state.lastThreadSnapshot?.task, "build the first version");

  agent.reset();
  assert.equal(agent.state.lastThreadSnapshot, undefined);
  assert.equal(session.threadSnapshot, undefined);

  await agent.prompt("start over cleanly");
  const prepareOpenings = openings
    .filter((entry) => /PREPARE phase/.test(entry.sys))
    .map((entry) => entry.opening);
  const lastPrepare = prepareOpenings.at(-1) ?? "";
  assert.doesNotMatch(lastPrepare, /THREAD CONTEXT FROM THE PREVIOUS RUN/);
  assert.equal(agent.state.lastThreadSnapshot?.task, "start over cleanly");
});

test("Session.runPhase persists a standalone thread snapshot for single-phase follow-ups", async () => {
  const llm = makeScriptedLlm([
    {
      text: [
        "CATEGORY: backend",
        "PROJECT: docs-only backend package",
        "SUMMARY: inspected the repo structure",
      ].join("\n"),
    },
  ]);
  const session = new Harness({ llm }).createSession({ cwd: os.tmpdir() });

  const result = await session.runPhase("prepare", "inspect the repo structure");

  assert.equal(result.phase, "prepare");
  assert.equal(session.threadSnapshot?.task, "inspect the repo structure");
  assert.equal(session.threadSnapshot?.disposition, "completed");
  assert.equal(session.threadSnapshot?.recommendedFollowUpMode, "structured_continue");
  assert.equal(session.threadSnapshot?.summary, "inspected the repo structure");
});

test("Single-phase agents expose the latest standalone thread snapshot", async () => {
  const llm = makeScriptedLlm([
    {
      text: [
        "CATEGORY: backend",
        "PROJECT: docs-only backend package",
        "SUMMARY: inspected the repo structure",
      ].join("\n"),
    },
  ]);
  const session = new Harness({ llm }).createSession({ cwd: os.tmpdir() });
  const agent = session.createAgent({ mode: "prepare" });

  await agent.prompt("inspect the repo structure");

  assert.equal(agent.state.lastThreadSnapshot?.task, "inspect the repo structure");
  assert.equal(agent.state.lastThreadSnapshot?.summary, "inspected the repo structure");
  assert.equal(session.threadSnapshot?.task, "inspect the repo structure");
});

test("Follow-up prepare reuses cached file contents without surfacing another READ tool event", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
  const projectFile = path.join(tmp, "index.html");
  await fs.writeFile(projectFile, "<title>Mosichi</title>");
  const llm = makeScriptedLlm([
    { tool: "read", args: { path: projectFile } },
    {
      text: [
        "CATEGORY: frontend",
        "PROJECT: static HTML site (no package.json) -> static file server",
        "SUMMARY: captured the current HTML title",
      ].join("\n"),
    },
    { tool: "read", args: { path: projectFile } },
    {
      text: [
        "CATEGORY: frontend",
        "PROJECT: static HTML site (no package.json) -> static file server",
        "SUMMARY: reused the prior HTML context",
      ].join("\n"),
    },
  ]);
  const session = new Harness({ llm }).createSession({ cwd: tmp });
  const readStarts = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "read") {
      readStarts.push(event);
    }
  });

  await session.runPhase("prepare", "inspect the current title");
  const second = await session.runPhase("prepare", "continue from the last title change");

  assert.equal(readStarts.length, 1);
  assert.equal(session.threadSnapshot?.contextFiles?.[0]?.path, projectFile);
  assert.match(second.summary, /reused the prior HTML context/);
});

test("Session.runChain persists a single run summary for aborted runs", async () => {
  const llm = new OpenRouterBridge();
  llm.stream = async function* (_model, _ctx, opts) {
    yield {
      type: "start",
      partial: {
        role: "assistant",
        content: [],
        model: "x",
        api: "openrouter",
        provider: "x",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
      },
    };
    await new Promise((_, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const session = new Harness({ llm }).createSession({ cwd: os.tmpdir() });
  const controller = new AbortController();
  const run = session.runChain("stop this run mid-flight", { signal: controller.signal });
  controller.abort();

  const result = await run;

  assert.equal(result.success, false);
  assert.equal(result.threadSnapshot?.disposition, "aborted");
  assert.equal(result.threadSnapshot?.recommendedFollowUpMode, "structured_continue");
  assert.match(result.threadSnapshot?.summary ?? "", /Run stopped before completion/);
  assert.equal(session.threadSnapshot?.summary, result.threadSnapshot?.summary);
});
