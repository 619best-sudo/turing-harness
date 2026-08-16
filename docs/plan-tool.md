# `create_plan`: the task breaker

`create_plan` ([`src/tools/builtin/plan.ts`](../src/tools/builtin/plan.ts)) is the
tool that turns a request into an ordered, per-file plan and puts it in front of
the user before any of it runs. Everything downstream keys off what it produces:
per-task `complexity` becomes the model-selection floor when that step executes,
`files` + `fileMutations` become the step's edit/write intent, and `isCompleted`
becomes the run's progress ledger.

```
draft → host shows it → user approves          → the plan executes, step by step
                     → user comments          → re-drafted with their feedback
                     → user attaches to step 3 → that file reaches step 3 only
```

## What it emits

Structured data on `details.planSet`, not prose — so a client renders a real
object instead of scraping text:

```jsonc
{"plans":[{"id":"plan-1","title":"Landing page","summary":"…","tasks":[
  {"id":"t1","order":1,"title":"Design tokens","summary":"…",
   "files":["src/tokens.css"],"fileMutations":{"src/tokens.css":"write"},
   "complexity":"low","verification":"…","risks":"…",
   "isCompleted":false,
   "attachments":[{"path":"/abs/hero.png","mimeType":"image/png","note":"…"}]}
]}],"executionOrder":["plan-1"]}
```

### `complexity`

`low` / `medium` / `high`, per task. When that step runs it becomes the
complexity **floor** for every read/write/edit in it
(`complexitySource: "plan-task"`), which is what routes a hard step to a stronger
model — see [reading & changing code](./code-changes.md).

### `isCompleted`

Present on every task, **always false at creation**, flipped to `true` in place on
the same `PlanSet` by `Orchestrator.run` as each step's work loop finishes. Two
layers enforce that the model cannot pre-declare work done: the extractor refuses
to read the field from planning JSON at all, and the tool stamps `false` over
whatever arrived. The LLM-facing rendering shows it as a checklist
(`1. [x] [t1] …`), so a plan re-rendered mid-run tells the truth about what is
left.

A step that ends early (stalled loop, step budget) is recorded `isCompleted:
false` with its reason, and the **remaining steps still run** — dropping the rest
of a plan the user approved because step 2 stalled is worse than letting step 3
try.

## Attachments, both directions

| Source | How it arrives | Where it lands |
|---|---|---|
| Files attached to the **run** | listed to the planner under `ATTACHMENTS` with real paths | the planner routes each to the step that needs it, via that task's `attachments` |
| Files the user attaches **during review** | `PlanApprovalDecision.stepEdits` | the exact step they were dropped on |
| Paths a caller names explicitly | the tool's `attachments` argument | same routing as run attachments |

Either way the file reaches that step's work loop and nothing else — a hero mockup
goes to the hero step, not to all six. Image-typed attachments become vision input
for that step's write/edit.

Three robustness details, because a silently dropped attachment is the worst
outcome here:

- Paths are resolved against `cwd` and **existence-checked at plan time**, while
  the user is still looking at the plan — not minutes later mid-execution.
- A path the model retyped slightly is repaired by **basename match** against the
  attachments the run actually has, so its intent is honoured rather than dropped.
- Anything that still cannot be read is dropped with a `warn` log naming it, and a
  step edit referencing an unknown task id is logged loudly too.
- A missing `mimeType` is **derived from the extension**. It is typed as required,
  but a step attachment crosses a host boundary — a UI dropping a file, or JSON off
  the wire — where the type enforces nothing, and everything downstream routes on
  it (an image becomes vision input; anything else is listed as a file to read).

An image attached during review is also [triaged](./media-analysis.md#the-triage-pre-pass)
just before its step runs, so it arrives with a category and its verbatim text
rather than as an undifferentiated file.

## Review and revision

`ctx.planApproval` is the round trip. The decision may `approve`, `cancel`, or
send it back with `comments`, which are injected as an explicit re-plan
instruction ("Apply the user's feedback directly. Their instructions override your
earlier judgement."). `stepEdits` apply on **both** paths — approving the plan
while attaching a mockup to step 3 is the common case and must not cost a re-plan.

`maxRevisions` (default 3) bounds the loop; when it runs out the last draft is
returned clearly labelled rather than thrown away. With **no** `planApproval`
callback the plan auto-approves, so a headless run never hangs waiting for an
approval that cannot arrive. A cancelled review returns an error telling the agent
not to start implementing.

## Configuration

```ts
new Harness({
  plan: {
    // Planning is the one call where a stronger model reliably pays back: a bad
    // decomposition is inherited by every step after it.
    model: "anthropic/claude-opus-4.8",
    // Extend rather than replace — the JSON contract lives in the default, and
    // getting it wrong means the plan silently fails to parse.
    systemPrompt: DEFAULT_PLAN_SYSTEM_PROMPT + "\n\nHOUSE RULES: …",
    maxRevisions: 3,
  },
});
```

Model resolution order: `plan.model` → the model the permission gate selected for
this call (the tool's `complexityHint: 0.8` biases that upward when the host wired
`toolModelCandidates`) → the loop's current model.

## What the default prompt insists on

- **Per-file units of work**, ordered by real dependency, each independently
  verifiable, with `edit` vs `write` named per file. Fewer meaningful tasks over
  many trivial ones.
- **End to end.** The executing agent does exactly what the steps say and nothing
  more, so the plan covers dependencies/config, the implementation, the *wiring
  that makes it reachable* (routes, exports, registration), data/schema changes,
  tests, and a concrete verification run. Vague deferrals — "polish", "handle edge
  cases", "finish the remaining pieces" — are banned: name the pieces or leave
  them out.
- **Hero / product / landing pages** decompose by **section** (hero, features,
  social proof, pricing, footer), because a section is what a person reviews and
  what a mockup shows — not by technology layer.
- **Animation has to be buildable from the plan.** Per animated element: what
  moves, the trigger (load / scroll / hover / in-view), rough duration and easing,
  and CSS vs a named JS library (with installing it as its own step). Shared
  design tokens are set up **first** so sections don't each invent their own, and
  a `prefers-reduced-motion` path, responsive behaviour, asset/font loading, and a
  performance check (no layout shift, 60fps, above-the-fold not gated on JS) are
  real steps rather than afterthoughts. A missing asset goes in that step's
  `risks` instead of being assumed.
