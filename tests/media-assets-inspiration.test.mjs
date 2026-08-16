/**
 * The three creative tools, and the facts their prompts must carry.
 *
 * Each existed and worked; each was missing the one input that makes it act on
 * reality instead of on a vibe:
 *   - media_analysis lens:"qa" judged a screen against a SENTENCE, so a page that
 *     renders the wrong brand color and a placeholder heading passes for looking
 *     plausible. It now takes `expected` — the spec that was actually built.
 *   - assets_generator knew the four kinds but not how the asset LANDS, so a hero
 *     came back with its subject exactly where the headline goes, and parallax got
 *     one flat composite that cannot be moved in layers.
 *   - inspiration_generator took one keyword bag, which ranks a glassy fintech page
 *     and a flat clinic page identically. Style and domain are now separate axes.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ASSETS_AND_SVG,
  INSPIRATION_REUSE,
  MEDIA_UNDERSTANDING,
  createInspirationGeneratorTool,
  createMediaAnalysisTool,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// media_analysis — visual QA acts on what was built.
// ---------------------------------------------------------------------------

test("media_analysis exposes `expected` for the qa lens", () => {
  const tool = createMediaAnalysisTool();
  const props = tool.parameters.properties;
  assert.ok(props.expected, "the built spec has somewhere to go");
  assert.match(props.expected.description, /token values/);
  assert.match(props.expected.description, /copy strings/);
  assert.deepEqual(props.lens.enum, ["describe", "ocr", "ui", "component", "qa", "compare"]);
  // `compare` needs the design named as such — order is the only channel a vision
  // model has for telling the target from the attempt at it.
  assert.ok(props.reference, "the design being replicated has somewhere to go");
  assert.match(props.reference.description, /compare/);
  assert.deepEqual(props.type.enum, ["image", "video", "audio", "document"]);
});

test("the qa pass receives the built spec as its own labelled block", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-qa-"));
  const shot = path.join(dir, "hero.png");
  await fs.writeFile(shot, "PNG-BYTES");

  let seenPrompt = "";
  const tool = createMediaAnalysisTool({
    analyze: async (req) => {
      seenPrompt = req.prompt;
      return { text: "VERDICT: PASS" };
    },
  });
  await tool.execute(
    "m1",
    {
      prompt: "does the hero match the brief?",
      file: shot,
      lens: "qa",
      expected: "--brand: #0A5C36; heading copy: 'Ship faster'",
    },
    { cwd: dir, log: () => {} },
  );
  assert.match(seenPrompt, /does the hero match the brief\?/, "the question survives");
  assert.match(seenPrompt, /WHAT WAS BUILT/, "the spec is labelled, not merged into the question");
  assert.match(seenPrompt, /#0A5C36/);
});

test("the guidance tells the model to paste real values, not a summary", () => {
  assert.match(MEDIA_UNDERSTANDING, /VISUAL QA OF UI YOU JUST BUILT/);
  assert.match(MEDIA_UNDERSTANDING, /the brand\s*\n?\s*color that fell back to a default/);
  assert.match(MEDIA_UNDERSTANDING, /NOT VERIFIABLE HERE/);
  assert.match(MEDIA_UNDERSTANDING, /On FAIL, fix the named defects and re-run/);
});

// ---------------------------------------------------------------------------
// assets_generator — which kind, and how it lands.
// ---------------------------------------------------------------------------

test("the assets guidance covers all four kinds by job", () => {
  for (const re of [/`image` for anything/, /`video` for ambient motion/, /`audio` for/, /`3d` for a model/]) {
    assert.match(ASSETS_AND_SVG, re);
  }
  // The failure that motivated it: composition decided after generation.
  assert.match(ASSETS_AND_SVG, /empty right third for a/);
});

test("parallax is generated as separate layers, not one composite", () => {
  assert.match(ASSETS_AND_SVG, /PARALLAX AND SCROLL SCENES/);
  assert.match(ASSETS_AND_SVG, /generate them separately/);
  assert.match(ASSETS_AND_SVG, /translate3d/);
  assert.match(ASSETS_AND_SVG, /prefers-reduced-motion/);
  assert.match(ASSETS_AND_SVG, /three or four reads as depth/);
});

// ---------------------------------------------------------------------------
// inspiration_generator — style and domain are separate axes.
// ---------------------------------------------------------------------------

test("inspiration_generator takes style and domain as first-class inputs", () => {
  const props = createInspirationGeneratorTool().parameters.properties;
  assert.ok(props.style, "style axis exists");
  assert.ok(props.domain, "domain axis exists");
  assert.match(props.style.description, /neumorphism/);
  assert.match(props.style.description, /glassmorphism/);
  assert.match(props.domain.description, /ecommerce/);
  assert.match(props.domain.description, /health/);
});

test("style and domain reach the backend on both axes and as keywords", async () => {
  let seen;
  const tool = createInspirationGeneratorTool({
    backend: async (input) => {
      seen = input;
      return { sections: [] };
    },
  });
  await tool.execute(
    "i1",
    { keywords: ["dark"], style: "Glassmorphism", domain: "Health", sections: ["hero"] },
    { cwd: process.cwd(), log: () => {} },
  );
  assert.equal(seen.style, "glassmorphism", "normalized, on its own axis");
  assert.equal(seen.domain, "health");
  // Folded in too, so a keyword-only backend is unaffected by the new axes.
  assert.ok(seen.keywords.includes("glassmorphism"));
  assert.ok(seen.keywords.includes("health"));
  assert.ok(seen.keywords.includes("dark"));
});

test("a tag named twice is not weighted twice", async () => {
  let seen;
  const tool = createInspirationGeneratorTool({
    backend: async (input) => { seen = input; return { sections: [] }; },
  });
  await tool.execute(
    "i1",
    { keywords: ["glassmorphism"], style: "glassmorphism" },
    { cwd: process.cwd(), log: () => {} },
  );
  assert.deepEqual(seen.keywords.filter((k) => k === "glassmorphism").length, 1);
});

test("`category` is accepted as a synonym for `domain`", async () => {
  // The word a model reaches for, mapped at the boundary — the store has meant
  // SECTION KIND by "category" since its first migration.
  let seen;
  const tool = createInspirationGeneratorTool({
    backend: async (input) => { seen = input; return { sections: [] }; },
  });
  await tool.execute("i1", { keywords: ["dark"], category: "Ecommerce" }, { cwd: process.cwd(), log: () => {} });
  assert.equal(seen.domain, "ecommerce");
  assert.equal(seen.category, undefined, "it never leaves the tool under the ambiguous name");
});

test("the guidance explains why the axes are separate", () => {
  assert.match(INSPIRATION_REUSE, /`style` — the visual language/);
  assert.match(INSPIRATION_REUSE, /`domain` — the product domain/);
  assert.match(INSPIRATION_REUSE, /which sections a design HAS at all/);
  assert.match(INSPIRATION_REUSE, /glassy fintech page and a flat clinic page the same/);
});
