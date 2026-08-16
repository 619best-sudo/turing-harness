/**
 * Project-pinned toolchain resolution.
 *
 * Regression target: a Flutter repo pins its SDK with fvm, so `flutter` is on
 * nobody's PATH. `flutter analyze` answered `command not found`, the pipe made
 * the tool call succeed anyway, and the run declared the change unverifiable
 * with a working SDK one directory away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  commandNotFoundNames,
  findProjectLauncher,
  missingExecutableGuidance,
  resolveProjectToolchain,
  substitutionNote,
  whichExecutable,
} from "../dist/exec/toolchain.js";

/** A throwaway project tree. */
async function scratch(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `turing-toolchain-${name}-`));
  return dir;
}

/** Create an executable stub at `file`. */
async function stubBinary(file, body = "#!/bin/sh\necho stub\n") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

/** An env whose PATH contains nothing, so every name is "missing". */
const EMPTY_PATH = { PATH: "" };

test("an fvm-pinned Flutter SDK is found through .fvm/flutter_sdk", async () => {
  const dir = await scratch("fvm");
  const sdk = await stubBinary(path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter"));

  const resolved = await resolveProjectToolchain(
    "cd . && flutter analyze lib/main.dart 2>&1 | head -50",
    dir,
    EMPTY_PATH,
  );

  assert.ok(resolved.command.includes(sdk), `rewrote to the pinned SDK: ${resolved.command}`);
  assert.equal(resolved.substitutions.length, 1);
  assert.equal(resolved.substitutions[0].missing, "flutter");
  assert.match(resolved.substitutions[0].reason, /fvm pin/);
  assert.ok(!resolved.unresolved.includes("flutter"), "flutter is resolved");
  assert.ok(!resolved.executables.includes("1"), "`2>&1` is a redirect, not a command");
  assert.match(substitutionNote(resolved.substitutions), /not on PATH/);
});

test(".fvmrc points at the fvm cache when the repo has no symlink", async () => {
  const dir = await scratch("fvmrc");
  await fs.writeFile(path.join(dir, ".fvmrc"), JSON.stringify({ flutter: "3.38.4" }), "utf8");
  const cached = await stubBinary(path.join(dir, ".fvm", "versions", "3.38.4", "bin", "flutter"));

  const resolved = await resolveProjectToolchain("flutter --version", dir, EMPTY_PATH);
  assert.ok(resolved.command.startsWith(cached), resolved.command);
  assert.match(resolved.substitutions[0].reason, /3\.38\.4/);
});

test("a node tool resolves to node_modules/.bin from a nested directory", async () => {
  const dir = await scratch("node");
  const bin = await stubBinary(path.join(dir, "node_modules", ".bin", "tsc"));
  const nested = path.join(dir, "src", "deep");
  await fs.mkdir(nested, { recursive: true });

  const resolved = await resolveProjectToolchain("tsc --noEmit", nested, EMPTY_PATH);
  assert.ok(resolved.command.startsWith(bin), resolved.command);
});

test("gradle resolves to the checked-in wrapper", async () => {
  const dir = await scratch("gradle");
  const wrapper = await stubBinary(path.join(dir, "gradlew"));
  const resolved = await resolveProjectToolchain("gradle assembleDebug", dir, EMPTY_PATH);
  assert.ok(resolved.command.startsWith(wrapper), resolved.command);
});

test("a python tool resolves inside the virtualenv", async () => {
  const dir = await scratch("venv");
  const bin = await stubBinary(path.join(dir, ".venv", "bin", "pytest"));
  const resolved = await resolveProjectToolchain("pytest -q tests/", dir, EMPTY_PATH);
  assert.ok(resolved.command.startsWith(bin), resolved.command);
});

test("an executable already on PATH is left completely alone", async () => {
  const dir = await scratch("onpath");
  const binDir = path.join(dir, "bin");
  await stubBinary(path.join(binDir, "flutter"));
  await stubBinary(path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter"));

  const command = "flutter analyze";
  const resolved = await resolveProjectToolchain(command, dir, { PATH: binDir });
  assert.equal(resolved.command, command, "no rewrite when PATH already resolves it");
  assert.deepEqual(resolved.substitutions, []);
});

test("nothing is invented on a repo that pins nothing and is not a Dart project", async () => {
  const dir = await scratch("bare");
  const command = "flutter analyze";
  const resolved = await resolveProjectToolchain(command, dir, EMPTY_PATH);
  assert.equal(resolved.command, command, "runs unchanged and fails honestly");
  assert.ok(resolved.unresolved.includes("flutter"));
  assert.match(missingExecutableGuidance(resolved.unresolved), /RESOLUTION failure/);
});

test("a machine-wide SDK is only used when the repo IS a Flutter project", async () => {
  const sdkHome = await scratch("sdkhome");
  const sdk = await stubBinary(path.join(sdkHome, "bin", "flutter"));

  const notFlutter = await scratch("not-flutter");
  const withoutManifest = await resolveProjectToolchain("flutter analyze", notFlutter, {
    PATH: "",
    FLUTTER_ROOT: sdkHome,
  });
  assert.equal(withoutManifest.command, "flutter analyze", "no pubspec.yaml → no guess");

  const flutterApp = await scratch("flutter-app");
  await fs.writeFile(path.join(flutterApp, "pubspec.yaml"), "name: app\n", "utf8");
  const withManifest = await resolveProjectToolchain("flutter analyze", flutterApp, {
    PATH: "",
    FLUTTER_ROOT: sdkHome,
  });
  assert.ok(withManifest.command.startsWith(sdk), withManifest.command);
  assert.match(withManifest.substitutions[0].reason, /FLUTTER_ROOT/);
});

test("paths, variables and builtins are never rewritten", async () => {
  const dir = await scratch("literal");
  await stubBinary(path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter"));

  for (const command of [
    "./flutter analyze",
    "$FLUTTER analyze",
    "/usr/local/bin/flutter analyze",
    "cd /tmp && echo flutter",
  ]) {
    const resolved = await resolveProjectToolchain(command, dir, EMPTY_PATH);
    assert.equal(resolved.command, command, command);
  }
});

test("every top-level segment is resolved, and the same tool costs one note", async () => {
  const dir = await scratch("segments");
  const sdk = await stubBinary(path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter"));

  const resolved = await resolveProjectToolchain(
    "flutter pub get && flutter analyze | tail -5",
    dir,
    EMPTY_PATH,
  );
  const hits = resolved.command.split(sdk).length - 1;
  assert.equal(hits, 2, "both invocations rewritten");
  assert.equal(resolved.substitutions.length, 1, "reported once");
});

test("env assignments and wrapper words are stepped over", async () => {
  const dir = await scratch("wrappers");
  const sdk = await stubBinary(path.join(dir, ".fvm", "flutter_sdk", "bin", "flutter"));
  const resolved = await resolveProjectToolchain("FLUTTER_SUPPRESS_ANALYTICS=1 flutter doctor", dir, EMPTY_PATH);
  assert.ok(resolved.command.includes(sdk), resolved.command);
  assert.ok(resolved.command.startsWith("FLUTTER_SUPPRESS_ANALYTICS=1 "), "assignment preserved");
});

test("quoted text is not mistaken for a command boundary", async () => {
  const dir = await scratch("quotes");
  const command = `grep -n "a && b" README.md`;
  const resolved = await resolveProjectToolchain(command, dir, EMPTY_PATH);
  assert.equal(resolved.command, command);
  assert.deepEqual(resolved.executables, ["grep"]);
});

test("command-not-found is read out of output in every shell's phrasing", () => {
  assert.deepEqual(commandNotFoundNames("/bin/sh: flutter: command not found"), ["flutter"]);
  assert.deepEqual(commandNotFoundNames("zsh: command not found: fvm"), ["fvm"]);
  assert.deepEqual(commandNotFoundNames("sh: 1: pod: not found"), ["pod"]);
  assert.deepEqual(commandNotFoundNames("no problem here"), []);
});

test("whichExecutable resolves against the PATH it is given", async () => {
  const dir = await scratch("which");
  const bin = await stubBinary(path.join(dir, "bin", "mytool"));
  assert.equal(await whichExecutable("mytool", { PATH: path.join(dir, "bin") }), bin);
  assert.equal(await whichExecutable("mytool", EMPTY_PATH), undefined);
});

test("a non-executable file is not treated as a launcher", async () => {
  const dir = await scratch("nonexec");
  const file = path.join(dir, "node_modules", ".bin", "tsc");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "not executable", "utf8");
  await fs.chmod(file, 0o644);
  assert.equal(await findProjectLauncher("tsc", dir, EMPTY_PATH), undefined);
});
