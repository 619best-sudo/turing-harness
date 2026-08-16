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
  /**
   * How many times to attempt a request whose failure looks transient
   * (default 3). Set to 1 to disable retrying.
   */
  maxAttempts?: number;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * How much of a provider error body to put in the MESSAGE.
 *
 * Enough for the sentence that actually names the problem ("max_tokens is
 * greater than the maximum allowed", "not a valid model ID"), short enough that
 * a wall of provider JSON does not become the whole log line.
 */
const ERROR_BODY_IN_MESSAGE = 500;

/** The useful sentence out of a provider error body, or a trimmed excerpt. */
function summarizeErrorBody(body: string | undefined): string {
  const raw = (body ?? "").trim();
  if (!raw) return "";
  // OpenRouter returns `{ "error": { "message": "...", ... } }`. That message is
  // the entire diagnostic value of the response; everything else is envelope.
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : undefined;
    if (message) return message.slice(0, ERROR_BODY_IN_MESSAGE);
  } catch {
    // Not JSON — fall through and use the raw text.
  }
  return raw.slice(0, ERROR_BODY_IN_MESSAGE);
}

/**
 * A provider error, with the response body BOTH kept as a field and folded into
 * the message.
 *
 * The body used to be a field only, and nothing ever read it. A 400 therefore
 * reached the user as `OpenRouter stream failed (400)` and nothing else — a
 * status code with the one part that explains it discarded one frame up. The
 * body says things like "max_tokens is greater than the maximum allowed" or
 * "is not a valid model ID", which is the difference between a fix and a guess;
 * an observed run was reduced to bisecting config changes to recover a sentence
 * the harness already had in hand.
 */
export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    const detail = summarizeErrorBody(body);
    super(detail ? `${message}: ${detail}` : message);
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

function resolveUrl(opts: CallOptions, path = "/chat/completions"): string {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}${path}`;
}

/** Resolve the key the same way {@link buildHeaders} does, for callers that need
 *  to know whether a real call is even possible before attempting one. */
export function resolveOpenRouterApiKey(apiKey?: string): string | undefined {
  return (
    apiKey ??
    (typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined) ??
    undefined
  );
}

// ---------------------------------------------------------------------------
// Image generation (a separate endpoint, not chat/completions)
// ---------------------------------------------------------------------------

/**
 * Request body for OpenRouter's dedicated image endpoint.
 *
 * Deliberately open (`[key: string]: unknown`): per-model knobs (aspect ratio,
 * output format, seed, and Riverflow's own font/enhancement options) differ by
 * model, and inventing a fixed schema for them would silently drop whatever the
 * caller actually needs. Only `model` and `prompt` are universal.
 */
export interface OpenRouterImageRequest {
  model: string;
  prompt: string;
  /**
   * Reference images for image-to-image work (edit, remix, style transfer,
   * subject consistency). Each entry is
   * `{ type: "image_url", image_url: { url } }` where `url` is an `http(s)://`
   * URL or a `data:<mime>;base64,…` URL — the endpoint cannot read local paths.
   */
  input_references?: Array<Record<string, unknown>>;
  /** How many images to generate (1-10). The response's `data` array grows to match. */
  n?: number;
  [key: string]: unknown;
}

/** One generated image. `b64_json` holds raw base64 (NOT a `data:` URL). */
export interface OpenRouterImageData {
  b64_json?: string;
  media_type?: string;
  [key: string]: unknown;
}

export interface OpenRouterImageResponse {
  data?: OpenRouterImageData[];
  [key: string]: unknown;
}

/**
 * Generate images via `POST /images`.
 *
 * Separate from {@link callOpenRouter} because image generation is a different
 * endpoint with a different envelope — it returns `data[].b64_json`, not
 * `choices[].message`.
 */
export async function callOpenRouterImages(
  request: OpenRouterImageRequest,
  opts: CallOptions = {},
): Promise<OpenRouterImageResponse> {
  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer =
    controller && opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  if (controller && opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(resolveUrl(opts, "/images"), {
      method: "POST",
      headers: buildHeaders(opts),
      body: JSON.stringify(request),
      signal: controller?.signal ?? opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new OpenRouterError(
        `OpenRouter image request failed (${res.status})`,
        res.status,
        body,
      );
    }
    return (await res.json()) as OpenRouterImageResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  try {
    for (let attempt = 1; ; attempt += 1) {
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
      } catch (err) {
        // A non-streaming call is idempotent from our side, so retrying a
        // transient failure is always safe here.
        if (attempt >= maxAttempts || !isRetryableTransportError(err)) throw err;
        await sleep(retryDelayMs(attempt), opts.signal);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * HTTP statuses worth retrying: transient upstream/provider failures, not
 * anything caused by the request itself.
 *
 * A single 502 used to destroy an entire run. On a long tool session — a
 * browser automation with a dozen navigations and snapshots — that throws away
 * minutes of real work and every tool result gathered along the way, for a
 * provider hiccup that would have succeeded a second later. The app already
 * classified these as `retryable`; nothing acted on it.
 *
 * 4xx are excluded on purpose: a bad key, a missing model or an oversized
 * payload will fail identically however many times it is sent. 429 IS included
 * because it is genuinely time-based.
 */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * A transport-level failure (DNS, connection reset, socket hang-up). A user
 * abort is NOT one of these and must never be retried.
 */
function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof OpenRouterError) return isRetryableStatus(err.status ?? 0);
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminated/i.test(
      err.message,
    );
  }
  return false;
}

/** Exponential backoff with jitter, so concurrent runs do not retry in lockstep. */
function retryDelayMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Streaming call. Yields parsed SSE chunks until `[DONE]`.
 * Works in Node 18+ and Electron (uses the standard `fetch` streaming body).
 */
export async function* streamOpenRouter(
  request: OpenRouterRequest,
  opts: CallOptions = {},
): AsyncGenerator<OpenRouterStreamChunk> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Retry only the stream OPEN. Once the first chunk has been yielded the
  // consumer has already seen partial output, and replaying the request would
  // duplicate it — so a mid-stream failure still propagates.
  let res: Response | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(resolveUrl(opts), {
        method: "POST",
        headers: buildHeaders(opts),
        body: JSON.stringify({
          ...request,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: opts.signal,
      });
      if (res.ok && res.body) break;
      const body = await res.text().catch(() => "");
      throw new OpenRouterError(
        `OpenRouter stream failed (${res.status})`,
        res.status,
        body,
      );
    } catch (err) {
      const last = attempt >= maxAttempts;
      if (last || !isRetryableTransportError(err)) throw err;
      await sleep(retryDelayMs(attempt), opts.signal);
    }
  }
  if (!res.body) {
    throw new OpenRouterError("OpenRouter stream failed (no body)", res.status);
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
