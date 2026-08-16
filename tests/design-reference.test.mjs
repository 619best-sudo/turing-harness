/**
 * A borrowed blueprint must reach the model that writes the bytes — with a hard
 * boundary on what may be copied out of it.
 *
 * Two failures this closes:
 *
 * 1. The blueprint arrived as a tool result in the DRIVER's conversation, but
 *    under `authorOnlyWrites` the driver does not write bytes — a second model
 *    does, from task + current file + anchor. So a run looked up a design
 *    reference and then authored the UI having never seen it; all that survived
 *    was the driver's paraphrase ("a gradient hero"), which is not a layout.
 *
 * 2. A blueprint carries the SOURCE'S real copy, hex values, image names and
 *    brand marks — that is how the source was described. Handed structured JSON
 *    with no boundary, a model reproduces the values in it. Shipping someone
 *    else's headline and palette is what turns the lookup from a head start into
 *    a liability.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { authorFileContent, authorEditReplacement } from "../dist/tools/builtin/authoring.js";
import { createCodingTools } from "../dist/index.js";

const BLUEPRINT = [
  {
    kind: "web-ui",
    category: "hero",
    style: "glassmorphism",
    domain: "health",
    name: "Frosted clinic hero",
    keywords: ["hero", "glassmorphism", "health"],
    layout: { type: "flex", direction: "column", gap: "24px" },
    elements: [
      { role: "heading", text: "Care that comes to you", styles: { color: "#0B1020", fontSize: "56px" } },
      { role: "image", srcHint: "clinic-lobby-photo", alt: "Lobby" },
    ],
    styles: { background: "linear-gradient(135deg,#6D28D9,#DB2777)" },
  },
];

function capturingLlm(text = "authored") {
  const seen = { system: "", user: "" };
  return {
    seen,
    llm: {
      complete: async (_m, ctx) => {
        seen.system = ctx.systemPrompt ?? "";
        const c = ctx.messages[0]?.content;
        seen.user =
          typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
        return { role: "assistant", content: [{ type: "text", text }], usage: null };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// It arrives.
// ---------------------------------------------------------------------------

test("the blueprint reaches the write author", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/Hero.tsx",
    task: "build the hero",
    designReference: BLUEPRINT,
  });
  assert.match(seen.user, /DESIGN REFERENCE/);
  assert.match(seen.user, /Frosted clinic hero/, "the structure is actually present");
});

test("the blueprint reaches the edit author too", async () => {
  const { seen, llm } = capturingLlm();
  await authorEditReplacement({
    llm,
    model: { id: "test/author" },
    path: "/site/Hero.tsx",
    oldString: "<section id=\"hero\" />",
    task: "build the hero",
    currentContent: "<section id=\"hero\" />",
    designReference: BLUEPRINT,
  });
  assert.match(seen.user, /DESIGN REFERENCE/);
});

test("with no blueprint, nothing is added — a reference-free run pays nothing", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({ llm, model: { id: "test/author" }, path: "/a.ts", task: "x" });
  assert.doesNotMatch(seen.user, /DESIGN REFERENCE/);
  assert.doesNotMatch(seen.system, /DO NOT TAKE/);
});

// ---------------------------------------------------------------------------
// And it comes with a boundary.
// ---------------------------------------------------------------------------

test("the reuse boundary states exactly what may and may not be copied", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/Hero.tsx",
    task: "build the hero",
    designReference: BLUEPRINT,
  });
  assert.match(seen.system, /TAKE: the layout skeleton/);
  assert.match(seen.system, /DO NOT TAKE/);
  // The specific things a blueprint carries that must not ship.
  for (const re of [/copy, headings, labels/, /hex values/, /image filenames/, /logos, icons or brand marks/]) {
    assert.match(seen.system, re);
  }
  // And what to do instead — a prohibition with no alternative gets ignored.
  assert.match(seen.system, /this project's own content and its existing theme tokens/);
  assert.match(seen.system, /Match the reference's ROLE for an/);
});

test("the boundary applies to ui and svg authoring, which is where designs land", async () => {
  for (const category of ["ui", "svg", "code", undefined]) {
    const { seen, llm } = capturingLlm();
    await authorFileContent({
      llm,
      model: { id: "test/author" },
      path: "/site/Hero.tsx",
      task: "build the hero",
      ...(category ? { category } : {}),
      designReference: BLUEPRINT,
    });
    assert.match(seen.system, /DO NOT TAKE/, `${category ?? "default"}: boundary present`);
  }
});

// ---------------------------------------------------------------------------
// End to end through the real tool.
// ---------------------------------------------------------------------------

test("write forwards the blueprint from the tool context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "design-ref-"));
  const { seen, llm } = capturingLlm("<section>built</section>\n");
  const write = createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "write");

  await write.execute(
    "w1",
    { path: path.join(dir, "Hero.tsx") },
    {
      cwd: dir,
      llm,
      model: { id: "driver/model" },
      authoringContext: { task: "build the hero", designReference: BLUEPRINT },
      log: () => {},
    },
  );

  assert.match(seen.user, /DESIGN REFERENCE/, "the tool passed it through");
  assert.match(seen.system, /DO NOT TAKE/, "with its boundary");
});

// ---------------------------------------------------------------------------
// `rationale` — the part meant to be reasoned from, not reproduced.
//
// Everything else in a blueprint is a spec for a rectangle: a consumer can
// rebuild the geometry pixel-perfectly and still choose the wrong focal element
// for its own product. The reasoning is what survives a change of brand,
// palette and copy — so the boundary has to separate "copy this" from
// "re-run this decision", or the model treats the conclusion as the artifact.
// ---------------------------------------------------------------------------

const WITH_RATIONALE = [
  {
    ...BLUEPRINT[0],
    designId: "clinic-landing-2024",
    rationale: {
      heroElement: "the product dashboard, mid-task with real data",
      whyThisElement: "the buyer's open question is whether it can do their job",
      businessGoal: "trial signup",
      audience: "an ops lead, skimming, already sceptical",
      animationIntent: "the dashboard assembles itself — 'this comes together quickly'",
      journeyStage: "first impression → comprehension → CTA",
    },
  },
];

test("the rationale reaches the author", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/Hero.tsx",
    task: "build the hero",
    designReference: WITH_RATIONALE,
  });
  assert.match(seen.user, /whyThisElement/);
  assert.match(seen.user, /animationIntent/);
});

test("the boundary tells the author to re-run the reasoning, not copy the answer", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/Hero.tsx",
    task: "build the hero",
    designReference: WITH_RATIONALE,
  });
  assert.match(seen.system, /USE THE `rationale` IF IT IS THERE/);
  assert.match(seen.system, /reasoned from rather than/);
  assert.match(seen.system, /ask what THIS/, "it must re-ask the question for this product");
  assert.match(
    seen.system,
    /Copying the conclusion while ignoring the reason/,
    "the failure mode is named, not just the rule",
  );
});
