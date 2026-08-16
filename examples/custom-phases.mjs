/**
 * Demonstrates + verifies that the "fixed" tools/mcps/skills per phase are fully
 * customizable — the requirement for supporting any type of app. Offline (no model).
 *
 * Run:  node examples/custom-phases.mjs
 */
import assert from "node:assert";
import { Harness } from "../dist/index.js";

const noop = { async execute() { return { output: "" }; } };
const tool = (name, extra = {}) => ({ name, description: name, parameters: { type: "object", properties: {} }, execute: noop.execute, ...extra });

async function main() {
  const harness = new Harness({ apiKey: "x" });

  // ---- 1. Per-tool `phases` declared by the author -----------------------
  const s1 = harness.createSession({
    providers: [{
      id: "app", kind: "skill", source: "external", name: "app",
      tools: [
        tool("deploy", { mutates: true, phases: ["perform"] }),
        tool("smoke_check", { phases: ["perfect"] }),
      ],
    }],
  });
  assert(s1.toolsForPhase("perfect").some((t) => t.name === "smoke_check"), "declared phase honored");
  assert(!s1.toolsForPhase("perform").some((t) => t.name === "smoke_check"), "smoke_check not in perform");

  // ---- 2. Custom categorizer (redefine what each P means for this app) ----
  // e.g. a data-pipeline app: treat everything named *_check as Perfect, and put
  // all mutations in Perform, ignore the built-in heuristics otherwise.
  const s2 = harness.createSession({
    categorizer: (t, def) => {
      if (t.name.endsWith("_check")) return ["perfect"];
      if (t.mutates) return ["perform"];
      return def; // fall back to built-in
    },
    providers: [{ id: "p", kind: "mcp", source: "external", name: "p", tools: [tool("lint_check"), tool("migrate", { mutates: true })] }],
  });
  assert(s2.toolsForPhase("perfect").some((t) => t.name === "lint_check"), "categorizer routed *_check → perfect");
  assert(s2.toolsForPhase("perform").some((t) => t.name === "migrate"), "categorizer routed mutation → perform");

  // ---- 3. phaseTools as an exact pinned list -----------------------------
  const only = [tool("playwright"), tool("mobile_tap")];
  const s3 = harness.createSession({ phaseTools: { perfect: only } });
  assert.deepEqual(s3.toolsForPhase("perfect").map((t) => t.name).sort(), ["mobile_tap", "playwright"], "exact pinned list");
  // built-ins still exist for other phases
  assert(s3.toolsForPhase("perform").some((t) => t.name === "write"), "other phases untouched");

  // ---- 4. phaseTools as a FILTER over the category -----------------------
  const s4 = harness.createSession({
    phaseTools: {
      // start from the perfect category, drop the auditor, add bash + a custom tool
      perfect: { fromCategory: true, exclude: ["media_analysis"], include: ["bash"] },
    },
    providers: [{ id: "extra", kind: "tool", source: "external", name: "extra", tools: [tool("db_check", { phases: ["perfect"] })] }],
  });
  const p4 = s4.toolsForPhase("perfect").map((t) => t.name);
  assert(!p4.includes("media_analysis"), "filter excluded auditor");
  assert(p4.includes("bash") && p4.includes("db_check"), "filter included bash + kept category tool");

  // ---- 5. phaseTools as a resolver function ------------------------------
  const s5 = harness.createSession({
    phaseTools: {
      prepare: (registry) => registry.allTools().filter((t) => !t.mutates && t.name !== "grep"),
    },
  });
  const p5 = s5.toolsForPhase("prepare").map((t) => t.name);
  assert(p5.includes("read") && p5.includes("ls") && !p5.includes("grep") && !p5.includes("write"), "resolver fn selection");

  // ---- 6. Runtime reassignment (customizable at any time) ----------------
  const s6 = harness.createSession();
  assert(!s6.toolsForPhase("plan").some((t) => t.name === "write"), "write not in plan initially");
  s6.setToolPhases("write", ["plan", "perform"]);         // move a tool
  assert(s6.toolsForPhase("plan").some((t) => t.name === "write"), "tool moved into plan at runtime");
  s6.setProviderPhases("builtin:media_analysis", ["plan"]); // move a whole provider
  assert(s6.toolsForPhase("plan").some((t) => t.name === "media_analysis"), "provider moved into plan");
  s6.setPhaseTools("perform", [tool("only_this", { mutates: true })]); // swap phase toolset live
  assert.deepEqual(s6.toolsForPhase("perform").map((t) => t.name), ["only_this"], "runtime setPhaseTools");
  s6.setPhaseTools("perform", undefined);                 // revert
  assert(s6.toolsForPhase("perform").some((t) => t.name === "write"), "reverted to default toolset");

  // ---- 7. Different apps/sessions keep independent phase policies --------
  assert.notDeepEqual(s3.toolsForPhase("perfect").map((t) => t.name), s4.toolsForPhase("perfect").map((t) => t.name),
    "each session's phase policy is independent");

  await harness.dispose();
  console.log("✅ CUSTOM PHASE-TOOLSET CHECKS PASSED (declared / categorizer / exact / filter / resolver / runtime / per-session)");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
