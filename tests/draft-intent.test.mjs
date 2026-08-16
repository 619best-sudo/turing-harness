/**
 * The authoring prompt is a minimal format contract, not a steering apparatus.
 *
 * History: this file originally pinned "Model A's draft must reach Model B, with
 * authority stated over scope but not quality" — a `DRAFT_INTENT` clause plus a
 * "SKETCH FROM THE WEAKER MODEL" section in the user message. That framing was
 * added to fix a real failure (B inventing a different change), but over time the
 * authoring prompt accreted ~3.6KB of steering (risk checklist, change-zone/
 * keep-zone zoning, draft-intent, "prefer the boring version") that the model
 * never sees in a chat turn — and that steering suppressed the work it was meant
 * to improve. It was all removed.
 *
 * The correctness checklist has since come back, but only for CODE: the observed
 * regression was visual (a model told to "prefer the boring version" draws
 * conservative SVG), so `ui`/`svg` and vision passes keep the bare contract while
 * logic gets the enumeration. The closer that actually misfired is gone for good.
 *
 * What remains otherwise: the format contract in the system prompt, and task +
 * current file + anchor in the user message. The tools still do not forward Model
 * A's draft at all. These tests pin that shape.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { authorEditReplacement, authorFileContent } from "../dist/tools/builtin/authoring.js";

const DRAFT_REPLACEMENT = `<header class="site-header site-header--v2">
  <h1 class="logo">Acme</h1>
</header>`;

const CURRENT = `<header class="site-header"><h1>Acme</h1></header>
<main><section id="pricing">Untouched</section></main>
<footer>© Acme</footer>
`;

/** Capture the prompt a given authoring call produces. */
function capturingLlm() {
  const seen = { system: "", user: "" };
  return {
    seen,
    llm: {
      complete: async (_model, ctx) => {
        seen.system = ctx.systemPrompt ?? "";
        const c = ctx.messages[0]?.content;
        seen.user =
          typeof c === "string"
            ? c
            : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
        return {
          role: "assistant",
          content: [{ type: "text", text: "authored" }],
          usage: null,
        };
      },
    },
  };
}

async function editPrompt(extra = {}) {
  const { seen, llm } = capturingLlm();
  await authorEditReplacement({
    llm,
    model: { id: "test/author" },
    path: "/site/index.html",
    oldString: '<header class="site-header"><h1>Acme</h1></header>',
    task: "redesign the header",
    currentContent: CURRENT,
    ...extra,
  });
  return seen;
}

async function writePrompt(extra = {}) {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/index.html",
    task: "redesign the header",
    currentContent: CURRENT,
    ...extra,
  });
  return seen;
}

// ---------------------------------------------------------------------------
// The system prompt is the minimal format contract — nothing else.
// ---------------------------------------------------------------------------

test("the system prompt is the format contract plus the risk checklist, for write and edit", async () => {
  for (const seen of [await writePrompt(), await editPrompt()]) {
    assert.match(seen.system, /written to disk verbatim/, "format contract present");
    // The correctness checklist is back for code — it is the one piece whose
    // removal was collateral damage from fixing the VISUAL regression.
    assert.match(seen.system, /CONDITIONALS AND BRANCHES/, "risk checklist present");
    // None of the steering that actually misfired survives.
    assert.doesNotMatch(seen.system, /BOUNDS SCOPE ONLY/, "no draft-intent clause");
    assert.doesNotMatch(seen.system, /prefer the boring/i, "no 'be boring' closer");
    assert.doesNotMatch(seen.system, /CHANGE ZONE|KEEP ZONE/, "no zoning framing");
  }
});

test("ui and svg authoring keep the BARE format contract — no checklist", async () => {
  // The documented regression: prose about control flow competes with the visual
  // brief and makes the model draw conservatively. Category is what separates them.
  for (const category of ["ui", "svg"]) {
    const seen = await editPrompt({ category });
    assert.match(seen.system, /written to disk verbatim/);
    assert.doesNotMatch(seen.system, /CONDITIONALS AND BRANCHES/, `${category}: no checklist`);
  }
});

// ---------------------------------------------------------------------------
// A draft passed directly to the helper is no longer specially framed.
// The tools do not forward drafts at all; a caller that does pass one should
// not see stale "SKETCH FROM THE WEAKER MODEL" framing either.
// ---------------------------------------------------------------------------

test("a draft passed to the helper is NOT rendered as a sketch section", async () => {
  const { user, system } = await editPrompt({ draftReplacement: DRAFT_REPLACEMENT });
  assert.doesNotMatch(user, /SKETCH FROM THE WEAKER MODEL/, "no sketch section");
  assert.doesNotMatch(user, /site-header--v2/, "the draft text is not echoed into the prompt");
  assert.doesNotMatch(system, /BOUNDS SCOPE ONLY/);
});

test("a draft passed to write is NOT rendered as a sketch section", async () => {
  const { user, system } = await writePrompt({ draft: "<html>A's draft</html>" });
  assert.doesNotMatch(user, /SKETCH FROM THE WEAKER MODEL/);
  assert.doesNotMatch(user, /A's draft/, "the draft text is not echoed");
  assert.doesNotMatch(system, /BOUNDS SCOPE ONLY/);
});

// ---------------------------------------------------------------------------
// The structural spec still reaches the model: anchor + whole file + task.
// ---------------------------------------------------------------------------

/**
 * The anchor is shown, and the SPLICE is stated.
 *
 * This assertion used to pin "do NOT include it in your output" on the anchor
 * header. That phrasing meant "don't echo the fences" but reads as "don't
 * reproduce this text", and a model replacing a multi-line region obeyed it
 * literally — returning only the line it meant to change, so `text.replace`
 * deleted every other line the anchor spanned. The contract now says the output
 * stands in for the whole anchor, which is what makes a multi-line edit safe.
 */
test("the anchor is shown and the replacement is scoped to the whole anchor", async () => {
  const { user } = await editPrompt();
  assert.match(user, /TEXT TO REPLACE \(the anchor\)/);
  assert.match(user, /REPLACES the entire anchor/, "the splice is stated");
  assert.match(user, /omitting a line\s+deletes it/, "the consequence of dropping a line is stated");
  assert.doesNotMatch(user, /do NOT include it in your output/, "the truncation-inducing phrasing is gone");
});

test("the edit author receives the whole file for context", async () => {
  const { user } = await editPrompt();
  assert.match(user, /CURRENT FILE CONTENTS/);
  assert.match(user, /section id="pricing"/);
});

test("the write author receives the whole file when modifying", async () => {
  const { user } = await editPrompt();
  assert.match(user, /CURRENT FILE CONTENTS/);
});

test("a brand-new file write is framed as creation, not modification", async () => {
  const { seen, llm } = capturingLlm();
  await authorFileContent({
    llm,
    model: { id: "test/author" },
    path: "/site/new.html",
    task: "add a pricing page",
  });
  assert.match(seen.user, /AUTHOR THE FILE/);
  assert.doesNotMatch(seen.user, /CURRENT FILE CONTENTS/);
});
