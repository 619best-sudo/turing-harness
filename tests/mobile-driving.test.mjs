/**
 * UI driving guidance (browser MCP and device MCP): act on ELEMENTS, not pixels
 * or guessed selectors; reason about the screen via media_analysis, not by eye.
 *
 * The failure this guards: the agent acted on coordinates/selectors it invented
 * — device taps at guessed (x, y) like 350,30 / 900,100, and browser clicks on
 * CSS selectors it never looked up — missed every target, and spiralled. The
 * loop prompt now carries a DRIVING_AUTOMATION block when a browser OR device
 * driving tool is present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLoopSystemPrompt } from "../dist/index.js";
import { DRIVING_AUTOMATION } from "../dist/phases/prompts.js";

const BASE = ["read", "write", "edit", "bash", "media_analysis", "ask_user_question"];
const WITH_MOBILE = [...BASE, "mobile_list_elements_on_screen", "mobile_click_on_screen_at_coordinates", "mobile_take_screenshot"];
const WITH_BROWSER = [...BASE, "mcp__playwright__browser_navigate", "mcp__playwright__browser_snapshot", "mcp__playwright__browser_click"];

test("DRIVING_AUTOMATION states element-over-pixel for BOTH surfaces and the media_analysis route", () => {
  assert.match(DRIVING_AUTOMATION, /ACT ON ELEMENTS, NOT PIXELS OR GUESSED SELECTORS/);
  // Browser path: snapshot ref.
  assert.match(DRIVING_AUTOMATION, /browser_snapshot/);
  assert.match(DRIVING_AUTOMATION, /BY REF/);
  // Device path: verbatim coords from bounds.
  assert.match(DRIVING_AUTOMATION, /VERBATIM/);
  assert.match(DRIVING_AUTOMATION, /never\s+pull a coordinate from memory/);
  // Screen reasoning via media_analysis, not by eye.
  assert.match(DRIVING_AUTOMATION, /media_analysis lens:"qa"/);
  assert.match(DRIVING_AUTOMATION, /reason about in\s+prose is NOT a check/);
});

test("the loop prompt includes driving guidance when MOBILE tools are present", () => {
  assert.match(buildLoopSystemPrompt(WITH_MOBILE), /ACT ON ELEMENTS, NOT PIXELS OR GUESSED SELECTORS/);
});

test("the loop prompt includes driving guidance when BROWSER (playwright) tools are present", () => {
  // MCP-namespaced playwright tools must trip the gate via the __endsWith match.
  assert.match(buildLoopSystemPrompt(WITH_BROWSER), /ACT ON ELEMENTS, NOT PIXELS OR GUESSED SELECTORS/);
});

test("the loop prompt omits driving guidance when neither surface is drivable", () => {
  assert.doesNotMatch(
    buildLoopSystemPrompt(BASE),
    /ACT ON ELEMENTS, NOT PIXELS OR GUESSED SELECTORS/,
    "no browser/device tools ⇒ no driving block",
  );
});
