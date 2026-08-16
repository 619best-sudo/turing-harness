# turing-harness documentation

A coding-agent orchestration library built on the **4P model** — **Prepare → Plan → Perform → Perfect**. It is multimodal, OpenRouter-native, MCP/skills-aware, permission-gated, and structurally compatible with [`@mariozechner/pi`](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/). It runs in Node and in an Electron main process.

## Start here

| Doc | What it covers |
|-----|----------------|
| [Getting started](./getting-started.md) | Install, configure, run your first chain and Agent |
| [Multi-session (parallel runs)](./multi-session.md) | Run many isolated sessions concurrently in one process |
| [Concepts & architecture](./architecture.md) | How the pieces fit, data flow, the orchestrator invariant |
| [The 4P phases](./4p-phases.md) | Deep dive on each phase, the chain, and verify/retry |
| [Project presets](./project-presets.md) | Ready-made frontend / mobile / games / backend setups |
| [Project memory](./project-memory.md) | Durable per-project memory; auto-detects tech stack on first init |
| [File search](./file-search.md) | The memory-first search ladder: project → file → graph memory, shell only as a fallback |
| [Web, scraping & automation](./web-and-scraping.md) | Version-first debugging research, scraping/automation as first-class work, capturing a UI to rebuild |
| [Reading & changing code](./code-changes.md) | The complexity gate (low proceeds, medium/high escalate) and the six places edits break |
| [The plan tool](./plan-tool.md) | `create_plan`: per-file task breakdown, approval/revision, attachments, the isCompleted ledger |
| [Assets](./assets.md) | `assets_generator`: generate pixels, author vectors, and why an animated SVG is declined |
| [Inspiration](./inspiration.md) | `inspiration_generator`: section blueprints when there is no reference, and borrowing a layout without borrowing a brand |
| [Media analysis](./media-analysis.md) | `media_analysis`: OCR / UI / component / QA lenses, screenshotting a live page, and analysing before planning |
| [Tool coverage](./tool-coverage.md) | Which tools carry guidance, which are still bare, and how "defaults, not policy" works |
| [Asking the user](./asking-the-user.md) | `ask_user_question`: which decisions are theirs, which are yours, and how to ask in one click |
| [Debugging](./debugging.md) | `activity_*`: who runs the app, where to instrument, browser logs that survive, fix→prove→revert |
| [The QA sequence](./qa-sequence.md) | log → build → run → inspect → logs → decide; why QA belongs to the verify pass, reaching the right device, and the refusals that enforce it |
| [Shell execution](./shell-execution.md) | The environment commands run in, project-pinned toolchains (fvm/gradlew/.venv), and capturing a booted simulator with no MCP |
| [API reference](./api-reference.md) | Every exported class, function, and type |
| [Test plan](./test-plan.md) | Real-project, real-prompt test cases for every feature |
| [Guides & recipes](./guides.md) | Add an MCP server, custom asset backend, permission policies, per-phase models, logging, Electron |
| [pi migration](./pi-migration.md) | Mapping to `@mariozechner/pi-ai` / `pi-agent` and how to migrate |

## The one-minute version

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });

harness.subscribe((e) => console.log(e.type));       // pi-compatible event stream
const result = await harness.runChain("Add a /health endpoint with a test.");

console.log(result.success);                          // did Perfect verify?
console.log(result.phases.perfect?.summary);          // the verdict + evidence
```

- **`runChain(task)`** runs Prepare → Plan → Perform → Perfect. Perfect verifies the work; on failure it re-runs Perform with feedback until it passes or hits the iteration cap. One successful `runChain` = one completed operation.
- **`runPhase(phase, task)`** runs any single phase on its own.
- **`createAgent()`** returns a pi-`Agent`-shaped facade (`subscribe`, `prompt`, `state`) for UIs.

## Requirements mapping

The library was built to a specific 7-point spec; each maps to code as follows.

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Multimodal (file/image/video/audio) | `multimodal/attachment.ts`, content blocks in `types.ts` |
| 2 | pi-compatible call signature + response format | `types.ts`, `llm/bridge.ts`, `agent.ts` |
| 3 | MCP/skills registry with get/add/delete + 4P category | `registry/registry.ts`, `registry/categorize.ts`, `mcp/client.ts` |
| 4 | 4P chain; standalone phases; Perfect→Perform retry | `orchestrator/orchestrator.ts`, `orchestrator/phase-runner.ts` |
| 5 | Customizable per-phase & per-tool models over OpenRouter | `llm/openrouter.ts`, `llm/models.ts`, `orchestrator` model resolution |
| 6 | Internal tools: assets_generator, media_analysis, activity_monitor | `tools/builtin/*` |
| 7 | No orchestrator file-reasoning/writes; permission gate + model selection by complexity/attachments | `orchestrator/phase-runner.ts`, `orchestrator/permission.ts`, `llm/model-selector.ts` |

See [architecture](./architecture.md) for the full picture.
