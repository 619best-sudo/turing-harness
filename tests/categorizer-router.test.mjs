/**
 * The categorizer router: choice parsing, fallback behavior, and the heuristic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeCategorizer, heuristicRoute, DEFAULT_CATEGORIZER_SETUP, entryCategories } from "../dist/index.js";

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

const MODEL = { id: "test/router", openRouterSlug: "test/router" };

function bridge(reply) {
  return {
    resolveModel: () => MODEL,
    async complete(_m, ctx) {
      const text = typeof reply === "function" ? reply(ctx) : reply;
      return {
        role: "assistant", content: [{ type: "text", text }],
        model: "test/router", api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    },
  };
}

const baseInput = (over = {}) => ({
  setup: DEFAULT_CATEGORIZER_SETUP,
  choices: entryCategories(DEFAULT_CATEGORIZER_SETUP),
  task: "build me a landing page",
  hops: [],
  llm: bridge("CATEGORY: write_edit"),
  model: MODEL,
  ...over,
});

test("parses the CATEGORY line and picks the categorizer", async () => {
  const r = await routeCategorizer(baseInput());
  assert.equal(r.selection, "write_edit");
  assert.equal(r.fallback, false);
});

test("summarise ends the chain", async () => {
  const r = await routeCategorizer(baseInput({ llm: bridge("CATEGORY: summarise") }));
  assert.equal(r.selection, "summarise");
});

test("an unparseable reply falls back to the heuristic, never throws", async () => {
  const r = await routeCategorizer(baseInput({ llm: bridge("I think we should probably write code?") }));
  assert.equal(r.fallback, true);
  assert.ok(["read", "write_edit", "activity_inspect", "conversation", "summarise"].includes(r.selection));
});

test("a transport error falls back to the heuristic", async () => {
  const llm = {
    resolveModel: () => MODEL,
    async complete() { throw new Error("endpoint down"); },
  };
  const r = await routeCategorizer(baseInput({ llm }));
  assert.equal(r.fallback, true);
});

test("the router prompt renders every choice with its contract", async () => {
  let seen = "";
  const llm = bridge((ctx) => {
    seen = ctx.messages?.[0]?.content ?? "";
    return "CATEGORY: read";
  });
  const r = await routeCategorizer(baseInput({ llm, task: "explain the repo layout" }));
  assert.equal(r.selection, "read");
  for (const id of ["conversation", "read", "write_edit", "activity_inspect", "summarise"]) {
    assert.ok(seen.includes(id), `${id} is offered`);
  }
  // Each choice carries its DELIVERS contract, so selection is informed.
  assert.match(seen, /delivers: /);
});

test("heuristic: chat-shaped input stays conversational", () => {
  const r = heuristicRoute(baseInput({ task: "hi, thanks for the help earlier!" }));
  assert.equal(r, "conversation");
});

test("heuristic: work-shaped input routes read-first (gather before mutate)", () => {
  const r = heuristicRoute(baseInput({ task: "add a /health endpoint to the server" }));
  assert.equal(r, "read");
});

test("heuristic: after a write hop, inspect when verification is on", () => {
  const hops = [{ id: "write_edit", index: 0, summary: "wrote", delivered: true, toolRecords: [], writtenPaths: ["a"], readPaths: [] }];
  assert.equal(heuristicRoute(baseInput({ hops, choices: cats(["activity_inspect"]) })), "activity_inspect");
  assert.equal(
    heuristicRoute(baseInput({ hops, choices: cats(["activity_inspect"]), preferInspect: false })),
    "summarise",
    "verify:false discourages the inspect hop",
  );
});

test("heuristic: a failed inspect verdict routes back to write_edit; pass summarises", () => {
  const hops = (verdict) => [{
    id: "activity_inspect", index: 0, summary: "inspected", delivered: true,
    toolRecords: [], writtenPaths: [], readPaths: [],
    deliverable: { findings: "defects", verdict },
  }];
  assert.equal(heuristicRoute(baseInput({ hops: hops("fail"), choices: cats(["write_edit"]) })), "write_edit");
  assert.equal(heuristicRoute(baseInput({ hops: hops("pass"), choices: cats(["write_edit"]) })), "summarise");
});

test("heuristic: a bug-fix read prefers activity_inspect (reproduction before fix)", () => {
  const hops = [{ id: "read", index: 0, summary: "read", delivered: true, toolRecords: [], writtenPaths: [], readPaths: [] }];
  assert.equal(
    heuristicRoute(baseInput({ hops, isBugFix: true, choices: cats(["write_edit", "activity_inspect"]) })),
    "activity_inspect",
  );
  assert.equal(
    heuristicRoute(baseInput({ hops, isBugFix: false, choices: cats(["write_edit", "activity_inspect"]) })),
    "write_edit",
  );
});

function cats(ids) {
  return DEFAULT_CATEGORIZER_SETUP.categories.filter((c) => ids.includes(c.id));
}
