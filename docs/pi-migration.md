# pi compatibility & migration

turing-harness is structurally compatible with [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) and [`@mariozechner/pi-agent`](https://www.npmjs.com/package/@mariozechner/pi-agent) (req #2). A UI or integration written against pi's message shapes and event stream can drive this harness with little to no change.

## Type mapping

| pi (`pi-ai` / `pi-agent`) | turing-harness | Notes |
|---------------------------|----------------|-------|
| `Message` = `UserMessage \| AssistantMessage \| ToolResultMessage` | same | identical roles/fields |
| `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall` | same | plus `MediaContent` for audio/video/file |
| `Usage`, `StopReason` | same | |
| `Context { systemPrompt?, messages, tools? }` | same | |
| `Tool { name, description, parameters }` | same | `parameters` is a JSON schema; pi's TypeBox `TSchema` satisfies it structurally |
| `AgentTool` (`Tool` + `execute → { output?, details?, content? }`) | same | plus `mutates?`, `phases?`, `complexityHint?` and a `ctx` argument on `execute` |
| `AssistantMessageEvent` (`start`/`text_delta`/`toolcall_*`/`done`/`error`) | same | |
| `AgentEvent` (`agent_start` … `tool_execution_end`) | same | plus namespaced `phase_*`, `chain_*`, `permission_*` |
| `Attachment` | same | extended with `audio`/`video`/`file` types and a lazy `ref` (address + summary) |
| `Model<TApi>` | same | `input` extended with `video`/`audio`/`file`; adds `openRouterSlug` |
| `stream(model, ctx, opts)` / `complete(model, ctx, opts)` | same signatures | over OpenRouter |
| `Agent` class (`subscribe`, `prompt`, `state`, `setModel`, …) | `HarnessAgent` | same surface; `prompt` runs the 4P chain |
| `AgentTransport.run(...)` | orchestrator internals | the harness owns the loop; you don't implement a transport |

## Differences to know

1. **`AgentTool.execute` takes a third `ctx` argument** (`ToolContext`: `cwd`, `signal`, `model`, `log`, `llm`, `registry`). pi passes only `(toolCallId, args)`. To reuse a pi tool, wrap it:

   ```ts
   const wrapped: AgentTool = { ...piTool, mutates: true, execute: (id, args) => piTool.execute(id, args) };
   ```

2. **`parameters` is typed as `JSONSchema`, not TypeBox `TSchema`.** They're structurally the same. A pi tool built with `Type.Object({...})` is assignable; you just lose the TypeBox static-type inference on `args` (args arrive as `Record<string, unknown>`).

3. **Extra events.** The 4P events (`phase_*`, `chain_*`, `permission_*`) are additive and namespaced. A pi renderer that switches on the pi event types will ignore them safely.

4. **Models are OpenRouter slugs.** Use `resolveModel("anthropic/claude-opus-4.8")` to get a `Model`, or pass slugs to config. Any OpenAI-compatible endpoint works via `baseUrl`.

5. **Reasoning levels.** `ThinkingLevel` here is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (pi-agent uses `off..high`); the extra `xhigh` maps down to `high` at the OpenRouter layer.

6. **Follow-up continuity is structured, not transcript-replay based.** `agent.state.messages` is still the render transcript a pi UI expects, but completed runs now also produce `lastThreadSnapshot`. The next prompt in the same session uses that compact snapshot (`task`, summaries, changed files, verification state) as follow-up context by default. Call `agent.reset()` to clear both the UI transcript and the stored follow-up state.

## Migrating a pi UI

Most pi UIs consume two things: `AppMessage[]` for rendering and the event stream for live updates. Both are provided:

```ts
const agent = harness.createAgent();

// live updates — same event names your pi renderer already handles
agent.subscribe((e) => {
  if (e.type === "message_update") applyAssistantEvent(e.assistantMessageEvent);
  if (e.type === "tool_execution_end") markToolDone(e.toolCallId, e.result);
  // new (optional): e.type === "phase_start" → show the 4P stepper
});

await agent.prompt(userText, attachments);
render(agent.state.messages);   // AppMessage[]
console.log(agent.state.lastThreadSnapshot); // structured context for the next prompt
```

If you were calling pi's `stream()`/`complete()` directly, import them from here unchanged:

```ts
import { stream, complete, resolveModel } from "@turing/harness";
const model = resolveModel("anthropic/claude-sonnet-4.5");
for await (const ev of stream(model, context, { reasoning: "medium" })) { /* ... */ }
```

## What you gain

The harness adds the 4P orchestration (Prepare/Plan/Perform/Perfect with verify-and-retry), the capability registry with phase categorization, per-phase/per-tool model selection, the permission gate, multimodal reference handling, and the three internal tools — while keeping the message/event contracts your pi code already speaks.
