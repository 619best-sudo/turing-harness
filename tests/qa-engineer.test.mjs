/**
 * activity_* is the run's QA engineer, and the prompt has to say so.
 *
 * The block already described a debugging LOOP in detail, but never stated the
 * role or the order. Two consequences it now fixes:
 *
 *   - No stated ORDER meant the expensive rung was as reachable as the cheap
 *     one. Booting a server and driving a browser to discover a compile error is
 *     paying twice for something `tsc --noEmit` catches across every touched
 *     file in seconds.
 *   - No stated ROLE meant "verify the new work" and "reproduce the reported
 *     bug" read as different activities, when they are the same toolkit pointed
 *     at two questions — and the bug half has a precondition the other does not:
 *     reproduce BEFORE theorising, or you cannot prove the fix.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEBUGGING_LOOP,
  BUILD_TYPECHECK_COMMANDS,
  PHASE_PROMPTS,
  buildLoopSystemPrompt,
  buildPhaseSystemPrompt,
} from "../dist/index.js";

/** A perform-phase toolset that keeps the debugging block gated in. */
const ACTIVITY_TOOLS = ["read", "write", "edit", "bash", "activity_trace_start", "activity_inspect"];

test("the role and its two jobs are stated up front", () => {
  assert.match(DEBUGGING_LOOP, /YOU ARE THE QA ENGINEER FOR THIS RUN/);
  assert.match(DEBUGGING_LOOP, /A\. VERIFY NEW WORK/);
  assert.match(DEBUGGING_LOOP, /B\. REPRODUCE A REPORTED BUG/);
  assert.match(DEBUGGING_LOOP, /Reproduce it FIRST/);
  assert.match(DEBUGGING_LOOP, /ask the user for the exact steps/);
});

test("a reported bug is observed BEFORE it is edited, not after", () => {
  // The two jobs run in opposite orders and the block must say which is which.
  // A real run collapsed them: told a screen was broken, it went straight to
  // `git log`/`git show` archaeology, edited, and only looked at the app after
  // the user asked it to — so it never saw the failure it claimed to have fixed.
  assert.match(DEBUGGING_LOOP, /A\. VERIFY NEW WORK — evidence AFTER the change/);
  assert.match(DEBUGGING_LOOP, /B\. REPRODUCE A REPORTED BUG — evidence BEFORE it/);
  assert.match(DEBUGGING_LOOP, /ahead of any `write`\/`edit`/);
  // The before-capture is a baseline, not just a repro: without it, "looks right
  // now" cannot distinguish a fix from a screen that always looked that way.
  assert.match(DEBUGGING_LOOP, /BASELINE/);
  assert.match(DEBUGGING_LOOP, /files:\[before, after\]/);
  // Reading history is hypothesis-forming, never confirmation.
  assert.match(DEBUGGING_LOOP, /DO NOT open with `git log`/);
  // And the ladder must not read as post-change-only, or (B) never reaches it.
  assert.match(DEBUGGING_LOOP, /for \(B\) before you touch it/);
});

test("the cheap-to-expensive ladder puts build/typecheck first", () => {
  assert.match(DEBUGGING_LOOP, /CLIMB FROM CHEAP TO EXPENSIVE/);
  assert.match(DEBUGGING_LOOP, /BUILD\/TYPECHECK FIRST/);
  assert.match(DEBUGGING_LOOP, /covers EVERY file you touched at once/);
  assert.match(DEBUGGING_LOOP, /Stop at the rung that answers the question/);
});

test("every verification surface the tool set supports is on the ladder", () => {
  assert.match(DEBUGGING_LOOP, /npx tsc --noEmit/, "build/typecheck");
  assert.match(DEBUGGING_LOOP, /scratch script that imports/, "narrow execution");
  assert.match(DEBUGGING_LOOP, /call the endpoint for real with `bash` \(curl\)/, "backend/API");
  assert.match(DEBUGGING_LOOP, /VISUAL: screenshot it/, "visual");
  assert.match(DEBUGGING_LOOP, /INTERNAL BEHAVIOUR you cannot see from outside/, "instrumentation");
});

test("backend checks cover the unhappy paths, not just a 200", () => {
  assert.match(DEBUGGING_LOOP, /ACTUAL response body and/);
  assert.match(DEBUGGING_LOOP, /error and empty cases too/);
});

test("visual QA drives a real surface and analyses pixels", () => {
  assert.match(DEBUGGING_LOOP, /activity_inspect/);
  assert.match(DEBUGGING_LOOP, /media_analysis/);
  assert.match(DEBUGGING_LOOP, /lens:"qa" with what you built passed as `expected`/);
  assert.match(DEBUGGING_LOOP, /On mobile, drive the device/);
});

test("who runs the system is settled before anything is instrumented", () => {
  assert.match(DEBUGGING_LOOP, /WHO RUNS THE SYSTEM — settle this FIRST/);
  assert.match(DEBUGGING_LOOP, /ask \("ask_user_question"\)/);
});

test("a fix is not reported until it is proved, and failed attempts are reverted", () => {
  assert.match(DEBUGGING_LOOP, /FIX, THEN PROVE IT/);
  assert.match(DEBUGGING_LOOP, /NOT FIXED: REVERT that change/);
  assert.match(DEBUGGING_LOOP, /Never report a bug as fixed on the strength of the code looking right/);
  assert.match(DEBUGGING_LOOP, /remove every `TURING_TRACE` you added/, "instrumentation is cleaned up");
});

test("a change on top of working code owes the same evidence as a new feature", () => {
  // The skipped case. A greenfield feature obviously needs driving; an edit into
  // code that already worked looks like it inherits that code's verification, so
  // nobody drives it — and that is precisely where a regression lands.
  assert.match(DEBUGGING_LOOP, /ON TOP OF code that already worked/);
  assert.match(DEBUGGING_LOOP, /not optional/);
  assert.match(DEBUGGING_LOOP, /Cover every file this run wrote/);
});

test("the visual rung names which surface each verifier actually drives", () => {
  // "Screenshot it" is not actionable if the model has to guess what does the
  // screenshotting. Web goes through the browser MCP, a device through the
  // built-in mobile_* toolkit, and `activity_inspect` is the one call fronting both.
  assert.match(DEBUGGING_LOOP, /activity_inspect/);
  assert.match(DEBUGGING_LOOP, /Playwright/);
  assert.match(DEBUGGING_LOOP, /mobile_\*/);
  assert.match(DEBUGGING_LOOP, /booted simulator/);
});

test("the run reads back its own recorded activity, not just the surfaces it drove", () => {
  // A check that failed mid-run scrolls past. The log is the only place it
  // survives, and these are the tools that get it back.
  assert.match(DEBUGGING_LOOP, /activity_tags/);
  assert.match(DEBUGGING_LOOP, /activity_search/);
  assert.match(DEBUGGING_LOOP, /verify:fail/);
});

test("no cross-reference to a block that the carrying phase may not have", () => {
  // DEBUGGING_LOOP rides in PERFORM, which does NOT carry VERIFY WHAT YOU WROTE
  // (Perfect owns the close-out, and duplicating it would drive the simulator
  // twice per chain). So a "see VERIFY WHAT YOU WROTE" pointer resolves to
  // nothing in the one phase where it is aimed at work that just happened —
  // (A) has to stand on its own instead.
  assert.doesNotMatch(DEBUGGING_LOOP, /see VERIFY WHAT YOU WROTE/);
  assert.doesNotMatch(buildPhaseSystemPrompt("perform", ACTIVITY_TOOLS), /see VERIFY WHAT YOU WROTE/);
});

test("PERFECT reaches for activity_inspect before the raw device tools", () => {
  // The phase template used to route straight to a four-step mobile_* sequence
  // while every guidance block appended to that same prompt called
  // `activity_inspect` the canonical verifier. The model was being given two
  // different answers in one prompt.
  const perfect = PHASE_PROMPTS.perfect;
  assert.match(perfect, /START WITH `activity_inspect`/);
  assert.ok(
    perfect.indexOf("START WITH `activity_inspect`") < perfect.indexOf('mobile { action: "devices" }'),
    "the wrapper has to be offered before the sequence it wraps",
  );
  assert.match(perfect, /RAW FALLBACK/);
});

test("the numbered steps are contiguous and cross-references resolve", () => {
  // A renumber that leaves a dangling "see 4 below" sends the model to the wrong
  // rung, which is worse than no cross-reference at all.
  assert.doesNotMatch(DEBUGGING_LOOP, /see 4 below/);
  assert.doesNotMatch(DEBUGGING_LOOP, /^ {2}7\. /m, "no orphaned step from the old numbering");
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.match(DEBUGGING_LOOP, new RegExp(`^ {2}${n}\\. `, "m"), `step ${n} present`);
  }
});

test("it stays compact — this block is carried on every tool-bearing turn", () => {
  // Not arbitrary: it rides in the system prompt of every loop that has the
  // activity tools, so growth here is paid on each turn of every run.
  //
  // Raised from 7500 to buy two things that were costing more than their bytes:
  // naming WHICH surface each verifier drives (Playwright for web, the mobile toolkit for a
  // device) on rung 4, because "screenshot it" left the model to guess how; and
  // stating in (A) that a change made ON TOP OF working code owes the same
  // evidence as a new feature, which is the case that was actually being skipped.
  // Raised again to name the DECLARE_REPRODUCE escape for a straightforward fix
  // (typo/constant/config) that genuinely needs no reproduction — a binding,
  // auditable bypass beats a silent maxBlocks give-up.
  // This is a ceiling to push back on drift, not a target — pay for new material
  // by cutting old material first.
  assert.ok(DEBUGGING_LOOP.length < 9000, `DEBUGGING_LOOP is ${DEBUGGING_LOOP.length} chars`);
});

test("the block is gated on the activity tools actually being present", () => {
  const withTools = buildLoopSystemPrompt(["read", "write", "activity_trace_start"]);
  const without = buildLoopSystemPrompt(["read", "write"]);
  assert.match(withTools, /YOU ARE THE QA ENGINEER/);
  assert.doesNotMatch(without, /YOU ARE THE QA ENGINEER/, "no dead guidance for a run that cannot act on it");
});

test("the build/typecheck block teaches the manifest as the source of the command", () => {
  // Rung 1 makes a one-command-covers-everything claim, but that only holds if
  // the model runs the command the project's OWN toolchain defines. A hard-coded
  // stack list goes stale the moment a project adopts a new tool and is blind to
  // any stack it never named — so the most leveraged check was the one getting
  // skipped. The manifest is the source of truth the project itself maintains, so
  // the block must teach finding the command THERE rather than guessing a stack.
  assert.match(BUILD_TYPECHECK_COMMANDS, /PROJECT'S OWN MANIFEST/i);
  // It must name the manifest files to open, across surfaces, so "read the
  // manifest" is actionable rather than vague.
  for (const manifest of ["package.json", "go.mod", "Cargo.toml", "pubspec.yaml", "pyproject.toml", "pom.xml", "build.gradle"]) {
    assert.match(BUILD_TYPECHECK_COMMANDS, new RegExp(manifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `BUILD_TYPECHECK_COMMANDS must name the ${manifest} manifest`);
  }
  // Build AND typecheck/lint are separate passes — a build that compiles is not a
  // typecheck that passes. The block must say so, and tell the model to add a
  // command when the manifest defines none rather than skip the gate.
  assert.match(BUILD_TYPECHECK_COMMANDS, /BOTH the build AND the typecheck\/lint/i);
  assert.match(BUILD_TYPECHECK_COMMANDS, /ADD one rather than skipping/i);
});

test("the build/typecheck block is wired into perform and perfect, gated on bash", () => {
  // The block is useless if it never reaches the model. It must appear when bash
  // (the tool that runs these commands) is present, and not when it is absent.
  const withBash = buildPhaseSystemPrompt("perform", ["read", "write", "edit", "bash"]);
  const withoutBash = buildPhaseSystemPrompt("perform", ["read", "write", "edit"]);
  assert.match(withBash, /BUILD \/ TYPECHECK \/ LINT/);
  assert.doesNotMatch(withoutBash, /BUILD \/ TYPECHECK \/ LINT/, "no dead build guidance without bash to run it");
  // Perfect carries it too — "the moment code stops changing" is both phases.
  const perfect = buildPhaseSystemPrompt("perfect", ["bash", "read"]);
  assert.match(perfect, /BUILD \/ TYPECHECK \/ LINT/);
});

