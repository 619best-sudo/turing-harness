# Guides & recipes

- [Add an external MCP server](#add-an-external-mcp-server)
- [Register a skill](#register-a-skill)
- [Write a custom tool](#write-a-custom-tool)
- [Permission policies](#permission-policies)
- [Per-phase and per-tool models](#per-phase-and-per-tool-models)
- [Multimodal inputs](#multimodal-inputs)
- [A real asset-generation backend](#a-real-asset-generation-backend)
- [Visual QA in Perfect](#visual-qa-in-perfect)
- [Log tags & activity monitoring](#log-tags--activity-monitoring)
- [Custom / non-OpenRouter endpoints](#custom--non-openrouter-endpoints)
- [Testing offline with a fake model](#testing-offline-with-a-fake-model)
- [Electron](#electron)

---

## Add an external MCP server

```ts
await harness.addMcpServer({
  id: "playwright",
  command: "npx",
  args: ["@playwright/mcp@latest"],
});

// Its tools are now categorized (browser/screenshot → Perfect) and available:
harness.listCapabilities({ phase: "perfect" });
await harness.removeProvider("playwright");   // stops the child process
```

The client spawns the server, performs the MCP `initialize` handshake, lists tools, and wraps each as an `AgentTool` proxying `tools/call`. External tools default to `mutates: true` (they're opaque); override per-server with `mutates: false` if you know they're read-only.

## Register a skill

A skill is just a named bundle of tools:

```ts
harness.addSkill({
  id: "release-notes",
  name: "release-notes",
  source: "external",
  tools: [genChangelogTool, bumpVersionTool],
  phases: ["perform"],          // optional; else inferred
});
```

## Write a custom tool

```ts
import type { AgentTool } from "@turing/harness";

const httpGet: AgentTool = {
  name: "http_get",
  description: "Fetch a URL and return the response body.",
  mutates: false,               // read-only → categorized into Prepare/Plan
  phases: ["prepare", "plan"],  // optional explicit category
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  async execute(_id, args, ctx) {
    ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:http_get"], message: String(args.url) });
    const res = await fetch(String(args.url), { signal: ctx.signal });
    return { output: await res.text(), details: { status: res.status } };
  },
};

harness.addProvider({ id: "web", kind: "tool", source: "external", name: "web", tools: [httpGet] });
```

`execute` returns `{ output?, details?, content?, isError? }`: `output` goes to the model, `details` is for the UI, `content` adds blocks (e.g. an image the model should see). If the tool returns `details` with `{ uri, mimeType }`, the runner threads it forward as a `MediaRef`.

## Permission policies

```ts
// Ask only for mutations; auto-pick the model by complexity.
harness.setPermissionMode("ask-mutations");
harness.setPermissionCallback(async (req) => {
  // req.kind: "tool" | "phase"; req.mutates; req.complexity.score; req.refs
  if (req.name === "bash" && /rm -rf/.test(String(req.args?.command))) {
    return { allowed: false, reason: "destructive command blocked" };
  }
  return {
    allowed: true,
    model: req.complexity.score > 0.6 ? "anthropic/claude-opus-4.8" : undefined, // else phase model
  };
});
```

Modes:
- **`bypass`** — never ask; callback ignored.
- **`ask-all`** — ask for every phase and tool call.
- **`ask-mutations`** — ask only when `req.mutates` (write/edit/bash/asset gen, the Perform phase, external MCP tools).

The callback can pin the model for that specific call via `decision.model`.

## Per-slot and per-tool models

The four `models` keys are named after the 4P phases, but under `run` they are
**role slots**: `perform` drives the work loop, `prepare` runs the intent router
and conversational replies, `perfect` writes the run summary, `plan` is unused.

```ts
new Harness({
  models: {
    orchestrator: "anthropic/claude-haiku-4.5",  // fallback for anything unspecified
    perform: "anthropic/claude-sonnet-4.5",      // the driver
  },
  toolModelCandidates: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4.8"],
});

// Change at runtime:
harness.orchestrator.setModel("perform", "openai/gpt-5");
harness.orchestrator.setModel("orchestrator", undefined);  // clear override

// On a warm session, set these PER RUN — the user can change models between runs:
session.setToolModelCandidates([cheap, capable]);
session.setRouteModel(routeModel);
```

Per-tool model comes from the permission decision (`decision.model`); with none, `selectModel()` picks from `toolModelCandidates` (or the built-in cheap→capable tiers) by complexity and required modalities; with none capable, the driver runs it.

Escalation — which model *comprehends* a hard file or *authors* a write's bytes —
is a separate decision, made from the call's rating, category and attachments.
See [complexity, category & models](./models.md).

## Multimodal inputs

```ts
import { attachmentFromPath } from "@turing/harness";

const design = await attachmentFromPath("./mock.png", "target design for the settings page");
const clip   = await attachmentFromPath("./demo.mp4", "screen recording of the bug");

const agent = harness.createAgent();
await agent.prompt("Match the settings page to the mock and fix the bug in the clip.", [design, clip]);
```

Attachments are reference-first: only the address + summary travel between steps. A video/audio attachment forces model selection toward a capable model (Gemini in the default catalog). Bytes are read only when a tool needs them (`loadContent`, or `attachmentToContent(att, true)`).

## A real asset-generation backend

The `assets_generator` tool uses placeholders unless you supply backends:

```ts
const harness = new Harness({
  assets: {
    backends: {
      async image(req, ctx) {
        const res = await fetch("https://api.example.com/v1/images", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.IMG_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: req.prompt, ...req.options }),
        });
        const { b64 } = await res.json();
        return { bytes: Buffer.from(b64, "base64"), mimeType: "image/png", ext: "png", summary: `image: ${req.prompt}` };
      },
      // video, audio, "3d" similarly
    },
  },
});
```

The tool writes the bytes to `<cwd>/assets` (or `outDir`) and returns a `MediaRef` — never the bytes inline.

## Analyzing attachments

`media_analysis` hands any attachment — image, video, audio, document — to a multimodal model:

```ts
// Called by any phase model, or directly:
const analyze = harness.toolsForPhase("perfect").find((t) => t.name === "media_analysis")!;
const res = await analyze.execute("id", {
  file: "screens/after.png",
  prompt: "Is the primary button teal, centered, and un-clipped on mobile?",
}, { cwd: process.cwd(), log: () => {}, llm: harness.llm });

console.log(res.details.analysis); // the model's answer, grounded in the screenshot
```

Pass `files: [a, b]` instead of `file` to compare several in one request (before/after screenshots).
The modality is inferred from the extension; pin `type: "image" | "video" | "audio" | "document"` when
the extension is missing or misleading. Video is always carried by address, as is anything over 20 MB —
everything else is inlined as base64.

The model **must** be multimodal. Pick it with `mediaAnalysis: { model: "google/gemini-2.5-pro" }` or
per-call `model`; left unset it falls back to the session model, which may be text-only.

## Log tags & activity monitoring

Everything the harness does emits tagged `LogEntry`s (`phase:*`, `tool:*`, `mutation`, `mcp:*`, `verify:fail`, …). Query them directly or via the tool:

```ts
harness.logStore.search({ anyTags: ["mutation"], level: "info" });
harness.logStore.tagHistogram();   // discover what tags exist

// Or let a phase model use the tools to cut noise and study a slice:
//   activity_tags {}                                                  // what tags exist
//   activity_search    { tags: ["tool:bash", "error"] }
//   activity_tail_file { file: "server.log", text: "ERROR" }
//   activity_study     { anyTags: ["verify:fail"] }                   // model summarizes
```

## Searching the internet

`web_search` and `web_fetch` drive the **Playwright MCP** — there is no HTTP client and no
search API key in either of them. Attach a browser MCP and both work:

```ts
new Harness({ providers: [{ id: "playwright", kind: "mcp", /* npx @playwright/mcp@latest */ }] });
```

```ts
// Find the page...
await search.execute("id", { query: "vite 7 breaking changes", site: "vite.dev" }, ctx);
//   -> details.hits: [{ url, title?, snippet? }], details.searchUrl (reproducible by hand)

// ...then read it. The page is RENDERED first, so client-side docs sites work.
await fetchTool.execute("id", { url: "https://github.com/vitejs/vite/issues/42" }, ctx);
//   -> details.text (truncated at maxChars), details.title, details.finalUrl
```

Search goes to DuckDuckGo's HTML endpoint by default because it renders server-side and is the
least hostile to automation; point `web: { searchUrlTemplate }` at another engine or an internal
index (`{query}` is substituted URL-encoded). The scraper reads DuckDuckGo's markup first and
falls back to "off-site links with visible text", so an unfamiliar layout still yields something.

With no browser MCP connected, both tools return a clear error naming the missing capability —
they never fall back to `curl`, which returns unrendered markup and usually no content at all.

## Tracing runtime data flow

`activity_trace_start` opens a trace session; the model then instruments the code with its
**own** `read`/`edit` calls, so every insertion is a visible, reviewable tool call that the
permission gate sees:

```
activity_trace_start { language: "typescript", hint: "why is the cart total wrong?" }
  -> traceId + a __t() snippet writing to console AND /tmp/turing-trace-<id>.log
read  src/cart.ts                 # the model's own calls, in the transcript
edit  src/cart.ts                 # inserts __t() at the flow points it chose
<run the flow>
activity_collect { traceId, waitMs: 30000 }   # waits, reporting progress, if the flow runs late
activity_study   { traceId }                  # root-cause analysis over the collected lines
activity_cleanup { traceId }                  # delete the file, kill anything auto-started
```

Pass `startCommand` to `activity_trace_start` to have the dev server started with its
stdout/stderr piped into the trace file (`port` frees the port first).

## Custom / non-OpenRouter endpoints

Anything OpenAI-compatible works via `baseUrl`:

```ts
new Harness({ baseUrl: "https://my-gateway.internal/v1", apiKey: "..." });
```

Or inject a fully custom `LLMBridge` (`{ complete, stream, resolveModel }`).

## Testing offline with a fake model

Inject a fake `LLMBridge` so tests never hit the network. See `examples/smoke.mjs` for a complete scripted-per-phase fake that drives the entire chain, executes real tools, and asserts on the results.

```ts
const harness = new Harness({ llm: fakeBridge, permissionMode: "bypass", cwd });
```

## Electron

The core is DOM-free (only Node built-ins + `fetch`). Run the `Harness` **manager** in the main process and map each window/tab to an isolated `Session` so tabs run in parallel without cross-talk (see [Multi-session](./multi-session.md)):

```ts
// main.ts
import { Harness } from "@turing/harness";
import { ipcMain } from "electron";

const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });
const windows = new Map<string, Electron.WebContents>();

// One subscription fans every session's events to the right window, tagged by id.
harness.subscribeAll((sessionId, e) => windows.get(sessionId)?.send("harness:event", e));

ipcMain.handle("session:open", (_e, { cwd, wc }) => {
  const s = harness.createSession({ cwd });
  windows.set(s.id, wc);
  return s.id;
});
ipcMain.handle("session:run",   (_e, { id, task }) => harness.getSession(id)?.runChain(task));
ipcMain.handle("session:abort", (_e, { id }) => harness.getSession(id)?.abort());
ipcMain.handle("session:mcp",   (_e, { id, opts }) => harness.getSession(id)?.addMcpServer(opts));
ipcMain.handle("session:close", (_e, { id }) => harness.closeSession(id));
```

```ts
// renderer.ts — build your UI from the pi-compatible event stream
const sessionId = await window.electron.invoke("session:open", { cwd });
window.electron.on("harness:event", (e) => renderPiEvent(e));   // this tab's events
await window.electron.invoke("session:run", { id: sessionId, task: "Add dark mode." });
```

For an interactive permission UI, set a per-session `permissionCallback` that round-trips to that tab's renderer (send the `PermissionRequest`, await the user's `PermissionDecision`). Because each session has its own gate, prompts never bleed across tabs.
