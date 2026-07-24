/**
 * Verifies the durable file-memory system (offline): first-init indexing,
 * reload, one-shot search across 100+ files, and stale -> refresh behavior.
 *
 * Run: node examples/file-memory.mjs
 */
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Harness, resolveModel } from "../dist/index.js";

async function mkproject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-memory-example-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "file-memory-example",
      scripts: { test: "node --test", dev: "node server.js" },
      dependencies: { express: "5.0.0" },
    }),
  );
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "search-engine.ts"),
    [
      "/**",
      " * Search files in one go across the durable file-memory index.",
      " */",
      "export function searchFilesOnce(query: string) {",
      "  return query.trim();",
      "}",
      "",
    ].join("\n"),
  );
  for (let i = 0; i < 110; i++) {
    await fs.writeFile(path.join(dir, "src", `generated-${i}.ts`), `export const value${i} = ${i};\n`);
  }
  return dir;
}

async function main() {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const harness = new Harness({ permissionMode: "bypass", llm: makeSummaryLlm() });

  const first = await harness.createProjectSession({ cwd, connectMcp: false });
  assert(first.fileMemory, "file memory should be created");
  assert(first.fileMemory.wasCreated, "first open should create the index");
  await first.fileMemoryRuntime?.drain();
  assert(first.fileMemory.stats().totalFiles >= 100, "project should be indexed");
  assert(await fs.readFile(path.join(cwd, ".turing", "FILES_MEMORY.md"), "utf8"), "FILES_MEMORY.md should exist");

  const tool = first.session.toolsForPhase("prepare").find((entry) => entry.name === "file_memory");
  assert(tool, "file_memory tool should be available");
  const ctx = { cwd, log: () => {}, llm: harness.llm };
  const found = await tool.execute("id", { action: "search", query: "search files in one go", limit: 3 }, ctx);
  assert(found.details[0].path === target, "one-shot search should rank the target file first");

  await fs.writeFile(
    target,
    [
      "/**",
      " * Search files in one go and refresh stale summaries.",
      " */",
      "export function searchFilesOnce(query: string) {",
      "  return `ranked:${query.trim()}`;",
      "}",
      "",
    ].join("\n"),
  );
  const reopened = await harness.createProjectSession({ cwd, connectMcp: false });
  assert(reopened.fileMemory.get(target)?.stale, "reopen should mark externally changed files as stale");
  const reopenedTool = reopened.session.toolsForPhase("prepare").find((entry) => entry.name === "file_memory");
  assert(reopenedTool, "file_memory tool should still be available after reopen");
  await reopenedTool.execute("id", { action: "refresh", path: target }, ctx);
  assert(!reopened.fileMemory.get(target)?.stale, "refresh should clear staleness");

  await harness.dispose();
  console.log("✅ FILE MEMORY CHECKS PASSED (index / load / search / stale / refresh)");
}

function makeSummaryLlm() {
  return {
    resolveModel: (slug) => resolveModel(slug),
    async complete(model, context) {
      const prompt = String(context.messages?.[0]?.content ?? "");
      const rel = /path:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? "unknown";
      return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: JSON.stringify({ summary: `${path.basename(rel)} covers business behavior and technical implementation for ${rel}.`, keywords: rel.split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 6) }) }],
      };
    },
    async *stream() {},
  };
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
