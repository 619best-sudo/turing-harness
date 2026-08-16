/**
 * Host-owned escalation routing: (kind, rating) → model slug.
 *
 * Before this hook the only way to steer escalation was `toolModelCandidates`,
 * a flat pool indexed by `floor(score * pool.length)`. That works, but which
 * model a rating lands on is a function of the pool's LENGTH — append one slug
 * and every rating silently re-targets. It also cannot distinguish a read from
 * a write, which is the distinction that actually matters: comprehension and
 * authoring want different models.
 *
 * These tests pin the contract: the router wins where it has an opinion, the
 * pool still works where it doesn't, `low` never escalates, and an explicit
 * per-call `authorModel` from the permission layer still outranks the table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODING_TOOLS,
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

/** The table shape the app owns, mirroring turing-model-routing.ts. */
const ROUTING = {
  read: { medium: "deepseek/deepseek-v4-flash-0731", high: "openai/gpt-5.6-terra-pro" },
  write: { medium: "deepseek/deepseek-v4-flash-0731", high: "openai/gpt-5.6-terra" },
};
const routeModel = ({ kind, rating }) => ROUTING[kind]?.[rating];

test("the table answers each (kind, rating) pair distinctly, and ignores low", () => {
  assert.equal(routeModel({ kind: "read", rating: "medium" }), "deepseek/deepseek-v4-flash-0731");
  assert.equal(routeModel({ kind: "read", rating: "high" }), "openai/gpt-5.6-terra-pro");
  assert.equal(routeModel({ kind: "write", rating: "medium" }), "deepseek/deepseek-v4-flash-0731");
  // The one asymmetry, and the reason kind is an axis at all: a high WRITE goes
  // to terra, a high READ to terra-pro. A flat pool cannot express this.
  assert.equal(routeModel({ kind: "write", rating: "high" }), "openai/gpt-5.6-terra");
  assert.equal(routeModel({ kind: "read", rating: "low" }), undefined);
  assert.equal(routeModel({ kind: "write", rating: "low" }), undefined);
});

/** Run one write through the loop and report the authoring model the tool saw. */
async function writeWith({ rating, decisionAuthorModel, useRouter = true }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-routing-"));
  const target = path.join(tmp, "f.ts");
  let seenAuthorModel = "(none)";

  // Stand in for `write` so the test observes ctx.authorModel without needing a
  // real authoring round-trip.
  const writeTool = {
    ...CODING_TOOLS.find((t) => t.name === "write"),
    async execute(_id, args, ctx) {
      seenAuthorModel = ctx.authorModel?.openRouterSlug ?? ctx.authorModel?.id ?? "(none)";
      await fs.writeFile(args.path, String(args.content ?? ""));
      return { output: "written" };
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
          [{ type: "toolCall", id: "w1", name: "write", arguments: { path: target, content: "x" } }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [writeTool],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({
      allowed: true,
      ...(decisionAuthorModel ? { authorModel: decisionAuthorModel } : {}),
    })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
    ...(useRouter ? { routeModel } : {}),
    // The rating the call arrives with, as if inherited from a plan step.
    complexityByPath: { [target]: rating },
    complexitySource: "plan-task",
  });

  return seenAuthorModel;
}

test("a high-rated write is authored by the model the table names", async () => {
  assert.equal(await writeWith({ rating: "high" }), "openai/gpt-5.6-terra");
});

test("a medium-rated write escalates too — it is not only high that routes", async () => {
  assert.equal(await writeWith({ rating: "medium" }), "deepseek/deepseek-v4-flash-0731");
});

test("a low-rated write is not escalated at all", async () => {
  // Escalating `low` would spend a whole extra model round-trip to re-derive
  // what the loop's own model was already trusted to do.
  assert.equal(await writeWith({ rating: "low" }), "(none)");
});

test("an explicit authorModel from the permission layer outranks the table", async () => {
  // Per-call instructions are more specific than standing policy, and hosts use
  // this to pin a model for one particular call.
  assert.equal(
    await writeWith({ rating: "high", decisionAuthorModel: "anthropic/claude-opus-4.8" }),
    "anthropic/claude-opus-4.8",
  );
});

test("with no router wired, nothing changes for existing hosts", async () => {
  // The hook is additive: a host that never passes `routeModel` must behave
  // exactly as before, escalating only when its permission callback says so.
  assert.equal(await writeWith({ rating: "high", useRouter: false }), "(none)");
});

test("the router reaches tools as ctx.routeModel, for staged reads", async () => {
  // The read half escalates INSIDE the tool (comprehendFile), so it needs the
  // table on the context rather than through a permission decision.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-routing-ctx-"));
  let seen;
  const probe = {
    name: "probe",
    description: "d",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, ctx) {
      seen = ctx.routeModel?.({ kind: "read", rating: "high" });
      return { output: "ok" };
    },
  };
  const llm = new OpenRouterBridge();
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "p1", name: "probe", arguments: {} }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };
  await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [probe],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
    routeModel,
  });
  assert.equal(seen, "openai/gpt-5.6-terra-pro");
});
