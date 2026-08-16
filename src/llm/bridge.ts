/**
 * pi-compatible LLM surface built on the OpenRouter layer.
 *
 * Exposes `stream(model, context, options)` and `complete(model, context, options)`
 * with the exact pi-ai signatures, plus an {@link OpenRouterBridge} implementing
 * {@link LLMBridge}. Converts between pi's `Context`/`Message` shapes and the
 * OpenRouter/OpenAI chat dialect, including multimodal content.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  LLMBridge,
  LLMOptions,
  Message,
  Modality,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import {
  callOpenRouter,
  streamOpenRouter,
  type CallOptions,
  type ORContentPart,
  type ORMessage,
  type ORTool,
  type ORUsage,
  type OpenRouterRequest,
} from "./openrouter.js";
import { resolveModel } from "./models.js";

// ---------------------------------------------------------------------------
// Context -> OpenRouter request
// ---------------------------------------------------------------------------

function dataUri(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Drop non-text content a model cannot accept, replacing it with a short text
 * note so the model still knows something was there.
 *
 * Sending an image to a text-only model is a HARD failure: the provider rejects
 * the whole request, so a browser session that took a screenshot loses every
 * turn of work that came before it. Degrading to a note keeps the run alive.
 *
 * Gated on `Model.input`, which is accurate for catalogued models. Unknown slugs
 * still get the permissive all-modality default (`resolveModel`), so this only
 * ever removes content we positively know the model rejects.
 */
function acceptsModality(model: Model | undefined, modality: Modality): boolean {
  if (!model?.input || model.input.length === 0) return true;
  return model.input.includes(modality);
}

function toORContent(msg: Message, model?: Model): string | ORContentPart[] | null {
  if (msg.role === "user") {
    if (typeof msg.content === "string") return msg.content;
    const parts: ORContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        if (!acceptsModality(model, "image")) {
          parts.push({
            type: "text",
            text: `[image omitted: ${model?.id ?? "this model"} cannot accept image input]`,
          });
          continue;
        }
        parts.push({ type: "image_url", image_url: { url: dataUri(block.mimeType, block.data) } });
      } else if (block.type === "audio" && block.data)
        parts.push({
          type: "input_audio",
          input_audio: { data: block.data, format: block.mimeType.split("/")[1] ?? "wav" },
        });
      else if ((block.type === "video" || block.type === "file") && (block.data || block.uri))
        parts.push({
          type: "file",
          file: {
            filename: block.uri?.split("/").pop() ?? "attachment",
            file_data: block.data ? dataUri(block.mimeType, block.data) : (block.uri as string),
          },
        });
      else if (block.uri)
        // Media carried by reference only (address). Surface the address as text so
        // the model knows it exists without us shipping the bytes (req #7).
        parts.push({ type: "text", text: `[${block.type}: ${block.uri}]` });
    }
    return parts.length ? parts : "";
  }
  if (msg.role === "toolResult") {
    // The OpenAI/OpenRouter `tool` role accepts text content only, so image/media
    // blocks from a tool can't ride on this message. We fold text here; any image
    // a tool produced is preserved in the pi message history and surfaced to the
    // model as a follow-up user message (see appendToolMedia in the phase runner).
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    return text || (msg.isError ? "error" : "ok");
  }
  // assistant text
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

export function contextToRequest(
  model: Model,
  context: Context,
  options: LLMOptions | undefined,
  stream: boolean,
): OpenRouterRequest {
  const messages: ORMessage[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const msg of context.messages) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: toORContent(msg, model) });
    } else if (msg.role === "assistant") {
      const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
      const reasoning = msg.content.find((c) => c.type === "thinking");
      messages.push({
        role: "assistant",
        content: toORContent(msg, model) || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((t) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: JSON.stringify(t.arguments) },
              })),
            }
          : {}),
        ...(reasoning ? { reasoning: (reasoning as { thinking: string }).thinking } : {}),
      });
    } else {
      // toolResult
      messages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: toORContent(msg, model),
      });
    }
  }

  const tools: ORTool[] | undefined = context.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));

  const req: OpenRouterRequest = {
    model: model.openRouterSlug ?? model.id,
    messages,
    stream,
  };
  if (tools?.length) {
    req.tools = tools;
    req.tool_choice = "auto";
  }
  if (options?.temperature != null) req.temperature = options.temperature;
  if (options?.maxTokens != null) req.max_tokens = options.maxTokens;
  else req.max_tokens = model.maxTokens;
  if (model.reasoning && (options?.reasoning || options?.reasoningMaxTokens != null)) {
    const level = options.reasoning;
    // `off` means "do not think", which on the wire is a zero reasoning budget —
    // not an omitted parameter. Omitting it hands the choice to the provider, and
    // an unbounded reasoning model can spend the whole completion budget thinking
    // and return no content at all.
    if (level === "off") {
      req.reasoning = { exclude: true, max_tokens: 0 };
    } else if (options.reasoningMaxTokens != null) {
      // MUTUALLY EXCLUSIVE with `effort` — sending both is a 400 from OpenRouter,
      // and a rejected request never appears in the provider's activity log, so it
      // presents as "the model returned nothing" with no upstream trace at all.
      // A token budget is the stronger guarantee, so it wins when both are given.
      req.reasoning = { max_tokens: options.reasoningMaxTokens };
    } else {
      const effort = level === "xhigh" ? "high" : level;
      req.reasoning = { effort: effort as "minimal" | "low" | "medium" | "high" };
    }
  }
  // Forward complexity + candidate hints to a backend proxy (modelSelection),
  // so the backend can control model selection "from there". Carried under
  // `metadata.modelSelection` — OpenRouter ignores unknown metadata, so this is
  // harmless even when the bridge goes direct. A backend reading it (the
  // turing-machine proxy) uses it to resolve the upstream model by complexity.
  if (options?.modelSelection) {
    const existing =
      req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata)
        ? (req.metadata as Record<string, unknown>)
        : {};
    req.metadata = { ...existing, modelSelection: options.modelSelection };
  }
  return req;
}

// ---------------------------------------------------------------------------
// Usage mapping
// ---------------------------------------------------------------------------

function mapUsage(model: Model, u: ORUsage | undefined): Usage {
  const usage = emptyUsage();
  if (!u) return usage;
  const cachedRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  usage.input = (u.prompt_tokens ?? 0) - cachedRead;
  usage.cacheRead = cachedRead;
  usage.output = u.completion_tokens ?? 0;
  usage.totalTokens = u.total_tokens ?? usage.input + usage.output + usage.cacheRead;
  usage.cost.input = usage.input * model.cost.input;
  usage.cost.output = usage.output * model.cost.output;
  usage.cost.cacheRead = usage.cacheRead * model.cost.cacheRead;
  usage.cost.total =
    u.cost ?? usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

function mapStopReason(finish: string | null | undefined): StopReason {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "length":
    case "max_tokens":
      return "length";
    case "stop":
    case "end_turn":
      return "stop";
    default:
      return "stop";
  }
}

function baseMessage(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.openRouterSlug ?? model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function callOptions(model: Model, options?: LLMOptions): CallOptions {
  return {
    baseUrl: model.baseUrl,
    apiKey: options?.apiKey,
    headers: { ...model.headers, ...options?.headers },
    signal: options?.signal,
  };
}

// ---------------------------------------------------------------------------
// complete() — non-streaming, pi-compatible
// ---------------------------------------------------------------------------

export async function complete(
  model: Model,
  context: Context,
  options?: LLMOptions,
): Promise<AssistantMessage> {
  const req = contextToRequest(model, context, options, false);
  const msg = baseMessage(model);
  try {
    const res = await callOpenRouter(req, callOptions(model, options));
    const choice = res.choices[0];
    msg.responseId = res.id;
    msg.responseModel = res.model;
    msg.usage = mapUsage(model, res.usage);
    msg.stopReason = mapStopReason(choice?.finish_reason);
    const rm = choice?.message;
    if (rm?.reasoning) msg.content.push({ type: "thinking", thinking: rm.reasoning });
    if (rm?.content) msg.content.push({ type: "text", text: rm.content });
    for (const tc of rm?.tool_calls ?? []) {
      msg.content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseArgs(tc.function.arguments),
      });
    }
    if (rm?.tool_calls?.length) msg.stopReason = "toolUse";
    return msg;
  } catch (err) {
    msg.stopReason = "error";
    msg.errorMessage = err instanceof Error ? err.message : String(err);
    return msg;
  }
}

/**
 * Key under which an UNPARSEABLE tool-call argument buffer is preserved.
 *
 * Providers stream tool arguments as JSON text fragments. If the stream is cut
 * off mid-arguments (usually `finish_reason: "length"`) or the model emits
 * invalid JSON, the accumulated buffer will not parse. Losing it silently is
 * worse than useless: the caller then sees a call with NO arguments and reports
 * "missing required argument 'x'", which is a lie — the model did send `x`. It
 * retries identically, fails identically, and loops.
 *
 * So the raw buffer is kept here, and callers use {@link isMalformedToolArgs} to
 * tell "never sent" apart from "sent but unreadable" and say which.
 */
export const MALFORMED_TOOL_ARGS_KEY = "_raw";

/** Whether a parsed argument object is actually an unparseable buffer. */
export function isMalformedToolArgs(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const keys = Object.keys(args);
  return keys.length === 1 && keys[0] === MALFORMED_TOOL_ARGS_KEY;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { [MALFORMED_TOOL_ARGS_KEY]: raw };
  }
}

// ---------------------------------------------------------------------------
// stream() — streaming, pi-compatible AssistantMessageEvent protocol
// ---------------------------------------------------------------------------

export function stream(
  model: Model,
  context: Context,
  options?: LLMOptions,
): AssistantMessageEventStream {
  return streamImpl(model, context, options);
}

async function* streamImpl(
  model: Model,
  context: Context,
  options?: LLMOptions,
): AsyncGenerator<AssistantMessageEvent> {
  const req = contextToRequest(model, context, options, true);
  const partial = baseMessage(model);
  yield { type: "start", partial };

  // Track in-progress content blocks by their content index.
  let textIndex = -1;
  let thinkingIndex = -1;
  // toolcall index (OpenRouter stream index) -> { contentIndex, argBuffer }
  const toolByIndex = new Map<number, { contentIndex: number; args: string }>();

  try {
    for await (const chunk of streamOpenRouter(req, callOptions(model, options))) {
      if (chunk.usage) partial.usage = mapUsage(model, chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta.reasoning) {
        if (thinkingIndex === -1) {
          thinkingIndex = partial.content.length;
          partial.content.push({ type: "thinking", thinking: "" });
          yield { type: "thinking_start", contentIndex: thinkingIndex, partial };
        }
        const block = partial.content[thinkingIndex] as { thinking: string };
        block.thinking += delta.reasoning;
        yield { type: "thinking_delta", contentIndex: thinkingIndex, delta: delta.reasoning, partial };
      }

      if (delta.content) {
        if (textIndex === -1) {
          textIndex = partial.content.length;
          partial.content.push({ type: "text", text: "" });
          yield { type: "text_start", contentIndex: textIndex, partial };
        }
        const block = partial.content[textIndex] as { text: string };
        block.text += delta.content;
        yield { type: "text_delta", contentIndex: textIndex, delta: delta.content, partial };
      }

      for (const tcDelta of delta.tool_calls ?? []) {
        let entry = toolByIndex.get(tcDelta.index);
        if (!entry) {
          const contentIndex = partial.content.length;
          const call: ToolCall = {
            type: "toolCall",
            id: tcDelta.id ?? `call_${tcDelta.index}`,
            name: tcDelta.function?.name ?? "",
            arguments: {},
          };
          partial.content.push(call);
          entry = { contentIndex, args: "" };
          toolByIndex.set(tcDelta.index, entry);
          yield { type: "toolcall_start", contentIndex, partial };
        }
        const call = partial.content[entry.contentIndex] as ToolCall;
        if (tcDelta.id) call.id = tcDelta.id;
        if (tcDelta.function?.name) call.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) {
          entry.args += tcDelta.function.arguments;
          yield {
            type: "toolcall_delta",
            contentIndex: entry.contentIndex,
            delta: tcDelta.function.arguments,
            partial,
          };
        }
      }

      if (choice.finish_reason) partial.stopReason = mapStopReason(choice.finish_reason);
    }

    // Finalize text/thinking blocks.
    if (thinkingIndex !== -1)
      yield {
        type: "thinking_end",
        contentIndex: thinkingIndex,
        content: (partial.content[thinkingIndex] as { thinking: string }).thinking,
        partial,
      };
    if (textIndex !== -1)
      yield {
        type: "text_end",
        contentIndex: textIndex,
        content: (partial.content[textIndex] as { text: string }).text,
        partial,
      };
    // Finalize tool calls (parse accumulated arg buffers).
    for (const entry of toolByIndex.values()) {
      const call = partial.content[entry.contentIndex] as ToolCall;
      call.arguments = safeParseArgs(entry.args);
      yield { type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: call, partial };
    }
    if (toolByIndex.size > 0) partial.stopReason = "toolUse";

    const reason = partial.stopReason === "toolUse" ? "toolUse" : partial.stopReason === "length" ? "length" : "stop";
    yield { type: "done", reason, message: partial };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    partial.stopReason = aborted ? "aborted" : "error";
    partial.errorMessage = err instanceof Error ? err.message : String(err);
    yield { type: "error", reason: aborted ? "aborted" : "error", error: partial };
  }
}

// ---------------------------------------------------------------------------
// LLMBridge implementation
// ---------------------------------------------------------------------------

export interface OpenRouterBridgeOptions {
  /**
   * Credential for every request this bridge makes.
   *
   * A function is resolved per request, which matters when the credential is a
   * short-lived token: a host whose JWT is renewed on a timer would otherwise
   * hold the value captured at construction for the whole lifetime of the
   * bridge, and every turn after expiry would 401 mid-run.
   */
  apiKey?: string | (() => string | undefined);
  baseUrl?: string;
  headers?: Record<string, string>;
}

export class OpenRouterBridge implements LLMBridge {
  constructor(private readonly opts: OpenRouterBridgeOptions = {}) {}

  /** Resolve a possibly-callable credential. Errors are left to the caller's
   *  request, which fails with the provider's own 401 rather than a throw from
   *  deep inside option merging. */
  private resolveApiKey(): string | undefined {
    const { apiKey } = this.opts;
    if (typeof apiKey !== "function") return apiKey;
    try {
      return apiKey();
    } catch {
      return undefined;
    }
  }

  private mergeOptions(options?: LLMOptions): LLMOptions {
    return {
      ...options,
      apiKey: options?.apiKey ?? this.resolveApiKey(),
      headers: { ...this.opts.headers, ...options?.headers },
    };
  }

  private applyBaseUrl(model: Model): Model {
    return this.opts.baseUrl ? { ...model, baseUrl: this.opts.baseUrl } : model;
  }

  complete(model: Model, context: Context, options?: LLMOptions): Promise<AssistantMessage> {
    return complete(this.applyBaseUrl(model), context, this.mergeOptions(options));
  }

  stream(model: Model, context: Context, options?: LLMOptions): AssistantMessageEventStream {
    return stream(this.applyBaseUrl(model), context, this.mergeOptions(options));
  }

  resolveModel(slug: string): Model {
    return this.applyBaseUrl(resolveModel(slug));
  }
}
