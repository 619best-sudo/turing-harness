import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectProject } from "../dist/index.js";

async function mkproject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "detect-matrix-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

const CASES = [
  {
    name: "php laravel",
    files: {
      "composer.json": JSON.stringify({
        require: { "laravel/framework": "^11.0" },
      }),
      "artisan": "#!/usr/bin/env php\n",
    },
    expect: { category: "backend", languages: ["php"], frameworks: ["laravel"] },
  },
  {
    name: "php symfony",
    files: {
      "composer.json": JSON.stringify({
        require: { "symfony/framework-bundle": "^7.0" },
      }),
    },
    expect: { category: "backend", languages: ["php"], frameworks: ["symfony"] },
  },
  {
    name: "dotnet backend",
    files: {
      "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>\n",
      "Program.cs": "using System;\nnamespace Demo;\n",
    },
    expect: { category: "backend", languages: ["csharp"], frameworks: ["aspnet"] },
  },
  {
    name: "swift package",
    files: {
      "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\n",
    },
    expect: { category: "backend", languages: ["swift"] },
  },
  {
    name: "scala sbt",
    files: {
      "build.sbt": "name := \"demo\"\nscalaVersion := \"3.3.1\"\n",
    },
    expect: { category: "backend", languages: ["scala"] },
  },
  {
    name: "elixir phoenix",
    files: {
      "mix.exs": "defmodule Demo.MixProject do\n  {:phoenix, \"~> 1.7\"}\nend\n",
    },
    expect: { category: "backend", languages: ["elixir"], frameworks: ["phoenix"] },
  },
  {
    name: "clojure",
    files: {
      "deps.edn": "{:deps {org.clojure/clojure {:mvn/version \"1.11.1\"}}}\n",
    },
    expect: { category: "backend", languages: ["clojure"] },
  },
  {
    name: "haskell",
    files: {
      "stack.yaml": "resolver: lts-21.0\n",
      "demo.cabal": "name: demo\nversion: 0.1.0.0\n",
    },
    expect: { category: "backend", languages: ["haskell"] },
  },
  {
    name: "lua",
    files: {
      "demo.rockspec": "package = 'demo'\nversion = '0.1-0'\n",
      "main.lua": "local demo = {}\nreturn demo\n",
    },
    expect: { category: "backend", languages: ["lua"] },
  },
  {
    name: "perl",
    files: {
      "cpanfile": "requires 'Mojolicious';\n",
    },
    expect: { category: "backend", languages: ["perl"] },
  },
  {
    name: "r",
    files: {
      "DESCRIPTION": "Package: demo\nVersion: 0.1.0\n",
      "renv.lock": "{}\n",
    },
    expect: { category: "backend", languages: ["r"] },
  },
  {
    name: "zig",
    files: {
      "build.zig": "const std = @import(\"std\");\npub fn build(b: *std.Build) void {}\n",
    },
    expect: { category: "backend", languages: ["zig"] },
  },
  {
    name: "jvm spring",
    files: {
      "pom.xml": "<project><dependency>spring-boot-starter-web</dependency></project>\n",
    },
    expect: { category: "backend", languages: ["java"], frameworks: ["spring"] },
  },
];

for (const item of CASES) {
  test(`detectProject supports ${item.name}`, async () => {
    const cwd = await mkproject(item.files);
    const result = await detectProject(cwd);
    assert.equal(result.category, item.expect.category);
    for (const language of item.expect.languages ?? []) {
      assert.ok(result.stack.languages.includes(language), `expected language ${language} in ${item.name}`);
    }
    for (const framework of item.expect.frameworks ?? []) {
      assert.ok(result.stack.frameworks.includes(framework), `expected framework ${framework} in ${item.name}`);
    }
  });
}
