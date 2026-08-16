# Multi-session (parallel runs)

A `Harness` is a **session manager**. Each `Session` is fully isolated, so a single process — for example one Electron app with several project tabs — can run many `runChain` / `runPhase` operations at the same time without cross-talk.

## What's isolated per session

| Per-session (isolated) | Shared (stateless / read-only) |
|------------------------|--------------------------------|
| `Registry` (built-ins + its own external MCP/skills) | `LLMBridge` (just does `fetch`) |
| `LogStore` (its own tagged log; its own `activity_monitor`) | Model catalog (`resolveModel`, `MODEL_CATALOG`) |
| `PermissionGate` (mode + callback) | Complexity / model-selection functions (pure) |
| `Orchestrator` + runtime per-slot model overrides | Asset backends / media-analysis config (stateless) |
| Working directory (`cwd`) | |
| Event stream (`subscribe`) | |
| Thread snapshot / follow-up context (`threadSnapshot`) | |
| Abort scope (`abort()` cancels only this session) | |

Two sessions share no mutable state, which is what makes concurrent runs safe.

## Creating and running sessions

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

const web = harness.createSession({
  id: "web",                       // optional; auto-generated if omitted
  cwd: "/repos/web-app",
  permissionMode: "ask-mutations",
  models: { perform: "anthropic/claude-sonnet-4.5" },
  metadata: { tabId: 1 },
});

const api = harness.createSession({
  cwd: "/repos/api",
  permissionMode: "bypass",
  models: { plan: "openai/gpt-5" },
});

// Run both at once — independent registries, logs, permissions, models.
const [webResult, apiResult] = await Promise.all([
  web.runChain("Add dark mode to settings."),
  api.runChain("Add a /health endpoint with a test."),
]);
```

## Manager API

| Method | Description |
|--------|-------------|
| `createSession(opts?)` | Mint an isolated `Session`; manager defaults apply, then `opts`. |
| `getSession(id)` | Look up a session. |
| `listSessions()` | `SessionInfo[]` — `{ id, cwd, createdAt, running, metadata }`. |
| `closeSession(id)` | Abort its in-flight runs, stop its MCP processes, remove it. |
| `subscribeAll(fn)` | `(sessionId, event) => void` — every session's events, tagged. |
| `addSharedProvider(input)` | Register a **stateless** provider into every session (current + future). |
| `dispose()` | Close all sessions. |

`SessionOptions` accepts everything `HarnessConfig` does for a single run (`cwd`, `permissionMode`, `permissionCallback`, `models`, `toolModelCandidates`, `phaseTools`, `maxSteps`, `reasoning`, `temperature`, `maxChainIterations`, `registerBuiltins`, `assets`, `mediaAnalysis`, `visionModel`, `routeModel`, `studyModel`) plus `id`, `providers`, and `metadata`.

## Session API

A `Session` exposes the same surface the single-session `Harness` used to:
`runChain`, `runPhase`, `subscribe`, `createAgent`, `listCapabilities`, `addProvider`, `removeProvider`, `addMcpServer`, `addSkill`, `toolsForPhase`, `setPermissionMode`, `setPermissionCallback`, `phaseTools`, `chainTool`, `clearThreadSnapshot()`, plus `abort()`, `isRunning`, `info()`, `dispose()`, and the fields `registry`, `logStore`, `permission`, `orchestrator`, `llm`, `threadSnapshot`.

```ts
const session = harness.createSession({ cwd });
const stop = session.subscribe((e) => renderTab(session.id, e));
const result = await session.runChain(task);
console.log(session.threadSnapshot); // last run's structured follow-up context
session.abort();                  // cancel everything in this session
await harness.closeSession(session.id);
```

`threadSnapshot` is session-scoped, so follow-up prompts only continue within that session/tab. Clearing or replacing one session's snapshot never affects another session.

## Cross-session monitoring

`subscribe` on a session gives that session's events. To watch all sessions from one place (e.g. a global activity view), use `subscribeAll` — it delivers the originating `sessionId` out-of-band so the `AgentEvent` shape stays pi-compatible:

```ts
harness.subscribeAll((sessionId, e) => {
  if (e.type === "chain_end") console.log(`[${sessionId}] done: ${e.success}`);
});
```

## Agents bind to a session

An `Agent` is bound to the session that created it, so a per-tab Agent stays isolated:

```ts
const agent = web.createAgent({ model: "anthropic/claude-opus-4.8" });
await agent.prompt("Fix the failing login test");
```

If the user sends a second prompt in the same tab, that Agent will automatically reuse `web.threadSnapshot` as structured follow-up context. A different session's Agent starts fresh unless it has its own prior run snapshot.

## Backward compatibility

The single-session methods on `Harness` still work — they proxy to a lazily created session with id `"default"`:

```ts
const harness = new Harness({ cwd, permissionMode: "bypass" });
await harness.runChain("...");    // runs on the default session
harness.listSessions();           // [{ id: "default", ... }]
harness.default;                  // the Session instance
```

Existing code needs no changes; adopt `createSession` when you want parallelism.

## Sharing capabilities across sessions

- **Stateless tools/skills** (plain `AgentTool[]`, no live resources): register once with `harness.addSharedProvider(...)` and every session gets them. The manager strips any `dispose` hook so closing one session can't tear down a shared capability.
- **Live resources (MCP servers)**: add them **per session** with `session.addMcpServer(...)`. Each session spawns and owns its own child process, and `closeSession` stops it. This keeps process lifecycles unambiguous; if you need one MCP shared by many sessions, run it as its own server and point each session's client at it.

## Electron pattern

Run the manager in the main process; map each renderer window/tab to a session.

```ts
// main.ts
const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

harness.subscribeAll((sessionId, e) =>
  windows.get(sessionId)?.webContents.send("harness:event", e));

ipcMain.handle("session:open", (_e, { cwd, tabId }) => harness.createSession({ cwd, metadata: { tabId } }).id);
ipcMain.handle("session:run",  (_e, { id, task }) => harness.getSession(id)?.runChain(task));
ipcMain.handle("session:abort", (_e, { id }) => harness.getSession(id)?.abort());
ipcMain.handle("session:close", (_e, { id }) => harness.closeSession(id));
```

See `examples/multi-session.mjs` for a runnable, offline demonstration of two sessions running in parallel with verified isolation.
