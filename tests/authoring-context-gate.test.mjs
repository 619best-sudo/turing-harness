/**
 * The authoring model must always be told WHAT THE EDIT IS FOR.
 *
 * The bug these tests pin: `authoringContext` was assembled only when the runner
 * had resolved an author model slug (`decision.authorModel` or a `routeModel`
 * hit). But a write/edit does not author only when a slug was resolved — under
 * `authorOnlyWrites` the schema drops `content`/`newString` entirely, so the tool
 * authors UNCONDITIONALLY and falls back to the driver model. Routing, meanwhile,
 * deliberately never fires for a `low` rating.
 *
 * The intersection — a content-less, low-rated edit, i.e. the most ordinary edit
 * there is — reached the authoring helper with no task, no plan and no snippets.
 * Model B got the current file and an anchor and was asked for a replacement with
 * no statement of intent anywhere in its prompt, so it invented one from the
 * file's own contents: asked to rename a page title, it wrote a title describing
 * whatever the file already was. The driver then re-edited the same region every
 * turn against a different invention.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCodingTools,
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  runToolLoop,
} from "../dist/index.js";

const editTool = createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit");

const CURRENT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Realistic Solar System Animation</title>
</head>
<body><canvas id="c"></canvas></body>
</html>
`;

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Records the prompt each authoring call receives; replies with a fixed string. */
function recordingLlm(text) {
  const prompts = [];
  return {
    prompts,
    complete: async (model, ctx) => {
      const c = ctx.messages[0]?.content;
      prompts.push(
        typeof c === "string"
          ? c
          : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""),
      );
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        model: model.openRouterSlug ?? model.id,
        api: "openrouter",
        provider: "test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
      };
    },
  };
}

async function scratchFile(contents = CURRENT) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authoring-gate-"));
  const file = path.join(dir, "index.html");
  await fs.writeFile(file, contents);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// The regression itself.
// ---------------------------------------------------------------------------

test("a content-less edit authored on the driver model still receives the task", async () => {
  const { dir, file } = await scratchFile();
  const llm = recordingLlm("<title>ToottyFruity</title>");

  // Exactly what the loop builds for a LOW-rated edit with no pinned/routed
  // author model: no `authorModel` on the context, but `authoringContext` IS
  // present now because the call *can* author.
  await editTool.execute(
    "call-1",
    { path: "index.html", oldString: "<title>Realistic Solar System Animation</title>" },
    {
      cwd: dir,
      llm,
      model: { id: "driver/model" },
      authoringContext: { task: "Change the page title to ToottyFruity" },
      log: () => {},
    },
  );

  assert.equal(llm.prompts.length, 1, "the driver-fallback author ran");
  assert.match(llm.prompts[0], /TASK:/, "the prompt carries a task section");
  assert.match(
    llm.prompts[0],
    /ToottyFruity/,
    "the actual instruction reaches the model that writes the bytes",
  );
  assert.equal(await fs.readFile(file, "utf8"), CURRENT.replace(
    "<title>Realistic Solar System Animation</title>",
    "<title>ToottyFruity</title>",
  ));
});

// ---------------------------------------------------------------------------
// Anchor scope: a short replacement silently deleted the rest of the anchor.
// ---------------------------------------------------------------------------

test("the anchor contract tells the author its output replaces the WHOLE anchor", async () => {
  const { dir } = await scratchFile();
  const llm = recordingLlm("<title>ToottyFruity</title>");
  const anchor = `<head>
<meta charset="UTF-8">
<title>Realistic Solar System Animation</title>
</head>`;

  await editTool.execute(
    "call-1",
    { path: "index.html", oldString: anchor },
    { cwd: dir, llm, model: { id: "driver/model" }, log: () => {} },
  );

  assert.match(llm.prompts[0], /REPLACES the entire anchor/);
  assert.doesNotMatch(
    llm.prompts[0],
    /do NOT include it in your output/,
    "the phrasing that induced truncation is gone",
  );
});

test("an edit whose replacement shrinks a multi-line anchor says so in its output", async () => {
  const { dir } = await scratchFile();
  // The exact failure: a 4-line anchor, a 1-line replacement. The doctype/meta
  // lines vanish and the call still succeeds — the result must say what it did.
  const llm = recordingLlm("<title>ToottyFruity</title>");
  const anchor = `<head>
<meta charset="UTF-8">
<title>Realistic Solar System Animation</title>
</head>`;

  const res = await editTool.execute(
    "call-1",
    { path: "index.html", oldString: anchor },
    { cwd: dir, llm, model: { id: "driver/model" }, log: () => {} },
  );

  assert.ok(!res.isError, "a shrinking replacement is reported, not failed");
  assert.match(res.output, /3 line\(s\) shorter than the anchor/);
  assert.match(res.output, /Read the file to confirm/);
});

// ---------------------------------------------------------------------------
// The gate at loop level: `canAuthor`, not "an author slug was resolved".
// ---------------------------------------------------------------------------

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/** Drive one edit through the real loop; report the authoringContext the tool saw. */
async function editThroughLoop({ rating, routeModel }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-loop-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, CURRENT);
  let seen = null;

  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _args, ctx) {
      seen = ctx.authoringContext ?? null;
      return { output: "edited" };
    },
  };

  const llm = new OpenRouterBridge();
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield {
        type: "done",
        message: msg(
          [{ type: "toolCall", id: "e1", name: "edit",
             arguments: { path: target, oldString: "<title>Realistic Solar System Animation</title>" } }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  await runToolLoop({
    task: "Build a realistic solar system animation",
    authoringTask: "Change the page title to ToottyFruity",
    userMessage: "go",
    tools: [spyEdit],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    ...(routeModel ? { routeModel } : {}),
    complexityByPath: { [target]: rating },
    complexitySource: "plan-task",
  });

  return seen;
}

test("a LOW-rated edit — which never routes — still gets an authoring context", async () => {
  // The regression. `low` is excluded from routing by design, so no author slug
  // resolves; under authorOnlyWrites the tool authors anyway. Gating the context
  // on the slug left this exact call with nothing to author toward.
  const ctx = await editThroughLoop({ rating: "low" });
  assert.ok(ctx, "authoringContext is present even with no author model resolved");
  assert.match(ctx.task, /ToottyFruity/);
});

test("authoringTask outranks the run-level task as the authoring intent", async () => {
  // `task` is run-level and outlives the turn; a per-anchor author needs the
  // instruction that is live NOW, or it authors toward an already-satisfied goal.
  const ctx = await editThroughLoop({ rating: "low" });
  assert.match(ctx.task, /Change the page title to ToottyFruity/);
  assert.doesNotMatch(ctx.task, /Build a realistic solar system animation/);
});

// ---------------------------------------------------------------------------
// Clarification carry-through: a resolved ask_user_question must reach Model B.
//
// The bug these tests pin: under authorOnlyWrites the driver gets a clarification
// answer in its conversation but has no `newString` field to express it, and the
// authoring model authors from task + file + anchor alone — so the answer never
// reached the bytes. A resolved question now folds its Q&A into the authoring
// intent, exactly as mediaFact/designReference are folded.
// ---------------------------------------------------------------------------

test("a resolved clarification reaches the authoring model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-clarify-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, CURRENT);
  let seen = null;

  // A spy ask_user_question that mimics the ANSWERED path: returns the same
  // `details` (`kind: "ask_user_question", answered: true`) and result text
  // the real tool emits when the host callback resolves. No host callback is
  // installed here — the loop reads the answered details off the tool result.
  const spyAsk = {
    name: "ask_user_question",
    description: "spy",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
    async execute(_id, _args, _ctx) {
      return {
        output: "User answered: RocknRoll\n(clarification for: What should the title be?)",
        content: [{ type: "text", text: "User answered: RocknRoll\n(clarification for: What should the title be?)" }],
        details: {
          kind: "ask_user_question",
          answered: true,
          question: "What should the title be?",
        },
      };
    },
  };
  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _args, ctx) {
      seen = ctx.authoringContext ?? null;
      return { output: "edited" };
    },
  };

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      // First the driver asks, then it edits from the answer.
      yield {
        type: "done",
        message: msg([{
          type: "toolCall", id: "q1", name: "ask_user_question",
          arguments: { question: "What should the title be?" },
        }], "tool_use"),
      };
      return;
    }
    if (turn === 2) {
      yield {
        type: "done",
        message: msg([{
          type: "toolCall", id: "e1", name: "edit",
          arguments: { path: target, oldString: "<title>Realistic Solar System Animation</title>" },
        }], "tool_use"),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  await runToolLoop({
    task: "Build a realistic solar system animation",
    userMessage: "go",
    tools: [spyAsk, spyEdit],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    complexityByPath: { [target]: "low" },
    complexitySource: "plan-task",
  });

  // The clarification answer must reach the authoring model's task. Without the
  // fix, `seen.task` is just the run-level "Build a realistic solar system
  // animation" and RocknRoll never appears — Model B invents a title from the
  // file's own contents instead.
  assert.ok(seen, "an edit after a clarification builds an authoring context");
  assert.match(seen.task, /RocknRoll/, "the clarification answer reaches Model B");
  assert.match(seen.task, /What should the title be\?/, "the question travels with the answer");
  // The run-level task still frames it; the clarification specializes it.
  assert.match(seen.task, /Build a realistic solar system animation/);
});

test("a MULTI-LINE clarification answer reaches the authoring model in full", async () => {
  // The regression: the parser used `(.+?)` with the multiline flag, which
  // anchored to end-of-line, so a free-text answer spanning lines was truncated
  // to its first line. The whole answer must reach Model B.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-clarify-ml-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, CURRENT);
  let seen = null;

  const spyAsk = {
    name: "ask_user_question",
    description: "spy",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
    async execute() {
      return {
        output: "User answered: line one of the answer\nline two of the answer\n(clarification for: details?)",
        content: [{ type: "text", text: "User answered: line one of the answer\nline two of the answer\n(clarification for: details?)" }],
        details: { kind: "ask_user_question", answered: true, question: "details?" },
      };
    },
  };
  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _args, ctx) {
      seen = ctx.authoringContext ?? null;
      return { output: "edited" };
    },
  };

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "q1", name: "ask_user_question", arguments: { question: "details?" } }], "tool_use") };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "e1", name: "edit", arguments: { path: target, oldString: "<title>Realistic Solar System Animation</title>" } }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  await runToolLoop({
    task: "Build a realistic solar system animation",
    userMessage: "go",
    tools: [spyAsk, spyEdit],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    complexityByPath: { [target]: "low" },
    complexitySource: "plan-task",
  });

  assert.ok(seen, "an edit after the clarification builds an authoring context");
  // BOTH lines must be present — the old regex truncated after "line one".
  assert.match(seen.task, /line one of the answer/);
  assert.match(seen.task, /line two of the answer/, "the second line is not truncated");
});

test("an OUTSTANDING (unanswered) question does not seed authoring intent", async () => {
  // A pending question carries `details` too (no `answered: true`); it must NOT
  // be folded into the intent. The loop stops on a pending question, so the edit
  // never runs — which is itself the guard: the unanswered shape neither seeded
  // intent nor let the edit proceed as though it had an answer.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-clarify-pending-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, CURRENT);
  let seen = null;

  const spyAsk = {
    name: "ask_user_question",
    description: "spy",
    parameters: { type: "object", properties: {}, required: [] },
    mutates: false,
    // No host callback installed: the tool emits a PENDING question (no `answered`).
    async execute() {
      return {
        output: "User clarification required: What should the title be?",
        content: [{ type: "text", text: "User clarification required: What should the title be?" }],
        details: {
          kind: "ask_user_question",
          question: "What should the title be?",
        },
      };
    },
  };
  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _args, ctx) {
      seen = ctx.authoringContext ?? null;
      return { output: "edited" };
    },
  };

  const llm = new OpenRouterBridge();
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield {
        type: "done",
        message: msg([{
          type: "toolCall", id: "q1", name: "ask_user_question",
          arguments: { question: "What should the title be?" },
        }], "tool_use"),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  await runToolLoop({
    task: "Build a realistic solar system animation",
    userMessage: "go",
    tools: [spyAsk, spyEdit],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    complexityByPath: { [target]: "low" },
    complexitySource: "plan-task",
  });

  assert.equal(seen, null, "a pending question stops the loop before the edit");
});

test("a routed HIGH-rated edit still gets its context, as before", async () => {
  const ctx = await editThroughLoop({
    rating: "high",
    routeModel: ({ kind, rating }) => (kind === "write" && rating === "high" ? "author/strong" : undefined),
  });
  assert.ok(ctx, "the escalated path is unchanged");
  assert.match(ctx.task, /ToottyFruity/);
});

test("a same-size replacement carries no shrink note", async () => {
  const { dir } = await scratchFile();
  const llm = recordingLlm("<title>ToottyFruity</title>");

  const res = await editTool.execute(
    "call-1",
    { path: "index.html", oldString: "<title>Realistic Solar System Animation</title>" },
    { cwd: dir, llm, model: { id: "driver/model" }, log: () => {} },
  );

  assert.ok(!res.isError);
  assert.doesNotMatch(res.output, /shorter than the anchor/);
});

// ---------------------------------------------------------------------------
// Planless (`skipPlan: true`) — the agent's DEFAULT path.
//
// The plan path gets its intent from `buildAuthoringTask`, which needs a
// PlanTask. Planless runs have none, so the loop must fall back to the run task —
// which in a planless run IS the live instruction, since the host calls
// `run("change the title to ToottyFruity")` per turn. This pins that the fallback
// actually reaches Model B rather than leaving it to invent again.
// ---------------------------------------------------------------------------

test("a planless run still hands the authoring model the task", async () => {
  const { Orchestrator, Registry, registerBuiltins } = await import("../dist/index.js");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-planless-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, CURRENT);

  let seenAuthoringTask = null;
  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _args, ctx) {
      seenAuthoringTask = ctx.authoringContext?.task ?? null;
      return { output: "edited" };
    },
  };

  const llm = new OpenRouterBridge();
  let routerCalls = 0;
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      routerCalls += 1;
      return {
        role: "assistant", content: [{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "write_edit" : "summarise"}` }],
        model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{ id: "p1", title: "Rename", summary: "x", tasks: [{ id: "t1", order: 1, title: "Rename", summary: "x", files: [target], fileMutations: { [target]: "edit" }, complexity: "low" }] }],
        executionOrder: ["p1"],
      };
      return {
        role: "assistant", content: [{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }],
        model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    }
    return {
      role: "assistant", content: [{ type: "text", text: "ok" }],
      model: model.openRouterSlug ?? model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  let turn = 0;
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "p1", name: "create_plan", arguments: { task: "the change" } }], "tool_use") };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: msg([{
        type: "toolCall", id: "e1", name: "edit",
        arguments: { path: target, oldString: "<title>Realistic Solar System Animation</title>" },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "toolCall", id: "d1", name: "deliver", arguments: { writes: [], notes: "done" } }], "tool_use") };
  };

  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });

  const orch = new Orchestrator({
    cwd: dir,
    llm,
    registry,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap" },
  });
  // Pin the spy edit into the write_edit hop (extras override same-named
  // defaults), so the real edit tool does not run and observe nothing.
  orch.setCategorizerTools("write_edit", [spyEdit]);

  await orch.run("Change the page title to ToottyFruity", { skipPlan: true });

  assert.ok(seenAuthoringTask, "planless runs still build an authoring context");
  assert.match(seenAuthoringTask, /ToottyFruity/);
});
