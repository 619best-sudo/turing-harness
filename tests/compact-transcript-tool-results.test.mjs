// Regression: in `compact` transcript mode the render transcript
// (`agent.state.messages`) must still carry each turn's TOOL RESULTS.
//
// `state.messages` is the host-facing render transcript (see docs/pi-migration.md).
// A host renders a read's file body / an edit's diff from the tool RESULT paired
// with the tool CALL. Dropping results in compact mode left hosts with tool-call
// strips that have nothing to expand once a run completed.
import assert from "node:assert/strict";
import test from "node:test";
import { HarnessAgent } from "../dist/index.js";

function fakeHost() {
  const listeners = new Set();
  return {
    threadSnapshot: undefined,
    orchestrator: { setModel() {}, setReasoning() {} },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

/** One assistant turn that calls `read`, plus that call's tool result. */
function turnEndEvent() {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/repo/a.ts" } }],
      model: "x",
      api: "openrouter",
      provider: "x",
      stopReason: "tool_use",
      timestamp: 0,
    },
    toolResults: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "1\tconst a = 1" }],
        details: { path: "/repo/a.ts", lineCount: 1 },
        isError: false,
        timestamp: 0,
      },
    ],
  };
}

for (const transcriptMode of ["full", "compact"]) {
  test(`${transcriptMode} transcript keeps tool results paired with their tool call`, () => {
    const host = fakeHost();
    const agent = new HarnessAgent(host, { transcriptMode });
    host.emit(turnEndEvent());

    const { messages } = agent.state;
    const call = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .find((c) => c.type === "toolCall");
    const result = messages.find((m) => m.role === "toolResult");

    assert.ok(call, "the tool call must be in the render transcript");
    assert.ok(result, "the tool RESULT must be in the render transcript");
    // The host pairs them by id to render the expandable body.
    assert.equal(result.toolCallId, call.id);
    assert.equal(result.details.path, "/repo/a.ts");
  });
}
