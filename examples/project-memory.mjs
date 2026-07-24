/**
 * Verifies the project-level memory system (offline): first-init tech-stack
 * detection, persistence to .turing/, reload without re-detection, category
 * driving the preset, explicit-override persistence, and the project_memory tool.
 *
 * Run:  node examples/project-memory.mjs
 */
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness, ProjectMemory, detectProject, resolveModel } from "../dist/index.js";

async function mkproject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proj-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

// minimal fake model so runChain works offline; also records per-phase model
function makeFake(rec = []) {
  const msg = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "openrouter", provider: "openrouter", model: "fake", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
  const phaseOf = (sp = "") => (sp.match(/You are the (PREPARE|PLAN|PERFORM|PERFECT) phase/)?.[1] ?? "PERFECT").toLowerCase();
  return {
    resolveModel: (s) => resolveModel(s),
    async complete(model, ctx) { const phase = phaseOf(ctx.systemPrompt); rec.push({ phase, model: model.openRouterSlug ?? model.id }); return msg({ prepare: "SUMMARY: x", plan: "PLAN: x\nACCEPTANCE: y", perform: "CHANGES: x", perfect: "VERDICT: PASS" }[phase]); },
    async *stream(m, ctx) { const x = await this.complete(m, ctx); yield { type: "start", partial: x }; yield { type: "done", reason: "stop", message: x }; },
  };
}

async function main() {
  // ---- 1. Detection across the four categories ----
  const feDir = await mkproject({ "package.json": JSON.stringify({ dependencies: { next: "15", react: "19" } }), "tsconfig.json": "{}" });
  const beDir = await mkproject({ "package.json": JSON.stringify({ dependencies: { express: "5" } }) });
  const mobDir = await mkproject({ "package.json": JSON.stringify({ dependencies: { expo: "51", "react-native": "0.76" } }) });
  const gameDir = await mkproject({ "project.godot": "; Godot project\nconfig_version=5\n" });
  const phpDir = await mkproject({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }), "artisan": "#!/usr/bin/env php\n" });
  const swiftDir = await mkproject({ "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\n" });

  assert.equal((await detectProject(feDir)).category, "frontend", "next/react → frontend");
  assert.equal((await detectProject(beDir)).category, "backend", "express → backend");
  assert.equal((await detectProject(mobDir)).category, "mobile", "expo → mobile");
  const gameDet = await detectProject(gameDir);
  assert.equal(gameDet.category, "games", "project.godot → games");
  assert.equal(gameDet.stack.engine, "godot", "engine detected as godot");
  const phpDet = await detectProject(phpDir);
  assert(phpDet.stack.languages.includes("php"), "composer.json → php");
  assert(phpDet.stack.frameworks.includes("laravel"), "laravel detected");
  const swiftDet = await detectProject(swiftDir);
  assert(swiftDet.stack.languages.includes("swift"), "Package.swift → swift");

  // ---- 2. First open creates memory; reload does not re-detect ----
  const m1 = await ProjectMemory.open(feDir);
  assert(m1.wasCreated, "memory created on first open");
  assert.equal(m1.category, "frontend");
  assert(m1.stack.frameworks.includes("next"), "stack recorded");
  // .turing/ persisted
  const saved = JSON.parse(await fs.readFile(path.join(feDir, ".turing", "project.json"), "utf8"));
  assert.equal(saved.category, "frontend", "persisted to .turing/project.json");
  assert((await fs.readFile(path.join(feDir, ".turing", "MEMORY.md"), "utf8")).includes("Category"), "MEMORY.md rendered");

  const m2 = await ProjectMemory.open(feDir);
  assert(!m2.wasCreated, "second open loads (does not recreate)");

  // remember/recall persists
  await m2.remember("tests run via `pnpm test`", { tags: ["build"] });
  const m3 = await ProjectMemory.open(feDir);
  assert.equal(m3.recall({ tag: "build" }).length, 1, "fact persisted across opens");

  // ---- 3. createProjectSession auto-derives category from memory ----
  const rec = [];
  const harness = new Harness({ llm: makeFake(rec), permissionMode: "bypass" });

  // No category passed → detected + stored → drives the preset.
  const { session, memory } = await harness.createProjectSession({ cwd: mobDir });
  assert.equal(memory.category, "mobile", "auto-detected mobile");
  assert(session.memory === memory, "memory attached to session");
  // mobile preset policy is applied from the memory-derived category.
  await session.runChain("build");
  assert(session.toolsForPhase("perfect").some((t) => t.name === "ui_screen_auditor"), "mobile preset verification tool applied from memory-derived category");
  // project_memory tool registered
  assert(session.toolsForPhase("prepare").some((t) => t.name === "project_memory"), "project_memory tool available");

  // ---- 4. Explicit category overrides + persists ----
  const { memory: m4 } = await harness.createProjectSession("backend", { cwd: feDir });
  assert.equal(m4.category, "backend", "explicit category overrides memory");
  const reSaved = JSON.parse(await fs.readFile(path.join(feDir, ".turing", "project.json"), "utf8"));
  assert.equal(reSaved.category, "backend", "override persisted");
  assert.equal(reSaved.detection.auto, false, "marked as manually set");

  // ---- 5. memory:false skips persistence but still picks a category ----
  const tmp = await mkproject({ "go.mod": "module x\n" });
  const { session: s5, memory: m5 } = await harness.createProjectSession({ cwd: tmp, memory: false });
  assert.equal(m5, undefined, "no memory object when memory:false");
  await assert.rejects(fs.access(path.join(tmp, ".turing")), "no .turing written");
  assert(!s5.toolsForPhase("prepare").some((t) => t.name === "project_memory"), "no memory tool without memory");

  // ---- 6. The project_memory tool reads/writes memory ----
  const memTool = session.toolsForPhase("prepare").find((t) => t.name === "project_memory");
  const ctx = { cwd: mobDir, log: () => {}, llm: harness.llm };
  const got = await memTool.execute("id", { action: "get" }, ctx);
  assert(got.output.includes("mobile"), "tool get returns category");
  await memTool.execute("id", { action: "remember", text: "uses fastlane for releases", tags: ["ci"] }, ctx);
  assert.equal((await ProjectMemory.open(mobDir)).recall({ tag: "ci" }).length, 1, "tool remember persisted to disk");

  await harness.dispose();
  console.log("✅ PROJECT MEMORY CHECKS PASSED (detect / persist / reload / auto-category / override / tool)");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
