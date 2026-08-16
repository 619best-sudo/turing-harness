/**
 * The activity_inspect prompt teaches the exact end-to-end pipeline, and the
 * raw-browser ceremony block disappears once the fused `drive` tool exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCategorizerSystemPrompt, DEFAULT_CATEGORIZER_PROMPTS, BROWSER_RAW_DRIVING, DRIVE_TOOL } from "../dist/index.js";

const build = (toolNames) =>
  buildCategorizerSystemPrompt(
    { id: "activity_inspect", systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_inspect },
    toolNames,
  );

const INSPECT_TOOLS = ["drive", "mobile", "media_analysis", "activity_inspect", "activity_collect", "activity_study", "add_log", "remove_log", "bash", "deliver"];

test("the prompt teaches the pipeline in order: instrument → build → run/automate → analyse → verdict", () => {
  const p = build(INSPECT_TOOLS);
  const order = [
    p.indexOf("1. INSTRUMENT"),
    p.indexOf("2. BUILD"),
    p.indexOf("3. RUN + AUTOMATE"),
    p.indexOf("4. ANALYSE"),
    p.indexOf("5. VERDICT"),
  ];
  assert.ok(order.every((i) => i >= 0), `all five stages present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stages appear in pipeline order");
});

test("step 3 names the fused per-surface sequence (drive open→look→click→shot; mobile launch→look→tap)", () => {
  const p = build(INSPECT_TOOLS);
  const step3 = p.slice(p.indexOf("3. RUN + AUTOMATE"), p.indexOf("4. ANALYSE"));
  assert.match(step3, /drive \{action:"open"\}/);
  assert.match(step3, /drive \{action:"look"\}/);
  assert.match(step3, /click.*fill.*select/);
  assert.match(step3, /drive \{action:"shot"\}/);
  assert.match(step3, /mobile \{action:"launch"\}/);
  assert.match(step3, /mobile \{action:"look"\}/);
  assert.match(step3, /mobile \{action:"tap"/);
  // One call per step is stated as the rule, ceremony named as the anti-pattern.
  assert.match(p, /ONE CALL PER STEP/);
  assert.match(p, /never a snapshot→ref→click→re-snapshot ceremony/);
});

test("step 4 routes pixels to media_analysis lenses and logs to study/search", () => {
  const p = build(INSPECT_TOOLS);
  const step4 = p.slice(p.indexOf("4. ANALYSE"), p.indexOf("5. VERDICT"));
  assert.match(step4, /lens:"qa"/);
  assert.match(step4, /lens:"compare"/);
  assert.match(step4, /activity_study/);
  assert.match(step4, /trail STOPS/);
});

test("the deliver contract and probe-stripping survive the rewrite", () => {
  const p = build(INSPECT_TOOLS);
  assert.match(p, /YOUR EXPECTATION/);
  assert.match(p, /verdict: "pass"\|"fail"\|"needs-work"/);
  assert.match(p, /STRIP YOUR INSTRUMENTATION/);
  assert.match(p, /activity_cleanup/);
});

test("with `drive` present: the fused block is taught and the raw-ceremony block is gone", () => {
  const withDrive = build(INSPECT_TOOLS);
  assert.ok(withDrive.includes(DRIVE_TOOL), "DRIVE_TOOL guidance attached");
  assert.ok(!withDrive.includes(BROWSER_RAW_DRIVING), "raw browser ceremony dropped");
});

test("without `drive` (raw browser MCP only): the by-ref block is taught instead", () => {
  const rawOnly = build(["browser_snapshot", "browser_click", "browser_navigate", "bash", "deliver"]);
  assert.ok(rawOnly.includes(BROWSER_RAW_DRIVING), "by-ref browser block attached");
  assert.ok(!rawOnly.includes(DRIVE_TOOL), "fused block not attached without the tool");
});

test("tool gating keeps both from appearing on a toolset with neither", () => {
  const neither = build(["bash", "read", "deliver"]);
  assert.ok(!neither.includes(BROWSER_RAW_DRIVING));
  assert.ok(!neither.includes(DRIVE_TOOL));
});
