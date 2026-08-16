/**
 * v2 equivalent of the old per-phase toolset example: how tools are scoped to
 * CATEGORIZERS, and how an app customizes that for its domain. Offline (no model).
 *
 * Run:  node examples/custom-categorizers.mjs
 */
import assert from "node:assert";
import { Harness } from "../dist/index.js";

const noop = { async execute() { return { output: "" }; } };
const tool = (name, extra = {}) => ({ name, description: name, parameters: { type: "object", properties: {} }, execute: noop.execute, ...extra });

async function main() {
  const harness = new Harness({ apiKey: "x" });

  // ---- 1. Per-tool `categorizers` declared by the author ------------------
  const s1 = harness.createSession({
    providers: [{
      id: "app", kind: "skill", source: "external", name: "app",
      tools: [
        tool("deploy", { mutates: true, categorizers: ["write_edit"] }),
        tool("smoke_check", { categorizers: ["activity_inspect"] }),
      ],
    }],
  });
  assert(s1.toolsForCategorizer("activity_inspect").some((t) => t.name === "smoke_check"), "declared scope honored");
  assert(!s1.toolsForCategorizer("write_edit").some((t) => t.name === "smoke_check"), "smoke_check not in write_edit");

  // ---- 2. Custom scoping strategy (redefine defaults for this app) --------
  // e.g. a data-pipeline app: everything named *_check is inspection, every
  // mutation is work; ignore the built-in heuristics otherwise.
  const s2 = harness.createSession({
    categorizer: (t, def) => {
      if (t.name.endsWith("_check")) return ["activity_inspect"];
      if (t.mutates) return ["write_edit"];
      return def; // fall back to built-in
    },
    providers: [{ id: "p", kind: "mcp", source: "external", name: "p", tools: [tool("lint_check"), tool("migrate", { mutates: true })] }],
  });
  assert(s2.toolsForCategorizer("activity_inspect").some((t) => t.name === "lint_check"), "categorizer routed *_check → activity_inspect");
  assert(s2.toolsForCategorizer("write_edit").some((t) => t.name === "migrate"), "categorizer routed mutation → write_edit");

  // ---- 3. categorizerTools as an exact pinned list -------------------------
  const only = [tool("playwright"), tool("mobile_tap")];
  const s3 = harness.createSession({ categorizerTools: { activity_inspect: only } });
  assert.deepEqual(s3.orchestrator.extraToolsFor("activity_inspect").map((t) => t.name).sort(), ["mobile_tap", "playwright"], "exact pinned list");
  // built-ins still exist for other categorizers
  assert(s3.toolsForCategorizer("write_edit").some((t) => t.name === "write"), "other categorizers untouched");

  // ---- 4. categorizerTools as a FILTER over the scope ----------------------
  const s4 = harness.createSession({
    categorizerTools: {
      // start from the activity_inspect scope, drop the auditor, add bash + a custom tool
      activity_inspect: { fromScope: true, exclude: ["media_analysis"], include: ["bash"] },
    },
    providers: [{ id: "extra", kind: "tool", source: "external", name: "extra", tools: [tool("db_check", { categorizers: ["activity_inspect"] })] }],
  });
  const p4 = s4.orchestrator.extraToolsFor("activity_inspect").map((t) => t.name);
  assert(!p4.includes("media_analysis"), "filter excluded auditor");
  assert(p4.includes("bash") && p4.includes("db_check"), "filter included bash + kept scoped tool");

  // ---- 5. categorizerTools as a resolver function --------------------------
  const s5 = harness.createSession({
    categorizerTools: {
      read: (registry) => registry.allTools().filter((t) => !t.mutates && t.name !== "grep"),
    },
  });
  const p5 = s5.orchestrator.extraToolsFor("read").map((t) => t.name);
  assert(p5.includes("read") && p5.includes("ls") && !p5.includes("grep") && !p5.includes("write"), "resolver fn selection");

  // ---- 6. Runtime reassignment (customizable at any time) ------------------
  const s6 = harness.createSession();
  assert(!s6.toolsForCategorizer("conversation").some((t) => t.name === "write"), "write not in conversation initially");
  s6.setToolCategorizers("write", ["conversation", "write_edit"]);      // move a tool
  assert(s6.toolsForCategorizer("conversation").some((t) => t.name === "write"), "tool moved into conversation at runtime");
  s6.setProviderCategorizers("builtin:media_analysis", ["read"]);        // move a whole provider
  assert(s6.toolsForCategorizer("read").some((t) => t.name === "media_analysis"), "provider moved into read");
  s6.setCategorizerTools("write_edit", [tool("only_this", { mutates: true })]); // swap toolset live
  assert.deepEqual(s6.orchestrator.extraToolsFor("write_edit").map((t) => t.name), ["only_this"], "runtime setCategorizerTools");
  s6.setCategorizerTools("write_edit", undefined);                       // revert
  const reverted = s6.orchestrator.extraToolsFor("write_edit").map((t) => t.name);
  assert(!reverted.includes("only_this"), "the pin is gone after revert");
  assert(reverted.includes("read"), "back to the registry-scope default (read joins write_edit)");

  // ---- 7. Different apps/sessions keep independent policies ----------------
  assert.notDeepEqual(
    s3.orchestrator.extraToolsFor("activity_inspect").map((t) => t.name),
    s4.orchestrator.extraToolsFor("activity_inspect").map((t) => t.name),
    "each session's categorizer policy is independent",
  );

  await harness.dispose();
  console.log("✅ CUSTOM CATEGORIZER-TOOLSET CHECKS PASSED (declared / strategy / exact / filter / resolver / runtime / per-session)");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
