/**
 * Transient upstream failures must not destroy a run.
 *
 * Run via: npm test (which builds first, then runs `node --test`).
 *
 * A real session died with `OpenRouter stream failed (502)` partway through a
 * browser automation — a dozen navigations and snapshots of real work thrown
 * away for a provider hiccup that would have succeeded on the next attempt. The
 * app already classified 5xx as `retryable: true`; nothing acted on it.
 *
 * These pin the boundary: retry what is genuinely transient, never retry what
 * will fail identically, and never retry a user abort.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { streamOpenRouter, callOpenRouter, OpenRouterError } from "../dist/index.js";

const REQUEST = { model: "m", messages: [{ role: "user", content: "hi" }] };
const OPTS = { apiKey: "k", maxAttempts: 3 };

/** An SSE body carrying one content chunk then [DONE]. */
function sseBody() {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const bytes = new TextEncoder().encode(frames);
  return {
    getReader() {
      let done = false;
      return {
        read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })),
        releaseLock() {},
        cancel: async () => {},
      };
    },
  };
}

function statusResponse(status) {
  return { ok: false, status, body: null, text: async () => `upstream ${status}` };
}

function okStream() {
  return { ok: true, status: 200, body: sseBody() };
}

async function drain(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

test("a 502 on stream open is retried and the run survives", async () => {
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(1);
    return calls.length < 3 ? statusResponse(502) : okStream();
  };

  const chunks = await drain(streamOpenRouter(REQUEST, OPTS));

  assert.equal(calls.length, 3, "should have retried twice before succeeding");
  assert.equal(chunks[0]?.choices?.[0]?.delta?.content, "ok");
});

test("retries are bounded and the last error surfaces", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return statusResponse(503);
  };

  await assert.rejects(
    () => drain(streamOpenRouter(REQUEST, OPTS)),
    (err) => err instanceof OpenRouterError && err.status === 503,
  );
  assert.equal(calls, 3, "must stop at maxAttempts, not retry forever");
});

test("a 400 is not retried — it will fail identically", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return statusResponse(400);
  };

  await assert.rejects(() => drain(streamOpenRouter(REQUEST, OPTS)));
  assert.equal(calls, 1, "client errors must not be retried");
});

test("a 401 is not retried — a bad key stays bad", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return statusResponse(401);
  };

  await assert.rejects(() => drain(streamOpenRouter(REQUEST, OPTS)));
  assert.equal(calls, 1);
});

test("a user abort is never retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  };

  await assert.rejects(() => drain(streamOpenRouter(REQUEST, OPTS)));
  assert.equal(calls, 1, "aborting is the user's decision, not a transient fault");
});

test("a network-level failure is retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 2) throw new Error("fetch failed");
    return okStream();
  };

  const chunks = await drain(streamOpenRouter(REQUEST, OPTS));
  assert.equal(calls, 2);
  assert.equal(chunks.length > 0, true);
});

test("maxAttempts: 1 disables retrying", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return statusResponse(502);
  };

  await assert.rejects(() => drain(streamOpenRouter(REQUEST, { ...OPTS, maxAttempts: 1 })));
  assert.equal(calls, 1);
});

test("the non-streaming call retries transient failures too", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return statusResponse(500);
    return { ok: true, status: 200, json: async () => ({ id: "x", choices: [] }) };
  };

  const res = await callOpenRouter(REQUEST, OPTS);
  assert.equal(calls, 3);
  assert.equal(res.id, "x");
});

/**
 * A model that cannot see must not be sent an image.
 *
 * `browser_take_screenshot` produces an image content block. Serialising it for
 * a text-only model makes the provider reject the ENTIRE request, so a browser
 * session loses every turn of work that preceded the screenshot. The catalog
 * claimed the default model accepted images; OpenRouter says it is text-only.
 */
test("an image is replaced with a note for a text-only model", async () => {
  const { contextToRequest, resolveModel } = await import("../dist/index.js");

  const context = {
    systemPrompt: "s",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is on screen?" },
          { type: "image", mimeType: "image/png", data: "aGk=" },
        ],
      },
    ],
    tools: [],
  };

  const textOnly = resolveModel("xiaomi/mimo-v2.5");
  assert.deepEqual(textOnly.input, ["text"], "catalog must reflect the real modalities");

  const req = contextToRequest(textOnly, context);
  const parts = req.messages.at(-1).content;
  assert.equal(
    parts.some((p) => p.type === "image_url"),
    false,
    "no image may be sent to a text-only model",
  );
  assert.match(
    parts.map((p) => p.text ?? "").join(" "),
    /image omitted/,
    "the model should be told an image existed",
  );
});

test("an image still reaches a vision-capable model", async () => {
  const { contextToRequest, resolveModel } = await import("../dist/index.js");

  const context = {
    systemPrompt: "s",
    messages: [
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGk=" }] },
    ],
    tools: [],
  };

  const vision = resolveModel("anthropic/claude-sonnet-4.5");
  const req = contextToRequest(vision, context);
  assert.equal(
    req.messages.at(-1).content.some((p) => p.type === "image_url"),
    true,
    "gating must not break models that genuinely accept images",
  );
});

// ---------------------------------------------------------------------------
// A provider error has to SAY what was wrong
// ---------------------------------------------------------------------------

test("a provider error folds the response body into the message", () => {
  // The body used to be a field nothing read, so a 400 surfaced to the user as
  // `OpenRouter stream failed (400)` and nothing else — the one sentence that
  // explains it discarded one frame above where it was captured. Diagnosing a
  // live failure then meant bisecting config changes to recover a string the
  // harness already had.
  const err = new OpenRouterError(
    "OpenRouter stream failed (400)",
    400,
    JSON.stringify({ error: { message: "max_tokens is greater than the maximum allowed", code: 400 } }),
  );
  assert.match(err.message, /OpenRouter stream failed \(400\)/, "the status still leads");
  assert.match(err.message, /max_tokens is greater than the maximum allowed/, "and the reason follows");
  assert.equal(err.status, 400);
  assert.match(err.body, /max_tokens/, "the raw body is still available in full");
});

test("a non-JSON or empty body degrades without inventing detail", () => {
  const plain = new OpenRouterError("failed (500)", 500, "upstream timeout");
  assert.equal(plain.message, "failed (500): upstream timeout");

  const bare = new OpenRouterError("failed (500)", 500, "   ");
  assert.equal(bare.message, "failed (500)", "whitespace adds nothing");

  const none = new OpenRouterError("failed (500)", 500);
  assert.equal(none.message, "failed (500)");
});

test("a huge body is truncated rather than becoming the whole log line", () => {
  const err = new OpenRouterError("failed (400)", 400, "x".repeat(5000));
  assert.ok(err.message.length < 700, `message stayed bounded (${err.message.length})`);
  assert.equal(err.body.length, 5000, "the field keeps everything");
});
