# Test plan — real project, real prompts

This document exercises **every feature** of turing-harness against a realistic project with the kinds of prompts a developer actually types. Each case lists the prompt/action, the steps, and the concrete, observable expected result.

## Legend

| Tag | Meaning |
|-----|---------|
| 🟢 **offline** | Deterministic; runs with the bundled fake model / no network. Mirrored by an `examples/*.mjs` suite where noted. |
| 🔵 **live** | Needs `OPENROUTER_API_KEY` (real model). Outcomes are described as invariants, not exact text. |
| 🟣 **live+mcp** | Also needs an external MCP server installed (e.g. `npx @playwright/mcp`, a Postgres URL). |

A case **passes** when every bullet under *Expect* holds. "Events" refers to the pi-compatible `AgentEvent` stream from `session.subscribe(...)` / `harness.subscribeAll(...)`.

---

## The sample project — `acme`

A notes-product monorepo that spans all four project categories, so one repo covers frontend, mobile, games, and backend:

```
acme/
  apps/
    web/        Next.js + React + TypeScript          → detects "frontend"
    mobile/     Expo (React Native) + TypeScript       → detects "mobile"
    api/        Express + Postgres + TypeScript         → detects "backend"
    arcade/     Godot 4 mini-game (project.godot)       → detects "games"
  packages/
    ui/         shared React components (TS)
```

Detection signals per app: `web` (`next`,`react` in package.json), `mobile` (`expo`,`react-native`), `api` (`express`), `arcade` (`project.godot`).

### Environment setup

```bash
node --version            # ≥ 18
export OPENROUTER_API_KEY=sk-or-...       # for 🔵 / 🟣 cases
# optional external MCP servers used by 🟣 cases:
#   npx @playwright/mcp@latest            # frontend Perfect
#   @modelcontextprotocol/server-postgres # backend (needs DATABASE_URL)
```

```ts
import { Harness } from "@turing/harness";
const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });
```

---

## 1. Project memory & tech-stack detection

Suite: `examples/project-memory.mjs` (🟢).

| ID | Type | Prompt / Action | Steps | Expect |
|----|------|-----------------|-------|--------|
| **MEM-1** | 🟢 | Open the API app for the first time | `const { session, memory } = await harness.createProjectSession({ cwd: "acme/apps/api" })` | `memory.category === "backend"`; `memory.stack.frameworks` includes `express`; `acme/apps/api/.turing/project.json` + `MEMORY.md` created; `memory.wasCreated === true`. |
| **MEM-2** | 🟢 | Reopen the same app | call `createProjectSession({ cwd: "acme/apps/api" })` again | Second `ProjectMemory.open().wasCreated === false`; category read from disk (no re-detection); no duplicate files. |
| **MEM-3** | 🟢 | Detect each app | open `web` / `mobile` / `arcade` | Categories: `frontend` / `mobile` / `games`; `arcade` stack `engine === "godot"`. |
| **MEM-4** | 🟢 | Correct a wrong guess | `createProjectSession("backend", { cwd: "acme/packages/ui" })` | `memory.category === "backend"`; persisted `detection.auto === false`. |
| **MEM-5** | 🔵 | "Remember that tests run via `pnpm test` in this repo." | run a chain; the model calls `project_memory{action:"remember"}` (or `memory.remember(...)`) | Fact persisted in `.turing/project.json` and visible in a later session via `project_memory{action:"recall"}`. |
| **MEM-6** | 🟢 | Opt out of memory | `createProjectSession({ cwd, memory: false })` | Returned `memory === undefined`; **no** `.turing/` dir written; no `project_memory` tool on the session. |
| **MEM-7** | 🟢 | Open a large project (100+ files) | `const { fileMemory } = await harness.createProjectSession({ cwd })` | `.turing/files.json` + `FILES_MEMORY.md` created; `fileMemory.stats().totalFiles >= 100`; `fileMemory.wasCreated === true`. |
| **MEM-8** | 🟢 | Search for a file in one call | call `file_memory{action:"search", query:"search files in one go"}` | Ranked file results returned in one tool call; top result matches the intended file. |
| **MEM-9** | 🟢 | External edit makes file stale | edit an indexed file, reopen the same project | reopened `fileMemory.get(path).stale === true`; `file_memory{action:"refresh"}` clears staleness and updates the summary. |
| **MEM-10** | 🟢 | Detection matrix breadth | open representative projects for PHP/Laravel, Symfony, .NET, Swift, Scala, Elixir/Phoenix, Clojure, Haskell, Lua, Perl, R, Zig | `detectProject(...)` returns the expected language and category, plus framework names when strong signals exist. |
| **MEM-11** | 🟢 | File-memory non-JS ecosystem awareness | index a project containing `composer.json`, `Package.swift`, `Program.cs`, `mix.exs`, `build.zig`, etc. | `file_memory.get(...)` includes ecosystem-aware tags/summaries and `file_memory.search(...)` can rank those files from natural-language queries. |
| **MEM-12** | 🟢 | Graph memory first init | `const { graphMemory } = await harness.createProjectSession({ cwd })` on a TS/JS project with imports/calls | `.turing/graph.json` + `GRAPH_MEMORY.md` created; `graphMemory.wasCreated === true`; `graphMemory.stats().totalFiles > 0`; `graph_memory` tool present on the session. |
| **MEM-13** | 🟢 | File dependency graph query | call `graph_memory{action:"file_deps", path:".../src/b.ts", direction:"inbound"}` | returns direct dependents for the target file in one call, with file paths and stale/fresh state. |
| **MEM-14** | 🟢 | Symbol dependency graph query | call `graph_memory{action:"symbol_deps", path:".../src/b.ts", symbol:"bar", direction:"inbound"}` | returns callers/references for the target symbol in one call. |
| **MEM-15** | 🟢 | Blast-radius query | call `graph_memory{action:"blast_radius", path:".../src/b.ts", symbol:"bar"}` | returns direct and transitive impacted files/symbols with reasons and freshness state. |
| **MEM-16** | 🟢 | Graph stale refresh | externally edit an indexed TS/JS file, reopen project, then run `graph_memory{action:"refresh"}` | reopened graph node is stale; refresh clears staleness and rebuilds new symbols/edges. |
| **MEM-17** | 🟢 | Multi-language graph matrix breadth | open representative Python, PHP, Ruby, Go, Rust, JVM, .NET, Dart, Swift, Elixir, Clojure, and misc-language projects | each representative project returns at least file-level graph/blast results with correct capability metadata. |
| **MEM-18** | 🟢 | Framework overlay breadth | open representative Next/Nest/Django/Laravel/Rails/Spring/Phoenix/Flutter/Godot-style projects | graph queries return framework-convention edges such as routes/controllers/pages/layouts/navigation/scenes where expected. |
| **MEM-19** | 🟢 | Background LLM file hydration | open a project session with file memory enabled and a stub LLM | session returns immediately; `fileMemoryRuntime` hydrates summaries in the background; entries move from `summarySource === "heuristic"` to `summarySource === "llm"` and persist keywords to `.turing/files.json`. |
| **MEM-20** | 🟢 | Watcher-driven summary refresh | modify a watched indexed file while the session is still alive | watcher marks the file pending, refreshes file metadata, then re-hydrates summary/keywords in the background without reopening the project. |

---

## 2. Project presets (frontend / mobile / games / backend)

Suite: `examples/project-presets.mjs` (🟢).

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **PRE-1** | 🟢 | `createProjectSession({ cwd: "acme/apps/web" })` (category from memory) | `session.toolsForPhase("perfect")` policy references `playwright`/`chrome-devtools` providers; Perfect includes `bash` + `media_analysis`; Perform includes `write`/`edit`. |
| **PRE-2** | 🟢 | Backend preset models | open `apps/api`, inspect resolved phase models | Plan → opus, Perform → sonnet, Perfect → sonnet (per `PROJECT_PRESETS.backend.models`). |
| **PRE-3** | 🟢 | Mobile/games use a vision Perfect model | open `apps/mobile` / `apps/arcade` | Perfect model === `google/gemini-2.5-pro`. |
| **PRE-4** | 🟢 | Explicit override wins | `createProjectSession("frontend", { cwd, models: { perform: "anthropic/claude-haiku-4.5" } })` | Perform runs with haiku (explicit beats preset). |
| **PRE-5** | 🟣 | Connect preset MCPs (frontend) | `createProjectSession("frontend", { cwd: "acme/apps/web", connectMcp: true })` | `report.connected` includes `playwright`/`chrome-devtools` if installed; `figma` in `report.skipped` (no `FIGMA_API_KEY`); nothing throws. |
| **PRE-6** | 🟢 | Missing config is graceful | `createProjectSession("backend", { connectMcp: true })` **without** `dbUrl` | `report.skipped` contains `{ id: "postgres" }`; `report.failed` empty for that reason. |

---

## 3. The 4P chain & verify/retry

Suite: `examples/smoke.mjs` (🟢, scripted fake).

| ID | Type | Prompt | Expect |
|----|------|--------|--------|
| **CHAIN-1** | 🔵 | *(api)* "Add a `POST /api/notes` endpoint that validates `{title, body}` and a Jest test for it." | `runChain` returns `success: true`; event order includes `chain_start` → `phase_start(prepare)` → … → `phase_start(perfect)` → `chain_end`; `phases.perform.summary` starts with `CHANGES:` and lists the route file + test file; new files exist on disk; `phases.perfect.verified === true`. |
| **CHAIN-2** | 🟢 | Phase order & single-run Prepare/Plan | inspect `phases.history` | Exactly one `prepare` and one `plan`; ≥1 `perform`+`perfect` pair. |
| **RETRY-1** | 🔵 | *(web)* "Make the login form reject empty passwords." with an intentionally incomplete first attempt | If Perfect fails, expect a `chain_iteration:2`, Perform re-runs with `feedback` = Perfect's `FIX:`, and the loop ends when `verified` or `maxChainIterations` (default 3) is hit; `result.iterations` reflects the count. |
| **RETRY-2** | 🟢 | Retry cap respected | configure a fake that always fails Perfect; `maxChainIterations: 2` | `result.success === false`; `result.iterations === 2`; exactly 2 perform+perfect pairs in history. |
| **PHASE-1** | 🔵 | "Just help me understand how auth works here — don't change anything." | `await session.runPhase("prepare", ...)` | Returns a `PhaseResult` with a `SUMMARY:` referencing files by path; **no** files mutated (Prepare is read-only). |
| **PHASE-2** | 🟢 | Phases as meta-tools | `harness.phaseTools()` / `harness.chainTool()` | Returns `phase_prepare|plan|perform|perfect` + a `code` tool; `code` tool `details` is a `ChainResult`, flagged `isError` when not verified. |

---

## 4. Permissions & safety

Suite: covered within `examples/multi-session.mjs` (🟢).

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **PERM-1** | 🟢 | `ask-mutations` mode | run a chain that writes a file | `permission_request` fires for `write`/`bash`/the Perform phase (mutating), **not** for `ls`/`read`/`grep`; each request carries `complexity` + `refs`. |
| **PERM-2** | 🟢 | `bypass` mode | set `permissionMode: "bypass"` | Callback never invoked; all calls allowed. |
| **PERM-3** | 🟢 | `ask-all` mode | set `ask-all` | Callback fires for every phase and tool call, including read-only. |
| **PERM-4** | 🟢 | Deny a call | callback returns `{ allowed: false, reason }` for `write` | Tool result is a denial message with `isError`; the phase model adapts; no file written. |
| **NEG-1** | 🟢 | Block a destructive command | callback rejects `bash` when `args.command` matches `rm -rf` | The dangerous `bash` call is denied; `permission_decision` shows `allowed:false`; workspace untouched. |
| **PERM-5** | 🟢 | Callback pins a model | return `{ allowed: true, model: "anthropic/claude-opus-4.8" }` | That tool/phase runs with opus (verify via injected fake recording the model). |

---

## 5. Models over OpenRouter & selection

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **MODEL-1** | 🟢 | Per-phase models | `models: { plan: "openai/gpt-5" }`; run chain with a recording fake | Plan phase calls with `openai/gpt-5`; others use defaults. |
| **MODEL-2** | 🟢 | Runtime model change | `session.orchestrator.setModel("perform", "anthropic/claude-opus-4.8")` mid-life | Subsequent Perform runs use opus; clearing (`undefined`) reverts to config/default. |
| **MODEL-3** | 🟢 | Complexity-based selection | no `decision.model`; a high-complexity mutating call | `selectModel` picks a higher tier as `complexity.score` rises (assert via `estimateComplexity` + `selectModel` unit-style). |
| **MODEL-4** | 🟢 | Modality forces a capable model | tool call with an audio ref | `requiredModalities` includes `audio`; selected model supports audio (e.g. gemini/gpt-5), never a text-only tier. |
| **MODEL-5** | 🔵 | Custom endpoint | `new Harness({ baseUrl: "https://gateway.internal/v1", apiKey })` | Requests hit the custom base URL (OpenAI-compatible); a chain completes. |
| **MODEL-6** | 🟢 | Raw call function | `callOpenRouter(req)` / `streamOpenRouter(req)` with a mock `fetch` | Request body is OpenAI/OpenRouter-shaped; streaming assembles a final `AssistantMessage`; non-2xx throws `OpenRouterError` with `status`. |

---

## 6. Registry: MCP / skills / tools + 4P categorization

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **REG-1** | 🟢 | Get list | `harness.listCapabilities()` | Returns internal providers (coding, assets_generator, media_analysis, activity_monitor) each with `source`, `kind`, aggregated `description`, `phases`, and full tool defs. |
| **REG-2** | 🟢 | Filter | `listCapabilities({ phase: "perfect", source: "internal" })` | Only internal providers whose tools serve Perfect. |
| **REG-3** | 🟣 | Add an MCP | `await session.addMcpServer({ id: "playwright", command: "npx", args: ["@playwright/mcp@latest"] })` | Spawns, handshakes, lists tools; each becomes an `AgentTool`; `listCapabilities({source:"external"})` shows it; `added` event fired. |
| **REG-4** | 🟢 | Add a skill | `harness.addSkill({ id, name, source: "external", tools })` | Registered as `kind:"skill"`; categorized; appears in list. |
| **REG-5** | 🟢 | Delete | `await harness.removeProvider("playwright")` | Provider gone from list; its `dispose()` ran (MCP process stopped); `removed` event fired (before async dispose). |
| **REG-6** | 🟢 | Duplicate tool name rejected | add two providers exposing a tool named `read` | Second `add` throws; registry left consistent (no half-registration). |
| **REG-7** | 🟢 | Categorization heuristic | add a tool named `screenshot_diff` | Auto-categorized into `perfect`; a `write_config` tool → `perform`; `grep`-like → `prepare`+`plan`. |

Suite: `examples/custom-phases.mjs` (🟢) covers REG-4/REG-7 shapes.

---

## 7. Customizing the fixed per-phase toolset

Suite: `examples/custom-phases.mjs` (🟢).

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **CUST-1** | 🟢 | Pin exact toolset | `phaseTools: { perfect: [playwrightTool, auditorTool, bashTool] }` | `toolsForPhase("perfect")` is exactly those three. |
| **CUST-2** | 🟢 | Filter over category | `perfect: { fromCategory: true, exclude: ["media_analysis"], include: ["bash"] }` | Auditor removed, bash added, other Perfect tools kept. |
| **CUST-3** | 🟢 | Resolver function | `prepare: (registry) => registry.allTools().filter(t => !t.mutates)` | Prepare gets only non-mutating tools. |
| **CUST-4** | 🟢 | Custom categorizer | `categorizer: (t, def) => t.name.endsWith("_check") ? ["perfect"] : def` | `*_check` tools land in Perfect regardless of default heuristic. |
| **CUST-5** | 🟢 | Runtime reassignment | `session.setToolPhases("write", ["plan","perform"])`; `session.setProviderPhases("playwright", ["perfect"])`; `session.setPhaseTools("perfect", spec)` | Each takes effect immediately; `setPhaseTools(phase, undefined)` reverts to config/category. |
| **CUST-6** | 🟢 | Per-session independence | two sessions, different `phaseTools` | Each session's `toolsForPhase` differs; no cross-talk. |

---

## 8. Multi-session (parallel runs)

Suite: `examples/multi-session.mjs` (🟢).

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **SESS-1** | 🔵 | Run two apps at once: *(web)* "Add a dark-mode toggle." and *(api)* "Add a `/health` endpoint + test." via `Promise.all([web.runChain(...), api.runChain(...)])` | Both complete independently; files land in each app's own `cwd`; no interleaved writes across dirs. |
| **SESS-2** | 🟢 | Log isolation | after parallel runs | `web.logStore` only references `apps/web` paths; `api.logStore` only `apps/api`; no leakage. |
| **SESS-3** | 🟢 | Event routing | `harness.subscribeAll((sid, e) => ...)` | Every event tagged with its originating `sessionId`; both sessions' `chain_start`/`chain_end` observed. |
| **SESS-4** | 🟢 | Independent permission policy | web `bypass`, api `ask-mutations` | api prompts for mutations; web does not; policies never bleed. |
| **SESS-5** | 🟢 | Abort one, others continue | `web.abort()` mid-run | web's in-flight runs cancel; api unaffected; `closeSession(web.id)` stops its MCPs. |
| **SESS-6** | 🟢 | Backward-compat default session | `new Harness().runChain(...)` | Works via lazily created `"default"` session; `listSessions()` shows it. |

---

## 9. Multimodal (file / image / video / audio)

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **MM-1** | 🔵 | *(web)* "Match the Settings screen to this mock." + `attachmentFromPath("./mock.png", "target design")` | Attachment carried **by reference** (address + summary) between phases; bytes read only when a step needs them; a vision-capable model handles it. |
| **MM-2** | 🟢 | Reference-first, lazy load | build attachment, then `attachmentToContent(att, false)` vs `true` | `false` → address-only content block (no base64); `true` → bytes inlined. |
| **MM-3** | 🔵 | Audio input forces capable model | attach a `.wav` and ask "Transcribe the key points." | Model selection includes `audio` modality → an audio-capable model chosen. |
| **MM-4** | 🟢 | Video by reference | attach `.mp4` | Carried as `MediaRef` (uri + summary); not base64-inlined by default. |

---

## 10. Internal tools

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **TOOL-1** | 🟢 | assets_generator (placeholder) | call with `{ kind: "image", prompt: "app icon" }`, no backend | Writes a deterministic placeholder (SVG) under `<cwd>/assets`; returns a `MediaRef` (path + summary), **not** inline bytes. |
| **TOOL-2** | 🔵 | assets_generator (real backend) | configure `assets.backends.image`; *(arcade)* "Generate a pixel-art coin sprite." | Backend invoked; asset file written; ref flows into `PhaseResult.refs`. |
| **TOOL-3** | 🟢 | media_analysis | `{ file: screenshot, prompt: "is the primary button teal and un-clipped?" }`; repeat with a `.pdf`, `.mp3`, `.mp4` | Returns `details.analysis` grounded in the attachment; `details.analyzed[]` reports the inferred `kind`/`mimeType` and `inline` (false for video). |
| **TOOL-4** | 🟢 | activity_search | after a run, `activity_search{anyTags:["mutation"]}` | Returns only mutation log lines; `activity_tags{}` returns the tag histogram. |
| **TOOL-5** | 🔵 | activity_study | `{anyTags:["verify:fail"]}`, and `{traceId}` after a trace | Model summarizes the failing slice; root-cause style output. |
| **TOOL-6** | 🟢 | activity_tail_file | *(api)* `{file:"server.log", text:"ERROR"}` | Returns only matching lines from the external log file. |
| **TOOL-7** | 🟢 | web_search | `{query:"vite 7 breaking changes", site:"vite.dev"}`, with and without a browser MCP attached | Navigates the browser MCP to the search URL and scrapes hits (`{url,title?,snippet?}`); with no browser MCP, a clear "needs a browser MCP" error rather than a bash/curl fallback. |
| **TOOL-8** | 🟢 | web_fetch | a docs page, a long page, a nav failure, a server with no `browser_evaluate` | Returns the RENDERED text (client-side pages included); truncation reported; falls back to the accessibility snapshot when evaluate is missing; a blank render is explained, not returned empty. |
| **TOOL-9** | 🟢 | trace workflow | `activity_trace_start` → model's own `read`/`edit` inserting `__t()` → `activity_collect{traceId, waitMs}` → `activity_study{traceId}` → `activity_cleanup` | Each step is a SEPARATE tool call in the transcript; `activity_collect` emits `tool_execution_update` while waiting. No hidden sub-loop edits files. |

---

## 11. pi compatibility

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **PI-1** | 🟢 | Message/content shapes | inspect `session` messages after a run | Match pi `UserMessage`/`AssistantMessage`/`ToolResultMessage` + content blocks (`text`/`thinking`/`toolCall`/`image`). |
| **PI-2** | 🟢 | Streaming events | subscribe during a turn | `AssistantMessageEvent` sequence `start` → `text_delta`/`toolcall_*` → `done`/`error`, exactly pi's protocol. |
| **PI-3** | 🟢 | Agent facade | `const a = harness.createAgent(); a.subscribe(renderPiEvent); await a.prompt("...")` | Same surface as pi's `Agent` (`state`, `subscribe`, `setModel`, `abort`, `reset`); `state.messages` is `AppMessage[]`. |
| **PI-4** | 🟢 | Exported `stream`/`complete` | `import { stream, complete, resolveModel }` | Exact pi-ai signatures; usable standalone. |

---

## 12. Electron integration

| ID | Type | Prompt / Action | Expect |
|----|------|-----------------|--------|
| **ELEC-1** | 🟢 | Import in main process | `require`/`import` the library in an Electron main entry | Loads with no DOM/native errors (Node built-ins + `fetch` only). |
| **ELEC-2** | 🔵 | Tab = session | main process maps each window to `createProjectSession`; forwards `subscribeAll` events over IPC | Renderer receives that tab's events; `session:run`/`abort`/`close` IPC handlers drive the right session. |

---

## Automated coverage matrix

The 🟢 deterministic behavior behind these cases is exercised by the offline suites (no network):

| Suite | Covers |
|-------|--------|
| `examples/smoke.mjs` | CHAIN-1/2 shape, PHASE, tool execution end-to-end |
| `examples/multi-session.mjs` | SESS-1..6, PERM-1/2, event routing, isolation |
| `examples/custom-phases.mjs` | CUST-1..6, REG-4/7 |
| `examples/project-presets.mjs` | PRE-1..6, MODEL-1 (per-phase), provider wiring |
| `examples/project-memory.mjs` | MEM-1..6, detection, the `project_memory` tool |

Run all: `npm test`.

## How to run a 🔵 / 🟣 case

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });
const { session } = await harness.createProjectSession({ cwd: "acme/apps/api" });

const stop = session.subscribe((e) => {
  if (e.type === "phase_start") console.log("▶", e.phase, e.model);
  if (e.type === "permission_request") console.log("?", e.request.name, e.request.complexity.score);
  if (e.type === "chain_end") console.log("done", e.success);
});

const result = await session.runChain("Add a POST /api/notes endpoint with validation and a Jest test.");
console.log(result.success, result.phases.perfect?.summary);
stop();
```

Pass criteria for a 🔵 case are the **invariants** in *Expect* (event order, files changed, `verified` flag, memory written) — not exact model wording.
