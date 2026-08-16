# The loop driver (`run`)

The flat loop driver is the primary way to run work in turing-harness. It
replaces the forced Prepare → Plan → Perform → Perfect decomposition with a
single, pi-agent-style tool loop, while keeping multi-plan steps, multimodal
authoring, and a run summary. The 4P `runChain`/`runPhase` methods remain as
back-compat shims (see [4p-phases.md](./4p-phases.md)), but new code should use
`run`.

## Why

A general-purpose harness gets asked to do all kinds of work. Forcing every
request through a fixed four-phase decomposition is too rigid: it adds latency,
loses context across artificial phase boundaries, and misfires on tasks that
don't fit the shape. The loop keeps what was good about the old design — the
per-tool-call permission/model/complexity callbacks, the multi-plan structure,
the verify-the-work discipline — and drops the forced decomposition.

## Entry point

```ts
const result = await orchestrator.run(task, opts);
// or via a session/agent:
const result = await session.run(task, opts);
await agent.prompt(task);            // agent.prompt runs the loop by default
```

`run` returns a [`RunLoopResult`](../src/types.ts):

| Field | Meaning |
| --- | --- |
| `route` | `"conversational"` (answered inline) or `"task"` (full work run). |
| `success` | `true` unless a hard error aborted the run (a user abort is not a failure). |
| `summary` | The end-of-run summary the loop produces (the summary turn). What the user reads. |
| `steps` | Per-task progress when a plan was produced; each carries `complexity` + `isCompleted`. Empty for a planless run. |
| `planSet` | The structured plan, if the model emitted `PLAN_JSON`/`PLANS_JSON`. |
| `refs` | Media/artifact refs accumulated across the run. |
| `usage` | Aggregated token usage across every turn. |
| `pendingUserQuestion` | A clarifying question that paused the run, if any. |
| `error` | A hard failure (LLM/transport/tool) that ended the run early, if any. |
| `threadSnapshot` | Continuity snapshot for the next prompt in the same session. |

## How it runs

```
run(task)
  ├─ intent route: CONVERSATIONAL → direct reply (no tools)
  └─ task:
       1. (optional) planning turn → PlanSet (PLAN_JSON / PLANS_JSON)
       2. for each plan, in executionOrder:
            for each task, in order:
              runToolLoop(task)        ← bounded tool loop on ONE step
              mark task.isCompleted = true
              re-inject live progress next turn
       3. summary turn → RUN SUMMARY over the whole run
       └─ RunLoopResult
```

The per-step sub-loop is the reusable core: stream a model turn → walk tool
calls → route each through the permission gate → estimate complexity + select
the per-call model → execute the tool → feed the result back into one growing
message history — until the model produces a turn with no tool calls (the normal
end: the work is finished), stalls, aborts, or hard-errors. There is no step cap
by default; `maxStepsPerStep` is an opt-in host bound. It lives in
[`src/orchestrator/loop.ts`](../src/orchestrator/loop.ts) and is reusable on its
own (`runToolLoop`).

### The four callbacks (all preserved)

Every tool call inside each sub-loop passes through the same machinery as before:

- **permission** — `permission.evaluate(req)` fires before every tool call. The
  request carries `kind`, `name`, `mutates`, `args`, `complexity`,
  `complexityRating`, `complexitySource`, `refs`, and `phase` (stamped
  `"plan"` for the planning turn, `"perform"` for work steps — kept for
  back-compat so existing host policies still key on it).
- **model** — a `decision.model` re-pins the driver for one turn;
  `decision.authorModel` routes a write/edit to a second model that authors the
  bytes. Unchanged semantics.
- **complexity** — `estimateComplexity` runs per call; a plan task's per-file
  `complexity` rating raises the call's floor (`complexitySource: "plan-task"`),
  and so does a rating a tool *measured* off the real file mid-run
  (`complexitySource: "tool-measured"` — see
  [Staged read](#staged-read-escalating-comprehension) below).
- **category** — tool selection in the loop uses every registered tool
  (`registry.allTools()`). The 4P `phases?` field on tools is kept for back-compat
  but is no longer load-bearing for selection.

## Stall detection

There is no step cap. A loop ends when the model stops calling tools — i.e. when
the work is done. A fixed number of turns was always the wrong control: it cut
real multi-file work mid-edit (with no summary, so the run still *looked*
complete) while doing nothing about a model that had genuinely gone in circles.

What bounds a loop instead is `StallGuard`
([`src/orchestrator/stall-guard.ts`](../src/orchestrator/stall-guard.ts)), which
watches for the two shapes a non-converging loop actually takes:

1. **repetition** — a turn whose tool calls are all ones this loop already made
   (same tool, same arguments), so the turn added nothing new;
2. **failure** — a turn in which every tool call errored.

Either shape earns a **nudge** first: a user message telling the model what it is
doing, to take a different concrete action or summarize, and how many such turns
remain. After `stallTurns` (default 3) consecutive no-progress turns the loop ends
with an error naming the pattern (`loop stalled: …`) — never a budget number.
Progress means a call that was both new *and* succeeded; one of those resets the
streak.

Before the stall verdict, a repeatedly-failing tool is escalated — see
[the fallback ladder](#when-a-tool-keeps-failing-bash--the-user--honest-stop) —
so a loop is only ended as stalled once bash and the user have both been offered.

A stalled step is not a broken run: `isNonFatalLoopError(err)` is true for it, so
the step is recorded `isCompleted: false` with its reason and the remaining plan
steps still run.

Hosts that genuinely want a hard ceiling can still pass `maxStepsPerStep` (per
step) or `maxSteps` (per 4P phase). When set, the loop injects a wind-down note as
the cap nears and reports `step budget exhausted (…)` if it is hit.

## When a tool keeps failing: bash → the user → honest stop

Stall detection ends a hopeless loop, but ending it is not the goal — finishing
the work is. A tool that keeps failing is a dead end models rarely escape alone:
they retry `write` on an unwritable path, or keep calling a browser MCP tool whose
server never came up, until the loop stalls with the work undone even though the
shell could have done it all along.

`ToolFallbackAdvisor`
([`src/orchestrator/tool-fallback.ts`](../src/orchestrator/tool-fallback.ts))
counts **consecutive failures per tool** and walks a fixed ladder, one rung per
escalation, so the harness exhausts its own capability before spending the user's
attention:

| Rung | Trigger | What is injected |
| --- | --- | --- |
| 1. bash fallback | 2 consecutive failures of the same tool (`failuresBeforeFallback`) | A concrete shell recipe **for that tool and its real arguments** — `write` → `mkdir -p` + `cat > <the actual path> <<'EOF'`; `edit` → `grep -n`/`sed -n` then a `python3` heredoc; a browser MCP → `curl` for liveness plus `npx playwright screenshot <the actual url>`; a mobile MCP → `xcrun simctl` / `adb`. |
| 2. ask the user | the shell can't do it either, or the run has no shell | Instruction to call `ask_user_question` with a question that is answerable in one reply: what was attempted, the exact errors, and precisely what is needed (a path, a credential only they can enter, a running server, a decision between two named options) — then to keep working on whatever is *not* blocked. |
| 3. honest stop | no `ask_user_question` in the toolset | Stop retrying; report in the summary what was blocked, the exact error, and what a human must do. |

Any success on that tool clears its streak. Rungs the run cannot offer are
skipped, never suggested uselessly: a mutating recipe is never proposed through
`bash_readonly`, presets that withhold `bash` jump straight to the human rung, and
`web_search`/`web_fetch` have **no** shell fallback on purpose (curl returns
unrendered markup, so a missing browser MCP is a capability to report, not to
fake).

The two actionable rungs call `StallGuard.grantGrace()`, which clears the stall
streaks once (bounded by `maxGraces`, default 2) — advice the loop just gave is
never advice the model never got a turn to act on.

The same ladder is written into the system prompts (`LOOP_SYSTEM_PROMPT` and every
4P phase prompt), so a capable model climbs it on its own and the injected notes
are only the enforcement path.

## How the loop searches for files: memory → better query → shell

The failure ladder above fires on tool *errors*. Search needed its own, because
the failure mode there is a **successful** call: `file_memory` returning "(no
matching files)" is not an error, and left alone a model reads that as licence to
start grepping — or worse, as evidence the code does not exist.

`SearchLadderAdvisor`
([`src/orchestrator/search-ladder.ts`](../src/orchestrator/search-ladder.ts))
therefore reads each tool's **output text**, not just its status, and keeps the
indexed-first order in view: `project_memory` → `file_memory.search` →
`graph_memory.blast_radius` → `read`, with `grep`/shell authorized only after
about three empty memory queries (`attemptsBeforeShell`) or immediately on a cold
index. Its notes are advice, not law: they fire once per rung, only ever name tools the
run actually has, each grants a stall grace, and each invites the model to
override the default with a stated reason — it often has context the advisor does
not (it already knows the path, it is sweeping every call site of a literal, the
index is visibly stale).

See **[File search](./file-search.md)** for the full ladder, the per-phase
differences, and the tuning knob.

## Multi-plan steps with `isCompleted`

If the model emits a plan, the loop flattens it: every task across every plan
runs in its own focused sub-loop, in execution order. After a step's sub-loop
ends, the loop:

1. records a `RunStep` with `isCompleted: true` (or `false` + an `error` on a
   hard failure),
2. marks the source `PlanTask.isCompleted` on the `planSet`, in place,
3. re-injects the live progress checklist into the next step's opening so the
   model sees what's done.

Each step keeps its **complexity rating** (`low`/`medium`/`high`), inherited by
the step's tool calls for per-call model selection — exactly as before.

A task with no plan (small/trivial work, or `skipPlan: true`) runs a single work
loop and `steps` is empty.

## Staged read (escalating comprehension)

`write` and `edit` are two-step: Model A drafts, and a stronger Model B can author
the bytes that land on disk. `read` is two-step in the same shape, so the model
that *understands* a file can also be upgraded — not just the model that writes
one.

```
read({path})
  1. fs.readFile                            → the numbered bytes (unchanged)
  2. rate difficulty (cheap internal call)   → low | medium | high
     ├─ low  → return the bytes, done
     └─ ≥medium → selectModel(rating, toolModelCandidates)
                  → stronger model analyzes the file
                  → analysis APPENDED beneath the bytes
  3. report `measuredComplexity` → becomes the path's inherited floor
```

**The escalation decision is internal — no host round-trip, no user prompt.** This
is the one deliberate asymmetry with authoring: for a write/edit the host holds the
draft args pre-flight and can judge, but for a read there is nothing to judge until
the bytes exist. So the tool rates the file itself and picks the tier that rating
deserves from the loop's own `toolModelCandidates` pool.

**The analysis is appended, never substituted.** Model A still has to emit a
byte-exact `oldString` anchor for the follow-up `edit`, which it cannot derive from
a paraphrase — so the raw numbered lines stay authoritative and B's contribution
sits beneath a labeled banner.

**The rating feeds forward.** `ToolResult.measuredComplexity` raises the floor in
the loop's per-path map (ratings only ratchet up), so the `edit` that follows the
read reaches the permission gate already rated `high` with `complexitySource:
"tool-measured"`. That is the signal a host uses to pin `authorModel` — closing the
loop with **no human anywhere in it**: *read discovers the file is hard → a stronger
model comprehends it → the edit inherits the floor → the stronger model authors the
bytes.* Previously an inherited floor could only originate from a plan.

**Cost control.** `read` is the loop's hottest tool, so escalation is gated three
ways before any tokens are spent: a structural prefilter (data/generated/short/
mostly-comment files classify as `low` for free), `ctx.knownComplexity` (a rating
the run already holds is never recomputed), and graceful degradation — with no
`toolModelCandidates` or no `llm`, the tool behaves exactly as the old single-stage
read. No config flag gates any of this.

Rating and comprehension failures degrade to a plain read rather than erroring: a
failed read takes the whole step down, whereas a failed *authoring* pass is a hard
error because it would otherwise write wrong bytes. See
[`src/tools/builtin/comprehension.ts`](../src/tools/builtin/comprehension.ts).

## Multimodal authoring (write/edit from an image)

The loop is text↔text by default. When a vision-authored result is wanted, a
`write`/`edit` call passes an `images` array of paths/URLs:

```ts
// model-emitted tool call:
{ "name": "write", "arguments": { "path": "index.html", "content": "...", "images": ["mockups/landing.png"] } }
```

The host routes that to a vision-capable authoring model (via the permission
decision's `authorModel`, or by configuring the loop's `images`). The authoring
pass lives inside the tool: it reads the images, builds a `UserContent[]` with
`{type:"image", data, mimeType}` blocks, and asks the vision model to author the
file bytes from the image(s) — mirroring `media_analysis`. See
[`src/tools/builtin/authoring.ts`](../src/tools/builtin/authoring.ts).

Images can also be supplied host-side via `RunOptions.images` (e.g. from a
prompt's attachments). These are **offered** to every write/edit rather than
applied to it: each call routes the set to the file it is writing and passes only
what belongs there, so a run carrying three screen designs does not author every
file from all three. An explicit `images` arg on the call always wins; otherwise an
entry's `targets`/`label`, then filename affinity, then being the run's only
attachment decide it. When several are in contention and nothing distinguishes
them, **none** is passed and the tool result names the candidates so the next call
can choose. See
[`src/multimodal/attachment-routing.ts`](../src/multimodal/attachment-routing.ts).

## Every loop of a run is the same loop

A run spawns more than the work loops: a planning turn, one loop per plan step,
then the verify rounds and (if instrumentation was left behind) a strip round.
All of them are built with **one** system prompt, assembled once from the
resolved toolset, and all of them receive the run's `images`, triaged
`mediaFact` and `projectCategory`.

The verify rounds are staged: each round targets one stage of
**build → instrument → run → inspect → decide**, picked from the outstanding
gaps. A round that ends `VERDICT: FAIL` makes the next round a **repair round**
— it lists what failed, authorizes `write`/`edit`, and the spine restarts at
*build* once the fix lands (the edit re-arms the build debt). The loop is
bounded by the gate's round/attempt budgets, so a change that genuinely cannot
verify still completes with `verified: false` rather than spinning forever.

That uniformity is load-bearing rather than tidy. The later rounds are not
read-only — the verify message explicitly tells the model to fix the defects it
finds and re-check, and those fixes are `write`/`edit` calls. A verify round
running without the run's attachments authors a fix blind against the very
mockup it is supposed to match; one running without the guidance blocks is told
nothing about `activity_inspect`, the media lenses, or the fix-then-prove
discipline — in the one round where they matter most.

## Run summary

Instead of a Perfect verify phase, the loop ends with a single bounded summary
turn over the whole run: what was done, the key files touched, anything notable,
and the final state. This is `RunLoopResult.summary` (and
`agent.state.lastRunSummary`). It is honest — if the task is not fully done, it
says so and what remains.

## Events

`run` emits only the pi-compatible events a pi UI already renders:
`agent_*`, `turn_*`, `message_*`, `tool_execution_*`, `permission_*`. The 4P
`phase_*`/`chain_*` events are still emitted by the legacy `runChain`/`runPhase`
shims but NOT by `run` — so a UI that switches to `run` can ignore them.

## Options

| `RunOptions` | Default | Meaning |
| --- | --- | --- |
| `skipPlan` | `false` | Skip the planning turn; run a single work loop. |
| `maxStepsPerStep` | — | Optional hard cap on tool-call turns per step. Unset means a step runs until the model stops calling tools; stall detection (not a step count) ends a loop that cannot converge. |
| `images` | — | The run's live attachment set, routed per target file by write/edit authoring passes. |
| `askUserQuestion` | — | Host callback for `ask_user_question`. |
| `followUpContext` | — | Structured continuity from the previous run. |
| `transcriptMode` | — | `"full"` (default) or `"compact"`. |
| `signal` | — | `AbortSignal` to cancel the run. |
