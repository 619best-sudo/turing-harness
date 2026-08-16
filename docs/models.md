# Complexity, category, and choosing models

Every model the harness calls is chosen by the same small set of inputs. This page
is the whole picture: what the inputs are, where each one comes from, and which
knob configures which call.

It is written for the **flat loop** (`run`) — the primary entry point. The legacy
4P `runChain`/`runPhase` shims use the same machinery; where they differ it is
called out.

## The model slots

A run does not use one model. It uses these, and they are configured separately:

| Slot | What it does | Configured by |
|---|---|---|
| **Driver** | The work loop: every reasoning turn and every tool-call decision. Dominates cost and latency, so it is normally a small fast model. | `models.perform` (or `models.orchestrator`), `orchestrator.setModel("perform", …)`, `agent.setPhaseModel("perform", …)` |
| **Router / conversational** | The front-of-run intent check (`task` vs `conversational`) and, for a conversational prompt, the reply itself. | `models.prepare` → `models.orchestrator` |
| **Run summary** | The single bounded summary turn that ends a run. | `models.perfect` → `models.orchestrator` |
| **Comprehension (read escalation)** | Explains a file the driver was rated unable to reason about; its analysis is appended beneath the bytes. | `routeModel({kind:"read"})`, else `toolModelCandidates` |
| **Authoring (write escalation)** | Produces the actual bytes of a `write`/`edit` instead of the driver's draft. | `decision.authorModel`, else `routeModel({kind:"write"})`, else (vision only) `toolModelCandidates` |
| **Vision** | Reads images: the `media_analysis` tool, and describing a tool's image output when the driver is text-only. | `mediaAnalysis.model`, `visionModel` |
| **Study** | `activity_monitor`'s `study` action. | `studyModel` |
| **Asset generation** | Image/video output for `assets_generator`. | `assets.backends` |

> The four keys in `models` are named after the 4P phases, but under `run` they
> are **role slots**, not phases: `perform` is the driver, `prepare` is the
> router/conversational model, `perfect` is the summarizer, and `plan` is unused.
> Setting `models.orchestrator` alone is enough — every slot falls back to it.

Resolution for a slot, highest first:

```
orchestrator.setModel(slot, …)   →   config.models[slot]
  →   orchestrator.setModel("orchestrator", …)   →   config.models.orchestrator
  →   DEFAULT_PHASE_MODELS[slot]
```

`Agent`'s constructor `model` option and `agent.setModel(slug)` both write the
`"orchestrator"` override, so a host that passes one slug gets it in all three
slots.

⚠️ Any slug that can be the **driver** must be reasoning-capable, and if it is
text-only, `visionModel` must be set — otherwise a tool that returns a screenshot
sends an image into a provider rejection that kills the turn.

## The three axes

Escalation — sending a call to a model other than the driver — is decided on
axes that are deliberately **independent**. Collapsing them loses information:

- **`rating`** (`low` | `medium` | `high`) — *how hard is this?* Decides
  **whether** to escalate.
- **`category`** (`ui` | `svg` | `code`) — *what must the stronger model be good
  at?* Spatial and visual reasoning for `ui`/`svg`, ordinary code reasoning for
  `code`. Says nothing about whether to escalate: a trivial SVG tweak and a hairy
  one are both `svg`.
- **`hasAttachment`** (boolean) — *is there a design to build FROM?* Authoring
  against a mockup is a transcription problem with a ground truth to match. It
  can justify a stronger model at the same rating, and the model must be able to
  see at all.

Plus **`kind`** (`read` | `write`), which is not a difficulty axis but a
different job: comprehension rewards raw capability, authoring rewards
instruction-following and diff discipline.

`category` is a **capability-tier** hint, not a modality one. Whether a call
needs eyes is decided separately, from the images actually attached to it.

## Where a rating comes from

Two representations coexist, and they are not interchangeable:

- **`Complexity { score: 0..1, signals }`** — the arithmetic estimate from
  `estimateComplexity()`, blending tool breadth, context size, attachment weight
  and whether the call mutates. This is what the permission callback receives and
  what indexes `toolModelCandidates`.
- **`ComplexityRating` (`low`/`medium`/`high`)** — the human-scale rating the
  prompts, the plan, and `routeModel` all speak. `scoreToRating` /
  `ratingToScore` convert.

For a given call the rating is resolved in this order:

1. **Declared** — a `write`/`edit` carries `complexity` and `category` arguments,
   so the model rates the work at zero extra token cost. A declaration is
   **authoritative, not a floor**: the arithmetic estimate cannot produce `low`
   for a mutation at all (the `mutates` term alone clears the threshold), so
   treating it as a floor would discard the only signal able to route a genuinely
   trivial edit back to the cheap model.
2. **Image floor** — a declared `low` on a call carrying images is raised to
   `medium`. "Here is the mockup, build it" is never mechanical, and a `low`
   there would author the driver's text-only draft and silently lose the image.
3. **Measured floor** — a rating an earlier `read` measured off the real bytes of
   this path raises the score but never lowers it. A tool that read the file is
   evidence; a self-report is not, so a model may talk its way up but never down
   past what a read established.
4. **Inherited floor** — a per-path rating handed down from a plan step.
5. **Estimated** — the arithmetic score, when nothing above applies.

The winning origin is reported honestly on the permission request as
`complexitySource`: `"estimated"` | `"tool-measured"` | `"plan-task"` |
`"prepare-file"`, alongside `complexityRating`.

A `read` has no declaration to offer — there is nothing to judge until the bytes
exist — so it rates itself: a zero-token structural prefilter, then one rater
call returning `RATING: low|medium|high | WHY: …`. See
[reading and changing code](./code-changes.md#the-gate).

## Where a category comes from

1. **Declared** by the calling model, for `write`/`edit` only. Strictly better
   than inference — a `.tsx` file is frequently pure logic.
2. **Inferred from the path**, otherwise (and always for `read`, where asking
   would cost a second rater call):
   - `.svg` → `svg`
   - `.tsx .jsx .vue .svelte .astro .css .scss .sass .less .styl .html .htm
     .storyboard .xib .xaml` → `ui`
   - `.dart .swift .kt .kts .java .ts .js .mjs .cjs` → `ui` **only when the
     project renders screens**, else `code`
   - everything else → `code`

That last rule is why the **project category** matters here and is not cosmetic.

## Project category

Separate from the `ui`/`svg`/`code` axis: `ProjectCategory` is
`frontend` | `mobile` | `games` | `backend`, describing what the *project* is.

Resolved per run as: the category the host set — `createProjectSession(category)`,
or `createSession({ preset })`, or the value post-Prepare reconciliation corrected
it to — else a value cached from an earlier detection, else `detectProject(cwd)`
reading the workspace's manifests
(logged under the `project`/`category` tags, best-effort — an unreadable
workspace never fails a run).

It is worked out rather than required because a host that set nothing made every
category-dependent behaviour silently inert, which is worse than the bug it
replaced: the verification gate fell back to `logic` for a mobile screen file, the
model satisfied that with the project's analyzer, and the run reported
`verified: true` for a change nobody had looked at.

What it drives:

- the contextual half of `categoryForPath` above — so a `.dart` screen edit on a
  mobile project is routed to a UI-strong model instead of a logic one;
- the verification gate's expectation of what "checked" means;
- design-reference sourcing for a fresh UI build (skipped on `backend`);
- the [project preset](./project-presets.md) — toolset and model defaults —
  when the session is created with `createProjectSession`.

## `routeModel`: the host owns the policy

```ts
type ModelRouter = (input: {
  kind: "read" | "write";
  rating: "low" | "medium" | "high";
  category?: "ui" | "svg" | "code";
  hasAttachment?: boolean;
  path?: string;
}) => string | undefined;
```

Return a slug, or `undefined` for "no opinion" — the caller then falls back to
the candidate pool, and then to not escalating.

This exists because `toolModelCandidates` answers a different question. That pool
picks a tier with `floor(score * pool.length)`, so which model a rating lands on
is a function of the pool's **length** — appending a slug silently re-targets
every rating — and a flat list cannot tell a read from a write at all.

Set it at construction or at any time on a warm session:

```ts
new Harness({ routeModel });
session.setRouteModel(routeModel);          // warm sessions: set per run
session.setToolModelCandidates([cheap, capable]);
```

Both matter for a host that caches sessions per project while the user can change
models between runs — a pool or router pinned only at creation goes stale.

### When each kind is consulted

| kind | consulted by | reached via | `low`? |
|---|---|---|---|
| `read` | the staged read's comprehension escalation | `ctx.routeModel`, inside the tool | **never** — a `low` read returns the bytes and stops before routing |
| `write` | `write`/`edit` byte authoring | the loop pre-resolves it into `ctx.authorModel`; the tool also consults `ctx.routeModel` itself | **yes** — the tool asks for every write, including `low` |

That asymmetry is load-bearing under `authorOnlyWrites`. In that mode the driver
never authors bytes at all, so **every** write tier must resolve to something —
including `low`. A host running author-only must return a slug for
`{kind:"write", rating:"low", hasAttachment:false}` (the driver itself is the
right answer) or the call errors loudly rather than being silently authored by
the driver.

### Authoring precedence

1. `decision.authorModel` from the permission callback — a per-call instruction,
   more specific than standing policy. *(If it cannot see and the call carries
   images, it is skipped.)*
2. `routeModel({kind:"write", …})`. A routed slug is honoured as-is for a plain
   write; for an image-bearing write it must also accept image input.
3. `toolModelCandidates` — **vision writes only**. A plain write has no pool
   fallback on purpose.
4. No escalation: the driver's own draft is written.

### Comprehension precedence

1. `routeModel({kind:"read", …})`.
2. `toolModelCandidates`, indexed by score.
3. If that lands on the model already doing the reading, nothing is escalated —
   there is nowhere to escalate *to*.

## Worked example

A routing grid with sparse rules, resolved by specificity so a broad rule can
never shadow a narrow one:

```ts
const BASE = {
  read:  { medium: "tencent/hy3",  high: "tencent/hy3" },
  write: { medium: "tencent/hy3",  high: "tencent/hy3" },
};

const routeModel: ModelRouter = ({ kind, rating, category, hasAttachment }) => {
  // author-only mode: the trivial tier must still resolve, to the driver itself
  if (rating === "low" && kind === "write" && !hasAttachment) return DRIVER;
  if (rating === "low") return undefined;

  // hy3 is text-only: anything authoring FROM an image needs eyes
  if (kind === "write" && hasAttachment) return "openai/gpt-5.6-terra-pro";
  // spatial work wants a model strong at layout, not at logic
  if (kind === "write" && (category === "ui" || category === "svg")) return UI_MODEL;

  return BASE[kind][rating];
};
```

Two things this shape gets right:

- **Verify modalities before adding a slug.** The harness trusts
  `MODEL_CATALOG`'s declared `input` list to decide whether an image is
  serialised into a request. A model wrongly declared image-capable makes the
  provider reject the *whole* call.

  ```bash
  curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id=="<slug>") | .architecture.input_modalities'
  ```

  Register a corrected descriptor with `registerModel()` rather than relying on
  the permissive unknown-slug default, which claims image support.

- **Keep rules sparse and non-overlapping.** Two rules of equal specificity that
  can both match resolve arbitrarily at runtime — a bug that only ever surfaces
  as "why did this call use that model". Assert against it in a test.

## Why the ratings are honest

The `low`/`medium`/`high` scale is injected into every prompt that can produce a
rating (`COMPLEXITY_CONTRACT`, exported), framed as *what the rating buys*: a
model that knows a rating pins a stronger author has a reason to state it
honestly, where a model that thinks it is bookkeeping defaults everything to
`medium`.

The guidance is **density-based, not length-based**. A 2000-line generated barrel
file is `low`; a 60-line function with nested conditionals, an un-awaited call and
three callers elsewhere is `high`. A one-line change to a function ten files call
is not `low`.

## See also

- [Reading and changing code](./code-changes.md) — the gate in full, and what a
  rejected analysis does.
- [The loop driver](./loop.md) — where these calls happen.
- [API reference](./api-reference.md#escalation-routing-routemodel) — exact types.
