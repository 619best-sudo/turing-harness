/**
 * Unit tests for the design skill — the final rung of reference sourcing for a
 * UI write with no image and no inspiration match.
 *
 * Pins the three properties that make the skill safe:
 *   1. SHAPE — its output passes the harvester's only gate (string `kind` per
 *      section), so the existing threading carries it unchanged.
 *   2. ROLE-NOT-LITERAL — the design prompt agrees with `DESIGN_REUSE_BOUNDARY`:
 *      role for text and color, never invented copy or hex.
 *   3. NEVER-THROWS — on any failure (parse miss, empty model output, bridge
 *      throw) it returns `undefined`, so the caller falls back to no reference
 *      rather than failing the write.
 *
 * Run via: npm test. All offline — the LLM is a capturing stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { designReferenceFromBrief, parseSections } from "../dist/tools/builtin/design-skill.js";

/** A stub LLM that captures the prompt and returns a canned message. */
function capturingLlm(content) {
  const seen = { system: "", user: "" };
  return {
    seen,
    llm: {
      complete: async (_model, ctx) => {
        seen.system = ctx.systemPrompt ?? "";
        seen.user = ctx.messages[0]?.content ?? "";
        return { role: "assistant", content: [{ type: "text", text: content }], usage: null };
      },
      resolveModel: (slug) => ({ id: slug }),
    },
  };
}

// ---------------------------------------------------------------------------
// parseSections — the shape gate, in isolation
// ---------------------------------------------------------------------------

test("parseSections keeps objects with a string kind", () => {
  const out = parseSections(
    '[{"kind":"web-ui","category":"hero","name":"x"},{"kind":"mobile-ui","name":"y"}]',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "web-ui");
});

test("parseSections drops objects without a string kind (the harvester would drop them anyway)", () => {
  const out = parseSections('[{"kind":"web-ui","name":"ok"},{"category":"hero","name":"dropped"}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "ok");
});

test("parseSections defaults a missing name so the authoring prompt never shows an unnamed section", () => {
  const out = parseSections('[{"kind":"web-ui","category":"hero"}]');
  assert.equal(out[0].name, "web-ui section");
});

test("parseSections tolerates a fenced array and trailing prose", () => {
  const out = parseSections(
    'Here you go:\n```json\n[{"kind":"web-ui","name":"hero"}]\n```\nLet me know.',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "hero");
});

test("parseSections returns [] on unparseable input (never throws)", () => {
  assert.deepEqual(parseSections("not json at all"), []);
  assert.deepEqual(parseSections("[oops"), []);
  assert.deepEqual(parseSections(""), []);
});

// ---------------------------------------------------------------------------
// designReferenceFromBrief — the LLM call
// ---------------------------------------------------------------------------

test("returns sections and forwards them when the model emits a valid array", async () => {
  const { seen, llm } = capturingLlm('[{"kind":"web-ui","category":"hero","name":"split hero"}]');
  const result = await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a landing page",
    path: "index.html",
  });
  assert.ok(result, "expected a design result");
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].kind, "web-ui");
});

test("the design prompt agrees with the reuse boundary: role, not literal values", async () => {
  const { seen, llm } = capturingLlm("[]");
  await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a pricing page",
    path: "pricing.html",
  });
  // Text must come out as ROLE, never invented copy.
  assert.match(seen.system, /emit the ROLE/);
  assert.match(seen.system, /NEVER invent/);
  // Colors must come out as ROLE, never hex.
  assert.match(seen.system, /NEVER a hex value/);
});

test("the task frames the design so structure is built toward it", async () => {
  const { seen, llm } = capturingLlm("[]");
  await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a saas pricing page with three tiers",
    path: "pricing.html",
  });
  assert.match(seen.user, /saas pricing page with three tiers/);
});

test("the design stresses coherence — one page, not independent parts", async () => {
  const { seen, llm } = capturingLlm("[]");
  await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a homepage",
    path: "index.html",
  });
  assert.match(seen.system, /COHERE/);
  assert.match(seen.system, /they are one page, not independent parts/);
});

test("the path is named in the framing so the skill knows what it is designing", async () => {
  const { seen, llm } = capturingLlm("[]");
  await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build it",
    path: "src/pages/landing.tsx",
  });
  assert.match(seen.user, /src\/pages\/landing\.tsx/);
});

// ---------------------------------------------------------------------------
// Never-throws contract — failure degrades to undefined, never crashes the write
// ---------------------------------------------------------------------------

test("returns undefined when the model emits empty text", async () => {
  const { llm } = capturingLlm("");
  const result = await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a page",
  });
  assert.equal(result, undefined);
});

test("returns undefined when the model emits unparseable text", async () => {
  const { llm } = capturingLlm("the page should have a hero");
  const result = await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a page",
  });
  assert.equal(result, undefined);
});

test("returns undefined when the model emits an array with no string-kind objects", async () => {
  const { llm } = capturingLlm('[{"category":"hero","name":"dropped"}]');
  const result = await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a page",
  });
  assert.equal(result, undefined);
});

test("returns undefined when the bridge throws", async () => {
  const llm = {
    complete: async () => {
      throw new Error("network down");
    },
    resolveModel: (slug) => ({ id: slug }),
  };
  const result = await designReferenceFromBrief({
    llm,
    model: { id: "design/model" },
    task: "build a page",
  });
  assert.equal(result, undefined);
});
