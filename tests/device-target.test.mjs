/**
 * Reaching the device: is the id real, and is it the right surface?
 *
 * Every case here is taken from one run. A Flutter app, one booted iOS
 * simulator, and a task that came down to changing one string. The run:
 *
 *   flutter run -d E25EC6B1-342D-4CDE-9607-A09B243E126   → "No devices found"
 *   mobile_install_app  device: …A09B243E126             → "Device not found"
 *   mobile_list_available_devices                        → the CORRECT id
 *   mobile_install_app  device: …A09B243E126             → "Device not found"
 *   mobile_install_app  device: …A09B243E126             → "Device not found"
 *   flutter run -d chrome --web-server-port 5000
 *   python3 -m http.server 8080 --directory build/web    → "Address already in use"
 *   python3 -m http.server 8888 --directory build/web    → "Address already in use"
 *
 * The real id is `E25EC6B1-342D-4CDE-9607-A09B5243E126`: the model dropped a
 * single `5`, then re-read the correct id and re-issued the same typo twice
 * more. Both error messages are accurate and neither says the only thing that
 * would have helped — "you are one character off, here is the id you meant".
 */
import test from "node:test";
import assert from "node:assert/strict";

import { QaGate } from "../dist/index.js";
import {
  checkBuildTarget,
  checkDeviceId,
  checkRunSurface,
  closestDevice,
  commandPlatform,
  deviceTargetInCommand,
  looksLikeDeviceId,
} from "../dist/exec/device-target.js";
import { composeDeviceLaunch, describeComposedLaunch } from "../dist/exec/run-commands.js";

const REAL = "E25EC6B1-342D-4CDE-9607-A09B5243E126";
const TYPO = "E25EC6B1-342D-4CDE-9607-A09B243E126";
const IPHONE = { id: REAL, name: "iPhone 17 Pro", platform: "ios", state: "booted" };
const PIXEL = { id: "emulator-5554", name: "Pixel 7", platform: "android", state: "booted" };

// ---- parsing ---------------------------------------------------------------

test("the -d target is read out of a command, in every flag form", () => {
  assert.equal(deviceTargetInCommand(`flutter run -d ${TYPO} --profile`), TYPO);
  assert.equal(deviceTargetInCommand(`flutter run -d=${TYPO}`), TYPO);
  assert.equal(deviceTargetInCommand(`flutter run --device-id ${TYPO}`), TYPO);
  assert.equal(deviceTargetInCommand(`flutter run -d "iPhone 17 Pro"`), "iPhone 17 Pro");
  assert.equal(deviceTargetInCommand("flutter analyze lib/main.dart"), undefined);
});

test("platform words are not device ids and are never typo-corrected", () => {
  for (const word of ["chrome", "web", "macos", "ios", "android", "all"]) {
    assert.equal(looksLikeDeviceId(word), false, word);
  }
  assert.equal(looksLikeDeviceId("iPhone 17 Pro"), false, "a human name is not an opaque id");
  assert.equal(looksLikeDeviceId(REAL), true);
  assert.equal(looksLikeDeviceId("emulator-5554"), true);
});

// ---- the typo --------------------------------------------------------------

test("a one-character typo resolves to the real device", () => {
  assert.equal(closestDevice(TYPO, [IPHONE])?.id, REAL);
});

test("a genuinely different id does not get corrected into one", () => {
  const other = "11111111-2222-3333-4444-555555555555";
  assert.equal(closestDevice(other, [IPHONE]), undefined);
});

test("the refusal names the exact id and says not to re-list", () => {
  const v = checkDeviceId({ requested: TYPO, devices: [IPHONE], via: "flag" });
  assert.equal(v.kind, "block");
  assert.equal(v.reason, "unknown-device");
  assert.match(v.message, new RegExp(REAL), "the correct id is IN the message");
  assert.match(v.message, /MIS-TYPED/);
  assert.match(v.message, /-d/, "and where to put it");
  assert.match(v.message, /do not re-list the devices/i, "the run already did that and re-typo'd anyway");
});

test("a correct id passes, case-insensitively", () => {
  assert.equal(checkDeviceId({ requested: REAL, devices: [IPHONE], via: "flag" }).kind, "ok");
  assert.equal(checkDeviceId({ requested: REAL.toLowerCase(), devices: [IPHONE], via: "argument" }).kind, "ok");
});

test("with nothing booted the check stays silent", () => {
  // The harness may simply be unable to enumerate devices on this host. Refusing
  // on a blind probe would break every run without simctl/adb.
  assert.equal(checkDeviceId({ requested: TYPO, devices: [], via: "flag" }).kind, "ok");
});

test("an unrelated id lists what IS booted", () => {
  const v = checkDeviceId({ requested: "99999999-0000-0000-0000-000000000000", devices: [IPHONE, PIXEL], via: "argument" });
  assert.equal(v.kind, "block");
  assert.match(v.message, new RegExp(REAL));
  assert.match(v.message, /emulator-5554/);
});

// ---- the web fallback ------------------------------------------------------

test("running a mobile app in chrome is refused while a device is booted", () => {
  const v = checkRunSurface({
    command: "flutter run -d chrome --web-server-port 5000",
    devices: [IPHONE],
    mobileProject: true,
    deviceCommand: "flutter run",
  });
  assert.equal(v.kind, "block");
  assert.equal(v.reason, "wrong-surface");
  assert.match(v.message, /MOBILE app/);
  assert.match(v.message, new RegExp(REAL), "it hands over the device to use instead");
  assert.match(v.message, /that failure IS the finding/, "and says what to do if the device run keeps failing");
});

test("--web-server-port alone is enough to catch it", () => {
  const v = checkRunSurface({
    command: "flutter run --web-server-port 5000",
    devices: [IPHONE],
    mobileProject: true,
  });
  assert.equal(v.kind, "block");
});

test("a web or desktop project is never touched", () => {
  assert.equal(
    checkRunSurface({ command: "flutter run -d chrome", devices: [IPHONE], mobileProject: false }).kind,
    "ok",
  );
});

test("with no device booted there is nothing better to offer", () => {
  assert.equal(
    checkRunSurface({ command: "flutter run -d chrome", devices: [], mobileProject: true }).kind,
    "ok",
  );
});

test("BUILDING a web bundle is legitimate work and is not a run", () => {
  // Only a `run` is refused. Shipping a web build is a real deliverable and no
  // business of this check.
  assert.equal(
    checkRunSurface({ command: "flutter build web --release", devices: [IPHONE], mobileProject: true }).kind,
    "ok",
  );
});

// ---- through the gate ------------------------------------------------------

function gate(extra = {}) {
  return new QaGate({
    mobileProject: true,
    listDevices: async () => [IPHONE],
    deviceCommands: [{ command: "flutter run", source: "README.md", kind: "device" }],
    ...extra,
  });
}

test("the gate catches the typo in a bash flag and in a tool argument", async () => {
  const g = gate();
  const viaFlag = await g.checkDeviceTarget("bash", { command: `flutter run -d ${TYPO} --profile` });
  assert.equal(viaFlag.kind, "block");
  assert.match(viaFlag.message, new RegExp(REAL));

  const viaArg = await g.checkDeviceTarget("vendor__mobile_install_app", { device: TYPO, path: "/x/Runner.app" });
  assert.equal(viaArg.kind, "block");
  assert.match(viaArg.message, new RegExp(REAL));
});

test("the gate lets a correct call through untouched", async () => {
  const g = gate();
  assert.equal((await g.checkDeviceTarget("bash", { command: `flutter run -d ${REAL}` })).kind, "allow");
  assert.equal((await g.checkDeviceTarget("bash", { command: "flutter analyze" })).kind, "allow");
  assert.equal((await g.checkDeviceTarget("read", { path: "/x.ts" })).kind, "allow");
});

test("a device-id correction is repeatable — it is mechanical, not a judgement", async () => {
  // The observed run re-issued the same typo four times. A budget of 2 would
  // have run out before the model got it right and handed the run back to the
  // failure this exists to prevent.
  const g = gate({ maxBlocks: 2 });
  const reasons = [];
  for (let i = 0; i < 7; i++) {
    const d = await g.checkDeviceTarget("bash", { command: `flutter run -d ${TYPO}` });
    reasons.push(d.kind === "block" ? d.reason : "allow");
  }
  assert.equal(reasons.filter((r) => r === "unknown-device").length, 6, "corrected six times");
  assert.equal(reasons[6], "allow", "and still stands down rather than deadlocking");
});

test("a failing device probe never blocks a call", async () => {
  const g = gate({ listDevices: async () => { throw new Error("simctl missing"); } });
  assert.equal((await g.checkDeviceTarget("bash", { command: `flutter run -d ${TYPO}` })).kind, "allow");
});

// ---- the build must be able to reach the device ---------------------------

test("a command's target platform is read from its verbs", () => {
  assert.equal(commandPlatform("flutter build apk --debug --no-shrink"), "android");
  assert.equal(commandPlatform("./gradlew assembleDebug"), "android");
  assert.equal(commandPlatform("flutter build ios --debug --no-codesign"), "ios");
  assert.equal(commandPlatform("xcodebuild -scheme Runner archive"), "ios");
  assert.equal(commandPlatform("flutter analyze"), undefined);
});

test("building for a platform nothing is booted for is refused", () => {
  // The observed run: `flutter build apk --debug` with only an iOS simulator up.
  // Minutes of compiling for an artifact it could not install anywhere.
  const v = checkBuildTarget({
    command: "flutter build apk --debug --no-shrink",
    devices: [IPHONE],
    mobileProject: true,
    launch: "flutter run --flavor staging -t lib/main_staging.dart -d " + REAL,
  });
  assert.equal(v.kind, "block");
  assert.equal(v.reason, "wrong-build");
  assert.match(v.message, /builds for ANDROID/);
  assert.match(v.message, /iPhone 17 Pro/, "it names what IS booted");
  assert.match(v.message, /main_staging\.dart/, "and hands back the command that works");
});

test("an artifact build for the RIGHT platform is still not an install", () => {
  // `flutter build ios` writes build/ios/iphoneos/ — a physical-device build
  // that cannot be installed on a simulator. The run then hunted for a .app path
  // and found a stale flavor directory from an old Xcode build.
  const v = checkBuildTarget({
    command: "flutter build ios --debug --no-codesign",
    devices: [IPHONE],
    mobileProject: true,
    launch: "flutter run -d " + REAL,
  });
  assert.equal(v.kind, "block");
  assert.match(v.message, /installs NOTHING/);
  assert.match(v.message, /path is one you then have to guess/);
});

test("the refusal stands down for someone who actually wants the artifact", () => {
  const v = checkBuildTarget({ command: "flutter build apk", devices: [IPHONE], mobileProject: true });
  assert.match(v.message, /genuinely want the .* ARTIFACT|genuinely want the artifact/);
});

test("a RUN is not an artifact build, and a non-mobile project is untouched", () => {
  assert.equal(
    checkBuildTarget({ command: `flutter run -d ${REAL}`, devices: [IPHONE], mobileProject: true }).kind,
    "ok",
  );
  assert.equal(
    checkBuildTarget({ command: "flutter build apk", devices: [IPHONE], mobileProject: false }).kind,
    "ok",
  );
  assert.equal(
    checkBuildTarget({ command: "npm run build", devices: [IPHONE], mobileProject: true }).kind,
    "ok",
    "a web build names no mobile platform",
  );
});

// ---- the command it hands back has to be the RIGHT one ---------------------

test("the project's own command wins, with the device pinned onto it", () => {
  // This is the case a hardcoded default gets wrong. cards_mobile_app has
  // product flavors and its CLAUDE.md says so; a bare `flutter run -d <id>`
  // fails on it, in a way that reads like the app is broken.
  const declared = [
    { command: "flutter run --flavor staging -t lib/main_staging.dart", source: "CLAUDE.md", kind: "device" },
  ];
  const c = composeDeviceLaunch(declared, "flutter", REAL, "ios");
  assert.equal(c.origin, "project");
  assert.equal(c.command, `flutter run --flavor staging -t lib/main_staging.dart -d ${REAL}`);
  assert.match(describeComposedLaunch(c), /this project's own run command \(CLAUDE\.md\)/);
});

test("a command that already pins a device is left exactly as written", () => {
  const declared = [{ command: "flutter run -d my-device --flavor prod", source: "README.md", kind: "device" }];
  assert.equal(composeDeviceLaunch(declared, "flutter", REAL, "ios").command, "flutter run -d my-device --flavor prod");
});

test("with nothing declared the stack default is offered, and labelled as generic", () => {
  const c = composeDeviceLaunch([], "flutter", REAL, "ios");
  assert.equal(c.origin, "stack");
  assert.equal(c.command, `flutter run -d ${REAL}`);
  assert.match(describeComposedLaunch(c), /NOT read from the project/);
  assert.match(describeComposedLaunch(c), /flavor/, "and says what it might be missing");
});

test("each stack pins the device with its own flag", () => {
  assert.equal(composeDeviceLaunch([], "expo", "abc123", "ios").command, "npx expo run:ios --device abc123");
  assert.equal(
    composeDeviceLaunch([], "react-native", "abc123", "android").command,
    "npx react-native run-android --deviceId abc123",
  );
  assert.equal(composeDeviceLaunch([], "gradle", "emulator-5554", "android").command, "./gradlew installDebug");
  // Nothing honest to say ⇒ say nothing, rather than a command that will fail.
  assert.equal(composeDeviceLaunch([], "gradle", REAL, "ios"), undefined);
  assert.equal(composeDeviceLaunch([], undefined, REAL, "ios"), undefined);
});

test("the gate refuses the wrong build and quotes the project's real command", async () => {
  const g = new QaGate({
    mobileProject: true,
    mobileStack: "flutter",
    listDevices: async () => [IPHONE],
    deviceCommands: [
      { command: "flutter run --flavor staging -t lib/main_staging.dart", source: "CLAUDE.md", kind: "device" },
    ],
  });
  const d = await g.checkDeviceTarget("bash", { command: "flutter build apk --debug --no-shrink" });
  assert.equal(d.kind, "block");
  assert.equal(d.reason, "wrong-build");
  assert.match(d.message, new RegExp(`flutter run --flavor staging -t lib/main_staging.dart -d ${REAL}`));
});
