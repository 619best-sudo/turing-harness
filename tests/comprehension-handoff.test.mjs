/**
 * The read→write hand-off: the model that UNDERSTOOD the file steers the model
 * that WRITES it.
 *
 * Two independent escalations existed and never spoke. `read` rated a file's
 * difficulty for itself and escalated to a stronger model for an analysis;
 * `write`/`edit` escalated to an authoring model driven by the ORCHESTRATOR's
 * self-declared `complexity` argument. So the strong model's understanding
 * reached the author, if at all, as the weaker model's paraphrase of it — and the
 * authoring effort was set by a claim from the model that had done the least
 * reading.
 *
 * Worse, the escalation itself was half-inert: `comprehendFile` bounded the call
 * with `reasoningMaxTokens`, which `authoring.ts` had already documented as
 * near-meaningless for OpenAI-family models. The stronger model was being paid
 * for and then asked to think at the provider default — the same effort the
 * orchestrator runs at.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearComprehensionMemory,
  comprehendFile,
  coversRange,
  forgetComprehension,
  hashContent,
  rateFileComplexity,
  recallComprehension,
  rememberComprehension,
} from "../dist/tools/builtin/comprehension.js";
import { authorFileContent } from "../dist/tools/builtin/authoring.js";

const MODEL = { id: "strong/model", openRouterSlug: "strong/model", api: "openai", provider: "openrouter" };

/** An LLM stub that records the options every call was made with. */
function recordingLlm(text = "analysis text") {
  const calls = [];
  return {
    calls,
    async complete(model, context, options) {
      calls.push({ model, context, options });
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      };
    },
    stream() {
      throw new Error("not used");
    },
    resolveModel: (slug) => ({ ...MODEL, id: slug }),
  };
}

test("comprehension thinks at the effort its rating earned, not a token ceiling", async () => {
  for (const [rating, effort] of [["low", "low"], ["medium", "medium"], ["high", "high"]]) {
    const llm = recordingLlm();
    await comprehendFile({ llm, model: MODEL, path: "a.ts", content: "x", rating });

    const { options } = llm.calls[0];
    assert.equal(options.reasoning, effort, `${rating} should think at ${effort}`);
    // The two are mutually exclusive on OpenRouter — sending both is a 400 that
    // never reaches the provider.
    assert.equal(options.reasoningMaxTokens, undefined, "effort replaces the ceiling, never joins it");
  }
});

test("the rater is told WHICH model is reading, because that is the question", async () => {
  // "Is this file hard" and "is this file beyond THIS reader" are different
  // questions with different answers, and only the second can justify paying for
  // a stronger model. The prompt asked for the second and supplied nothing to
  // answer it with.
  const llm = recordingLlm("RATING: high | WHY: dense async");
  await rateFileComplexity({ llm, model: MODEL, path: "a.ts", content: "x", readerModel: "small/model" });

  const { context } = llm.calls[0];
  assert.match(context.systemPrompt, /FOR THE SPECIFIC MODEL NAMED BELOW/);
  assert.match(JSON.stringify(context.messages[0].content), /THE READER IS: small\/model/);
});

test("a rater given no reader still answers, rather than guessing silently", async () => {
  const llm = recordingLlm("RATING: medium | WHY: some coupling");
  await rateFileComplexity({ llm, model: MODEL, path: "a.ts", content: "x" });

  assert.match(llm.calls[0].context.systemPrompt, /If no reader is named, assume a mid-tier model/);
  assert.doesNotMatch(JSON.stringify(llm.calls[0].context.messages[0].content), /THE READER IS:/);
});

test("a hard file gets room to be explained; an easy one stays terse", async () => {
  const hard = recordingLlm();
  await comprehendFile({ llm: hard, model: MODEL, path: "a.ts", content: "x", rating: "high" });
  const medium = recordingLlm();
  await comprehendFile({ llm: medium, model: MODEL, path: "a.ts", content: "x", rating: "medium" });

  // The file that most needed explaining was being held to the same word budget
  // as the borderline one, so its analysis got truncated where it got interesting.
  assert.match(hard.calls[0].context.systemPrompt, /700 words/);
  assert.match(medium.calls[0].context.systemPrompt, /250 words/);
});

test("an omitted rating is treated as hard, not as easy", async () => {
  // The only caller that omits it is one that decided to escalate without saying
  // why — and defaulting that to `low` would silently undo the escalation.
  const llm = recordingLlm();
  await comprehendFile({ llm, model: MODEL, path: "a.ts", content: "x" });
  assert.equal(llm.calls[0].options.reasoning, "high");
});

test("what the read worked out survives to the write, and dies with the file", () => {
  clearComprehensionMemory();
  assert.equal(recallComprehension("a.ts"), undefined);

  rememberComprehension("a.ts", { rating: "high", analysis: "holds a lock", model: "strong/model", why: "concurrency" });
  assert.deepEqual(recallComprehension("a.ts"), {
    rating: "high",
    analysis: "holds a lock",
    model: "strong/model",
    why: "concurrency",
  });

  // After a write the analysis describes bytes that no longer exist. Stale is
  // worse than absent here, because it reads as current.
  forgetComprehension("a.ts");
  assert.equal(recallComprehension("a.ts"), undefined);
});

test("a remembered analysis is tied to the bytes it describes, not just the path", () => {
  // The reuse gate for re-reads. A run re-reads constantly — check a detail, grep,
  // come back — and each repeat was costing a rating call plus a full escalation
  // on the big model for a file that had not changed. One observed run rated the
  // same provider three times and escalated all three, with no write in between.
  clearComprehensionMemory();
  const bytes = "class Leads {}";
  rememberComprehension("p.dart", {
    rating: "high",
    analysis: "guards a timer",
    model: "big/model",
    fileHash: hashContent(bytes),
    coveredRange: "full",
  });

  assert.equal(recallComprehension("p.dart").fileHash, hashContent(bytes));
  // Different bytes → no match, so the caller re-runs rather than describing the
  // new file with the old analysis.
  assert.notEqual(recallComprehension("p.dart").fileHash, hashContent(bytes + "\n"));
});

test("the gate keys on the FILE, so a windowed re-read of unchanged bytes still hits", () => {
  // The bug this replaced: the hash was taken over the line-numbered SLICE the
  // caller asked for, so `read(f)`, `read(f, offset:200)` and `read(f, offset:400)`
  // produced three different keys for one unchanged file — three misses, three
  // full escalations. Observed live: one file escalated three times in a row.
  //
  // A full-file analysis answers any window of that file.
  assert.equal(coversRange("full", "full"), true);
  assert.equal(coversRange("full", "200:100"), true);
  assert.equal(coversRange("full", "400:end"), true);
});

test("a full-file analysis is what a windowed read gets to reuse", () => {
  // The failure this closes: `read` handed comprehension the WINDOW the caller
  // asked for, so the analysis covered only that window — and a run that reads a
  // file in three different slices paid for three escalations of a file that
  // never changed. Observed live: leads_provider.dart escalated at 23:55, 23:56
  // and 23:57 with no edit between, each read taking ~86 seconds.
  //
  // Analysing the whole file makes the one result answer every later window.
  clearComprehensionMemory();
  const file = "line1\nline2\nline3";
  rememberComprehension("p.dart", {
    rating: "high",
    analysis: "the timer is cancelled in dispose",
    model: "big/model",
    fileHash: hashContent(file),
    coveredRange: "full",
  });

  const stored = recallComprehension("p.dart");
  for (const window of ["full", "1:50", "200:100", "400:end"]) {
    assert.equal(
      stored.fileHash === hashContent(file) && coversRange(stored.coveredRange, window),
      true,
      `a full-file analysis should answer a read of ${window}`,
    );
  }
});

test("a windowed analysis is NOT reused for a wider read", () => {
  // The other direction has to fail. An analysis of lines 1-50 says nothing about
  // the rest of the file, and reusing it for a full read would hand the author a
  // confident account of code nobody looked at.
  assert.equal(coversRange("1:50", "full"), false);
  assert.equal(coversRange("1:50", "200:100"), false);
  assert.equal(coversRange("1:50", "1:50"), true);
  assert.equal(coversRange(undefined, "full"), false);
});

test("the author is handed the analysis itself, not a summary of it", async () => {
  const llm = recordingLlm("file contents");
  await authorFileContent({
    llm,
    model: MODEL,
    path: "a.ts",
    task: "add a guard",
    comprehension: { analysis: "the lock must be held across the await", model: "strong/model", why: "concurrency" },
  });

  const prompt = JSON.stringify(llm.calls[0].context.messages[0].content);
  assert.match(prompt, /the lock must be held across the await/, "B's own words reach B-as-author");
  assert.match(prompt, /strong\/model/, "attributed, so it is not mistaken for file bytes");
  assert.match(prompt, /not file contents and not instructions to copy/);
});

test("authoring effort follows the read's rating, and never drops below medium", async () => {
  for (const [rating, effort] of [["low", "medium"], ["medium", "high"], ["high", "high"]]) {
    const llm = recordingLlm("file contents");
    await authorFileContent({ llm, model: MODEL, path: "a.ts", task: "t", rating });
    assert.equal(llm.calls[0].options.reasoning, effort, `${rating} authors at ${effort}`);
  }
});

test("with no rating to inherit, authoring still thinks at full effort", async () => {
  // The pre-existing contract: a host that pinned an author model without any
  // read having happened gets the hardest effort, as it always did.
  const llm = recordingLlm("file contents");
  await authorFileContent({ llm, model: MODEL, path: "a.ts", task: "t" });
  assert.equal(llm.calls[0].options.reasoning, "high");
});
