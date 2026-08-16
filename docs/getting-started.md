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

## Your first chain

```ts
import { Harness } from "@turing/harness";

const harness = new Harness({
  apiKey: process.env.OPENROUTER_API_KEY,
  cwd: process.cwd(),          // workspace the tools operate in
  permissionMode: "bypass",    // auto-allow while you experiment
});

const result = await harness.runChain("Create a CONTRIBUTING.md with a PR checklist.");

console.log("verified:", result.success);
console.log("iterations:", result.iterations);
console.log("changes:", result.phases.perform?.summary);
console.log("verdict:", result.phases.perfect?.summary);
```

`runChain` returns a [`ChainResult`](./api-reference.md#chainresult): `success`, `iterations`, per-phase [`PhaseResult`](./api-reference.md#phaseresult)s, accumulated `refs`, and total `usage`.

## Watching what happens

Subscribe to the event stream. It is a superset of pi's `AgentEvent` — the extra `phase_*`, `chain_*`, and `permission_*` events are namespaced so a pi UI can ignore them.

```ts
harness.subscribe((e) => {
  switch (e.type) {
    case "phase_start":        console.log(`▶ ${e.phase} (${e.model})`); break;
    case "message_update":     process.stdout.write(deltaText(e.assistantMessageEvent)); break;
    case "tool_execution_end": console.log(`  ✓ ${e.toolName}`); break;
    case "chain_end":          console.log(`done: success=${e.success}`); break;
  }
});
```

## Running a single phase

Any phase runs standalone and returns a `PhaseResult`:

```ts
const briefing = await harness.runPhase("prepare", "Understand how auth works here.");
console.log(briefing.summary);   // starts with "SUMMARY: ..."
```

## Using it as a pi-style Agent

```ts
const agent = harness.createAgent({ model: "anthropic/claude-opus-4.8" });

agent.subscribe(renderPiEvent);          // same AgentEvent shape pi UIs consume
await agent.prompt("Fix the failing login test");

console.log(agent.state.messages);       // AppMessage[]
console.log(agent.state.lastVerified);   // did the last chain verify?
```

By default the Agent runs the full chain per `prompt`. To make a prompt run just one phase:

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

  models: {                  // per-phase orchestrator models
    orchestrator: "anthropic/claude-haiku-4.5",   // fallback for any phase/tool
    prepare: "anthropic/claude-haiku-4.5",
    plan:    "anthropic/claude-opus-4.8",
    perform: "anthropic/claude-sonnet-4.5",
    perfect: "anthropic/claude-sonnet-4.5",
  },
  toolModelCandidates: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"],

  phaseTools: { perfect: [/* pin exact AgentTool[] */] },   // else resolved by 4P category
  maxSteps: { perform: 20 },        // OPTIONAL hard cap per phase; unset = run to completion
  reasoning: { plan: "high" },      // thinking level per phase
  temperature: { perform: 0.2 },
  maxChainIterations: 3,            // Perfect→Perform retries

  registerBuiltins: true,           // bundle bash/read/write/edit + the 3 internal tools
  assets: { backends: { image: myImageBackend } },
  auditor: { model: "google/gemini-2.5-pro" },
  studyModel: "anthropic/claude-haiku-4.5",
});
```

Next: [Concepts & architecture](./architecture.md).
