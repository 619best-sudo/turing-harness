# turing-harness

A coding-agent orchestration library built around one idea: **a small model is
effective when it never sees a big context or a big tool list.**

v2 (the **categorizer chain**) replaces the retired 4P phase system and the
classic flat run. A cheap router call picks ONE focused *categorizer* — a small
toolset, a combined prompt, its own orchestrator model, and a single expectation
it must `deliver`. The chain hops between categorizers until the work is done,
then summarises. Every hop starts fresh; a follow-up categorizer receives only
what its `accepts` contract names — never a shared transcript.

```
user prompt + attachments + /mentions
        │
   ┌────▼───── router (cheap, tool-free) ─────┐
   │                                          │
   ▼                                          │
 categorizer (scoped tools, own model)        │
   │ deliver ── the ONE expectation           │
   ▼                                          │
 router over children ∪ summarise ────────────┘
   │
 read → write_edit ↔ activity_inspect → summarise
```

- **Multimodal** (file/image/video/audio), reference-first attachments.
- **pi-compatible** types & event stream (a pi UI drives it nearly unchanged).
- **Registry** of MCP servers / skills / tools, scoped by categorizer.
- **Per-categorizer orchestrator models** + the retained per-call escalation
  (Model-B authoring for write/edit by complexity & category, staged-read
  comprehension, `routeModel` / `toolModelCandidates`).
- **Smart context passing**: deliverables + accepted tool records only.
- **`clearing_doubt`**: a stuck small model consults a big model for
  step-by-step guidance it executes with its own tools.
- Permission gate (ask-all / bypass / ask-mutations) with per-call model
  selection. Electron-capable (pure Node built-ins + fetch).

```bash
npm install
npm run build
node examples/smoke.mjs   # end-to-end demo with a fake (offline) model
```

## Quick start

```js
import { Harness } from "turing-harness";

const harness = new Harness({
  cwd: "/path/to/project",
  permissionMode: "ask-mutations",
  permissionCallback: async (req) => ({ allowed: true }),
});

const unsub = harness.subscribe((event) => { /* see events below */ });

const result = await harness.run("add a /health endpoint that returns ok");
console.log(result.summary, result.steps, result.verified);
```

The pi-style agent facade (what a chat UI drives):

```js
const agent = harness.createAgent({ thinkingLevel: "medium" });
await agent.prompt("build me a landing page", attachments, { planMode: true });
// agent.state.messages / .lastRunSummary / .lastSteps / .lastPlanSet / .lastThreadSnapshot
```

## The four default categorizers

| id | own tools | children | accepts | delivers |
|---|---|---|---|---|
| `conversation` | — (globals) | — | fresh | `{summary}` |
| `read` | read, ls, grep, bash_readonly, mark_concern_lines, *_memory | write_edit, activity_inspect | fresh | files (path/lines/snippet) + linked `codeSummary` |
| `write_edit` | read/ls/grep, write, edit, **create_plan (always)**, assets_generator, inspiration_generator, design_skill | activity_inspect | read + activity_inspect deliverables | the writes that landed |
| `activity_inspect` | **drive** (fused web automation), media_analysis, mobile, activity_* family, add_log, remove_log | write_edit | write_edit deliverable **+ write/edit call records** | findings + logPaths + bugLocation + verdict |

**Globals every categorizer receives**: `bash`, `ask_user_question`,
`clearing_doubt`, `web_search`, `web_fetch`, `web_scrape` — plus the tools of
any MCP server or skill the user mentioned with `/name` or `#name`.

**Flow**: read → (write_edit | activity_inspect for bug reports) → after writes,
activity_inspect for QA → a `fail` verdict routes back to write_edit → a `pass`
(or nothing left) summarises. Bounded by `maxHops` (default 6); the router never
repeats the categorizer that just ran.

## categorizer-setup (the app's config file)

The categories are data. Extend or replace them from a plain setup module —
new categories need nothing but ids wired into `children`/`accepts`:

```js
// categorizer-setup.js (your app)
import {
  DEFAULT_CATEGORIZER_SETUP,
  defineCategorizer,
  createCategorizerSetup,
} from "turing-harness/categorizer-setup";

const deploy = defineCategorizer({
  id: "deploy",
  name: "Deploy",
  description: "Ship the verified build: run the project's deploy pipeline.",
  systemPrompt: "You are the DEPLOY categorizer… call deliver when shipped.",
  tools: ["bash"],
  children: [],
  accepts: { from: ["activity_inspect"] },
  returns: { kind: "summary", description: "The deploy result" },
  model: "qwen/qwen3-coder",       // this categorizer's own orchestrator (driver) model
});

export const setup = createCategorizerSetup({
  categories: [...DEFAULT_CATEGORIZER_SETUP.categories, deploy],
  routerModel: "xiaomi/mimo-v2.5",  // the router turn
  summaryModel: "xiaomi/mimo-v2.5", // the closing summary turn
  doubtModel: "tencent/hy3",        // the big model clearing_doubt consults
  maxHops: 8,
});

// new Harness({ categorizerSetup: setup, ... }) — or per session.
```

Each definition carries: unique `id`, `tools`, combined `systemPrompt`,
`children` (allowed next hops), `accepts` (`from` deliverables + `tools` whose
call records flow in), `returns` (the deliverable contract — it drives the
injected terminal `deliver` tool's schema), optional `model`/`reasoning`
(per-categorizer orchestrator), `entry`, `maxSteps`.

## Completion is a tool call, not a guess

Every categorizer's loop ends when the model calls the injected **`deliver`**
tool with its structured result (`AgentTool.terminal` ends the loop). If a
small model just stops instead, the chain derives a fallback deliverable from
what the loop actually tracked (written paths, final text) and logs the gap.

## Plan mode (`create_plan` always, card only in plan mode)

`create_plan` **always** runs inside `write_edit` — the first `write`/`edit` is
refused until a plan exists (twice, then allowed; a deadlock is worse than a
nudge). With multiple attachments, the plan routes each attachment only to the
steps that need it. The **review card** shows only when the host passes
`planMode: true` (via `agent.prompt(input, attachments, { planMode: true })` or
`run(task, { planMode: true })`) **and** a `planApproval` callback is installed;
otherwise the plan auto-approves silently.

## Model escalation (kept from v1, verbatim)

- **Per-call**: `estimateComplexity` → `selectModel` over `toolModelCandidates`;
  permission decisions may re-pin `model` / `authorModel` / `thinkingLevel`.
- **Model-B authoring**: `write`/`edit` rate themselves (`complexity` +
  `category`: `ui`/`svg`/`code`); medium/high route to a stronger author via
  `routeModel({kind:"write", rating, category, hasAttachment, path})` or the
  permission decision's `authorModel`. `authorOnlyWrites` mode keeps Model A
  from drafting at all.
- **Staged reads**: a hard file escalates comprehension to a stronger model
  (`routeModel({kind:"read"})`); measured ratings ratchet per-path floors.
- **Plan-task floors**: a plan task's `complexity` becomes the floor for
  write/edit on its files; plan JSON reaches Model B's authoring context.
- **Where models are configured (v2)**: entirely in the categorizer setup —
  each category's `model` (its driver), plus `routerModel` / `summaryModel` /
  `doubtModel` chain-wide. A category without a `model` drives on the work-tier
  default (conversation on the cheap tier).

## Fused automation (`drive` + `mobile`)

Automation is one tool call per step — never the snapshot → ref → click →
re-snapshot ceremony:

```
add_log → build (bash) → drive open → drive look → drive click/fill/… → drive shot
→ media_analysis (qa/compare) + activity_study → verdict
```

- `drive { action: "look" }` returns the screenshot **and** every element
  (names + refs) in one result.
- `drive { action: "click", target: "Sign in" }` resolves the description
  against the live page, clicks, and returns the post-action screenshot plus
  what changed — nothing to look up first, nothing to re-check after.
- `drive { action: "shot" }` is the final capture for media_analysis.
- Ambiguous/missed targets list the page's elements instead of guessing.
- Devices/simulators use the same shape via `mobile`; a one-shot page + console
  capture with no driving remains `activity_inspect`.

## clearing_doubt

Available in every categorizer. When the small model is unsure or the work
seems beyond it, it calls `clearing_doubt { doubt }`; a senior model
(`setup.doubtModel`, default `tencent/hy3`) is consulted with the task, state
and the categorizer's own toolset, and answers with numbered steps phrased
against those tools — the small model executes them itself.

## Events

pi-compatible: `agent_start/end`, `turn_start/end`, `message_*`,
`tool_execution_start/update/end`, `permission_request/decision`. v2 adds the
namespaced pair (ignorable by pi UIs):

```ts
| { type: "categorizer_start"; categorizer: string; model: string }
| { type: "categorizer_end"; categorizer: string; writtenPaths?: string[]; readPaths?: string[] }
```

Hop events are **progress telemetry only**. Each categorizer's deliverable is an
internal handoff for the next categorizer — it is never emitted as UI content.
The single user-facing summary of a run is the final one
(`RunLoopResult.summary`), composed from every hop's deliverable: a
summary-of-summaries, produced by a dedicated summary turn when the last
categorizer finishes.

The old `phase_*` / `chain_*` events are retired with the 4P system.

## Registry, MCP, skills, mentions

```js
await session.addMcpServer({ id: "playwright", name: "Playwright", command: "npx", args: ["-y", "@playwright/mcp"] });
session.addSkill(defineSkill({ id: "skill:lint", name: "lint", description: "…", categorizers: ["write_edit"], tools: […] }));
session.listCapabilities();
```

Users mention capabilities in the prompt (`/lint`, `#playwright`); resolved
providers' tools join **every** categorizer, `#file` mentions join the run's
files. Unresolved mentions are surfaced to the model ("no such skill").

## Multi-session & project memory

`harness.createSession()` mints isolated sessions (own registry/logs/gate/
models). `harness.createProjectSession(category)` additionally opens
`.turing/` project/file/graph memory — the `read` categorizer's deliverable
carries `memoryUpdates` and `projectCategory` back for reconciliation, and
presets re-apply when the category changed.

## What was retired (v1 → v2 migration)

- `runChain` / `runPhase` / `phaseTools()` / `chainTool()` and the
  `phase_start|end|summary` / `chain_*` events — use `run()` and the
  `categorizer_*` events.
- `Phase`/`PHASES`/`PhaseResult`/`PhaseHandoff` types; `AgentTool.phases` →
  `AgentTool.categorizers`; `PermissionRequest.phase`/`AskUserQuestionRequest.phase`
  are now optional strings carrying the categorizer id.
- The `models: { prepare, plan, perform, perfect }` role-slot CONFIG — model
  selection is configured in the categorizer setup now (see above). The old
  keys and `setModel("<slot>", …)` still work as hidden compat aliases
  (`prepare`→router/conversation tier, `perform`→work tier, `perfect`→summary
  turn, `orchestrator`→doubt fallback), but new code should not use them.
- The reproduce/verify/QA gates: reproduction and verification are the
  `activity_inspect` categorizer's job (a bug report routes read → inspect →
  write_edit; `RunLoopResult.verified` comes from the inspect verdict;
  `RunOptions.isBugFix`/`verify` remain as router hints).
- `RunLoopResult.reproduction`/`.verification` fields (always undefined now).
- Unchanged client surface: `Harness.run`, `Session.run`,
  `agent.prompt(input, attachments, { planMode })`, `RunLoopResult` (minus the
  two fields above), permission/ask/plan callbacks, thread snapshots.

## Development

```bash
npm run build
npm test          # build + node --test tests/*.test.mjs
```
