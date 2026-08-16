/**
 * A short-lived credential must be resolved per request, not captured once.
 *
 * Run via: npm test (which builds first, then runs `node --test`).
 *
 * A host proxying through its own backend authenticates with the signed-in
 * user's JWT, which its auth layer renews on a timer (~15 minutes). When the
 * bridge captured that string at construction, every turn after expiry 401'd:
 * the renewal reached the credential store but never the in-flight run, so a
 * long agent run died partway through for a token that had already been
 * replaced.
 *
 * These pin the contract: a function is called on every request and its current
 * value is what ships, while a plain string keeps working unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterBridge } from "../dist/index.js";

const CONTEXT = { messages: [{ role: "user", content: "hi" }] };

/** Capture the Authorization header of every request the bridge makes. */
function recordingFetch(sent) {
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers.authorization);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "1",
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    };
  };
}

test("a callable credential is resolved on every request, so a rotation lands on the next turn", async () => {
  const sent = [];
  recordingFetch(sent);

  let token = "jwt-first";
  const bridge = new OpenRouterBridge({ apiKey: () => token, baseUrl: "https://host/turing-machine" });
  const model = bridge.resolveModel("some/model");

  await bridge.complete(model, CONTEXT);
  // The renewal the host's auth timer would perform mid-run.
  token = "jwt-renewed";
  await bridge.complete(model, CONTEXT);

  assert.deepEqual(sent, ["Bearer jwt-first", "Bearer jwt-renewed"]);
});

test("a string credential still works and is sent unchanged", async () => {
  const sent = [];
  recordingFetch(sent);

  const bridge = new OpenRouterBridge({ apiKey: "static-key" });
  const model = bridge.resolveModel("some/model");

  await bridge.complete(model, CONTEXT);
  await bridge.complete(model, CONTEXT);

  assert.deepEqual(sent, ["Bearer static-key", "Bearer static-key"]);
});

test("a per-call apiKey still overrides the bridge default", async () => {
  const sent = [];
  recordingFetch(sent);

  const bridge = new OpenRouterBridge({ apiKey: () => "from-resolver" });
  const model = bridge.resolveModel("some/model");

  await bridge.complete(model, CONTEXT, { apiKey: "explicit" });

  assert.deepEqual(sent, ["Bearer explicit"]);
});

test("a throwing resolver does not crash the run — the request fails on the provider's own 401", async () => {
  const sent = [];
  recordingFetch(sent);

  const bridge = new OpenRouterBridge({
    apiKey: () => {
      throw new Error("credential store unavailable");
    },
  });
  const model = bridge.resolveModel("some/model");

  await bridge.complete(model, CONTEXT);

  // No authorization header rather than a throw from inside option merging:
  // the caller sees the provider's 401, which the host already classifies.
  assert.deepEqual(sent, [undefined]);
});
