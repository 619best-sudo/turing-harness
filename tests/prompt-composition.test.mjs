/**
 * Prompt COMPOSITION: a phase reads guidance for the tools it actually has.
 *
 * Every guidance block prevents a real failure, and every one of them used to be
 * injected unconditionally — so PERFORM shipped ~11k tokens of system prompt in
 * which a third described tools the run had never been given. That is not only
 * waste: instructions for an absent tool cannot be acted on, so they dilute the
 * ones that can, and a very long undifferentiated prompt is how a model loses its
 * grip on the task.
 *
 * What this file protects is the gate. The full-text exports must stay complete
 * (hosts and the sibling guidance tests read them), the gated builder must drop
 * exactly the blocks whose tools are missing and keep the ones present, and the
 * SHARED parts — who the agent is, the handoff contract, the escalation ladder —
 * must survive every filtering, because those are not situational.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASKING_THE_USER,
  ASSETS_AND_SVG,
  BUILD_TYPECHECK_COMMANDS,
  CODE_CHANGE_ATTENTION,
  COMPLEXITY_CONTRACT,
  DEBUGGING_LOOP,
  FILE_SEARCH_LADDER,
  INSPIRATION_REUSE,
  MEDIA_UNDERSTANDING,
  PROJECT_LEARNING,
  RUN_ORDER,
  VERIFY_WHAT_YOU_WROTE,
  WEB_AND_SCRAPING,
} from "../dist/index.js";
import { WORK_PROMPT, READ_PROMPT, INSPECT_PROMPT, CATEGORIZER_PROMPTS, buildWorkPrompt, buildPhaseLikePrompt } from "./helpers/v2-prompts.mjs";

/** The block each tool is the reason for. */
const GATED = [
  ["media_analysis", MEDIA_UNDERSTANDING],
  ["assets_generator", ASSETS_AND_SVG],
  ["inspiration_generator", INSPIRATION_REUSE],
  ["web_search", WEB_AND_SCRAPING],
  ["ask_user_question", ASKING_THE_USER],
  ["activity_trace_start", DEBUGGING_LOOP],
  ["file_memory", FILE_SEARCH_LADDER],
];

const BARE = ["read", "write", "edit", "bash"];
const EVERYTHING = [...BARE, ...GATED.map(([tool]) => tool)];

test("no tool list means the full prompt — the static exports stay complete", () => {
  assert.equal(buildPhaseLikePrompt("perform"), CATEGORIZER_PROMPTS.write_edit);
  assert.equal(buildWorkPrompt(), WORK_PROMPT);
});

test("a block is present when its tool is, and absent when it is not", () => {
  const rich = buildPhaseLikePrompt("perform", EVERYTHING);
  const bare = buildPhaseLikePrompt("perform", BARE);
  for (const [tool, block] of GATED) {
    assert.ok(rich.includes(block), `${tool} is attached but its guidance is missing`);
    assert.ok(!bare.includes(block), `${tool} is absent but its guidance was still injected`);
  }
  // The gate has to actually pay for itself.
  assert.ok(bare.length < rich.length * 0.6, "gating a bare toolset saved almost nothing");
});

test("one present tool pulls in its own block and nothing else", () => {
  const withMedia = buildPhaseLikePrompt("perform", [...BARE, "media_analysis"]);
  assert.ok(withMedia.includes(MEDIA_UNDERSTANDING));
  assert.ok(!withMedia.includes(ASSETS_AND_SVG));
  assert.ok(!withMedia.includes(WEB_AND_SCRAPING));
});

test("an MCP-namespaced tool still matches its block", () => {
  // Servers prefix their tools (`mcp__foo__media_analysis`, `browser_navigate`),
  // so a literal-equality gate would silently drop guidance for a tool the phase
  // genuinely has.
  const namespaced = buildPhaseLikePrompt("perform", [...BARE, "mcp__vision__media_analysis"]);
  assert.ok(namespaced.includes(MEDIA_UNDERSTANDING), "a namespaced tool name did not match");
});

test("filtering never removes the phase's own identity or contracts", () => {
  const bare = buildPhaseLikePrompt("perform", BARE);
  assert.match(bare, /You are the WRITE\/EDIT categorizer/);
  assert.match(bare, /ALWAYS PLAN FIRST/);
  assert.match(bare, /YOUR EXPECTATION/);
  assert.match(bare, /WHEN A TOOL KEEPS FAILING/);
  // The complexity scale routes models on every write/edit, so it is core, not
  // situational — a phase that can mutate always carries it.
  assert.ok(bare.includes(COMPLEXITY_CONTRACT));

  const loop = buildWorkPrompt(BARE);
  assert.match(loop, /You are the WRITE\/EDIT categorizer/);
  assert.match(loop, /ALWAYS PLAN FIRST/);
  assert.match(loop, /deliver/);
  assert.ok(loop.includes(VERIFY_WHAT_YOU_WROTE), "the loop must still close out with a verification pass");
});

test("every phase carries the complexity scale it is asked to produce ratings on", () => {
  // PREPARE rates each file, PLAN rates each task, PERFORM declares per call —
  // and the rating is inherited across those boundaries, so one definition has to
  // reach all three or the same word means three things.
  for (const phase of ["prepare", "plan", "perform"]) {
    assert.ok(
      buildPhaseLikePrompt(phase, BARE).includes(COMPLEXITY_CONTRACT),
      `${phase} produces complexity ratings without being told what they mean`,
    );
  }
  assert.ok(WORK_PROMPT.includes(COMPLEXITY_CONTRACT));
});

test("the scale says what a rating buys, and names the category axis separately", () => {
  assert.match(COMPLEXITY_CONTRACT, /ROUTES MODELS/);
  assert.match(COMPLEXITY_CONTRACT, /stronger AUTHOR/);
  // The two failure modes: rating the diff instead of the change, and treating a
  // small diff as automatically safe.
  assert.match(COMPLEXITY_CONTRACT, /never the length of the text you/);
  assert.match(COMPLEXITY_CONTRACT, /A small diff is not automatically low/);
  // Category selects what the escalated model must be good at — it does not decide
  // whether to escalate.
  assert.match(COMPLEXITY_CONTRACT, /CATEGORY is INDEPENDENT of the rating/);
  for (const cat of ["ui", "svg", "code"]) {
    assert.ok(COMPLEXITY_CONTRACT.includes(`\`${cat}\``), `category ${cat} is undefined`);
  }
  assert.match(COMPLEXITY_CONTRACT, /Do not inflate a rating/);
});

test("PERFORM is told to declare both axes on every mutation", () => {
  // The arguments are optional in the schema, and a model that omits them gets a
  // category guessed from the file extension — which is how UI work ends up
  // authored by a model picked for logic.
  assert.match(WORK_PROMPT, /DECLARE THE CALL: pass `complexity` and `category` on every `write` and `edit`/);
});

test("activity_inspect verifies visual work by looking at it, with a verdict lens", () => {
  const perfect = CATEGORIZER_PROMPTS.activity_inspect;
  // The verdict-lens discipline now lives in the DRIVING/MEDIA guidance the
  // inspect categorizer carries: judging a render is a qa-lens check, never
  // prose over a screenshot.
  assert.match(perfect, /VERIFYING A RENDER/);
  assert.match(perfect, /lens:"qa"/);
  assert.match(perfect, /VISUAL QA OF UI YOU JUST BUILT/);
  assert.ok(perfect.includes(CODE_CHANGE_ATTENTION) === false, "activity_inspect does not author code");
});

test("the loop closes the fix cycle itself — it has no PERFECT phase to hand a FIX to", () => {
  // In the classic run there is no Perform→Perfect round trip, so "verify, and if
  // it fails, fix and re-verify" has to be one instruction in the loop's own
  // close-out. Finishing on a red check is the one outcome the user cannot use.
  assert.match(VERIFY_WHAT_YOU_WROTE, /WHEN A CHECK FAILS, THE RUN IS NOT OVER/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /RE-RUN THE SAME check/);
  // No stacking speculative fixes, and no silently dropping the failure.
  assert.match(VERIFY_WHAT_YOU_WROTE, /REVERT that attempt/);
  assert.match(VERIFY_WHAT_YOU_WROTE, /never quietly drop\s+a failing check/);
  assert.ok(WORK_PROMPT.includes(VERIFY_WHAT_YOU_WROTE));
});

test("a bug-fix run injects the reproduce-first directive; a normal run does not", () => {
  // The directive is PROACTIVE: it states the discipline at the top of the run,
  // before the model commits to a fix, so reproducing first is the plan rather
  // than a wall at edit time. A feature run must not carry it.
  const feature = buildWorkPrompt(BARE);
  const bugfix = buildWorkPrompt(BARE, { isBugFix: true });

  // The directive's unique opening line — not the generic DEBUGGING guidance a
  // feature run may also carry.
  assert.ok(!feature.includes("THIS RUN IS FIXING A REPORTED BUG"), "a non-bug-fix run carries no bug-fix directive");
  assert.ok(!feature.includes("fix exactly what its evidence shows"));

  assert.match(bugfix, /THIS RUN IS FIXING A REPORTED BUG/);
  assert.match(bugfix, /fix exactly what its evidence shows/);
  // It names the inspect pass — the v2 reproduction path — so the model has
  // seen the route before it ever guesses a fix.
  assert.match(bugfix, /activity_inspect/);
});

// ---------------------------------------------------------------------------
// The flat loop does the work of PERFORM and PERFECT in one pass, so its
// guidance must be a SUPERSET of both.
//
// It was not. `BUILD_TYPECHECK_COMMANDS` sat in both phase lists and was lost
// when the loop's list was written by merging them — invisibly, because no gate
// and no test covered the omission. Two blocks the loop DOES carry point at it
// by name ("see BUILD / TYPECHECK / LINT"), so the model was told twice to run
// the project's own build command, given neither the method for finding it nor
// the rule that `command not found` is a resolution failure rather than proof
// the toolchain is absent. A real run on a Flutter app reached exactly that
// wrong conclusion and shipped a UI change verified by nothing.
// ---------------------------------------------------------------------------

/** Every exported guidance block, by the name it is exported under. */
const ALL_BLOCKS = {
  ASKING_THE_USER,
  ASSETS_AND_SVG,
  BUILD_TYPECHECK_COMMANDS,
  CODE_CHANGE_ATTENTION,
  COMPLEXITY_CONTRACT,
  DEBUGGING_LOOP,
  FILE_SEARCH_LADDER,
  INSPIRATION_REUSE,
  MEDIA_UNDERSTANDING,
  PROJECT_LEARNING,
  RUN_ORDER,
  VERIFY_WHAT_YOU_WROTE,
  WEB_AND_SCRAPING,
};

/** A tool list broad enough that no block is gated out. */
const EVERY_TOOL = [
  "read", "write", "edit", "ls", "grep", "bash",
  "project_memory", "file_memory", "graph_memory",
  "media_analysis", "assets_generator", "inspiration_generator",
  "ask_user_question", "web_search", "web_fetch", "web_scrape",
  "activity_trace_start", "activity_collect", "activity_study", "activity_inspect",
];

test("the flat loop carries every block PERFORM or PERFECT carries", () => {
  const loop = buildWorkPrompt(EVERY_TOOL);
  const perform = buildPhaseLikePrompt("perform", EVERY_TOOL);
  const perfect = buildPhaseLikePrompt("perfect", EVERY_TOOL);

  const dropped = Object.entries(ALL_BLOCKS)
    .filter(([, text]) => perform.includes(text) || perfect.includes(text))
    .filter(([, text]) => !loop.includes(text))
    .map(([name]) => name);

  assert.deepEqual(dropped, [], `the flat loop replaced both phases but dropped: ${dropped.join(", ")}`);
});

test("no carried block cross-references a section the loop omits", () => {
  // A dangling "see X" is worse than no reference: it tells the model there is
  // more detail somewhere and there is not.
  const loop = buildWorkPrompt(EVERY_TOOL);
  // The reference is wrapped across lines in the source, so match across it.
  assert.match(loop, /see\s+BUILD \/ TYPECHECK \/ LINT/, "the cross-reference exists");
  assert.ok(
    loop.includes("BUILD / TYPECHECK / LINT — one command covers"),
    "and the section it points at is present",
  );
});

test("the build block carries the command-not-found rule the flat loop needs", () => {
  // The specific sentence a real run needed and did not get.
  const loop = buildWorkPrompt(EVERY_TOOL);
  assert.match(loop, /`command not found` IS NOT `not installed`/);
  assert.match(loop, /Never\s+downgrade verification/);
  assert.match(loop, /\.fvm\/flutter_sdk/, "names the pinned-toolchain shapes bash resolves");
});

test("a run with no shell does not carry build guidance it cannot act on", () => {
  const noShell = buildWorkPrompt(EVERY_TOOL.filter((t) => t !== "bash"));
  assert.ok(!noShell.includes("BUILD / TYPECHECK / LINT — one command covers"));
});
