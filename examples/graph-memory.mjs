/**
 * Verifies the durable graph-memory system (offline): first-init indexing,
 * reload, file deps, symbol deps, blast radius, stale -> refresh behavior,
 * and capability-aware support beyond TS/JS.
 *
 * Run: node examples/graph-memory.mjs
 */
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Harness, resolveModel } from "../dist/index.js";

async function mkproject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-memory-example-"));
  const files = {
    "package.json": JSON.stringify({ name: "graph-memory-example", type: "module" }),
    "src/b.ts": "export function bar() { return 1; }\n",
    "src/c.ts": "import { bar } from './b.js';\nexport function helper() { return bar(); }\n",
    "src/a.ts": "import { bar } from './b.js';\nimport { helper } from './c.js';\nexport function foo() { return bar() + helper(); }\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

async function mkpythonProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-memory-python-example-"));
  const files = {
    "pyproject.toml": "[project]\nname='graph-memory-python-example'\n",
    "app/main.py": "from app.routes import router\nfrom app.services import do_work\n",
    "app/routes.py": "from app.services import do_work\n",
    "app/services.py": "def do_work():\n    return 1\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

async function main() {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "b.ts");
  const harness = new Harness({ permissionMode: "bypass", llm: makeSummaryLlm() });

  const first = await harness.createProjectSession({ cwd, connectMcp: false });
  await first.fileMemoryRuntime?.drain();
  assert(first.graphMemory, "graph memory should be created");
  assert(first.graphMemory.wasCreated, "first open should create the graph index");
  assert(first.graphMemory.stats().totalFiles >= 3, "graph should index the project");
  assert(await fs.readFile(path.join(cwd, ".turing", "GRAPH_MEMORY.md"), "utf8"), "GRAPH_MEMORY.md should exist");

  const tool = first.session.toolsForPhase("prepare").find((entry) => entry.name === "graph_memory");
  assert(tool, "graph_memory tool should be available");
  const ctx = { cwd, log: () => {}, llm: harness.llm };

  const fileDeps = await tool.execute("id", { action: "file_deps", path: target, direction: "inbound" }, ctx);
  assert(fileDeps.details.direct.some((node) => node.path.endsWith("/src/a.ts")), "a.ts should depend on b.ts");
  assert(fileDeps.details.direct.some((node) => node.path.endsWith("/src/c.ts")), "c.ts should depend on b.ts");

  const symbolDeps = await tool.execute("id", { action: "symbol_deps", path: target, symbol: "bar", direction: "inbound" }, ctx);
  assert(symbolDeps.details.direct.some((node) => node.qualifiedName === "foo"), "foo should call bar");

  const blast = await tool.execute("id", { action: "blast_radius", path: target, symbol: "bar" }, ctx);
  assert(blast.details.directFiles.length >= 2, "blast radius should include dependent files");

  await fs.writeFile(target, "export function bar() { return 2; }\nexport function baz() { return bar(); }\n");
  const reopened = await harness.createProjectSession({ cwd, connectMcp: false });
  assert(reopened.graphMemory.getFileNode(target)?.stale, "changed file should reopen as stale");
  const reopenedTool = reopened.session.toolsForPhase("prepare").find((entry) => entry.name === "graph_memory");
  assert(reopenedTool, "graph_memory tool should still be available");
  await reopenedTool.execute("id", { action: "refresh", path: target }, ctx);
  assert(!reopened.graphMemory.getFileNode(target)?.stale, "refresh should clear staleness");
  assert(reopened.graphMemory.findSymbol({ filePath: target, symbol: "baz" }).length === 1, "refresh should rebuild new symbols");

  const pythonCwd = await mkpythonProject();
  const python = await harness.createProjectSession({ cwd: pythonCwd, connectMcp: false });
  const pyMain = path.join(pythonCwd, "app", "main.py");
  const pyDeps = python.graphMemory.fileDeps(pyMain, "outbound");
  assert(pyDeps.direct.length > 0, "python file graph should work");
  assert(pyDeps.capabilityLevel === "partial", "python graph should report tiered capability");

  await harness.dispose();
  console.log("✅ GRAPH MEMORY CHECKS PASSED (index / deps / symbols / blast / stale / refresh / tiered ecosystems)");
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});

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
        content: [{ type: "text", text: JSON.stringify({ summary: `${path.basename(rel)} covers business and technical responsibilities.`, keywords: rel.split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 6) }) }],
      };
    },
    async *stream() {},
  };
}
