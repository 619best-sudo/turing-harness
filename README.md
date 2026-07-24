# turing-harness

A coding-agent orchestration library built around the **4P model** — **Prepare → Plan → Perform → Perfect** — with pluggable per-phase/per-tool models over OpenRouter, a registry of internal + external MCP/skills/tools, multimodal inputs, a permission gate, and three built-in tools (asset generation, visual QA, activity monitoring). Types and the event stream are **compatible with [`@mariozechner/pi`](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)** so a pi-style UI can drive it with minimal changes. Pure Node + `fetch`, so it runs in Node and in an **Electron** main process.

```bash
npm install
npm run build
node examples/smoke.mjs   # end-to-end demo with a fake (offline) model
```

## Documentation

Full docs live in [`docs/`](./docs/index.md):

- [Getting started](./docs/getting-started.md) — install, config, first chain & Agent
- [Multi-session (parallel runs)](./docs/multi-session.md) — isolated sessions running concurrently in one process
- [Concepts & architecture](./docs/architecture.md) — how it fits together, the orchestrator invariant
- [The 4P phases](./docs/4p-phases.md) — each phase, the chain, verify/retry
- [Project presets](./docs/project-presets.md) — ready-made frontend / mobile / games / backend setups
- [Project memory](./docs/project-memory.md) — durable per-project memory; auto-detects the tech stack on first init
- [API reference](./docs/api-reference.md) — every exported class, function, and type
- [Test plan](./docs/test-plan.md) — real-project, real-prompt test cases for every feature
- [Guides & recipes](./docs/guides.md) — MCP servers, custom tools, permissions, models, multimodal, Electron
- [pi migration](./docs/pi-migration.md) — mapping to `@mariozechner/pi` and how to migrate

## Quick start

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({
  apiKey: process.env.OPENROUTER_API_KEY,
  cwd: process.cwd(),
  permissionMode: "ask-mutations",           // "ask-all" | "bypass" | "ask-mutations"
  models: {                                   // per-phase orchestrator models (req #5)
    prepare: "anthropic/claude-haiku-4.5",
    plan:    "anthropic/claude-opus-4.8",
    perform: "anthropic/claude-sonnet-4.5",
    perfect: "anthropic/claude-sonnet-4.5",
  },
  permissionCallback: (req) => {
    // req.complexity.score + req.refs drive model choice; return a model to pin it.
    return { allowed: true, model: req.complexity.score > 0.6 ? "anthropic/claude-opus-4.8" : undefined };
  },
});

harness.subscribe((e) => console.log(e.type));           // pi-compatible AgentEvent stream
const result = await harness.runChain("Add a /health endpoint and a test for it.");
console.log(result.success, result.phases.perfect?.verified);
```

### As a pi-style Agent

```ts
const agent = harness.createAgent({ model: "anthropic/claude-opus-4.8" });
agent.subscribe((e) => renderPiEvent(e));   // same AgentEvent shape pi UIs consume
await agent.prompt("Fix the failing login test", attachments);
console.log(agent.state.messages);          // AppMessage[]
console.log(agent.state.lastThreadSnapshot); // structured follow-up context for the next prompt
```

Follow-up prompts in the same session now use a structured thread snapshot by default. The visible `messages` array remains the render transcript, while the next `runChain()` receives compact prior-run context (`task`, summaries, changed files, verification state) through `threadSnapshot`. Call `agent.reset()` or `session.clearThreadSnapshot()` to start over without follow-up continuity.

## The 4P model (req #3, #4)

| Phase | Purpose | Typical tools |
|-------|---------|---------------|
| **Prepare** | Prepare the run: find relevant files, walk graph-memory blast radius, route MCPs/skills to later phases. Every kept file gets a `why` + `low/medium/high` complexity. Read-only, memory-first. | `read`, `project_memory`, `file_memory`, `graph_memory` |
| **Plan** | Read the handed-over files and chalk out **ordered** implementation plans — one for a single repo, **multiple with an execution order** for multi-repo. Per-task complexity. Read-only. | `read`, `bash_readonly`, `file_memory`, `graph_memory` + Plan-assigned MCPs |
| **Perform** | Execute the plan's tasks **in order** (reads **and** mutations); one Perform pass **per plan**. | `read`, `write`, `edit`, `bash`, `assets_generator` + Perform-assigned MCPs |
| **Perfect** | Derive a tech-stack **QA plan** and verify adversarially (API via `bash`, browser/mobile MCP + screenshot → `ui_screen_auditor`, tests, typecheck). FAIL ⇒ plan-like `FIX`. | `bash`, `read`, `ui_screen_auditor`, browser/mobile/sqlite MCPs |

- **A single successful operation** = one run of `runChain()`: Prepare → Plan → Perform → Perfect. Prepare/Plan run once; then **Perform ↔ Perfect loops**: if Perfect's `VERDICT: FAIL`, its `FIX:` section is fed back into another Perform, up to `maxChainIterations`. (req #4)
- **Multiple plans** (`PLANS_JSON`, multi-repo tasks) run **one Perform pass per plan** in execution order, each scoped to its plan's files/mutations/complexity. A single-repo `PLAN_JSON` is the one-plan case. See [`docs/4p-phases.md`](./docs/4p-phases.md#multiple-plans-multi-repo-tasks).
- **Complexity flows down the chain**: Prepare's per-file rating is inherited by later reads; Plan's per-task rating by Perform's edits/writes. Each permission request carries `complexityRating` + `complexitySource`, and per-call model selection uses the inherited rating as a floor. See [Complexity inheritance](./docs/4p-phases.md#complexity-inheritance).
- **Every phase emits common handoff parameters**: `uiSummary` (styled, user-facing), `toolChain` (curated continuity), and a structured `handoff` — see the [common handoff outputs](./docs/4p-phases.md#common-handoff-outputs-every-phase).
- **Each phase can also run standalone**: `harness.runPhase("prepare", task)`. (req #4)
- **Phases are also meta-tools** (`harness.phaseTools()`, `harness.chainTool()`) so they can be dropped into an outer tool-call chain. (req #3/#4)
- Each phase's **fixed toolset** is resolved from the registry by 4P category, or pinned explicitly via `phaseTools` config. (req #3)

## Registry: MCP / skills / tools (req #3)

Providers are **internal** (bundled) or **external** (user-loaded). Each is categorized into one or more 4P phases; `list()` returns an aggregated description derived from its tools.

```ts
// get list — every provider with description + 4P category + full tool defs
harness.listCapabilities();
harness.listCapabilities({ phase: "perfect", source: "external" });

// add — an external MCP server (spawned over stdio) ...
await harness.addMcpServer({ id: "playwright", command: "npx", args: ["@playwright/mcp"] });
// ... or a skill (a named, phase-scoped bundle of in-process tools) ...
import { defineSkill } from "@turing/harness";
registry.add(defineSkill({
  id: "skill:docs", name: "docs-helper",
  description: "Fetches & summarizes reference docs for planning.",
  phases: ["plan"],                 // route the skill to the phase(s) it serves
  tools: [/* AgentTool[] */],
}));

// delete
await harness.removeProvider("playwright");
```

`defineSkill` gives skills a first-class registration path (parallel to `connectMcpServer` for MCP servers): declare `phases` explicitly and every tool lands in exactly those phase(s) instead of the categorizer's guess. Categorization is otherwise heuristic (read-only/discovery → Prepare+Plan, mutation → Perform, verification incl. browser/mobile/API-probe → Perfect) and can always be overridden per-tool via `tool.phases`. Prepare receives the full provider metadata (id/kind/name/description/phases/tools) **plus the shared 4P phase definitions**, so its per-phase provider routing (`PROVIDER ASSIGNMENTS`) is grounded in what each phase is actually for.

## Models over OpenRouter (req #5)

Every model call goes through one OpenRouter-shaped function (`callOpenRouter` / `streamOpenRouter`). The request/response are OpenAI/OpenRouter-compatible, so any OpenAI-compatible endpoint works by setting `baseUrl`.

- **Per-phase model**: `models` config or `orchestrator.setModel(phase, slug)` at runtime.
- **Per-tool-call model**: returned from the `permissionCallback` (`decision.model`); otherwise selected by complexity + required modalities; otherwise the phase model runs it. (req #5, #7)
- `stream()` / `complete()` are exported with the exact pi-ai signatures.

## Permissions & model selection (req #7)

The orchestrator only runs the loop — **it never reasons over file contents and never writes/edits code**. All reasoning is done by the phase model; all IO by tools.

Every **phase call and tool call** passes through the permission gate:

- Modes: `bypass`, `ask-all`, `ask-mutations` (mutating calls declare `mutates: true`).
- The callback receives the operation's **`complexity`** (0..1 + signals), a coarse **`complexityRating`** (`low`/`medium`/`high`), a **`complexitySource`** (`estimated` / `prepare-file` / `plan-task` — so the UI can show whether the rating was inherited from Prepare's per-file rating or Plan's per-task rating), the relevant media **`refs`** (address + summary, **not** bytes), and optional **`options`** (named choices the host may present). It returns `{ allowed, model?, reasoning?, transcript?, option?, reason? }` — `model` pins any OpenRouter slug the client wants for that call; `option` echoes the chosen `PermissionOption`. On a **phase** decision, `transcript` and `reasoning` are UI-emission toggles applied before the phase streams: `transcript` picks full (text + tool calls) vs compact (tool-calls-only) emission, and `reasoning` gates whether the model's thinking is emitted to the UI. They're independent — set both `true` to emit both; omit a flag and the configured `transcriptMode` (and reasoning-on for a full transcript) applies.
- Attachments are **reference-first**: the address + a summary are carried between calls; bytes are read only when a step needs them.

## Multimodal (req #1)

`Attachment` / content blocks cover **file, image, video, audio**. Build a lazy (address-only) attachment and let the harness inline bytes on demand:

```ts
import { attachmentFromPath } from "@turing/harness";
const shot = await attachmentFromPath("./screens/home.png", "landing page screenshot");
await agent.prompt("Does this match the spec?", [shot]);
```

Model selection respects modality: an audio/video attachment forces an audio/video-capable model.

## Built-in tools (req #6)

- **`assets_generator`** — generate image / video / audio / 3d. Backends are pluggable (`assets.backends`); with none configured it writes deterministic placeholders so the pipeline still runs end-to-end. Returns the asset **by reference** (path + summary).
- **`ui_screen_auditor`** — visual QA of screenshots/video against acceptance criteria using a vision model; returns `{ pass, score, findings[] }`.
- **`activity_monitor`** — search/study the activity log; filter by **tag** to cut noise, tail an external log file, or ask a model to study a filtered slice.
- **`project_memory`** — read/append the durable project memory (category, tech stack, learned facts). Present when a session is created via `createProjectSession`. See [docs/project-memory.md](./docs/project-memory.md).
- **`file_memory`** — one-shot search over the durable file-memory index (per-file summaries, tags, and freshness metadata). Present when a project session has durable memory enabled.
- **`graph_memory`** — durable file/symbol dependency and blast-radius queries over the on-disk graph index. Present when a project session has durable memory enabled.

## pi compatibility (req #2)

Structurally matched to `@mariozechner/pi-ai` / `pi-agent`:

| pi | turing-harness |
|----|----------------|
| `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage` | same |
| `TextContent` / `ThinkingContent` / `ImageContent` / `ToolCall` | same (+ `MediaContent` for audio/video/file) |
| `Context { systemPrompt?, messages, tools? }` | same |
| `AssistantMessageEvent` (start/text_delta/toolcall_*/done/error) | same |
| `AgentEvent` (agent_start … tool_execution_end) | same (+ namespaced `phase_*`/`chain_*`/`permission_*`) |
| `Tool` + `AgentTool.execute → { output?, details?, content? }` | same |
| `Attachment`, `Model`, `Usage`, `stream()`/`complete()` | same signatures |

A pi UI that renders `Message[]` and consumes `AgentEvent`/`AssistantMessageEvent` works unchanged; the 4P events are additive and namespaced so they can be ignored.

The main behavior addition is follow-up continuity: a session now acts as the thread container. A new prompt after a completed run starts a fresh 4P execution, but it carries a structured snapshot of the previous run instead of replaying raw transcript/tool chatter into the next model call.

## Multi-session (parallel runs)

`Harness` is a **session manager**. Each `Session` is fully isolated — its own registry, log store, permission gate, orchestrator, `cwd`, event stream, and abort scope — so many runs proceed at once in one process (e.g. one Electron app with several project tabs) with no cross-talk. The stateless LLM bridge and read-only model catalog are shared.

```ts
const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

const web = harness.createSession({ cwd: "/repos/web", permissionMode: "ask-mutations" });
const api = harness.createSession({ cwd: "/repos/api", permissionMode: "bypass" });

const [a, b] = await Promise.all([        // run concurrently, isolated
  web.runChain("Add dark mode."),
  api.runChain("Add /health + a test."),
]);

harness.subscribeAll((sessionId, e) => route(sessionId, e));   // events tagged by session
await harness.closeSession(web.id);       // aborts its runs, stops its MCPs
```

The single-session methods (`runChain`, `subscribe`, registry APIs, …) still work — they proxy to a lazily created `"default"` session, so existing code is unchanged. See [docs/multi-session.md](./docs/multi-session.md) and `examples/multi-session.mjs`.

## Project presets

Ready-made 4P setups for common project types — each wires the phases with a category-appropriate tool/MCP policy and per-phase model defaults. Declarative and offline-safe; MCP servers spawn only on opt-in.

```ts
// Policy + models only (nothing spawned):
const web = harness.createSession({ preset: "frontend", cwd: "/repos/web" });

// Policy + models + connect the recommended MCP servers:
const { session, report } = await harness.createProjectSession("backend", {
  cwd: "/repos/api", connectMcp: true, dbUrl: process.env.DATABASE_URL,
});
```

| Category | Perfect-phase MCPs (verification) | Also |
|----------|-----------------------------------|------|
| **frontend** | Playwright, Chrome DevTools | Figma (plan/perform), Context7 |
| **mobile** | mobile-mcp (simulators/devices) | Context7; Perfect uses a vision model |
| **games** | Godot MCP (run/screenshot/input) | assets_generator; Perfect vision model |
| **backend** | Postgres (verify data) + bash/curl | Postgres, Filesystem, Context7 |

Presets are a starting point — every part stays customizable per session. See [docs/project-presets.md](./docs/project-presets.md) and `examples/project-presets.mjs`.

## Project memory

The first time a project directory is opened, the harness **detects its tech stack** (website / mobile / game / backend) and writes a durable memory to `<cwd>/.turing/`. On later opens the memory is loaded, and its category selects the preset — so you don't pass the category every time.

```ts
// First open: detects stack, writes .turing/, picks the preset from the result.
const { session, memory } = await harness.createProjectSession({ cwd: "/repos/api" });
memory.category;   // "backend"  (auto-detected & persisted)
memory.stack;      // { languages: ["typescript"], frameworks: ["express"], ... }

// Later — same or new process — category comes from memory, no re-detection.
await harness.createProjectSession({ cwd: "/repos/api" });
```

Memory also accumulates durable facts across runs (via the `project_memory` tool the agent gets, or `memory.remember(...)`), and project sessions also build:

- a durable file-memory index in `.turing/files.json` + `FILES_MEMORY.md` for one-shot file search via `file_memory.search`, with background LLM summaries, keywords, and per-session watcher refresh
- a durable graph-memory index in `.turing/graph.json` + `GRAPH_MEMORY.md` for file deps, symbol deps, and blast-radius queries via `graph_memory`

An explicit category argument overrides + persists. Set `memory: false` to skip `.turing/`. See [docs/project-memory.md](./docs/project-memory.md), `examples/project-memory.mjs`, `examples/file-memory.mjs`, and `examples/graph-memory.mjs`.

Detection now intentionally covers a much broader ecosystem set than the original JS/Python-heavy baseline, including common manifests and frameworks across PHP, .NET/C#, Swift, Scala, Elixir, Clojure, Haskell, Lua, Perl, R, Zig, plus major frontend/mobile/game stacks. File memory also tags and summarizes many of those ecosystem-specific files for one-shot search.

`graph_memory` now follows a tiered support model across those ecosystems:

- exact file + symbol graph for `typescript` / `javascript`
- broad file-graph and blast-radius support across the other detected languages
- framework-aware convention edges for supported web/backend/mobile/game stacks
- capability-aware query results so partial ecosystems report what level of graph precision is available

## Electron

The core is DOM-free and depends only on Node built-ins + global `fetch`. Run the `Harness` in the **main process**; map each renderer window/tab to a `Session`, forward that session's events to the renderer over IPC (`subscribeAll` tags each event with its `sessionId`), and call `session.runChain` / `agent.prompt` from IPC handlers. External MCP servers spawn per-session as child processes from the main process.

## Architecture

```
Harness  (session manager — shared LLM bridge + defaults)
└── Session  (isolated; one per parallel run)
    ├── Registry         get/add/delete providers, 4P categorization
    ├── PermissionGate   ask-all | bypass | ask-mutations
    ├── LogStore         structured logs (feeds activity_monitor)
    ├── cwd + abort scope
    └── Orchestrator     runs the loop; per-phase/per-tool models
        └── runPhase()   LLM-driven tool loop per phase → PhaseResult
            ├── prepare  ├── plan  ├── perform  └── perfect (verify → retry)
Shared: OpenRouterBridge (LLMBridge), model catalog
Internal tools: bash/read/write/edit/ls/grep, project_memory, file_memory, graph_memory,
                assets_generator, ui_screen_auditor, activity_monitor
```

See `examples/smoke.mjs` for a runnable, offline end-to-end demo.
