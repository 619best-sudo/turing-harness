/**
 * How THIS project says it runs itself.
 *
 * WHY THIS FILE EXISTS
 *
 * The verify round needs to tell a model how to get an app in front of a
 * screen, and the tempting way to write that is a stack list: Flutter → this,
 * React Native → that, Expo → the other. Every such list is wrong somewhere.
 * The Flutter app that prompted this one cannot be launched with a bare
 * `flutter run` at all — it has product flavors, and its own CLAUDE.md says
 * `flutter run --flavor staging -t lib/main_staging.dart`. A hardcoded
 * `flutter run -d <id>` would have sent the model to a command that fails, in a
 * confident voice, which is worse than saying nothing.
 *
 * Projects already answer this question, in files they maintain: the scripts
 * block of a package.json, a Makefile target, the "Running the app" section of
 * a README or CLAUDE.md. This module reads those and reports what it found,
 * with the file it came from, so the verify round can quote the project back to
 * itself instead of guessing.
 *
 * The same principle as `exec/toolchain.ts`: evidence in the repo beats a table
 * in our source. When the repo says nothing, this returns nothing and the
 * prompt asks the model to go and look — which is still better than a wrong
 * command, because the model can read files and a hardcoded list cannot.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** What a command is FOR, so the verify round can ask for the right one. */
export type RunCommandKind = "device" | "dev-server" | "build" | "test" | "unknown";

export interface ProjectRunCommand {
  /** The command, verbatim as the project declares it. */
  command: string;
  /** The file (and key) it came from — the evidence, quoted back to the model. */
  source: string;
  kind: RunCommandKind;
}

/**
 * Commands that BUILD, INSTALL and LAUNCH on a device or simulator.
 *
 * This is the one classification that has to be right, because it is the
 * distinction the failing run got wrong: `flutter build apk` and
 * `gradle assembleDebug` produce an artifact and install nothing, while
 * `flutter run` and `react-native run-ios` put the app on a screen. Matching is
 * on the VERB, not the framework, so a stack nobody here has heard of still
 * classifies correctly if it uses the same vocabulary.
 */
const DEVICE_LAUNCH_PATTERNS = [
  /\bflutter\s+run\b/i,
  /\breact-native\s+run-(?:ios|android)\b/i,
  /\bexpo\s+(?:run:(?:ios|android)|start)\b/i,
  /\bcap(?:acitor)?\s+run\b/i,
  /\bxcrun\s+simctl\s+launch\b/i,
  /\bxcodebuild\b[^\n]*\b-destination\b/i,
  /\bgradlew?\b[^\n]*\binstall(?:Debug|Release)\b/i,
  /\badb\s+install\b/i,
  /\bfastlane\b[^\n]*\b(?:simulator|device)\b/i,
];

/**
 * Artifact-only commands. Recorded as `build`, never as `device`, so a round
 * that asks for a device command can never be handed one of these.
 */
const BUILD_ONLY_PATTERNS = [
  /\bflutter\s+build\b/i,
  /\bgradlew?\b[^\n]*\bassemble\b/i,
  /\bgradlew?\b[^\n]*\bbundle\b/i,
  /\bxcodebuild\s+archive\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i,
  /\b(?:vite|next|tsc|webpack|rollup|esbuild)\s+build\b/i,
];

const DEV_SERVER_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i,
  /\b(?:vite|next|nuxt|remix|astro)\s+(?:dev|start|preview)\b/i,
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\brails\s+server\b/i,
  /\b(?:flask|uvicorn|gunicorn)\b/i,
];

const TEST_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:vitest|jest|pytest|rspec|go\s+test|cargo\s+test)\b/i,
  /\bflutter\s+test\b/i,
];

/**
 * Script/target NAMES that state their purpose, used when the body does not.
 *
 * A script called `ios` that shells out to `./scripts/launch.sh` is a device
 * command and no pattern above will see it; the name is the only evidence there
 * is, and the author chose it deliberately. Consulted for `device` BEFORE the
 * body (the name is the stated intent) and for the rest AFTER it (a script
 * named `build` that actually runs the app should be reported as a run).
 */
const SCRIPT_NAME_KINDS: Array<[RegExp, RunCommandKind]> = [
  [/^(?:ios|android|run:?(?:ios|android)|emulate|device|simulator)$/i, "device"],
  [/^build(?:[:-].*)?$/i, "build"],
  [/^test(?:[:-].*)?$/i, "test"],
  [/^(?:dev|start|serve|preview)(?:[:-].*)?$/i, "dev-server"],
];

function nameKind(scriptName: string | undefined, want?: RunCommandKind): RunCommandKind | undefined {
  if (!scriptName) return undefined;
  for (const [pattern, kind] of SCRIPT_NAME_KINDS) {
    if (!pattern.test(scriptName)) continue;
    return want && kind !== want ? undefined : kind;
  }
  return undefined;
}

/**
 * Classify one command line. Exported because the QA gate reads the same
 * distinction to decide whether a `bash` call actually DEPLOYED the change —
 * `device` puts new bytes on a screen, `build` produces an artifact and installs
 * nothing — and that judgement must not drift from the one the verify messages
 * print.
 */
export function classify(command: string, scriptName?: string): RunCommandKind {
  if (nameKind(scriptName, "device")) return "device";
  // Device before build-only: a script that runs the app is a run even if it
  // compiles first, and `flutter build` matches nothing here so it cannot leak.
  if (DEVICE_LAUNCH_PATTERNS.some((p) => p.test(command))) return "device";
  if (BUILD_ONLY_PATTERNS.some((p) => p.test(command))) return "build";
  if (TEST_PATTERNS.some((p) => p.test(command))) return "test";
  if (DEV_SERVER_PATTERNS.some((p) => p.test(command))) return "dev-server";
  return nameKind(scriptName) ?? "unknown";
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `cwd` and each ancestor, nearest first — a monorepo package before its root. */
function ancestors(cwd: string, limit = 6): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < limit; i += 1) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fromPackageJson(root: string, rel: string): Promise<ProjectRunCommand[]> {
  const raw = await readIfExists(path.join(root, "package.json"));
  if (!raw) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const out: ProjectRunCommand[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string" || !body.trim()) continue;
    const kind = classify(body, name);
    if (kind === "unknown") continue;
    // The invocation, not the body: `npm run ios` is what a person types, and
    // it picks up whatever the script does today.
    out.push({ command: `npm run ${name}`, source: `${rel}package.json scripts.${name}`, kind });
  }
  return out;
}

/**
 * Makefile targets. Classified by the target NAME and by its recipe lines,
 * because `make run` says what it is for and the recipe says what it does.
 */
async function fromMakefile(root: string, rel: string): Promise<ProjectRunCommand[]> {
  const raw = await readIfExists(path.join(root, "Makefile"));
  if (!raw) return [];
  const out: ProjectRunCommand[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const target = /^([A-Za-z0-9_.-]+):(?!=)/.exec(lines[i]!);
    if (!target) continue;
    const name = target[1]!;
    // The recipe is the indented block under the target.
    const recipe: string[] = [];
    for (let j = i + 1; j < lines.length && /^\t/.test(lines[j] ?? ""); j += 1) recipe.push(lines[j]!.trim());
    const kind = classify(recipe.join("\n"), name);
    if (kind === "unknown") continue;
    out.push({ command: `make ${name}`, source: `${rel}Makefile target \`${name}\``, kind });
  }
  return out;
}

/**
 * Documented commands — the fenced shell blocks of the files a project writes
 * FOR this purpose.
 *
 * This is the source that catches what no manifest can: flavors, entrypoints,
 * a required `--dart-define`, the device flag this team always passes. It is
 * also the least structured, so matching is strict (a fenced block, a line that
 * classifies) and the result is capped.
 */
const DOC_FILES = ["CLAUDE.md", "AGENTS.md", "README.md", "CONTRIBUTING.md", "DEVELOPMENT.md", "docs/README.md"];

/** Fence languages whose contents are shell. A bare ``` counts. */
const SHELL_FENCE = /^(?:bash|sh|shell|zsh|console|shellsession|terminal)?$/i;

/**
 * Shell lines inside fenced blocks.
 *
 * Parsed as a state machine over every fence rather than with one regex,
 * because a regex that only recognises SHELL fences pairs the opening ``` of a
 * shell block with the closing ``` of some later block and swallows all the
 * prose in between. That is not hypothetical: on the app that prompted this,
 * a ```dart block sat between two shell blocks and the naive match harvested
 * two paragraphs of performance-tuning prose as if they were commands.
 */
function fencedShellLines(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let isShell = false;
  for (const line of markdown.split("\n")) {
    const fence = /^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      if (inFence) {
        inFence = false;
      } else {
        inFence = true;
        isShell = SHELL_FENCE.test(fence[1] ?? "");
      }
      continue;
    }
    if (inFence && isShell) out.push(line);
  }
  return out;
}

/**
 * Does this line read as a command someone would type, rather than a sentence
 * that happens to mention one?
 *
 * Docs quote commands inside prose constantly ("Run with `flutter run
 * --profile` and enable the overlay…"), and a matched pattern alone cannot tell
 * the two apart. Shape can: a command is short, starts with the program, and
 * carries no markdown.
 */
function looksLikeCommandLine(line: string): boolean {
  if (!line || line.length > 200) return false;
  if (line.startsWith("#")) return false;
  if (line.includes("`")) return false; // a command quoted inside a sentence
  if (/\*\*\S/.test(line) || line.includes("](")) return false; // bold, or a link
  if (/^\s*(?:\d+[.)]|[-+]|\*\s)\s*/.test(line) && !/^[A-Za-z_./]/.test(line)) return false; // a list item
  if (!/^[A-Za-z_./]/.test(line)) return false;
  // Underscores and `*` are NOT markdown here: `-t lib/main_staging.dart` and
  // `rm build/*.apk` are ordinary shell, and rejecting them threw away the
  // flavored launch command this whole module exists to find.
  return true;
}

async function fromDocs(root: string, rel: string): Promise<ProjectRunCommand[]> {
  const out: ProjectRunCommand[] = [];
  for (const file of DOC_FILES) {
    const raw = await readIfExists(path.join(root, file));
    if (!raw) continue;
    for (const rawLine of fencedShellLines(raw)) {
      const command = rawLine.trim().replace(/^[$>]\s+/, "");
      if (!looksLikeCommandLine(command)) continue;
      // A documented command is only interesting if it is one we can label.
      if (classify(command) !== "device") continue;
      if (out.some((c) => c.command === command)) continue;
      out.push({ command, source: `${rel}${file}`, kind: "device" });
    }
  }
  return out;
}

/**
 * The number of documented device commands carried into a prompt.
 *
 * A README can list a launch line per flavor per platform; pasting fifteen of
 * them buries the point. Enough to show the shape and the flags this project
 * actually uses, and the model can read the file for the rest.
 */
const MAX_DOC_COMMANDS = 4;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Every run command this project declares, nearest package first.
 *
 * Ordered by how much the project committed to it: a package script or Makefile
 * target is machine-readable intent; a documented command is prose we parsed.
 * Deduplicated on the command text.
 */
export async function detectRunCommands(cwd: string): Promise<ProjectRunCommand[]> {
  const out: ProjectRunCommand[] = [];
  const seen = new Set<string>();
  const push = (entries: ProjectRunCommand[], cap = Infinity) => {
    let added = 0;
    for (const entry of entries) {
      if (seen.has(entry.command) || added >= cap) continue;
      seen.add(entry.command);
      out.push(entry);
      added += 1;
    }
  };

  for (const root of ancestors(cwd)) {
    const rel = path.relative(cwd, root) ? `${path.relative(cwd, root)}/` : "";
    const [pkg, make, docs] = await Promise.all([
      fromPackageJson(root, rel),
      fromMakefile(root, rel),
      fromDocs(root, rel),
    ]);
    push(pkg);
    push(make);
    push(docs, MAX_DOC_COMMANDS);
    // Stop at the first directory that declared anything: a monorepo package's
    // own scripts are the answer, not the workspace root's.
    if (out.length) break;
  }
  return out;
}

/** Just the ones that put the app on a device/simulator. */
export async function detectDeviceRunCommands(cwd: string): Promise<ProjectRunCommand[]> {
  return (await detectRunCommands(cwd)).filter((c) => c.kind === "device");
}

/**
 * The "how do I get this on a screen" paragraph for a verify round, built from
 * what the project actually declares.
 *
 * Returns the general instruction either way. What changes is whether it can
 * quote the project or has to send the model to read it — never a guess at a
 * command this repo may not accept.
 */
export function describeDeviceLaunch(commands: ProjectRunCommand[]): string {
  const lines = [
    "MOBILE — THE APP MUST BE RUNNING ON THE DEVICE BEFORE A SCREENSHOT MEANS ANYTHING. You need the ONE " +
      "command that BUILDS, INSTALLS AND LAUNCHES it on the target; a command that only produces an artifact " +
      "(a build/assemble/archive/bundle task) installs nothing and leaves you screenshotting whatever was on " +
      "the device already.",
  ];
  if (commands.length) {
    lines.push("This project declares:");
    for (const c of commands) lines.push(`  - \`${c.command}\`  — ${c.source}`);
    lines.push(
      "Use one of those, adapted to the device you picked (they may need a flavor, an entrypoint or a " +
        "`-d`/`--device` flag). If none fits, read the file it came from before improvising.",
    );
  } else {
    lines.push(
      "This project declares none that were recognisable, so FIND IT rather than guessing: the scripts block " +
        "of its package manifest, a Makefile target, the run/getting-started section of its README / CLAUDE.md " +
        "/ AGENTS.md, or the CI workflow. Mobile projects routinely need flags a generic command omits " +
        "(a flavor, a target entrypoint, a scheme), so a command you invented will fail in a way that looks " +
        "like the app is broken.",
    );
  }
  lines.push(
    "Run it through `bash` with `background: true, waitMs: 300000` — the call listens and returns on the outcome; a cold first build takes " +
      "minutes, so do not shorten `timeoutMs` and do not read a kill as a failure. Then capture with " +
      "`activity_inspect` (`target:\"mobile\"`, the device id, and `bundleId` to foreground the app).",
  );
  return lines.join("\n");
}

/**
 * The mobile toolchain a project is built with, when it is a mobile project.
 *
 * Detected from manifests rather than asked of the model, because the model's
 * guesses were the problem. An observed run, on a Flutter app with one booted
 * iOS simulator, tried in order: `flutter build apk --debug` (an ANDROID
 * artifact), then `flutter build ios --debug --no-codesign` (a build for a
 * physical DEVICE, which writes `build/ios/iphoneos/` and cannot be installed on
 * a simulator), then `mobile_install_app` against
 * `build/ios/Debug-staging-iphonesimulator/Runner.app` — a stale flavor path
 * left by some earlier Xcode build. None of those could have worked, and the run
 * read their failure as the app being unrunnable.
 *
 * The command that actually does the job on a booted simulator is one line, and
 * the harness can work it out. See {@link deviceLaunchCommand}.
 */
export type MobileStack = "flutter" | "expo" | "react-native" | "gradle";

/** Read `package.json` dependencies (both blocks) at `root`, or an empty set. */
async function packageDeps(root: string): Promise<Set<string>> {
  const raw = await readIfExists(path.join(root, "package.json"));
  if (!raw) return new Set();
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

/**
 * Which mobile toolchain this project uses, or undefined when it is not a mobile
 * project (or uses one this cannot name confidently).
 *
 * Ordered most-specific first: an Expo app also depends on `react-native`, and a
 * Flutter app may still contain an `android/gradlew`.
 */
export async function detectMobileStack(cwd: string): Promise<MobileStack | undefined> {
  for (const root of ancestors(cwd)) {
    if (await readIfExists(path.join(root, "pubspec.yaml"))) return "flutter";
    const deps = await packageDeps(root);
    if (deps.has("expo")) return "expo";
    if (deps.has("react-native")) return "react-native";
    if (deps.size) return undefined; // a JS project, but not a mobile one
    if (await readIfExists(path.join(root, "android", "build.gradle"))) return "gradle";
    if (await readIfExists(path.join(root, "build.gradle"))) return "gradle";
  }
  return undefined;
}

/** Flags by which a command already names its target device. */
const DEVICE_PIN_RE = /(?:^|\s)(?:-d[=\s]|--device-id[=\s]|--device[=\s]|--udid[=\s]|--deviceId[=\s])/;

/** The flag this stack uses to pin a device, when it takes one. */
function devicePinFlag(command: string, stack: MobileStack | undefined): string | undefined {
  if (/\breact-native\b/.test(command) || stack === "react-native") {
    return /run-android/.test(command) ? "--deviceId" : "--udid";
  }
  if (/\bexpo\b/.test(command) || stack === "expo") return "--device";
  if (/\bflutter\b/.test(command) || stack === "flutter") return "-d";
  return undefined;
}

/**
 * The stack's generic one-shot run command. LAST RESORT only — see
 * {@link composeDeviceLaunch} for why this must never outrank the project.
 */
function stackDefaultLaunch(
  stack: MobileStack | undefined,
  deviceId: string,
  platform: "ios" | "android",
): string | undefined {
  switch (stack) {
    case "flutter":
      return `flutter run -d ${deviceId}`;
    case "expo":
      return platform === "ios"
        ? `npx expo run:ios --device ${deviceId}`
        : `npx expo run:android --device ${deviceId}`;
    case "react-native":
      return platform === "ios"
        ? `npx react-native run-ios --udid ${deviceId}`
        : `npx react-native run-android --deviceId ${deviceId}`;
    case "gradle":
      return platform === "android" ? `./gradlew installDebug` : undefined;
    default:
      return undefined;
  }
}

/** A device-launch command, and how much the harness trusts it. */
export interface ComposedLaunch {
  command: string;
  /** `project` — read from the repo, authoritative. `stack` — a generic default. */
  origin: "project" | "stack";
  /** Where a `project` command came from, quoted back as evidence. */
  source?: string;
}

/**
 * The command to run THIS project on THIS booted device.
 *
 * The project's own declaration ALWAYS wins, with the device pinned onto it.
 * That ordering is the whole point, and the project that prompted all of this
 * shows why: `cards_mobile_app` has product flavors, and its CLAUDE.md says
 *
 *     flutter run --flavor staging -t lib/main_staging.dart
 *
 * A bare `flutter run -d <udid>` does not build that app — it fails on a missing
 * flavor, in a way that reads like the app is broken rather than like the
 * command was wrong. So the generic stack command is a LAST RESORT, reported as
 * such, and never quoted over something the repo actually says.
 *
 * The harness already detected that CLAUDE.md line and already knew the booted
 * simulator's id. It just never put the two together where the model could see
 * them — which is how a run spent its whole budget on `flutter build apk`,
 * `flutter build ios --debug` (a physical-device build, which cannot install on
 * a simulator) and finally `flutter run -d chrome`.
 */
export function composeDeviceLaunch(
  commands: readonly ProjectRunCommand[],
  stack: MobileStack | undefined,
  deviceId: string,
  platform: "ios" | "android",
): ComposedLaunch | undefined {
  const declared = commands.find((c) => c.kind === "device" && c.command.trim());
  if (declared) {
    const base = declared.command.trim();
    // Already pins a device ⇒ leave it exactly as the project wrote it.
    if (DEVICE_PIN_RE.test(base)) {
      return { command: base, origin: "project", source: declared.source };
    }
    const flag = devicePinFlag(base, stack);
    return {
      command: flag ? `${base} ${flag} ${deviceId}` : base,
      origin: "project",
      source: declared.source,
    };
  }
  const fallback = stackDefaultLaunch(stack, deviceId, platform);
  return fallback ? { command: fallback, origin: "stack" } : undefined;
}

/** One quotable line for a composed launch, stating how much to trust it. */
export function describeComposedLaunch(launch: ComposedLaunch): string {
  return launch.origin === "project"
    ? `\`${launch.command}\`  — this project's own run command (${launch.source}), with the device pinned`
    : `\`${launch.command}\`  — a generic default for this stack, NOT read from the project. If it needs a ` +
        `flavor, an entrypoint or a scheme, read its README / CLAUDE.md / package scripts and add them`;
}

/** Just the ones that start a local server you can point a browser at. */
export async function detectDevServerCommands(cwd: string): Promise<ProjectRunCommand[]> {
  return (await detectRunCommands(cwd)).filter((c) => c.kind === "dev-server");
}

/**
 * The web counterpart of {@link describeDeviceLaunch}: how to get a page on
 * screen so it can be looked at.
 *
 * Same principle, same reason. The device half of this existed because a run had
 * screenshotted a simulator with no app on it; the web half was missing, so a run
 * verifying a page had to guess a port. A guessed `localhost:3000` that nothing
 * answers returns an error page, and an error page analysed as if it were the app
 * is worse than no check at all — it reports PASS or FAIL about a page that does
 * not exist.
 */
export function describeDevServerStart(commands: ProjectRunCommand[]): string {
  const lines = [
    "WEB — THE PAGE MUST BE SERVED BEFORE A SCREENSHOT MEANS ANYTHING, and it must be served on the port you " +
      "then point `activity_inspect` at. A URL nothing answers captures an error page, which is a FAILED " +
      "verification, not a pass — never analyse one.",
  ];
  if (commands.length) {
    lines.push("This project declares:");
    for (const c of commands) lines.push(`  - \`${c.command}\`  — ${c.source}`);
  } else {
    lines.push(
      "This project declares none that were recognisable, so FIND IT rather than guessing: the scripts block " +
        "of its package manifest, a Makefile target, or the run/getting-started section of its README / " +
        "CLAUDE.md / AGENTS.md.",
    );
  }
  lines.push(
    "Start it through `bash` with `background: true`, then read the log for the URL IT PRINTS and use that — " +
      "not a remembered default. If it is already running and reachable, reuse it. Then one " +
      "`activity_inspect` call with that `url` and `expected` set to what you built.",
  );
  lines.push(
    "START IT ONCE. A second server for the same project is a port fight, not a retry — if the first start " +
      "is slow, WAIT on it (`waitMs`), don't spawn another. And NEVER open the page as a `file://` URL or " +
      "spin up a one-off `python3 -m http.server` beside the real one: a file opened from disk is not the " +
      "app the users get (no server, no dev-server transforms, no API), so a capture of it verifies nothing " +
      "about the real surface.",
  );
  return lines.join("\n");
}
