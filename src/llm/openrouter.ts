/**
 * OpenRouter-compatible request/response layer (req #5).
 *
 * OpenRouter speaks the OpenAI Chat Completions dialect, so the request/response
 * shapes here double as "OpenAI-compatible" and work against any OpenAI-compatible
 * endpoint by swapping `baseUrl`. This module is the single low-level API-call
 * function the whole harness routes model traffic through.
 */

// ---------------------------------------------------------------------------
// Request shape (OpenRouter / OpenAI chat completions)
// ---------------------------------------------------------------------------

export interface ORTextPart {
  type: "text";
  text: string;
}
export interface ORImagePart {
  type: "image_url";
  image_url: { url: string };
}
export interface ORAudioPart {
  type: "input_audio";
  input_audio: { data: string; format: string };
}
export interface ORFilePart {
  type: "file";
  file: { filename: string; file_data: string };
}
export type ORContentPart = ORTextPart | ORImagePart | ORAudioPart | ORFilePart;

export interface ORToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ORMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ORContentPart[] | null;
  name?: string;
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
  /** OpenRouter/DeepSeek-style reasoning echo, replayed for multi-turn continuity. */
  reasoning?: string;
}

export interface ORTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Provider-routing preferences, passed straight through to OpenRouter. */
export interface ORProviderRouting {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  only?: string[];
  ignore?: string[];
  sort?: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: ORMessage[];
  tools?: ORTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** OpenRouter reasoning control. */
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high"; max_tokens?: number; exclude?: boolean };
  provider?: ORProviderRouting;
  /** Ask OpenRouter to include usage in the final streamed chunk. */
  stream_options?: { include_usage: boolean };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface ORUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

export interface ORResponseMessage {
  role: "assistant";
  content: string | null;
  reasoning?: string | null;
  tool_calls?: ORToolCall[];
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: ORResponseMessage;
    finish_reason: string | null;
  }>;
  usage?: ORUsage;
}

// ---------------------------------------------------------------------------
// Streaming chunk shape
// ---------------------------------------------------------------------------

export interface ORStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenRouterStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: ORStreamToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: ORUsage;
}

// ---------------------------------------------------------------------------
// The call function
// ---------------------------------------------------------------------------

export interface CallOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function buildHeaders(opts: CallOptions): Record<string, string> {
  const apiKey =
    opts.apiKey ??
    (typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined) ??
    "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // OpenRouter attribution headers (optional but recommended).
    "http-referer": "https://github.com/turing/harness",
    "x-title": "turing-harness",
    ...opts.headers,
  };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function resolveUrl(opts: CallOptions): string {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}/chat/completions`;
}

/** Non-streaming call. Returns the full parsed OpenRouter response. */
export async function callOpenRouter(
  request: OpenRouterRequest,
  opts: CallOptions = {},
): Promise<OpenRouterResponse> {
  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer =
    controller && opts.timeoutMs
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : undefined;
  // Chain the user signal into our timeout controller.
  if (controller && opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(resolveUrl(opts), {
      method: "POST",
      headers: buildHeaders(opts),
      body: JSON.stringify({ ...request, stream: false }),
      signal: controller?.signal ?? opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new OpenRouterError(`OpenRouter request failed (${res.status})`, res.status, body);
    }
    return (await res.json()) as OpenRouterResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Streaming call. Yields parsed SSE chunks until `[DONE]`.
 * Works in Node 18+ and Electron (uses the standard `fetch` streaming body).
 */
export async function* streamOpenRouter(
  request: OpenRouterRequest,
  opts: CallOptions = {},
): AsyncGenerator<OpenRouterStreamChunk> {
  const res = await fetch(resolveUrl(opts), {
    method: "POST",
    headers: buildHeaders(opts),
    body: JSON.stringify({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new OpenRouterError(
      `OpenRouter stream failed (${res.status})`,
      res.status,
      body,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** Parse one SSE frame; returns true if a [DONE] sentinel was seen. */
  function parseFrame(frame: string, out: OpenRouterStreamChunk[]): boolean {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return true;
      if (!payload) continue;
      try {
        out.push(JSON.parse(payload) as OpenRouterStreamChunk);
      } catch {
        // OpenRouter occasionally emits `: OPENROUTER PROCESSING` comments; skip.
      }
    }
    return false;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize CRLF so frame splitting works regardless of line endings.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const chunks: OpenRouterStreamChunk[] = [];
        const isDone = parseFrame(frame, chunks);
        for (const c of chunks) yield c;
        if (isDone) return;
      }
    }
    // Flush the decoder and process any final frame that lacked a trailing blank
    // line (e.g. a usage-only chunk at end-of-stream).
    buffer += decoder.decode().replace(/\r\n/g, "\n");
    if (buffer.trim()) {
      const chunks: OpenRouterStreamChunk[] = [];
      parseFrame(buffer, chunks);
      for (const c of chunks) yield c;
    }
  } finally {
    reader.releaseLock();
  }
}
