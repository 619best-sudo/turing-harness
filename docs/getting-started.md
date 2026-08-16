# Getting started

## Install & build

```bash
npm install
npm run build          # tsc → dist/
node examples/smoke.mjs   # offline end-to-end demo (fake model, no network)
```

- **Node** ≥ 18 (uses global `fetch` and the Web Streams API).
- The package is **ESM** (`"type": "module"`). Import with `import { Harness } from "@turing/harness"`.
- Live model calls need an OpenRouter API key. Set `OPENROUTER_API_KEY` or pass `apiKey` to the constructor.

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## Your first run

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({
  apiKey: process.env.OPENROUTER_API_KEY,
  cwd: process.cwd(),          // workspace the tools operate in
  permissionMode: "bypass",    // auto-allow while you experiment
});

const result = await harness.run("Create a CONTRIBUTING.md with a PR checklist.");

console.log("success:", result.success);
console.log("summary:", result.summary);     // honest end-of-run summary
console.log("steps:", result.steps.length);  // empty for a planless run
console.log("verified:", result.verified);   // undefined when the gate didn't run
```

`run` returns a [`RunLoopResult`](./api-reference.md): `success`, `summary`, `steps`, `planSet`, `refs`, `usage`, and `verified`. See [the loop driver](./loop.md) for how a run actually executes.

## Watching what happens

Subscribe to the event stream. `run` emits only the pi-compatible events a pi UI already renders (`agent_*`, `turn_*`, `message_*`, `tool_execution_*`, `permission_*`); the `phase_*` / `chain_*` events belong to the legacy chain and are namespaced so they can be ignored.

```ts
harness.subscribe((e) => {
  switch (e.type) {
    case "agent_start":        console.log("▶ run started"); break;
    case "message_update":     process.stdout.write(deltaText(e.assistantMessageEvent)); break;
    case "tool_execution_end": console.log(`  ✓ ${e.toolName}`); break;
    case "agent_end":          console.log("done"); break;
  }
});
```

## The legacy 4P entry points

`runChain` (Prepare → Plan → Perform → Perfect, with a Perfect→Perform retry) and `runPhase` still work and return a `ChainResult` / `PhaseResult`:

```ts
const briefing = await harness.runPhase("prepare", "Understand how auth works here.");
console.log(briefing.summary);   // starts with "SUMMARY: ..."
```

New code should call `run`. See [the 4P phases](./4p-phases.md).

## Using it as a pi-style Agent

```ts
const agent = harness.createAgent({ model: "anthropic/claude-opus-4.8" });

agent.subscribe(renderPiEvent);          // same AgentEvent shape pi UIs consume
await agent.prompt("Fix the failing login test");

console.log(agent.state.messages);       // AppMessage[]
console.log(agent.state.lastRunSummary); // the end-of-run summary
console.log(agent.state.lastVerified);   // did the verify gate pass?
```

By default (`mode: "chain"`, despite the legacy name) each `prompt` drives the flat `run` loop. To make a prompt run just one legacy 4P phase:

```ts
const planner = harness.createAgent({ mode: "plan" });
await planner.prompt("Plan the migration to Postgres.");
```

## Configuration cheat-sheet

```ts
new Harness({
  apiKey,                    // or OPENROUTER_API_KEY
  baseUrl,                   // any OpenAI-compatible endpoint (default OpenRouter)
  cwd,                       // workspace root for tools (default process.cwd())

  permissionMode: "ask-mutations",   // "ask-all" | "bypass" | "ask-mutations"
  permissionCallback: (req) => ({ allowed: true }),

  // Model role slots. Under `run`: perform = the work-loop driver, prepare = the
  // intent router / conversational reply, perfect = the run summary, plan unused.
  // `orchestrator` alone is enough — every slot falls back to it. See ./models.md.
  models: {
    orchestrator: "anthropic/claude-haiku-4.5",   // fallback for any slot/tool
    perform: "anthropic/claude-sonnet-4.5",
  },
  toolModelCandidates: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"],
  routeModel,                // escalation policy: (kind, rating, category, attachment) → slug
  visionModel: "google/gemini-2.5-flash",   // REQUIRED when the driver is text-only

  phaseTools: { perfect: [/* pin exact AgentTool[] */] },   // else resolved by 4P category
  maxSteps: { perform: 20 },        // OPTIONAL hard cap per phase; unset = run to completion
  reasoning: { plan: "high" },      // thinking level per phase
  temperature: { perform: 0.2 },
  maxChainIterations: 3,            // Perfect→Perform retries

  registerBuiltins: true,           // bundle bash/read/write/edit + the 3 internal tools
  assets: { backends: { image: myImageBackend } },
  mediaAnalysis: { model: "google/gemini-2.5-pro" },   // vision for `media_analysis`
  studyModel: "anthropic/claude-haiku-4.5",            // `activity_monitor`'s study action
});
```

Next: [Concepts & architecture](./architecture.md), then [complexity, category & models](./models.md) for how each of those model knobs is actually consulted.
