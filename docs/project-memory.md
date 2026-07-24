# Project memory

Every project gets a durable, project-scoped memory. **The first time a project directory is opened, the harness detects its tech stack** — website (frontend), mobile, game, or backend — and writes a memory to `<cwd>/.turing/`. On later opens the memory is loaded, and its category selects the 4P [preset](./project-presets.md), so you don't pass the category every time.

Memory is different from the [`LogStore`](./api-reference.md#logstore): memory is **durable, project-scoped knowledge**; the log store is ephemeral, session-scoped activity.

## How it works

```ts
import { Harness } from "@turing/harness";
const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

// First open of /repos/api: detects stack, writes .turing/, picks the "backend" preset.
const { session, memory } = await harness.createProjectSession({ cwd: "/repos/api" });
console.log(memory.category);          // "backend"  (auto-detected & persisted)
console.log(memory.stack);             // { languages: ["typescript"], frameworks: ["express"], ... }

// Next time — same or a new process — the category comes from memory, no re-detection.
const again = await harness.createProjectSession({ cwd: "/repos/api" });
```

You can still pass a category explicitly; it overrides and persists:

```ts
const { memory } = await harness.createProjectSession("frontend", { cwd: "/repos/thing" });
// memory.category === "frontend", detection.auto === false
```

`createProjectSession` accepts an explicit category **or** an options object (auto-detect):

```ts
createProjectSession("backend", { connectMcp: true, dbUrl })   // explicit
createProjectSession({ cwd, connectMcp: true })                // category from memory
```

## What's stored

`<cwd>/.turing/project.json` (source of truth) + `<cwd>/.turing/MEMORY.md` (human/LLM-readable):

```jsonc
{
  "version": 1,
  "category": "frontend",              // website / mobile / games / backend
  "stack": {
    "languages": ["typescript"],
    "frameworks": ["next", "react"],
    "packageManager": "pnpm",
    "engine": null,                    // "godot" | "unity" | "unreal" for games
    "runtime": ["node"]
  },
  "detection": { "evidence": ["frontend framework: next, react"], "confidence": 0.85, "auto": true },
  "facts": [ { "id": "…", "text": "tests run via `pnpm test`", "tags": ["build"], "createdAt": 0 } ],
  "metadata": {}
}
```

File memory is stored alongside it:

- `<cwd>/.turing/files.json` — structured per-file index (summary, keywords, tags, role, freshness metadata, summary source/state)
- `<cwd>/.turing/FILES_MEMORY.md` — low-token human/LLM-readable file summaries
- `<cwd>/.turing/graph.json` — structured file/symbol dependency graph index
- `<cwd>/.turing/GRAPH_MEMORY.md` — low-token human/LLM-readable graph summary

## Detection

`detectProject(cwd)` reads manifests/engine files and returns `{ category, stack, evidence, confidence }`. Signals (highest first):

- **games** — `project.godot`, `*.uproject`, Unity `Assets/` + `ProjectSettings/`, or `phaser`/`bevy`.
- **mobile** — Flutter `pubspec.yaml`, `react-native`/`expo`, Ionic/Capacitor, native `android/`+`ios/`.
- **frontend** — `next`/`react`/`vue`/`svelte`/`angular`/`astro`/`vite`, or `index.html` without backend signals.
- **backend** — `express`/`fastify`/`nest`, Python `django`/`flask`/`fastapi`, `go.mod`, Rails, Spring, Dockerfile.

Detection is best-effort with a confidence score; the category can always be corrected (`memory.setCategory(...)`, an explicit arg, or the `project_memory` tool).

### Expanded ecosystem support

Project detection now explicitly recognizes a broad combined matrix of languages/frameworks/platforms, including representative support for:

- Languages: `javascript`, `typescript`, `python`, `go`, `rust`, `java`, `kotlin`, `ruby`, `dart`, `php`, `csharp`, `swift`, `scala`, `elixir`, `clojure`, `haskell`, `lua`, `perl`, `r`, `zig`
- Frontend/web: `react`, `next`, `vue`, `nuxt`, `svelte`, `angular`, `astro`, `vite`, `solid-js`, `gatsby`, `remix`, `qwik`
- Backend: `express`, `fastify`, `nestjs`, `koa`, `django`, `flask`, `fastapi`, `spring`, `micronaut`, `quarkus`, `ktor`, `laravel`, `symfony`, `rails`, `sinatra`, `phoenix`, `aspnet`
- Mobile: `flutter`, `expo`, `react-native`, `ionic/capacitor`
- Games: `godot`, `unity`, `unreal`, `phaser`, `bevy`

Signals are still heuristic and manifest-based rather than perfect language parsing. “Supported” means the detector intentionally matches common project files, manifests, lockfiles, dependencies, or engine markers for those ecosystems.

## Learned facts

Memory accumulates durable facts across runs — the agent records them via the `project_memory` tool, or you can add them directly:

```ts
await memory.remember("API base path is /v1", { tags: ["api"] });
memory.recall({ tag: "api" });         // [{ text: "API base path is /v1", ... }]
```

## The `project_memory` tool

When a session has memory, the agent gets a `project_memory` tool (available in all phases). It lets Prepare read the stack instead of re-discovering it, and any phase record a durable fact:

- `get` — full memory (category, stack, facts)
- `remember` — append a fact (`text`, `tags`)
- `recall` — filter facts by tag/substring
- `set_category` — correct the category

## File memory & one-shot search

When project memory is enabled, the session also creates and loads a durable file-memory index. It is built on first `createProjectSession(...)`, then reloaded on later opens. The index stores a concise per-file summary, keywords, and freshness metadata so the agent can find the right file in one call instead of re-scanning the repo manually.

File memory now has two layers:

- a synchronous heuristic/bootstrap pass that runs during `FileMemory.open(...)`
- a background LLM hydration pass that starts after `createProjectSession(...)` returns

The LLM hydration runs in parallel with bounded concurrency, upgrades heuristic summaries to richer summaries, and writes:

- one <=100-word summary covering both business and technical aspects
- comma-style searchable keywords (stored as `string[]` in JSON)
- summary metadata such as source, model, version, pending/error state

When watcher support is enabled, the harness now creates a **project-level watcher** per `cwd` and shares it across all open sessions for that same project. When watched files change, the watcher:

- refreshes `file_memory` metadata immediately
- marks changed file summaries as pending
- re-hydrates semantic/LLM summaries in the background
- refreshes `graph_memory` so file/symbol queries stay current without reopening the project

The watcher is reference-counted at the harness level and is released automatically when the last session for that project is disposed.

The agent gets a `file_memory` tool with these actions:

- `search` — rank matching files in one call from a natural-language or keyword query
- `get` — return one indexed file entry
- `refresh` — refresh one or more file entries after changes
- `stats` — inspect index size and stale-count

Example:

```ts
const { session, fileMemory } = await harness.createProjectSession({ cwd: "/repos/api" });
console.log(fileMemory.stats()); // { totalFiles, staleFiles, ... }

const fileTool = session.toolsForPhase("prepare").find((tool) => tool.name === "file_memory");
await fileTool.execute("id", { action: "search", query: "health endpoint route" }, {
  cwd: "/repos/api",
  log: () => {},
  llm: harness.llm,
});
```

Staleness and hydration rules:

- files are fresh when size/mtime still match the indexed entry
- files become stale when the filesystem changes or the entry is refreshed after a mutation
- changed files fall back to heuristic summaries immediately and are re-hydrated by the background runtime
- stale entries can be refreshed explicitly with `file_memory.refresh`, or on the next project-session load

File-memory heuristics are now more ecosystem-aware for common non-JS stacks too. It tags and summarizes representative manifests and entry/config files such as:

- `composer.json`, `artisan`, `routes/web.php`
- `*.csproj`, `Program.cs`, `Startup.cs`
- `Package.swift`
- `mix.exs`
- `build.sbt`
- `deps.edn`, `project.clj`
- `stack.yaml`, `*.cabal`
- `go.mod`, `Cargo.toml`, `Gemfile`, `pubspec.yaml`, `build.zig`, `DESCRIPTION`, `cpanfile`

## Graph memory, dependency queries, and blast radius

When project memory is enabled, the session also creates and loads durable graph memory. This is a separate layer from file memory:

- `file_memory` answers “which file likely contains this?”
- `graph_memory` answers “what depends on this file?”, “who calls this symbol?”, and “what is the blast radius?”

The graph store is persisted under:

- `<cwd>/.turing/graph.json`
- `<cwd>/.turing/GRAPH_MEMORY.md`

The first implementation is parser-backed for TypeScript/JavaScript and stores:

- file graph nodes
- symbol graph nodes
- dependency edges such as `imports`, `exports`, `defines`, `references`, `calls`, `extends`, `implements`, `contains`

The agent gets a `graph_memory` tool with these actions:

- `stats`
- `refresh`
- `file_deps`
- `symbol_deps`
- `blast_radius`
- `get_file_node`
- `get_symbol_node`
- `find_symbol`

Graph-memory support is tiered across the broader ecosystem matrix:

- **Exact:** `typescript`, `javascript`
- **Partial symbol + file graph:** `python`, `php`, `ruby`, `go`, `rust`, `java`, `kotlin`, `scala`, `csharp`, `dart`, `swift`, `elixir`, `clojure`
- **File graph + framework conventions:** `haskell`, `lua`, `perl`, `r`, `zig`, plus framework/engine overlays for `next`, `nuxt`, `react`, `vue`, `svelte`, `angular`, `astro`, `vite`, `gatsby`, `remix`, `qwik`, `express`, `fastify`, `nestjs`, `koa`, `django`, `flask`, `fastapi`, `spring`, `micronaut`, `quarkus`, `ktor`, `laravel`, `symfony`, `rails`, `sinatra`, `phoenix`, `aspnet`, `flutter`, `expo`, `react-native`, `ionic/capacitor`, `godot`, `unity`, `unreal`, `phaser`, `bevy`

Tool responses now include capability-aware results so the agent can distinguish:

- exact parser-derived graph edges
- partial symbol graphs
- framework-convention/file-only graph answers

Typical usage pattern:

1. use `file_memory.search` to find the candidate file quickly
2. use `graph_memory.file_deps` or `graph_memory.symbol_deps` to inspect direct dependencies
3. use `graph_memory.blast_radius` to estimate direct and transitive impact before editing

Graph results are freshness-aware. With the project watcher enabled, changed files are revalidated automatically while the session is alive; without the watcher, they become stale until the graph is refreshed explicitly or the project session is reopened and revalidated.

## App integration lifecycle

For an app shell such as Electron or a multi-tab IDE host, the recommended integration pattern is:

1. create a `Harness` once for the app process
2. call `createProjectSession({ cwd })` as soon as the user opens/selects a project
3. keep the returned `session`, `memory`, `fileMemory`, and `graphMemory` attached to that tab/project state
4. dispose that session when the tab/project closes

### Initialization

On first open:

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const project = await harness.createProjectSession({
  cwd: "/repos/api",
  connectMcp: false,
});

const { session, memory, fileMemory, graphMemory, fileMemoryRuntime } = project;
```

What happens during that call:

- `ProjectMemory.open(...)` initializes or loads `<cwd>/.turing/project.json`
- `FileMemory.open(...)` initializes or loads `<cwd>/.turing/files.json`
- `GraphMemory.open(...)` initializes or loads `<cwd>/.turing/graph.json`
- the session gets `project_memory`, `file_memory`, and `graph_memory` tools
- `FileMemoryRuntime.startInitialHydration()` begins background summary upgrades after the session is returned
- if watching is enabled, the harness subscribes that session to a shared project watcher for the same `cwd`

On later opens of the same project:

- project/category detection is reused from `.turing/project.json`
- `file_memory` and `graph_memory` are loaded from disk
- if another session for the same `cwd` is already open, the new session joins the same watcher instead of creating another filesystem watcher

### Automatic refresh

By default, refresh happens automatically while the session is alive:

- editing a project file triggers the shared project watcher
- `file_memory` updates the file entry immediately with fresh metadata and heuristic semantic fields
- if LLM sync is enabled, the changed file is queued for background summary regeneration
- `graph_memory` is debounced and refreshed automatically so dependency and blast-radius queries stay current

This means the app usually does **not** need to manually refresh memory after ordinary file edits.

### Manual refresh controls

You may still want explicit refresh controls in the app for these cases:

- force a full LLM summary sync for the whole project
- refresh after importing/generated files were added while watching was disabled
- recover after a watcher failure or if the app intentionally runs with watch off

Examples:

```ts
// Full project summary upgrade / re-upgrade.
await project.fileMemoryRuntime?.refreshAllSummaries();

// Re-run stack detection even if memory already exists.
const reDetected = await harness.createProjectSession({
  cwd: "/repos/api",
  detect: true,
});
```

Tool-driven refresh from the app is also valid:

```ts
const fileTool = project.session.toolsForPhase("prepare").find((tool) => tool.name === "file_memory");
await fileTool?.execute("refresh-files", {
  action: "refresh",
  paths: ["/repos/api/src/search.ts"],
}, {
  cwd: "/repos/api",
  log: () => {},
  llm: harness.llm,
});

const graphTool = project.session.toolsForPhase("prepare").find((tool) => tool.name === "graph_memory");
await graphTool?.execute("refresh-graph", {
  action: "refresh",
  path: "/repos/api/src/search.ts",
}, {
  cwd: "/repos/api",
  log: () => {},
  llm: harness.llm,
});
```

### Tuning options

`createProjectSession({ fileMemoryRuntime: ... })` supports a few useful knobs for app integration:

- `watch: false` disables automatic project watching
- `autoStartHydration: false` skips immediate background LLM hydration after initialization
- `llmSyncEnabled: false` keeps file summaries heuristic-only until `refreshAllSummaries()` is called

Example:

```ts
const project = await harness.createProjectSession({
  cwd: "/repos/api",
  fileMemoryRuntime: {
    watch: true,
    autoStartHydration: false,
    llmSyncEnabled: false,
  },
});
```

### App responsibilities

The app should:

- create the project session early, ideally on project selection/open
- retain the returned session + memory handles in project state
- surface memory state from `memory`, `fileMemory.stats()`, `graphMemory.stats()`, and `fileMemoryRuntime?.getStatus()`
- provide an optional manual "Refresh Memory" action that calls `refreshAllSummaries()`
- dispose the session when the project/tab closes

The app does **not** need to:

- poll the filesystem itself for memory refresh
- manually refresh `graph_memory` after each save
- reopen the project just to keep file and graph memory current

## API

```ts
import { ProjectMemory, detectProject } from "@turing/harness";

const memory = await ProjectMemory.open(cwd, { dir: ".turing", forceDetect: false });
memory.wasCreated;                     // true on first init
memory.category; memory.stack; memory.data;
await memory.remember(text, { tags });
memory.recall({ tag, text });
await memory.setCategory("mobile");
await memory.set("deployTarget", "fly.io");
```

`createProjectSession` options relevant to memory: `memory` (default true — set `false` to skip `.turing/`), `memoryDir` (default `.turing`), `detect` (re-run detection even if memory exists). The result is `{ session, report, memory, fileMemory, graphMemory }`, and the memories are also attached as `session.memory`, `session.fileMemory`, and `session.graphMemory`.

Because memory is keyed by directory and applied per session, a multi-tab app opens each project once, remembers its stack, and reuses it — see [Multi-session](./multi-session.md).
