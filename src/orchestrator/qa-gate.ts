/**
 * The QA gate: WHEN a run is allowed to look at a screen, and WHAT it must have
 * done first.
 *
 * Every rule here is already written in the prompts, and an observed run broke
 * every one of them anyway. The run (a one-line Flutter dialog-title change)
 * went: edit → `flutter analyze` → `mobile_launch_app` on the ALREADY-INSTALLED
 * binary → `mobile_take_screenshot` (the iOS home screen) → three guessed
 * coordinate taps → two more screenshots → "verified". It never built, so the
 * app on the simulator was the OLD code; it never called `activity_inspect`, so
 * nothing judged the pixels; it never called `media_analysis`, so the
 * screenshots were captured and thrown away; and it only asked the user for help
 * with the login wall in the last turn of the run, after burning the budget
 * wandering the springboard.
 *
 * Prose did not bind, so this is the same rules expressed as something that can
 * stop a call. Three of them, all project-agnostic:
 *
 *   1. SCOPE — QA is the verify pass's job. Once the run has WRITTEN something,
 *      raw drive/capture tools (`mobile_take_screenshot`, `browser_click`, …) in
 *      a WORK loop are refused: finish the change, run the project's own build,
 *      and let the dedicated verify pass do the QA through `activity_inspect`.
 *      Before the first write they are allowed — that is bug REPRODUCTION, which
 *      is required, not QA.
 *
 *   2. FRESHNESS — a capture only means something if the surface is running the
 *      code you just wrote. On a DEVICE, after an edit, that requires a
 *      build+install: an installed app does not change because a file on disk
 *      did, so a capture taken in between verifies the OLD binary, always. Those
 *      captures are refused with the project's OWN launch command quoted back.
 *      Scoped to the device on purpose — a web dev server hot-reloads and may
 *      have been started outside this run, so "stale" there is a guess, and the
 *      guessed-URL failure it would half-catch is already caught downstream by
 *      `activity_inspect`'s own navigation-failure detection.
 *
 *   3. STUCK — driving a UI in circles is how a run reaches a login wall and
 *      keeps tapping. After enough capture/drive calls with no write, no deploy
 *      and no question, the gate emits a nudge naming `ask_user_question` as the
 *      way across: the user can answer with the value OR attach the file, and
 *      the run continues from where it stopped.
 *
 * Non-wedging by construction: each refusal kind stands down after `maxBlocks`
 * so a model that cannot satisfy it is never deadlocked — it proceeds with the
 * warning on the record instead. The gate holds no filesystem and does no I/O.
 */
import {
  classify as classifyRunCommand,
  composeDeviceLaunch,
  describeComposedLaunch,
  type MobileStack,
  type ProjectRunCommand,
} from "../exec/run-commands.js";
import {
  checkBuildTarget,
  checkDeviceId,
  checkRunSurface,
  deviceTargetInCommand,
  type DeviceTargetVerdict,
} from "../exec/device-target.js";
import { listLocalDevices, type LocalDevice } from "../devices/local-devices.js";
import { mobileActionToolName } from "../devices/mobile-tool.js";
import { instrumentationTarget } from "./reproduction-gate.js";

/** Which surface a call touches, when the call names one. */
export type QaSurface = "mobile" | "browser" | "unknown";

/** A gate decision for one tool call. */
export type QaDecision = { kind: "allow" } | { kind: "block"; message: string; reason: QaBlockReason };

/** Why a call was refused — one counter per reason, so one cannot exhaust another. */
export type QaBlockReason =
  | "scope"
  | "stale"
  | "unknown-device"
  | "wrong-surface"
  | "wrong-build"
  | "blind-tap";

export interface QaGateOptions {
  /**
   * True inside the dedicated verify rounds. The verify pass IS the QA pass, so
   * the SCOPE rule stands down there — driving the app to reach the screen under
   * test is exactly what those rounds are for. FRESHNESS still applies: a stale
   * capture is wrong whoever takes it.
   */
  verifyPass?: boolean;
  /**
   * The project's own device build+install+launch commands, detected from its
   * manifests. Quoted verbatim in a freshness refusal so the model is handed the
   * command instead of inventing one (the observed run invented
   * `--no-sound-null-safety`, which does not exist, and read the failure as the
   * app being unverifiable).
   */
  deviceCommands?: ProjectRunCommand[];
  /**
   * True when the project's product is an app on a device. Enables the
   * wrong-surface and wrong-build refusals.
   */
  mobileProject?: boolean;
  /**
   * The project's mobile toolchain, used to pin a booted device onto the
   * project's own run command. See `composeDeviceLaunch`.
   */
  mobileStack?: MobileStack;
  /**
   * How the gate learns which devices are booted. Injectable so the rules stay
   * testable without a simulator; defaults to the harness's own probe.
   */
  listDevices?: () => Promise<readonly LocalDevice[]>;
  /** Refusals per reason before the gate stands down. Default 2. */
  maxBlocks?: number;
  /** Capture/drive calls with no progress before the stuck nudge fires. Default 6. */
  stuckAfter?: number;
}

// ---------------------------------------------------------------------------
// Tool classification
//
// Matching is on the tool's BARE name and on the `<server>__<name>` form an MCP
// bridge produces, so a server prefix never smuggles a call past a rule. Names
// are grouped by what the call DOES, not by which server offers it, so a device
// MCP nobody here has heard of classifies correctly if it uses the same verbs.
// ---------------------------------------------------------------------------

/** Tools that photograph a surface. A capture is the thing freshness guards. */
const CAPTURE_TOOLS = [
  "mobile_screenshot",
  // `mobile { action: "look" }` maps here: it screenshots AND lists elements,
  // so it is a capture for freshness purposes and a position analysis for tap
  // credit (see POSITION_ANALYSIS_TOOLS).
  "mobile_elements",
  "browser_take_screenshot",
  "browser_snapshot",
  "take_screenshot",
  "take_snapshot",
];

/** Tools that ACT on a surface — taps, typing, navigation, app launch. */
const DRIVE_TOOLS = [
  "mobile_tap",
  "mobile_long_press",
  "mobile_swipe",
  "mobile_type_text",
  "mobile_press_button",
  "mobile_launch_app",
  "mobile_terminate_app",
  "mobile_open_url",
  "mobile_elements",
  "mobile_tap_visual",
  "browser_click",
  "browser_type",
  "browser_navigate",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_evaluate",
  // chrome-devtools names its verbs bare; the `__` form covers the bridged case
  // and the bare form is only matched when it is the WHOLE name.
  "navigate_page",
  "new_page",
  "click",
  "fill",
  "fill_form",
  "hover",
  "drag",
  "type_text",
  "press_key",
  "evaluate_script",
];

/** Tools whose success means a NEW build reached the device. */
const INSTALL_TOOLS = ["mobile_install_app"];

/** Coordinate tap tools — precise x/y, so the x/y must be DERIVED, not nudged. */
const COORDINATE_TAP_TOOLS = [
  "mobile_tap",
  "mobile_long_press",
];

/**
 * Tools whose success hands the model positions it can tap with confidence.
 *
 * `mobile_elements` belongs here and its absence was a live self-contradiction:
 * the blind-tap refusal below tells the model, in these words, to call
 * `mobile_elements` and "tap that centre verbatim" — and then the gate refused
 * the very tap it had just demanded, because only `media_analysis` granted
 * credit. In one production run every direct `mobile_tap` was rejected while
 * carrying an exact centre copied straight out of the element tree.
 *
 * It is also the STRONGEST evidence available, not the weakest: an element rect
 * is measured, where a vision estimate is guessed. Anything that reads real
 * positions off the device earns a tap.
 */
const POSITION_ANALYSIS_TOOLS = [
  "media_analysis",
  "mobile_elements",
];

function matches(name: string, list: readonly string[]): boolean {
  return list.some((t) => name === t || name.endsWith(`__${t}`));
}

/**
 * The name a rule should classify this call under.
 *
 * Every rule below reasons about tool NAMES — what counts as a capture, a
 * drive, a coordinate tap, a position analysis. The device toolkit is now a
 * single `mobile` tool with an `action`, which would have collapsed all of
 * those distinctions into one name and quietly disabled the lot: a screenshot
 * and a tap would have been indistinguishable. So a `mobile` call is mapped
 * back onto the per-action name the rules already know, and every list stays
 * exactly as it was.
 */
function effectiveName(name: string, args: Record<string, unknown> | undefined): string {
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare !== "mobile") return name;
  const mapped = mobileActionToolName(typeof args?.action === "string" ? args.action : undefined);
  return mapped ?? name;
}

/** True for a coordinate tap (precise x/y — the blind-nudge failure mode). */
export function isCoordinateTapTool(name: string): boolean {
  return matches(name, COORDINATE_TAP_TOOLS);
}

/** True for a raw screenshot/snapshot tool. */
export function isCaptureTool(name: string): boolean {
  return matches(name, CAPTURE_TOOLS);
}

/** True for a raw tap/type/navigate/launch tool. */
export function isDriveTool(name: string): boolean {
  return matches(name, DRIVE_TOOLS);
}

/** True for `activity_inspect` — the sanctioned capture-and-judge entry point. */
export function isInspectTool(name: string): boolean {
  return name === "activity_inspect" || name.endsWith("__activity_inspect");
}

/** True for `ask_user_question` — the way across a wall the agent cannot cross. */
function isAskTool(name: string): boolean {
  return name === "ask_user_question" || name.endsWith("__ask_user_question");
}

function isBashTool(name: string): boolean {
  return name === "bash" || name.endsWith("__bash");
}

/**
 * A screenshot (or screen recording) taken through a SHELL command rather than a
 * capture tool — `npx playwright screenshot …`, `screencapture`, `xcrun simctl
 * io … screenshot`, `adb … screencap`. A real run, refused on its raw
 * `browser_take_screenshot`, said "the harness keeps blocking screenshot" and
 * rerouted the SAME capture through `bash`, where a tool-name gate sees nothing.
 * The command text is the only signal that closes it; kept tight to screenshot
 * semantics so an ordinary build/test command never matches.
 */
const BASH_CAPTURE_RE =
  /playwright\s+(?:screenshot|--save-video)|\bscreencapture\b|simctl\s+io\s+\S+\s+screenshot|\badb\s+(?:exec-out\s+)?(?:shell\s+)?screencap/i;

/** The matched capture snippet when a `bash` command is a screenshot in disguise. */
function bashCaptureSnippet(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!isBashTool(name)) return null;
  const cmd = typeof args?.command === "string" ? args.command : "";
  const m = cmd.match(BASH_CAPTURE_RE);
  return m ? m[0] : null;
}

function isMutationTool(name: string): boolean {
  return name === "write" || name === "edit";
}

/**
 * The surface a call is pointed at, from its own arguments.
 *
 * For `activity_inspect` this mirrors the tool's own routing: an explicit
 * `target` wins, then a device/bundle argument means the device, then an http
 * url means the browser. For raw tools the name says it (`mobile_*` vs
 * `browser_*`). `unknown` is not guessed at — an unknown surface is never
 * blocked by the freshness rule, because refusing a call whose target we could
 * not determine would refuse work the rule was never written about.
 */
export function callSurface(name: string, args: Record<string, unknown> | undefined): QaSurface {
  if (isInspectTool(name)) {
    const target = typeof args?.target === "string" ? args.target.toLowerCase() : "";
    if (target === "mobile") return "mobile";
    if (target === "browser") return "browser";
    if (args?.bundleId || args?.device) return "mobile";
    const url = typeof args?.url === "string" ? args.url.trim() : "";
    if (/^https?:\/\//i.test(url)) return "browser";
    if (url) return "mobile"; // a deep link (myapp://…) is a device target
    return "unknown";
  }
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare.startsWith("mobile_")) return "mobile";
  if (bare.startsWith("browser_")) return "browser";
  if (CAPTURE_TOOLS.includes(bare) || DRIVE_TOOLS.includes(bare)) return "browser";
  return "unknown";
}

/**
 * Whether a `bash` call DEPLOYS the change — puts new bytes on a device, or
 * stands a server up in front of them.
 *
 * Reuses the project's own run-command classifier so the vocabulary is shared
 * with the messages the verify stages already print. `device` means build +
 * install + launch (`flutter run`, `react-native run-ios`, `gradlew
 * installDebug`); `build` alone deliberately does NOT count on the device side
 * — `flutter build apk` produces an artifact and installs nothing, which is the
 * exact distinction a stale capture turns on.
 */
export function deployKind(command: string): "device" | "web" | null {
  const kind = classifyRunCommand(command);
  if (kind === "device") return "device";
  if (kind === "dev-server") return "web";
  return null;
}

/** Render the project's own commands as a quotable list, or a generic fallback. */
function quoteCommands(commands: ProjectRunCommand[] | undefined, fallback: string): string {
  const real = (commands ?? []).filter((c) => c.command.trim());
  if (!real.length) return fallback;
  return real.slice(0, 3).map((c) => `\`${c.command}\` (from ${c.source})`).join(" or ");
}

/**
 * Run-scoped QA sequencing. One instance per run, threaded into every loop so
 * the writes a work loop made are the writes the verify pass's freshness rule
 * measures against.
 */
export class QaGate {
  private readonly maxBlocks: number;
  private readonly stuckAfter: number;
  private readonly deviceCommands: ProjectRunCommand[];
  private readonly mobileProject: boolean;
  private readonly mobileStack: MobileStack | undefined;
  private readonly listDevices: () => Promise<readonly LocalDevice[]>;

  /** True during the dedicated verify rounds. Mutable: one gate, many loops. */
  private verifyPass: boolean;

  /**
   * A monotonic tick, bumped on every event the gate records.
   *
   * Deliberately not a wall-clock timestamp. ORDERING is the whole question here
   * — did the build happen after the edit — and wall-clock has millisecond
   * granularity, so an edit, a build and a second edit inside one millisecond
   * compare EQUAL and the second edit's staleness silently disappears. A counter
   * cannot tie, and cannot be moved by a clock adjustment either.
   */
  private tick = 0;
  /** The tick at which the run last wrote real (non-probe) bytes. */
  private lastWriteAt = 0;
  /** The tick at which a build+install last reached a device. */
  private deviceDeployAt = 0;
  /** Paths written since the last device deploy — named in the refusal. */
  private readonly pendingWrites = new Set<string>();
  /** Refusals issued, per reason. */
  private readonly blocks: Record<QaBlockReason, number> = {
    scope: 0,
    stale: 0,
    // A typo'd device id gets a longer leash than the judgement calls: the
    // correction is mechanical and unambiguous ("you are one character off,
    // here is the id"), so repeating it is far cheaper than letting a run
    // conclude the device is unreachable — which is what happened.
    "unknown-device": 0,
    "wrong-surface": 0,
    "wrong-build": 0,
    "blind-tap": 0,
  };
  /** Capture/drive calls since the last write, deploy or question. */
  private driveStreak = 0;
  /** Whether the stuck nudge has already fired for the current streak. */
  private stuckNotified = false;
  /**
   * True while a position ANALYSIS (`activity_inspect` or `media_analysis`) has
   * handed the model derivable coordinates since the last coordinate tap. A raw
   * screenshot does NOT set it: the run that birthed this rule screenshotted
   * between every tap and still nudged x by 15px, 3px, … — pixels on screen are
   * only positions once something has READ them off the image.
   */
  private tapCredit = false;

  constructor(opts: QaGateOptions = {}) {
    this.maxBlocks = opts.maxBlocks ?? 2;
    this.stuckAfter = opts.stuckAfter ?? 6;
    this.deviceCommands = opts.deviceCommands ?? [];
    this.mobileProject = opts.mobileProject === true;
    this.mobileStack = opts.mobileStack;
    this.listDevices = opts.listDevices ?? (() => listLocalDevices());
    this.verifyPass = opts.verifyPass === true;
  }

  /** Switch the gate between work loops and the dedicated verify rounds. */
  setVerifyPass(on: boolean): void {
    this.verifyPass = on;
  }

  /** True once the run has written real bytes — i.e. it owes QA at all. */
  hasWrites(): boolean {
    return this.lastWriteAt > 0;
  }

  /** Files written since the last device deploy. */
  stalePaths(): string[] {
    return [...this.pendingWrites];
  }

  /**
   * Whether the surface is running the bytes the run last wrote.
   *
   * Scoped deliberately narrowly, to the one case where "stale" is a fact rather
   * than a guess:
   *
   * DEVICE, and only after a write. An app installed on a simulator does not
   * change because a file on disk did — there is no mechanism by which it could.
   * So a capture taken between an edit and a build+install is verifying the old
   * binary, always, and that is worth refusing.
   *
   * NOT the browser. A dev server hot-reloads, and it may well have been started
   * outside this run (the usual setup: the user already has `npm run dev` up).
   * "No server was started in THIS run" is therefore not evidence of anything,
   * and blocking on it would refuse correct captures. The real web failure — a
   * guessed URL nothing answers — is already caught downstream: `activity_inspect`
   * detects a navigation failure / error page and reports it as a failed capture
   * rather than handing it to the analyst.
   *
   * BEFORE THE FIRST WRITE nothing is stale by construction: the surface and the
   * source agree, and looking at it is bug REPRODUCTION, which the run is
   * required to do.
   */
  isFresh(surface: QaSurface): boolean {
    if (!this.hasWrites()) return true;
    if (surface === "mobile") return this.deviceDeployAt >= this.lastWriteAt;
    return true;
  }

  /**
   * Decide one call, BEFORE it executes. `allow` for anything this gate has no
   * opinion on, which is the overwhelming majority of calls.
   */
  check(rawName: string, args: Record<string, unknown> | undefined): QaDecision {
    const name = effectiveName(rawName, args);
    const capture = isCaptureTool(name);
    const drive = isDriveTool(name);
    const inspect = isInspectTool(name);
    // A screenshot taken through a shell command is still a raw capture — the
    // route the tool-name rules were dodged with.
    const bashCapture = bashCaptureSnippet(name, args);
    if (!capture && !drive && !inspect && !bashCapture) return { kind: "allow" };

    // --- 1. SCOPE: QA belongs to the verify pass. -------------------------
    // Only in a WORK loop, only after a write (before one, driving is bug
    // reproduction — required), and never against `activity_inspect`, which is
    // the tool this rule is redirecting TO.
    if (!this.verifyPass && !inspect && (capture || drive || bashCapture) && this.hasWrites() && this.blocks.scope < this.maxBlocks) {
      this.blocks.scope += 1;
      return {
        kind: "block",
        reason: "scope",
        message: [
          bashCapture
            ? `That \`bash\` command (\`${bashCapture} …\`) is a raw screenshot wearing a shell — the capture ` +
              `the previous refusal already turned down, rerouted where the tool name hides it.`
            : `\`${name}\` is not this step's job. You have already changed code, so QA now belongs to the ` +
              `dedicated verify pass that runs at the end of this run — driving the app and taking raw ` +
              `screenshots here does the same check twice, and does it worse (a raw screenshot is a capture, ` +
              `not a verdict).`,
          ``,
          `What this step owes instead:`,
          `  1. Finish the code change.`,
          `  2. Run the project's OWN build/typecheck so a compile error is caught now — ` +
            `${quoteCommands(this.deviceCommands, "the command the project's manifest declares")}.`,
          `  3. Stop. The verify pass will instrument, run the app and judge the screen with ` +
            `\`activity_inspect\` (one call: it drives the surface, captures it AND returns VERDICT: PASS/FAIL).`,
          ``,
          `If you genuinely need to see the screen in THIS step, call \`activity_inspect\` — with ` +
            `\`expected\` set to what you changed — instead of a raw screenshot/tap tool.`,
        ].join("\n"),
      };
    }

    // --- 2. BLIND TAPS: coordinates come from the screenshot, not from nudging.
    // A precise x/y tap is a claim that you KNOW where the element is. The only
    // evidence for that claim is a position read off a capture — `activity_inspect`
    // (which captures AND judges) or `media_analysis` on a screenshot. Real runs
    // instead tapped a guessed spot, screenshotted, nudged a few pixels, tapped
    // again… burning whole rounds and never landing on a small hit target. One
    // tap per analysis; re-derive before the next tap.
    if (
      isCoordinateTapTool(name) &&
      !this.tapCredit &&
      this.blocks["blind-tap"] < this.maxBlocks
    ) {
      this.blocks["blind-tap"] += 1;
      return { kind: "block", reason: "blind-tap", message: this.blindTapMessage(name) };
    }

    // --- 3. FRESHNESS: never photograph stale bytes. ----------------------
    const surface = callSurface(name, args);
    if ((capture || inspect) && !this.isFresh(surface) && this.blocks.stale < this.maxBlocks) {
      this.blocks.stale += 1;
      return { kind: "block", reason: "stale", message: this.staleMessage(name, this.lastKnownLaunch) };
    }

    return { kind: "allow" };
  }

  /**
   * The ASYNC half of the gate: is the device this call names real, and is it
   * the right kind of surface to run this project on?
   *
   * Separate from {@link check} because it needs to know what is booted, which
   * is I/O. Kept on the same object so a run has one place that owns "getting
   * the app onto a screen", and so both halves share the stand-down counters.
   *
   * Silent for every call that names no device target, which is nearly all of
   * them. See `exec/device-target.ts` for the run these rules come from.
   */
  async checkDeviceTarget(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<QaDecision> {
    const command = isBashTool(name) && typeof args?.command === "string" ? args.command : undefined;
    const argDevice = typeof args?.device === "string" ? args.device : undefined;
    const flagDevice = command ? deviceTargetInCommand(command) : undefined;
    if (!argDevice && !flagDevice && !command) return { kind: "allow" };

    let devices: readonly LocalDevice[];
    try {
      devices = await this.listDevices();
    } catch {
      // The probe is best-effort. A machine we cannot enumerate is one we have
      // nothing to say about, and refusing on a failed probe would break runs
      // on every host without simctl/adb.
      return { kind: "allow" };
    }
    if (!devices.length) return { kind: "allow" };

    // The command that WOULD do the job, composed once: the project's own device
    // command with this booted device pinned onto it. Every refusal below hands
    // it back, because "that is wrong" without "this is right" is what left the
    // observed run inventing `flutter build apk`.
    const launch = this.launchFor(devices);

    if (command) {
      // Wrong surface first: `flutter run -d chrome` names a device target too,
      // and "chrome is not a booted device" would be a true but useless answer
      // to a call whose real problem is that it runs the app on the web.
      const surface = this.applyVerdict(
        checkRunSurface({
          command,
          devices,
          mobileProject: this.mobileProject,
          ...(launch ? { deviceCommand: launch } : {}),
        }),
      );
      if (surface) return surface;

      // Then: a build aimed at a platform nothing is booted for, or an
      // artifact-only build when the job is getting the app onto the screen.
      const build = this.applyVerdict(
        checkBuildTarget({
          command,
          devices,
          mobileProject: this.mobileProject,
          ...(launch ? { launch } : {}),
        }),
      );
      if (build) return build;
    }

    for (const [requested, via] of [
      [argDevice, "argument"],
      [flagDevice, "flag"],
    ] as const) {
      if (!requested) continue;
      const blocked = this.applyVerdict(checkDeviceId({ requested, devices, via }));
      if (blocked) return blocked;
    }
    return { kind: "allow" };
  }

  /**
   * The one command that builds, installs and launches this project on the
   * booted device — the project's OWN command with the device pinned, falling
   * back to the stack default only when the repo declares nothing.
   */
  private launchFor(devices: readonly LocalDevice[]): string | undefined {
    const device = devices[0];
    if (!device) return undefined;
    const composed = composeDeviceLaunch(this.deviceCommands, this.mobileStack, device.id, device.platform);
    // Cached so the SYNC freshness refusal can quote it too. That refusal runs
    // before any device probe (it must stay sync and cheap), so without this it
    // could only offer the project's command without a device pinned — which is
    // most of the way there, but not the line you can paste.
    if (composed) this.lastKnownLaunch = composed.command;
    return composed?.command;
  }

  /** The last composed launch, for the sync refusal. Undefined until a probe ran. */
  private lastKnownLaunch: string | undefined;

  /** The same, rendered with its provenance, for a message that must be trusted. */
  describeLaunch(devices: readonly LocalDevice[]): string | undefined {
    const device = devices[0];
    if (!device) return undefined;
    const composed = composeDeviceLaunch(this.deviceCommands, this.mobileStack, device.id, device.platform);
    return composed ? describeComposedLaunch(composed) : undefined;
  }

  /** Count a device-target verdict against its budget, or let it through. */
  private applyVerdict(verdict: DeviceTargetVerdict): QaDecision | undefined {
    if (verdict.kind !== "block") return undefined;
    // A mis-typed id is worth repeating: the correction is mechanical, and the
    // alternative — letting the run decide the device is unreachable — is how
    // one dropped character ended a run. The judgement rules keep the tighter
    // budget, where repeating a refusal the model disagrees with is the risk.
    const budget = verdict.reason === "unknown-device" ? this.maxBlocks * 3 : this.maxBlocks;
    if (this.blocks[verdict.reason] >= budget) return undefined;
    this.blocks[verdict.reason] += 1;
    return { kind: "block", reason: verdict.reason, message: verdict.message };
  }

  /**
   * The blind-tap refusal. Teaches the exact loop the user asked for: screenshot
   * → read the position off it → convert pixels to logical coords → tap the
   * REPORTED center once — and the exits when the target is not tappable that
   * way (scroll, deep link, ask), so the rule cannot become a tap-retry loop
   * of its own.
   */
  private blindTapMessage(name: string): string {
    return [
      `\`${name}\` with coordinates you have not derived from a capture. A precise x/y is a claim you KNOW ` +
        `where the element is — and nudging a few pixels between taps is guessing, not navigating.`,
      ``,
      `Do not compute coordinates at all — DESCRIBE the target instead:`,
      `  \`mobile { action: "tap", target: "<describe what to tap>" }\``,
      ``,
      `That one call captures the screen, reads the UI tree, and fuses them: the visual estimate decides ` +
        `WHICH control is meant and the tree supplies its exact coordinates. It covers labelled controls, ` +
        `icon-only ones with no label, and custom-drawn UI with no tree at all — then confirms the screen ` +
        `actually changed.`,
      ``,
      `If you must pass coordinates, they have to be READ, never estimated: \`mobile { action: "look" }\` ` +
        `returns every element with a \`center\` already in LOGICAL POINTS. Tap that centre verbatim and do ` +
        `NOT scale it by anything.`,
      ``,
      `If the element is not visible, scroll (\`mobile { action: "swipe", to: "up" }\`) or open its deep ` +
        `link (\`action: "open"\`). If it needs a value only the user knows — \`ask_user_question\` instead ` +
        `of tapping again.`,
    ].join("\n");
  }

  /**
   * The refusal text. Only the DEVICE surface can reach here (see `isFresh`), so
   * there is one message and it is specific: the app on the screen is the old
   * build, and here is the project's own command that replaces it.
   */
  private staleMessage(name: string, launch?: string): string {
    const changed = this.stalePaths();
    const changedLine = changed.length
      ? `Changed since the last deploy: ${changed.slice(0, 5).map((p) => `\`${p}\``).join(", ")}${changed.length > 5 ? `, +${changed.length - 5} more` : ""}.`
      : `You have edited code since the app was last put on the device.`;
    return [
      `Not yet — the app on the device is the OLD build. \`${name}\` would capture the code as it was ` +
        `BEFORE your change, which verifies nothing.`,
      changedLine,
      ``,
      launch
        ? `Editing a file does not change an app that is already installed. Run THIS, exactly — it builds, ` +
          `installs and launches in one step, so there is no artifact path to guess: ${launch}`
        : `Editing a file does not change an app that is already installed. Build, install and launch it ` +
          `first: ${quoteCommands(this.deviceCommands, "the project's own run command — the one that BUILDS, INSTALLS AND LAUNCHES on a device, NOT a build/assemble/archive task, which produces an artifact and installs nothing")}.`,
      `Run it through \`bash\` with \`background: true, waitMs: 300000\` (the call listens for the outcome) — a cold first build ` +
        `takes minutes, so do not shorten \`timeoutMs\` and do not read a slow build as a failure. ` +
        `(A dev runner already attached from earlier in this run can be FULL-restarted instead; a hot ` +
        `reload is not always enough.)`,
      ``,
      `Then capture. If the build fails, fix the build — do not fall back to screenshotting the old app.`,
    ].join("\n");
  }

  /**
   * Feed every completed call back in. This is what moves the gate's state:
   * writes open a freshness debt, deploys close it, and questions/progress reset
   * the stuck counter.
   */
  observe(
    rawName: string,
    args: Record<string, unknown> | undefined,
    isError: boolean,
    _details?: Record<string, unknown>,
  ): void {
    if (isError) return;
    const name = effectiveName(rawName, args);

    // A probe-only edit is not a change to the app's behaviour, so it opens no
    // freshness debt — the same exemption the reproduce gate makes, and for the
    // same reason: instrumentation is scaffolding the run is about to strip.
    if (isMutationTool(name) && !instrumentationTarget(name, args)) {
      const p = typeof args?.path === "string" ? args.path : "";
      this.lastWriteAt = ++this.tick;
      if (p) this.pendingWrites.add(p);
      this.resetStreak();
      return;
    }

    if (isBashTool(name)) {
      const command = typeof args?.command === "string" ? args.command : "";
      const kind = command ? deployKind(command) : null;
      if (kind === "device") {
        this.deviceDeployAt = ++this.tick;
        this.pendingWrites.clear();
        this.resetStreak();
      } else if (kind === "web") {
        // A dev server start is not a device deploy and the freshness rule does
        // not gate the browser (see `isFresh`) — but it IS progress, so it clears
        // the stuck counter rather than counting toward a run going in circles.
        this.resetStreak();
      }
      return;
    }

    // `activity_trace_start { startCommand }` boots the app inside the trace
    // session. When the start command launches ONTO A DEVICE (e.g. `flutter run`,
    // the same patterns the bash branch above classifies), that is a real deploy:
    // the binary the device is now running includes the pending writes, so the
    // freshness debt is paid. A web dev-server start is not a device deploy and
    // the freshness rule does not gate the browser (see `isFresh`) — it only
    // clears the stuck counter, as before.
    if (
      (name === "activity_trace_start" || name.endsWith("__activity_trace_start")) &&
      typeof args?.startCommand === "string" &&
      args.startCommand.trim()
    ) {
      const kind = deployKind(args.startCommand);
      if (kind === "device") {
        this.deviceDeployAt = ++this.tick;
        this.pendingWrites.clear();
      }
      this.resetStreak();
      return;
    }

    if (matches(name, INSTALL_TOOLS)) {
      this.deviceDeployAt = ++this.tick;
      this.pendingWrites.clear();
      this.resetStreak();
      return;
    }

    // Asking the user IS the way forward, so it clears the stuck counter — the
    // run is no longer going in circles once a real answer is on the way.
    if (isAskTool(name)) {
      this.resetStreak();
      return;
    }

    if (isCaptureTool(name) || isDriveTool(name) || isInspectTool(name)) {
      this.driveStreak += 1;
    }

    // Tap credit: an analysis that can yield positions (`activity_inspect`,
    // `media_analysis`) earns ONE coordinate tap; the tap spends it. A raw
    // screenshot deliberately does not — looking is not the same as reading a
    // position off the image, and the nudge loop this rule exists to kill
    // screenshotted between every miss.
    if (isInspectTool(name) || matches(name, POSITION_ANALYSIS_TOOLS)) {
      this.tapCredit = true;
    } else if (isCoordinateTapTool(name)) {
      this.tapCredit = false;
    }
  }

  private resetStreak(): void {
    this.driveStreak = 0;
    this.stuckNotified = false;
  }

  /**
   * The stuck nudge, or null. Fires ONCE per streak, after enough capture/drive
   * calls with nothing to show for them — the shape of a run stuck behind a
   * login, a form it cannot fill, or a screen it cannot reach.
   *
   * Deliberately a nudge and not a refusal: the model may be three taps from the
   * target, and refusing the fourth would strand it. What it needs is the
   * reminder that a wall is a question, not a puzzle.
   */
  stuckNote(): string | null {
    if (this.stuckNotified || this.driveStreak < this.stuckAfter) return null;
    this.stuckNotified = true;
    return [
      `STUCK CHECK — you have driven or captured the surface ${this.driveStreak} times without getting ` +
        `anywhere: nothing was written, nothing was rebuilt, and you have not asked the user anything.`,
      `If something on the screen is blocking you — a login, a signup, an OTP / 2FA, a form field whose ` +
        `value only the user knows, a file to upload, a paywall, a permission or role wall, a record that ` +
        `does not exist in this environment — STOP driving and call \`ask_user_question\` NOW.`,
      `Say exactly which screen you are on and exactly what you need. The user can reply with the value, ` +
        `OR ATTACH the file (credentials, a token or cookie, the document to upload, a screenshot of the ` +
        `expected state) in the input box, OR do that one step themselves and tell you to continue — and ` +
        `you resume from where you stopped.`,
      `Asking one focused question is the correct move here, not a failure. Repeating the same tap is.`,
    ].join("\n");
  }

  /** Counts for logging/tests. */
  stats(): { scopeBlocks: number; staleBlocks: number; driveStreak: number } {
    return { scopeBlocks: this.blocks.scope, staleBlocks: this.blocks.stale, driveStreak: this.driveStreak };
  }
}
