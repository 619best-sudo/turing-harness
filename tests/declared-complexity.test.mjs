/**
 * Model-declared complexity + category on write/edit.
 *
 * The write half used to derive its escalation rating from `estimateComplexity`,
 * an arithmetic blend of tool count, context size and a flat `mutates` term. That
 * had two failures worth fixing:
 *
 *   1. `low` was UNREACHABLE for any mutation — the `mutates` term alone cleared
 *      the medium threshold — so every write escalated, forever.
 *   2. Which tier it landed in was driven by `contextChars`, i.e. by how long the
 *      session had been running rather than by how risky the write was.
 *
 * A write/edit call already carries the target path and the code, so the model can
 * rate the work inline at zero extra token cost (the read half must spend a rater
 * call, because there is nothing to judge until the bytes exist). These tests pin
 * that contract: a declaration is authoritative where present, a MEASURED rating
 * still floors it, absence changes nothing, and only the mutating file tools are
 * allowed to declare at all.
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
  OpenRouterBridge,
  PermissionGate,
  readTool,
  runToolLoop,
} from "../dist/index.js";

const ROUTING = {
  read: { medium: "deepseek/deepseek-v4-flash-0731", high: "openai/gpt-5.6-terra-pro" },
  write: { medium: "deepseek/deepseek-v4-flash-0731", high: "openai/gpt-5.6-terra" },
};

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

/**
 * Inert tools that exist only to make `toolCount` realistic. The arithmetic
 * estimate weights tool breadth at 0.3 * min(toolCount/12, 1); a fixture with a
 * single tool scores below the `medium` threshold even for a mutation, which is
 * not the situation any real run is in.
 */
const FILLER_TOOLS = Array.from({ length: 11 }, (_, i) => ({
  name: `noop${i}`,
  description: "inert",
  parameters: { type: "object", properties: {} },
  async execute() { return { output: "" }; },
}));

/**
 * Drive one mutating call through the loop and report what the escalation saw.
 * `args` is spread into the tool call, so a test controls exactly which
 * self-assessment fields the model "declared".
 */
async function callWith({
  tool = "write",
  args = {},
  measured,
  toolName,
  mutates = true,
} = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "declared-"));
  const target = path.join(tmp, args.path ?? "f.ts");
  await fs.writeFile(target, "old\n", "utf8");

  let seenAuthorModel = "(none)";
  const routeCalls = [];
  let permissionRating;

  const base = CODING_TOOLS.find((t) => t.name === tool);
  const stub = {
    ...base,
    ...(toolName ? { name: toolName } : {}),
    mutates,
    async execute(_id, a, ctx) {
      seenAuthorModel = ctx.authorModel?.openRouterSlug ?? ctx.authorModel?.id ?? "(none)";
      await fs.writeFile(a.path ?? target, "new\n");
      return { output: "ok" };
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
          [{
            type: "toolCall",
            id: "c1",
            name: stub.name,
            arguments: {
              path: target,
              content: "x",
              oldString: "old",
              newString: "new",
              ...args,
              path: target,
            },
          }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "done" }]) };
  };

  await runToolLoop({
    task: "t",
    userMessage: "go",
    // Padded to a realistic toolset. `toolBreadth` is 0.3 * min(toolCount/12, 1),
    // so with a mutation's flat 0.2 the arithmetic estimate crosses into `medium`
    // at ~6 tools. A one-tool fixture would sit at `low` and quietly test nothing.
    tools: [stub, ...FILLER_TOOLS],
    model: { id: "base/model", openRouterSlug: "base/model" },
    llm,
    permission: new PermissionGate("ask-all", async (req) => {
      permissionRating = req.complexityRating;
      return { allowed: true };
    }),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
    routeModel: (input) => {
      routeCalls.push(input);
      return ROUTING[input.kind]?.[input.rating];
    },
    ...(measured ? { complexityByPath: { [target]: measured }, complexitySource: "plan-task" } : {}),
  });

  return { seenAuthorModel, routeCalls, permissionRating, target };
}

// ---------------------------------------------------------------------------
// The declaration decides the tier
// ---------------------------------------------------------------------------

test("a declared `low` write is not escalated — the case the arithmetic could not express", async () => {
  // This is the headline fix. `estimateComplexity` gives every mutation >= 0.33,
  // so before this change a trivial one-line edit was routed to an escalation
  // model unconditionally. A model that says "this is mechanical" is now believed.
  const { seenAuthorModel } = await callWith({ args: { complexity: "low", category: "code" } });
  assert.equal(seenAuthorModel, "(none)");
});

test("a declared `high` write is authored by the model the table names for high", async () => {
  const { seenAuthorModel } = await callWith({ args: { complexity: "high", category: "code" } });
  assert.equal(seenAuthorModel, "openai/gpt-5.6-terra");
});

test("a declared `medium` write lands on the medium tier, not high", async () => {
  // Guards against the old contextChars behavior, where a long session pushed
  // every write to the most expensive model regardless of the work.
  const { seenAuthorModel } = await callWith({ args: { complexity: "medium", category: "code" } });
  assert.equal(seenAuthorModel, "deepseek/deepseek-v4-flash-0731");
});

test("an edit declares its complexity the same way a write does", async () => {
  const { seenAuthorModel } = await callWith({
    tool: "edit",
    args: { complexity: "high", category: "code" },
  });
  assert.equal(seenAuthorModel, "openai/gpt-5.6-terra");
});

// ---------------------------------------------------------------------------
// Absence and garbage both fall back — this is why no feature flag is needed
// ---------------------------------------------------------------------------

test("omitting the fields leaves the arithmetic estimate in charge", async () => {
  // The fields are optional, so a model that has never heard of them behaves
  // exactly as before: a mutation still escalates off the arithmetic score.
  const { seenAuthorModel, routeCalls } = await callWith({ args: {} });
  assert.notEqual(seenAuthorModel, "(none)", "absence must not disable escalation");
  assert.equal(routeCalls.at(-1).category, undefined, "no category is asserted when none was declared");
});

test("an unparseable rating is ignored rather than trusted", async () => {
  // A model that emits "very high" or "3" must not be able to produce an
  // out-of-range rating; it degrades to the arithmetic path.
  const { seenAuthorModel } = await callWith({ args: { complexity: "very high" } });
  assert.notEqual(seenAuthorModel, "(none)");
});

test("an unparseable category is dropped without dropping the rating", async () => {
  const { seenAuthorModel, routeCalls } = await callWith({
    args: { complexity: "high", category: "artwork" },
  });
  assert.equal(seenAuthorModel, "openai/gpt-5.6-terra", "the valid rating still applies");
  assert.equal(routeCalls.at(-1).category, undefined, "the invalid category is not forwarded");
});

// ---------------------------------------------------------------------------
// Measured evidence outranks self-report
// ---------------------------------------------------------------------------

test("a measured `high` cannot be talked down by a declared `low`", async () => {
  // The anti-gaming rule. A rating produced by a tool that actually read the file
  // is evidence; a self-report is not. So the floor still wins downward.
  const { seenAuthorModel } = await callWith({
    args: { complexity: "low", category: "code" },
    measured: "high",
  });
  assert.equal(seenAuthorModel, "openai/gpt-5.6-terra");
});

test("a declared `high` still raises above a measured `medium`", async () => {
  // Upward is allowed: the model may know something about the task that a read of
  // the file alone could not reveal.
  const { seenAuthorModel } = await callWith({
    args: { complexity: "high", category: "code" },
    measured: "medium",
  });
  assert.equal(seenAuthorModel, "openai/gpt-5.6-terra");
});

// ---------------------------------------------------------------------------
// Only the mutating file tools may declare
// ---------------------------------------------------------------------------

test("a non-mutating tool's `complexity` argument cannot steer routing", async () => {
  // Otherwise any MCP tool that happens to take an unrelated `complexity`
  // argument would silently rewrite the run's escalation decisions.
  const { permissionRating } = await callWith({
    args: { complexity: "high" },
    mutates: false,
  });
  assert.equal(permissionRating, "low", "the declaration must not reach the permission gate");
});

test("a mutating tool that is not write/edit may not declare either", async () => {
  // `canDeclareComplexity` is keyed on the tool NAME, not just on `mutates`,
  // because only write and edit carry the code in their arguments.
  const { routeCalls } = await callWith({
    args: { complexity: "high", category: "svg" },
    toolName: "deploy",
  });
  assert.equal(routeCalls.length, 0, "a non-authoring tool never consults the write table");
});

// ---------------------------------------------------------------------------
// Category threading
// ---------------------------------------------------------------------------

test("the declared category reaches the host's router alongside the rating", async () => {
  const { routeCalls } = await callWith({ args: { complexity: "high", category: "ui" } });
  const call = routeCalls.at(-1);
  assert.equal(call.kind, "write");
  assert.equal(call.rating, "high");
  assert.equal(call.category, "ui", "the host needs this to pick a model with eyes");
});

test("category is orthogonal to rating — a low-rated ui write still does not escalate", async () => {
  // Category says what the escalation model must be good at, never whether to
  // escalate. Conflating them would make every styling tweak expensive.
  const { seenAuthorModel } = await callWith({ args: { complexity: "low", category: "ui" } });
  assert.equal(seenAuthorModel, "(none)");
});

// ---------------------------------------------------------------------------
// Attachments: "here is the mockup, build it"
// ---------------------------------------------------------------------------

/**
 * Drive the REAL write tool (not a stub) so the tool-internal authoring
 * escalation runs, and report which model actually authored the bytes.
 */
async function authorWith({ declared, category, withImage, measured, routeModel, onRoute }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "declared-img-"));
  const target = path.join(tmp, "Panel.tsx");
  const img = path.join(tmp, "mock.png");
  await fs.writeFile(target, "old\n", "utf8");
  await fs.writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let authoredBy = "(none)";
  const llm = new OpenRouterBridge();
  llm.complete = async (model) => {
    authoredBy = model.openRouterSlug ?? model.id;
    return msg([{ type: "text", text: "authored\n" }]);
  };
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      yield {
        type: "done",
        message: msg(
          [{
            type: "toolCall", id: "w1", name: "write",
            arguments: {
              path: target, content: "draft",
              ...(declared ? { complexity: declared } : {}),
              ...(category ? { category } : {}),
              ...(withImage ? { images: [img] } : {}),
            },
          }],
          "tool_use",
        ),
      };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  await runToolLoop({
    task: "build the panel from the mockup",
    userMessage: "go",
    tools: [CODING_TOOLS.find((t) => t.name === "write"), ...FILLER_TOOLS],
    // Text-only, like the real driver: it physically cannot read the mockup.
    model: { id: "xiaomi/mimo-v2.5", openRouterSlug: "xiaomi/mimo-v2.5", input: ["text"], output: ["text"] },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
    toolModelCandidates: [
      "deepseek/deepseek-v4-flash-0731",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-terra-pro",
    ],
    routeModel: (input) => {
      onRoute?.(input);
      if (routeModel) return routeModel(input);
      const { kind, rating, category: cat } = input;
      return (
        { "write.ui.high": "openai/gpt-5.6-terra-pro", "write.svg.high": "openai/gpt-5.6-terra-pro" }[
          `${kind}.${cat}.${rating}`
        ] ?? ROUTING[kind]?.[rating]
      );
    },
    ...(measured ? { complexityByPath: { [target]: measured }, complexitySource: "plan-task" } : {}),
  });

  return { authoredBy, onDisk: await fs.readFile(target, "utf8") };
}

/** The last routing input the loop/tool produced for one write call. */
async function routeInputFor(opts) {
  const seen = [];
  await authorWith({ ...opts, onRoute: (i) => seen.push(i) });
  return seen.at(-1) ?? {};
}

test("a declared `low` cannot drop an image-bearing write back to the driver", async () => {
  // The failure this prevents: the driver is TEXT-ONLY, so authoring on it would
  // write its own wordy draft and lose the mockup entirely — "here is the design,
  // build it" silently becoming "build it from the words". An attachment floors
  // the rating at medium for exactly this reason.
  const { authoredBy, onDisk } = await authorWith({
    declared: "low", category: "ui", withImage: true,
  });
  assert.notEqual(authoredBy, "(none)", "an image-bearing write must still be authored");
  assert.notEqual(authoredBy, "xiaomi/mimo-v2.5", "never author a mockup on a text-only model");
  assert.equal(onDisk, "authored\n", "the authored bytes reach disk, not the draft");
});

test("an image-bearing write is authored by a model that can actually see", async () => {
  const { authoredBy } = await authorWith({ declared: "low", category: "ui", withImage: true });
  const { resolveModel } = await import("../dist/index.js");
  assert.ok(
    resolveModel(authoredBy).input?.includes("image"),
    `${authoredBy} must accept image input`,
  );
});

test("a vision escalation honours the host's category table instead of pool order", async () => {
  // Before this, `resolveAuthorModel` fell straight through to `selectModel` over
  // the candidate pool, so the case where category matters MOST — build this UI
  // from a mockup — picked by pool ORDER and ignored the stated policy.
  const { authoredBy } = await authorWith({ declared: "high", category: "ui", withImage: true });
  assert.equal(authoredBy, "openai/gpt-5.6-terra-pro", "the write.ui.high override must win");
});

test("without images a declared `low` still writes the draft directly", async () => {
  // The floor is specific to attachments. A genuinely mechanical text edit must
  // stay on the cheap path — that is the whole cost win.
  const { authoredBy, onDisk } = await authorWith({
    declared: "low", category: "code", withImage: false,
  });
  assert.equal(authoredBy, "(none)", "no authoring call at all");
  assert.equal(onDisk, "draft", "the driver's own bytes land on disk");
});

test("the attachment axis reaches the host router as hasAttachment", async () => {
  // The third axis has to be independently visible to the host, not folded into
  // the rating — a host may want a different model for the same rating and
  // category once there is a design to match.
  const withImg = await routeInputFor({ declared: "high", category: "ui", withImage: true });
  const without = await routeInputFor({ declared: "high", category: "ui", withImage: false });
  assert.equal(withImg.hasAttachment, true);
  assert.ok(!without.hasAttachment, "no attachment must not assert the axis");
  // The other two axes still arrive alongside it, so the host sees a full cell.
  assert.equal(withImg.rating, "high");
  assert.equal(withImg.category, "ui");
});

test("all three axes are independently visible for one call", async () => {
  const seen = await routeInputFor({ declared: "medium", category: "svg", withImage: true });
  assert.deepEqual(
    { kind: seen.kind, rating: seen.rating, category: seen.category, hasAttachment: seen.hasAttachment },
    { kind: "write", rating: "medium", category: "svg", hasAttachment: true },
  );
});

test("a host can route the same rating+category differently on attachment alone", async () => {
  // The point of the axis: identical rating and category, different model, decided
  // only by whether a design was supplied.
  const table = ({ hasAttachment }) => (hasAttachment ? "vendor/with-eyes-pro" : "vendor/plain");
  const a = await authorWith({ declared: "high", category: "ui", withImage: true, routeModel: table });
  const b = await authorWith({ declared: "high", category: "ui", withImage: false, routeModel: table });
  assert.equal(a.authoredBy, "vendor/with-eyes-pro");
  assert.equal(b.authoredBy, "vendor/plain");
});

// ---------------------------------------------------------------------------
// The read half infers its category from the path
// ---------------------------------------------------------------------------

test("a read infers its category from the extension and forwards it", async () => {
  // A read has no declaration available and asking for one would cost a second
  // rater call, so extension inference is the floor. `.tsx` -> ui, `.svg` -> svg,
  // everything else -> code.
  const cases = [["Panel.tsx", "ui"], ["icon.svg", "svg"], ["queue.ts", "code"]];
  for (const [name, expected] of cases) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declared-read-"));
    const file = path.join(dir, name);
    // >= 40 substantive lines, so `looksTrivial` does not short-circuit.
    await fs.writeFile(
      file,
      Array.from({ length: 60 }, (_, i) => `export function fn${i}(a){ return acquire(a) ? release(a,${i}) : retry(a); }`).join("\n"),
      "utf8",
    );

    const llm = new OpenRouterBridge();
    llm.complete = async () => msg([{ type: "text", text: "RATING: high | WHY: dense" }]);

    const routeCalls = [];
    await readTool.execute("r1", { path: file }, {
      cwd: dir,
      model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
      llm,
      log: () => {},
      routeModel: (input) => {
        routeCalls.push(input);
        return ROUTING[input.kind]?.[input.rating];
      },
    });

    assert.equal(routeCalls.at(-1)?.category, expected, `${name} should be ${expected}`);
  }
});

test("svg is no longer auto-classified as trivial data", async () => {
  // `.svg` used to sit in TRIVIAL_EXTENSIONS, which auto-rated it `low` so hand
  // edited vector markup could never escalate — inconsistent with svg being a
  // first-class escalation category. Generated single-line SVG is still filtered
  // by the line-count check.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declared-svg-"));
  const file = path.join(dir, "chart.svg");
  await fs.writeFile(
    file,
    `<svg viewBox="0 0 100 100">\n${Array.from({ length: 60 }, (_, i) => `  <path d="M${i} 0 L${i} 99 Z" fill="#0${i % 10}0"/>`).join("\n")}\n</svg>`,
    "utf8",
  );

  let rated = false;
  const llm = new OpenRouterBridge();
  llm.complete = async () => {
    rated = true;
    return msg([{ type: "text", text: "RATING: high | WHY: geometry is load-bearing" }]);
  };

  const res = await readTool.execute("r1", { path: file }, {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    routeModel: ({ kind, rating }) => ROUTING[kind]?.[rating],
  });

  assert.ok(rated, "a multi-line svg must reach the rater");
  assert.equal(res.measuredComplexity, "high");
});

test("a single-line generated svg is still skipped for free", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declared-svg-gen-"));
  const file = path.join(dir, "sprite.svg");
  await fs.writeFile(file, `<svg>${"<path d='M0 0'/>".repeat(400)}</svg>`, "utf8");

  let calls = 0;
  const llm = new OpenRouterBridge();
  llm.complete = async () => { calls += 1; return msg([{ type: "text", text: "RATING: high" }]); };

  await readTool.execute("r1", { path: file }, {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    routeModel: ({ kind, rating }) => ROUTING[kind]?.[rating],
  });

  assert.equal(calls, 0, "one long line is machine output; it must not cost a rater call");
});
