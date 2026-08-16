# The 4P phases

> **Note:** The 4P decomposition is the **legacy** path. The primary entry point
> is now the flat loop driver — see [`loop.md`](./loop.md). The 4P
> `runChain`/`runPhase` methods remain as back-compat shims and still behave as
> documented here; new code should call `run`.

The 4P model splits a coding operation into four phases with distinct jobs and toolsets. Prompts live in `phases/prompts.ts` and default toolsets in `PHASE_DEFAULT_TOOLS`; both are exported so you can inspect or override them.

A phase's system prompt is **assembled from the tools that phase actually resolved**: `buildPhaseSystemPrompt(phase, toolNames)` (and `buildLoopSystemPrompt(toolNames)` for the flat loop) keeps the situational guidance blocks whose tools are attached and drops the rest — no `assets_generator` means no generated-media guidance, no browser/web tools means no scraping ladder. Guidance for a tool the run does not have cannot be acted on, and it dilutes the guidance that can; for Perform this typically halves the system prompt. `PHASE_PROMPTS` / `LOOP_SYSTEM_PROMPT` remain exported as the **full** text (every block included) for inspection and for hosts that assemble their own.

One thing is never situational: `COMPLEXITY_CONTRACT`, the single definition of the `low`/`medium`/`high` scale and the `ui`/`svg`/`code` category, is injected into Prepare, Plan, Perform and the loop. All three produce ratings that the next stage **inherits** (Prepare rates each file → Plan rates each task → Perform declares per `write`/`edit` call, and the rating pins the authoring model), so the word has to mean the same thing in every producer. Every phase shares one authoritative definition of the four jobs (`PHASE_DEFINITIONS`, injected into all four prompts) so provider/tool routing and handoffs are grounded in the same contract.

## The shared contract

- **Prepare** — prepare the run for this directory. Search the folder, find the files relevant to the task, walk **graph memory** to collect dependent / blast-radius files, and choose which MCPs/skills each later phase should receive. Read-only. Every kept file carries a **reasoning** (`why`) and a **complexity** rating (`low`/`medium`/`high`). Its handover is the shortlist of relevant file addresses + reasoning + complexity + the per-phase provider routing — **not** every read it performed.
- **Plan** — read the handed-over files and chalk out an executable plan of **ordered steps**. A single-repo task produces **one** plan; a complex / multi-repo task produces **multiple** plans with an explicit **execution order**. Read-only, plus any MCP/skill Prepare assigned to Plan.
- **Perform** — execute the plan's tasks **in order** with `read`/`write`/`edit` (plus any assigned MCP/skill). When Plan produced multiple plans, Perform runs **once per plan** in execution order.
- **Perfect** — quality assurance. It receives the changed files, derives a **QA plan** from the tech stack, and verifies — API calls via `bash`, a browser/mobile MCP to drive & screenshot the app (handing the screenshot to `media_analysis` when present, else checking element dimensions), tests, or typecheck. PASS ⇒ done. FAIL ⇒ it emits a **plan-like `FIX`** describing exactly what broke, which the next Perform run repairs.

## The shared output contract (every phase)

Every phase ends with the **same three sections, in the same order, meaning the same thing** — this is the single common trailer, defined once (`COMMON_HANDOFF_STYLE`) and injected into all four prompts. A phase's distinct work (`FILE SEARCH`, `PLAN_JSON`, `CHANGES`, `QA_PLAN`, …) is separate; no phase invents its own summary/continuity markers. (The older `CHAT SUMMARY`, Prepare-only `TOOL TRANSCRIPT`, and Plan-only `DEBUG_LOGS` were folded into these three; `CHAT SUMMARY`/`TOOL TRANSCRIPT` are still parsed as legacy aliases for back-compat.)

| Field | Marker | Purpose |
| --- | --- | --- |
| `PhaseResult.summary` | `SUMMARY:` | The full markdown briefing for the next phase and the host phase card. Required. |
| `PhaseResult.uiSummary` | `UI SUMMARY:` | A short, user-message-anchored status update with light markdown (files/commands in `inline code`, bold key result, bullets/numbered list when long). This is what the client renders. |
| `PhaseResult.toolChain` | `TOOL CHAIN:` | Curated continuity for the next phase — the tool activity that matters, with `reasoning` + `complexity`, **not** the raw transcript. Falls back to a transcript-derived chain if the model omits the section. |
| `PhaseResult.handoff` | — | A single structured `{ from, to, files, toolChain, reasoning }` object combining the above for the next phase. |

Each phase's own **payload** (below) precedes this trailer.

## Prepare

**Job:** as above. Read-only, memory-first.

**Default tools:** `read`, `mark_concern_lines`, `project_memory`, `file_memory`, `graph_memory` (no shell/`ls`/`grep`).

**Discovery order:** project memory → `file_memory.search` → `graph_memory` blast-radius → `read` to confirm.

**Output contract:** payload `CATEGORY` / `PROJECT` / `RUN` / `STOP` / `VERIFY` / `CAPABILITIES` / `PROVIDER ASSIGNMENTS` / `FILE SEARCH` (one line per relevant file: `path | complexity=… | why=… | blast=…`) / `MEMORY UPDATES` / `FILE MEMORY UPDATES`, then the shared trailer `SUMMARY` / `UI SUMMARY` / `TOOL CHAIN`. (`FILE SEARCH` is the relevant-file handover; `TOOL CHAIN` the curated tool activity.)

```ts
const r = await harness.runPhase("prepare", "Understand the billing module.");
r.relevantFiles;      // [{ path, complexity, why, blastRadius }]
r.providerAssignments; // { plan, perform, perfect } provider ids
r.uiSummary;          // user-facing status
```

## Plan

**Job:** turn the Prepare briefing into one or more ordered implementation plans. Read-only.

**Default tools:** `read`, `mark_concern_lines`, `bash_readonly`, `file_memory`, `graph_memory`, plus any MCP/skill Prepare assigned to Plan (mutating `bash` is blocked).

**Output contract:**
- `PLAN_JSON` — **single-repo tasks.** A JSON array of ordered task objects: `{ id, title, summary, files, fileMutations, changes, complexity, tools, verification, risks }`. `complexity` is `low|medium|high` and is inherited by Perform's edits/writes.
- `PLANS_JSON` — **complex / multi-repo tasks.** `{ plans: [{ id, title, repo, summary, tasks: [ …task, order ] }], executionOrder: [planId, …] }`. Emit **either** `PLAN_JSON` **or** `PLANS_JSON`.
- Plus payload `PLAN` (human-readable) and `ACCEPTANCE`, then the shared trailer `SUMMARY` / `UI SUMMARY` / `TOOL CHAIN`.

Both forms normalize into `PhaseResult.planSet` — `{ plans: PlanDocument[], executionOrder: string[] }` — which the orchestrator uses to drive Perform.

```ts
r.planSet?.plans;          // [{ id, title, repo?, summary, tasks }]
r.planSet?.executionOrder; // plan ids in run order
r.artifacts?.planJson;     // raw legacy array (single-plan back-compat)
```

## Perform

**Job:** execute the plan's tasks in order. Reads **and** mutations. Multiple plans ⇒ one Perform pass per plan (see below).

**Default tools:** `read`, `mark_concern_lines`, `write`, `edit`, `bash`, `assets_generator`, `file_memory`, `graph_memory`.

**Complexity inheritance:** when a task marks a file `high`, the read/edit/write on that file inherits that rating — the permission request's `complexityRating` / `complexitySource` reflect it and per-call model selection honors it (see [Complexity inheritance](#complexity-inheritance)).

**Authoring model (host opt-in):** a host may pin a *different* model to author a `write`/`edit` call by returning `authorModel` from the permission callback. By the time the callback runs, the requesting model has already emitted its draft args — so Model B authors the on-disk bytes via an internal LLM call inside the tool, given the task, PLAN_JSON, and surrounding file snippets. `write`: B's content replaces the draft. `edit`: B authors the replacement; Model A's `oldString` anchor is kept. Contrast with `model`, which only swaps the model that *processes* the result on the next turn. See `PermissionDecision.authorModel` in `docs/api-reference.md`.

**Output contract:** payload `CHANGES` (every file/asset created or modified, by address), then the shared trailer `SUMMARY` / `UI SUMMARY` / `TOOL CHAIN`. Generated assets flow forward as `PhaseResult.refs`.

## Perfect

**Job:** verify — adversarially — that Perform met the acceptance criteria, using a QA plan derived from the tech stack.

**Default tools:** `bash` (tests/typecheck/API probes), `read`, `mark_concern_lines`, `media_analysis`, `graph_memory`, plus any Perfect-categorized MCPs you add (browser, mobile, sqlite).

**Output contract:** payload `QA_PLAN` (JSON: `{ stack, checks: [{ id, description, method, targets, passed, evidence }] }`), `VERDICT: PASS|FAIL`, and on FAIL a plan-like `FIX:` with per-check file paths and observed-vs-expected evidence; then the shared trailer `SUMMARY` / `UI SUMMARY` / `TOOL CHAIN`.

```ts
r.qaPlan?.checks;  // [{ description, method: "browser"|"api"|…, passed, evidence }]
r.verified;        // true | false
```

`PhaseResult.verified` is `true`/`false` for the Perfect phase (parsed from the verdict), and `undefined` for the others.

## The chain and verify/retry (req #4)

`runChain(task)` runs:

```
prepare → plan → ┌──────────────────────────────┐
                 │ perform → perfect             │  repeat until
                 │   perfect.verified === true?  │  verified OR
                 │   no → feedback = perfect.FIX │  maxChainIterations
                 └──────────────────────────────┘
```

- Prepare and Plan run **once**; their summaries are threaded into every later phase.
- Each iteration runs Perform (once per plan) then Perfect. If Perfect fails, its `FIX:` (or full summary) is injected as the next Perform's `feedback`.
- `ChainResult.iterations` counts Perform/Perfect rounds; `phases.history` holds every phase result in order; `phases.prepare|plan|perform|perfect` hold the latest of each.

## Multiple plans (multi-repo tasks)

When Plan emits `PLANS_JSON`, the orchestrator builds **one Perform work unit per plan**, in `executionOrder`. Each unit is scoped to its plan's files (allowlist), mutation modes, attached file contents, and per-task complexity, and is labelled (`ACTIVE PLAN: Plan 1/2 …`) so the model stays inside its plan. Files written by an earlier plan are visible to later plans (the `writtenPaths` handover accumulates across units). A single `Perfect` runs after all plans in the iteration; a `FAIL` re-runs every plan's Perform with the feedback.

```
prepare → plan → ┌─────────────────────────────────────────────┐
                 │ for each plan (execution order): perform     │  repeat until
                 │ then: perfect  →  verified?                   │  verified OR
                 │   no → feedback = perfect.FIX                 │  maxChainIterations
                 └─────────────────────────────────────────────┘
```

A single-repo task (`PLAN_JSON`) is just the degenerate one-unit case — behavior is unchanged.

## Complexity inheritance

Complexity flows down the chain instead of being blindly re-estimated at each call:

- **Prepare → later reads.** Each `FILE SEARCH` entry's `complexity` becomes a per-path rating. When a later phase `read`s that file, the call's complexity is raised to at least that rating.
- **Plan → Perform edits/writes.** Each task's `complexity` is applied to the task's files. When Perform edits/writes one, the call inherits the task's rating.

The runner surfaces this on the permission request as `complexityRating` (`low`/`medium`/`high`) and `complexitySource` (`prepare-file` / `plan-task` / `estimated`), and uses the inherited rating as a floor for per-call model selection — so a `high` file gets a stronger model even if the generic estimate was low.

```ts
const res = await harness.runChain("Make the nav responsive.");
if (!res.success) {
  console.log("Gave up after", res.iterations, "attempts");
  console.log("Last verdict:", res.phases.perfect?.summary);
}
```

Tune with `maxChainIterations` (default 3). Per-phase `maxSteps` is optional and
unset by default: a phase runs until its model stops calling tools, and a loop
that stops making progress (repeating calls, or every call failing) is ended by
the stall guard — see [the loop](loop.md#stall-detection). A tool that keeps
failing is escalated first: bash fallback → `ask_user_question` → an honest report
of the blocker ([the ladder](loop.md#when-a-tool-keeps-failing-bash--the-user--honest-stop)).

## Phases as composable tools (req #3/#4)

Phases and the whole chain are also exposed as `AgentTool`s so they can be nested inside an outer tool-calling loop (your own agent, or another harness phase):

```ts
harness.phaseTools();   // [phase_prepare, phase_plan, phase_perform, phase_perfect]
harness.chainTool();    // "code" — runs the full chain; success == verified
```

Each `phase_*` tool takes `{ task }` and returns that phase's summary + `{ verified, complexity, refs }` in `details`. The `code` tool returns the full `ChainResult` in `details` and is flagged `isError` when the chain doesn't verify.

## Customizing the fixed per-phase toolset

Every app type defines "what belongs in each P" differently, so the fixed toolset per phase is fully customizable. There are five ways, from most local to most global; use whichever fits.

**1. Per-tool `phases`** — the tool author declares its category:

```ts
tool = { name: "smoke_check", phases: ["perfect"], /* ... */ };
```

**2. `phaseTools` as an exact pinned list** — replace a phase's toolset entirely:

```ts
new Harness({ phaseTools: { perfect: [myPlaywrightAudit, mediaAnalysisTool, bashTool] } });
```

**3. `phaseTools` as a filter** — include/exclude on top of the 4P category:

```ts
new Harness({
  phaseTools: {
    perfect: { fromCategory: true, exclude: ["media_analysis"], include: ["bash"], providers: ["playwright"] },
  },
});
```

`PhaseToolFilter` fields: `fromCategory` (start from the category, default true), `include` / `exclude` (tool names), `providers` (include all tools from these provider ids), `kinds` / `sources` (restrict to provider kinds/sources).

**4. `phaseTools` as a resolver function** — full programmatic control:

```ts
new Harness({
  phaseTools: { prepare: (registry) => registry.allTools().filter((t) => !t.mutates) },
});
```

**5. A custom categorizer** — redefine what each P means globally for an app domain:

```ts
new Harness({
  categorizer: (tool, defaultPhases) => {
    if (tool.name.endsWith("_check")) return ["perfect"];
    if (tool.mutates) return ["perform"];
    return defaultPhases;                 // fall back to the built-in heuristic
  },
});
```

### Changing it at runtime

The toolset is customizable at any time — per session, so app tabs stay independent:

```ts
session.setPhaseTools("perfect", { include: ["my_new_audit"] });  // swap a phase spec live
session.setToolPhases("write", ["plan", "perform"]);              // move one tool
session.setProviderPhases("playwright", ["perfect"]);             // move a whole MCP
session.setPhaseTools("perfect", undefined);                      // revert to config/category
```

Resolution precedence for a phase's tools: **runtime `setPhaseTools` → constructor `phaseTools` → registry 4P category** (which itself respects per-tool `phases` and the custom `categorizer`). Prompts are exported as `PHASE_PROMPTS` if you want to inspect or replace them.

See `examples/custom-phases.mjs` for a runnable check of all of the above.
