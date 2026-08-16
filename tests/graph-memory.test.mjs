import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Harness,
  createGraphMemoryTool,
  resolveGraphMemoryAction,
  resolveModel,
} from "../dist/index.js";

async function mkproject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-memory-"));
  const files = {
    "package.json": JSON.stringify({ name: "graph-memory-demo", type: "module" }),
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

async function mkFiles(files, prefix = "graph-memory-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

function toolCtx(cwd, harness) {
  return { cwd, log: () => {}, llm: harness.llm };
}

async function readLazyGraphResult(result) {
  assert.equal(result.details?.kind, "lazy_tool_result", "graph_memory should return lazy detail metadata");
  const payload = JSON.parse(await fs.readFile(result.details.fullOutputPath, "utf8"));
  return payload.result;
}

async function waitFor(check, timeoutMs = 4000, intervalMs = 75) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
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
        content: [{ type: "text", text: JSON.stringify({ summary: `${path.basename(rel)} covers business and technical responsibilities.`, keywords: rel.split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 6) }) }],
      };
    },
    async *stream() {},
  };
}

function makeHarness(t) {
  const harness = new Harness({ permissionMode: "bypass", llm: makeSummaryLlm() });
  // Dispose even when the test throws. The harness holds a recursive fs watcher
  // per project, and an assertion failure that skips the explicit dispose() at
  // the end of a test leaves that handle open — which does not fail the run, it
  // HANGS it: every test reports its result and then the process never exits.
  // Registering the teardown here means a future failure stays a failure.
  t.after(() => harness.dispose());
  return harness;
}

test("createProjectSession creates and loads graph memory", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const first = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.ok(first.graphMemory, "graphMemory should be attached");
  assert.equal(first.graphMemory.wasCreated, true, "graphMemory should be created on first open");
  assert.ok(first.session.graphMemory === first.graphMemory, "graphMemory should attach to session");
  assert.ok(first.session.toolsForCategorizer("read").some((tool) => tool.name === "graph_memory"), "graph_memory tool should be available");
  await fs.access(path.join(cwd, ".turing", "graph.json"));
  await fs.access(path.join(cwd, ".turing", "GRAPH_MEMORY.md"));
  assert.ok(first.graphMemory.stats().totalFiles >= 3, "graph should index TS files");

  const second = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.ok(second.graphMemory, "graphMemory should load on second open");
  assert.equal(second.graphMemory.wasCreated, false, "second open should load graph memory");
  await harness.dispose();
});

test("graph_memory returns file deps, symbol deps, and blast radius in one call", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session } = await harness.createProjectSession({ cwd, connectMcp: false });
  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "graph_memory");
  assert.ok(tool, "graph_memory tool should exist");

  const fileDeps = await tool.execute("id", { action: "file_deps", path: path.join(cwd, "src", "b.ts"), direction: "inbound" }, toolCtx(cwd, harness));
  const fileDepsResult = await readLazyGraphResult(fileDeps);
  const directFiles = fileDepsResult.direct.map((node) => node.path);
  assert.ok(directFiles.some((p) => p.endsWith("/src/a.ts")), "a.ts should depend on b.ts");
  assert.ok(directFiles.some((p) => p.endsWith("/src/c.ts")), "c.ts should depend on b.ts");

  const symbolDeps = await tool.execute("id", { action: "symbol_deps", path: path.join(cwd, "src", "b.ts"), symbol: "bar", direction: "inbound" }, toolCtx(cwd, harness));
  const symbolDepsResult = await readLazyGraphResult(symbolDeps);
  const directSymbols = symbolDepsResult.direct.map((node) => node.qualifiedName);
  assert.ok(directSymbols.includes("foo"), "foo should call bar");
  assert.ok(directSymbols.includes("helper"), "helper should call bar");

  const blast = await tool.execute("id", { action: "blast_radius", path: path.join(cwd, "src", "b.ts"), symbol: "bar" }, toolCtx(cwd, harness));
  const blastResult = await readLazyGraphResult(blast);
  const blastFiles = blastResult.directFiles.map((node) => node.path);
  assert.ok(blastFiles.some((p) => p.endsWith("/src/a.ts")), "blast radius should include a.ts");
  assert.ok(blastFiles.some((p) => p.endsWith("/src/c.ts")), "blast radius should include c.ts");

  await harness.dispose();
});

test("graph memory stale detection and refresh work", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "b.ts");
  const harness = makeHarness(t);
  const initial = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.equal(initial.graphMemory?.getFileNode(target)?.stale, false, "file graph should start fresh");

  await fs.writeFile(target, "export function bar() { return 2; }\nexport function baz() { return bar(); }\n");

  const reopened = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.equal(reopened.graphMemory?.getFileNode(target)?.stale, true, "reopen should mark changed graph file stale");

  const tool = reopened.session.toolsForCategorizer("read").find((entry) => entry.name === "graph_memory");
  assert.ok(tool, "graph_memory tool should exist");
  await tool.execute("id", { action: "refresh", path: target }, toolCtx(cwd, harness));
  assert.equal(reopened.graphMemory?.getFileNode(target)?.stale, false, "refresh should clear graph staleness");
  assert.ok(reopened.graphMemory?.findSymbol({ filePath: target, symbol: "baz" }).length, "refresh should rebuild new symbols");

  await harness.dispose();
});

test("project watcher refreshes graph memory immediately after file changes", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "b.ts");
  const harness = makeHarness(t);
  const first = await harness.createProjectSession({ cwd, connectMcp: false });
  const second = await harness.createProjectSession({ cwd, connectMcp: false });

  await fs.writeFile(target, "export function bar() { return 2; }\nexport function baz() { return bar(); }\n");

  await waitFor(
    () =>
      Boolean(first.graphMemory?.findSymbol({ filePath: target, symbol: "baz" }).length) &&
      Boolean(second.graphMemory?.findSymbol({ filePath: target, symbol: "baz" }).length),
  );
  assert.equal(first.graphMemory?.getFileNode(target)?.stale, false, "watch refresh should leave first graph fresh");
  assert.equal(second.graphMemory?.getFileNode(target)?.stale, false, "watch refresh should leave second graph fresh");
  assert.ok(first.graphMemory?.findSymbol({ filePath: target, symbol: "baz" }).length, "first session should rebuild symbols");
  assert.ok(second.graphMemory?.findSymbol({ filePath: target, symbol: "baz" }).length, "second session should rebuild symbols");

  await harness.dispose();
});

test("memory:false disables graph memory", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session, graphMemory } = await harness.createProjectSession({ cwd, memory: false, connectMcp: false });
  assert.equal(graphMemory, undefined, "graphMemory should be disabled");
  await assert.rejects(fs.access(path.join(cwd, ".turing", "graph.json")));
  assert.ok(!session.toolsForCategorizer("read").some((tool) => tool.name === "graph_memory"), "graph_memory tool should be absent");
  await harness.dispose();
});

test("graph memory supports representative non-TS ecosystems at file graph level", async (t) => {
  const pythonCwd = await mkFiles({
    "pyproject.toml": "[project]\nname='demo'\n",
    "app/main.py": "from app.routes import router\nfrom app.services import do_work\n",
    "app/routes.py": "from app.services import do_work\n",
    "app/services.py": "def do_work():\n    return 1\n",
  }, "graph-python-");
  const phpCwd = await mkFiles({
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
    "routes/web.php": "<?php\nrequire '../app/Http/Controllers/HomeController.php';\n",
    "app/Http/Controllers/HomeController.php": "<?php\nfunction index() { return view('home'); }\n",
  }, "graph-php-");
  const goCwd = await mkFiles({
    "go.mod": "module demo\n",
    "cmd/main.go": "package main\nimport \"demo/internal/service\"\nfunc main() { service.Run() }\n",
    "internal/service/service.go": "package service\nfunc Run() {}\n",
  }, "graph-go-");

  const harness = makeHarness(t);

  const py = await harness.createProjectSession({ cwd: pythonCwd, connectMcp: false });
  const pyMain = path.join(pythonCwd, "app", "main.py");
  assert.equal(py.graphMemory?.getFileNode(pyMain)?.language, "python");
  assert.equal(py.graphMemory?.getFileNode(pyMain)?.capabilityLevel, "partial");
  const pyDeps = py.graphMemory?.fileDeps(pyMain, "outbound");
  assert.ok(pyDeps?.direct.some((node) => node.path.endsWith("/app/routes.py")));

  const php = await harness.createProjectSession({ cwd: phpCwd, connectMcp: false });
  const phpRoutes = path.join(phpCwd, "routes", "web.php");
  const phpBlast = php.graphMemory?.blastRadius({ targetType: "file", path: phpRoutes });
  assert.ok(phpBlast?.directFiles.some((node) => node.path.endsWith("/app/Http/Controllers/HomeController.php")));

  const go = await harness.createProjectSession({ cwd: goCwd, connectMcp: false });
  const goMain = path.join(goCwd, "cmd", "main.go");
  const goDeps = go.graphMemory?.fileDeps(goMain, "outbound");
  assert.ok(goDeps?.direct.some((node) => node.path.endsWith("/internal/service/service.go")));

  await harness.dispose();
});

test("graph memory preserves per-language identity and resolves suffix-based module layouts across the extended matrix", async (t) => {
  const kotlinCwd = await mkFiles({
    "build.gradle.kts": "plugins { kotlin('jvm') version '2.0.0' }\n",
    "src/main/kotlin/com/demo/Application.kt": "import com.demo.service.UserService\nfun main() { UserService().run() }\n",
    "src/main/kotlin/com/demo/service/UserService.kt": "class UserService { fun run() {} }\n",
  }, "graph-kotlin-");
  const scalaCwd = await mkFiles({
    "build.sbt": "name := 'demo'\n",
    "src/main/scala/com/demo/Main.scala": "import com.demo.service.ReportService\nobject Main { def main(args: Array[String]): Unit = ReportService.run() }\n",
    "src/main/scala/com/demo/service/ReportService.scala": "object ReportService { def run(): Unit = () }\n",
  }, "graph-scala-");
  const swiftCwd = await mkFiles({
    "Package.swift": "import PackageDescription\nlet package = Package(name: 'Demo')\n",
    "Sources/App/main.swift": "import Feature\nfunc main() { render() }\n",
    "Sources/Feature/Feature.swift": "func render() {}\n",
  }, "graph-swift-");
  const miscCwd = await mkFiles({
    "stack.yaml": "resolver: lts-22.0\n",
    "src/Main.hs": "import Demo.Service\nmain = run\n",
    "src/Demo/Service.hs": "run :: IO ()\nrun = pure ()\n",
    "lua/main.lua": "local service = require('service')\nservice.run()\n",
    "lua/service.lua": "function run() end\n",
    "main.pl": "use App::Service;\nrun();\n",
    "App/Service.pm": "package App::Service;\nsub run {}\n1;\n",
    "main.R": "library(ggplot2)\nrun <- function() {}\n",
    "src/main.zig": "const service = @import(\"service.zig\");\npub fn main() void { service.run(); }\n",
    "src/service.zig": "pub fn run() void {}\n",
  }, "graph-misc-");

  const harness = makeHarness(t);

  const kotlin = await harness.createProjectSession({ cwd: kotlinCwd, connectMcp: false });
  const kotlinMain = path.join(kotlinCwd, "src", "main", "kotlin", "com", "demo", "Application.kt");
  assert.equal(kotlin.graphMemory?.getFileNode(kotlinMain)?.language, "kotlin");
  assert.ok(kotlin.graphMemory?.fileDeps(kotlinMain, "outbound").direct.some((node) => node.path.endsWith("/UserService.kt")));

  const scala = await harness.createProjectSession({ cwd: scalaCwd, connectMcp: false });
  const scalaMain = path.join(scalaCwd, "src", "main", "scala", "com", "demo", "Main.scala");
  assert.equal(scala.graphMemory?.getFileNode(scalaMain)?.language, "scala");
  assert.ok(scala.graphMemory?.fileDeps(scalaMain, "outbound").direct.some((node) => node.path.endsWith("/ReportService.scala")));

  const swift = await harness.createProjectSession({ cwd: swiftCwd, connectMcp: false });
  const swiftMain = path.join(swiftCwd, "Sources", "App", "main.swift");
  assert.equal(swift.graphMemory?.getFileNode(swiftMain)?.language, "swift");
  assert.ok(swift.graphMemory?.fileDeps(swiftMain, "outbound").direct.some((node) => node.path.endsWith("/Sources/Feature/Feature.swift")));

  const misc = await harness.createProjectSession({ cwd: miscCwd, connectMcp: false });
  assert.equal(misc.graphMemory?.getFileNode(path.join(miscCwd, "src", "Main.hs"))?.language, "haskell");
  assert.equal(misc.graphMemory?.getFileNode(path.join(miscCwd, "lua", "main.lua"))?.language, "lua");
  assert.equal(misc.graphMemory?.getFileNode(path.join(miscCwd, "main.pl"))?.language, "perl");
  assert.equal(misc.graphMemory?.getFileNode(path.join(miscCwd, "main.R"))?.language, "r");
  assert.equal(misc.graphMemory?.getFileNode(path.join(miscCwd, "src", "main.zig"))?.language, "zig");
  assert.ok(misc.graphMemory?.fileDeps(path.join(miscCwd, "lua", "main.lua"), "outbound").direct.some((node) => node.path.endsWith("/lua/service.lua")));
  assert.ok(misc.graphMemory?.fileDeps(path.join(miscCwd, "src", "main.zig"), "outbound").direct.some((node) => node.path.endsWith("/src/service.zig")));

  await harness.dispose();
});

test("graph memory builds symbol graphs for parser-backed non-TS language adapters", async (t) => {
  const pythonCwd = await mkFiles({
    "pyproject.toml": "[project]\nname='demo'\n",
    "app/service.py": "class Service:\n    def run(self):\n        return helper()\n\ndef helper():\n    return 1\n",
  }, "graph-symbol-python-");
  const goCwd = await mkFiles({
    "go.mod": "module demo\n",
    "internal/service/service.go": "package service\ntype Service struct {}\nfunc (s Service) Run() { Helper() }\nfunc Helper() {}\n",
  }, "graph-symbol-go-");
  const rustCwd = await mkFiles({
    "Cargo.toml": "[package]\nname='demo'\nversion='0.1.0'\n",
    "src/lib.rs": "pub struct Service {}\nimpl Service {\n  pub fn run(&self) {\n    helper();\n  }\n}\npub fn helper() {}\n",
  }, "graph-symbol-rust-");
  const jvmCwd = await mkFiles({
    "build.gradle.kts": "plugins { kotlin('jvm') version '2.0.0' }\n",
    "src/main/kotlin/com/demo/Service.kt": "class Service {\n  fun run() {\n    helper()\n  }\n}\nfun helper() {}\n",
  }, "graph-symbol-jvm-");
  const dotnetCwd = await mkFiles({
    "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>\n",
    "Service.cs": "namespace Demo;\npublic class Service {\n  public void Run() {\n    Helper();\n  }\n}\npublic static class Helpers {\n  public static void Helper() {}\n}\n",
  }, "graph-symbol-dotnet-");
  const swiftCwd = await mkFiles({
    "Package.swift": "import PackageDescription\nlet package = Package(name: \"Demo\")\n",
    "Sources/App/Service.swift": "struct Service {\n  func run() {\n    helper()\n  }\n}\nfunc helper() {}\n",
  }, "graph-symbol-swift-");

  const harness = makeHarness(t);

  const python = await harness.createProjectSession({ cwd: pythonCwd, connectMcp: false });
  assert.ok(python.graphMemory?.findSymbol({ filePath: path.join(pythonCwd, "app", "service.py"), symbol: "run" }).length);
  assert.ok(
    python.graphMemory?.symbolDeps({
      filePath: path.join(pythonCwd, "app", "service.py"),
      symbol: "run",
    }, "outbound").direct.some((node) => node.qualifiedName.endsWith("helper")),
  );

  const go = await harness.createProjectSession({ cwd: goCwd, connectMcp: false });
  assert.ok(go.graphMemory?.findSymbol({ filePath: path.join(goCwd, "internal", "service", "service.go"), symbol: "Run" }).length);
  assert.ok(
    go.graphMemory?.symbolDeps({
      filePath: path.join(goCwd, "internal", "service", "service.go"),
      symbol: "Run",
    }, "outbound").direct.some((node) => node.qualifiedName.endsWith("Helper")),
  );

  const rust = await harness.createProjectSession({ cwd: rustCwd, connectMcp: false });
  assert.ok(rust.graphMemory?.findSymbol({ filePath: path.join(rustCwd, "src", "lib.rs"), qualifiedName: "Service.run" }).length);

  const jvm = await harness.createProjectSession({ cwd: jvmCwd, connectMcp: false });
  assert.ok(jvm.graphMemory?.findSymbol({ filePath: path.join(jvmCwd, "src", "main", "kotlin", "com", "demo", "Service.kt"), symbol: "run" }).length);

  const dotnet = await harness.createProjectSession({ cwd: dotnetCwd, connectMcp: false });
  assert.ok(dotnet.graphMemory?.findSymbol({ filePath: path.join(dotnetCwd, "Service.cs"), symbol: "Run" }).length);

  const swift = await harness.createProjectSession({ cwd: swiftCwd, connectMcp: false });
  assert.ok(swift.graphMemory?.findSymbol({ filePath: path.join(swiftCwd, "Sources", "App", "Service.swift"), symbol: "run" }).length);

  await harness.dispose();
});

test("graph memory ignores Android/iOS build artifacts but keeps native source files", async (t) => {
  const cwd = await mkFiles({
    "android/app/src/main/java/com/demo/MainActivity.java": "package com.demo;\npublic class MainActivity {}\n",
    "android/build/generated/source/buildConfig/debug/com/demo/BuildConfig.java": "package com.demo;\npublic class BuildConfig {}\n",
    "android/app/.cxx/debug/arm64-v8a/log.txt": "generated\n",
    "ios/App/AppDelegate.swift": "import UIKit\nclass AppDelegate: UIResponder {}\n",
    "ios/.symlinks/plugins/path.txt": "generated\n",
    "ios/Flutter/Generated.xcconfig": "// generated\n",
    "ios/Pods/Pods.xcodeproj/project.pbxproj": "// pods project\n",
  }, "graph-mobile-ignore-");
  const harness = makeHarness(t);
  const { graphMemory } = await harness.createProjectSession({ cwd, connectMcp: false });

  assert.ok(graphMemory?.getFileNode(path.join(cwd, "android", "app", "src", "main", "java", "com", "demo", "MainActivity.java")));
  assert.ok(graphMemory?.getFileNode(path.join(cwd, "ios", "App", "AppDelegate.swift")));
  assert.equal(
    graphMemory?.getFileNode(path.join(cwd, "android", "build", "generated", "source", "buildConfig", "debug", "com", "demo", "BuildConfig.java")),
    undefined,
  );
  assert.equal(graphMemory?.getFileNode(path.join(cwd, "android", "app", ".cxx", "debug", "arm64-v8a", "log.txt")), undefined);
  assert.equal(graphMemory?.getFileNode(path.join(cwd, "ios", ".symlinks", "plugins", "path.txt")), undefined);
  assert.equal(graphMemory?.getFileNode(path.join(cwd, "ios", "Flutter", "Generated.xcconfig")), undefined);
  assert.equal(graphMemory?.getFileNode(path.join(cwd, "ios", "Pods", "Pods.xcodeproj", "project.pbxproj")), undefined);

  await harness.dispose();
});

test("framework overlays add convention edges and capability-aware query notes", async (t) => {
  const cwd = await mkFiles({
    "package.json": JSON.stringify({ dependencies: { next: "15", react: "19" } }),
    "app/page.tsx": "export default function Page() { return null; }\n",
    "app/layout.tsx": "export default function Layout({ children }) { return children; }\n",
    "components/Card.tsx": "export function Card() { return null; }\n",
    "routes/web.php": "<?php\n",
    "app/Http/Controllers/HomeController.php": "<?php\nclass HomeController {}\n",
  }, "graph-overlay-");
  const harness = makeHarness(t);
  const { graphMemory, session } = await harness.createProjectSession({ cwd, connectMcp: false });
  const nextPage = path.join(cwd, "app", "page.tsx");
  const nextDeps = graphMemory?.fileDeps(nextPage, "outbound");
  assert.ok(nextDeps?.edges.some((edge) => edge.reason === "page uses layout"), "next overlay should add layout edge");

  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "graph_memory");
  assert.ok(tool);
  const phpSymbol = await tool.execute("id", {
    action: "symbol_deps",
    path: path.join(cwd, "routes", "web.php"),
    symbol: "missing",
  }, toolCtx(cwd, harness));
  // symbol_deps returns a lazy detail envelope, so the payload has to be read
  // back through it — `details.notes` is undefined by construction.
  const phpSymbolResult = await readLazyGraphResult(phpSymbol);
  assert.ok(Array.isArray(phpSymbolResult.notes), "partial ecosystems should surface notes");

  await harness.dispose();
});

test("resolveGraphMemoryAction infers action when the model omits it", () => {
  assert.equal(resolveGraphMemoryAction({ action: "blast_radius", path: "a.ts" }), "blast_radius");
  assert.equal(resolveGraphMemoryAction({ paths: ["a.ts"] }), "refresh");
  assert.equal(resolveGraphMemoryAction({ symbol: "foo" }), "find_symbol");
  assert.equal(resolveGraphMemoryAction({ qualifiedName: "M.foo" }), "find_symbol");
  assert.equal(resolveGraphMemoryAction({ path: "a.ts" }), "file_deps");
  assert.equal(resolveGraphMemoryAction({}), "stats");
  const tool = createGraphMemoryTool(/** @type {any} */ ({}), undefined);
  assert.ok(!tool.parameters.required.includes("action"));
});
