/**
 * The guidance blocks, as one system.
 *
 * Five blocks were written separately (`FILE_SEARCH_LADDER`, `CODE_CHANGE_ATTENTION`,
 * `MEDIA_UNDERSTANDING`, `ASSETS_AND_SVG`, `WEB_AND_SCRAPING`) plus the contract
 * that frames them. Individually each one is tested where its tool is tested; what
 * this file protects is the seams — that they are all actually WIRED, that they do
 * not teach the same thing twice in drifting words, that they hand off to each
 * other by name, and that every one of them is a default the user can override.
 *
 * A guidance block that is not in the prompt is a comment. A block that contradicts
 * its neighbour is worse than either alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASKING_THE_USER,
  ASSETS_AND_SVG,
  CODE_CHANGE_ATTENTION,
  CODE_RISK_SITES,
  DEBUGGING_LOOP,
  FILE_SEARCH_LADDER,
  GUIDELINE_CONTRACT,
  INSPIRATION_REUSE,
  MEDIA_UNDERSTANDING,
  VERIFY_WHAT_YOU_WROTE,
  WEB_AND_SCRAPING,
} from "../dist/index.js";
import { WORK_PROMPT, READ_PROMPT, INSPECT_PROMPT, CATEGORIZER_PROMPTS, buildWorkPrompt, buildPhaseLikePrompt } from "./helpers/v2-prompts.mjs";

const BLOCKS = {
  GUIDELINE_CONTRACT,
  ASKING_THE_USER,
  DEBUGGING_LOOP,
  FILE_SEARCH_LADDER,
  CODE_CHANGE_ATTENTION,
  MEDIA_UNDERSTANDING,
  ASSETS_AND_SVG,
  INSPIRATION_REUSE,
  WEB_AND_SCRAPING,
  VERIFY_WHAT_YOU_WROTE,
};

test("every block reaches the model it was written for", () => {
  for (const [name, text] of Object.entries(BLOCKS)) {
    assert.ok(WORK_PROMPT.includes(text), `${name} is missing from the loop prompt`);
  }
  // write_edit is the v2 categorizer that reads, writes, generates and carries
  // the work-pass superset; read is read-only and deliberately does not.
  for (const name of ["FILE_SEARCH_LADDER", "CODE_CHANGE_ATTENTION", "MEDIA_UNDERSTANDING", "ASSETS_AND_SVG", "INSPIRATION_REUSE", "WEB_AND_SCRAPING", "GUIDELINE_CONTRACT", "ASKING_THE_USER", "DEBUGGING_LOOP"]) {
    assert.ok(CATEGORIZER_PROMPTS.write_edit.includes(BLOCKS[name]), `${name} is missing from write_edit`);
  }
});

test("the contract comes first: the user outranks every default", () => {
  // Stated once, at the top, rather than hedged into each block — repeating "but
  // you may deviate" everywhere trains a model to discount all of it.
  assert.match(GUIDELINE_CONTRACT, /DEFAULTS, not policy/);
  assert.match(GUIDELINE_CONTRACT, /THE USER'S REQUEST OUTRANKS ALL OF IT/);
  assert.match(GUIDELINE_CONTRACT, /State the reason in one line/);
  // Deviating for a reason is the job; deviating because you didn't check is not.
  assert.match(GUIDELINE_CONTRACT, /What is NOT a reason to deviate/);
  // The few things that are not negotiable are named as such.
  assert.match(GUIDELINE_CONTRACT, /never report unfinished work as done/);
  assert.match(GUIDELINE_CONTRACT, /never present a placeholder as a/);
  // And the runtime notes are framed as advice from less context, not orders.
  assert.match(GUIDELINE_CONTRACT, /LESS context/);

  const contractAt = WORK_PROMPT.indexOf(GUIDELINE_CONTRACT);
  for (const [name, text] of Object.entries(BLOCKS)) {
    if (name === "GUIDELINE_CONTRACT") continue;
    assert.ok(
      contractAt < WORK_PROMPT.indexOf(text),
      `${name} appears before the contract that frames it`,
    );
  }
});

test("each block hands off to its neighbours instead of restating them", () => {
  // Capturing a UI: the web block owns copy + computed styles, media_analysis owns
  // reading the screen. Exactly one of them teaches "build from the system".
  assert.match(WEB_AND_SCRAPING, /the analysis belongs to "media_analysis"/);
  assert.match(MEDIA_UNDERSTANDING, /REPLICATING SOMETHING THAT ALREADY EXISTS/);
  assert.doesNotMatch(WEB_AND_SCRAPING, /Extract the SYSTEM, not the markup/);

  // Finding callers before an edit: the risk list points at the graph tools the
  // search ladder introduces, rather than re-explaining them.
  assert.match(CODE_RISK_SITES, /graph_memory/);
  assert.match(FILE_SEARCH_LADDER, /graph_memory/);

  // Library breakage: the risk list defers to the web block's changelog routine.
  assert.match(CODE_RISK_SITES, /read the changelog/);
  assert.match(WEB_AND_SCRAPING, /CHANGELOG/);

  // Attachments: media_analysis explains why analysis precedes planning, and the
  // planning guidance is where routing happens.
  assert.match(MEDIA_UNDERSTANDING, /ANALYSE BEFORE YOU PLAN/);
  assert.match(MEDIA_UNDERSTANDING, /create_plan/);

  // Escalating a blocker: the failure ladder owns the WHEN (after ~2 failures),
  // the asking block owns the HOW. Neither re-teaches the other.
  assert.match(ASKING_THE_USER, /that is the escalation rung of the tool-/);
  assert.match(WORK_PROMPT, /call\n?\s*`ask_user_question` with a specific, answerable question/);

  // Debugging reuses rather than restates: the risk sites say where to instrument,
  // media_analysis says how to look at a UI, asking says who runs the app.
  assert.match(DEBUGGING_LOOP, /Put them at the risk sites/);
  assert.match(DEBUGGING_LOOP, /"media_analysis"/);
  assert.match(DEBUGGING_LOOP, /"ask_user_question"/);
  assert.doesNotMatch(DEBUGGING_LOOP, /lens:"ui" — a whole web or mobile screen/);

  // Vector work: the assets block is the one that draws the generate/author line.
  assert.match(ASSETS_AND_SVG, /SVG IS CODE, SO PREFER WRITING IT/);
  assert.doesNotMatch(MEDIA_UNDERSTANDING, /SVG IS CODE/);
});

test("the blocks do not contradict each other on the shell", () => {
  // The search ladder sends you to the shell after memory comes up empty; the
  // failure ladder sends you there when a tool keeps failing. Neither may read as
  // "never use the shell", because both end up there legitimately.
  // Asserted by intent, not by phrasing: the ladder must sanction the shell for
  // the jobs it genuinely suits, without wording that reads as "never".
  assert.match(FILE_SEARCH_LADDER, /USE `grep`\/shell DIRECTLY when it is genuinely the better tool/);
  assert.doesNotMatch(FILE_SEARCH_LADDER, /never use (the )?(shell|grep)/i);
  assert.match(WORK_PROMPT, /FALL BACK TO THE SHELL/);
  assert.doesNotMatch(WORK_PROMPT, /never use (the )?(shell|bash)/i);
});

test("guidance is phrased as defaults, not as prohibitions with no way out", () => {
  // Spot-check the blocks that most tempt an absolutist phrasing. Each states its
  // reasoning or its escape hatch next to the instruction.
  // The ladder states its escape hatch ONCE, at the end. It used to repeat some
  // form of "you don't have to" nine times, which a small model reads as
  // permission to skip the ladder entirely — so this asserts the hatch exists
  // and that it has not multiplied again.
  assert.match(FILE_SEARCH_LADDER, /Deviating from this ladder is fine when you have a concrete reason/);
  const hedges = FILE_SEARCH_LADDER.match(/not a rule|unless you|your judgement|just comply|fully sanctioned/gi);
  assert.equal(hedges, null, `ladder should hedge once, found: ${hedges}`);
  assert.match(CODE_CHANGE_ATTENTION, /Do not inflate or deflate difficulty/);
  assert.match(ASSETS_AND_SVG, /they outrank the default: pass `force: true`/);
  assert.match(WEB_AND_SCRAPING, /it is the JOB, so do it/);
});

test("inspiration is offered as a fallback, not a default, and never as a clone", () => {
  // The tool only makes sense when the run has nothing of its own to work from —
  // a user's own mockup is always the better reference.
  assert.match(INSPIRATION_REUSE, /you\s+have\s+NO\s+reference\s+of\s+your\s+own/i);
  assert.match(INSPIRATION_REUSE, /media_analysis.*lens:"ui"/s);
  // One lookup, not a retry loop against the same store.
  assert.match(INSPIRATION_REUSE, /do not retry with reworded/i);
  // Sections come from different designs — the run has to make them cohere.
  assert.match(INSPIRATION_REUSE, /DIFFERENT stored designs/);
  // Posters borrow composition, which is the same rule in another medium.
  assert.match(INSPIRATION_REUSE, /POSTERS AND STATIC COMPOSITIONS WORK THE SAME WAY/);
  // The line that matters: structure yes, identity no.
  assert.match(INSPIRATION_REUSE, /NOT A CLONE/);
  for (const rule of [/CONTENT:/, /COLORS:/, /IMAGES & LOGOS:/, /ICONS:/, /TYPOGRAPHY:/, /ANIMATION:/]) {
    assert.match(INSPIRATION_REUSE, rule);
  }
});

test("a written file is not verified by re-reading it", () => {
  // The whole point of the block: coverage, then evidence.
  assert.match(VERIFY_WHAT_YOU_WROTE, /every file you created or modified/i);
  assert.match(VERIFY_WHAT_YOU_WROTE, /re-reading a file only proves the bytes landed/i);
  // Each verifier is chosen by what the file does, not by what is convenient.
  for (const method of [/test runner or typecheck/, /curl/, /activity_inspect/, /lens:"qa"/]) {
    assert.match(VERIFY_WHAT_YOU_WROTE, method);
  }
  // A visual change is verified by looking at the pixels, and the block must say
  // so WITHOUT a "if a browser/mobile MCP is connected" hedge. That hedge is the
  // exact loophole a real run took: with a device server connected and a simulator
  // booted, it fixed a Flutter screen, "verified" with shell commands, and
  // finished — never having looked at the screen it changed.
  assert.match(VERIFY_WHAT_YOU_WROTE, /THE SHELL IS NOT A VISUAL CHECK/);
  assert.doesNotMatch(VERIFY_WHAT_YOU_WROTE, /MCP if one is connected/);
  // Mobile is not a lesser case that falls back to "build it and see if it compiles".
  assert.match(VERIFY_WHAT_YOU_WROTE, /capturing the simulator, not by rebuilding the app/);
  // Missing capability is reported, never silently downgraded to a source review.
  assert.match(VERIFY_WHAT_YOU_WROTE, /never report a visual change as done on the source alone/);
  // Inspection is legitimate exactly once: artifacts with no runtime behaviour.
  assert.match(VERIFY_WHAT_YOU_WROTE, /no runtime behaviour at all \(docs, config, fixtures\)/);
  // Behaviour you cannot observe gets instrumented rather than re-read.
  assert.match(VERIFY_WHAT_YOU_WROTE, /activity_trace_start/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /activity_collect/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /activity_study/);
  // And the scaffolding comes back out.
  assert.match(VERIFY_WHAT_YOU_WROTE, /activity_cleanup/);
  // Honesty is not a default that can be traded away.
  assert.match(VERIFY_WHAT_YOU_WROTE, /Never describe a check you did not run/);
});

test("the verify block hands off to the debugging loop instead of restating it", () => {
  // Two blocks, one activity_* workflow. VERIFY points at DEBUGGING's steps for
  // the how; it must not grow a second, drifting copy of them.
  assert.match(VERIFY_WHAT_YOU_WROTE, /the `activity_\*` loop from the DEBUGGING section/);
  assert.ok(
    !VERIFY_WHAT_YOU_WROTE.includes("activity_trace_start` hands you a `__t()` snippet"),
    "VERIFY_WHAT_YOU_WROTE should defer to DEBUGGING_LOOP, not duplicate its instructions",
  );
});

// ---------------------------------------------------------------------------
// Stitching added after the QA-engineer pass. Each of these is a place where two
// blocks describe the same activity and had drifted apart.
// ---------------------------------------------------------------------------

test("the cheapest gate is stated once and reached from both QA blocks", () => {
  // DEBUGGING_LOOP orders the whole ladder; VERIFY_WHAT_YOU_WROTE is per-file
  // and would otherwise start at the per-file rung, missing the one command
  // that covers every file at once — including a file it did not think to check.
  assert.match(DEBUGGING_LOOP, /BUILD\/TYPECHECK FIRST/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /START WITH THE ONE GLOBAL GATE/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /covers EVERY file you/);
  // Same justification in both, so neither reads as optional.
  for (const block of [DEBUGGING_LOOP, VERIFY_WHAT_YOU_WROTE]) {
    assert.match(block, /booted a server and driven a browser/);
  }
});

test("every block that reaches for the qa lens passes the built spec", () => {
  // `expected` is what turns a QA pass from "does this look plausible" into a
  // claim-by-claim check. A block that names lens:"qa" without it silently gets
  // the weaker check.
  for (const block of [MEDIA_UNDERSTANDING, VERIFY_WHAT_YOU_WROTE, DEBUGGING_LOOP]) {
    assert.match(block, /lens:"qa"/);
    assert.match(block, /`expected`/, "the built spec is passed, not just described");
  }
});

test("the risk-site enumeration does not claim a count that can go stale", () => {
  // It said "the six risk sites" and kept saying it after a seventh was added.
  assert.doesNotMatch(DEBUGGING_LOOP, /\b(six|seven) risk sites\b/);
  assert.match(DEBUGGING_LOOP, /Put them at the risk sites/);
  // And the enumeration it points at now includes the added one.
  assert.match(CODE_CHANGE_ATTENTION, /EXPENSIVE WORK/);
});
