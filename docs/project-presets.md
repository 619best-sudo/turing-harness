# Project presets (frontend / mobile / games / backend)

Presets are ready-made 4P setups for common project types. Each wires the four phases with a sensible tool/MCP policy and per-phase model defaults, so you can go from zero to a category-appropriate agent in one call.

A preset is **declarative and offline-safe**:
- the **phase-tool policy** and **model defaults** apply synchronously (no processes spawned);
- the **MCP servers** are a *recommended catalog* that is spawned only when you opt in (`connectMcp: true`), tolerating any that aren't installed.

## Quick start

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

// Policy + models only (offline-safe) — no MCP servers spawned:
const web = harness.createSession({ preset: "frontend", cwd: "/repos/web" });

// Policy + models + spawn the recommended MCP servers (opt-in):
const { session, report } = await harness.createProjectSession("backend", {
  cwd: "/repos/api",
  connectMcp: true,
  dbUrl: process.env.DATABASE_URL,        // needed for the Postgres MCP
});
console.log(report); // { connected, skipped, failed, phaseTools, modelsSet }

// Or omit the category — it comes from the project's memory (auto-detected on
// first open):
const { session: s, memory } = await harness.createProjectSession({ cwd: "/repos/api" });
```

> `createProjectSession` also initializes/loads [project memory](./project-memory.md): on first open it detects the tech stack, persists it to `<cwd>/.turing/`, and uses the detected category to select the preset — so you don't have to pass the category every time.

## What each preset sets up

All categories keep the shared internal tools (`bash`, `read`, `write`, `edit`, `ls`, `grep`, `assets_generator`, `ui_screen_auditor`, `activity_monitor`) mapped across the phases, and add category MCPs:

### 🖥️ frontend
| Phase | Adds (MCP) |
|-------|-----------|
| Prepare | Context7 (docs) |
| Plan | Context7, Figma (design spec/tokens) |
| Perform | Figma |
| Perfect | Playwright (E2E + a11y), Chrome DevTools (console/network/perf) |

Models: Prepare haiku · Plan opus · Perform sonnet · Perfect sonnet.

### 📱 mobile
| Phase | Adds (MCP) |
|-------|-----------|
| Prepare / Plan | Context7 |
| Perfect | mobile-mcp (mobile-next: simulators/devices, screenshots, vision element-finding) |

Models: Prepare haiku · Plan opus · Perform sonnet · **Perfect gemini-2.5-pro** (vision for device screenshots).

### 🎮 games (Godot)
| Phase | Adds (MCP) |
|-------|-----------|
| Prepare / Plan | Godot MCP (scene / ClassDB introspection) |
| Perform | Godot MCP (scene mgmt, GDScript, asset import) + built-in `assets_generator` (sprites/audio/3d) |
| Perfect | Godot MCP (run project, screenshot capture, input injection, debug output) |

Models: Prepare haiku · Plan opus · Perform sonnet · **Perfect gemini-2.5-pro** (vision + video for playtest capture).

Godot MCP typically needs the editor + a bridge configured; override the launch command with `engineCommand: { command, args }`.

### ⚙️ backend
| Phase | Adds (MCP) |
|-------|-----------|
| Prepare / Plan | Context7, Postgres (schema introspection, read) |
| Perform | Postgres (scoped writes/migrations), Filesystem |
| Perfect | Postgres (verify data), plus `bash` for tests + `curl` API checks |

Models: Prepare haiku · Plan opus · Perform sonnet · Perfect sonnet.

## Recommended MCP servers

The exact servers in each preset (2026):

| id | server | phases | needs |
|----|--------|--------|-------|
| `context7` | Context7 (`@upstash/context7-mcp`) | prepare, plan | — |
| `figma` | Figma (`figma-developer-mcp`) | plan, perform | `env.FIGMA_API_KEY` |
| `playwright` | Playwright (`@playwright/mcp`) | perfect | — |
| `chrome-devtools` | Chrome DevTools (`chrome-devtools-mcp`) | perfect | — |
| `mobile` | mobile-mcp (`@mobilenext/mobile-mcp`) | perfect | simulator/device |
| `godot` | Godot MCP | all | editor + bridge |
| `postgres` | Postgres (`@modelcontextprotocol/server-postgres`) | all | `dbUrl` |
| `filesystem` | Filesystem (`@modelcontextprotocol/server-filesystem`) | prepare, perform | — |

Missing prerequisites are handled gracefully: a server requiring config you didn't supply is **skipped** (e.g. `postgres` without `dbUrl`), and a server that fails to spawn is **reported in `failed`** — neither throws.

## API

```ts
// Declarative catalog + policy:
import { PROJECT_PRESETS, presetPolicy, applyProjectPreset } from "@turing/harness";

PROJECT_PRESETS.frontend;          // { category, description, phaseTools, mcp, models }
presetPolicy("backend");           // { phaseTools, models } — the offline-safe policy

// Apply to an existing session (policy always; MCP on opt-in):
const report = await applyProjectPreset(session, "frontend", {
  connectMcp: true,
  env: { FIGMA_API_KEY: "..." },   // enables the Figma MCP
  include: ["playwright"],         // only connect these
});
```

`applyProjectPreset(session, category, opts)` options: `connectMcp`, `applyPolicy` (default true), `setModels` (default true), `include`/`exclude` (server ids), and the context (`cwd`, `env`, `dbUrl`, `filesystemDir`, `engineCommand`). Returns `{ category, phaseTools, modelsSet, connected, skipped, failed }`.

## Customizing a preset

Presets are just a starting point — everything stays [customizable](./4p-phases.md#customizing-the-fixed-per-phase-toolset):

```ts
// Start from a preset, then override per phase (explicit wins over the preset):
const s = harness.createSession({
  preset: "frontend",
  phaseTools: { perfect: { fromCategory: true, include: ["my_visual_diff"], exclude: ["chrome-devtools"] } },
  models: { plan: "openai/gpt-5" },
});

// Or adjust at runtime:
s.setProviderPhases("playwright", ["perform", "perfect"]);
s.setPhaseTools("perfect", { fromCategory: true, providers: ["playwright"] });
```

Because presets apply per session, one Electron app can run a `frontend` tab and a `backend` tab side by side, each with its own 4P policy and models. See [Multi-session](./multi-session.md).

See `examples/project-presets.mjs` for a runnable, offline verification of all four presets.
