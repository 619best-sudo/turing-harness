/**
 * How a project says it runs itself, read from the project.
 *
 * The verify round has to tell a model how to get an app in front of a screen.
 * A hardcoded stack list gets that wrong the moment a project has flavors: the
 * Flutter app that prompted this cannot be launched with a bare `flutter run`
 * at all — its own CLAUDE.md says
 * `flutter run --flavor staging -t lib/main_staging.dart`. Naming a command
 * that fails, confidently, is worse than saying nothing.
 *
 * Run via: npm test. All offline, all against throwaway trees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  describeDeviceLaunch,
  detectDeviceRunCommands,
  detectRunCommands,
} from "../dist/exec/run-commands.js";

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `runcmd-${name}-`));
}

async function file(dir, rel, body) {
  const target = path.join(dir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf8");
}

const commandsOf = (list) => list.map((c) => c.command);

// ---------------------------------------------------------------------------
// package.json scripts
// ---------------------------------------------------------------------------

test("package scripts are classified by what they do, not by their name alone", async () => {
  const dir = await scratch("pkg");
  await file(
    dir,
    "package.json",
    JSON.stringify({
      scripts: {
        ios: "react-native run-ios --simulator='iPhone 15'",
        build: "tsc -p tsconfig.json",
        dev: "vite dev",
        test: "vitest run",
        lint: "eslint .",
      },
    }),
  );

  const all = await detectRunCommands(dir);
  const byCommand = Object.fromEntries(all.map((c) => [c.command, c.kind]));
  assert.equal(byCommand["npm run ios"], "device");
  assert.equal(byCommand["npm run build"], "build");
  assert.equal(byCommand["npm run dev"], "dev-server");
  assert.equal(byCommand["npm run test"], "test");
  assert.ok(!("npm run lint" in byCommand), "unclassifiable scripts are left out");
});

test("a device script is found by NAME even when its body is opaque", async () => {
  const dir = await scratch("opaque");
  await file(dir, "package.json", JSON.stringify({ scripts: { android: "./scripts/launch.sh --android" } }));
  const device = await detectDeviceRunCommands(dir);
  assert.deepEqual(commandsOf(device), ["npm run android"]);
});

// ---------------------------------------------------------------------------
// Documented commands — the source that carries flavors and entrypoints
// ---------------------------------------------------------------------------

test("a documented launch command is picked up verbatim, flags and all", async () => {
  const dir = await scratch("docs");
  await file(dir, "pubspec.yaml", "name: app\n");
  await file(
    dir,
    "CLAUDE.md",
    [
      "## Running the app",
      "",
      "```bash",
      "flutter run --flavor staging -t lib/main_staging.dart",
      "flutter run --flavor production -t lib/main_production.dart",
      "```",
      "",
      "## Building",
      "",
      "```bash",
      "flutter build apk --release",
      "```",
    ].join("\n"),
  );

  const device = await detectDeviceRunCommands(dir);
  assert.deepEqual(commandsOf(device), [
    "flutter run --flavor staging -t lib/main_staging.dart",
    "flutter run --flavor production -t lib/main_production.dart",
  ]);
  assert.match(device[0].source, /CLAUDE\.md/);
  // The whole point: the flavor and the entrypoint survive, and no invented
  // bare `flutter run` appears alongside them.
  assert.ok(!commandsOf(device).includes("flutter run"));
});

test("an artifact-only command is never offered as a way onto a device", async () => {
  const dir = await scratch("buildonly");
  await file(dir, "pubspec.yaml", "name: app\n");
  await file(dir, "README.md", "```bash\nflutter build apk --debug\n./gradlew assembleDebug\n```");
  assert.deepEqual(await detectDeviceRunCommands(dir), []);
});

test("prompts and comments in a fenced block are not commands", async () => {
  const dir = await scratch("prompts");
  await file(dir, "README.md", "```bash\n# launch it:\n$ flutter run -d emulator-5554\n```");
  const device = await detectDeviceRunCommands(dir);
  assert.deepEqual(commandsOf(device), ["flutter run -d emulator-5554"], "the `$` prompt is stripped");
});

test("prose that MENTIONS a command is not mistaken for one", async () => {
  // Docs quote commands inside sentences constantly. A pattern match alone
  // cannot tell them apart from a command; shape can.
  const dir = await scratch("prose");
  await file(
    dir,
    "README.md",
    [
      "```bash",
      "flutter run --flavor dev",
      "1. **Performance Overlay:** Run with `flutter run --profile` and enable the overlay.",
      "- Or use `flutter run --release` for timings.",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(commandsOf(await detectDeviceRunCommands(dir)), ["flutter run --flavor dev"]);
});

test("a non-shell fence between two shell fences does not swallow the prose between them", async () => {
  // The real failure: a ```dart block sat between two shell blocks, a regex
  // paired the wrong fences, and two paragraphs of prose were harvested as
  // commands. Fences are parsed as a state machine over ALL of them.
  const dir = await scratch("fences");
  await file(
    dir,
    "CLAUDE.md",
    [
      "```bash",
      "flutter run --flavor staging -t lib/main_staging.dart",
      "```",
      "",
      "```dart",
      "void main() => runApp(const App());",
      "```",
      "",
      "Some prose that says run `flutter run --profile` to see jank.",
      "",
      "```bash",
      "flutter run --flavor production -t lib/main_production.dart",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(commandsOf(await detectDeviceRunCommands(dir)), [
    "flutter run --flavor staging -t lib/main_staging.dart",
    "flutter run --flavor production -t lib/main_production.dart",
  ]);
});

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

test("a Makefile target is classified from its recipe", async () => {
  const dir = await scratch("make");
  await file(
    dir,
    "Makefile",
    ["run:", "\tflutter run --flavor dev", "", "package:", "\tflutter build ipa", ""].join("\n"),
  );
  const all = await detectRunCommands(dir);
  const byCommand = Object.fromEntries(all.map((c) => [c.command, c.kind]));
  assert.equal(byCommand["make run"], "device");
  assert.equal(byCommand["make package"], "build");
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

test("a monorepo package's own scripts win over the workspace root's", async () => {
  const dir = await scratch("mono");
  await file(dir, "package.json", JSON.stringify({ scripts: { ios: "echo root" } }));
  const app = path.join(dir, "apps", "mobile");
  await file(app, "package.json", JSON.stringify({ scripts: { ios: "expo run:ios" } }));

  const device = await detectDeviceRunCommands(app);
  assert.deepEqual(commandsOf(device), ["npm run ios"]);
  assert.match(device[0].source, /^package\.json/, "resolved from the package, not the root");
});

test("a project that declares nothing returns nothing — no invented default", async () => {
  const dir = await scratch("silent");
  await file(dir, "pubspec.yaml", "name: app\n");
  assert.deepEqual(await detectRunCommands(dir), []);
});

// ---------------------------------------------------------------------------
// The paragraph the verify round carries
// ---------------------------------------------------------------------------

test("the launch paragraph quotes the project when it can", async () => {
  const text = describeDeviceLaunch([
    { command: "flutter run --flavor staging -t lib/main_staging.dart", source: "CLAUDE.md", kind: "device" },
  ]);
  assert.match(text, /This project declares:/);
  assert.match(text, /--flavor staging/);
  assert.match(text, /CLAUDE\.md/);
  assert.match(text, /BUILDS, INSTALLS AND LAUNCHES/);
  assert.match(text, /background: true/);
});

test("the launch paragraph sends the model to look when it cannot", async () => {
  const text = describeDeviceLaunch([]);
  assert.match(text, /FIND IT rather than guessing/);
  assert.match(text, /README \/ CLAUDE\.md/);
  // No command is invented — that is the entire failure mode being avoided.
  assert.ok(!/flutter run|react-native run-|expo run:/.test(text), text);
});

test("the paragraph always states what a device command must DO", async () => {
  for (const text of [describeDeviceLaunch([]), describeDeviceLaunch([{ command: "make run", source: "Makefile", kind: "device" }])]) {
    assert.match(text, /BUILDS, INSTALLS AND LAUNCHES/);
    assert.match(text, /installs nothing|produces an artifact/);
  }
});
