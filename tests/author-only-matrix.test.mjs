/**
 * The `authorOnlyWrites` invariant, swept across the axes that can break it.
 *
 * The contract the host is relying on:
 *   1. EVERY file-mutating call authors through Model B — at low, medium and high
 *      complexity alike. `low` is the dangerous one: it is excluded from routing
 *      by design, so it authors on the driver model via `driver-fallback` and is
 *      the case a slug-keyed gate silently starved.
 *   2. Every such call reaches the author WITH CONTEXT — a task at minimum.
 *      Authoring without intent is worse than not authoring: the model invents a
 *      change and the file drifts.
 *   3. The DRIVER never supplies the bytes. Under this mode the schema gives it
 *      nowhere to put them, which is the structural half of the guarantee.
 *   4. Both run shapes work: planless (`skipPlan: true`, the agent default) and
 *      planned (per-step authoring intent).
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
  Orchestrator,
  PermissionGate,
  Registry,
  registerBuiltins,
  runToolLoop,
} from "../dist/index.js";

const RATINGS = ["low", "medium", "high"];

const SEED = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Realistic Solar System Animation</title>
</head>
<body><canvas id="c"></canvas></body>
</html>
`;

const AUTHORED = "<title>ToottyFruity</title>";
const INTENT = "Change the page title to ToottyFruity";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

/** Route every non-low rating somewhere, so medium/high take the escalated path. */
const routeModel = ({ kind, rating }) =>
  kind === "write" && rating !== "low" ? `author/${rating}` : undefined;

/**
 * Drive ONE mutating call through the real loop with the real (content-less)
 * coding tools, and report what the authoring pass saw and what hit disk.
 */
async function runMutation({ toolName, rating, useRouter = true }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `matrix-${toolName}-${rating}-`));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, SEED);

  const authorPrompts = [];
  const authorModels = [];

  const llm = new OpenRouterBridge();
  // `complete` is the authoring pass (and only that, in this run).
  llm.complete = async (model, ctx) => {
    const c = ctx.messages[0]?.content;
    authorModels.push(model.openRouterSlug ?? model.id);
    authorPrompts.push(
      typeof c === "string"
        ? c
        : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    );
    return {
      role: "assistant",
      content: [{ type: "text", text: toolName === "write" ? `${AUTHORED}\n` : AUTHORED }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  // The driver emits ONLY the path (+ anchor). No content/newString exists in
  // the schema, so it has no way to supply bytes even if it tried.
  const args =
    toolName === "write"
      ? { path: target }
      : { path: target, oldString: "<title>Realistic Solar System Animation</title>" };

  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield { type: "done", message: msg([{ type: "toolCall", id: "c1", name: toolName, arguments: args }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  let seenContext;
  const tools = createCodingTools({ authorOnlyWrites: true })
    .filter((t) => t.name === toolName)
    .map((t) => ({
      ...t,
      async execute(id, a, ctx) {
        seenContext = ctx.authoringContext ?? null;
        return t.execute(id, a, ctx);
      },
    }));

  await runToolLoop({
    task: INTENT,
    userMessage: "go",
    tools,
    model: { id: "driver/model", openRouterSlug: "driver/model" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    ...(useRouter ? { routeModel } : {}),
    complexityByPath: { [target]: rating },
    complexitySource: "plan-task",
  });

  return {
    context: seenContext,
    authorPrompts,
    authorModels,
    onDisk: await fs.readFile(target, "utf8"),
  };
}

// ---------------------------------------------------------------------------
// 1 + 2 + 3. Every mutating tool, every rating.
// ---------------------------------------------------------------------------

for (const toolName of ["write", "edit"]) {
  for (const rating of RATINGS) {
    test(`${toolName} @ ${rating}: authors through Model B, with the task in hand`, async () => {
      const r = await runMutation({ toolName, rating });

      assert.equal(r.authorPrompts.length, 1, "exactly one authoring pass ran");
      assert.ok(r.context, "an authoring context was assembled");
      assert.match(r.context.task, /ToottyFruity/, "the intent reached the tool");
      assert.match(r.authorPrompts[0], /TASK:/, "the prompt carries a TASK section");
      assert.match(r.authorPrompts[0], /ToottyFruity/, "the intent reached the AUTHOR");
      assert.match(r.onDisk, /ToottyFruity/, "the author's bytes are what hit disk");
    });
  }
}

test("medium and high escalate to the routed slug", async () => {
  assert.deepEqual((await runMutation({ toolName: "edit", rating: "medium" })).authorModels, ["author/medium"]);
  assert.deepEqual((await runMutation({ toolName: "edit", rating: "high" })).authorModels, ["author/high"]);
});

test("a LOW call authors on the PER-CALL selected model, not the loop's driver model", async () => {
  // Worth pinning because it is easy to misread. `driver-fallback` names the
  // *reason*, not the model: the tool authors on `ctx.model`, which the loop set
  // from `selectModel` for this call — NOT `input.model`. With no
  // `toolModelCandidates` that resolves to the cheapest COMPLEXITY_TIERS entry.
  //
  // Consequence for a host: under `authorOnlyWrites`, low-rated writes are
  // authored by the cheap tier unless the host supplies `toolModelCandidates` or
  // routes `low` explicitly. They ARE authored — nothing slips through
  // unauthored — but not necessarily by the model the host had in mind.
  const r = await runMutation({ toolName: "edit", rating: "low" });
  assert.equal(r.authorPrompts.length, 1, "low still authors");
  assert.notDeepEqual(r.authorModels, ["author/low"], "low is not routed");
  assert.notDeepEqual(r.authorModels, ["driver/model"], "and it is not the loop's driver model either");
  assert.match(r.onDisk, /ToottyFruity/);
});

test("with NO router configured, every rating still authors — none slips through unauthored", async () => {
  // A host that sets authorOnlyWrites but forgets routeModel must still get
  // authored bytes on every call, not a silent passthrough to an unauthored write.
  for (const rating of RATINGS) {
    const r = await runMutation({ toolName: "edit", rating, useRouter: false });
    assert.equal(r.authorPrompts.length, 1, `${rating} authored`);
    assert.match(r.authorPrompts[0], /ToottyFruity/, `${rating} author had the intent`);
    assert.match(r.onDisk, /ToottyFruity/, `${rating} wrote authored bytes`);
  }
});

// ---------------------------------------------------------------------------
// 3. The driver structurally cannot supply bytes.
// ---------------------------------------------------------------------------

test("the content-less schemas give the driver nowhere to put code", async () => {
  const tools = createCodingTools({ authorOnlyWrites: true });
  const write = tools.find((t) => t.name === "write");
  const edit = tools.find((t) => t.name === "edit");

  assert.ok(!("content" in write.parameters.properties), "write has no content field");
  assert.deepEqual(write.parameters.required, ["path"]);
  assert.ok(!("newString" in edit.parameters.properties), "edit has no newString field");
  assert.deepEqual(edit.parameters.required, ["path", "oldString"]);
});

test("a driver that smuggles content anyway is ignored — the author still writes the bytes", async () => {
  // Schemas are advisory to a model that ignores them. Even given `content`,
  // the authored text must win, or "the orchestrator never writes code" is only
  // true for well-behaved drivers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-smuggle-"));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, SEED);

  const llm = new OpenRouterBridge();
  llm.complete = async (model) => ({
    role: "assistant", content: [{ type: "text", text: "<title>ToottyFruity</title>" }],
    model: model.id, api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });

  const edit = createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit");
  await edit.execute(
    "c1",
    {
      path: target,
      oldString: "<title>Realistic Solar System Animation</title>",
      newString: "<title>DRIVER WROTE THIS</title>", // smuggled past the schema
    },
    { cwd: dir, llm, model: { id: "driver/model" }, authoringContext: { task: INTENT }, log: () => {} },
  );

  const onDisk = await fs.readFile(target, "utf8");
  assert.match(onDisk, /ToottyFruity/, "the author's bytes won");
  assert.doesNotMatch(onDisk, /DRIVER WROTE THIS/, "the driver's draft never reached disk");
});

// ---------------------------------------------------------------------------
// 4. Both run shapes.
// ---------------------------------------------------------------------------

/** Run the orchestrator over one edit and report the authoring task the tool saw. */
async function runOrchestrated({ skipPlan }) {
  // v2: `skipPlan` no longer gates a planning turn (create_plan always runs in
  // write_edit); both shapes exercise the same chain here.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `matrix-orch-${skipPlan}-`));
  const target = path.join(dir, "index.html");
  await fs.writeFile(target, SEED);

  let seenTask = null;
  let seenPlanJson = null;
  const spyEdit = {
    ...createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit"),
    async execute(_id, _a, ctx) {
      seenTask = ctx.authoringContext?.task ?? null;
      seenPlanJson = ctx.authoringContext?.planJson ?? null;
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
      return {
        role: "assistant", content: [{ type: "text", text: `PLANS_JSON:\n${JSON.stringify({
          plans: [{
            id: "p1", title: "Rename the page title", summary: INTENT,
            tasks: [{
              id: "t1", order: 1, title: "Rename the page title",
              summary: "Set the document title to ToottyFruity",
              files: [target], fileMutations: { [target]: "edit" }, complexity: "low",
              verification: "the title reads ToottyFruity",
            }],
          }],
          executionOrder: ["p1"],
        })}` }],
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
    // v2 write_edit: plan → edit → deliver.
    if (turn === 1) {
      yield { type: "done", message: msg([{ type: "toolCall", id: "p1", name: "create_plan", arguments: { task: INTENT } }], "tool_use") };
      return;
    }
    if (turn === 2) {
      yield { type: "done", message: msg([{
        type: "toolCall", id: "e1", name: "edit",
        arguments: { path: target, oldString: "<title>Realistic Solar System Animation</title>" },
      }], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "toolCall", id: "d1", name: "deliver", arguments: { writes: [{ tool: "edit", path: target }], notes: "done" } }], "tool_use") };
  };

  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore(), authorOnlyWrites: true });
  const orch = new Orchestrator({
    cwd: dir, llm, registry,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    models: { plan: "test/cheap", perform: "test/cheap" },
  });
  // The spy edit replaces the registered one for this run's write_edit hop.
  orch.setCategorizerTools("write_edit", [spyEdit, registry.getTool("create_plan"), registry.getTool("deliver")].filter(Boolean));

  await orch.run(INTENT, { skipPlan });
  return { seenTask, seenPlanJson };
}

test("planless (the agent default) hands the author the run task", async () => {
  const { seenTask } = await runOrchestrated({ skipPlan: true });
  assert.ok(seenTask, "planless builds an authoring context");
  assert.match(seenTask, /ToottyFruity/);
});

test("planned mode hands the author the plan's tasks, not just the run task", async () => {
  const { seenTask, seenPlanJson } = await runOrchestrated({ skipPlan: false });
  assert.ok(seenTask, "planned mode builds an authoring context");
  assert.match(seenTask, /ToottyFruity/);
  assert.ok(Array.isArray(seenPlanJson) && seenPlanJson.length, "the plan's tasks reach the author");
});

// ---------------------------------------------------------------------------
// 5. The shell must not author files behind the authoring model's back.
//
// `authorOnlyWrites` only ever swapped the write/edit SCHEMAS, so its guarantee
// held only while the driver chose those tools. `bash` is `mutates: true` and
// ships in the same toolset: a heredoc wrote source with no authoring pass, no
// task context, and no record. These pin the guard, and — just as important —
// pin what it must NOT block, since an over-eager filter breaks every build.
// ---------------------------------------------------------------------------

async function runBash(command, { authorOnly = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-bash-"));
  const bash = createCodingTools({ authorOnlyWrites: authorOnly }).find((t) => t.name === "bash");
  const res = await bash.execute("b1", { command }, { cwd: dir, log: () => {} });
  return { res, dir };
}

const BLOCKED = [
  ["heredoc", "cat > src/app.ts <<'EOF'\nconsole.log(1)\nEOF"],
  ["truncating redirect", "echo '<h1>hi</h1>' > index.html"],
  ["appending redirect", "echo 'body{}' >> styles/main.css"],
  ["in-place edit", "sed -i 's/a/b/' src/index.ts"],
  ["tee", "echo x | tee src/config.json"],
  ["python inline write", `python3 -c "open('src/gen.py','w').write('x')"`],
  ["python pathlib write_text", `python3 << 'EOF'\nfrom pathlib import Path\nPath("src/app.ts").write_text("x")\nEOF`],
  ["python pathlib write_bytes", `python3 -c "from pathlib import Path; Path('lib/a.dart').write_bytes(b'x')"`],
  ["hidden in a chain", "npm run build && cat > src/late.tsx <<'EOF'\nx\nEOF"],
];

for (const [label, command] of BLOCKED) {
  test(`bash refuses to author source via ${label}`, async () => {
    const { res } = await runBash(command);
    assert.ok(res.isError, `${label} was blocked`);
    assert.match(res.output, /refusing to author file contents/);
    assert.match(res.output, /`write` or `edit`/, "the driver is told where to go instead");
  });
}

const ALLOWED = [
  ["build with a log redirect", "npm run build > build.log"],
  ["test output to a txt file", "npm test > /tmp/out.txt"],
  ["install", "npm install"],
  ["mkdir", "mkdir -p src/components"],
  ["remove a source file", "rm -f src/old.ts"],
  ["move a source file", "mv src/a.ts src/b.ts"],
  ["git commit", "git add -A && git commit -m 'x'"],
  ["read a source file", "cat src/index.ts"],
  ["grep source", "grep -rn 'foo' src/*.ts"],
];

for (const [label, command] of ALLOWED) {
  test(`bash still allows ${label}`, async () => {
    const { res } = await runBash(command);
    // The command itself may fail in a temp dir; what matters is that it was not
    // refused by the guard.
    assert.doesNotMatch(res.output ?? "", /refusing to author file contents/, `${label} was not blocked`);
  });
}

test("the guard is scoped to author-only mode — default bash is unrestricted", async () => {
  const { res } = await runBash("cat > src/app.ts <<'EOF'\nx\nEOF", { authorOnly: false });
  assert.doesNotMatch(res.output ?? "", /refusing to author file contents/);
});

test("a blocked shell write leaves nothing on disk", async () => {
  const { res, dir } = await runBash("cat > index.html <<'EOF'\n<title>DRIVER WROTE THIS</title>\nEOF");
  assert.ok(res.isError);
  assert.deepEqual(await fs.readdir(dir), [], "no file was created");
});

// ---------------------------------------------------------------------------
// 6. Logging is not an edit.
//
// There WAS a `probe` argument on author-only `edit`, so instrumenting had a channel
// in a mode whose schema drops `newString`. `add_log` replaced it: same anchor shape,
// no authoring model, no verification debt, and refused outright if the replacement
// changes code (see activity-monitor.test.mjs). That keeps `edit` exactly as it was
// in both modes — the point of moving logging out.
//
// What remains here is the guarantee that matters if a log ever DOES arrive through
// `edit`: it must not be handed to the authoring model.
// ---------------------------------------------------------------------------

const DART_SEED = `void reload() {
  final leads = fetch();
  render(leads);
}
`;

test("author-only `edit` has no `probe` channel — logging is `add_log`'s job", async () => {
  const authorOnly = createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "edit");
  const normal = createCodingTools().find((t) => t.name === "edit");
  assert.equal(authorOnly.parameters.properties.probe, undefined, "no bolted-on probe argument");
  assert.equal(authorOnly.parameters.properties.newString, undefined, "and newString stays dropped");
  assert.ok(normal.parameters.properties.newString, "default mode is untouched");
  assert.equal(normal.parameters.properties.probe, undefined);
  assert.match(authorOnly.description, /add_log/, "the description points at the right tool");
});

test("DEFAULT mode: a probe `newString` is NOT handed to a pinned authoring model", async () => {
  // The break this pins: `resolveAuthorModel` honours `ctx.authorModel` regardless
  // of author-only, and an authoring pass DISCARDS `newString` and writes from the
  // anchor + task. So on a host with authorModel pinned, a probe edit would land an
  // authored FIX — the reproduce gate's instrumentation exemption turned into a
  // channel for the unobserved fix it exists to refuse, with the trace it was
  // setting up collecting nothing.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-probe-pinned-"));
  const target = path.join(dir, "a.dart");
  await fs.writeFile(target, DART_SEED);

  let authored = 0;
  const llm = new OpenRouterBridge();
  llm.complete = async (model) => {
    authored += 1;
    return {
      role: "assistant", content: [{ type: "text", text: "  render(leads ?? []); // AUTHORED FIX" }],
      model: model.id, api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  const edit = createCodingTools().find((t) => t.name === "edit");
  const ctx = {
    cwd: dir, llm, model: { id: "driver/model" },
    authorModel: { id: "author/model" }, // host-pinned: authoring is ON in default mode
    authoringContext: { task: "fix the reload bug" }, log: () => {},
  };

  const probe = await edit.execute("c1", {
    path: target,
    oldString: "  render(leads);",
    newString: '  render(leads);\n  console.log("TURING_TRACE rendered");',
  }, ctx);
  assert.equal(probe.isError, undefined);
  assert.equal(authored, 0, "a probe edit skips authoring in default mode too");
  const afterProbe = await fs.readFile(target, "utf8");
  assert.match(afterProbe, /console\.log\("TURING_TRACE rendered"\);/, "the probe landed verbatim");
  assert.doesNotMatch(afterProbe, /AUTHORED FIX/, "no fix was authored over the probe");

  // ...and an ORDINARY edit on the same host still authors, as it must.
  const real = await edit.execute("c2", {
    path: target, oldString: "  final leads = fetch();", newString: "  final leads = fetchAll();",
  }, ctx);
  assert.equal(real.isError, undefined);
  assert.equal(authored, 1, "the authoring path is intact for real changes");
  assert.match(real.output, /authored by author\/model/);
});
