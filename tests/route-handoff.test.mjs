/**
 * Who decides the next categorizer.
 *
 * From a real run ("bug: on polling in the contacts page, the status is not
 * changing…"): `read` spent twenty-four turns on it and delivered a full
 * root-cause analysis with fix locations. The router — a separate tool-free turn
 * whose whole view of the hop is one 240-character line — read the opening of
 * that analysis, took it for a finished report, and answered `summarise`. The run
 * ended having written nothing.
 *
 * `children: ["write_edit", "activity_inspect"]` was correct the whole time:
 * children is the MENU, not the choice. Both were offered and both were declined.
 *
 * So the driver that did the work now names what comes next, in order, as part of
 * its own `deliver` call — validated against `children`, floored by policy, with
 * the router as the fallback for when it says nothing usable.
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
  OpenRouterBridge,
  Orchestrator,
  PermissionGate,
  Registry,
  applyPolicyToRouted,
  createDefaultCategorizers,
  decideFromDriver,
  deliverSchemaFor,
  registerBuiltins,
  takeHandoff,
} from "../dist/index.js";

const CATS = createDefaultCategorizers();
const cat = (id) => CATS.find((c) => c.id === id);

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
const msg = (content, model = "test/a") => ({
  role: "assistant", content, model, api: "openrouter", provider: "test",
  usage: zeroUsage(), stopReason: "stop", timestamp: 0,
});
const toolMsg = (calls) => ({
  ...msg(calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))),
  stopReason: "tool_use",
});

function withBuiltins() {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  return reg;
}

// ---------------------------------------------------------------------------
// The schema channel
// ---------------------------------------------------------------------------

test("every categorizer with children can nominate, bounded by its own children", () => {
  for (const id of ["read", "write_edit", "activity_inspect"]) {
    const schema = deliverSchemaFor(cat(id));
    const field = schema.properties.nextCategorizers;
    assert.ok(field, `${id} should be able to nominate`);
    assert.deepEqual(field.items.enum, [...cat(id).children, "summarise"]);
    assert.ok(schema.properties.handoffReason, `${id} should be able to say why`);
    // The content contract is untouched — the tail is additive.
    for (const key of Object.keys(deliverSchemaFor({ ...cat(id), children: [] }).properties)) {
      assert.ok(key in schema.properties, `${id} lost its own field ${key}`);
    }
  }
});

test("a terminal categorizer gets no nomination field", () => {
  const schema = deliverSchemaFor(cat("conversation"));
  assert.equal(cat("conversation").children.length, 0);
  assert.ok(!("nextCategorizers" in schema.properties));
});

test("takeHandoff splits routing off the deliverable and drops illegal ids", () => {
  const taken = takeHandoff(cat("read"), {
    codeSummary: "the story",
    nextCategorizers: ["activity_reproduce", "write_edit"],
    handoffReason: "reproduce it, then fix it",
  });
  assert.deepEqual(taken.nominations, ["activity_reproduce", "write_edit"]);
  assert.equal(taken.reason, "reproduce it, then fix it");
  // Stripped: the deliverable is rendered into the next hop's prompt verbatim, so
  // a note addressed to the chain must not travel inside it.
  assert.deepEqual(taken.deliverable, { codeSummary: "the story" });

  // `read` cannot nominate itself or a stranger.
  assert.deepEqual(
    takeHandoff(cat("read"), { nextCategorizers: ["read", "activity_inspect", "nonsense", "write_edit"] }).nominations,
    ["write_edit"],
    "read may not nominate itself, a stranger, or the VERIFY hop (not one of its children)",
  );
  // A bare string where an array was asked for.
  assert.deepEqual(takeHandoff(cat("read"), { nextCategorizers: "write_edit" }).nominations, ["write_edit"]);
  // Everything after summarise is unreachable.
  assert.deepEqual(takeHandoff(cat("read"), { nextCategorizers: ["summarise", "write_edit"] }).nominations, [
    "summarise",
  ]);
  // Nothing said ⇒ nothing claimed, and the deliverable is untouched.
  const none = takeHandoff(cat("read"), { codeSummary: "x" });
  assert.deepEqual(none.nominations, []);
  assert.deepEqual(none.deliverable, { codeSummary: "x" });
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const readHop = (over = {}) => ({
  id: "read", index: 0, summary: "## Bug Summary: root cause found…", delivered: true,
  toolRecords: [], writtenPaths: [], readPaths: ["/a.dart"], ...over,
});

test("the driver's nominated sequence is consumed in order", () => {
  const base = {
    choices: [cat("activity_reproduce"), cat("write_edit")],
    hops: [readHop()],
    queue: ["activity_reproduce", "write_edit"],
    writtenPaths: [],
  };
  const first = decideFromDriver(base);
  assert.equal(first.selection, "activity_reproduce");
  assert.equal(first.source, "driver");
  assert.deepEqual(first.queue, ["write_edit"]);

  // Next hop: the remainder is re-validated against activity_reproduce's children.
  const second = decideFromDriver({
    choices: [cat("write_edit")],
    hops: [readHop(), { ...readHop(), id: "activity_reproduce", index: 1 }],
    queue: first.queue,
    writtenPaths: [],
  });
  assert.equal(second.selection, "write_edit");
  assert.deepEqual(second.queue, []);
});

test("a nomination that is no longer legal is skipped, not fatal", () => {
  // write_edit is not among activity_inspect's... it is; use a stranger instead:
  // an id the current choices do not offer must be passed over so the REST of the
  // sequence still gets its turn.
  const decision = decideFromDriver({
    choices: [cat("write_edit")],
    hops: [readHop()],
    queue: ["activity_inspect", "write_edit"],
    writtenPaths: [],
  });
  assert.equal(decision.selection, "write_edit");
});

test("the driver may not pick the categorizer that just ran", () => {
  const decision = decideFromDriver({
    choices: [cat("write_edit"), cat("activity_inspect")],
    hops: [readHop({ id: "activity_reproduce" })],
    queue: ["activity_reproduce", "write_edit"],
    writtenPaths: [],
  });
  assert.equal(decision.selection, "write_edit", "the repeat is dropped, the sequence survives");
});

test("no nomination ⇒ the router is asked", () => {
  assert.equal(
    decideFromDriver({ choices: [cat("write_edit")], hops: [readHop()], queue: [], writtenPaths: [] }),
    undefined,
  );
});

test("a bug run with nothing written cannot summarise — reproduce first", () => {
  const decision = applyPolicyToRouted(
    {
      choices: [cat("activity_reproduce"), cat("write_edit")],
      hops: [readHop()],
      queue: [],
      writtenPaths: [],
      isBugFix: true,
    },
    "summarise",
    "CATEGORY: summarise",
    false,
  );
  assert.equal(decision.selection, "activity_reproduce", "reproduce, not verify — there is no fix yet");
  assert.equal(decision.source, "policy");
  // Floor 1 owns this now: an unreproduced bug goes to reproduction whether the
  // decision was to summarise or to jump straight to the fix.
  assert.match(decision.reason, /reproduced before it is fixed/);
});

test("the floor falls through to write_edit when inspection is unavailable or off", () => {
  const input = {
    choices: [cat("activity_reproduce"), cat("write_edit")],
    hops: [readHop()],
    queue: [],
    writtenPaths: [],
    isBugFix: true,
    preferInspect: false,
  };
  assert.equal(applyPolicyToRouted(input, "summarise", "r", false).selection, "write_edit");
  assert.equal(
    applyPolicyToRouted({ ...input, preferInspect: undefined, choices: [cat("write_edit")] }, "summarise", "r", false)
      .selection,
    "write_edit",
  );
});

test("the floor is narrow: it never forces work onto a run that did some, or is not a bug", () => {
  const base = {
    choices: [cat("activity_reproduce"), cat("write_edit")],
    hops: [readHop()],
    queue: [],
    writtenPaths: [],
  };
  // "understand the auth flow and summarise it" — not a bug report, so read →
  // summarise is the right answer and must survive.
  assert.equal(applyPolicyToRouted(base, "summarise", "r", false).selection, "summarise");
  // A bug run that already wrote something may end.
  assert.equal(
    applyPolicyToRouted({ ...base, isBugFix: true, writtenPaths: ["/a.dart"] }, "summarise", "r", false).selection,
    "summarise",
  );
  // A decision to gather evidence is never redirected — only summarise and
  // straight-to-the-fix are, and only while the bug is unobserved.
  assert.equal(
    applyPolicyToRouted({ ...base, isBugFix: true }, "activity_reproduce", "r", false).selection,
    "activity_reproduce",
  );
  assert.equal(
    applyPolicyToRouted({ ...base, isBugFix: true, writtenPaths: ["/a.dart"] }, "write_edit", "r", false).selection,
    "write_edit",
    "a second fix round is the run's own business",
  );
});

test("a driver nominating summarise is floored too — the driver is not above policy", () => {
  const decision = decideFromDriver({
    choices: [cat("activity_reproduce"), cat("write_edit")],
    hops: [readHop()],
    queue: ["summarise"],
    writtenPaths: [],
    isBugFix: true,
  });
  assert.equal(decision.selection, "activity_reproduce");
  assert.equal(decision.source, "policy");
});

// ---------------------------------------------------------------------------
// Floor 1: see it before you fix it
// ---------------------------------------------------------------------------

/**
 * The nomination channel exists because the driver knows more than the router —
 * but on a reported bug it does not know the one thing that matters. From a real
 * run, minutes after the QA split landed: read was offered
 * [activity_reproduce, write_edit], nominated `write_edit`, and went straight to
 * editing the file its own reading had pointed at. Nothing reproduced, nothing
 * instrumented; the user stopped the run.
 */
const bugRun = (over = {}) => ({
  choices: [cat("activity_reproduce"), cat("write_edit")],
  hops: [readHop()],
  queue: ["write_edit"],
  writtenPaths: [],
  isBugFix: true,
  ...over,
});

test("a driver that nominates the FIX on an unreproduced bug is sent to reproduce first", () => {
  const decision = decideFromDriver(bugRun());
  assert.equal(decision.selection, "activity_reproduce");
  assert.equal(decision.source, "policy", "not attributed to the driver — the driver was overruled");
  assert.match(decision.reason, /reproduced before it is fixed/);
  // The nomination is not thrown away: the fix is queued for immediately after.
  assert.deepEqual(decision.queue, ["write_edit"]);

  // And it runs, from the queue, with no further routing call.
  const next = decideFromDriver({
    choices: [cat("write_edit")],
    hops: [readHop(), { ...readHop(), id: "activity_reproduce", index: 1 }],
    queue: decision.queue,
    writtenPaths: [],
    isBugFix: true,
  });
  assert.equal(next.selection, "write_edit");
  assert.equal(next.source, "driver");
});

test("a longer nominated sequence keeps its tail through the redirect", () => {
  const decision = decideFromDriver(bugRun({ queue: ["write_edit", "activity_inspect"] }));
  assert.equal(decision.selection, "activity_reproduce");
  assert.deepEqual(decision.queue, ["write_edit", "activity_inspect"]);
});

test("the same floor applies to the ROUTER choosing the fix", () => {
  const decision = applyPolicyToRouted(bugRun({ queue: [] }), "write_edit", "CATEGORY: write_edit", false);
  assert.equal(decision.selection, "activity_reproduce");
  assert.equal(decision.source, "policy");
});

test("floor 1 stays out of the way of everything else", () => {
  const honoured = (label, over) => {
    const d = decideFromDriver(bugRun(over));
    assert.equal(d.selection, "write_edit", label);
    assert.equal(d.source, "driver", label);
  };
  honoured("not a bug report", { isBugFix: false });
  honoured("a later fix round — something is already written", { writtenPaths: ["/a.dart"] });
  honoured("the host disabled verification", { preferInspect: false });
  honoured("reproduction already ran earlier in the run", {
    hops: [readHop(), { ...readHop(), id: "activity_reproduce", index: 1 }],
  });
  honoured("a setup with no reproduce hop at all", { choices: [cat("write_edit")] });

  // Verification after a fix is untouched.
  const verify = decideFromDriver({
    choices: [cat("activity_inspect")],
    hops: [readHop(), { ...readHop(), id: "write_edit", index: 1 }],
    queue: ["activity_inspect"],
    writtenPaths: ["/a.dart"],
    isBugFix: true,
  });
  assert.equal(verify.selection, "activity_inspect");
  assert.equal(verify.source, "driver");
});

test("reproduce → write_edit is never bounced back (the floor cannot loop)", () => {
  const decision = decideFromDriver({
    choices: [cat("write_edit")],
    hops: [readHop(), { ...readHop(), id: "activity_reproduce", index: 1 }],
    queue: ["write_edit"],
    writtenPaths: [],
    isBugFix: true,
  });
  assert.equal(decision.selection, "write_edit");
});

test("floor 2 knows reproduction is spent: summarise after it goes to the fix", () => {
  const afterRepro = {
    choices: [cat("write_edit")],
    hops: [readHop(), { ...readHop(), id: "activity_reproduce", index: 1 }],
    queue: [],
    writtenPaths: [],
    isBugFix: true,
  };
  const decision = applyPolicyToRouted(afterRepro, "summarise", "r", false);
  assert.equal(decision.selection, "write_edit");
  assert.match(decision.reason, /describing a defect is not repairing it/);
});

// ---------------------------------------------------------------------------
// End to end: the run that failed
// ---------------------------------------------------------------------------

/**
 * Replays it. The router is scripted to answer `summarise` after read — exactly
 * what the real one did — so the run can only reach the fix through the driver's
 * nomination and the policy floor.
 */
function bugBridge({ target, nominate }) {
  const llm = new OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  const seen = { turns: {}, routerCalls: 0, hops: [] };

  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    if (/CATEGORIZER ROUTER/.test(sys)) {
      seen.routerCalls += 1;
      // First choice: read. Every choice after that: end the run — the bug.
      return msg([
        { type: "text", text: seen.routerCalls === 1 ? "CATEGORY: read\nBUGFIX: yes" : "CATEGORY: summarise\nBUGFIX: yes" },
      ]);
    }
    if (/breaking a task into an ordered implementation plan/.test(sys)) {
      const plan = {
        plans: [{
          id: "p1", title: "Fix polling", summary: "x",
          tasks: [{ id: "t1", order: 1, title: "fix", summary: "x", files: [target], fileMutations: { [target]: "write" }, complexity: "medium" }],
        }],
        executionOrder: ["p1"],
      };
      return msg([{ type: "text", text: `PLANS_JSON:\n${JSON.stringify(plan)}` }]);
    }
    if (/closing summary/.test(sys)) return msg([{ type: "text", text: "Polling fixed and reproduced." }]);
    return msg([{ type: "text", text: "ok" }]);
  };

  llm.stream = async function* (model, ctx) {
    const sys = ctx.systemPrompt ?? "";
    const which =
      /READ categorizer/.test(sys) ? "read"
      : /WRITE\/EDIT categorizer/.test(sys) ? "write_edit"
      : /ACTIVITY REPRODUCE/.test(sys) ? "activity_reproduce"
      : /ACTIVITY INSPECT/.test(sys) ? "activity_inspect"
      : "other";
    seen.turns[which] = (seen.turns[which] ?? 0) + 1;
    if (seen.turns[which] === 1) seen.hops.push(which);
    yield { type: "start", partial: msg([]) };

    if (which === "read") {
      yield { type: "done", message: toolMsg([["d1", "deliver", {
        files: [{ path: target, role: "list screen", lines: "113-118" }],
        codeSummary: "## Bug Summary\n**Root Cause:** polling never starts on initial load…",
        ...(nominate ? { nextCategorizers: nominate, handoffReason: "reproduce it, then fix it" } : {}),
      }]]) };
      return;
    }
    if (which === "activity_reproduce") {
      // Observe first — the hop's `deliver` is refused once until something has
      // actually been run, so the stub runs one command like a real pass would.
      const script = [
        ["o1", "bash", { command: "echo status did not repaint" }],
        ["d3", "deliver", {
          reproduced: true,
          symptom: "the status never repaints until you pull to refresh",
          steps: "opened the contacts list and waited for polling",
          logPaths: ["/tmp/t.log"],
          suspects: [{ path: target, lines: "113-118", why: "_dbLeads is never refreshed in browse mode" }],
          nextCategorizers: ["write_edit"],
          handoffReason: "now fix it",
        }],
      ];
      yield { type: "done", message: toolMsg([script[Math.min(seen.turns.activity_reproduce - 1, script.length - 1)]]) };
      return;
    }
    if (which === "write_edit") {
      const script = [
        ["p1", "create_plan", { task: "fix polling" }],
        ["w1", "write", { path: target, content: "fixed\n" }],
        ["d2", "deliver", { writes: [{ tool: "write", path: target, summary: "fixed" }], notes: "done", nextCategorizers: ["summarise"] }],
      ];
      yield { type: "done", message: toolMsg([script[Math.min(seen.turns.write_edit - 1, script.length - 1)]]) };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  return { llm, seen };
}

async function runBug({ nominate, isBugFix = true }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-handoff-"));
  const target = path.join(dir, "lead_list_screen.dart");
  await fs.writeFile(target, "old\n");
  const { llm, seen } = bugBridge({ target, nominate });
  const logStore = new LogStore();
  const orch = new Orchestrator({
    cwd: dir, llm, registry: withBuiltins(),
    permission: new PermissionGate("bypass"), logStore,
    ...(isBugFix ? { isBugFix: true } : {}),
  });
  const result = await orch.run("bug: on polling in the contacts page, the status is not changing");
  return { dir, target, seen, result, logStore };
}

test("read's nomination takes the run through reproduce → fix, past a router saying summarise", async () => {
  const { dir, target, seen, result, logStore } = await runBug({ nominate: ["activity_reproduce", "write_edit"] });
  assert.equal(result.success, true, `error=${result.error}`);
  assert.deepEqual(seen.hops, ["read", "activity_reproduce", "write_edit"]);
  assert.equal(await fs.readFile(target, "utf8"), "fixed\n", "the bug must actually get fixed");

  // The router was asked for the FIRST hop only; after that the driver answered,
  // so the chain skipped the call entirely.
  assert.equal(seen.routerCalls, 1);

  // Four decisions: the router opens the run, then each hop's driver names the
  // next — including write_edit ending it, which it has earned by writing.
  const routes = logStore.entries.filter((e) => e.tags?.includes("categorizer:route"));
  assert.deepEqual(routes.map((e) => e.data.selection), ["read", "activity_reproduce", "write_edit", "summarise"]);
  assert.deepEqual(routes.map((e) => e.data.source), ["router", "driver", "driver", "driver"]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("read nominating the fix directly is redirected through reproduction, end to end", async () => {
  const { dir, target, seen, result, logStore } = await runBug({ nominate: ["write_edit"] });
  assert.equal(result.success, true, `error=${result.error}`);
  assert.deepEqual(seen.hops, ["read", "activity_reproduce", "write_edit"], `hops: ${seen.hops.join(" → ")}`);
  const routes = logStore.entries.filter((e) => e.tags?.includes("categorizer:route"));
  assert.equal(routes[1].data.source, "policy");
  assert.equal(routes[1].data.selection, "activity_reproduce");
  // The driver's own nomination survives the redirect and needs no router call.
  assert.equal(routes[2].data.source, "driver");
  assert.equal(routes[2].data.selection, "write_edit");
  assert.equal(await fs.readFile(target, "utf8"), "fixed\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("with no nomination the policy floor still refuses to end a bug run that wrote nothing", async () => {
  const { dir, target, seen, result } = await runBug({ nominate: undefined });
  assert.equal(result.success, true, `error=${result.error}`);
  assert.equal(seen.hops[0], "read");
  assert.ok(seen.hops.includes("activity_reproduce"), `hops were ${seen.hops.join(" → ")}`);
  assert.equal(await fs.readFile(target, "utf8"), "fixed\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the routing decision is logged either way", async () => {
  const { dir, logStore } = await runBug({ nominate: ["activity_reproduce", "write_edit"] });
  const [first] = logStore.entries.filter((e) => e.tags?.includes("categorizer:route"));
  assert.ok(first.data.choices.length, "the menu offered is logged");
  assert.ok("isBugFix" in first.data && "writes" in first.data, "the inputs to the decision are logged");
  const handoffs = logStore.entries.filter((e) => e.tags?.includes("categorizer:handoff"));
  assert.match(handoffs[0].message, /read nominated activity_reproduce → write_edit/);
  await fs.rm(dir, { recursive: true, force: true });
});
