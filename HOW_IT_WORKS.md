# How turing-harness works

The natural-language flow of a run: from the user's prompt to a verified, completed task.
This is the operating model the loop, the orchestrator, and the tool set are built around.

```
User prompt  +  Attachments  +  MCP servers / Skills
```

- **MCP servers / Skills** are registered once at session creation and are NOT auto-invoked.
  They are surfaced to the model as available tools. The model (or, for a few, the harness)
  calls one **when the prompt needs it** — never speculatively. The tool list is the only
  channel that carries tool names; there is no roster in the system prompt.

---

## Two-stage flow selection

Which flow a run takes is decided in **two stages**, because the inputs for each decision are
available at different times.

### Stage 1 — intent, upfront (task text only, before any file is read)
A cheap, tool-free LLM classification on the user's text returns:

- **ROUTE** — `CONVERSATIONAL` or `TASK`.
- (when `TASK`) **BUGFIX** — `YES` or `NO`.

```
if (ROUTE == CONVERSATIONAL) {
  // answer directly using web_search / web_fetch; never touch the project
}
if (ROUTE == TASK) {
  run the task harness with all available tools
  // the BUGFIX label arms the reproduce gate + injects the reproduce-first
  // directive, but it does NOT by itself pick the flow — see stage 2.
}
```

`BUGFIX: YES` is what arms the reproduce-before-you-edit gate and injects the "reproduce first"
directive into the system prompt. A development task (`BUGFIX: NO`) goes straight to the
write/edit phase. A bug fix is *provisionally* in the debugging flow — but whether it actually
has to reproduce is decided after reading.

(A host that passes `isBugFix` explicitly wins over the classifier, in **both** directions:
`true` arms the gate on a run the router called `NO`, `false` keeps it inert on one it called
`YES`. The classifier's label is consulted only when the host leaves the flag unset.)

### Stage 2 — straightforwardness, after reads (code characteristics)
A bug report can be a one-line static-HTML typo or a multi-file async polling bug, and the
task text alone cannot tell them apart. So after the model has read the files, the harness
runs a **static straightforwardness assessor** (no LLM) that decides whether the *armed* gate
should actually block. This is the decision that really picks the path:

```
// runs twice: once after planning (plan-shaped — files + rating, no content), and
// again at the moment a write/edit would be blocked, with the FULL read set in hand
if (≤ 2 source files involved                                 // plan `files` ∪ files actually read
    AND no concurrency constructs in the read source          // async/await/Future/Timer/Promise/Stream/Completer/…
    AND every file MEASURED low by the read that loaded it    // the staged read's own rating
    AND planner-rated low)                                    // only checked when a planning turn ran
{
  the gate LIFTS — the bug fix flows like development: read -> write/edit -> verify
} else {
  the gate BLOCKS — the bug fix flows like debugging: read -> reproduce -> write/edit -> re-verify
}
// no source file seen yet => no verdict; the gate stays armed and reassesses later
```

The second call is the one that matters, and the reason it is late is specific: assessing after
each read would lift on a synchronous *first* file, before the model reads the file carrying the
async marker. Deferring to block time means the verdict sees every file the run has read.

The measured rating is there to close a gap the other three signals share: **they all get safer
the less the run has looked at.** File count is "files read so far", and the concurrency scan can
only find async in source it has actually seen — so read-one-file-then-edit, the precise pattern
the gate exists to stop, presents as the most straightforward fix there is. Auditing a real
317-line hydration file with no async tokens showed exactly that: the gate lifted on a bug whose
real diagnosis took four files and instrumentation. The reader's rating does not move that way,
because it describes the file rather than the run's progress through it.

So a trivial bug fix never tries to reproduce it; a real one must. The model's own
`DECLARE_REPRODUCE` remains as a fallback escape, but the verified assessor is the primary
lift path — straightforwardness is grounded in the code, not in a self-assertion.

> **Why two stages:** bug-fix-vs-development is a phrasing/intent question decidable from the
> task text. Straightforwardness depends on the *code* (how many files, is there async) — and
> the code is only known after reading. Deciding straightforwardness upfront would be a guess;
> deciding it after the full read set is evidence.

---

## How the model learns this flow

The system prompt's guidance is organised by **topic** — how to search, how to read a design, how
to instrument, how to verify — and no topical block says when it is that block's turn. So the
sequence above is also stated directly, as the `RUN_ORDER` block (`phases/prompts.ts`), which
leads the guidance in the flat loop and in Perform: attachments first, then understand the
project, then the fix/build fork, then verify by observation, then strip instrumentation before
the summary — with `ask_user_question` and `web_search`/`web_fetch` marked as throughout rather
than as a step.

It is deliberately an **index**, not a second copy: each step names the tool to reach for and
defers the detail to the block that owns it, because two copies of the same instruction drift and
then contradict each other. It also names no visual tool, so the block survives the
`projectCategory: "backend"` filter that drops the visual ladder — a map that hard-coded
`inspiration_generator` would put it back into exactly the prompt built to exclude it.

---

## Shared mechanics (both task flows)

### File search — memory first, shell only as a fallback
`project_memory` / `file_memory` / `graph_memory` are tried first. Only when the memory index
is cold or comes back empty does the search ladder fall through to `bash` (`find`, `grep`, `rg`).
This keeps search cheap and avoids re-discovering what the project already remembers.

### Read with comprehension, reused not repeated
The `read` tool is **staged by complexity**:
1. `looksTrivial` (config/json/`@generated`/<40 lines) → rated `low` instantly, no LLM cost.
2. Otherwise a cheap rater (`rateFileComplexity`) judges `low|medium|high` + a 15-word *why*.
3. Non-`low` files escalate to a stronger **comprehension** model whose analysis is
   **cached per path** and threaded forward to every subsequent write/edit on that file.

The goal of that comprehension pass: the reasoning is robust enough that **multiple read calls
are not required**, and when a file *is* re-read the cached comprehension is **reused** (not
re-derived). Identical read calls within a loop are deduped automatically.

### Attachments (images / files)
If the prompt carries an attachment, `media_analysis` is called to triage it:
- It returns an **OCR text value** and a **category**: `informational` (a spec, a stack trace,
  a data screenshot) or `ui-replicate` (a design to rebuild) or `ui-bug` (a screen showing a defect).
- **OCR / informational** text is folded into the run as a **media fact** so every following
  tool call sees it without re-deriving it.
- **ui-replicate / ui-bug** images join the run's **live attachment set** and are passed as
  `images` on the `write`/`edit` that authors the file, using a **multimodal** authoring model
  that builds/fixes from the pixels.

### One file, its own reference
The live set is **offered** to a write/edit, not applied to it. Each call routes the set to the
file it is writing (`multimodal/attachment-routing.ts`) and passes only what belongs there, in
this order of evidence:

```
1. call-named  the call passed `images` — the model chose; nothing is added to that choice
2. routed      the attachment declares `targets` (a planner routing a mockup to its step)
3. affinity    filename/label and target path share a distinctive token, and it is a strict
               winner  (login-screen.png -> src/screens/Login.tsx)
4. sole        one candidate in the whole run — the ordinary single-mockup case
5. ambiguous   several candidates, nothing to tell them apart -> NO image is passed, and the
               result names the candidates so the next call can choose
```

An attachment routed to a *different* target is never a candidate, even when that leaves the
call with nothing. The reason is the failure it replaced: unioning the whole set meant a run
carrying three screens authored `Login.tsx` while looking at the checkout and settings designs
too, and the result looks deliberate rather than broken. Authoring from prose is a recoverable
miss; authoring from the wrong design is not.

### ask_user_question
Called whenever the harness genuinely needs input (missing target value, reproduction steps,
an approval). The answer is folded back into the **same conversation** *and* into the authoring
intent, so Model B (the authoring model) sees it too — not just the driver. Attachments in an
answer are triaged the same way as prompt attachments (OCR / saved to the live set).

### web_search / web_fetch
Available on **every** task route (not only conversational). Use for library docs, changelogs,
release notes — implementing against the latest API, or diagnosing a third-party breakage via a
changelog.

---

## Development-task flow  (`BUGFIX: NO`, or a `BUGFIX: YES` the assessor lifts)

Taken by any non-bug task, **and** by a bug fix the straightforwardness assessor (stage 2)
lifts for — so a genuinely simple bug never goes through reproduction. Either way the
reproduce gate is not blocking this run: `BUGFIX: NO` never armed it; a lifted bug fix had it
disarmed by the assessor.

```
1. file search          project_memory / file_memory / bash  (memory first)
2. read                 staged by complexity, comprehension cached + reused
3. if attachments       media_analysis -> OCR + category (informational | ui-replicate)
                          OCR  -> folded in as a media fact for later tool calls
                          image-> joins the live attachment set for the write/edit
```

### Write / edit phase

The driver model emits `write`/`edit`; the **authoring model** (Model B) authors the actual
bytes from `task + current file + anchor (+ images)`. The model declares `complexity` and
`category` on each call, which routes the authoring model.

```
if (attachments == true) {
  // an image is in the live set: author write/edit FROM the pixels
  write/edit on the relevant files, multimodal, complexity/category-routed
} else {
  // no reference image present
  if (project is non-UI / backend) {
    // skip the whole visual ladder — there is no UI to design for
    write/edit on the relevant files
  } else {
    // a UI write with no reference: build a design FIRST
    inspiration_generator  -> section blueprints (JSON: layout, spacing rhythm,
                              hierarchy, motion, rationale). Plain-text/copy/hex/font
                              hints ride along, but as STRUCTURE to adapt — never copied.
    if (the design needs imagery) {
      assets_generator     -> generate the icons / imagery / video the sections call for
    }
    if (inspiration_generator returns nothing) {
      design-skill         -> design a coherent page from the brief (same JSON shape)
    }
    write/edit on the relevant files, with the design reference attached
  }
}
```

`authorOnlyWrites` mode (host-configurable): the schema drops `content`/`newString` entirely,
so Model A can only name the file + intent; Model B authors every byte. The same mode also
refuses shell-based file writes (`sed`, `>`, heredoc, `pathlib.write_text`) so source cannot
bypass the authoring model via `bash`.

One exception, and only one: `edit` takes a `probe` argument, written **verbatim with no
authoring pass**. It exists because a `__t()` log line is not code that needs authoring —
handed to Model B it comes back as a fix rather than a probe, which made instrumentation (and
therefore the reproduce gate's no-MCP route) impossible in this mode. It is accepted only when
it adds or removes probe lines and leaves every other line intact, judged by the same
predicate the reproduce gate uses, so the tool and the gate cannot disagree.

---

## Debugging-task flow  (`BUGFIX: YES`, and the assessor did NOT lift)

Taken by a bug fix whose straightforwardness assessor (stage 2) did **not** lift — i.e. it
spans >2 source files, or the read source carries a concurrency construct, or the planner rated
it above `low`. The reproduce-before-you-edit gate is **armed and blocking**. No `write`/`edit`
(and no shell source-write) is allowed until the bug is observed.

```
1. file search          project_memory / file_memory / bash
2. read                 staged by complexity, comprehension cached + reused
3. if attachments       media_analysis -> OCR + category
                          OCR    -> media fact
                          ui-bug -> image joins the live set (passed to the fix's write/edit)
4. once enough is understood -> REPRODUCE  (the gate blocks edits until this happens)
```

### Reproduce — observe the broken behaviour
`activity_inspect` drives the running system:
- **Frontend repo** → Playwright (web) or the `mobile_*` toolkit (simulator/device): navigate, capture
  screenshot + coordinates + console logs + page snapshot.
- **Any repo** → instrument, in four calls and no hand-editing. No MCP required.
  1. `activity_trace_start` — once. Calling it again while the open session has no logs
     **reuses** that session rather than opening a second empty one.
  2. **`add_log`** — `edit`'s shape (`oldString` → `newString`), none of `edit`'s machinery.
     Anchor the exact line and pass it back with your `__t("what this means", { value })`
     added. The model writes the message and picks the values, the way it would narrate the
     step to itself; the tool writes them **verbatim**. The `__t()` helper is inserted once
     per file, where the language permits a declaration (Dart and Go reject one before their
     directives).
  3. **Run the flow.** A log records nothing until the code executes.
  4. `activity_collect` — harvest what they logged.

  Each `add_log` call returns a **`logId`**. **`remove_log`** takes one back out by id — a log
  at the wrong point is noise in every later collect, and the alternative was tearing the whole
  session down and re-adding the rest — or all of them with `all: true`, optionally scoped to
  one `path`. The `__t()` helper is removed once no logging is left in a file and kept while any
  remains, because a surviving `__t()` call with no helper throws the moment that path runs.
  `activity_cleanup` does the same clearing as part of ending the session; `remove_log` leaves
  it open, so the trace file and collector survive while the source goes clean.

  Removal matches the exact lines that were written, so the file returns byte-for-byte. Anything
  the tool did not add is reported instead of guessed at.

  `add_log` is a separate tool rather than a mode of `edit` for three reasons, each of which
  was a real defect first: an authoring model **rewrites** a `newString`, so a log handed to
  `edit` on a host with `authorModel` pinned came back as an unobserved *fix*; a code mutation
  owes the **verify gate** evidence, so logging opened a debt on a change about to be
  stripped; and `edit` is gated on having observed the bug, which made the recommended route
  unreachable. It also **cannot** change code — the replacement must add or remove `__t()`
  lines and leave every other line byte-identical, judged by the same predicate the reproduce
  gate uses, so it is not a back door for the fix the gate refuses.
- Or read a log the project already writes (`activity_tail_file`).

A successful capture (or a trace with output, or asking the user for steps) **lifts the gate**.

If the user attached an image of the bug, it can be compared against the live screenshot via
`activity_inspect`'s `reference` arg (or `media_analysis` with both as `files`) to find the
exact gaps.

> A bug fix that the straightforwardness assessor **lifts** (stage 2) never reaches this
> point — it takes the development-task flow instead. Everything below assumes the gate
> stayed armed.

### Run the system to confirm the bug
The harness can drive the run itself (curl / `mobile_*` / Playwright), or wait **inline** for
the user to run it and report back — so the actual logs/state can be reasoned about.

### Fix + re-verify
```
once the exact problem is found:
  write/edit          -> the fix (authoring model; image attached if it's a UI bug)
  activity_inspect    -> verify again
  if (working) {
    activity_cleanup  -> tear the session down: delete the trace file, kill any server
                         `activity_trace_start` started, and REMOVE every line `add_log`
                         added (exact-text match, byte-exact restore). Hand-written logs it
                         did not add are reported, not guessed at.
    complete the run
  } else {
    re-fix and re-verify
  }
```

Stripping is enforced, not trusted. The loop records every file it saw probe markers written
into; before the summary the harness re-scans those paths on disk and, if any marker survives,
runs **one** capped round naming the files. A model that forgets cleanup does not ship debug
probes — and if that round still cannot clear them, the leftovers are logged rather than
silently shipped.

---

## Verification & completion (both task flows)

After the write/edit phase, `activity_inspect` validates the result:
- **data flow** — instrumentation + log watching,
- **frontend** — screenshot/coordinates/logs via Playwright or the `mobile_*` toolkit, then `media_analysis`
  on the capture,
- **backend** — call the endpoint (`curl`) and read the logs/response,
- if something is not working → fix again and re-verify.

### Replication fidelity — `lens:"compare"`
Verifying a screen against a *written* expectation is `lens:"qa"`. Verifying it against the
**design itself** is `lens:"compare"`: pass the mockup as `reference` and the screenshot as
`file`/`url`, and the analyst returns, per difference, the element's **bounding box** in both
images, the measured **delta** (dx/dy, dw/dh, the two hex values, the two font sizes), and a
**FIX** line written for the model about to edit the code — after normalizing for the two images
being different sizes. The rule that separates the two lenses: comparing against an **image** is
`compare`, comparing against a written expectation is `qa`.

The output shape is the point. A verdict the next write/edit cannot act on ("the spacing looks
off") ends the round without changing anything, so the lens is specified to produce geometry and
an imperative per entry instead. A `MISMATCH` is applied and re-compared, not just reported.
The tool refuses a `compare` with one attachment rather than quietly describing it — a diff with
one side reads back as "no differences found".

A separate **verify gate** tracks which written paths still owe runtime evidence and holds the
run open until they have it (or the model declares a change needs no runtime check).

---

## Plan mode (`planMode: true`)

A planning turn runs first; the model emits a structured plan (`PLAN_JSON` / `PLANS_JSON`).
The plan is shown for **review**, and the user can add notes or attach files to **individual
steps**. A step attachment is triaged exactly like a prompt attachment (OCR / live image set),
scoped to that step's execution only.

---

## assets_generator — multi-asset & reference-image capabilities

`assets_generator` is not single-shot. Per the OpenRouter images/video reference format:

- **Multiple assets** — `count` generates N assets in one call (each seeded distinctly).
- **Remix / image-to-image** — pass `images` with `role: "reference"` to remix/edit/extend.
- **Video with frames** — `role: "start_frame"` and `role: "last_frame"` give the clip its
  opening and closing frames (first/last-frame generation).
- **Style / mask** — `role: "style"` keeps a look consistent; `role: "mask"` constrains region.
- **Character / product sheet → video** — a reference image (character / product) is passed as
  an input image; the video is generated around it.
- **Modality** — `image` | `video` | `audio` | `3d`, each with its own options (size, duration,
  aspect, voice…).

The harness allows multiple assets / multiple `assets_generator` calls per run when the work
needs them (a hero image, an icon set, a looping background video). Input images are resolved
to sendable URLs/paths by the tool; the caller just names the file and its `role`.
