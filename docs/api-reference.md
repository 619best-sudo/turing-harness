# API reference

Everything below is exported from the package root (`@turing/harness`). Types are also available from `@turing/harness/types`.

- [Harness](#harness)
- [Session](#session)
- [HarnessAgent](#harnessagent)
- [Orchestrator](#orchestrator)
- [Registry](#registry)
- [PermissionGate](#permissiongate)
- [LogStore](#logstore)
- [LLM layer](#llm-layer)
- [Model selection](#model-selection)
- [MCP client](#mcp-client)
- [Multimodal helpers](#multimodal-helpers)
- [Built-in tools](#built-in-tools)
- [Core types](#core-types)

---

## Harness

The top-level **session manager**. Holds the shared (stateless) LLM bridge and the default configuration for new sessions, mints isolated [`Session`](#session)s, and exposes a backward-compatible single-session API that proxies to a lazily created `"default"` session. See [Multi-session](./multi-session.md).

```ts
new Harness(config?: HarnessConfig)
```

### Session-manager methods

| Method | Returns | Description |
|--------|---------|-------------|
| `createSession(opts?)` | `Session` | Mint an isolated session; manager defaults apply, then `opts`. Pass `preset` for a category setup. |
| `createProjectSession(category, opts?)` | `Promise<{ session, report }>` | Session pre-wired for `"frontend"\|"mobile"\|"games"\|"backend"`; policy+models sync, MCP on `connectMcp`. |
| `getSession(id)` | `Session \| undefined` | |
| `listSessions()` | `SessionInfo[]` | `{ id, cwd, createdAt, running, metadata }`. |
| `closeSession(id)` | `Promise<void>` | Abort in-flight runs, stop MCP processes, remove. |
| `subscribeAll(fn)` | `() => void` | `(sessionId, event) => void` — all sessions' events, tagged. |
| `addSharedProvider(input)` | `void` | Register a stateless provider into every session. |
| `dispose()` | `Promise<void>` | Close all sessions. |
| `default` (getter) | `Session` | The lazily created default session. |

### Single-session proxy (backward compatible)

The following delegate to `harness.default`: `runChain`, `runPhase`, `subscribe`, `listCapabilities`, `addProvider`, `removeProvider`, `addMcpServer`, `addSkill`, `toolsForPhase`, `setPhaseTools`, `setToolPhases`, `setProviderPhases`, `setPermissionMode`, `setPermissionCallback`, `phaseTools`, `chainTool`, `createAgent`, and the getters `registry`, `logStore`, `permission`, `orchestrator`. `llm` is the shared bridge. `HarnessConfig` also accepts `categorizer` (default categorization for new sessions).

### `HarnessConfig`

Extends the orchestrator options (`models`, `toolModelCandidates`, `phaseTools`, `maxSteps`, `reasoning`, `temperature`, `maxChainIterations`, `cwd`, `signal`) plus:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `apiKey` | `string` | `OPENROUTER_API_KEY` | OpenRouter key |
| `baseUrl` | `string` | OpenRouter v1 | Any OpenAI-compatible endpoint |
| `llm` | `LLMBridge` | `OpenRouterBridge` | Inject a custom bridge (e.g. a fake for tests) |
| `permissionMode` | `PermissionMode` | `"ask-mutations"` | |
| `permissionCallback` | `PermissionCallback` | — | |
| `registerBuiltins` | `boolean` | `true` | Bundle coding tools + the 3 internal tools |
| `assets` | `AssetsGeneratorConfig` | — | Backends for `assets_generator` |
| `mediaAnalysis` | `MediaAnalysisConfig` | — | Multimodal model (and optional backend) for `media_analysis` |
| `studyModel` | `string` | haiku | Model for `activity_study` |

`dispose()` on the Harness closes every session. `HarnessConfig` fields also serve as per-session defaults, overridable in `createSession(opts)`.

---

## Session

An isolated, independently-runnable unit. Created with `harness.createSession(opts?)`. Owns its own registry, log store, permission gate, orchestrator, `cwd`, event stream, and abort scope, so sessions run in parallel with no shared mutable state.

### `SessionOptions`

Everything in `HarnessConfig` (except `apiKey`/`baseUrl`/`llm`, which are manager-level) plus:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Stable id; auto-generated if omitted |
| `providers` | `ProviderInput[]` | Extra providers registered at creation |
| `categorizer` | `ToolCategorizer` | Custom 4P categorization for this session's registry |
| `metadata` | `Record<string, unknown>` | Freeform (project path, tab id, ...) |

`phaseTools` here (and in `HarnessConfig`) is `Partial<Record<Phase, PhaseToolSpec>>` — see [Phase toolset customization types](#phase-toolset-customization-types).

### Fields

`id`, `cwd`, `createdAt`, `metadata`, `registry: Registry`, `logStore: LogStore`, `permission: PermissionGate`, `orchestrator: Orchestrator`, `llm: LLMBridge`, `threadSnapshot?: ThreadRunSnapshot`.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `run(task, opts?)` | `Promise<RunLoopResult>` | **Primary entry point.** Flat loop driver: optional plan → one sub-loop per step → run summary. See [loop.md](./loop.md). |
| `runChain(task, opts?)` | `Promise<ChainResult>` | Legacy: run the full 4P chain (run-scoped abort). Back-compat shim. |
| `runPhase(phase, task, opts?)` | `Promise<PhaseResult>` | Legacy: run one phase standalone. |
| `abort()` | `void` | Cancel every in-flight run in this session. |
| `get isRunning` | `boolean` | True while a run is in flight. |
| `subscribe(fn)` | `() => void` | This session's `AgentEvent` stream. |
| `createAgent(opts?)` | `HarnessAgent` | pi-style Agent bound to this session. |
| `get threadSnapshot` | `ThreadRunSnapshot \| undefined` | Last run snapshot for structured follow-up continuation in this session. |
| `clearThreadSnapshot()` | `void` | Drop the stored follow-up context so the next run starts fresh. |
| `listCapabilities(filter?)` | `ProviderListItem[]` | **get list** for this session. |
| `addProvider` / `removeProvider` / `addMcpServer` / `addSkill` | | Registry mutations (per session). |
| `toolsForPhase(phase)` | `AgentTool[]` | The (customized) fixed toolset for a phase. |
| `setPhaseTools(phase, spec?)` | `void` | Set/clear a phase's toolset live (`AgentTool[]` / filter / resolver). |
| `setToolPhases(name, phases)` | `boolean` | Move one tool between phases. |
| `setProviderPhases(id, phases)` | `boolean` | Move a whole provider/MCP between phases. |
| `setPermissionMode` / `setPermissionCallback` | `void` | Per-session permission policy. |
| `phaseTools()` / `chainTool()` | | Meta-tools. |
| `info()` | `SessionInfo` | |
| `dispose()` | `Promise<void>` | Abort + release resources (MCP processes). |

### `SessionInfo`

`{ id: string; cwd: string; createdAt: number; running: boolean; metadata?: Record<string, unknown> }`

---

## HarnessAgent

pi-`Agent`-compatible facade. Created via `harness.createAgent(opts?)`.

### `HarnessAgentOptions`

| Field | Type | Default |
|-------|------|---------|
| `systemPrompt` | `string` | `""` |
| `model` | `string` | `"anthropic/claude-opus-4.8"` |
| `thinkingLevel` | `ThinkingLevel` | `"medium"` |
| `mode` | `"chain" \| Phase` | `"chain"` |

### `HarnessAgentState`

`{ systemPrompt, model, thinkingLevel, messages: AppMessage[], isStreaming, streamMessage, error?, lastVerified?, pendingUserQuestion?, lastPhaseResults?, lastThreadSnapshot? }`.

### Methods

`get state`, `subscribe(fn)`, `setSystemPrompt(v)`, `setModel(slug)`, `setPhaseModel(phase, slug?)`, `setThinkingLevel(l)`, `clearMessages()`, `abort()`, `reset()`, `waitForIdle()`, `prompt(input, attachments?)`, `dispose()`.

`prompt(input, attachments?)` appends the user message (attachments carried by reference), runs the chain (or the configured single phase), and resolves when done, emitting `agent_start` … `agent_end`. After a completed run, the next prompt in the same session automatically receives structured follow-up context from `lastThreadSnapshot` unless you call `reset()` (or `session.clearThreadSnapshot()`).

---

## Orchestrator

Runs the work. The primary entry point is `run` (the flat loop driver; see
[loop.md](./loop.md)). `runChain`/`runPhase` remain as legacy 4P back-compat
shims. Never reasons over file contents; never writes/edits code.

```ts
new Orchestrator(config?: OrchestratorConfig)
```

### `OrchestratorConfig`

| Field | Type | Notes |
|-------|------|-------|
| `cwd` | `string` | Workspace root |
| `llm` | `LLMBridge` | |
| `registry` | `Registry` | |
| `logStore` | `LogStore` | |
| `permission` | `PermissionGate` | |
| `models` | `PhaseModelConfig` | `{ orchestrator?, prepare?, plan?, perform?, perfect? }` slugs |
| `toolModelCandidates` | `string[]` | Slugs the selector may pick from for tool calls |
| `phaseTools` | `Partial<Record<Phase, AgentTool[]>>` | Pin exact toolsets |
| `maxSteps` | `Partial<Record<Phase, number>>` | Optional per-phase tool-loop cap. Unset by default — a phase runs to completion, bounded by stall detection |
| `reasoning` | `Partial<Record<Phase, ThinkingLevel>>` | |
| `temperature` | `Partial<Record<Phase, number>>` | |
| `maxChainIterations` | `number` | Perfect→Perform retries (default 3) |
| `signal` | `AbortSignal` | |

### Methods

| Method | Description |
|--------|-------------|
| `subscribe(fn)` | Event stream. |
| `resolvePhaseTools(phase)` | The tools for a phase (config or registry category). |
| `setModel(target, slug?)` | Runtime model override; `target` is a `Phase` or `"orchestrator"`. Pass `undefined` to clear. |
| `runPhase(phase, task, opts?)` | Applies the phase-level permission gate, resolves the model, runs the phase. |
| `runChain(task, opts?)` | The 4P chain with verify/retry. |
| `phaseTools()` / `chainTool()` | Meta-tools. |

### `RunPhaseOptions`

`{ priorSummaries?, priorRefs?, feedback?, tools?, signal?, followUpContext? }`.

### `ChainResult`

```ts
interface ChainResult {
  success: boolean;
  iterations: number;
  phases: {
    prepare?: PhaseResult; plan?: PhaseResult;
    perform?: PhaseResult; perfect?: PhaseResult;
    history: PhaseResult[];   // every phase run, in order
  };
  refs: MediaRef[];
  usage: Usage;
  route?: "conversational" | "task";
  pendingUserQuestion?: AskUserQuestionRequest;
  threadSnapshot?: ThreadRunSnapshot;
}
```

### `ThreadRunSnapshot`

```ts
interface ThreadRunSnapshot {
  timestamp: number;
  task: string;
  route: "conversational" | "task";
  disposition: "completed" | "pending_user_question" | "aborted" | "failed";
  recommendedFollowUpMode: "fresh" | "structured_continue";
  summary: string;
  phaseSummaries?: Array<{
    phase: Phase;
    summary: string;
    displaySummary?: string;
    verified?: boolean;
    error?: string;
  }>;
  planSummary?: string;
  planJson?: unknown[];
  discoveredPaths?: string[];
  readPaths?: string[];
  writtenPaths?: string[];
  relevantFiles?: PrepareRelevantFile[];
  verified?: boolean;
  pendingUserQuestion?: AskUserQuestionRequest;
  error?: string;
}
```

`ThreadRunSnapshot` is the host-facing contract for follow-up continuation. It describes the last run in a session and is what later prompts use instead of replaying the raw transcript/tool history back into the next model call.

### `runPhase(input: PhaseRunInput)` (free function)

The low-level phase loop, if you want to drive a phase without the orchestrator. `PhaseRunInput` carries the resolved `model`, `tools`, `llm`, `permission`, `logStore`, `emit`, `cwd`, and phase context. Returns a `PhaseResult`.

---

## Registry

Holds capability providers and resolves them per phase.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `add(input: ProviderInput)` | `ProviderListItem` | Register/replace a provider; categorizes tools and synthesizes a description if none given. Throws on duplicate tool names. |
| `remove(id)` | `Promise<boolean>` | Deregister; calls the provider's `dispose()`. |
| `list(filter?)` | `ProviderListItem[]` | Filter by `{ source, kind, phase }`. |
| `get(id)` | `ProviderListItem \| undefined` | |
| `getToolsForPhase(phase)` | `AgentTool[]` | Executable tools for a phase (by category). |
| `selectPhaseTools(phase, spec?)` | `AgentTool[]` | Resolve a phase's toolset from a `PhaseToolSpec` (list / filter / resolver). |
| `setToolPhases(name, phases)` | `boolean` | Reassign one tool's phases at runtime. |
| `setProviderPhases(id, phases)` | `boolean` | Reassign a whole provider's phases at runtime. |
| `getTool(name)` | `AgentTool \| undefined` | |
| `allTools()` | `AgentTool[]` | |
| `phaseMap()` | `Record<Phase, tools[]>` | Phase → tool defs. |
| `subscribe(fn)` | `() => void` | `added`/`removed`/`changed` events. |
| `dispose()` | `Promise<void>` | Remove all providers. |

Constructor: `new Registry(opts?: { categorizer?: ToolCategorizer })`. `ToolCategorizer = (tool, defaultPhases) => Phase[]` customizes 4P categorization.

### Phase toolset customization types

```ts
type PhaseToolSpec = AgentTool[] | PhaseToolFilter | PhaseToolResolver;
type PhaseToolResolver = (registry: Registry, phase: Phase) => AgentTool[];
interface PhaseToolFilter {
  fromCategory?: boolean;   // start from the 4P category (default true)
  include?: string[];       // tool names to add
  exclude?: string[];       // tool names to remove
  providers?: string[];     // include all tools from these provider ids
  kinds?: ProviderKind[];   // restrict to these kinds
  sources?: ProviderSource[]; // restrict to these sources
}
```

### `ProviderInput`

```ts
interface ProviderInput {
  id: string;
  kind: "tool" | "mcp" | "skill";
  source: "internal" | "external";
  name: string;
  description?: string;            // else synthesized from the tools
  tools: AgentTool[];
  phases?: Phase[];                // else inferred by categorizeProvider()
  dispose?: () => void | Promise<void>;
  metadata?: Record<string, unknown>;
}
```

### `ProviderListItem`

```ts
interface ProviderListItem {
  id; kind; source; name;
  description: string;             // aggregated from the tools
  phases: Phase[];                 // 4P category
  tools: Array<Tool & { mutates: boolean; phases: Phase[] }>;
  metadata?: Record<string, unknown>;
}
```

### Categorization helpers

- `categorizeTool(tool): Phase[]` — infer phases for one tool.
- `categorizeProvider(tools): Phase[]` — union across tools.

---

## PermissionGate

```ts
new PermissionGate(mode?: PermissionMode, callback?: PermissionCallback)
```

`setMode(mode)`, `getMode()`, `setCallback(cb?)`, `evaluate(req): Promise<PermissionDecision>`.

Under `bypass` the callback is never called. Under `ask-mutations` it is called only when `req.mutates`. Under `ask-all` it is always called. With no callback, everything is allowed.

---

## LogStore

In-memory structured log with tag search (backs `activity_monitor`).

```ts
new LogStore(maxEntries = 10_000)
```

| Method | Description |
|--------|-------------|
| `append(entry)` | Add a `LogEntry` (fills defaults). |
| `logger()` | Returns an `(entry) => void` for `ToolContext.log`. |
| `subscribe(fn)` | Stream new entries. |
| `search(query: LogQuery)` | Filter by `tags` (AND), `anyTags` (OR), `text`/`regex`, `level`, `since`, `limit`. |
| `tagHistogram()` | `{ tag: count }`. |
| `clear()` / `all()` | |

---

## LLM layer

### `stream(model, context, options?)` / `complete(model, context, options?)`

pi-ai-compatible. `stream` returns an `AssistantMessageEventStream`; `complete` returns a final `AssistantMessage`. `options: LLMOptions = { temperature?, maxTokens?, reasoning?, signal?, apiKey?, headers? }`.

### `OpenRouterBridge`

```ts
new OpenRouterBridge({ apiKey?, baseUrl?, headers? }): LLMBridge
```

Implements `LLMBridge`: `complete`, `stream`, `resolveModel(slug)`.

### `callOpenRouter(request, opts?)` / `streamOpenRouter(request, opts?)`

The single low-level API-call function (req #5). `request: OpenRouterRequest` (OpenAI/OpenRouter chat shape — `model`, `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`, `reasoning`, `provider` routing). `opts: CallOptions = { baseUrl?, apiKey?, headers?, signal?, timeoutMs? }`. `callOpenRouter` resolves an `OpenRouterResponse`; `streamOpenRouter` yields `OpenRouterStreamChunk`s. Throws `OpenRouterError` (with `status`, `body`) on non-2xx.

### Models

- `MODEL_CATALOG: Record<string, Model>` — built-in metadata (cost, window, modalities).
- `DEFAULT_PHASE_MODELS` — `{ prepare, plan, perform, perfect, orchestrator }` slugs.
- `resolveModel(slug): Model` — known slugs from the catalog; unknown slugs get a permissive all-modality descriptor.
- `registerModel(model)` — add/override a catalog entry.

---

## Model selection

- `estimateComplexity(input: ComplexityInput): Complexity` — 0..1 score from tool breadth, context size, attachment weight, mutation, and `bias`.
- `requiredModalities(attachments?, refs?): Modality[]` — modalities a call needs.
- `selectModel(input: SelectModelInput): { model, complexity }` — precedence: `preferred` (if modality-capable) → cheapest candidate/tier matching the complexity tier and modalities.

---

## MCP client

- `connectMcpServer(opts: McpServerOptions): Promise<ProviderInput>` — spawn, handshake, list tools, wrap each as an `AgentTool`. Hand the result to `registry.add()` (or use `harness.addMcpServer`).
- `class McpClient` — lower-level: `start(): Promise<McpToolDef[]>`, `callTool(name, args)`, `stop()`.

```ts
interface McpServerOptions {
  id: string; name?: string;
  command: string; args?: string[];
  env?: Record<string, string>; cwd?: string;
  mutates?: boolean;   // default true (external tools are opaque)
  timeoutMs?: number;  // default 30_000
}
```

Transport: newline-delimited JSON-RPC 2.0 over stdio.

---

## Multimodal helpers

| Function | Description |
|----------|-------------|
| `attachmentFromPath(file, summary?)` | Build a reference-only `Attachment` (no bytes read). |
| `loadContent(att)` | Read bytes and populate `content` (base64) on demand. |
| `attachmentToContent(att, inline = false)` | Convert to a `UserContent` block; `inline` loads bytes. |
| `buildUserContent(text, attachments?, inline = false)` | Text + attachments → `UserContent[]`. |
| `refsFromAttachments(attachments?)` | Extract `MediaRef[]` (address + summary). |
| `guessMimeType(file)` / `attachmentTypeFor(mimeType)` | Helpers. |

---

## Built-in tools

Factory functions (return an `AgentTool`) and pre-built lists:

- `CODING_TOOLS` — `bashTool`, `bashReadonlyTool`, `readTool`, `writeTool`, `editTool`, `lsTool`, `grepTool`, `markConcernLinesTool`. (`mark_concern_lines` is the per-read "lines of concern" marker: after a `read`, the model calls it with the lines that matter for the task — `lines` accepts a range like `"42-44"` or a list like `"42,43,44"`, optional `why`. Surfaces live via `tool_execution_end` (`details: { path, lines, why }`) and at phase end via `PhaseResult.lineConcerns`.)
- `createAssetsGeneratorTool(config?: AssetsGeneratorConfig)` — image/video/audio/3d. Config: `{ backends?: AssetBackends, defaultOutDir? }`. Returns the asset by reference; `details: AssetResult { uri, mimeType, size, summary }`.
- `createMediaAnalysisTool(config?: MediaAnalysisConfig)` — analyze image/video/audio/document attachments; args `{ prompt, file?, files?, type?, model? }`, `details: MediaAnalysisResult { analysis, analyzed: ResolvedMedia[] }`. Config: `{ model?, analyze?: MediaAnalysisBackend }`.
- `createWebTools(config?: WebConfig): AgentTool[]` — `web_search` (args `{ query, maxResults?, site? }`, `details: WebSearchResult { query, searchUrl, hits[] }`) and `web_fetch` (args `{ url, maxChars? }`, `details: WebFetchResult { url, finalUrl, title?, text, truncated }`). Both drive the Playwright MCP resolved from the registry at call time; neither makes its own HTTP request. Config: `{ maxResults?, maxFetchChars?, searchUrlTemplate? }`. Also exports `findBrowserTool`, `extractJsonPayload`.
- `createActivityMonitorTools({ logStore, studyModel? }): AgentTool[]` — the activity-monitor provider's toolset, registered `kind: "mcp"`: `activity_search`, `activity_tags`, `activity_tail_file`, `activity_study`, `activity_trace_start`, `activity_collect`, `activity_cleanup`, `activity_inspect`. One tool per step so each is a separate, visible tool call.
- `createProjectMemoryTool(memory)` — read/append durable project memory; actions `get` | `remember` | `recall` | `set_category`. See [Project memory](./project-memory.md).
- `builtinProviders(config): ProviderInput[]` and `registerBuiltins(registry, config)` — assemble/register all internal providers.

### `AssetBackend`

```ts
type AssetBackend = (req: AssetRequest, ctx: ToolContext) =>
  Promise<{ bytes: Uint8Array; mimeType: string; ext: string; summary?: string }>;
```

Provide one per kind via `AssetBackends { image?, video?, audio?, "3d"? }`. Unconfigured kinds use deterministic placeholders.

---

## Core types

The pi-compatible surface (all exported).

### Messages & content

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage   { role: "user"; content: string | UserContent[]; timestamp: number; }
interface AssistantMessage {
  role: "assistant"; content: AssistantContent[];
  api: Api; provider: Provider; model: string;
  responseModel?; responseId?;
  usage: Usage; stopReason: StopReason; errorMessage?; timestamp: number;
}
interface ToolResultMessage<D = unknown> {
  role: "toolResult"; toolCallId: string; toolName: string;
  content: ToolResultContent[]; details?: D; isError: boolean; timestamp: number;
}

// content blocks
interface TextContent    { type: "text"; text: string; textSignature?; }
interface ThinkingContent{ type: "thinking"; thinking: string; thinkingSignature?; redacted?; }
interface ImageContent   { type: "image"; data: string; mimeType: string; }        // base64
interface MediaContent   { type: "audio" | "video" | "file"; data?: string; uri?: string; mimeType: string; }
interface ToolCall       { type: "toolCall"; id; name; arguments: Record<string, unknown>; thoughtSignature?; }

type UserContent       = TextContent | ImageContent | MediaContent;
type AssistantContent  = TextContent | ThinkingContent | ToolCall;
type ToolResultContent = TextContent | ImageContent | MediaContent;
```

### Context & tools

```ts
interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }

interface Tool<P = JSONSchema> { name: string; description: string; parameters: P; }

interface AgentTool<P = JSONSchema, D = unknown> extends Tool<P> {
  mutates?: boolean;          // drives ask-mutations
  phases?: Phase[];           // 4P category override
  complexityHint?: number;    // 0..1 static hint
  execute(id, args, ctx: ToolContext): Promise<ToolResult<D>>;
}

interface ToolResult<D = unknown> {
  output?: string;            // LLM-facing text
  details?: D;                // UI-facing structured payload
  content?: ToolResultContent[];
  isError?: boolean;
  usage?: Usage;              // tokens spent by internal LLM calls inside the tool
  /** Complexity the tool MEASURED off the artifact it touched (vs. the static
   *  `complexityHint` guessed before the call). The loop folds this into its
   *  per-path floor — ratchets up only — so the next call on that path arrives at
   *  the gate pre-rated with `complexitySource: "tool-measured"`. Set by the
   *  staged `read`. */
  measuredComplexity?: ComplexityRating;
  measuredPath?: string;      // defaults to the call's path argument
}

interface ToolContext {
  cwd: string; signal?: AbortSignal; model?: Model;
  authorModel?: Model; authoringContext?: AuthoringContext;
  images?: Array<{ path: string; mimeType: string }>;
  /** The loop's candidate pool (cheap → capable), so a tool can escalate
   *  INTERNALLY — rate the artifact, then selectModel({complexity, candidates}).
   *  Absent ⇒ the tool must behave as single-stage (graceful degradation). */
  toolModelCandidates?: string[];
  /** Rating the loop already holds for this path, so a staged tool can skip its
   *  own rating pass instead of paying to recompute it. */
  knownComplexity?: ComplexityRating;
  log: (entry: LogEntry) => void; llm?: LLMBridge; registry?: unknown;
  askUserQuestion?: (req: AskUserQuestionRequest) => Promise<string>;
}
```

### Events

```ts
type AssistantMessageEvent =
  | { type: "start"; partial } | { type: "text_start" | "text_delta" | "text_end"; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_delta" | "toolcall_end"; ... }
  | { type: "done"; reason; message } | { type: "error"; reason; error };

type AgentEvent =
  // pi-compatible:
  | { type: "agent_start" } | { type: "agent_end"; messages }
  | { type: "turn_start" } | { type: "turn_end"; message; toolResults }
  | { type: "message_start" | "message_update" | "message_end"; ... }
  | { type: "tool_execution_start" | "tool_execution_end"; ... }
  // 4P extensions:
  | { type: "phase_start"; phase; model } | { type: "phase_end"; phase; result }
  | { type: "phase_summary"; phase; uiSummary?; handoff? }   // lightweight end-of-phase UI signal
  | { type: "chain_start"; task } | { type: "chain_iteration"; iteration } | { type: "chain_end"; success; iterations }
  | { type: "permission_request"; request } | { type: "permission_decision"; request; decision };
```

`phase_summary` is emitted once at the very end of every phase (after `phase_end`) carrying **only** the user-facing `uiSummary` string and the structured `handoff` object — so a UI/IPC host gets the one card it renders plus the continuity object without unpacking the heavy `PhaseResult` that `phase_end` carries. Like the other 4P events it is additive: a pi UI can ignore it.

### 4P, permissions, complexity, media

```ts
type Phase = "prepare" | "plan" | "perform" | "perfect";
const PHASES: Phase[];

interface PhaseResult {
  phase: Phase; summary: string; artifacts?: Record<string, unknown>;
  refs?: MediaRef[]; verified?: boolean;   // verified only meaningful for "perfect"
  complexity: number; usage: Usage; messages: Message[]; error?: string;
}

type PermissionMode = "ask-all" | "bypass" | "ask-mutations";
interface PermissionRequest {
  kind: "tool" | "phase"; name: string; mutates: boolean;
  args?; complexity: Complexity; refs?: MediaRef[]; phase?: Phase;
  complexityRating?: ComplexityRating;
  /** "estimated" | "prepare-file" | "plan-task" | "tool-measured" — the last
   *  meaning a tool read the real artifact and rated it mid-run. */
  complexitySource?: ComplexitySource;
}
interface PermissionDecision {
  allowed: boolean;
  /** Model that PROCESSES this call's result on the next turn (Model B reads the
   *  diff / interprets the read). Applies to every tool; one turn only. */
  model?: string;
  /** Model that AUTHORS the bytes for a write/edit (Model B authors from scratch).
   *  write: B's content replaces Model A's draft. edit: B authors the replacement;
   *  Model A's oldString anchor is kept. Honored only for write/edit. Omit ⇒ Model
   *  A's args are written as-is (today's behavior). No fallback on failure. */
  authorModel?: string;
  /** UI-emission toggles + reasoning effort for the next turn (see types.ts). */
  thinkingLevel?: ThinkingLevel; reasoning?: boolean; transcript?: boolean;
  reason?: string;
}
type PermissionCallback = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

interface Complexity { score: number; signals: { toolBreadth?; contextSize?; attachmentWeight?; mutation?; }; }

interface MediaRef { id: string; uri: string; mimeType: string; summary?: string; size?: number; }
interface Attachment {
  id; type: "image" | "document" | "audio" | "video" | "file";
  fileName; mimeType; size; content?; ref?: MediaRef; extractedText?; preview?;
}
```

### Models & usage

```ts
interface Model<TApi = Api> {
  id; name; api: TApi; provider; baseUrl; reasoning: boolean;
  input: Modality[];                          // "text"|"image"|"video"|"audio"|"file"
  cost: { input; output; cacheRead; cacheWrite };
  contextWindow; maxTokens; headers?; openRouterSlug?;
}
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
interface Usage { input; output; cacheRead; cacheWrite; totalTokens; cost { input; output; cacheRead; cacheWrite; total }; }
function emptyUsage(): Usage;

interface LLMBridge {
  complete(model, context, options?): Promise<AssistantMessage>;
  stream(model, context, options?): AssistantMessageEventStream;
  resolveModel(slug): Model;
}
```

### Logging

```ts
interface LogEntry { timestamp: number; level: "debug"|"info"|"warn"|"error"; tags: string[]; message: string; data?: unknown; }
```

## Escalation routing (`routeModel`)

`HarnessConfig.routeModel` / `SessionOptions.routeModel` — a host-owned table
mapping an escalation to a model slug:

```ts
type ModelRouter = (input: {
  kind: "read" | "write";
  rating: "low" | "medium" | "high";
  path?: string;
}) => string | undefined;
```

It answers a question `toolModelCandidates` cannot. That pool picks a tier with
`floor(score * pool.length)`, so which model a rating lands on is a function of
the pool's **length** — appending a slug silently re-targets every rating — and a
flat list cannot distinguish a read from a write at all. The two want different
models: comprehension rewards raw capability, authoring rewards
instruction-following and diff discipline.

Where each `kind` is consulted:

| kind | consulted by | how it arrives |
|---|---|---|
| `read` | the staged `read`'s comprehension escalation (`comprehendFile`) | `ctx.routeModel`, because the escalation happens *inside* the tool |
| `write` | `write` / `edit` byte authoring | the loop resolves it into `ctx.authorModel` |

Precedence, highest first:

1. **`decision.authorModel`** from the permission callback — a per-call
   instruction, more specific than standing policy.
2. **`routeModel`** — returns a slug, or `undefined` for "no opinion".
3. **`toolModelCandidates`** — the score-indexed pool.
4. **No escalation.** The loop's own model does the work.

`low` never routes: it proceeds unescalated, because spending a second model
round-trip to re-derive what the loop's model was already trusted with is pure
cost. The hook is additive — a host that passes no `routeModel` behaves exactly
as before.

⚠️ Any slug that can end up as the **driver** must be reasoning-capable. A model
without the capability returns stream deltas carrying only `content`/`role`, so
no thinking is ever emitted and nothing reports an error — the loop logs a
`warn` under the `reasoning` tag when a reasoning level was requested and no
turn returned any.
