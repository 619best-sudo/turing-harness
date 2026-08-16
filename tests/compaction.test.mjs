/**
 * Context compaction: keep a long run alive instead of letting the provider end it.
 *
 * Bounding each tool result stops ONE result from killing a run (that was the
 * 11.3 MB grep → `413`). It does nothing about forty bounded results, which add
 * up to the same rejection with no partial credit. A turn cap "fixes" that by
 * truncating short runs to protect long ones; compaction trades only the
 * verbatim transcript of early work, which the model has already extracted what
 * it needs from.
 *
 * The trap these tests exist for: a `toolResult` is only valid immediately after
 * the assistant message whose call it answers. Cut the history at the wrong
 * index and the provider rejects the request outright — turning a recoverable
 * size problem into a hard failure. Every cut must land on a turn boundary.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPACTION_ENV_VAR,
  compactHistory,
  findCutIndex,
  historySize,
  pruneHistoricalMedia,
  resolveCompactionThreshold,
} from "../dist/index.js";

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A summariser that records what it was asked to compact. */
function summarizer(text = "Read src/a.ts (exports foo). Tests pass. Remaining: wire the route.") {
  const seen = [];
  return {
    seen,
    complete: async (_m, ctx) => {
      seen.push(ctx.messages[0].content);
      return {
        role: "assistant", content: [{ type: "text", text }],
        model: "m", api: "openrouter", provider: "t",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    },
  };
}

/** A realistic history: opening message, then N assistant+toolResult turns. */
function history(turns, filler = 4000) {
  const out = [{ role: "user", content: "TASK: build the thing", timestamp: 0 }];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/f${i}.ts` } }],
      timestamp: 0,
    });
    out.push({
      role: "toolResult",
      toolCallId: `c${i}`,
      toolName: "read",
      content: [{ type: "text", text: `contents ${i} ${"x".repeat(filler)}` }],
      isError: false,
      timestamp: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The correctness trap.
// ---------------------------------------------------------------------------

test("never cuts so that a toolResult loses the call it answers", async () => {
  const messages = history(40);
  const llm = summarizer();
  const { messages: out, compacted } = await compactHistory({
    messages, llm, model: { id: "m" }, threshold: 10_000,
  });
  assert.ok(compacted);

  // Every kept toolResult must be preceded by an assistant message.
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "toolResult") {
      assert.ok(i > 0 && out[i - 1].role === "assistant", `orphaned toolResult at ${i}`);
    }
  }
});

test("findCutIndex refuses to cut on a toolResult", () => {
  const messages = history(3);
  for (let from = 0; from < messages.length; from++) {
    const idx = findCutIndex(messages, from);
    if (idx >= 0) assert.notEqual(messages[idx].role, "toolResult");
  }
});

test("returns unchanged when no safe cut exists", async () => {
  // All-toolResult tail: compacting would orphan them, so it must not happen.
  const messages = [
    { role: "user", content: "t", timestamp: 0 },
    ...Array.from({ length: 6 }, (_, i) => ({
      role: "toolResult", toolCallId: `c${i}`, toolName: "read",
      content: [{ type: "text", text: "y".repeat(50_000) }], isError: false, timestamp: 0,
    })),
  ];
  const { compacted } = await compactHistory({
    messages, llm: summarizer(), model: { id: "m" }, threshold: 1000,
  });
  assert.equal(compacted, false);
});

// ---------------------------------------------------------------------------
// What it keeps.
// ---------------------------------------------------------------------------

test("compacts a large history and actually shrinks it", async () => {
  const messages = history(40);
  const before = historySize(messages);
  const { messages: out, compacted, savedChars } = await compactHistory({
    messages, llm: summarizer(), model: { id: "m" }, threshold: 10_000,
  });
  assert.ok(compacted);
  assert.ok(historySize(out) < before);
  assert.equal(savedChars, before - historySize(out));
});

test("keeps the opening message — a run that forgets the task is worse than a big one", async () => {
  const messages = history(40);
  const { messages: out } = await compactHistory({
    messages, llm: summarizer(), model: { id: "m" }, threshold: 10_000,
  });
  assert.equal(out[0].content, "TASK: build the thing");
});

test("keeps recent turns verbatim — they are what the model is reasoning against", async () => {
  const messages = history(40);
  const { messages: out } = await compactHistory({
    messages, llm: summarizer(), model: { id: "m" }, threshold: 10_000,
  });
  const lastOriginal = JSON.stringify(messages[messages.length - 1]);
  assert.equal(JSON.stringify(out[out.length - 1]), lastOriginal);
});

test("the summary is labelled as already-done work, so it is not redone", async () => {
  const messages = history(40);
  const { messages: out } = await compactHistory({
    messages, llm: summarizer(), model: { id: "m" }, threshold: 10_000,
  });
  const summary = out[1].content;
  assert.match(summary, /\[COMPACTED CONTEXT\]/);
  assert.match(summary, /work ALREADY DONE and do not redo it/);
  // The post-compaction failure is misplaced confidence, not forgetting: the
  // summary still describes files whose contents are gone.
  assert.match(summary, /`read` it again/);
  assert.match(summary, /an anchor you remember is not an anchor on disk/);
  assert.match(summary, /do not claim anything listed as unverified has been verified/);
  assert.match(summary, /wire the route/, "the summariser's content survives");
});

// ---------------------------------------------------------------------------
// When it must do nothing.
// ---------------------------------------------------------------------------

test("under threshold, nothing happens and no model call is made", async () => {
  const llm = summarizer();
  const messages = history(2, 10);
  const { compacted } = await compactHistory({ messages, llm, model: { id: "m" }, threshold: 1_000_000 });
  assert.equal(compacted, false);
  assert.equal(llm.seen.length, 0, "no round trip paid for nothing");
});

test("a failing summariser degrades to carrying the big context, not a broken one", async () => {
  const failing = { complete: async () => { throw new Error("provider down") } };
  const messages = history(40);
  const { messages: out, compacted } = await compactHistory({
    messages, llm: failing, model: { id: "m" }, threshold: 10_000,
  });
  assert.equal(compacted, false);
  assert.equal(out, messages, "the original history is returned untouched");
});

test("an errored summariser reply is treated as failure, not as a summary", async () => {
  const errored = {
    complete: async () => ({
      role: "assistant", content: [], model: "m", api: "openrouter", provider: "t",
      usage: zeroUsage(), stopReason: "error", errorMessage: "429", timestamp: 0,
    }),
  };
  const { compacted } = await compactHistory({
    messages: history(40), llm: errored, model: { id: "m" }, threshold: 10_000,
  });
  assert.equal(compacted, false);
});

// ---------------------------------------------------------------------------
// The env knob.
// ---------------------------------------------------------------------------

test("the threshold comes from the env var, with a sane default", () => {
  assert.equal(resolveCompactionThreshold({}), 300_000);
  assert.equal(resolveCompactionThreshold({ [COMPACTION_ENV_VAR]: "50000" }), 50_000);
});

test("zero or negative disables compaction; a typo does NOT", () => {
  assert.equal(resolveCompactionThreshold({ [COMPACTION_ENV_VAR]: "0" }), Infinity);
  assert.equal(resolveCompactionThreshold({ [COMPACTION_ENV_VAR]: "-1" }), Infinity);
  // A typo falling through to "disabled" would silently remove the protection
  // that keeps long runs alive — the default is the safer failure.
  assert.equal(resolveCompactionThreshold({ [COMPACTION_ENV_VAR]: "lots" }), 300_000);
  assert.equal(resolveCompactionThreshold({ [COMPACTION_ENV_VAR]: "" }), 300_000);
});

// ---------------------------------------------------------------------------
// End to end through the real loop.
// ---------------------------------------------------------------------------

test("the loop compacts mid-run and keeps going", async () => {
  const { LogStore, OpenRouterBridge, PermissionGate, runToolLoop } = await import("../dist/index.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compact-loop-"));

  // A tool that returns a lot each time, so the history crosses the threshold.
  // Distinct args per call: identical ones would (correctly) trip StallGuard,
  // which is a different mechanism and not what this test is about.
  const chatty = {
    name: "chatty",
    description: "x",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    async execute(_id, args) {
      return { output: `call ${args.n}\n` + "z".repeat(20_000) };
    },
  };

  const sizes = [];
  const llm = new OpenRouterBridge();
  llm.complete = async (_m, ctx) => ({
    role: "assistant",
    content: [{ type: "text", text: "Earlier: called chatty repeatedly; nothing outstanding." }],
    model: "m", api: "openrouter", provider: "t",
    usage: zeroUsage(), stopReason: "stop", timestamp: 0,
  });
  let turn = 0;
  llm.stream = async function* (_m, ctx) {
    sizes.push(historySize(ctx.messages));
    turn += 1;
    yield { type: "start", partial: { role: "assistant", content: [], model: "m", api: "openrouter", provider: "t", usage: zeroUsage(), stopReason: "stop", timestamp: 0 } };
    if (turn <= 8) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `c${turn}`, name: "chatty", arguments: { n: turn } }],
          model: "m", api: "openrouter", provider: "t", usage: zeroUsage(), stopReason: "tool_use", timestamp: 0,
        },
      };
      return;
    }
    yield {
      type: "done",
      message: {
        role: "assistant", content: [{ type: "text", text: "done" }],
        model: "m", api: "openrouter", provider: "t", usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
  };

  const result = await runToolLoop({
    task: "t",
    userMessage: "go",
    tools: [chatty],
    model: { id: "m", openRouterSlug: "m" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: dir,
    compactThresholdChars: 60_000,
  });

  assert.ok(!result.error, `loop finished cleanly: ${result.error ?? ""}`);
  // Growth is bounded: without compaction the last request would be ~8x20k.
  assert.ok(Math.max(...sizes) < 200_000, `peak context ${Math.max(...sizes)}`);
  // And it actually shrank at least once rather than growing monotonically.
  assert.ok(sizes.some((s, i) => i > 0 && s < sizes[i - 1]), `sizes: ${sizes.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Is the summary good enough to CONTINUE from?
//
// A readable recap of what happened is useless to an agent mid-task. These pin
// the sections whose loss breaks the next turn in a specific way.
// ---------------------------------------------------------------------------

test("the summary prompt demands everything the next turn needs", async () => {
  // Reach the prompt through a capturing bridge rather than exporting it: what
  // matters is what the model is actually sent.
  let systemPrompt = "";
  const capturing = {
    complete: async (_m, ctx) => {
      systemPrompt = ctx.systemPrompt ?? "";
      return {
        role: "assistant", content: [{ type: "text", text: "s" }],
        model: "m", api: "openrouter", provider: "t",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    },
  };
  await compactHistory({ messages: history(40), llm: capturing, model: { id: "m" }, threshold: 10_000 });

  for (const [label, re] of [
    ["plan + step status", /which are DONE \/ IN PROGRESS \/ NOT STARTED/],
    ["verbatim user instructions", /quote them VERBATIM/],
    ["why paraphrase is unsafe", /permits exactly\s+what the user ruled out/],
    ["files by exact path", /FILES touched, by exact path/],
    ["dead ends", /DEAD ENDS/],
    ["command results", /tests passing or failing \(which ones\)/],
    ["verified vs assumed", /VERIFIED vs ASSUMED/],
    ["runtime facts", /dev server already running and on which port/],
    ["open questions", /OPEN QUESTIONS asked of the user/],
    ["the next action", /NEXT: the immediate next action/],
  ]) {
    assert.match(systemPrompt, re, `missing: ${label}`);
  }
});

test("the summariser must not paste file contents back in", async () => {
  // Reproducing files would defeat the compaction that called for it.
  let systemPrompt = "";
  const capturing = {
    complete: async (_m, ctx) => {
      systemPrompt = ctx.systemPrompt ?? "";
      return {
        role: "assistant", content: [{ type: "text", text: "s" }],
        model: "m", api: "openrouter", provider: "t",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      };
    },
  };
  await compactHistory({ messages: history(40), llm: capturing, model: { id: "m" }, threshold: 10_000 });
  assert.match(systemPrompt, /Do NOT reproduce file contents/);
  assert.match(systemPrompt, /the agent re-reads it when it needs the bytes/);
  assert.match(systemPrompt, /under ~600 words/, "bounded, or it defeats compaction");
});

// ---------------------------------------------------------------------------
// Screenshots must not trigger compaction (the re-ask loop).
//
// A run edited a title, then ran activity_inspect / browser_take_screenshot for
// verification. The screenshots arrived as base64 image blocks, and historySize
// counted every base64 byte, so 2-3 captures blew the 300k threshold. Compaction
// summarised away the user's ask_user answer + the completed edit, the model
// "forgot" it had already done the work, and re-asked the same question. These
// pin the two fixes: historySize ignores base64, and old captures are pruned.
// ---------------------------------------------------------------------------

test("historySize does NOT count base64 image bytes — a screenshot is a fixed allowance", () => {
  // A 2 MB base64 screenshot in an otherwise tiny message.
  const huge = "x".repeat(2_000_000);
  const withImage = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: huge, mimeType: "image/png" }], timestamp: 0 },
  ];
  const withoutImage = [{ role: "user", content: [{ type: "text", text: "look" }], timestamp: 0 }];
  // The image adds only a small fixed allowance, not 2 MB.
  const diff = historySize(withImage) - historySize(withoutImage);
  assert.ok(diff < 10_000, `image added ${diff} chars (base64 leaked into the size estimate)`);
  assert.ok(diff > 0, "the image still counts as a non-zero allowance");
});

test("a screenshot-heavy history does not trip compaction off the images alone", async () => {
  // Small text context + several large screenshots. Before the fix this was
  // millions of chars (base64) and compacted; now it is small and must NOT compact.
  const big = "x".repeat(500_000);
  const messages = [
    { role: "user", content: "TASK: edit the title", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: {} }], timestamp: 0 },
    { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false, timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "screenshot" }, { type: "image", data: big, mimeType: "image/png" }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "screenshot 2" }, { type: "image", data: big, mimeType: "image/png" }], timestamp: 0 },
  ];
  assert.ok(historySize(messages) < 10_000, "screenshots alone no longer inflate historySize");
  const { compacted } = await compactHistory({ messages, llm: summarizer(), model: { id: "m" }, threshold: 300_000 });
  assert.equal(compacted, false, "no compaction fired for a screenshot-heavy, text-light history");
});

test("pruneHistoricalMedia keeps only the last 2 captures and marks the rest", () => {
  const img = (n) => ({ type: "image", data: "x".repeat(1000), mimeType: "image/png", n });
  const messages = [
    { role: "user", content: [{ type: "text", text: "cap1" }, img(1)], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "cap2" }, img(2)], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "cap3" }, img(3)], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "cap4" }, img(4)], timestamp: 0 },
  ];
  const pruned = pruneHistoricalMedia(messages);
  assert.equal(pruned, 2, "the two oldest captures were pruned");
  // The two most recent (3 and 4) keep their image blocks.
  const kept = messages.filter((m) => m.content.some((b) => b.type === "image"));
  assert.deepEqual(kept.map((m) => m.content.find((b) => b.type === "image").n), [3, 4]);
  // The pruned ones carry the marker instead.
  assert.ok(messages[0].content.some((b) => b.type === "text" && /omitted from history/.test(b.text)));
  assert.ok(!messages[0].content.some((b) => b.type === "image"));
});

test("pruneHistoricalMedia leaves a history with <=2 captures untouched", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "cap1" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "cap2" }, { type: "image", data: "y", mimeType: "image/png" }], timestamp: 0 },
  ];
  assert.equal(pruneHistoricalMedia(messages), 0);
  assert.equal(messages.filter((m) => m.content.some((b) => b.type === "image")).length, 2);
});

test("historySize and prune cover AUDIO and VIDEO too, not just images", () => {
  // A huge base64 audio clip and a video clip must not inflate historySize, and
  // must be pruned like screenshots — the same bloat/compaction bug applies.
  const big = "x".repeat(800_000);
  const withMedia = [
    { role: "user", content: "task", timestamp: 0 },
    { role: "user", content: [{ type: "audio", data: big, mimeType: "audio/mpeg" }], timestamp: 0 },
    { role: "user", content: [{ type: "video", data: big, mimeType: "video/mp4" }], timestamp: 0 },
  ];
  assert.ok(historySize(withMedia) < 10_000, "audio/video base64 did not inflate historySize");

  // Pruning: 4 media-bearing messages (image, audio, video, image) → keep last 2.
  const messages = [
    { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: 0 },
    { role: "user", content: [{ type: "audio", data: "x", mimeType: "audio/mpeg" }], timestamp: 0 },
    { role: "user", content: [{ type: "video", data: "x", mimeType: "video/mp4" }], timestamp: 0 },
    { role: "user", content: [{ type: "image", data: "y", mimeType: "image/png" }], timestamp: 0 },
  ];
  const pruned = pruneHistoricalMedia(messages);
  assert.equal(pruned, 2, "the two oldest media blocks were pruned");
  // The oldest two (image, audio) are now text markers; the newest two kept.
  assert.ok(!messages[0].content.some((b) => b.type === "image"));
  assert.ok(!messages[1].content.some((b) => b.type === "audio"));
  assert.ok(messages[2].content.some((b) => b.type === "video"));
  assert.ok(messages[3].content.some((b) => b.type === "image"));
});

test("prune leaves path/uri-only media blocks alone (they are small and useful)", () => {
  // A media block carrying only a `uri` (no base64) is already path-based — it
  // must NOT be pruned (it is how a materialised capture should travel).
  const messages = [
    { role: "user", content: [{ type: "file", uri: "/p/a.mp3", mimeType: "audio/mpeg" }], timestamp: 0 },
    { role: "user", content: [{ type: "file", uri: "/p/b.mp4", mimeType: "video/mp4" }], timestamp: 0 },
    { role: "user", content: [{ type: "file", uri: "/p/c.png", mimeType: "image/png" }], timestamp: 0 },
  ];
  assert.equal(pruneHistoricalMedia(messages), 0, "uri-only blocks have no base64 to prune");
  assert.equal(messages.filter((m) => m.content.some((b) => b.type === "file")).length, 3);
});
