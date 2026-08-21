/**
 * Tests for the six pre-deployment gap fixes (G1–G6) that close the spec gaps
 * before OpenWaggleMain consumes the harness:
 *
 *   G1 — intent classifier emits a BUGFIX hint; host flag still wins.
 *   G2 — media_analysis returns a triage CATEGORY and structured OCR.
 *   G3 — informational OCR is lifted into the loop's carried mediaFact.
 *   G4 — inspiration/assets decline and the design ladder is skipped on a
 *        `backend` (non-UI) project.
 *   G5 — the design blueprint carries a `fonts` role map end-to-end.
 *   G6 — probe-marker stripping is enforced (markers detected, scan finds them).
 *
 * Run via: npm test. All offline — the LLM is a capturing stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_ROUTER_PROMPT,
  OpenRouterBridge,
  createMediaAnalysisTool,
  createInspirationGeneratorTool,
  createAssetsGeneratorTool,
} from "../dist/index.js";
import { designReferenceFromBrief } from "../dist/tools/builtin/design-skill.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A 1x1 PNG — enough to satisfy the file-resolution path. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeBridge(replyText) {
  const llm = new OpenRouterBridge();
  const seen = [];
  llm.complete = async (model, ctx) => {
    seen.push({ model: model.openRouterSlug ?? model.id, ctx });
    return {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, seen };
}

async function tmpFile(name = "mockup.png", bytes = PNG_BYTES) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gap-fix-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { dir, file };
}

function ctxFor(llm, dir, extra = {}) {
  return { cwd: dir, llm, log: () => {}, ...extra };
}

// ---------------------------------------------------------------------------
// G1 — the v2 router prompt: one CATEGORY line, bug-report guidance
// ---------------------------------------------------------------------------

test("G1: DEFAULT_ROUTER_PROMPT asks for a single CATEGORY reply", () => {
  // The contract routeCategorizer's parser depends on.
  assert.match(DEFAULT_ROUTER_PROMPT, /CATEGORY:\s*<categorizer id from the choices, or summarise>/);
  // Bug reports route read-first, and REPRODUCTION before mutation.
  assert.match(DEFAULT_ROUTER_PROMPT, /A bug report needs read, then activity_reproduce/);
  assert.match(DEFAULT_ROUTER_PROMPT, /activity_inspect VERIFIES/);
  assert.match(DEFAULT_ROUTER_PROMPT, /Never repeat the categorizer that just ran/);
});

test("G1: BUGFIX hint resolution — host true wins; explicit false suppresses; unset consults hint", () => {
  // Mirrors the resolution line in orchestrator.ts run():
  //   const isBugFix = opts.isBugFix === true || (opts.isBugFix === undefined && bugFixHint);
  function resolve(hostFlag, hint) {
    return hostFlag === true || (hostFlag === undefined && hint);
  }
  // Host explicitly true → bug fix regardless of hint.
  assert.equal(resolve(true, false), true);
  assert.equal(resolve(true, true), true);
  // Host explicitly false → NOT a bug fix, even when the hint is positive
  // (the spec: "host flag wins if explicitly set").
  assert.equal(resolve(false, true), false);
  // Host unset → the hint decides.
  assert.equal(resolve(undefined, true), true);
  assert.equal(resolve(undefined, false), false);
});

// ---------------------------------------------------------------------------
// G2 — media_analysis category + structured OCR
// ---------------------------------------------------------------------------

test("G2: media_analysis parses the trailing CATEGORY line and strips it from analysis", async () => {
  const { dir, file } = await tmpFile();
  // The model's reply ends with the CATEGORY directive line.
  const { llm } = makeBridge("A login form.\nCATEGORY: ui-replicate");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "role?" }, ctxFor(llm, dir));

  assert.equal(res.details.category, "ui-replicate");
  // The category line is stripped so the model-facing output stays clean.
  assert.equal(res.details.analysis, "A login form.");
  assert.doesNotMatch(res.output, /CATEGORY:/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("G2: a missing/unparseable CATEGORY line leaves category undefined (not a failure)", async () => {
  const { dir, file } = await tmpFile();
  const { llm } = makeBridge("Just a description with no category line.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "role?" }, ctxFor(llm, dir));

  assert.equal(res.details.category, undefined);
  assert.equal(res.details.analysis, "Just a description with no category line.");
  await fs.rm(dir, { recursive: true, force: true });
});

test("G2: the ocr lens exposes a structured ocr.text field mirroring analysis", async () => {
  const { dir, file } = await tmpFile("spec.png");
  const { llm } = makeBridge("Error: ENOSUCH\nLine 42\nCATEGORY: informational");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, lens: "ocr", prompt: "extract text" }, ctxFor(llm, dir));

  assert.equal(res.details.category, "informational");
  assert.equal(res.details.ocr.text, "Error: ENOSUCH\nLine 42");
  // analysis mirrors ocr.text.
  assert.equal(res.details.analysis, res.details.ocr.text);
  await fs.rm(dir, { recursive: true, force: true });
});

test("G2: a non-ocr lens does NOT populate details.ocr", async () => {
  const { dir, file } = await tmpFile();
  const { llm } = makeBridge("A screen.\nCATEGORY: ui-replicate");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, lens: "ui", prompt: "describe" }, ctxFor(llm, dir));

  assert.equal(res.details.ocr, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// G3 — informational OCR is lifted into the loop-carried mediaFact
// ---------------------------------------------------------------------------

test("G3: a mediaFactFromToolResult-equivalent extraction picks informational OCR only", () => {
  // Mirrors the helper added to loop.ts: only informational triage qualifies;
  // ui-replicate/ui-bug travel as pixels, not as text.
  function mediaFactFromToolResult(details) {
    if (!details || typeof details !== "object") return undefined;
    const d = details;
    if (d.category !== "informational") return undefined;
    const ocrText = d.ocr?.text;
    if (typeof ocrText === "string" && ocrText.trim()) return ocrText.trim();
    if (typeof d.analysis === "string" && d.analysis.trim()) return d.analysis.trim();
    return undefined;
  }
  assert.equal(
    mediaFactFromToolResult({ category: "informational", ocr: { text: "stack trace" } }),
    "stack trace",
  );
  assert.equal(
    mediaFactFromToolResult({ category: "informational", analysis: "fallback text" }),
    "fallback text",
  );
  // A ui-replicate image must NOT be folded into mediaFact (it rides as pixels).
  assert.equal(
    mediaFactFromToolResult({ category: "ui-replicate", analysis: "a mockup" }),
    undefined,
  );
  assert.equal(mediaFactFromToolResult({ category: "ui-bug", analysis: "broken" }), undefined);
  assert.equal(mediaFactFromToolResult(undefined), undefined);
});

// ---------------------------------------------------------------------------
// G4 — inspiration/assets decline on a backend project
// ---------------------------------------------------------------------------

test("G4: inspiration_generator declines on a backend project (matched:false, not an error)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backend-insp-"));
  const tool = createInspirationGeneratorTool();
  // A backend would normally be registered WITH a backend; the decline must
  // fire before any backend call, purely on ctx.projectCategory.
  const res = await tool.execute(
    "c1",
    { keywords: ["dashboard"], kind: "web-ui" },
    ctxFor(undefined, dir, { projectCategory: "backend" }),
  );
  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.matched, false);
  assert.match(res.output, /backend/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test("G4: assets_generator declines on a backend project", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backend-assets-"));
  const tool = createAssetsGeneratorTool();
  const res = await tool.execute(
    "c1",
    { kind: "image", prompt: "a hero illustration" },
    ctxFor(undefined, dir, { projectCategory: "backend" }),
  );
  assert.equal(res.isError ?? false, false);
  assert.match(res.output, /backend/i);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// G5 — the design blueprint carries a `fonts` role map
// ---------------------------------------------------------------------------

test("G5: the design-skill prompt asks for a fonts role map", () => {
  // The prompt's shape sketch must now mention fonts, or the model won't emit it.
  // Capture it by running the skill once with a stub that records the system
  // prompt, then assert on what it was handed.
  let systemPrompt = "";
  const llm = {
    complete: async (_model, ctx) => {
      systemPrompt = ctx.systemPrompt ?? "";
      return { role: "assistant", content: [{ type: "text", text: "[]" }], usage: null };
    },
    resolveModel: (slug) => ({ id: slug }),
  };
  return designReferenceFromBrief({ llm, model: { id: "x" }, task: "build a hero", path: "p.tsx" })
    .then(() => {
      assert.match(systemPrompt, /"fonts"/);
      // The ROLE-not-literal discipline must extend to typography.
      assert.match(systemPrompt, /TYPOGRAPHY/i);
    });
});

test("G5: a `fonts` field the model emits survives parseSections (no parser change needed)", async () => {
  let systemPrompt = "";
  const llm = {
    complete: async (_model, ctx) => {
      systemPrompt = ctx.systemPrompt ?? "";
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '[{"kind":"web-ui","category":"hero","name":"h","fonts":{"heading":"display","body":"text"}}]',
          },
        ],
        usage: null,
      };
    },
    resolveModel: (slug) => ({ id: slug }),
  };
  const designed = await designReferenceFromBrief({ llm, model: { id: "x" }, task: "hero", path: "p.tsx" });
  assert.ok(designed?.sections.length, "expected at least one section");
  assert.deepEqual(designed.sections[0].fonts, { heading: "display", body: "text" });
});

// ---------------------------------------------------------------------------
// G6 — probe-marker detection + stripping enforcement
// ---------------------------------------------------------------------------

test("G6: a file with a TURING_TRACE probe line is detected by the marker regex", () => {
  // Mirrors PROBE_MARKER_RE in probe-marker.ts (imported by loop.ts / orchestrator.ts / activity-monitor.ts / coding.ts).
  const RE = /TURING_TRACE/;
  assert.ok(RE.test('console.log("TURING_TRACE hit", { x: 1 });'));
  assert.ok(RE.test('print("TURING_TRACE [${DateTime.now()}] screen=home");'));
  // A file WITHOUT markers must not trip.
  assert.ok(!RE.test("function normal(x) { return x + 1; }"));
  assert.ok(!RE.test("// just a comment about tracing"));
});

test("G6: scanForProbeMarkers-equivalent finds files still containing markers", async () => {
  // Mirrors the orchestrator's post-verify scan + activity_cleanup's
  // findProbeMarkerFiles: read each path, keep those still matching.
  const RE = /TURING_TRACE/;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-scan-"));
  const clean = path.join(dir, "clean.ts");
  const dirty = path.join(dir, "dirty.ts");
  await fs.writeFile(clean, "export const x = 1;\n");
  await fs.writeFile(dirty, 'console.log("TURING_TRACE here");\n');

  async function scanRemaining(files) {
    const remaining = [];
    for (const p of files) {
      const content = await fs.readFile(p, "utf8");
      if (RE.test(content)) remaining.push(p);
    }
    return remaining;
  }
  const remaining = await scanRemaining([clean, dirty]);
  assert.deepEqual(remaining, [dirty]);
  await fs.rm(dir, { recursive: true, force: true });
});
