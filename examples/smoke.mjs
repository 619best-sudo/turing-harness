/**
 * End-to-end smoke test with a scripted fake LLM (no network).
 * Exercises: registry + 4P categorization, permission modes, the full chain
 * (Prepare→Plan→Perform→Perfect), tool execution, Perfect verify, and event stream.
 *
 * Run:  node examples/smoke.mjs
 */
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness, resolveModel } from "../dist/index.js";

// --- A fake LLM bridge that scripts one tool call + a final answer per phase ---
function scriptedMessage(phase, hasToolResult) {
  const base = {
    role: "assistant",
    content: [],
    api: "openrouter",
    provider: "openrouter",
    model: "fake/model",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  if (!hasToolResult) {
    // First turn: emit a tool call appropriate to the phase.
    const call =
      phase === "prepare" ? { name: "ls", args: { path: "." } }
      : phase === "plan" ? null
      : phase === "perform" ? { name: "write", args: { path: "hello.txt", content: "hi from perform\n" } }
      : { name: "bash", args: { command: "cat hello.txt" } }; // perfect
    if (call) {
      return { ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: `${phase}_call`, name: call.name, arguments: call.args }] };
    }
  }
  // Final turn per phase.
  const text = {
    prepare: "SUMMARY: single-file project; goal is to create hello.txt.",
    plan: "PLAN:\n1. write hello.txt with greeting.\nACCEPTANCE: hello.txt exists and contains a greeting.",
    perform: "CHANGES:\n- hello.txt: created greeting file.",
    perfect: "Checked file contents; greeting present.\nVERDICT: PASS",
  }[phase];
  return { ...base, content: [{ type: "text", text }] };
}

function phaseOf(systemPrompt = "") {
  // Anchor on the "You are the X phase" line (prompts cross-reference each other).
  const m = systemPrompt.match(/You are the (PREPARE|PLAN|PERFORM|PERFECT) phase/);
  return m ? m[1].toLowerCase() : "perfect";
}

const fakeLLM = {
  resolveModel: (slug) => resolveModel(slug),
  async complete(model, context) {
    const phase = phaseOf(context.systemPrompt);
    const hasToolResult = context.messages.some((m) => m.role === "toolResult");
    return scriptedMessage(phase, hasToolResult);
  },
  async *stream(model, context) {
    const msg = await this.complete(model, context);
    yield { type: "start", partial: msg };
    const reason = msg.stopReason === "toolUse" ? "toolUse" : "stop";
    yield { type: "done", reason, message: msg };
  },
};

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-smoke-"));

  const harness = new Harness({ llm: fakeLLM, cwd, permissionMode: "bypass" });

  // 1) Registry: internal providers exist and are 4P-categorized.
  const caps = harness.listCapabilities();
  console.log("Capabilities:");
  for (const c of caps) console.log(`  - [${c.source}/${c.kind}] ${c.name} → phases: ${c.phases.join(", ")}`);
  assert(caps.find((c) => c.name === "assets_generator"), "assets_generator registered");
  assert(caps.find((c) => c.name === "media_analysis")?.phases.includes("perfect"), "media_analysis is a Perfect tool");
  assert(caps.find((c) => c.name === "coding")?.phases.includes("perform"), "coding serves Perform");

  // 2) Per-phase toolsets resolve from categories.
  const performTools = harness.toolsForPhase("perform").map((t) => t.name);
  assert(performTools.includes("write") && performTools.includes("edit"), "perform has mutation tools");
  console.log("\nPerform toolset:", performTools.join(", "));

  // 3) Event stream (pi-compatible) is observable.
  const events = [];
  harness.subscribe((e) => events.push(e.type));

  // 4) Run the full 4P chain.
  const result = await harness.runChain("Create a hello.txt greeting file.");
  console.log("\nChain success:", result.success, "| iterations:", result.iterations);
  console.log("Perfect verdict summary:", result.phases.perfect?.summary);

  assert(result.success === true, "chain verified in Perfect");
  assert(result.phases.prepare && result.phases.plan && result.phases.perform && result.phases.perfect, "all phases ran");
  assert(events.includes("chain_start") && events.includes("phase_start") && events.includes("tool_execution_end"), "emitted 4P + tool events");

  // 5) Perform actually wrote the file via the write tool.
  const written = await fs.readFile(path.join(cwd, "hello.txt"), "utf8");
  assert(written.includes("hi from perform"), "write tool created the file");
  console.log("\nFile written by Perform:", JSON.stringify(written.trim()));

  // 6) activity_search can filter the harness log by tag (noise removal).
  // The activity tools are perform/perfect — they are not in the Prepare toolset.
  const monitor = harness.toolsForPhase("perform").find((t) => t.name === "activity_search");
  const search = await monitor.execute("t", { anyTags: ["mutation"] }, {
    cwd, log: () => {}, llm: fakeLLM,
  });
  console.log("\nactivity_search (mutation tag) matched entries:\n" + search.output.split("\n").slice(0, 3).join("\n"));
  assert(search.output.includes("write"), "activity_search found the write mutation");

  // 7) Permission mode: ask-mutations should invoke callback only on mutating calls.
  const asked = [];
  harness.setPermissionMode("ask-mutations");
  harness.setPermissionCallback((req) => { asked.push({ name: req.name, mutates: req.mutates, complexity: req.complexity.score }); return { allowed: true }; });
  await harness.runPhase("prepare", "look around");   // ls is non-mutating → no ask
  await harness.runPhase("perform", "touch a file");   // write is mutating → ask
  console.log("\nPermission asks (ask-mutations mode):", asked);
  assert(asked.every((a) => a.mutates), "only mutating calls prompted");

  console.log("\n✅ ALL SMOKE CHECKS PASSED");
  await harness.dispose();
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
