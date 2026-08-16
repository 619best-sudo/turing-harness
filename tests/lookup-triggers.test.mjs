/**
 * The agent must go and read BEFORE it writes, not only after something breaks.
 *
 * The web guidance was entirely reactive: every trigger was "when code is not
 * working". That leaves the two most expensive cases uncovered —
 *
 *   1. writing against a third-party API from memory. Training data is a
 *      snapshot of SOME version; the lockfile is the truth, and the gap between
 *      them is risk site 6 (the most common way confident code is wrong).
 *   2. not actually understanding something — an unfamiliar convention, an error
 *      whose wording means nothing, a config key copied blind.
 *
 * Both are cheaper to fix before the fact: one search costs a turn, three wrong
 * attempts against a misremembered API cost the run.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WEB_AND_SCRAPING, CODE_RISK_SITES, buildLoopSystemPrompt } from "../dist/index.js";

test("the proactive trigger exists and is stated as before-you-write", () => {
  assert.match(WEB_AND_SCRAPING, /LOOK IT UP BEFORE YOU WRITE IT, not after it breaks/);
  // The economics, so it is not read as optional diligence.
  assert.match(WEB_AND_SCRAPING, /three wrong attempts against a misremembered API cost the run/);
});

test("third-party libraries: check the INSTALLED version, not memory", () => {
  assert.match(WEB_AND_SCRAPING, /A THIRD-PARTY LIBRARY IS INVOLVED/);
  assert.match(WEB_AND_SCRAPING, /check the INSTALLED version/);
  assert.match(WEB_AND_SCRAPING, /Your training\s+data is a snapshot of some other version; the lockfile is the truth/);
  // The specific things that drift between versions.
  assert.match(WEB_AND_SCRAPING, /signature, option names, defaults, sync-vs-promise/);
});

test("it names the trigger set concretely, not just 'when using a library'", () => {
  // "Adding a dependency / an API not used in THIS project / code that wraps one"
  // is checkable; "when unsure" is not.
  assert.match(WEB_AND_SCRAPING, /Adding a dependency/);
  assert.match(WEB_AND_SCRAPING, /an API you have not used in THIS project/);
});

test("not understanding something is itself a trigger to look it up", () => {
  assert.match(WEB_AND_SCRAPING, /YOU DO NOT ACTUALLY UNDERSTAND SOMETHING/);
  assert.match(WEB_AND_SCRAPING, /a config key you are copying without knowing what it does/);
  assert.match(
    WEB_AND_SCRAPING,
    /Writing code you cannot explain is how a plausible-looking change\s+fails/,
    "the consequence is named",
  );
  // And the honest fallback, so an unfindable answer is not silently guessed.
  assert.match(WEB_AND_SCRAPING, /say so plainly rather than\s+shipping the guess silently/);
});

test("it is bounded — lookup must not become background reading", () => {
  assert.match(WEB_AND_SCRAPING, /Keep it proportionate/);
  assert.match(WEB_AND_SCRAPING, /One or two\s+searches, then get back to the work/);
});

test("it ties back to the shared risk enumeration instead of restating it", () => {
  assert.match(WEB_AND_SCRAPING, /This is risk site 6/);
  assert.match(CODE_RISK_SITES, /6\. LIBRARIES AND EXTERNAL APIs/);
  // The risk sites stay tool-agnostic: they are shared with the authoring model,
  // which has no web tools, so tool names belong here and not there.
  assert.doesNotMatch(CODE_RISK_SITES, /web_search|web_fetch/);
});

test("the reactive path is unchanged — both triggers coexist", () => {
  assert.match(WEB_AND_SCRAPING, /WHEN CODE IS NOT WORKING, GO AND READ/);
  assert.match(WEB_AND_SCRAPING, /Suspect a BREAKING CHANGE/);
  assert.match(WEB_AND_SCRAPING, /the WEB WINS/);
});

test("all of it is gated on the web tools actually being present", () => {
  assert.match(buildLoopSystemPrompt(["read", "web_search"]), /LOOK IT UP BEFORE YOU WRITE IT/);
  assert.doesNotMatch(buildLoopSystemPrompt(["read", "write"]), /LOOK IT UP BEFORE YOU WRITE IT/);
});
