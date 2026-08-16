/**
 * What the staged read is allowed to append to a file's bytes.
 *
 * The escalated analysis is appended under a banner that tells the reading model
 * "the numbered lines above are the authoritative file contents" — so the model
 * treats what follows as authoritative too. One observed run returned an
 * "analysis" that was, in order: ~600 characters of `{`, `//` and `>` with no
 * words in it; ~4KB of the analyst thinking aloud, terminated by a stray
 * `</think:opensource>`; and then a competent analysis OF A TASK NOBODY ASKED
 * FOR — `TASK: changing the "Lock screen Widget" label (line 767)`, on a run
 * whose task was to change a delete-account dialog title.
 *
 * All three reached the driver, which then re-read lines 640-767 three times and
 * eventually wrote "I see the analysis is confusing me."
 *
 * The invented task is fixed upstream (`ToolContext.task` — the analyst was
 * given no task at all and was under instruction to lead with one). The other
 * two are fixed here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenRouterBridge, readTool } from "../dist/index.js";
import { clearComprehensionMemory, sanitizeAnalysis } from "../dist/tools/builtin/comprehension.js";

// The comprehension cache is process-global by design (one entry per file a run
// escalated on). Clear it so these tests do not inherit another file's run.
clearComprehensionMemory();

test("a clean analysis passes through untouched", () => {
  const good = "- Line 41 establishes the invariant that `head` is never null once `init()` returns.\n- Line 88 re-enters acquire().";
  assert.equal(sanitizeAnalysis(good), good);
});

test("terse is not broken — a one-line finding survives", () => {
  // The prompt asks for as few words as the findings take, so a short analysis
  // is the goal, not a symptom. An early version of this check demanded 40
  // characters and 20 words and threw away correct output.
  assert.equal(sanitizeAnalysis("L3: acquire() may reenter."), "L3: acquire() may reenter.");
});

test("leaked thinking is cut at the closing tag", () => {
  const raw = [
    "Let me write the analysis now, leading with the task, citing line numbers.",
    "Key findings: 1. Label location. 2. Platform gate.",
    "Actually, the task is a bit contradictory. Let me just present the risks clearly:",
    "</think:opensource>The label lives only in `_buildLiveActivityToggleRow()` at line 767.",
  ].join("\n");
  const out = sanitizeAnalysis(raw);
  assert.ok(!out.includes("Let me write"), "the planning is gone");
  assert.ok(!out.includes("</think"), "and so is the tag");
  assert.match(out, /line 767/, "the actual analysis survives");
});

test("a paired think block is cut too", () => {
  const out = sanitizeAnalysis("<think>weighing what matters here</think>\nLine 12 mutates the shared buffer.");
  assert.equal(out, "Line 12 mutates the shared buffer.");
});

test("an unterminated think block means the whole reply was thinking", () => {
  assert.equal(sanitizeAnalysis("<think>I should start by working out what the file does"), "");
});

test("a degenerate symbol wall is rejected outright", () => {
  // Reproduced from the transcript: the generation collapsed into brace/comment
  // tokens. Returning "" is correct — the caller falls back to a plain read,
  // which is strictly better than an analysis nobody can trust.
  const junk = "{\n //   {\n {\n {\n >\n , {\n // {\n  {\n >\n {\n //  {\n {\n";
  assert.equal(sanitizeAnalysis(junk), "");
});

test("a symbol wall in FRONT of a real analysis is stripped, not fatal", () => {
  const raw = "{\n // {\n  >\n {\n- Line 767 holds the label literal; it is the only surface.";
  const out = sanitizeAnalysis(raw);
  assert.equal(out, "- Line 767 holds the label literal; it is the only surface.");
});

test("first-person planning at the top is dropped", () => {
  const raw = [
    "Okay, let me look at this file.",
    "I'll focus on the toggle row.",
    "Line 191 returns early on non-iOS, so the state never initialises there.",
  ].join("\n");
  assert.equal(
    sanitizeAnalysis(raw),
    "Line 191 returns early on non-iOS, so the state never initialises there.",
  );
});

test("prose mid-analysis that merely starts with 'now' is kept", () => {
  // Only the TOP is trimmed. A narration-shaped line inside a real analysis is
  // far more likely to be a sentence about the code than a relapse into planning.
  const raw = "Line 40 sets up the lock.\nNow-unused `retry()` at line 88 is still exported.";
  assert.match(sanitizeAnalysis(raw), /Now-unused/);
});

test("empty in, empty out", () => {
  assert.equal(sanitizeAnalysis(""), "");
  assert.equal(sanitizeAnalysis("   \n  "), "");
});

// ---- the analyst is actually TOLD what the run is doing --------------------

/** A file long/dense enough to clear the cheap trivia prefilter. */
function complexSource() {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`export function fn${i}(a, b) { return acquire(a) ? release(b, ${i}) : retry(a, b); }`);
  }
  return lines.join("\n");
}

function usageWith(output) {
  return {
    input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/** Records the system + user prompt of each internal call the staged read makes. */
function recordingBridge(analysis = "Line 12 holds the invariant the task must not break.") {
  const llm = new OpenRouterBridge();
  const seen = [];
  llm.complete = async (model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const kind = /judge how hard a source file/i.test(sys) ? "rate" : "comprehend";
    const user = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    seen.push({ kind, system: sys, user });
    const text = kind === "rate" ? "RATING: high | WHY: dense retry loop" : analysis;
    return {
      role: "assistant", content: [{ type: "text", text }],
      model: "test/strong", api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, seen };
}

test("the analyst is handed the run's task on a plain read", async () => {
  // The regression this pins: `authoringContext` exists only for write/edit, so
  // reading the task from it alone left every `read` escalation with no task —
  // and the analyst, under instruction to lead with one, invented it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-task-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");
  const { llm, seen } = recordingBridge();

  await readTool.execute("c1", { path: file }, {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    toolModelCandidates: ["test/cheap", "test/strong"],
    task: "change title of delete account popup",
  });

  const comprehend = seen.find((c) => c.kind === "comprehend");
  assert.ok(comprehend, "the escalation ran");
  assert.match(comprehend.user, /change title of delete account popup/, "the real task reached the analyst");
  // And the prompt closes the door on inventing one when it is genuinely absent.
  assert.match(comprehend.system, /NEVER INVENT THE TASK/);
  assert.match(comprehend.system, /OUTPUT THE ANALYSIS ONLY/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a collapsed analysis is retried once before it is given up on", async () => {
  // The reader is often a WEAK model — that is why the escalation exists — so
  // rejecting one bad sample and walking away is the wrong trade. A collapsed
  // generation is usually a bad draw, not a model that cannot do the job.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-retry-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");

  const replies = ["{\n // {\n  >\n {\n {\n", "Line 40 holds the lock; line 88 re-enters acquire()."];
  let n = 0;
  const llm = new OpenRouterBridge();
  const prompts = [];
  llm.complete = async (_model, ctx) => {
    const sys = ctx.systemPrompt ?? "";
    const rate = /judge how hard a source file/i.test(sys);
    const user = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (!rate) prompts.push(user);
    const text = rate ? "RATING: high | WHY: dense" : (replies[n++] ?? "");
    return {
      role: "assistant", content: [{ type: "text", text }],
      model: "test/strong", api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };

  const res = await readTool.execute("c1", { path: file }, {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm, log: () => {},
    toolModelCandidates: ["test/cheap", "test/strong"],
    task: "rename the export",
  });

  assert.equal(prompts.length, 2, "it tried again");
  assert.match(prompts[1], /YOUR PREVIOUS REPLY WAS DISCARDED/, "and said why, so the retry differs");
  assert.match(res.output, /Line 40 holds the lock/, "the good second answer is used");
  await fs.rm(dir, { recursive: true, force: true });
});

test("when BOTH attempts collapse the reader is warned, not left guessing", async () => {
  // The failure mode this replaces: fall back to a plain read, so a file the
  // harness judged too hard for this model comes back looking like any other.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-reject-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");

  const logs = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (_model, ctx) => {
    const rate = /judge how hard a source file/i.test(ctx.systemPrompt ?? "");
    const text = rate ? "RATING: high | WHY: dense" : "{\n // {\n > {\n {\n";
    return {
      role: "assistant", content: [{ type: "text", text }],
      model: "test/strong", api: "openrouter", provider: "test",
      usage: usageWith(text.length), stopReason: "stop", timestamp: 0,
    };
  };

  const res = await readTool.execute("c1", { path: file }, {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm,
    log: (e) => logs.push(e),
    toolModelCandidates: ["test/cheap", "test/strong"],
    task: "rename the export",
  });

  // The bytes always survive — discarding the analysis never costs the file.
  assert.match(res.output, /1\texport function fn0/);
  // ...and the garbage never reaches the reader.
  assert.ok(!/^\s*\{\s*$/m.test(res.output.split("NOTE:")[1] ?? ""), "the rejected text is not included");
  assert.match(res.output, /rated HIGH/, "the reader is told the file is hard");
  assert.match(res.output, /unusable/, "and that the explanation failed");
  assert.match(res.output, /escalated to the stronger model for authoring/, "and what still protects it");
  // The measured rating still stands, which is what makes that last claim true.
  assert.equal(res.measuredComplexity, "high");
  assert.ok(
    logs.some((l) => (l.tags ?? []).includes("escalation:rejected")),
    "and it is on the log, so a bad escalation model is discoverable",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("re-reading an analysed file gets a pointer, not the analysis again", async () => {
  // One observed run appended the same 14KB analysis to six reads of one file,
  // including a 12-line window. The analysis is already in the conversation.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comprehension-repeat-"));
  const file = path.join(dir, "queue.js");
  await fs.writeFile(file, complexSource(), "utf8");
  const { llm } = recordingBridge("Line 12 holds the invariant the task must not break.");
  const ctx = {
    cwd: dir,
    model: { id: "test/cheap", openRouterSlug: "test/cheap", input: ["text"], output: ["text"] },
    llm,
    log: () => {},
    toolModelCandidates: ["test/cheap", "test/strong"],
    task: "rename the export",
  };

  const first = await readTool.execute("c1", { path: file }, ctx);
  assert.match(first.output, /ANALYSIS OF THE FILE ABOVE/);
  assert.match(first.output, /Line 12 holds the invariant/);

  const second = await readTool.execute("c2", { path: file, offset: 3, limit: 5 }, ctx);
  assert.ok(!second.output.includes("Line 12 holds the invariant"), "not repeated verbatim");
  assert.match(second.output, /already given with an earlier read/, "a pointer instead");
  assert.ok(second.output.length < first.output.length, "and it is shorter");
  await fs.rm(dir, { recursive: true, force: true });
});
