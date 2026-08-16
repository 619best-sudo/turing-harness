# Concepts & architecture

## Components

```
Harness  (session manager)      shared LLM bridge + defaults; mints Sessions
│  subscribeAll · createSession · closeSession · addSharedProvider
└── Session  (isolated unit — one per parallel run)
    ├── Registry                providers (mcp/skill/tool), 4P categorization
    ├── PermissionGate          ask-all | bypass | ask-mutations
    ├── LogStore                structured logs; feeds activity_monitor
    ├── cwd + abort scope
    └── Orchestrator            runs the loop; resolves per-phase/per-tool models
        └── runPhase()          an LLM-driven tool loop for one phase → PhaseResult
            prepare → plan → perform → perfect (verify → retry)

Shared (stateless): OpenRouterBridge (LLMBridge), model catalog, selection fns
Internal tools: bash/read/write/edit/ls/grep, project_memory,
                assets_generator, media_analysis, activity_monitor
```

Each `Session` owns its registry, log store, permission gate, orchestrator, working
directory, event stream, and abort scope — so any number of sessions run
concurrently with no shared mutable state. The `Harness` shares only the stateless
LLM bridge and read-only model catalog. See [Multi-session](./multi-session.md).

Every component is independently usable and injectable. You can construct a
`Harness`, call `createSession`, and use the session's high-level methods, or wire
`Registry` + `OpenRouterBridge` + `Orchestrator` yourself. The single-session
`Harness` methods proxy to a lazily created `"default"` session.

## The core loop

A single phase is an agentic tool loop driven by that phase's model:

```
buildContext(systemPrompt + task + prior summaries + refs)
repeat until the model stops calling tools (no step cap by default):
  assistant = llm.stream(phaseModel, context)      # the model reasons here
  if assistant has no tool calls: break            # final answer
  for each tool call:
     req = { name, mutates, complexity, refs, phase }
     decision = permissionGate.evaluate(req)        # allow? which model? author?
     if denied: append denied result; continue
     model = decision.model ?? selectModel(complexity, modalities) ?? phaseModel
     authorModel = (write/edit && decision.authorModel) ? resolve(...) : undefined
     result = tool.execute(id, args, { cwd, model, authorModel?, authoringContext?, llm, log, ... })
     usage += result.usage                          # fold in any in-tool LLM cost
     append tool result to context
→ PhaseResult { summary, artifacts, refs, verified?, complexity, usage, messages }
```

`runChain` composes four of these:

```
prepare (once) → plan (once) → [ perform → perfect ]×N
                                          └ if VERDICT: FAIL, feed FIX: back into perform
```

Prepare and Plan run once; Perform and Perfect loop. Perfect returns `verified: true|false`; on `false` its `FIX:` section becomes the next Perform's `feedback`. The loop stops when Perfect verifies or `maxChainIterations` is reached.

### Repairing a mangled tool call

Some providers delimit tool calls with sentinel tokens, and a mis-segmented
stream puts them in the `name` field — `read<|channel|>clipboard`,
`bash<|tool_call_begin|>…`. Before dispatch the loop checks for that framing, and
when the leading identifier names a **registered** tool *and* the `arguments`
field survived intact, it repairs the name and runs the call (logged under
`tools:framing-recovered`, naming what arrived).

Only the leading identifier is trusted and arguments are never reconstructed from
the mangled string, so a repair cannot change what the model asked for. When the
arguments did **not** survive, the call is refused with a message that says so —
it used to assert the arguments were empty for every framed call, including one
observed carrying a complete `{path, offset, limit}`, and the model spent three
turns re-issuing a call the harness could have run.

## The orchestrator invariant (req #7)

**The orchestrator never reasons over file contents and never writes or edits code.** Concretely, orchestrator/runner code:

- does **not** call the LLM to interpret file bytes or to produce edits;
- does **not** read/parse a file to decide what to change;
- only **shuttles messages** between the phase model and tools, applies the permission gate, and selects models.

All reasoning lives in the **phase model**; all IO and mutation live in **tools**. This keeps the control plane deterministic and auditable, and means swapping models or tools never changes orchestration behavior. See `orchestrator/phase-runner.ts` — it manipulates `Message[]` and events only.

## Data flow: references, not payloads (req #1 & #7)

Media (images, video, audio, generated assets) is carried between phases and tool calls as a **`MediaRef`** — an address (`uri`) plus a `summary` and `mimeType` — not as bytes. Bytes are read only when a specific step needs them (e.g. `media_analysis` reads image bytes at audit time; `attachmentToContent(att, /*inline*/ true)` inlines on demand).

Consequences:
- Tool-call payloads and inter-phase context stay small.
- Model selection can inspect required **modalities** from the refs without loading the media.
- A `PhaseResult.refs` array threads produced/consumed media forward through the chain.

## Model resolution order

For a **phase**: `permissionDecision.model` → runtime override (`orchestrator.setModel(phase, …)`) → `models[phase]` config → `models.orchestrator` → built-in default.

For a **tool call**: `permissionDecision.model` → `selectModel()` by complexity + required modalities (from `toolModelCandidates` or the built-in cheap→capable tiers) → the phase model.

"If no model is specified, the orchestrator runs it" — the phase/orchestrator model is always the final fallback.

## Result-processing model vs. authoring model (`model` vs `authorModel`)

Two **independent** permission-decision fields let a host swap in a second model (Model B), and they do different things. This is the read↔write asymmetry the host must understand:

- **`decision.model` — "B processes the result."** Re-pins the driver for the **next** phase-model turn — the one that ingests this call's tool result — for exactly one turn, then reverts to the phase model (Model A). Works for *every* tool. For `read`, this is effectively "Model B reads the file" (interpretation happens post-hoc). The tool itself still runs unchanged.

- **`decision.authorModel` — "B authors the bytes."** Honored only for **write/edit**. The requesting model (A) has *already* emitted its `content` / `oldString+newString` one full turn earlier — that draft is fixed by the time this decision is made. So Model B authors the on-disk bytes via an **internal LLM call inside the tool**, before `fs.writeFile`:
  - `write`: Model B authors the whole file from scratch; Model A's draft is discarded (kept only as `details.draft` for diagnostics).
  - `edit`: Model A's `oldString` anchor is preserved (an edit needs an anchor); Model B authors only the replacement `newString`.
  - The tool is given the task, the PLAN_JSON, and bounded surrounding file snippets (`toolCtx.authoringContext`), so it can author coherently.
  - There is **no silent fallback** to Model A's draft on authoring failure — if the authoring model returns empty or errors, the call surfaces `isError: true`. The contract is "B authors."
  - Model B's authoring tokens are folded into the chain `usage`/`cost` (via `ToolResult.usage`) so accounting stays honest.

This split keeps the orchestrator invariant intact: the runner still does no content reasoning — it only resolves the slug, assembles the bounded context, and accumulates usage. The authoring LLM call lives in the tool, exactly like `media_analysis` / `activity_monitor` already call `ctx.llm.complete(...)` internally.

## Complexity

Every phase/tool call gets a `Complexity { score: 0..1, signals }` from `estimateComplexity()`, blending tool breadth, context size, attachment weight, and whether the call mutates. It is passed to the permission callback (so a UI can decide what to ask about and which model to pin) and drives automatic model-tier selection.

## Registry & 4P categorization

Providers (`kind`: `tool` | `mcp` | `skill`; `source`: `internal` | `external`) hold `AgentTool[]`. Each tool is categorized into one or more phases:

- read-only discovery (`bash`, `ls`, `grep`, `read`) → **Prepare** + **Plan**
- mutations (`write`, `edit`, generation) → **Perform**
- verification (`playwright`, `screenshot`, `sqlite`, `test`, `audit`) → **Perfect**

Explicit `tool.phases` always wins over the heuristic. A phase's toolset is the union of tools categorized for it, unless you pin `phaseTools` in config.

## Events

Two layers, both pi-compatible:

- **`AssistantMessageEvent`** — token/tool streaming for one model turn (`start`, `text_delta`, `toolcall_*`, `done`, `error`).
- **`AgentEvent`** — orchestration lifecycle: pi's `agent_start`/`turn_*`/`message_*`/`tool_execution_*`/`agent_end`, plus 4P extensions `phase_start`/`phase_end`/`phase_summary`, `chain_start`/`chain_iteration`/`chain_end`, and `permission_request`/`permission_decision`. `phase_summary` is the lightweight end-of-phase signal for UI hosts — just `uiSummary` + the `handoff` object.

## Runtime portability

The core imports only Node built-ins (`node:child_process`, `node:fs/promises`, `node:path`, `node:crypto`, `node:util`) and global `fetch`. There is no DOM dependency, so it runs unchanged in an Electron main process. See the [Electron guide](./guides.md#electron).
