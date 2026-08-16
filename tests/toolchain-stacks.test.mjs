/**
 * Toolchain resolution ACROSS STACKS.
 *
 * The fvm case is what surfaced the bug, but nothing about it is Flutter-
 * specific: every ecosystem keeps its tools off PATH somewhere. This file is the
 * coverage claim, one case per mechanism, so "if a person can run it here, the
 * harness can run it here" is checked rather than asserted.
 *
 * Run via: npm test. All offline, all against throwaway trees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installHint, resolveProjectToolchain } from "../dist/exec/toolchain.js";

const isWindows = process.platform === "win32";

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `tc-${name}-`));
}

/** Write an executable stub at `rel` inside `dir`. */
async function bin(dir, rel) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

async function file(dir, rel, body = "") {
  const target = path.join(dir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf8");
  return target;
}

/** A PATH containing only the stubs we put there, so nothing resolves by luck. */
async function pathWith(...names) {
  const dir = await scratch("path");
  for (const name of names) await bin(dir, name);
  return { PATH: dir, dir };
}

const EMPTY = { PATH: "" };

/** Resolve `command` in `dir` and return the rewritten command. */
async function resolve(command, dir, env = EMPTY) {
  const res = await resolveProjectToolchain(command, dir, env);
  return res;
}

// ---------------------------------------------------------------------------
// Repo-local bin directories
// ---------------------------------------------------------------------------

test("node — node_modules/.bin, from a nested workspace package", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("node");
  const target = await bin(dir, "node_modules/.bin/eslint");
  await file(dir, "package.json", "{}");
  const nested = path.join(dir, "packages", "web", "src");
  await fs.mkdir(nested, { recursive: true });

  const res = await resolve("eslint .", nested);
  assert.ok(res.command.startsWith(target), res.command);
});

test("python — .venv/bin", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("py");
  const target = await bin(dir, ".venv/bin/pytest");
  await file(dir, "pyproject.toml", "[project]\nname='x'\n");
  const res = await resolve("pytest -q", dir);
  assert.ok(res.command.startsWith(target), res.command);
});

test("php — vendor/bin", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("php");
  const target = await bin(dir, "vendor/bin/phpunit");
  await file(dir, "composer.json", "{}");
  const res = await resolve("phpunit --testdox", dir);
  assert.ok(res.command.startsWith(target), res.command);
});

test("ruby — bin/ binstubs (bin/rails)", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("rails");
  const target = await bin(dir, "bin/rails");
  await file(dir, "Gemfile", "source 'https://rubygems.org'\n");
  const res = await resolve("rails db:migrate", dir);
  assert.ok(res.command.startsWith(target), res.command);
});

// ---------------------------------------------------------------------------
// Build-tool wrappers
// ---------------------------------------------------------------------------

test("gradle — ./gradlew, including the android/ subdir a mobile repo uses", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const root = await scratch("gradle");
  const target = await bin(root, "gradlew");
  await file(root, "build.gradle", "");
  assert.ok((await resolve("gradle test", root)).command.startsWith(target));

  const rn = await scratch("rn");
  const androidWrapper = await bin(rn, "android/gradlew");
  await file(rn, "package.json", "{}");
  assert.ok((await resolve("gradle assembleDebug", rn)).command.startsWith(androidWrapper));
});

test("maven — ./mvnw", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("mvn");
  const target = await bin(dir, "mvnw");
  await file(dir, "pom.xml", "<project/>");
  assert.ok((await resolve("mvn -q verify", dir)).command.startsWith(target));
});

test("scala — ./sbt launcher", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("sbt");
  const target = await bin(dir, "sbt");
  await file(dir, "build.sbt", "");
  assert.ok((await resolve("sbt compile", dir)).command.startsWith(target));
});

// ---------------------------------------------------------------------------
// SDK roots the user's shell exports
// ---------------------------------------------------------------------------

test("java — $JAVA_HOME/bin", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const home = await scratch("jdk");
  const target = await bin(home, "bin/java");
  const project = await scratch("jvm");
  await file(project, "pom.xml", "<project/>");
  const res = await resolve("java -version", project, { PATH: "", JAVA_HOME: home });
  assert.ok(res.command.startsWith(target), res.command);
  assert.match(res.substitutions[0].reason, /JAVA_HOME/);
});

test("android — $ANDROID_HOME/platform-tools/adb and cmdline-tools", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const sdk = await scratch("androidsdk");
  const adb = await bin(sdk, "platform-tools/adb");
  const sdkmanager = await bin(sdk, "cmdline-tools/latest/bin/sdkmanager");
  const project = await scratch("androidapp");
  await file(project, "build.gradle", "");
  const env = { PATH: "", ANDROID_HOME: sdk };
  assert.ok((await resolve("adb devices", project, env)).command.startsWith(adb));
  assert.ok((await resolve("sdkmanager --list", project, env)).command.startsWith(sdkmanager));
});

test("go — $GOROOT/bin, and the standard install on a go.mod repo", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const goroot = await scratch("goroot");
  const target = await bin(goroot, "bin/go");
  const project = await scratch("gomod");
  await file(project, "go.mod", "module x\n");
  const res = await resolve("go build ./...", project, { PATH: "", GOROOT: goroot });
  assert.ok(res.command.startsWith(target), res.command);
});

test("an activated virtualenv only applies to a PYTHON project", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const venv = await scratch("activatedvenv");
  const target = await bin(venv, "bin/ruff");
  const env = { PATH: "", VIRTUAL_ENV: venv };

  const python = await scratch("pyproj");
  await file(python, "requirements.txt", "ruff\n");
  assert.ok((await resolve("ruff check .", python, env)).command.startsWith(target));

  // The same shell variable must not leak into an unrelated repo — it describes
  // whatever the user last activated, not this project.
  const rust = await scratch("rustproj");
  await file(rust, "Cargo.toml", "[package]\n");
  assert.equal((await resolve("ruff check .", rust, env)).command, "ruff check .");
});

// ---------------------------------------------------------------------------
// Dependency runners — the tool IS installed, just not reachable by path
// ---------------------------------------------------------------------------

test("yarn pnp — no node_modules/.bin exists, so `yarn <tool>` is the launcher", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("pnp");
  await file(dir, "package.json", "{}");
  await file(dir, ".pnp.cjs", "// pnp");
  const env = await pathWith("yarn");
  const res = await resolve("tsc --noEmit", dir, { PATH: env.PATH });
  assert.equal(res.command, "yarn tsc --noEmit");
  assert.match(res.substitutions[0].reason, /Plug'n'Play/);
});

test("poetry — `poetry run <tool>` when poetry.lock is present", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("poetry");
  await file(dir, "pyproject.toml", "[tool.poetry]\n");
  await file(dir, "poetry.lock", "");
  const env = await pathWith("poetry");
  assert.equal((await resolve("pytest -q", dir, { PATH: env.PATH })).command, "poetry run pytest -q");
});

test("uv — `uv run <tool>` when uv.lock is present", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("uv");
  await file(dir, "pyproject.toml", "[project]\n");
  await file(dir, "uv.lock", "");
  const env = await pathWith("uv");
  assert.equal((await resolve("ruff check .", dir, { PATH: env.PATH })).command, "uv run ruff check .");
});

test("bundler — only for gems the bundle actually declares", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("bundler");
  await file(dir, "Gemfile", "source 'https://rubygems.org'\ngem 'rspec'\ngem 'cocoapods'\n");
  await file(dir, "Gemfile.lock", "GEM\n  specs:\n    rspec (3.13.0)\n    cocoapods (1.15.2)\n");
  const env = await pathWith("bundle");

  assert.equal((await resolve("rspec spec/", dir, { PATH: env.PATH })).command, "bundle exec rspec spec/");
  // `pod` is shipped by the cocoapods gem, not a gem named `pod`.
  assert.equal((await resolve("pod install", dir, { PATH: env.PATH })).command, "bundle exec pod install");
  // A Gemfile does not make every missing command a gem.
  assert.equal((await resolve("kubectl get pods", dir, { PATH: env.PATH })).command, "kubectl get pods");
});

// ---------------------------------------------------------------------------
// Precedence and safety
// ---------------------------------------------------------------------------

test("a repo-local binary beats a dependency runner", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("precedence");
  const target = await bin(dir, "node_modules/.bin/jest");
  await file(dir, "package.json", "{}");
  await file(dir, ".pnp.cjs", "// pnp");
  const env = await pathWith("yarn");
  assert.ok((await resolve("jest --ci", dir, { PATH: env.PATH })).command.startsWith(target));
});

test("a machine-wide SDK is never guessed at on an unrelated repo", async (t) => {
  if (isWindows) return t.skip("posix stub");
  // The stack-gated strategies must stay silent on a repo of a different stack,
  // even on a machine that has those SDKs installed.
  const rust = await scratch("rustonly");
  await file(rust, "Cargo.toml", "[package]\n");
  assert.equal((await resolve("flutter analyze", rust)).command, "flutter analyze");
  assert.equal((await resolve("adb devices", rust)).command, "adb devices");
  assert.equal((await resolve("dotnet build", rust)).command, "dotnet build");
});

test("a resolvable command is untouched no matter how many pins exist", async (t) => {
  if (isWindows) return t.skip("posix stub");
  const dir = await scratch("onpath");
  await bin(dir, "node_modules/.bin/tsc");
  await file(dir, "package.json", "{}");
  const env = await pathWith("tsc");
  assert.equal((await resolve("tsc --noEmit", dir, { PATH: env.PATH })).command, "tsc --noEmit");
});

// ---------------------------------------------------------------------------
// When nothing resolves, say why in this project's terms
// ---------------------------------------------------------------------------

test("the install hint names the command THIS project needs", async () => {
  const node = await scratch("hint-node");
  await file(node, "package.json", "{}");
  assert.match(await installHint(node), /npm install/);

  const dart = await scratch("hint-dart");
  await file(dart, "pubspec.yaml", "name: app\n");
  assert.match(await installHint(dart), /pub get/);

  const ruby = await scratch("hint-ruby");
  await file(ruby, "Gemfile", "source 'x'\n");
  assert.match(await installHint(ruby), /bundle install/);
});

test("no hint once dependencies are installed", async () => {
  const dir = await scratch("hint-done");
  await file(dir, "package.json", "{}");
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  assert.equal(await installHint(dir), undefined);
});
