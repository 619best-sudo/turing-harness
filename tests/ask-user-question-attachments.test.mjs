/**
 * `ask_user_question` carries files in both directions.
 *
 * Two distinct capabilities, both of which used to be missing:
 *
 *  1. The agent can SHOW files with the question (`attachments`) and can ASK
 *     the user for one (`requestAttachments`). A question about something
 *     visual is cheaper to answer with the thing on screen; a question whose
 *     answer IS a file — the mockup, the error screenshot, the CSV — gets a
 *     paragraph describing it when asked in prose, which is a worse answer than
 *     none.
 *
 *  2. Whatever the user attaches reaches the rest of the run. This is the half
 *     that makes the first half worth having: an image handed over mid-run
 *     joins the live attachment set, so the next `write`/`edit` authors from
 *     the pixels exactly as it would for a file attached to the prompt. Without
 *     it, the file is named in a tool result and never looked at again.
 *
 * Back-compat is pinned too: a host callback returning a plain string is still
 * valid and still means "text only".
 *
 * All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  askUserQuestionTool,
  normalizeAnswer,
  sanitizeAttachments,
  sanitizeAttachmentRequest,
  Orchestrator,
  PermissionGate,
  OpenRouterBridge,
  LogStore,
  Registry,
  registerBuiltins,
} from "../dist/index.js";

function ctxFor(overrides = {}) {
  return { cwd: "/work", log: () => {}, ...overrides };
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

test("a bare string answer is still valid and means text-only", () => {
  assert.deepEqual(normalizeAnswer("use Postgres"), { text: "use Postgres" });
});

test("an object answer carries text plus files", () => {
  const out = normalizeAnswer({
    text: "here it is",
    attachments: [{ path: "/abs/hero.png", mimeType: "image/png" }],
  });
  assert.equal(out.text, "here it is");
  assert.equal(out.attachments.length, 1);
});

test("files alone are a legitimate answer — empty text is not an error", () => {
  const out = normalizeAnswer({ text: "", attachments: [{ path: "/abs/a.png" }] });
  assert.equal(out.text, "");
  assert.equal(out.attachments[0].mimeType, "image/png", "mime inferred from the extension");
});

test("relative paths are absolutized against cwd; duplicates collapse", () => {
  const out = sanitizeAttachments(
    ["shot.png", { path: "shot.png" }, { path: "/abs/other.pdf" }],
    "/work",
  );
  assert.deepEqual(out.map((a) => a.path), ["/work/shot.png", "/abs/other.pdf"]);
  assert.equal(out[0].mimeType, "image/png");
  assert.equal(out[1].mimeType, "application/pdf");
});

test("an unknown extension still yields a usable attachment", () => {
  const [only] = sanitizeAttachments([{ path: "/abs/thing.weird" }], "/work");
  assert.equal(only.mimeType, "application/octet-stream", "never dropped for lack of a mime");
});

test("http(s) URLs pass through untouched", () => {
  const [only] = sanitizeAttachments(["https://x/y.png"], "/work");
  assert.equal(only.path, "https://x/y.png");
});

test("requestAttachments accepts the shorthand forms a model reaches for", () => {
  assert.deepEqual(sanitizeAttachmentRequest(true), { mode: "optional" });
  assert.deepEqual(sanitizeAttachmentRequest("required"), { mode: "required" });
  assert.deepEqual(
    sanitizeAttachmentRequest({ mode: "required", accept: [".png", ""], hint: "the mockup", multiple: true }),
    { mode: "required", accept: [".png"], hint: "the mockup", multiple: true },
  );
  assert.equal(sanitizeAttachmentRequest({ mode: "whenever" }), undefined);
  assert.equal(sanitizeAttachmentRequest(undefined), undefined);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

test("the request carries the agent's attachments and its file request to the host", async () => {
  let seen;
  await askUserQuestionTool.execute(
    "q1",
    {
      question: "Which of these two heroes?",
      attachments: [
        { path: "a.png", note: "option A" },
        { path: "/abs/b.png", note: "option B" },
      ],
      requestAttachments: { mode: "required", accept: ["image/*"], hint: "the Figma export" },
    },
    ctxFor({ askUserQuestion: async (req) => { seen = req; return "A"; } }),
  );
  assert.equal(seen.attachments.length, 2);
  assert.equal(seen.attachments[0].path, "/work/a.png", "absolutized for the host");
  assert.equal(seen.attachments[0].note, "option A");
  assert.deepEqual(seen.requestAttachments, {
    mode: "required",
    accept: ["image/*"],
    hint: "the Figma export",
  });
});

test("a string answer keeps the exact pre-attachment output shape", async () => {
  const res = await askUserQuestionTool.execute(
    "q2",
    { question: "Postgres or SQLite?" },
    ctxFor({ askUserQuestion: async () => "Postgres" }),
  );
  assert.match(res.output, /User answered: Postgres/);
  assert.equal(res.isError, undefined);
});

test("attached files are listed and ROUTED in the model-facing output", async () => {
  const res = await askUserQuestionTool.execute(
    "q3",
    { question: "Send me the mockup", requestAttachments: { mode: "required" } },
    ctxFor({
      askUserQuestion: async () => ({
        text: "",
        attachments: [{ path: "/abs/hero.png", mimeType: "image/png", note: "the hero" }],
      }),
    }),
  );
  assert.match(res.output, /User answered with a file and no text/);
  assert.match(res.output, /\/abs\/hero\.png \(image\/png\) — the hero/);
  assert.match(res.output, /pass the path in `images` on write\/edit/);
  assert.match(res.output, /media_analysis/);
  assert.deepEqual(res.details.answerAttachments.map((a) => a.path), ["/abs/hero.png"]);
});

test("a non-image answer file is pointed at the tool that can read it", async () => {
  const res = await askUserQuestionTool.execute(
    "q4",
    { question: "Send me the export", requestAttachments: { mode: "required" } },
    ctxFor({
      askUserQuestion: async () => ({ text: "attached", attachments: [{ path: "/abs/rows.csv" }] }),
    }),
  );
  assert.doesNotMatch(res.output, /images` on write\/edit/, "a CSV is not vision input");
  assert.match(res.output, /use `read` for/);
  assert.equal(res.details.answerAttachments[0].mimeType, "text/csv");
});

test("with no host callback the question still states what it wants attached", async () => {
  const res = await askUserQuestionTool.execute(
    "q5",
    {
      question: "Send me the mockup",
      requestAttachments: { mode: "required", hint: "the hero design", accept: [".png"] },
      attachments: [{ path: "/abs/current.png", note: "what we have now" }],
    },
    ctxFor(),
  );
  assert.match(res.output, /A file is REQUIRED with the answer: the hero design/);
  assert.match(res.output, /accepts \.png/);
  assert.match(res.output, /Shown with the question:/);
  assert.equal(res.details.requestAttachments.mode, "required");
});

// ---------------------------------------------------------------------------
// The half that matters: the file reaches the rest of the run
// ---------------------------------------------------------------------------

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
const msg = (content) => ({
  role: "assistant", content, model: "x", api: "openrouter", provider: "x",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});
const toolCall = (id, name, args) => ({
  ...msg([{ type: "toolCall", id, name, arguments: args }]),
  stopReason: "tool_use",
});

test("an image the user attaches mid-run reaches the NEXT tool call's context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askq-attach-"));
  const mock = path.join(dir, "hero-mockup.png");
  await fs.writeFile(mock, Buffer.from("89504e470d0a1a0a", "hex"));

  const probed = [];
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  registry.add({
    id: "test:probe",
    kind: "tool",
    source: "internal",
    name: "context probe",
    tools: [{
      name: "context_probe",
      description: "Records the tool context it was handed.",
      mutates: false,
      // Explicit scope: the heuristic would file a "probe" under
      // activity_inspect, but this probe must run in the reading hop.
      categorizers: ["read"],
      parameters: { type: "object", properties: { when: { type: "string" } }, required: [] },
      async execute(_id, args, ctx) {
        probed.push({ when: args.when, images: (ctx.images ?? []).map((i) => i.path) });
        return { output: "probed" };
      },
    }],
  });

  // Turn 1: probe (before). Turn 2: ask for the file. Turn 3: probe (after).
  let turn = 0;
  const llm = new OpenRouterBridge();
  let routerCalls = 0;
  llm.complete = async (_m, ctx) => {
    if (/CATEGORIZER ROUTER/.test(String(ctx.systemPrompt ?? ""))) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "read" : "summarise"}` }]);
    }
    return msg([{ type: "text", text: "done" }]);
  };
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: toolCall("p1", "context_probe", { when: "before" }) };
      return;
    }
    if (turn === 2) {
      yield {
        type: "done",
        message: toolCall("a1", "ask_user_question", {
          question: "Send me the hero mockup",
          requestAttachments: { mode: "required", hint: "the hero design" },
        }),
      };
      return;
    }
    if (turn === 3) {
      yield { type: "done", message: toolCall("p2", "context_probe", { when: "after" }) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "Done." }]) };
  };

  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  const result = await orch.run("Build the hero", {
    skipPlan: true,
    verify: false,
    askUserQuestion: async () => ({
      text: "here it is",
      attachments: [{ path: mock, mimeType: "image/png", note: "the hero design" }],
    }),
  });

  assert.equal(result.success, true);
  const before = probed.find((p) => p.when === "before");
  const after = probed.find((p) => p.when === "after");
  assert.ok(before && after, "both probes ran");
  assert.deepEqual(before.images, [], "nothing was attached at the start of the run");
  assert.deepEqual(
    after.images,
    [mock],
    "the file the user handed over must be part of the run's attachments afterwards",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("a non-image answer file does NOT become vision input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askq-csv-"));
  const csv = path.join(dir, "rows.csv");
  await fs.writeFile(csv, "a,b\n1,2\n");

  const probed = [];
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });
  registry.add({
    id: "test:probe",
    kind: "tool",
    source: "internal",
    name: "context probe",
    tools: [{
      name: "context_probe",
      description: "Records the tool context it was handed.",
      mutates: false,
      // Explicit scope: the heuristic would file a "probe" under
      // activity_inspect, but this probe must run in the reading hop.
      categorizers: ["read"],
      parameters: { type: "object", properties: {}, required: [] },
      async execute(_id, _args, ctx) {
        probed.push((ctx.images ?? []).map((i) => i.path));
        return { output: "probed" };
      },
    }],
  });

  let turn = 0;
  const llm = new OpenRouterBridge();
  let routerCalls = 0;
  llm.complete = async (_m, ctx) => {
    if (/CATEGORIZER ROUTER/.test(String(ctx.systemPrompt ?? ""))) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "read" : "summarise"}` }]);
    }
    return msg([{ type: "text", text: "done" }]);
  };
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield {
        type: "done",
        message: toolCall("a1", "ask_user_question", {
          question: "Send me the export",
          requestAttachments: { mode: "required" },
        }),
      };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: toolCall("p1", "context_probe", {}) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "Done." }]) };
  };

  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
    autoTriageAttachments: false,
  });
  await orch.run("Parse the export", {
    skipPlan: true,
    verify: false,
    askUserQuestion: async () => ({ text: "attached", attachments: [{ path: csv, mimeType: "text/csv" }] }),
  });

  assert.deepEqual(probed[0], [], "a CSV must not be handed to a vision authoring pass");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a host that still returns a plain string keeps working end to end", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askq-str-"));
  const registry = new Registry();
  const logStore = new LogStore();
  registerBuiltins(registry, { logStore });

  let turn = 0;
  const llm = new OpenRouterBridge();
  let routerCalls = 0;
  llm.complete = async (_m, ctx) => {
    if (/CATEGORIZER ROUTER/.test(String(ctx.systemPrompt ?? ""))) {
      routerCalls += 1;
      return msg([{ type: "text", text: `CATEGORY: ${routerCalls <= 1 ? "read" : "summarise"}` }]);
    }
    return msg([{ type: "text", text: "done" }]);
  };
  llm.stream = async function* () {
    turn += 1;
    yield { type: "start", partial: msg([]) };
    if (turn === 1) {
      yield { type: "done", message: toolCall("a1", "ask_user_question", { question: "Postgres or SQLite?" }) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "Went with Postgres." }]) };
  };

  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass"),
    logStore,
  });
  const result = await orch.run("Pick a datastore", {
    skipPlan: true,
    verify: false,
    askUserQuestion: async () => "Postgres",
  });
  assert.equal(result.success, true);
  await fs.rm(dir, { recursive: true, force: true });
});
