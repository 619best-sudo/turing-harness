import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Harness,
  createFileMemoryTool,
  resolveFileMemoryAction,
  resolveModel,
} from "../dist/index.js";
import { ProjectWatcherRuntime } from "../dist/memory/project-watcher-runtime.js";

async function mkproject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-memory-"));
  const files = {
    "package.json": JSON.stringify({
      name: "file-memory-demo",
      scripts: { test: "node --test", dev: "node server.js" },
      dependencies: { express: "5.0.0" },
    }),
    "README.md": "# Demo\n\nSearch files in one go.\n",
    "src/search-engine.ts": [
      "/**",
      " * Search files in one go across the durable memory index.",
      " */",
      "export function searchFilesOnce(query: string) {",
      "  return query.trim();",
      "}",
      "",
    ].join("\n"),
    "src/config/app-config.ts": "export const APP_NAME = 'demo';\n",
    "src/config/app-confg.ts": "export const LEGACY_APP_NAME = 'demo-legacy';\n",
    "src/index.ts": "export * from './search-engine.js';\n",
    "tests/search-engine.test.ts": "export const smoke = true;\n",
    "pyproject.toml": "[project]\nname = 'demo'\ndependencies = ['fastapi']\n",
    "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health():\n    return {'ok': True}\n",
    "composer.json": JSON.stringify({
      name: "demo/php-app",
      require: { "laravel/framework": "^11.0" },
    }),
    "routes/web.php": "<?php\n// Laravel routes\nRoute::get('/', fn () => 'ok');\n",
    "src/backend/Program.cs": "using Microsoft.AspNetCore.Builder;\nnamespace Demo;\npublic class Program { public static void Main(string[] args) { var builder = WebApplication.CreateBuilder(args); } }\n",
    "src/backend/appsettings.json": "{ \"Logging\": { \"LogLevel\": { \"Default\": \"Information\" } } }\n",
    "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: \"Demo\")\n",
    "mix.exs": "defmodule Demo.MixProject do\n  use Mix.Project\nend\n",
    "build.sbt": "name := \"demo\"\nscalaVersion := \"3.3.1\"\n",
    "deps.edn": "{:deps {org.clojure/clojure {:mvn/version \"1.11.1\"}}}\n",
    "Cargo.toml": "[package]\nname = 'demo'\nversion = '0.1.0'\n[dependencies]\nbevy = '0.14'\n",
    "src/game/main.rs": "use bevy::prelude::*;\nfn main() { App::new(); }\n",
    "Gemfile": "gem 'rails'\n",
    "config/routes.rb": "Rails.application.routes.draw do\n  get '/health', to: 'health#show'\nend\n",
    "pubspec.yaml": "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n",
    "lib/main.dart": "import 'package:flutter/widgets.dart';\nvoid main() => runApp(const Placeholder());\n",
    "gatsby-config.js": "module.exports = { plugins: ['gatsby-plugin-image'] };\n",
    "app/routes/users.tsx": "import { json } from '@remix-run/node';\nexport async function loader() { return json({ ok: true }); }\n",
    "src/routes/index.tsx": "import { component$ } from '@builder.io/qwik';\nexport default component$(() => null);\n",
    "src/server/micronaut/Application.java": "import io.micronaut.runtime.Micronaut;\npublic class Application { public static void main(String[] args) { Micronaut.run(Application.class); } }\n",
    "src/server/quarkus/GreetingResource.java": "import jakarta.ws.rs.GET;\nimport jakarta.ws.rs.Path;\n@Path('/hello')\npublic class GreetingResource { @GET public String hello() { return 'ok'; } }\n",
    "src/server/ktor/Application.kt": "import io.ktor.server.application.*\nfun Application.module() {}\n",
    "src/mobile/ionic/App.tsx": "import { App as CapacitorApp } from '@capacitor/app';\nexport function MobileApp() { return CapacitorApp; }\n",
    "src/server/hapi/server.ts": "import Hapi from '@hapi/hapi';\nexport async function createServer() { return Hapi.server(); }\n",
    "src/server/trpc/router.ts": "import { initTRPC } from '@trpc/server';\nexport const t = initTRPC.create();\n",
    "src/server/adonisjs/start.ts": "import '@adonisjs/core';\nexport const boot = true;\n",
    "src/server/starlette/app.py": "from starlette.applications import Starlette\napp = Starlette()\n",
    "src/server/aiohttp/app.py": "from aiohttp import web\napp = web.Application()\n",
    "src/server/sanic/app.py": "from sanic import Sanic\napp = Sanic('demo')\n",
    "src/server/falcon/app.py": "import falcon\napp = falcon.App()\n",
    "src/server/tornado/app.py": "import tornado.web\nclass HomeHandler(tornado.web.RequestHandler):\n    pass\n",
    "src/frontend/client.tsx": "import { createRoot } from 'react-dom/client';\nexport function mount(root) { return createRoot(root); }\n",
    "demo.cabal": "name: demo\nversion: 0.1.0.0\n",
    "demo.rockspec": "package = 'demo'\nversion = '0.1-0'\n",
    "cpanfile": "requires 'Mojolicious';\n",
    "DESCRIPTION": "Package: demo\nVersion: 0.1.0\n",
    "build.zig": "const std = @import(\"std\");\npub fn build(b: *std.Build) void {}\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  for (let i = 0; i < 120; i++) {
    const file = path.join(dir, "src/generated", `file-${String(i).padStart(3, "0")}.ts`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `export const value${i} = ${i};\n`);
  }
  return dir;
}

function toolCtx(cwd, harness) {
  return { cwd, log: () => {}, llm: harness.llm };
}

async function readLazyToolResult(result) {
  assert.equal(result.details?.kind, "lazy_tool_result", "tool should return lazy detail metadata");
  assert.equal(typeof result.details?.fullOutputPath, "string", "lazy details should include a full output path");
  return JSON.parse(await fs.readFile(result.details.fullOutputPath, "utf8"));
}

function makeSummaryLlm() {
  return {
    resolveModel: (slug) => resolveModel(slug),
    async complete(model, context) {
      const prompt = String(context.messages?.[0]?.content ?? "");
      const rel = /path:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? "unknown";
      const base = path.basename(rel);
      return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: `${base} covers business behavior and technical implementation for ${rel}.`,
              keywords: [...new Set(rel.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8))],
              keySymbols: [base.replace(/\.[^.]+$/, "").toLowerCase()],
              dependencies: [],
              routes: [],
              interfaces: [`symbol:${base.replace(/\.[^.]+$/, "").toLowerCase()}`],
              responsibilities: ["semantic summary"],
              frameworkHints: [],
              language: undefined,
            }),
          },
        ],
      };
    },
    async *stream() {},
  };
}

function makeCountingSummaryLlm() {
  const inner = makeSummaryLlm();
  const calls = [];
  return {
    calls,
    resolveModel: inner.resolveModel,
    async complete(model, context, options) {
      const prompt = String(context.messages?.[0]?.content ?? "");
      calls.push({ path: /path:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? "unknown", options });
      return inner.complete(model, context, options);
    },
    async *stream() {},
  };
}

function makeHarness(t, llm) {
  const harness = new Harness({ permissionMode: "bypass", llm: llm ?? makeSummaryLlm() });
  // Dispose even when the test throws. The harness holds a recursive fs watcher
  // per project, and an assertion failure that skips the explicit dispose() at
  // the end of a test leaves that handle open — which does not fail the run, it
  // HANGS it: every test reports its result and then the process never exits.
  // Registering the teardown here means a future failure stays a failure.
  t.after(() => harness.dispose());
  return harness;
}

test("createProjectSession creates and loads file memory for large projects", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);

  const first = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.ok(first.fileMemory, "fileMemory should be attached");
  assert.equal(first.fileMemory.wasCreated, true, "fileMemory should be created on first open");
  assert.ok(first.session.fileMemory === first.fileMemory, "fileMemory should be attached to session");
  assert.ok(first.fileMemoryRuntime, "fileMemory runtime should be attached");
  assert.ok(first.session.toolsForCategorizer("read").some((tool) => tool.name === "file_memory"), "file_memory tool should be available");
  await first.fileMemoryRuntime?.drain();

  await fs.access(path.join(cwd, ".turing", "files.json"));
  await fs.access(path.join(cwd, ".turing", "FILES_MEMORY.md"));
  assert.ok(first.fileMemory.stats().totalFiles >= 120, "index should include the generated files");

  const second = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.ok(second.fileMemory, "fileMemory should load on second open");
  assert.equal(second.fileMemory.wasCreated, false, "second open should load existing file memory");

  await harness.dispose();
});

test("file_memory search returns ranked results in one call across 100+ files", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session } = await harness.createProjectSession({ cwd, connectMcp: false });
  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "file_memory");
  assert.ok(tool, "file_memory tool should exist");

  const result = await tool.execute("id", { action: "search", query: "search files in one go", limit: 5 }, toolCtx(cwd, harness));
  const matches = await readLazyToolResult(result);
  assert.ok(Array.isArray(matches), "search should return structured results");
  assert.ok(matches.length > 0, "search should return at least one result");
  assert.match(matches[0].path, /src\/search-engine\.ts$/, "best result should be the indexed search source file");

  await harness.dispose();
});

test("file_memory search supports typo-aware fuzzy fallback for misspellings", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session } = await harness.createProjectSession({ cwd, connectMcp: false });
  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "file_memory");
  assert.ok(tool, "file_memory tool should exist");

  const result = await tool.execute(
    "id",
    { action: "search", query: "serch engne", limit: 5 },
    toolCtx(cwd, harness),
  );
  const matches = await readLazyToolResult(result);
  assert.ok(Array.isArray(matches), "search should return structured results");
  assert.ok(matches.length > 0, "fuzzy search should return at least one result");
  assert.match(matches[0].path, /src\/search-engine\.ts$/, "best fuzzy result should be search-engine.ts");
  assert.ok(
    matches[0].reasons.some((reason) => reason.includes("fuzzy")),
    "fuzzy fallback should explain why the misspelling matched",
  );

  await harness.dispose();
});

test("file_memory keeps exact matches ahead of fuzzy neighbors when direct ranking is strong", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session } = await harness.createProjectSession({ cwd, connectMcp: false });
  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "file_memory");
  assert.ok(tool, "file_memory tool should exist");

  const result = await tool.execute(
    "id",
    { action: "search", query: "app config", limit: 5 },
    toolCtx(cwd, harness),
  );
  const matches = await readLazyToolResult(result);
  assert.ok(Array.isArray(matches), "search should return structured results");
  assert.match(matches[0].path, /src\/config\/app-config\.ts$/, "exact file should beat the typo-shaped neighbor");
  assert.doesNotMatch(
    matches[0].reasons.join(" "),
    /fuzzy/i,
    "strong direct matches should not need fuzzy fallback",
  );

  await harness.dispose();
});

test("file_memory tags and summaries cover representative non-JS ecosystems", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session, fileMemory } = await harness.createProjectSession({ cwd, connectMcp: false });
  const tool = session.toolsForCategorizer("read").find((entry) => entry.name === "file_memory");
  assert.ok(tool, "file_memory tool should exist");

  const phpEntry = fileMemory.get(path.join(cwd, "composer.json"));
  assert.ok(phpEntry?.tags.includes("php"), "composer.json should be tagged as php");
  assert.match(phpEntry?.summary ?? "", /Composer manifest/i);

  const dotnetEntry = fileMemory.get(path.join(cwd, "src", "backend", "Program.cs"));
  assert.ok(dotnetEntry?.tags.includes("csharp"), "Program.cs should be tagged as csharp");

  const swiftSearch = await tool.execute("id", { action: "search", query: "swift package manifest", limit: 3 }, toolCtx(cwd, harness));
  assert.match((await readLazyToolResult(swiftSearch))[0].path, /Package\.swift$/, "swift query should return Package.swift");

  const zigSearch = await tool.execute("id", { action: "search", query: "zig build script", limit: 3 }, toolCtx(cwd, harness));
  assert.match((await readLazyToolResult(zigSearch))[0].path, /build\.zig$/, "zig query should return build.zig");

  await harness.dispose();
});

test("file_memory exposes semantic summaries and expanded framework tags without reading the source file", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { fileMemory } = await harness.createProjectSession({
    cwd,
    connectMcp: false,
    fileMemoryRuntime: { autoStartHydration: false, llmSyncEnabled: false },
  });

  const searchEntry = fileMemory.get(path.join(cwd, "src", "search-engine.ts"));
  assert.match(searchEntry?.summary ?? "", /key symbols/i);
  assert.ok(searchEntry?.keySymbols.includes("searchfilesonce"), "semantic memory should capture key symbols");
  assert.ok(searchEntry?.interfaces.includes("symbol:searchfilesonce"), "semantic memory should expose file interface");

  assert.ok(fileMemory.get(path.join(cwd, "gatsby-config.js"))?.tags.includes("gatsby"), "gatsby config should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "app", "routes", "users.tsx"))?.tags.includes("remix"), "remix route should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "routes", "index.tsx"))?.tags.includes("qwik"), "qwik route should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "micronaut", "Application.java"))?.tags.includes("micronaut"), "micronaut app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "quarkus", "GreetingResource.java"))?.tags.includes("quarkus"), "quarkus resource should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "ktor", "Application.kt"))?.tags.includes("ktor"), "ktor app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "backend", "Program.cs"))?.tags.includes("aspnet"), "aspnet program should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "mobile", "ionic", "App.tsx"))?.tags.includes("ionic/capacitor"), "ionic app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "game", "main.rs"))?.tags.includes("bevy"), "bevy game entry should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "hapi", "server.ts"))?.tags.includes("hapi"), "hapi server should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "trpc", "router.ts"))?.tags.includes("trpc"), "trpc router should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "adonisjs", "start.ts"))?.tags.includes("adonisjs"), "adonisjs start should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "starlette", "app.py"))?.tags.includes("starlette"), "starlette app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "aiohttp", "app.py"))?.tags.includes("aiohttp"), "aiohttp app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "sanic", "app.py"))?.tags.includes("sanic"), "sanic app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "falcon", "app.py"))?.tags.includes("falcon"), "falcon app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "server", "tornado", "app.py"))?.tags.includes("tornado"), "tornado app should be tagged");
  assert.ok(fileMemory.get(path.join(cwd, "src", "frontend", "client.tsx"))?.tags.includes("react-dom"), "react-dom client should be tagged");
  assert.equal(fileMemory.get(path.join(cwd, "composer.json"))?.role, "manifest", "composer manifest should use manifest role");
  assert.equal(fileMemory.get(path.join(cwd, "build.sbt"))?.role, "build", "build.sbt should use build role");
  assert.equal(fileMemory.get(path.join(cwd, "routes", "web.php"))?.role, "route", "route files should use route role");

  await harness.dispose();
});

test("file_memory ignores Android/iOS build artifacts but keeps native source files", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-memory-mobile-"));
  const files = {
    "android/app/src/main/java/com/demo/MainActivity.java": "package com.demo;\npublic class MainActivity {}\n",
    "android/build/generated/source/buildConfig/debug/com/demo/BuildConfig.java": "package com.demo;\npublic class BuildConfig {}\n",
    "android/app/.cxx/debug/arm64-v8a/log.txt": "generated\n",
    "ios/App/AppDelegate.swift": "import UIKit\nclass AppDelegate: UIResponder {}\n",
    "ios/.symlinks/plugins/path.txt": "generated\n",
    "ios/Flutter/Generated.xcconfig": "// generated\n",
    "ios/Pods/Pods.xcodeproj/project.pbxproj": "// pods project\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  const harness = makeHarness(t);
  const { fileMemory } = await harness.createProjectSession({ cwd: dir, connectMcp: false });
  assert.ok(fileMemory.get(path.join(dir, "android", "app", "src", "main", "java", "com", "demo", "MainActivity.java")));
  assert.ok(fileMemory.get(path.join(dir, "ios", "App", "AppDelegate.swift")));
  assert.equal(fileMemory.get(path.join(dir, "android", "build", "generated", "source", "buildConfig", "debug", "com", "demo", "BuildConfig.java")), undefined);
  assert.equal(fileMemory.get(path.join(dir, "android", "app", ".cxx", "debug", "arm64-v8a", "log.txt")), undefined);
  assert.equal(fileMemory.get(path.join(dir, "ios", ".symlinks", "plugins", "path.txt")), undefined);
  assert.equal(fileMemory.get(path.join(dir, "ios", "Flutter", "Generated.xcconfig")), undefined);
  assert.equal(fileMemory.get(path.join(dir, "ios", "Pods", "Pods.xcodeproj", "project.pbxproj")), undefined);

  await harness.dispose();
});

test("file_memory ignores build output and dependency trees across ecosystems, at any depth", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-memory-stacks-"));
  const kept = [
    // Real source that shares a parent name with generated trees, or sits one
    // level away from one. None of these may be skipped.
    "lib/main.dart",
    "assets/images/logo.svg",
    "packages/ui/src/Button.tsx",
    "src/app/page.tsx",
    "cmd/server/main.go",
    "app/models/user.rb",
    "Sources/App/Service.swift",
    "unity/Assets/Scripts/Player.cs",
    "docs/public/index.md",
  ];
  const ignored = [
    // Flutter/Gradle/CMake: the case that started this — a top-level `build/`.
    "build/app/intermediates/flutter/release/flutter_assets/assets/icon.svg",
    "build/ios/Release-iphoneos/Runner.app/Info.plist",
    ".dart_tool/package_config.json",
    // JS / TS
    "node_modules/react/index.js",
    "apps/web/node_modules/lodash/index.js",
    "apps/web/.next/server/pages.js",
    ".turbo/cache/log.txt",
    "web/dist/bundle.js",
    "storybook-static/iframe.html",
    // Python
    "api/__pycache__/main.cpython-312.pyc",
    ".venv/lib/python3.12/site-packages/fastapi/main.py",
    ".ruff_cache/content.json",
    // JVM / Android
    "service/target/classes/App.class",
    "android/app/.cxx/debug/log.txt",
    ".gradle/caches/journal.bin",
    // Apple
    "ios/Pods/Firebase/Firebase.h",
    "Carthage/Build/iOS/Alamofire.framework/Info.plist",
    "DerivedData/App/Build/Products/App.app/Info.plist",
    // Rust / Go / Ruby / PHP / .NET / Elixir / Haskell
    "rust/target/debug/deps/app.d",
    "go/vendor/github.com/pkg/errors/errors.go",
    ".bundle/config",
    "php/vendor/laravel/framework/src/App.php",
    "dotnet/bin/Debug/net8.0/App.dll",
    "dotnet/obj/project.assets.json",
    "elixir/_build/dev/lib/app/app.beam",
    "haskell/dist-newstyle/build/app/App.hi",
    // Bazel / infra / static sites
    "bazel-out/k8-fastbuild/bin/app",
    "infra/.terraform/plugins/registry.json",
    "cdk.out/App.template.json",
    "site/_site/index.html",
  ];
  for (const name of [...kept, ...ignored]) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `// ${name}\n`);
  }

  const harness = makeHarness(t);
  const { fileMemory } = await harness.createProjectSession({ cwd: dir, connectMcp: false });
  for (const name of kept) {
    assert.ok(fileMemory.get(path.join(dir, name)), `expected ${name} to be indexed`);
  }
  for (const name of ignored) {
    assert.equal(fileMemory.get(path.join(dir, name)), undefined, `expected ${name} to be ignored`);
  }

  await harness.dispose();
});

test("external edits become stale on reopen and refresh clears staleness", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const harness = makeHarness(t);

  const initial = await harness.createProjectSession({ cwd, connectMcp: false });
  assert.equal(initial.fileMemory?.get(target)?.stale, false, "fresh file should not start stale");

  await fs.writeFile(
    target,
    [
      "/**",
      " * Search files in one go and rank refreshed results.",
      " */",
      "export function searchFilesOnce(query: string) {",
      "  return `ranked:${query.trim()}`;",
      "}",
      "",
    ].join("\n"),
  );

  const reopened = await harness.createProjectSession({ cwd, connectMcp: false });
  const staleEntry = reopened.fileMemory?.get(target);
  assert.equal(staleEntry?.stale, true, "reopen should detect that the file became stale");
  assert.match(staleEntry?.staleReason ?? "", /filesystem changed/);

  const tool = reopened.session.toolsForCategorizer("read").find((entry) => entry.name === "file_memory");
  assert.ok(tool, "file_memory tool should exist");
  await tool.execute("id", { action: "refresh", path: target }, toolCtx(cwd, harness));
  const refreshed = reopened.fileMemory?.get(target);
  assert.equal(refreshed?.stale, false, "refresh should clear staleness");
  assert.match(refreshed?.summary ?? "", /Search files in one go and rank refreshed results/);

  await harness.dispose();
});

test("memory:false disables file memory", async (t) => {
  const cwd = await mkproject();
  const harness = makeHarness(t);
  const { session, fileMemory } = await harness.createProjectSession({ cwd, memory: false, connectMcp: false });
  assert.equal(fileMemory, undefined, "fileMemory should be disabled when memory:false");
  await assert.rejects(fs.access(path.join(cwd, ".turing", "files.json")));
  assert.ok(!session.toolsForCategorizer("read").some((tool) => tool.name === "file_memory"), "file_memory tool should be absent");
  await harness.dispose();
});

test("background hydration upgrades summaries and watcher refreshes changed files", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const harness = makeHarness(t);
  // Eager mode, opted into explicitly: sweep the whole index at startup and run
  // summaries as paths arrive. Not the default — see the deferred tests below.
  const first = await harness.createProjectSession({
    cwd,
    connectMcp: false,
    fileMemoryRuntime: { summarizeOn: "all", deferUntilFlush: false },
  });

  await first.fileMemoryRuntime?.drain();
  const hydrated = first.fileMemory?.get(target);
  assert.equal(hydrated?.summarySource, "llm");
  assert.ok(hydrated?.keywords.length, "llm hydration should write keywords");
  assert.match(hydrated?.summary ?? "", /business behavior and technical implementation/i);

  await fs.writeFile(
    target,
    [
      "export function refreshSearchIndex(query: string) {",
      "  return `updated:${query}`;",
      "}",
      "",
    ].join("\n"),
  );

  await new Promise((resolve) => setTimeout(resolve, 400));
  await first.fileMemoryRuntime?.drain();
  const updated = first.fileMemory?.get(target);
  assert.equal(updated?.summarySource, "llm");
  assert.match(updated?.summary ?? "", /refreshSearchIndex|search-engine\.ts/i);

  await harness.dispose();
});

test("project watcher defers file-memory refresh while a session run is active", async () => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const watcher = new ProjectWatcherRuntime({ cwd });
  const seen = [];
  try {
    // `mkproject()` writes a hundred-odd files immediately before this, and the
    // watcher keeps receiving their trailing fs events for a beat afterwards.
    // Subscribe only once those have drained, so the deferred batch under test
    // contains the file this test actually edited and nothing else — otherwise
    // the assertion below is a race against project setup.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    watcher.subscribe("session-1", {
      fileMemoryRuntime: {
        onExternalFileChange: async (filePath) => {
          seen.push(filePath);
        },
      },
    });

    watcher.suspend("session-1");
    await fs.writeFile(
      target,
      [
        "export function refreshSearchIndex(query: string) {",
        "  return `updated:${query}`;",
        "}",
        "",
      ].join("\n"),
    );

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(seen, [], "watcher should not refresh file memory while suspended");

    await watcher.resume("session-1");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(seen, [target], "resume should flush one deferred refresh for the changed file");
  } finally {
    await watcher.dispose();
  }
});

test("manual refresh mode delays full LLM sync until explicitly requested and persists project sync state", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const harness = makeHarness(t);
  const first = await harness.createProjectSession({
    cwd,
    connectMcp: false,
    fileMemoryRuntime: { autoStartHydration: false, llmSyncEnabled: false },
  });

  await new Promise((resolve) => setTimeout(resolve, 250));
  const initial = first.fileMemory?.get(target);
  assert.equal(initial?.summarySource, "heuristic");
  assert.equal(first.fileMemory?.summarySync.llmSyncEnabled, false);
  assert.equal(first.fileMemory?.summarySync.lastFullSummarySyncCompletedAt, undefined);

  await first.fileMemoryRuntime?.refreshAllSummaries();
  const hydrated = first.fileMemory?.get(target);
  assert.equal(hydrated?.summarySource, "llm");
  assert.equal(first.fileMemory?.summarySync.llmSyncEnabled, true);
  assert.ok(first.fileMemory?.summarySync.lastFullSummarySyncStartedAt, "manual refresh should record start time");
  assert.ok(first.fileMemory?.summarySync.lastFullSummarySyncCompletedAt, "manual refresh should record completion time");

  const reopened = await harness.createProjectSession({
    cwd,
    connectMcp: false,
    fileMemoryRuntime: { autoStartHydration: false },
  });
  assert.equal(reopened.fileMemory?.summarySync.llmSyncEnabled, true, "manual enablement should persist per project");
  assert.ok(
    reopened.fileMemory?.summarySync.lastFullSummarySyncCompletedAt,
    "reopened project should preserve last full sync timestamp",
  );

  await harness.dispose();
});

test("watcher does not run llm before enablement and resumes changed-file llm refresh after enablement", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const harness = makeHarness(t);
  const first = await harness.createProjectSession({
    cwd,
    connectMcp: false,
    fileMemoryRuntime: { autoStartHydration: false, llmSyncEnabled: false, deferUntilFlush: false },
  });

  await fs.writeFile(
    target,
    [
      "export function searchFilesOnce(query: string) {",
      "  return `manual:${query}`;",
      "}",
      "",
    ].join("\n"),
  );

  await new Promise((resolve) => setTimeout(resolve, 450));
  const beforeEnable = first.fileMemory?.get(target);
  assert.equal(beforeEnable?.summarySource, "heuristic");
  assert.equal(beforeEnable?.summaryPending, false);

  await first.fileMemoryRuntime?.refreshAllSummaries();
  await fs.writeFile(
    target,
    [
      "export function refreshSearchIndex(query: string) {",
      "  return `updated:${query}`;",
      "}",
      "",
    ].join("\n"),
  );

  await new Promise((resolve) => setTimeout(resolve, 450));
  await first.fileMemoryRuntime?.drain();
  const afterEnable = first.fileMemory?.get(target);
  assert.equal(afterEnable?.summarySource, "llm");
  assert.match(afterEnable?.summary ?? "", /refreshSearchIndex|search-engine\.ts/i);

  await harness.dispose();
});

test("by default no summary runs on session open — only on the files a run wrote", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const other = path.join(cwd, "src", "index.ts");
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemory, fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  // Opening a project owes it nothing. The old default swept the whole index
  // here — one LLM call per file, on every session, invisible in the transcript.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await fileMemoryRuntime?.drain();
  assert.equal(llm.calls.length, 0, "session open must not summarize anything");
  assert.equal(fileMemory?.get(target)?.summarySource, "heuristic");

  // What a run wrote, summarized at run end and nothing else.
  fileMemoryRuntime?.noteFilesWritten([target]);
  assert.equal(llm.calls.length, 0, "queued writes must wait for the flush");
  await fileMemoryRuntime?.flush();

  assert.deepEqual(llm.calls.map((call) => call.path), ["src/search-engine.ts"]);
  assert.equal(fileMemory?.get(target)?.summarySource, "llm");
  assert.equal(fileMemory?.get(other)?.summarySource, "heuristic", "untouched files keep their parser summary");

  await harness.dispose();
});

test("summaries are held for the duration of a run and released after it", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  await fileMemoryRuntime?.hold();
  fileMemoryRuntime?.noteFilesWritten([target]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(llm.calls.length, 0, "nothing may reach the network mid-run");
  assert.equal(fileMemoryRuntime?.getStatus().held, true);
  assert.equal(fileMemoryRuntime?.getStatus().queuedCount, 1);

  // drain() must settle while held — a caller waiting on in-flight work should
  // not block on paths that are parked by design.
  await fileMemoryRuntime?.drain();

  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 1);
  assert.equal(fileMemoryRuntime?.getStatus().held, true, "flush re-holds for the next run");
  assert.equal(fileMemoryRuntime?.getStatus().queuedCount, 0);

  await harness.dispose();
});

test("the summarizer spends no tokens on reasoning", async (t) => {
  const cwd = await mkproject();
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  fileMemoryRuntime?.noteFilesWritten([path.join(cwd, "src", "search-engine.ts")]);
  await fileMemoryRuntime?.flush();

  const [call] = llm.calls;
  assert.ok(call, "expected one summary call");
  assert.equal(call.options?.reasoning, "off");
  assert.equal(call.options?.reasoningMaxTokens, undefined, "a reasoning budget would compete with the JSON body");
  assert.ok(
    (call.options?.maxTokens ?? 0) >= 1200,
    "the body needs room for nine fields — 800 truncated every call",
  );

  await harness.dispose();
});

test("a file is summarized once, and again only when its bytes change", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemory, fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  // First write: no summary exists, so one is made.
  fileMemoryRuntime?.noteFilesWritten([target]);
  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 1);
  const first = fileMemory?.get(target);
  assert.equal(first?.summarySource, "llm");
  assert.equal(first?.summaryContentHash, first?.contentHash, "the summary records the bytes it was made from");
  const firstUpdatedAt = first?.summaryUpdatedAt;

  // Reported again with the file untouched — nothing to do, no call.
  fileMemoryRuntime?.noteFilesWritten([target]);
  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 1, "an unchanged file must not be summarized twice");
  assert.equal(fileMemory?.get(target)?.summaryUpdatedAt, firstUpdatedAt, "the stored summary is untouched");
  assert.equal(fileMemoryRuntime?.getStatus().skippedCount, 1);

  // A write that produces IDENTICAL bytes (a revert, a formatter no-op) is still
  // not a change: the hash decides, not the fact that a write happened.
  const bytes = await fs.readFile(target, "utf8");
  await fs.writeFile(target, bytes);
  fileMemoryRuntime?.noteFilesWritten([target]);
  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 1, "rewriting the same bytes is not a change");

  // Real change ⇒ a fresh summary.
  await fs.writeFile(target, "export function renamedEntirely(q: string) {\n  return q;\n}\n");
  fileMemoryRuntime?.noteFilesWritten([target]);
  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 2, "changed bytes must be re-summarized");
  const second = fileMemory?.get(target);
  assert.equal(second?.summaryContentHash, second?.contentHash);
  assert.notEqual(second?.summaryContentHash, first?.summaryContentHash);
  assert.match(second?.summary ?? "", /search-engine/);

  await harness.dispose();
});

test("needsSummaryHydration answers from the hash, not from event order", async (t) => {
  const cwd = await mkproject();
  const target = path.join(cwd, "src", "search-engine.ts");
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemory, fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  assert.equal(fileMemory?.needsSummaryHydration(target), true, "no llm summary yet");
  fileMemoryRuntime?.noteFilesWritten([target]);
  await fileMemoryRuntime?.flush();
  assert.equal(fileMemory?.needsSummaryHydration(target), false, "summarized at the current bytes");

  // Change the file WITHOUT telling the memory. The answer must still be right:
  // the check reads the file, so it cannot be desynchronised by a missed event.
  await fs.writeFile(target, "export const changedOutsideTheRuntime = true;\n");
  await fileMemory?.refreshPathMetadata(target);
  assert.equal(fileMemory?.needsSummaryHydration(target), true, "the bytes moved on");

  // A double metadata refresh must not consume the signal — the old proxy chain
  // (reset summarySource on change) could, a hash comparison cannot.
  await fileMemory?.refreshPathMetadata(target);
  assert.equal(fileMemory?.needsSummaryHydration(target), true);

  await harness.dispose();
});

test("only the changed file of several written is summarized", async (t) => {
  const cwd = await mkproject();
  const a = path.join(cwd, "src", "search-engine.ts");
  const b = path.join(cwd, "src", "index.ts");
  const llm = makeCountingSummaryLlm();
  const harness = makeHarness(t, llm);
  const { fileMemoryRuntime } = await harness.createProjectSession({ cwd, connectMcp: false });

  fileMemoryRuntime?.noteFilesWritten([a, b]);
  await fileMemoryRuntime?.flush();
  assert.equal(llm.calls.length, 2);

  await fs.writeFile(b, "export const onlyThisMoved = true;\n");
  fileMemoryRuntime?.noteFilesWritten([a, b]);
  await fileMemoryRuntime?.flush();
  assert.deepEqual(
    llm.calls.slice(2).map((call) => call.path),
    ["src/index.ts"],
    "the untouched file must not be re-summarized alongside the changed one",
  );

  await harness.dispose();
});

test("resolveFileMemoryAction infers action when the model omits it", () => {
  // Explicit action always wins.
  assert.equal(resolveFileMemoryAction({ action: "get", query: "x" }), "get");
  assert.equal(resolveFileMemoryAction({ action: "refresh" }), "refresh");
  // Inference from the other arguments (the common weak-model call shape).
  assert.equal(resolveFileMemoryAction({ query: "intercom" }), "search");
  assert.equal(resolveFileMemoryAction({ paths: ["a.ts", "b.ts"] }), "refresh");
  assert.equal(resolveFileMemoryAction({ path: "a.ts" }), "get");
  // Blank/whitespace action is treated as omitted, then inferred.
  assert.equal(resolveFileMemoryAction({ action: "   ", query: "q" }), "search");
  // Nothing to go on: harmless index summary rather than an error.
  assert.equal(resolveFileMemoryAction({}), "stats");
});

test("file_memory tool no longer requires 'action' (so valid calls aren't rejected up front)", () => {
  // The factory only uses `memory` inside execute; a stub is fine for schema checks.
  const tool = createFileMemoryTool(/** @type {any} */ ({}));
  assert.ok(Array.isArray(tool.parameters.required));
  assert.ok(
    !tool.parameters.required.includes("action"),
    "action must be optional so the phase-runner arg guard doesn't reject query-only calls",
  );
});
