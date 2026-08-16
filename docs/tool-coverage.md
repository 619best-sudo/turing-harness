# Tool coverage: what has guidance, and what is still bare

The harness exposes 25 built-in tools. Some now carry deliberate guidance — a
default the model is told, a reason it exists, and a way to override it. The rest
work, but the model gets nothing beyond their parameter descriptions.

This page is the ledger of which is which.

## How guidance is meant to work

Everything in the guidance blocks is a **default, not policy** — stated once in
`GUIDELINE_CONTRACT` rather than hedged into each block, because repeating "but you
may deviate" everywhere trains a model to discount all of it.

- **The user's request outranks all of it.** A default that contradicts an explicit
  instruction is a default that is wrong for this run.
- The model may also deviate on its own judgement with a concrete reason, stated in
  one line. Deviating knowingly is doing the job; the guidance exists to catch
  *guessing*, not thinking.
- Not reasons to deviate: it seemed faster, you didn't check, you assumed.
- A few things are **not** defaults and hold regardless: never report unfinished
  work as done, never present a placeholder as a real asset, never claim a
  verification you didn't run.
- Runtime notes (from `SearchLadderAdvisor`, `ToolFallbackAdvisor`) are advice
  written with *less* context than the model has. Weigh them; don't obey reflexively.

The one place code steers rather than suggests — `assets_generator` declining an
animated-SVG request — takes `force: true` for exactly this reason.

## Covered

| Tool(s) | Guidance | Doc |
|---|---|---|
| `file_memory`, `graph_memory`, `project_memory`, `grep`, `ls` | `FILE_SEARCH_LADDER` + `SearchLadderAdvisor` (runtime) | [file-search](./file-search.md) |
| `read`, `write`, `edit` | `CODE_CHANGE_ATTENTION` + `CODE_RISK_SITES` in four framings (rater, comprehension, authoring, requester) | [code-changes](./code-changes.md) |
| `create_plan` | rewritten default prompt: end-to-end coverage, hero/animation decomposition, attachment routing, `isCompleted` ownership | [plan-tool](./plan-tool.md) |
| `assets_generator` | `ASSETS_AND_SVG` + the animated-vector steer (with `force`); input `images` with roles (reference/style/mask/start_frame/last_frame) and `count` for a set; declines on a `backend` project | [assets](./assets.md) |
| `inspiration_generator` | `INSPIRATION_REUSE`: when to look one up, sections come from different designs, borrow structure/composition and replace content-colors-imagery, posters included | [inspiration](./inspiration.md) |
| `media_analysis` | `MEDIA_UNDERSTANDING`; lenses wired (`ocr`/`ui`/`component`/`qa`), `url` screenshot capture, plus the orchestrator's triage pre-pass (category + verbatim OCR, run-level and per plan step) | [media-analysis](./media-analysis.md) |
| `web_search`, `web_fetch` | `WEB_AND_SCRAPING`: version-first debugging, scraping as first-class work, UI capture handoff | [web-and-scraping](./web-and-scraping.md) |
| `activity_*` (8 tools) | `DEBUGGING_LOOP`: who runs the app, instrument the risk sites end-to-end, browser-log sink, UI probe → media lens, fix→prove→revert | [debugging](./debugging.md) |
| `ask_user_question` | `ASKING_THE_USER`: which decisions are the user's, which are yours, and how to ask so it costs one click. Now available in **every** phase, with option trade-offs + a recommendation | [asking-the-user](./asking-the-user.md) |
| every tool that writes | `VERIFY_WHAT_YOU_WROTE`: every written file gets a check, the check is chosen by what the file *does*, and behaviour you cannot see from outside gets instrumented rather than re-read | [debugging](./debugging.md) |
| `bash`, `bash_readonly` | no dedicated block, but covered from two sides: the failure ladder (`ToolFallbackAdvisor`) and the search ladder's shell rung | [loop](./loop.md#when-a-tool-keeps-failing-bash--the-user--honest-stop) |

## Not covered yet

Everything below works and is tested; none of it has guidance telling the model
*when* to reach for it or what good use looks like.

### `mark_concern_lines`

One line in `TOOL_HYGIENE` ("call it when specific lines matter"). No guidance on
what makes a line worth flagging, or how a host should render the result.

### `ls`

Covered incidentally by the search ladder (as a thing to postpone). Never described
positively — orienting in an unfamiliar directory is a legitimate first move.

### The 4P phase meta-tools

`harness.phaseTools()` / `chainTool()` expose the phases as tools for an outer
agent. Unexamined this pass.

### External MCP / skill tools

Whatever a host registers — browser, mobile, database. The harness routes them by
phase category, and `PROVIDER ASSIGNMENTS` from Prepare tells later phases which to
prefer, but there is no guidance on *using* a class of MCP well.

## Gated by project category

A project with no interface has nowhere to put a generated hero image and no
screen to look a design reference up for. Both visual tools already **decline** a
call when `projectCategory === "backend"` — not as an error, so the loop reads it
as guidance rather than a failure to retry. On top of that, the two visual
guidance blocks (`ASSETS_AND_SVG`, `INSPIRATION_REUSE`) are dropped from the
system prompt on a backend project, so the model does not spend a turn
discovering what the tool would have told it. The design-reference ladder inside
the work loop is gated the same way.

Left uncategorized, everything stays on: an unknown project may well have UI, and
that is the cheap direction to err in.

## End-to-end coverage

[`tests/end-to-end.test.mjs`](../tests/end-to-end.test.mjs) runs the seams rather
than the pieces:

- **The whole flow, one `Orchestrator.run`** — an attached mockup goes through
  `media_analysis` (`ui` lens) → `create_plan` (which sees the attachment listed
  and routes it to the step that needs it) → host approval with a per-step note →
  the step's work loop → a `write` that escalates to a **vision** model because the
  step carries an image, with no host `authorModel` pinned anywhere → `isCompleted`
  flipped on the plan → run summary.
- **Third-party providers as first-class citizens** — a `defineSkill` skill and an
  MCP-shaped provider are listed with their own kind/source, resolve into exactly
  the phases they declared, are callable inside the loop, pass through the
  permission gate (and can be **denied** without breaking the run), are removable,
  and a server that connects **mid-run** is picked up by the next turn through
  `resolveTools` — no restart.

## Suite health

`npm test` is 704/704 in about twenty-five seconds, and the process exits on its own.

Getting there meant fixing a failure mode worth describing, because it turns any
future bug in these files into a silent hang rather than a red test:

**A failing test used to hang the whole run.** `createProjectSession` opens a
recursive fs watcher per project, and the graph-memory / file-memory tests
released it with a bare `await harness.dispose()` on the last line of the test
body. An assertion that throws before that line skips it — so the handle stays
open, the runner reports every result, and then the process never exits. `npm
test` produced no summary at all. The symptom (a hang) looked nothing like the
cause (one wrong assertion), which is what made it expensive.

Both files now build the harness through `makeHarness(t)`, which registers
`t.after(() => harness.dispose())`. Teardown runs on the failure path too, so a
broken test is a *failure* again. Verified by injecting an assertion failure
ahead of the explicit dispose: the run reports `fail 1` and exits.

The two assertions that were actually wrong:

- `graph-memory` read `details.notes` off a `symbol_deps` result that is a lazy
  detail envelope, so the field is undefined by construction — the file's own
  `readLazyGraphResult` helper is what that assertion needed.
- `file-memory`'s suspend/resume test raced `mkproject()`'s hundred-odd setup
  writes, failing one way in isolation (setup files in the flushed batch) and
  another way under full-suite load (nothing flushed in time). It now lets those
  events drain before it subscribes.
