/**
 * Verifies the frontend / mobile / games / backend presets: phase-tool policy,
 * per-category model defaults, provider-filter wiring, and graceful opt-in MCP
 * connect (skip/fail paths) — all offline (no real MCP servers spawned).
 *
 * Run:  node examples/project-presets.mjs
 */
import assert from "node:assert";
import { Harness, PROJECT_PRESETS, resolveModel } from "../dist/index.js";

const tool = (name, extra = {}) => ({ name, description: name, parameters: { type: "object", properties: {} }, async execute() { return { output: "" }; }, ...extra });

// Fake model that records which model slug each phase ran with.
function phaseOf(sp = "") { const m = sp.match(/You are the (PREPARE|PLAN|PERFORM|PERFECT) phase/); return m ? m[1].toLowerCase() : "perfect"; }
function makeFake(record) {
  const msg = (text, tc) => ({ role: "assistant", content: tc ? [{ type: "toolCall", id: "c", name: tc, arguments: {} }] : [{ type: "text", text }], api: "openrouter", provider: "openrouter", model: "fake", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tc ? "toolUse" : "stop", timestamp: 0 });
  return {
    resolveModel: (s) => resolveModel(s),
    async complete(model, ctx) {
      const phase = phaseOf(ctx.systemPrompt);
      record.push({ phase, model: model.openRouterSlug ?? model.id });
      return msg({ prepare: "SUMMARY: x", plan: "PLAN: x\nACCEPTANCE: y", perform: "CHANGES: x", perfect: "VERDICT: PASS" }[phase]);
    },
    async *stream(model, ctx) { const m = await this.complete(model, ctx); yield { type: "start", partial: m }; yield { type: "done", reason: "stop", message: m }; },
  };
}

async function main() {
  // ---- 1. Every category applies a distinct phase-tool policy (offline) ----
  const h = new Harness({ apiKey: "x" });
  for (const cat of ["frontend", "mobile", "games", "backend"]) {
    const s = h.createSession({ preset: cat });
    // Base fix: bash + read + ui_screen_auditor must be usable in Perfect.
    const perfect = s.toolsForPhase("perfect").map((t) => t.name);
    assert(perfect.includes("bash"), `${cat}: bash in perfect`);
    assert(perfect.includes("ui_screen_auditor"), `${cat}: auditor in perfect`);
    // Perform has the mutation tools.
    const perform = s.toolsForPhase("perform").map((t) => t.name);
    assert(perform.includes("write") && perform.includes("edit"), `${cat}: write/edit in perform`);
  }

  // ---- 2. Provider-filter wiring: a connected provider lands in its phase ----
  // Simulate the Playwright MCP by registering a provider with the id the frontend
  // preset references; its tools must appear in Perfect via the providers filter.
  const fe = h.createSession({ preset: "frontend" });
  assert(!fe.toolsForPhase("perfect").some((t) => t.name === "browser_click"), "not present before connect");
  fe.addProvider({ id: "playwright", kind: "mcp", source: "external", name: "Playwright", tools: [tool("browser_click", { mutates: true })] });
  fe.setProviderPhases("playwright", ["perfect"]);
  assert(fe.toolsForPhase("perfect").some((t) => t.name === "browser_click"), "playwright tool in perfect after connect");
  // ...and NOT in prepare (frontend prepare references context7, not playwright).
  assert(!fe.toolsForPhase("prepare").some((t) => t.name === "browser_click"), "playwright not in prepare");

  // ---- 3. Per-category model defaults drive each phase ----
  const rec = [];
  const h2 = new Harness({ llm: makeFake(rec), permissionMode: "bypass" });
  const s2 = h2.createSession({ preset: "mobile" });
  await s2.runChain("build a screen");
  const modelFor = (p) => rec.find((r) => r.phase === p)?.model;
  assert.equal(modelFor("plan"), "anthropic/claude-opus-4.8", "mobile plan → opus");
  assert.equal(modelFor("perform"), "anthropic/claude-sonnet-4.5", "mobile perform → sonnet");
  assert.equal(modelFor("perfect"), "google/gemini-2.5-pro", "mobile perfect → gemini (vision)");

  // Explicit models override the preset.
  const rec2 = [];
  const h3 = new Harness({ llm: makeFake(rec2), permissionMode: "bypass" });
  const s3 = h3.createSession({ preset: "frontend", models: { perform: "anthropic/claude-haiku-4.5" } });
  await s3.runChain("tweak css");
  assert.equal(rec2.find((r) => r.phase === "perform")?.model, "anthropic/claude-haiku-4.5", "explicit model overrides preset");

  // ---- 4. Opt-in MCP connect: graceful skip (missing config) + fail paths ----
  // memory:false so this offline test never writes .turing/ into a real project dir.
  const { report: backendReport } = await h.createProjectSession("backend", { memory: false, connectMcp: true, include: ["postgres"] });
  assert(backendReport.skipped.some((s) => s.id === "postgres"), "postgres skipped without dbUrl");
  assert.equal(backendReport.connected.length, 0, "nothing connected");

  const { report: gameReport } = await h.createProjectSession("games", {
    memory: false, connectMcp: true, include: ["godot"],
    engineCommand: { command: "node", args: ["-e", "process.exit(1)"] }, // fast-failing fake server
  });
  assert(gameReport.failed.some((f) => f.id === "godot"), "godot connect failed gracefully (reported, not thrown)");

  // ---- 5. Preset MCP catalogs are what we researched ----
  assert.deepEqual(PROJECT_PRESETS.frontend.mcp.map((m) => m.id).sort(), ["chrome-devtools", "context7", "figma", "playwright"]);
  assert.deepEqual(PROJECT_PRESETS.mobile.mcp.map((m) => m.id).sort(), ["context7", "mobile"]);
  assert.deepEqual(PROJECT_PRESETS.games.mcp.map((m) => m.id).sort(), ["godot"]);
  assert.deepEqual(PROJECT_PRESETS.backend.mcp.map((m) => m.id).sort(), ["context7", "filesystem", "postgres"]);

  await h.dispose();
  await h2.dispose();
  await h3.dispose();
  console.log("✅ PROJECT PRESET CHECKS PASSED (frontend / mobile / games / backend: policy, models, provider wiring, opt-in MCP)");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
