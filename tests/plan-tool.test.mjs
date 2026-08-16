/**
 * Tests for the `create_plan` tool and its review loop.
 *
 * Covers each requirement:
 *   - breaks a task into an ordered multi-FILE plan
 *   - the planning PROMPT is configuration, replaceable by the host
 *   - the plan is handed to the host for review (approve / re-plan with comments)
 *   - a re-plan actually carries the user's comments to the model
 *   - per-step user notes + attachments ride on the plan
 *   - and reach the step's own execution when that step runs
 *
 * All offline — a stub bridge stands in for the planning model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PLAN_SYSTEM_PROMPT,
  DEFAULT_PLAN_MODEL,
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  createPlanTool,
  runToolLoop,
} from "../dist/index.js";

const MODEL = "test/planner";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function planJson(titleSuffix = "") {
  return JSON.stringify({
    plans: [
      {
        id: "plan-1",
        title: `Ship the feature${titleSuffix}`,
        summary: "two-file change",
        tasks: [
          {
            id: "t1", order: 1, title: `Add the header${titleSuffix}`, summary: "new component",
            files: ["src/Header.tsx"], fileMutations: { "src/Header.tsx": "write" },
            complexity: "medium", verification: "renders at 375px", risks: "none",
          },
          {
            id: "t2", order: 2, title: "Wire it into the page", summary: "import + mount",
            files: ["src/Page.tsx"], fileMutations: { "src/Page.tsx": "edit" },
            complexity: "low", verification: "header visible",
          },
        ],
      },
    ],
    executionOrder: ["plan-1"],
  });
}

/** Stub planner. Records every call so we can assert on the prompt it received. */
function makePlanner(replies = [planJson()]) {
  const llm = new OpenRouterBridge();
  const calls = [];
  let i = 0;
  llm.complete = async (model, ctx) => {
    calls.push({ model: model.openRouterSlug ?? model.id, ctx });
    const text = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      model: MODEL, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, calls };
}

function ctxFor(llm, extra = {}) {
  return {
    cwd: os.tmpdir(),
    model: { id: MODEL, openRouterSlug: MODEL, input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    ...extra,
  };
}

test("create_plan: produces an ordered multi-file plan", async () => {
  const { llm } = makePlanner();
  const res = await createPlanTool().execute("c1", { task: "add a header" }, ctxFor(llm));

  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.kind, "plan_set");
  const tasks = res.details.planSet.plans[0].tasks;
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.order), [1, 2]);
  assert.deepEqual(tasks.map((t) => t.files[0]), ["src/Header.tsx", "src/Page.tsx"]);
  assert.equal(tasks[0].fileMutations["src/Header.tsx"], "write");
  // The LLM-facing rendering is an ordered checklist, not raw JSON.
  assert.match(res.output, /APPROVED PLAN/);
  assert.match(res.output, /1\. \[ \] \[t1\] Add the header \(medium\)/);
  // Every task carries `isCompleted` from the start: a client rendering checkboxes
  // must not have to distinguish "not done" from "field missing".
  assert.deepEqual(tasks.map((t) => t.isCompleted), [false, false]);
});

test("create_plan: the planning prompt is replaceable configuration", async () => {
  const { llm, calls } = makePlanner();
  await createPlanTool({ systemPrompt: "HOUSE RULES: plan in haiku." }).execute(
    "c1", { task: "add a header" }, ctxFor(llm),
  );

  assert.equal(calls[0].ctx.systemPrompt, "HOUSE RULES: plan in haiku.");
  assert.doesNotMatch(calls[0].ctx.systemPrompt, /senior engineer/);

  // The default is exported so a host can extend rather than replace it — get
  // the JSON contract wrong and the plan silently fails to parse.
  const { llm: llm2, calls: calls2 } = makePlanner();
  await createPlanTool({ systemPrompt: `${DEFAULT_PLAN_SYSTEM_PROMPT}\n\nALSO: prefer TypeScript.` }).execute(
    "c1", { task: "x" }, ctxFor(llm2),
  );
  assert.match(calls2[0].ctx.systemPrompt, /PLANS_JSON/);
  assert.match(calls2[0].ctx.systemPrompt, /prefer TypeScript/);
});

test("create_plan: sends the draft to the host and returns the approved plan", async () => {
  const { llm } = makePlanner();
  const seen = [];
  const res = await createPlanTool().execute(
    "c1",
    { task: "add a header", context: "React app" },
    ctxFor(llm, {
      planApproval: async (req) => {
        seen.push(req);
        return { approved: true };
      },
    }),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].revision, 1);
  assert.equal(seen[0].task, "add a header");
  assert.equal(seen[0].revisionsRemaining, 3);
  assert.equal(seen[0].planSet.plans[0].tasks.length, 2);
  assert.equal(res.details.approved, true);
  assert.equal(res.details.revisions, 1);
});

test("create_plan: comments drive a re-plan and reach the model", async () => {
  const { llm, calls } = makePlanner([planJson(), planJson(" v2")]);
  let round = 0;
  const res = await createPlanTool().execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, {
      planApproval: async (req) => {
        round += 1;
        if (round === 1) return { approved: false, comments: "Split the header into two components." };
        // Round 2 must be told what was said in round 1.
        assert.equal(req.revision, 2);
        assert.equal(req.priorComments, "Split the header into two components.");
        assert.equal(req.revisionsRemaining, 2);
        return { approved: true };
      },
    }),
  );

  assert.equal(calls.length, 2, "a rejected plan must be re-drafted");
  // The user's words go to the planner verbatim, marked as overriding.
  assert.match(calls[1].ctx.systemPrompt, /THIS IS A RE-PLAN/);
  assert.match(calls[1].ctx.systemPrompt, /Split the header into two components\./);
  assert.match(calls[1].ctx.systemPrompt, /override your earlier judgement/);
  assert.equal(res.details.revisions, 2);
  assert.equal(res.details.approved, true);
  assert.match(res.output, /Add the header v2/);
});

test("create_plan: stops re-planning at the revision budget and labels the result", async () => {
  const { llm, calls } = makePlanner();
  const res = await createPlanTool({ maxRevisions: 2 }).execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, { planApproval: async () => ({ approved: false, comments: "nope" }) }),
  );

  // 1 initial draft + 2 revisions, then it stops rather than looping forever.
  assert.equal(calls.length, 3);
  assert.equal(res.details.approved, false);
  assert.equal(res.details.revisionBudgetExhausted, true);
  // The last draft is still returned — losing the work would be worse — but the
  // model is told it was never approved.
  assert.match(res.output, /review budget ran out/);
  assert.equal(res.details.planSet.plans[0].tasks.length, 2);
});

test("create_plan: per-step notes and attachments attach to the right step", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-attach-"));
  const mockup = path.join(dir, "header.png");
  await fs.writeFile(mockup, "not-really-a-png");

  const { llm } = makePlanner();
  const res = await createPlanTool().execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, {
      cwd: dir,
      planApproval: async () => ({
        // Approving AND attaching in one go — the common case; it must not cost
        // a wasted re-planning round.
        approved: true,
        stepEdits: [
          {
            taskId: "t1",
            notes: "Use the brand blue, not the default.",
            attachments: [{ path: "header.png", mimeType: "image/png", note: "target design" }],
          },
        ],
      }),
    }),
  );

  const [t1, t2] = res.details.planSet.plans[0].tasks;
  assert.equal(t1.userNotes, "Use the brand blue, not the default.");
  assert.equal(t1.attachments.length, 1);
  // Relative paths are resolved at review time, so execution never sees a
  // path that only turns out to be wrong minutes later.
  assert.equal(t1.attachments[0].path, mockup);
  assert.equal(t1.attachments[0].note, "target design");
  // The edit was scoped to t1 only.
  assert.equal(t2.userNotes, undefined);
  assert.equal(t2.attachments, undefined);
  assert.match(res.output, /USER INSTRUCTIONS FOR THIS STEP: Use the brand blue/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("create_plan: an unreadable attachment is dropped, not carried as a bad path", async () => {
  const { llm } = makePlanner();
  const logs = [];
  const res = await createPlanTool().execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, {
      log: (e) => logs.push(e),
      planApproval: async () => ({
        approved: true,
        stepEdits: [{ taskId: "t1", attachments: [{ path: "/nope/missing.png", mimeType: "image/png" }] }],
      }),
    }),
  );

  assert.equal(res.details.planSet.plans[0].tasks[0].attachments, undefined);
  assert.ok(logs.some((l) => l.message.includes("unreadable and was dropped")));
});

test("create_plan: a step edit for an unknown task is loudly logged, never silent", async () => {
  const { llm } = makePlanner();
  const logs = [];
  await createPlanTool().execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, {
      log: (e) => logs.push(e),
      planApproval: async () => ({ approved: true, stepEdits: [{ taskId: "nope", notes: "hi" }] }),
    }),
  );

  // Silently dropping a user's attachment is the worst possible outcome here.
  assert.ok(logs.some((l) => l.level === "warn" && l.message.includes('unknown task "nope"')));
});

test("create_plan: cancelling review yields no plan and says not to implement", async () => {
  const { llm } = makePlanner();
  const res = await createPlanTool().execute(
    "c1",
    { task: "add a header" },
    ctxFor(llm, { planApproval: async () => ({ approved: false, cancelled: true }) }),
  );

  assert.equal(res.isError, true);
  assert.match(res.output, /cancelled plan review/);
  assert.match(res.output, /do not start implementing/);
});

test("create_plan: auto-approves with no host callback (headless-safe)", async () => {
  const { llm, calls } = makePlanner();
  const res = await createPlanTool().execute("c1", { task: "add a header" }, ctxFor(llm));

  // A library run must never hang waiting for a reviewer that cannot answer.
  assert.equal(calls.length, 1);
  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.approved, false, "auto-approval is not a real approval");
  assert.equal(res.details.planSet.plans[0].tasks.length, 2);
});

test("create_plan: unparseable output is a clear error, not a silent empty plan", async () => {
  const { llm } = makePlanner(["I think we should probably start with the header component."]);
  const res = await createPlanTool().execute("c1", { task: "add a header" }, ctxFor(llm));

  assert.equal(res.isError, true);
  assert.match(res.output, /did not return parseable PLANS_JSON/);
  assert.match(res.output, /start with the header component/, "the raw output is quoted for diagnosis");
});

test("loop: a plan produced by the tool is surfaced on the loop result", async () => {
  const { llm } = makePlanner();
  // The model calls create_plan, then stops.
  let turn = 0;
  llm.stream = async function* () {
    const base = {
      role: "assistant", content: [], model: MODEL, api: "openrouter",
      provider: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
    yield { type: "start", partial: base };
    turn += 1;
    if (turn === 1) {
      yield {
        type: "done",
        message: {
          ...base, stopReason: "tool_use",
          content: [{ type: "toolCall", id: "p1", name: "create_plan", arguments: { task: "add a header" } }],
        },
      };
      return;
    }
    yield { type: "done", message: { ...base, content: [{ type: "text", text: "planned" }] } };
  };

  const result = await runToolLoop({
    task: "add a header",
    userMessage: "add a header",
    tools: [createPlanTool()],
    model: { id: MODEL, openRouterSlug: MODEL, input: ["text"], output: ["text"] },
    llm,
    permission: new PermissionGate("bypass"),
    logStore: new LogStore(),
    emit: () => {},
    cwd: os.tmpdir(),
    maxSteps: 5,
    planApproval: async () => ({ approved: true, stepEdits: [{ taskId: "t2", notes: "keep the import sorted" }] }),
  });

  assert.equal(result.error, undefined);
  // This is what lets the orchestrator execute a TOOL-authored plan.
  assert.ok(result.planSet, "the loop must surface the plan the tool produced");
  assert.equal(result.planSet.plans[0].tasks.length, 2);
  assert.equal(result.planSet.plans[0].tasks[1].userNotes, "keep the import sorted");
});

// ---------------------------------------------------------------------------
// Run attachments: a mockup the user attached to the RUN must reach the planner,
// and the planner must be able to route it to the one step that needs it. A
// mockup nobody told the planner about is a mockup that never gets built from.
// ---------------------------------------------------------------------------

/** A plan whose hero step claims one attachment by path. */
function planWithAttachment(attachPath) {
  return JSON.stringify({
    plans: [{
      id: "plan-1", title: "Landing page", summary: "hero + features",
      tasks: [
        {
          id: "t1", order: 1, title: "Design tokens", summary: "shared theme",
          files: ["src/tokens.css"], fileMutations: { "src/tokens.css": "write" },
          complexity: "low", verification: "tokens resolve",
        },
        {
          id: "t2", order: 2, title: "Hero section", summary: "build the hero from the mockup",
          files: ["src/Hero.tsx"], fileMutations: { "src/Hero.tsx": "write" },
          complexity: "high", verification: "matches mockup at 1440px",
          attachments: [{ path: attachPath, note: "the hero this step builds" }],
        },
      ],
    }],
    executionOrder: ["plan-1"],
  });
}

test("create_plan: files attached to the run are shown to the planner", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-attach-"));
  const mockup = path.join(dir, "hero.png");
  await fs.writeFile(mockup, "PNG");

  const { llm, calls } = makePlanner([planWithAttachment(mockup)]);
  const res = await createPlanTool().execute(
    "c1",
    { task: "build the landing page" },
    ctxFor(llm, { cwd: dir, images: [{ path: mockup, mimeType: "image/png" }] }),
  );

  const sent = calls[0].ctx.messages[0].content;
  assert.match(sent, /ATTACHMENTS/, "the planner is told what the user attached");
  assert.ok(sent.includes(mockup), "with the real path, so it can route it verbatim");
  assert.match(sent, /image\/png/);

  // And the routed attachment survives onto the step that claimed it.
  const tasks = res.details.planSet.plans[0].tasks;
  assert.equal(tasks[0].attachments, undefined, "tokens step gets no attachment");
  assert.equal(tasks[1].attachments.length, 1, "the hero step keeps its mockup");
  assert.equal(tasks[1].attachments[0].path, mockup);
  assert.match(res.output, /USER ATTACHED: .*hero\.png/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("create_plan: a retyped attachment path is repaired by basename", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-attach-fix-"));
  const mockup = path.join(dir, "hero.png");
  await fs.writeFile(mockup, "PNG");

  // The model wrote a plausible-but-wrong path — the usual LLM path drift.
  const { llm } = makePlanner([planWithAttachment("designs/hero.png")]);
  const res = await createPlanTool().execute(
    "c1",
    { task: "build the landing page" },
    ctxFor(llm, { cwd: dir, images: [{ path: mockup, mimeType: "image/png" }] }),
  );

  const hero = res.details.planSet.plans[0].tasks[1];
  assert.equal(hero.attachments.length, 1, "intent honoured rather than dropped");
  assert.equal(hero.attachments[0].path, mockup, "resolved to the file the run actually has");

  await fs.rm(dir, { recursive: true, force: true });
});

test("create_plan: an attachment path that exists nowhere is dropped, loudly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-attach-miss-"));
  const warnings = [];
  const { llm } = makePlanner([planWithAttachment("/nope/ghost.png")]);
  const res = await createPlanTool().execute(
    "c1",
    { task: "build the landing page" },
    ctxFor(llm, { cwd: dir, log: (e) => warnings.push(e) }),
  );

  assert.equal(res.details.planSet.plans[0].tasks[1].attachments, undefined);
  assert.ok(
    warnings.some((w) => w.level === "warn" && /unreadable/.test(w.message)),
    "a dropped attachment is never silent",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("create_plan: the caller can name extra attachments the run does not carry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-attach-arg-"));
  const spec = path.join(dir, "spec.md");
  await fs.writeFile(spec, "# spec");

  const { llm, calls } = makePlanner();
  await createPlanTool().execute(
    "c1",
    { task: "build it", attachments: ["spec.md"] },
    ctxFor(llm, { cwd: dir }),
  );

  const sent = calls[0].ctx.messages[0].content;
  assert.ok(sent.includes(spec), "a cwd-relative arg path is resolved and listed");
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The plan is the run's ledger: complexity per task drives model selection, and
// isCompleted is owned by the harness, not the model.
// ---------------------------------------------------------------------------

test("create_plan: a model that authors isCompleted:true does not get to lie", async () => {
  const forged = JSON.parse(planJson());
  forged.plans[0].tasks[0].isCompleted = true;
  const { llm } = makePlanner([JSON.stringify(forged)]);

  const res = await createPlanTool().execute("c1", { task: "x" }, ctxFor(llm));
  // The harness owns this field: a plan may not arrive with work pre-declared
  // done, however the planning model decorated its JSON.
  assert.deepEqual(res.details.planSet.plans[0].tasks.map((t) => t.isCompleted), [false, false]);
  assert.match(res.output, /1\. \[ \]/, "nothing is checked off before it runs");
});

test("create_plan: planning can be pinned to a stronger model than the loop", async () => {
  const { llm, calls } = makePlanner();
  await createPlanTool({ model: "test/strong-planner" }).execute("c1", { task: "x" }, ctxFor(llm));
  assert.equal(calls[0].model, "test/strong-planner", "config.model wins over the loop's model");

  // Unpinned, planning runs on the DEDICATED planner — not the loop's model.
  // Inheriting the driver here was the quiet failure: the one call where a weak
  // model costs the most (every later step inherits the decomposition) was the
  // one call with no model of its own.
  const { llm: llm2, calls: calls2 } = makePlanner();
  await createPlanTool().execute("c1", { task: "x" }, ctxFor(llm2));
  assert.equal(calls2[0].model, DEFAULT_PLAN_MODEL);
  assert.notEqual(calls2[0].model, MODEL, "the driver model is not the planner");
});

test("the default planning prompt covers end-to-end delivery, hero sites and animation", () => {
  // A plan that stops at "implement the feature" ships something nobody wired up.
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /COVER THE WHOLE JOB, END TO END/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /wiring that makes it reachable/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /Never write a step that defers work vaguely/);
  // Hero/product pages decompose by section, and animation has to be buildable.
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /decompose by SECTION/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /trigger \(page load, scroll position, hover, in-view\)/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /prefers-reduced-motion/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /design tokens\/theme the sections share/);
  // Attachments get routed, and isCompleted stays the harness's business.
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /Route each one to the step that needs it/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /Do NOT author "isCompleted"/);
});

test("the planner is told its plan is a review artifact, not a machine input", () => {
  // Without this the planner writes for an executor and the user reviews prose
  // that was never addressed to them — and it never learns that a step is the
  // unit a reviewer comments on and attaches files to.
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /REVIEWED BEFORE ANY OF IT RUNS/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /attach a file or a note to ONE step/);
  assert.match(DEFAULT_PLAN_SYSTEM_PROMPT, /architecture fork/);
});

test("planning defaults to the dedicated planner model", () => {
  assert.equal(DEFAULT_PLAN_MODEL, "tencent/hy3");
});
