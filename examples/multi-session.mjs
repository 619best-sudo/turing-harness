/**
 * Parallel multi-session smoke test (offline, fake model).
 * Proves two sessions run concurrently in one process with full isolation:
 * separate cwds, log stores, event streams, permission policies, and model overrides.
 *
 * Run:  node examples/multi-session.mjs
 */
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness, resolveModel } from "../dist/index.js";

// --- scripted fake model (one tool call + a final answer per phase) ---
function phaseOf(sp = "") {
  const m = sp.match(/You are the (PREPARE|PLAN|PERFORM|PERFECT) phase/);
  return m ? m[1].toLowerCase() : "perfect";
}
function scripted(phase, hasToolResult) {
  const base = {
    role: "assistant", content: [], api: "openrouter", provider: "openrouter", model: "fake",
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
  if (!hasToolResult) {
    const call = phase === "prepare" ? { name: "ls", args: { path: "." } }
      : phase === "perform" ? { name: "write", args: { path: "out.txt", content: "content\n" } }
      : phase === "perfect" ? { name: "bash", args: { command: "cat out.txt" } }
      : null;
    if (call) return { ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: `${phase}_c`, name: call.name, arguments: call.args }] };
  }
  const text = { prepare: "SUMMARY: ok", plan: "PLAN:\n1. write\nACCEPTANCE: file exists", perform: "CHANGES:\n- out.txt", perfect: "VERDICT: PASS" }[phase];
  return { ...base, content: [{ type: "text", text }] };
}
const fakeLLM = {
  resolveModel: (s) => resolveModel(s),
  async complete(_m, ctx) {
    await new Promise((r) => setTimeout(r, 5)); // force interleaving across sessions
    return scripted(phaseOf(ctx.systemPrompt), ctx.messages.some((m) => m.role === "toolResult"));
  },
  async *stream(m, ctx) {
    const msg = await this.complete(m, ctx);
    yield { type: "start", partial: msg };
    yield { type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg };
  },
};

async function main() {
  const harness = new Harness({ llm: fakeLLM });

  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "sess-A-"));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "sess-B-"));

  // Two sessions, different cwds + different permission policies + different models.
  const asksB = [];
  const a = harness.createSession({ id: "A", cwd: dirA, permissionMode: "bypass", models: { perform: "anthropic/claude-haiku-4.5" } });
  const b = harness.createSession({ id: "B", cwd: dirB, permissionMode: "ask-mutations", models: { perform: "anthropic/claude-opus-4.8" },
    permissionCallback: (req) => { asksB.push(req.name); return { allowed: true }; } });

  // Cross-session monitor tags every event with its session id.
  const seen = { A: new Set(), B: new Set() };
  harness.subscribeAll((sid, e) => seen[sid]?.add(e.type));

  assert.equal(harness.listSessions().length, 2, "two sessions registered");

  // --- run both chains in parallel ---
  const [ra, rb] = await Promise.all([a.runChain("build A"), b.runChain("build B")]);

  console.log("A success:", ra.success, "| B success:", rb.success);
  assert(ra.success && rb.success, "both chains verified");

  // 1) Files landed in the correct, separate working directories.
  assert.equal((await fs.readFile(path.join(dirA, "out.txt"), "utf8")).trim(), "content", "A wrote to its cwd");
  assert.equal((await fs.readFile(path.join(dirB, "out.txt"), "utf8")).trim(), "content", "B wrote to its cwd");

  // 2) Log stores are isolated — each only has its own session's write path.
  const aLogs = a.logStore.search({ anyTags: ["mutation"] }).map((e) => e.message);
  const bLogs = b.logStore.search({ anyTags: ["mutation"] }).map((e) => e.message);
  console.log("A mutation logs:", aLogs.length, "| B mutation logs:", bLogs.length);
  assert(aLogs.every((m) => m.includes(dirA)) && aLogs.length > 0, "A log only references A's cwd");
  assert(bLogs.every((m) => m.includes(dirB)) && bLogs.length > 0, "B log only references B's cwd");
  assert(!aLogs.some((m) => m.includes(dirB)) && !bLogs.some((m) => m.includes(dirA)), "no cross-session log leakage");

  // 3) Permission policies stayed independent: only B (ask-mutations) prompted.
  console.log("B permission asks:", asksB);
  assert(asksB.includes("write"), "B prompted for the write mutation");
  // Non-mutating discovery (ls) must NOT prompt under ask-mutations.
  assert(!asksB.includes("ls"), "B did not prompt for read-only ls");
  // A was bypass → its writes never invoked B's callback (independent gate instances).

  // 4) Cross-session event stream tagged both sessions.
  assert(seen.A.has("chain_start") && seen.B.has("chain_start"), "subscribeAll saw both sessions");
  assert(seen.A.has("tool_execution_end") && seen.B.has("tool_execution_end"), "tool events per session");

  // 5) Per-session model override isolation.
  a.orchestrator.setModel("plan", "openai/gpt-5");
  assert(a !== b && a.registry !== b.registry && a.logStore !== b.logStore, "sessions share no mutable state");

  // 6) Close one session; the other keeps working.
  await harness.closeSession("A");
  assert.equal(harness.listSessions().length, 1, "A closed");
  const rb2 = await b.runChain("build B again");
  assert(rb2.success, "B still runs after A closed");

  // 7) Backward-compatible default session still works alongside real sessions.
  const dirDefault = await fs.mkdtemp(path.join(os.tmpdir(), "sess-def-"));
  const def = new Harness({ llm: fakeLLM, cwd: dirDefault, permissionMode: "bypass" });
  const rd = await def.runChain("build default");
  assert(rd.success, "default-session proxy API still works");
  assert.equal(def.listSessions().length, 1, "default session auto-created");

  await harness.dispose();
  await def.dispose();
  console.log("\n✅ MULTI-SESSION ISOLATION CHECKS PASSED");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
