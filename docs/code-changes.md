# Reading and changing code: the complexity gate and the six risk sites

Every `read`, `write` and `edit` passes through a complexity gate before it takes
effect. `low` proceeds with the model that asked; `medium` and `high` escalate to a
stronger one. That machinery already existed — what this page documents is the
contract around it, and the checklist that makes the extra spend buy something.

## The gate

Complexity is estimated per tool call (`estimateComplexity`), with a **floor**
inherited from whatever the run already knows: Prepare's per-file rating, Plan's
per-task rating, or a rating a previous `read` *measured* off the real bytes
(`complexitySource: "tool-measured"`). The rating rides on every permission
request as `complexityRating` + `complexitySource`, so the host sees it before
anything happens.

### Reading — decided internally

There is nothing to judge until the bytes exist, so `read` escalates itself, with
no host round-trip ([`stageRead`](../src/tools/builtin/coding.ts)):

1. A cheap structural **prefilter** shortcuts the obvious cases (config, data,
   prose, generated files) at zero token cost.
2. The current model **rates** the loaded file: one parseable line,
   `RATING: low|medium|high | WHY: …`.
3. `low` returns the bytes as-is. **`medium` and `high` escalate**: a stronger
   model produces an analysis that is *appended beneath* the numbered lines under
   an explicit banner. The raw bytes are never replaced — Model A still has to
   emit a byte-exact `oldString` anchor from them.
4. The measured rating is returned as `measuredComplexity` and becomes the floor
   for later calls on that path, so the run gets smarter about a file it has read.

Failures degrade rather than propagate: an unparseable or failed rating means
`low` (today's plain-read behaviour), because a read that dies takes the whole
step with it.

#### What the analysis is allowed to be

The analysis lands under a banner telling the reading model that what precedes it
is authoritative — so the model treats the analysis as authoritative too, and a
bad one is worse than none. Three guards, all added after one run produced all
three failures in a single returned analysis:

- **It is told what the run is doing.** The analyst's instructions open with
  *lead with the task*, and it used to be handed no task at all: the task was read
  from `authoringContext`, which only exists for a `write`/`edit`. Told to lead
  with a task and given none, the model does not say so — it picks a feature out
  of the file and analyses a change to it. On a run whose task was *change title
  of delete account popup*, the analysis opened `TASK: changing the "Lock screen
  Widget" label (line 767)` and spent 14KB on a feature nobody had mentioned. The
  driver followed it. `ToolContext.task` now carries the live instruction on
  **every** call, and the prompt forbids inventing one when it is genuinely
  absent.
- **Thinking is stripped.** Reasoning-channel text leaks into content on some
  models — observed as ~4KB of *"Let me write the analysis now… Actually, the task
  is a bit contradictory…"* ending in a stray `</think:opensource>`.
  `sanitizeAnalysis` cuts everything up to the last reasoning closer, and drops
  leading first-person planning.
- **Degenerate output is rejected.** The same reply opened with ~600 characters
  of `{`, `//` and `>` containing no words. Symbol-dominated output returns `""`
  and the read degrades to plain bytes. Short output is *not* degenerate — the
  prompt asks for as few words as the findings take, so `L3: acquire() may
  reenter.` passes.

The analysis is also emitted **once per file per run**. It is cached by content
hash, and re-reads of the same bytes get a one-line pointer instead of the full
text — the observed run appended one 14KB analysis to six reads of the same file,
including a 12-line window.

#### When the analysis is rejected

Rejecting is not the same as ignoring, and it must not be silent — the reader is
often a weak model, which is the whole reason the escalation exists. So:

1. **Retry once.** A collapsed generation is usually a bad sample, not a model
   that cannot do the job. The retry appends a corrective line to the prompt
   rather than re-sending it unchanged — at temperature 0 an identical request
   re-draws the identical sample.
2. **Tell the reader.** If both attempts fail, the read returns the bytes plus a
   short note: this file was rated `HIGH`, a stronger model was asked to explain
   it, and its answer was discarded — so work more carefully here, read the
   callers, keep the edit narrow. Silently falling back to a plain read would
   leave a file the harness judged too hard looking like any other. The rejected
   text is *not* included: an unusable analysis under an authoritative banner is
   the failure being prevented.
3. **Log it.** `escalation:rejected` at `warn`, naming the model. A repeatedly
   rejected escalation is a signal about the *model*, not the file.

The file's **measured rating survives regardless**, so a later `write`/`edit` on
that path still inherits `high` and still escalates its authoring model. A weak
driver never authors the bytes of a hard file, whether or not the analysis
arrived.

### Writing and editing — decided by the client

For a mutation the args exist *before* anything happens, so the decision belongs
to the host. The permission callback receives the request (including
`complexityRating`) and chooses:

| The client's decision | What ships |
|---|---|
| `{ allowed: true }` — rating passed through unchanged | **Model A's own draft is written.** Its reasoning and its bytes are accepted as-is. |
| `{ allowed: true, authorModel: <model> }` | **That model authors the bytes.** For `write` it produces the whole file; for `edit` it produces only the replacement text while Model A's anchor is preserved. |
| `{ allowed: true, model: <model> }` | Unchanged legacy meaning: Model A's bytes ship now, the *next* turn uses that model. Not an authoring escalation. |

If the authoring model returns nothing, the tool **fails loudly and writes
nothing** — it never silently falls back to Model A's draft. The draft is kept in
`details.draft` / `details.draftNewString` for diagnostics, and the authoring
call's tokens are billed into the run's usage.

`authorModel` is ignored for non-mutating tools; there is no authoring pass on a
read.

### Surviving a model that sends the wrong argument SHAPE

Tool schemas say `newString` is a string; models routinely send an array of
lines, an array of content blocks, or a one-field wrapper object, and which one
depends on the model family. That is a serialisation difference — the model said
exactly what it wanted written — so
[`tool-arg-coercion.ts`](../src/orchestrator/tool-arg-coercion.ts) joins it and
lets the call run, rather than spending a turn on a correction the model will get
wrong again.

It replaces something worse than a rejection: `edit` read the argument through
`String(args.newString ?? "")`, and `String(["a","b"])` is `"a,b"` — so a
two-line replacement was written into the file **comma-joined**, with no error
anywhere.

Driven by each tool's own JSON Schema, so it covers built-in, MCP and host tools
without naming an argument. Lines join with `\n`; pieces that already end in a
newline are chunks and join with nothing. A field whose schema accepts the shape
that arrived (`["string","array"]`) is never rewritten, and anything ambiguous —
a mixed array, a two-field object — is left for the normal validation to reject.
The result carries a note saying what was joined, so a model that keeps doing it
gets told.

### Surviving a model that ignores the format instruction

The authoring prompt says *output ONLY the raw file contents — no markdown code
fences, no commentary*. Models comply at very different rates, and the harness is
meant to work with whatever model a user prefers, so compliance cannot be
assumed. Two guards, both in
[`authored-output.ts`](../src/tools/builtin/authored-output.ts):

**Markdown artifacts are stripped.** The old stripper was one regex matching a
perfectly balanced fence with nothing around it. Everything else went into the
user's source verbatim — a leading newline, a preamble line, an **unbalanced**
fence, a `~~~` fence, an info string with a trailing space, trailing prose. On a
Dart file that wrote a bare ` ``` ` into the middle of a widget tree, a syntax
error, across four consecutive authored edits.

The sanitizer now unwraps a fenced block (discarding narration around it), and
where there is no matching pair to anchor on — the unbalanced case a regex can
never catch — sweeps whole-line fence markers and repairs the blank line each one
leaves behind. Markdown targets are treated differently on purpose: a fence is
*content* there, so only a wrapping pair is removed and prose outside it is never
discarded.

**Blank-line drift falls back to the draft.** Asked to fix one line's
indentation, an author returned the same code with blank lines inserted between
unrelated properties, repeatedly. `isBlankLineDriftOnly` fires only when the two
texts are identical once blank lines are ignored — so the draft wins in exactly
that case and real authoring work can never be discarded.

Neither repair is silent: the edit result says when a reply arrived wrapped in
markdown and how much was removed, and drift is logged under
`authoring:blank-line-drift`. A model that needs repairing should be visible as
such, not smoothed over.

## The six places code actually breaks

A stronger model is only worth its cost if it is looking at the right things. Wrong
edits cluster in the same six places regardless of language, so
[`src/code-risk.ts`](../src/code-risk.ts) holds one enumeration of them, handed in
four framings to every model that touches code — the rater ("these are the
difficulty signals"), the comprehension model ("report these"), the authoring model
("get these right"), and the requesting model itself ("walk these before you
write"). One source, so the four views of a change cannot disagree.

1. **Conditionals and branches** — the implicit else; `null`/`undefined`/`0`/`""`/
   empty-array collapsing under a truthiness check; negation and `&&`/`||`
   precedence; a guard clause that doesn't actually return early; a new branch that
   must still handle every state the old one did.
2. **Functions that return a value** — the return contract is an API. Does every
   path return, or can one fall off the end as `undefined`? Is the shape the same
   on success, empty and error paths (`null` here and `[]` there is a caller-side
   crash)? Change what a function returns or accepts and the callers must change
   with it — the most common way a local edit breaks something far away.
3. **Sync vs async** — a missing `await` is invisible until it isn't, and turns
   errors into unhandled rejections. `map`/`forEach` callbacks cannot await.
   Awaiting in a loop is sequential; `Promise.all` is parallel (and sometimes a
   rate-limit violation or a race). Does cleanup still run on the throw path?
4. **Loops and iteration** — both boundaries, the zero-iteration case, accumulator
   initialization, mutation during iteration, `break`/`continue` skipping needed
   work, closures capturing the loop variable, per-iteration I/O becoming an N+1.
5. **Other files that depend on this** — renaming or re-shaping an export, moving a
   file, touching a barrel re-export, shared types needing both sides updated. Use
   `graph_memory` (`blast_radius` / `symbol_deps`) to enumerate callers instead of
   hoping; see [file search](./file-search.md).
6. **Libraries and external APIs** — the version *installed*, not the one
   remembered: does the signature exist there, are option names/defaults right,
   sync-vs-promise, throw-vs-return-error, ESM/CJS? When something that should work
   doesn't, read the changelog; see
   [web & scraping](./web-and-scraping.md#job-1--the-code-is-not-working).

These apply equally to **new code, modifications, and bug fixes** — the prompts say
so explicitly, because "just a small fix" is exactly when the checklist gets
skipped.

Two habits carry most of the rest, and are stated alongside: **read before you
write** (never edit a file you haven't read this run — the anchor you imagine is
rarely the anchor on disk), and after a non-trivial change **run the thing** rather
than asserting it works.

The rating guidance is deliberately density-based, not length-based: a 2000-line
generated barrel file is `low`; a 60-line function with nested conditionals, an
un-awaited call and three callers elsewhere is `high`. And the comprehension model
is told to report only the risks that are *real* in the file it was given — a file
with no async and no callers should not produce paragraphs about `await` and blast
radius.
