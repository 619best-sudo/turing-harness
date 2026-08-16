/**
 * Does this call name a device that actually exists, and the right KIND of one?
 *
 * Two failures, both observed in one run of a Flutter app against a booted iOS
 * simulator, and between them they consumed the whole run.
 *
 * 1. A ONE-CHARACTER TYPO in a device id. The simulator is
 *    `E25EC6B1-342D-4CDE-9607-A09B5243E126`; the model wrote
 *    `E25EC6B1-342D-4CDE-9607-A09B243E126` — the `5` dropped, 35 characters
 *    instead of 36. `flutter run -d <typo>` answered "No devices found", and
 *    `mobile_install_app` answered "Device not found. Use the
 *    mobile_list_available_devices tool to see available devices." The model DID
 *    re-list the devices, read the correct id back, and then re-issued the same
 *    typo twice more. Four failed calls, and it concluded the app could not be
 *    run at all.
 *
 *    Nothing in that loop could ever have closed: both error messages are
 *    accurate and neither says the words that matter, which are "you are ONE
 *    CHARACTER off, here is the id you meant". A 36-character hex string is
 *    exactly the kind of token a model cannot reliably copy, and the fix is not
 *    to ask it to try harder — it is to notice a near-miss and hand back the
 *    real one.
 *
 * 2. FALLING BACK TO THE WRONG SURFACE. Having failed to reach the simulator,
 *    the run tried `flutter run -d chrome --web-server-port 5000`, then built a
 *    web bundle, then served `build/web` with `python3 -m http.server` twice.
 *    A Flutter app rendered in Chrome is a different build of a different
 *    surface; a screenshot of it verifies nothing about the iOS screen the user
 *    asked about. The prompts say so, in the verify-stage message — but this all
 *    happened in the WORK loop, where nothing was enforcing it.
 *
 * Both checks are advisory-shaped: they refuse the call and hand back the exact
 * next command. Neither can wedge a run — the caller counts refusals and stands
 * down (see `QaGate`).
 */
import { levenshtein } from "../orchestrator/tool-suggest.js";
import { classify as classifyRunCommand } from "./run-commands.js";
import type { LocalDevice } from "../devices/local-devices.js";

/** What a device-target check concluded. */
export type DeviceTargetVerdict =
  | { kind: "ok" }
  | { kind: "block"; reason: "unknown-device" | "wrong-surface" | "wrong-build"; message: string };

/**
 * Device targets that are NOT a device id and must never be typo-corrected.
 *
 * `flutter devices` accepts platform words as well as ids, and a run that says
 * `-d macos` on a desktop project means it. Only strings that LOOK like an
 * opaque identifier are validated, so a project targeting a named platform is
 * left alone entirely.
 */
const PLATFORM_TARGETS = new Set([
  "chrome", "web", "web-server", "edge", "macos", "windows", "linux", "all", "ios", "android",
]);

/**
 * Targets that mean "render this on the desktop or in a browser".
 *
 * The set is small and specific on purpose: `-d chrome` is a wrong-surface run
 * for a mobile app, while `-d ios` is just a platform selector and fine.
 */
const NON_DEVICE_SURFACES = new Set(["chrome", "web", "web-server", "edge", "macos", "windows", "linux"]);

/**
 * Whether a string is shaped like an opaque device identifier rather than a
 * platform word or a human-readable device name.
 *
 * Covers the two forms that actually appear: an iOS simulator UDID (36-char
 * dashed hex) and an Android serial (alphanumeric, no spaces, 6+ chars). A name
 * with a space in it ("iPhone 17 Pro") is not one — `flutter` accepts those and
 * matching them is not this function's job.
 */
export function looksLikeDeviceId(value: string): boolean {
  const v = value.trim();
  if (!v || v.includes(" ")) return false;
  if (PLATFORM_TARGETS.has(v.toLowerCase())) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(v)) return true; // UDID, including a typo'd one
  return /^[A-Za-z0-9._:-]{6,}$/.test(v) && /\d/.test(v);
}

/**
 * The `-d` / `--device-id` target in a shell command, if it names one.
 *
 * Deliberately only the explicit flag forms. A bare word elsewhere in a command
 * line is not a device target, and guessing at one would refuse unrelated work.
 */
export function deviceTargetInCommand(command: string): string | undefined {
  const m =
    /(?:^|\s)-d[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(command) ??
    /(?:^|\s)--device-id[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(command);
  const raw = m?.[1];
  return raw ? raw.replace(/^["']|["']$/g, "") : undefined;
}

/**
 * The closest booted device to a mistyped id, or undefined when nothing is near
 * enough to be a typo rather than a different device.
 *
 * The threshold is a ratio, not a constant: 3 edits in a 36-character UDID is
 * unmistakably the same string mis-copied, while 3 edits in an 8-character
 * Android serial could be a different phone. `0.25` accepts up to 9 edits on a
 * UDID and 2 on an 8-character serial, which is the shape we want.
 */
export function closestDevice(requested: string, devices: readonly LocalDevice[]): LocalDevice | undefined {
  let best: { device: LocalDevice; distance: number } | undefined;
  for (const device of devices) {
    const distance = levenshtein(requested.toLowerCase(), device.id.toLowerCase(), 12);
    if (!Number.isFinite(distance)) continue;
    const budget = Math.max(2, Math.floor(Math.max(requested.length, device.id.length) * 0.25));
    if (distance > budget) continue;
    if (!best || distance < best.distance) best = { device, distance };
  }
  return best?.device;
}

/** Render the booted devices as a quotable list. */
function describeDevices(devices: readonly LocalDevice[]): string {
  return devices.map((d) => `\`${d.id}\` (${d.name}, ${d.platform})`).join(", ");
}

export interface DeviceTargetInput {
  /** The device id the call named, from an argument or a `-d` flag. */
  requested: string;
  /** Booted devices, as the harness itself sees them. */
  devices: readonly LocalDevice[];
  /** How the id reached us, for a message that names the right thing to fix. */
  via: "argument" | "flag";
}

/**
 * Validate a device id against what is actually booted.
 *
 * Silent (`ok`) whenever there is nothing to say: no booted devices to compare
 * against (the harness may simply not be able to see them), a platform word
 * rather than an id, or an id that matches. It only speaks when the id is wrong
 * AND the right one is knowable.
 */
export function checkDeviceId(input: DeviceTargetInput): DeviceTargetVerdict {
  const { requested, devices, via } = input;
  if (!devices.length) return { kind: "ok" };
  if (!looksLikeDeviceId(requested)) return { kind: "ok" };
  if (devices.some((d) => d.id.toLowerCase() === requested.trim().toLowerCase())) return { kind: "ok" };

  const near = closestDevice(requested, devices);
  const where = via === "flag" ? "the `-d` flag" : "the `device` argument";
  if (near) {
    return {
      kind: "block",
      reason: "unknown-device",
      message: [
        `No device \`${requested}\` — you have MIS-TYPED the id. The booted device is \`${near.id}\` ` +
          `(${near.name}, ${near.platform}), and what you passed differs from it by a few characters.`,
        `Re-issue the call with ${where} set to \`${near.id}\`, copied EXACTLY — do not retype it from ` +
          `memory, and do not re-list the devices first; the id is on this line.`,
        `(Nothing else about the call is wrong. "No devices found" and "Device not found" both mean this.)`,
      ].join("\n"),
    };
  }
  return {
    kind: "block",
    reason: "unknown-device",
    message: [
      `No device \`${requested}\` is booted, and it is not close to one that is.`,
      `Booted right now: ${describeDevices(devices)}.`,
      `Re-issue the call with ${where} set to one of those ids, copied exactly.`,
    ].join("\n"),
  };
}

/**
 * The mobile platform a build/run command targets, when it names one.
 *
 * Verb-and-target based rather than framework based, so an unfamiliar stack that
 * uses the same words still classifies. `undefined` means the command says
 * nothing about a platform, which is most commands.
 */
export function commandPlatform(command: string): "ios" | "android" | undefined {
  if (/\bapk\b|\baab\b|\bassemble(?:Debug|Release)?\b|\bbundle(?:Debug|Release)\b|\brun-android\b|\brun:android\b|\bgradlew?\b|-d\s+android\b/i.test(command)) {
    return "android";
  }
  if (/\bios\b|\bipa\b|\bxcodebuild\b|\bxcrun\b|\brun-ios\b|\brun:ios\b|\biphone\w*\b/i.test(command)) {
    return "ios";
  }
  return undefined;
}

export interface BuildTargetInput {
  command: string;
  devices: readonly LocalDevice[];
  mobileProject: boolean;
  /** The command that WOULD do the job, already composed for a booted device. */
  launch?: string;
}

/**
 * Refuse a build aimed at a platform nothing is booted for, and refuse an
 * artifact-only build when the job is getting the app onto a device.
 *
 * Both come from the same run and the same misconception — that "build" and "get
 * it onto the simulator" are the same verb. They are not:
 *
 *   flutter build apk --debug          → an ANDROID artifact. The only booted
 *                                        device was an iOS simulator.
 *   flutter build ios --debug          → builds for a PHYSICAL device
 *                                        (`build/ios/iphoneos/`). It cannot be
 *                                        installed on a simulator, and the run
 *                                        then tried to install a stale
 *                                        `Debug-staging-iphonesimulator` path
 *                                        left by some earlier Xcode build.
 *
 * Neither could ever have worked, both took minutes, and their failure was read
 * as the app being unrunnable. The one-shot run command does the build, the
 * install and the launch together and cannot get the artifact path wrong,
 * because it never names one.
 *
 * Deliberately recoverable: the message says what to do if the ARTIFACT really
 * is the goal, because "build me a release APK" is a legitimate request that
 * looks identical from here.
 */
export function checkBuildTarget(input: BuildTargetInput): DeviceTargetVerdict {
  const { command, devices, mobileProject, launch } = input;
  if (!mobileProject || !devices.length) return { kind: "ok" };
  if (classifyRunCommand(command) !== "build") return { kind: "ok" };
  const target = commandPlatform(command);
  if (!target) return { kind: "ok" };

  const matching = devices.filter((d) => d.platform === target);
  const booted = devices.map((d) => `${d.name} (${d.platform}, \`${d.id}\`)`).join(", ");
  const fix = launch
    ? `Use the one command that builds, installs AND launches instead: \`${launch}\` — run it through \`bash\` with \`background: true, waitMs: 300000\` — the call listens and returns on the outcome.`
    : `Use the project's own build-install-launch command with the booted device pinned, not a build task.`;

  if (!matching.length) {
    return {
      kind: "block",
      reason: "wrong-build",
      message: [
        `That builds for ${target.toUpperCase()}, and no ${target} device is booted. Booted: ${booted}.`,
        `It would compile for minutes and produce an artifact you cannot install anywhere.`,
        fix,
        `(If you genuinely want the ${target} ARTIFACT rather than the app on a screen, say so in your next ` +
          `message and re-issue it — this refusal stands down.)`,
      ].join("\n"),
    };
  }
  return {
    kind: "block",
    reason: "wrong-build",
    message: [
      `An artifact build does not put the app on ${matching[0]!.name}. A build/assemble/archive task writes a ` +
        `file and installs NOTHING, so the device keeps running whatever was on it before — and its output ` +
        `path is one you then have to guess, which is its own failure.`,
      fix,
      `(If you genuinely want the artifact rather than the app on a screen, say so in your next message and ` +
        `re-issue it — this refusal stands down.)`,
    ].join("\n"),
  };
}

export interface SurfaceCheckInput {
  command: string;
  /** Booted devices. A wrong-surface run only matters when a right one exists. */
  devices: readonly LocalDevice[];
  /** True when the project's product is an app on a device. */
  mobileProject: boolean;
  /** The project's own device launch command, quoted back in the refusal. */
  deviceCommand?: string;
}

/**
 * Refuse running a MOBILE app on the web or the desktop while a real device is
 * booted.
 *
 * This is the shape a run takes when it has failed to reach the device and is
 * looking for something — anything — that will start: `-d chrome`, then a web
 * build, then a static server over `build/web`. Every one of those "succeeds"
 * and none of them verifies the screen the user asked about, so the run ends
 * confidently wrong instead of honestly stuck.
 *
 * Gated on a device being booted AND the project being a mobile one, so a
 * genuine Flutter-for-web or desktop project is never touched.
 */
export function checkRunSurface(input: SurfaceCheckInput): DeviceTargetVerdict {
  const { command, devices, mobileProject, deviceCommand } = input;
  if (!mobileProject || !devices.length) return { kind: "ok" };
  const target = deviceTargetInCommand(command)?.toLowerCase();
  const webFlag = /--web-port\b|--web-server-port\b|--web-hostname\b/.test(command);
  if (!webFlag && !(target && NON_DEVICE_SURFACES.has(target))) return { kind: "ok" };
  // Only a RUN of the app. Building a web bundle as a deliverable is legitimate
  // work and no business of this check.
  if (!/\b(?:flutter|expo|react-native|npx\s+expo)\s+run\b|\bflutter\s+run\b/.test(command)) {
    return { kind: "ok" };
  }
  const device = devices[0]!;
  return {
    kind: "block",
    reason: "wrong-surface",
    message: [
      `Not on the web — this is a MOBILE app and ${device.name} (\`${device.id}\`) is booted right now.`,
      `Running it in a browser or on the desktop builds a DIFFERENT target: different rendering, different ` +
        `plugins, and often it simply fails to compile. A capture of it says nothing about the screen you ` +
        `changed, so it cannot verify this work no matter what it shows.`,
      deviceCommand
        ? `Run it on the device instead — this builds, installs and launches in one step: ` +
          `\`${deviceCommand}\`, through \`bash\` with \`background: true\`.`
        : `Run it on the device instead: the project's own device command with \`-d ${device.id}\`, through ` +
          `\`bash\` with \`background: true\`.`,
      `If the device run keeps failing, that failure IS the finding — report it or ask the user, rather than ` +
        `switching to a surface that will appear to work.`,
    ].join("\n"),
  };
}
