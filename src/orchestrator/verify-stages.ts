/**
 * The staged verify flow: build → instrument → run/wait → inspect → decide.
 *
 * The old verify round handed the model ONE message that named every route at
 * once (screenshot it, instrument it, curl it, declare it) and let the model
 * pick. A disoriented model picks badly — most often it re-reads the file, or
 * drives a UI it cannot navigate, and never produces a check. Real runs burned
 * whole budgets that way and shipped changes nobody observed.
 *
 * This module turns the round into a SEQUENCE. Each round the orchestrator asks
 * the tracker which single stage the outstanding gaps are owed, and this builds
 * the focused message for THAT stage. The model is never told everything and
 * asked to choose; it is told the next step. The spine is the same for every
 * kind of runtime change:
 *
 *   build (rebuild + install) → instrument (add_log) → run/wait
 *   → inspect (collect/study ± visual) → decide
 *
 * Logs are the backbone for VISUAL changes too, not only logic: the trace is
 * how you reason about what the app did, and it is the fallback when a screen is
 * hard to reach (auth, deep links, seeded data the agent cannot reproduce). The
 * visual capture is a complement at the INSPECT stage, never a substitute for
 * the trace. Endpoint-only changes have no line to probe, so they skip
 * instrument and go straight to RUN (`curl`).
 *
 * The handoff ({@link RunHandoffResult}) decides who runs the app, which decides
 * what "run/wait" means: in AGENT mode the model runs the app and
 * `activity_collect { waitMs }` polls the trace; in USER mode the orchestrator
 * waits for the user to run the app and drop evidence, and the model's next step
 * is INSPECT (read what was supplied). That gives one backbone across all three
 * run shapes — individual QA (user-run), debugging (reproduce-first), and
 * development (build then verify).
 *
 * The message slices here are also composed into a full combined message
 * ({@link buildFullVerificationMessage}) for the legacy test seam — the slices
 * are the single source, so the combined form cannot drift from the staged one.
 */
import type { VerificationGap } from "./verification-gate.js";
import type { RunHandoffResult } from "./run-handoff.js";
import {
  describeDeviceLaunch,
  describeDevServerStart,
  type ProjectRunCommand,
} from "../exec/run-commands.js";

/** The five stages a verify round can be in. */
export type VerifyStage = "build" | "instrument" | "run" | "inspect" | "decide";

/** Everything a stage message needs, mirroring the legacy verify-message args. */
export interface VerifyStageContext {
  gaps: VerificationGap[];
  handoff: RunHandoffResult;
  /** 0-based round index. */
  round: number;
  maxRounds: number;
  /** Device-launch commands read from the project's own files, if any. */
  deviceCommands?: ProjectRunCommand[];
  /** Dev-server commands read from the project's own files, if any. */
  webCommands?: ProjectRunCommand[];
  /**
   * True for a QA run — verifying EXISTING behaviour with no change requested.
   * Changes the instrument wording (observe, do not modify source) and the
   * decide wording (report a verdict, do not fix).
   */
  qa?: boolean;
  /**
   * True for a bug-fix run — the spine doubles as the debugging loop, so the
   * run/inspect/decide wording leans on the trace (reproduce, collect, study)
   * and DECIDE carries the fix-or-revert contract.
   */
  isBugFix?: boolean;
  /**
   * Set when the previous round ended with an explicit FAIL verdict: the round's
   * message gets a repair preamble that authorizes `edit`/`write` and restarts
   * the spine at BUILD once the fix lands.
   */
  failureReasons?: string[];
}

/** True when any outstanding gap needs the app on a screen. */
function needsScreen(gaps: VerificationGap[]): boolean {
  return gaps.some((g) => g.method === "visual");
}

/** Render the gap list (path + method + diff excerpt) the way both forms share it. */
function gapList(gaps: VerificationGap[]): string[] {
  const lines: string[] = [];
  for (const gap of gaps) {
    lines.push(`- ${gap.path} — method: ${gap.method}`);
    if (gap.diffExcerpt) {
      lines.push(`    changed:`);
      for (const dl of gap.diffExcerpt.split("\n")) lines.push(`      ${dl}`);
    }
  }
  return lines;
}

/**
 * The body for ONE stage — no header, no gap list. Shared between the focused
 * per-stage message and the combined legacy message so they cannot diverge.
 */
function stageSlice(stage: VerifyStage, ctx: VerifyStageContext): string {
  switch (stage) {
    case "build":
      return buildSlice(ctx);
    case "instrument":
      return instrumentSlice(ctx);
    case "run":
      return runSlice(ctx);
    case "inspect":
      return inspectSlice(ctx);
    case "decide":
      return decideSlice(ctx);
  }
}

function buildSlice(ctx: VerifyStageContext): string {
  const lines: string[] = [];
  lines.push(
    "BUILD — get the change onto the surface that will be verified. An edit on disk changes NOTHING that is " +
      "already running: the app on the device/screen/server is the OLD code until you rebuild, and capturing it " +
      "would verify the wrong bytes.",
  );
  if (ctx.handoff.surfaces.mobile) {
    lines.push(describeDeviceLaunch(ctx.deviceCommands ?? []));
    lines.push(
      "Rebuild AND install on the device/simulator with the project's own command above (`-d <device>`), then " +
      "launch it. An artifact-only task (`flutter build`, `gradlew assemble`, `xcodebuild archive`) installs " +
      "NOTHING — the launch command is what puts the new code on the screen. Do NOT run a mobile app in a " +
      "browser (`-d chrome`): that is the wrong surface and usually fails or hangs.",
    );
  } else if (needsScreen(ctx.gaps)) {
    lines.push(describeDevServerStart(ctx.webCommands ?? []));
    lines.push(
      "Start (or hot-restart) the dev server so the running page carries the edit — on web the dev server " +
      "hot-reloads, but HARD-REFRESH the page afterwards so the capture is not of a stale render.",
    );
  } else {
    lines.push(
      "Run the project's OWN build/typecheck via `bash` (`npx tsc --noEmit`, `npm run build`… find the command " +
      "from the manifest) and fix what it reports before any runtime check.",
    );
  }
  lines.push(
    "WAIT FOR THE BUILD — by LISTENING, not by polling. Start it with `bash { background: true, waitMs: 300000 }`: " +
      "the call watches the output and returns on the outcome — ready, failed, exited (code 0 = success), or " +
      "settled (line-quiet). A cold first build takes minutes; do NOT sleep or tail-poll, and do not read slow " +
      "as failed. A build that FAILS is the finding: fix it (`edit`/`write`) and re-run it. THIS IS ENFORCED on " +
      "a device: a capture attempted before a build+install lands is REFUSED.",
  );
  if (ctx.isBugFix) {
    lines.push(
      "This is a bug-fix run: the rebuilt app must contain the FIX, and the probes you added (or are about to " +
      "add) must emit from the FIXED binary — a trace from the pre-fix build proves nothing either way.",
    );
  }
  lines.push(
    "LAUNCH THROUGH THE TRACE so logs and screen are collected SIMULTANEOUSLY: run the launch command via " +
      "`activity_trace_start { startCommand }` — the trace session is live from the first frame, the probes " +
      "emit while you drive, and `activity_collect` + `activity_inspect` read the SAME pass at INSPECT. Do not " +
      "build, verify visually, and only then instrument and re-run — that is two passes for one check.",
  );
  lines.push(
    "ORDER: a green build is NOT a capture and NOT verification — it only makes verification possible. Once the " +
      "build has landed and the trace is live, move on to RUN.",
  );
  return lines.join("\n");
}

function instrumentSlice(ctx: VerifyStageContext): string {
  const agent = ctx.handoff.mode === "agent";
  const qa = ctx.qa === true;
  const lines: string[] = [];
  if (qa) {
    lines.push(
      "OBSERVE THE TARGET BEHAVIOUR (this is QA — verify what exists, do NOT modify the user's source).",
    );
    lines.push(
      "If the target has RUNTIME behaviour, add logs first: `activity_trace_start` (a traceId + the `TURING_TRACE` " +
        "log convention) then `add_log` on the lines that produce the behaviour you are verifying. Probes are not " +
        "source changes and are stripped automatically.",
    );
    lines.push(
      "If the check is STATIC (does the build/lint/typecheck pass? do the tests pass?), run it directly with " +
        "`bash` and skip probing — there is nothing to trace.",
    );
    lines.push(
      agent
        ? "Once observation is set up, move on to RUN."
        : "Once observation is set up, STOP. Tell the user to run the app and exercise the target; capture is " +
          "armed — do NOT drive the app yourself. The run waits for the user, then INSPECT.",
    );
    lines.push(
      "ORDER: do NOT `activity_cleanup` or `remove_log {all:true}` yet — stripping happens at DECIDE, after a " +
        "capture, and the runner will REFUSE an early strip. And do NOT declare the target verified/done before " +
        "you have RUN it and read what it did.",
    );
    return lines.join("\n");
  }
  lines.push(
    "INSTRUMENT — get evidence by LOGGING what the changed code actually does, before you judge it.",
  );
  lines.push(
    "  1. `activity_trace_start` → returns a traceId + the `TURING_TRACE` log convention (pass `startCommand` " +
      "to boot a dev server in the same call).",
  );
  lines.push(
    "  2. `add_log` on the EXACT changed lines of each runtime file above — same shape as `edit`, but it only " +
      "inserts a `TURING_TRACE …` line and never counts as a code change. Probe the value the change produced " +
      "and the branch it took, including the one you expect NOT to fire.",
  );
  lines.push(
    "Logs are the backbone for EVERY runtime change, VISUAL INCLUDED: the trace is how you reason about what " +
      "the app did, and it is the fallback when a screen is hard to reach (auth, deep links, seeded data you " +
      "cannot reproduce). An endpoint-only change has no line to probe — skip to RUN and `curl`.",
  );
  lines.push(
    "A change that is genuinely trivial (a generated fixture, pure config with no runtime behaviour) may " +
      "instead `DECLARE { path, tier:\"static\", method:\"none\", reason }` — but a UI change is not that.",
  );
  lines.push(
    agent
      ? "Once every runtime gap above is probed, move on to RUN."
      : "Once every runtime gap above is probed, STOP. Tell the user to run the app and exercise the changed " +
        "path; capture is armed — do NOT drive the app yourself. The run will wait for the user, then INSPECT.",
  );
  lines.push(
    "ORDER: do NOT `activity_cleanup` or `remove_log {all:true}` yet — stripping happens at DECIDE, after a " +
      "capture, and the runner will REFUSE an early strip (a single `remove_log {logId}` to reposition a probe " +
      "is fine). And do NOT declare the change verified/done before you have RUN it and read what it did.",
  );
  return lines.join("\n");
}

function runSlice(ctx: VerifyStageContext): string {
  const agent = ctx.handoff.mode === "agent";
  const lines: string[] = [];
  if (agent) {
    lines.push("RUN — exercise the changed path and read what the probes recorded.");
    if (ctx.handoff.surfaces.mobile && needsScreen(ctx.gaps)) {
      lines.push(describeDeviceLaunch(ctx.deviceCommands ?? []));
      // Pin the target: a mobile app is NOT a web page. This is the exact
      // shortcut that sank a real run — the model ran `flutter run -d chrome`
      // (web) for a Flutter mobile app, which either failed or captured the
      // wrong surface, and it concluded the app could not be verified.
      lines.push(
        "This is a MOBILE app: run it on the DEVICE or SIMULATOR with the command above (`-d <device>`). Do NOT " +
          "run it on a browser (`-d chrome` / `--web-port` / web mode) — a mobile app is not a web page, a browser " +
          "capture of it is the wrong surface, and a web run of a mobile project usually fails or hangs.",
      );
    }
    if (needsScreen(ctx.gaps) && !ctx.handoff.surfaces.mobile) {
      lines.push(describeDevServerStart(ctx.webCommands ?? []));
    }
    lines.push(
      "THE RUNNING APP MUST CONTAIN YOUR CHANGE. A code edit does nothing to an app already on the device/screen " +
        "from a previous run — capturing that stale instance verifies the OLD code, not your change. So: rebuild " +
        "+ reinstall (the launch command above does this), or — if the app runner / dev server is ALREADY " +
        "attached from earlier in the run — HOT-RESTART it so it picks up the edit (send a FULL restart to the " +
        "run console, not just a hot-reload; on web the dev server hot-reloads, but hard-refresh the page). Do " +
        "NOT just foreground an already-installed app and screenshot it. THIS IS ENFORCED on a device: a " +
        "capture attempted before a build+install lands is REFUSED, and the refusal quotes the project's own " +
        "launch command back at you.",
    );
    lines.push(
      "WAIT FOR THE BUILD — by LISTENING, not by polling. `bash { background: true, waitMs: 300000 }` returns " +
        "on the outcome: ready, failed, exited (code 0 = success), or settled (line-quiet). A cold first build " +
        "takes minutes; do NOT sleep or tail-poll, and do not read slow as failed. A build that FAILS is the " +
        "finding: fix it and re-run it. Falling back to the previously-installed app is not a fallback, it is a " +
        "wrong answer. And an artifact-only task (`flutter build`, `gradlew assemble`, `xcodebuild archive`) " +
        "installs NOTHING — it cannot make the app on the screen current.",
    );
    lines.push(
      "EXERCISE the changed path, then `activity_collect { traceId, waitMs }` — it polls the trace file until " +
        "the probes emit. Run the project's OWN build/typecheck/tests via `bash` (`npx tsc --noEmit`, " +
        "`npm test`… find the command from the manifest) as well — but do not stop at green: a passing test " +
        "suite says nothing broke, which is not the same as saying your change works.",
    );
    lines.push(
      "Endpoint change → call it for real with `bash` (curl) and read the actual response body and status, " +
        "including the error/empty cases, not just the happy path. A change that spans BOTH — an API plus the " +
        "screen that renders it — owes both checks, API first: what the endpoint actually returned is what " +
        "explains the screen, and a screen that looks right on defaulted or cached data is a bug you are " +
        "about to call verified.",
    );
    lines.push(
      `WHO RUNS THE APP: you (the agent). ${ctx.handoff.surfaces.browser ? "A browser MCP is connected. " : ""}` +
        `${ctx.handoff.surfaces.mobile ? "A device is available. " : ""}Start/drive the app and capture it directly.`,
    );
    lines.push(
      "STUCK ON A SCREEN OR AN INPUT? While driving Playwright / the mobile_* toolkit, or calling an endpoint (curl), if " +
        "you hit something you cannot get past — a login, a form field, a file upload, a captcha / 2FA, an auth " +
        "or role wall, a value only the user knows — STOP and use `ask_user_question`. The user can reply with " +
        "the value OR ATTACH it in the input box (the file to upload, credentials, a cookie / token, a " +
        "screenshot of the expected state), then you continue from where you stopped. Do NOT guess credentials " +
        "or invent inputs, and do NOT loop on the same screen. Asking one focused question is the correct way " +
        "forward, not a failure.",
    );
    lines.push(
      "ORDER: a green build/analyzer is NOT a capture and is NOT verification. Do NOT declare the change " +
        "verified/done, and do NOT `activity_cleanup` until you have a real capture in hand (the runner refuses " +
        "an early strip). Capture first, reason at INSPECT, verdict at DECIDE.",
    );
  } else {
    // USER mode: the orchestrator waits for the user to run the app between
    // INSTRUMENT and INSPECT. There is nothing for the model to drive here —
    // its job after the wait is to READ what the user supplied.
    lines.push("WHO RUNS THE APP: the user. The run waits while they run it.");
    if (ctx.handoff.evidenceDir) lines.push(`Evidence is dropped at ${ctx.handoff.evidenceDir}.`);
    if (ctx.handoff.userEvidencePath) {
      lines.push(`The user named ${ctx.handoff.userEvidencePath} as their evidence.`);
    }
    lines.push(
      "Do not drive the app. Once the user has run it, move on to INSPECT and read what they supplied.",
    );
  }
  return lines.join("\n");
}

function inspectSlice(_ctx: VerifyStageContext): string {
  const lines: string[] = [];
  lines.push(
    "INSPECT — reason over what you captured. Read where the trail STOPS, not where the code reads like it should.",
  );
  lines.push(
    "  - `activity_collect` / `activity_study` the trace: the values the probes emitted, in order.",
  );
  lines.push(
    "  - For a VISUAL gap, `activity_inspect` IS the QA — ONE call with `expected: \"<the exact thing you " +
      "built>\"`. It drives the surface, captures AND judges (VERDICT: PASS/FAIL) in one call. Do NOT also " +
      "drive the UI with raw browser/mobile tools and screenshot + `media_analysis` — that is the same check " +
      "a second time. (Only if you captured with a raw screenshot tool instead do you still owe a " +
      "`media_analysis lens:\"qa\"`.)",
  );
  lines.push(
    "  - COMPARE AGAINST THE RIGHT IMAGE. Replicating a design the user attached → the capture is compared " +
      "against THAT image, and `activity_inspect` NAMES the file it compared against on the first line of its " +
      "result. READ that line: if it named the wrong image (an informational screenshot, another screen's " +
      "mockup), pass `reference: \"<the right path>\"` and run it again — a verdict against the wrong " +
      "reference is confidently wrong, which is worse than no verdict. Fixing a reported visual bug → " +
      "compare against the BROKEN capture you took before editing. Neither → `expected` alone.",
  );
  lines.push(
    "  - AND READ THE TRACE, not just the screen. `activity_collect { traceId, waitMs }` tells you whether the " +
      "DATA behind the screen actually flowed — which values arrived, which branch ran, where the trail " +
      "stops. A screen that renders correctly on stale, cached or defaulted data passes a visual check and is " +
      "still broken.",
  );
  lines.push(
    "BUILD MUST BE READY FIRST: do not call `activity_inspect` until the build from RUN has COMPLETED and the " +
      "app is running the new code. Inspecting a build that is still compiling, or a stale already-running " +
      "instance, captures the OLD screen and verifies nothing — if you are not sure the new code is live, go " +
      "back and rebuild / hot-restart before capturing.",
  );
  lines.push(
    "Match what you see against what you intended. If it is wrong, FIX it (an `edit` re-opens that file's " +
      "evidence — you re-INSTRUMENT and re-RUN afterwards), then re-check. A fix nobody re-checked is a hypothesis.",
  );
  return lines.join("\n");
}

function decideSlice(ctx: VerifyStageContext): string {
  const qa = ctx.qa === true;
  const lines: string[] = [];
  if (qa) {
    lines.push("DECIDE — report a verdict on the target behaviour, then strip your probes. Do not leave it open.");
    lines.push(
      "  - PASS: the evidence shows the behaviour works as expected. Say so and cite the line/value/screen that " +
        "proved it.",
    );
    lines.push(
      "  - FAIL: the evidence shows a problem. DESCRIBE it precisely (what you observed vs what you expected, " +
        "the steps, the file/line) so it can be fixed. This is QA — do NOT edit the code yourself unless the " +
        "user explicitly asked for a fix; report the finding.",
    );
    lines.push(
      "Then remove every probe you added (`remove_log { all: true }` or `activity_cleanup`). Debug logging left " +
        "in the user's source is a defect.",
    );
    return lines.join("\n");
  }
  lines.push("DECIDE — commit a verdict per file, then strip your probes. Do not leave the run without one.");
  lines.push(
    "  - VERIFIED: the evidence shows the change works. Say so and cite the line/value that proved it.",
  );
  lines.push(
    "  - FAIL: the evidence shows it does NOT work. Fix it (`edit`/`write`) and re-verify — the spine restarts " +
      "at BUILD so the running app picks up the fix, then re-probe, re-run, re-inspect.",
  );
  lines.push(
    "  - FAIL only on INTENDED states or the unverifiable — a button disabled until input is typed, a font " +
      "weight pixels cannot measure? The analyst sees pixels, not code; it cannot know the state is intended. " +
      "NOT a fix loop: re-run `activity_inspect` ONCE with an `expected` that states those states explicitly " +
      "(`\"Confirm disabled until the email is typed\"`); if it still fails only on those, adjudicate — " +
      "`DECLARE { path, method:\"none\", reason:\"capture judged; FAIL items intended/unverifiable: <quote them>\" }`. " +
      "Do not rebuild for a failure that is the app working.",
  );
  if (ctx.isBugFix) {
    lines.push(
      "  - Bug-fix contract: FIXED → strip every probe (`remove_log { all: true }` / `activity_cleanup`) and " +
        "cite the trace line that shows the reported behaviour is gone. NOT FIXED after this round → REPRODUCE " +
        "the reported path (capture a baseline if you have not), revert the attempted fix (or keep the probes), " +
        "form the next hypothesis from `activity_study`, and edit again — the spine restarts at BUILD either way.",
    );
  }
  lines.push(
    "  - A file that legitimately needs no runtime check: `DECLARE { path, tier:\"static\", method:\"none\", reason }`.",
  );
  lines.push(
    "Then remove every probe you added: `remove_log { all: true }` (or a single group by `logId`), or " +
      "`activity_cleanup` to end the trace session as well. Debug logging left in the user's source is a " +
      "defect, and the runner re-scans for it.",
  );
  return lines.join("\n");
}

/**
 * The header line. Non-QA keeps the literal `VERIFY WHAT YOU WROTE` anchor
 * (tests/hosts detect the verify turn by it); QA — where nothing was written —
 * uses `VERIFY THE REQUESTED BEHAVIOUR` so the wording fits, and flags that the
 * run is observe-only.
 */
function headerLine(
  stage: VerifyStage | "all",
  round: number,
  maxRounds: number,
  qa = false,
): string {
  const label = stage === "all" ? `round ${round + 1} of ${maxRounds}` : `${stage.toUpperCase()} stage, round ${round + 1} of ${maxRounds}`;
  if (qa) {
    return (
      `VERIFY THE REQUESTED BEHAVIOUR — ${label}. QA: observe the target and report a pass/fail verdict; ` +
      `do NOT edit the user's source. Reading the source is NOT a check — run it and read what it did.`
    );
  }
  return (
    `VERIFY WHAT YOU WROTE — ${label}. The work is done but these files still need a real check before the ` +
    `run can finish. Reading the source is NOT a check (the write already proved the bytes landed).`
  );
}

/**
 * The focused message for ONE verify stage. This is what the orchestrator sends
 * a round — the model is told the next step, not every route at once.
 */
export function buildStageMessage(stage: VerifyStage, ctx: VerifyStageContext): string {
  const parts: string[] = [
    headerLine(stage, ctx.round, ctx.maxRounds, ctx.qa === true),
    "",
    ...gapList(ctx.gaps),
    "",
  ];
  // A round that follows an explicit FAIL is a REPAIR round: the model is told
  // what failed, authorized to edit, and told where the spine restarts. Without
  // this framing a FAIL tended to end the attempt instead of looping back.
  if (ctx.failureReasons && ctx.failureReasons.length > 0) {
    parts.push(
      "REPAIR — the previous round ended VERDICT: FAIL. The change is NOT verified. What failed:",
    );
    for (const r of ctx.failureReasons.slice(0, 6)) parts.push(`  - ${r}`);
    parts.push(
      "Fix it: `edit`/`write` the file(s) above, then the spine RESTARTS at BUILD — rebuild/restart so the " +
        "running app contains the fix, re-probe, re-run, re-inspect. Do not repeat the same steps that failed; " +
        "if the blocker is an input/credential/screen you cannot pass, use `ask_user_question`.",
    );
    parts.push(
      "But if EVERY failing item is intended app behavior the verdict could not know (a state — a disabled " +
        "button, an empty list — that the code shows on purpose) or NOT VERIFIABLE from a capture, a rebuild " +
        "reproduces the same FAIL forever. Do not rebuild: re-run `activity_inspect` once with an `expected` " +
        "that states those states explicitly; if it still fails only on those, adjudicate — " +
        "`DECLARE { path, method:\"none\", reason }` quoting each failing item and why it is intended or " +
        "unverifiable.",
    );
    parts.push("");
  }
  parts.push(stageSlice(stage, ctx));
  return parts.join("\n");
}

/**
 * The combined message (all five slices), kept as the legacy test seam so the
 * message's wiring is asserted in one place. Composed from the same slices as
 * the staged form, so the two cannot drift.
 */
export function buildFullVerificationMessage(ctx: VerifyStageContext): string {
  return [
    headerLine("all", ctx.round, ctx.maxRounds, ctx.qa === true),
    "",
    ...gapList(ctx.gaps),
    "",
    buildSlice(ctx),
    "",
    instrumentSlice(ctx),
    "",
    runSlice(ctx),
    "",
    inspectSlice(ctx),
    "",
    decideSlice(ctx),
  ].join("\n");
}

/**
 * Tracks how far the outstanding gaps have moved through the spine, fed by the
 * same loop hooks that feed the gates (`add_log` → instrumented; a capture tool
 * → captured; a real `edit` resets both for that path, because the bytes the
 * capture proved are gone). Pure state — no I/O, no model calls.
 *
 * The tracker does NOT duplicate the gate's notion of "satisfied": the
 * orchestrator still stops on `verificationGate.isSatisfied()`. This only picks
 * which STAGE the next round's message should target so the model is nudged
 * through instrument → run → inspect → decide instead of left to choose.
 */
export class VerifyStageTracker {
  private readonly instrumented = new Set<string>();
  private captured = false;
  private readonly mode: RunHandoffResult["mode"];
  private readonly qa: boolean;
  /** True when this project's verify spine owes a build step (mobile/desktop apps, dev servers). */
  private readonly buildRequired: boolean;
  /** True while a write has landed but no successful build/run of it has been observed. */
  private needsBuild = false;
  /** Reasons recorded by `noteFailure` — consumed into the next round's repair preamble. */
  private failureReasons: string[] = [];

  constructor(opts: {
    mode: RunHandoffResult["mode"];
    qa?: boolean;
    initialInstrumented?: Iterable<string>;
    /**
     * True when a write cannot reach the verified surface without an explicit
     * build/launch step (a mobile/desktop install, a dev-server (re)start).
     * Endpoint-only curl checks and static checks skip the BUILD stage.
     */
    buildRequired?: boolean;
  }) {
    this.mode = opts.mode;
    this.qa = opts.qa === true;
    this.buildRequired = opts.buildRequired === true;
    // Armed at construction: the writes landed in the work loops and nothing has
    // been observed RUNNING them yet, so the first runtime round owes a build.
    this.needsBuild = this.buildRequired;
    if (opts.initialInstrumented) for (const p of opts.initialInstrumented) this.instrumented.add(p);
  }

  /** A real (non-instrumentation) write resets that path, the global capture, and the build. */
  onWritten(path: string): void {
    this.instrumented.delete(path);
    this.captured = false;
    if (this.buildRequired) this.needsBuild = true;
  }

  /**
   * A successful build/launch of the current code was observed (a classified
   * build/run `bash` result, or `activity_trace_start` reporting the app ready).
   * Clears the BUILD debt until the next write.
   */
  onBuildOk(): void {
    this.needsBuild = false;
  }

  /**
   * Record an explicit verification FAIL (parsed from the round's VERDICT) so
   * the next round's message carries a repair preamble instead of repeating
   * the same stage instruction that just failed.
   */
  noteFailure(reasons: string[]): void {
    if (reasons.length) this.failureReasons = reasons.slice(0, 6);
  }

  /** Consume the recorded failure reasons (for the next round's message ctx). */
  takeFailure(): string[] {
    const out = this.failureReasons;
    this.failureReasons = [];
    return out;
  }

  /** A probe landed on a path (`add_log`). */
  onInstrumented(path: string): void {
    this.instrumented.add(path);
  }

  /** A capture/check tool ran (collect/inspect/study/media/tail/curl). */
  onCapture(): void {
    this.captured = true;
  }

  isCaptured(): boolean {
    return this.captured;
  }

  /** The stage the current round targets, set by the orchestrator each round. */
  private currentStage: VerifyStage | null = null;
  setCurrentStage(stage: VerifyStage): void {
    this.currentStage = stage;
  }

  /**
   * Enforce inspection ORDER at the tool level, not just the prompt. A premature
   * strip destroys the probes the model still needs to RUN the app and INSPECT
   * what it did — which is exactly how runs derail: the model instruments, then
   * immediately `activity_cleanup`s, then has nothing to capture and declares
   * done on the analyzer. Refuse `activity_cleanup` and `remove_log {all:true}`
   * until a capture exists (or DECIDE is reached — a run that could not verify
   * must still be allowed to clean up). A single `remove_log {logId}` is always
   * allowed, because repositioning a misplaced probe during INSTRUMENT is
   * legitimate (the prompt says so). Returns a redirect message, or null to allow.
   */
  blockPrematureStrip(toolName: string, args: unknown): string | null {
    if (this.captured || this.currentStage === "decide") return null;
    const isCleanup = toolName === "activity_cleanup" || toolName.endsWith("__activity_cleanup");
    const all = (args as { all?: unknown } | undefined | null)?.all === true;
    const isRemoveAll =
      (toolName === "remove_log" || toolName.endsWith("__remove_log")) && all;
    if (isCleanup || isRemoveAll) {
      return (
        "Not yet — you have not captured any evidence. `activity_cleanup` / `remove_log {all:true}` strip the " +
        "probes you need to RUN the app and INSPECT what it did; stripping belongs at the DECIDE stage, AFTER a " +
        "capture. Run the app and `activity_collect` / `activity_inspect` first. (A single `remove_log {logId}` " +
        "to reposition a misplaced probe is fine.)"
      );
    }
    return null;
  }

  /**
   * The mirror guard on the OTHER end of the spine: refuse a visual capture
   * while the INSTRUMENT stage is still owed. A real run opened a trace
   * session, added ZERO `add_log` probes, screenshot-verified the screen, then
   * `remove_log`/`activity_cleanup`'d probes that never existed — the LOG step
   * of the sequence was skipped end to end and nothing pushed back. This
   * refuses `activity_inspect` and raw screenshot tools until every runtime
   * gap path carries a probe (or the round advances past instrument). Escapes
   * stay open, so it cannot deadlock: DECLARE a static file, reach DECIDE (the
   * last round forces it), or let the round budget end the attempt honestly.
   */
  blockPrematureCapture(toolName: string): string | null {
    if (this.currentStage !== "instrument" || this.qa) return null;
    if (this.runtimeGapPaths.size === 0) return null;
    const isInspect = toolName === "activity_inspect" || toolName.endsWith("__activity_inspect");
    const isRawCapture =
      toolName === "browser_take_screenshot" ||
      toolName.endsWith("__browser_take_screenshot") ||
      toolName === "browser_snapshot" ||
      toolName.endsWith("__browser_snapshot");
    if (!isInspect && !isRawCapture) return null;
    const owed = [...this.runtimeGapPaths].filter((p) => !this.instrumented.has(p));
    if (owed.length === 0) return null;
    return (
      "Not yet — this round is the INSTRUMENT stage and these changed files still owe probes:\n" +
      owed.map((p) => `  - ${p}`).join("\n") +
      "\nA screenshot alone skipped exactly this step last time: open the trace (`activity_trace_start`), then " +
      "`add_log` on the changed lines of EACH file above, THEN capture. The trace is how you reason about what " +
      "the app did behind the screen — and your fallback when a screen is unreachable. (If a file genuinely " +
      "needs no runtime check, `DECLARE { path, tier:\"static\", method:\"none\", reason }`.)"
    );
  }

  /** True once ANY probe has landed (used by QA mode, which observes globally). */
  private get anyInstrumented(): boolean {
    return this.instrumented.size > 0;
  }

  /**
   * Runtime (visual/logic) gap paths for the current round — refreshed by
   * `stage()` each round, and the debt `blockPrematureCapture` collects on.
   */
  private runtimeGapPaths = new Set<string>();

  /** The stage the next round should target for the given gaps + round budget. */
  stage(ctx: { gaps: VerificationGap[]; round: number; maxRounds: number }): VerifyStage {
    // Last allowed round: force a commit rather than start a cycle that cannot finish.
    if (ctx.round >= ctx.maxRounds - 1) return "decide";
    this.runtimeGapPaths = new Set(
      ctx.gaps
        .filter((g) => g.method === "visual" || g.method === "logic")
        .map((g) => g.path),
    );
    if (this.qa) {
      // QA observes EXISTING behaviour — instrumentation is global (the target may
      // span files), and the spine is the same: observe → run/wait → inspect.
      if (this.captured) return "inspect";
      if (this.mode === "agent") {
        if (this.anyInstrumented || ctx.round > 0) return "run";
        return "instrument";
      }
      // USER mode: instrument once, then the orchestrator waits before INSPECT.
      if (this.anyInstrumented || ctx.round > 0) return "inspect";
      return "instrument";
    }
    // INSTRUMENT before BUILD — deliberately, and for simultaneity: probes are
    // source edits, so they must be IN the binary before it launches. Build
    // first and the probes arrive after the app is already running — the exact
    // "logs after the visual, one pass then another" waste this ordering kills.
    // The launch then happens through activity_trace_start, whose trace is live
    // from the first frame, so logs and screen land in ONE pass.
    const needsInstrument = ctx.gaps.some(
      (g) => (g.method === "visual" || g.method === "logic") && !this.instrumented.has(g.path),
    );
    if (needsInstrument) return "instrument";
    // BUILD next: get the (now-probed) writes onto the verified surface.
    // Agent mode only — in USER mode the user builds/runs the app themselves.
    // Endpoint-only gaps curl an already-running server and skip the build step.
    const runtimeGaps = ctx.gaps.some((g) => g.method === "visual" || g.method === "logic");
    if (this.needsBuild && runtimeGaps && this.mode === "agent") return "build";
    // Agent mode must run the app and collect; user mode's RUN is the
    // orchestrator's wait, so the model goes straight to INSPECT.
    if (this.mode === "agent" && !this.captured) return "run";
    return "inspect";
  }
}
