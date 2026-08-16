/**
 * The build → ask-who-runs-it → drive-or-wait handoff for verification.
 *
 * `DEBUGGING_LOOP` (phases/prompts.ts) settles "who runs the system" at the
 * start of a BUG-FIX run. This module does the same for the END of a run that
 * just wrote code: verifying a visual or endpoint change needs a running app,
 * and racing the agent to a port when the user already has one (with seeded
 * data, a device, credentials nobody can reproduce) wastes both attempts.
 *
 * The handoff fires ONLY when a written file declared `visual`/`endpoint`
 * (a running app is genuinely required). Pure-logic and static-file runs skip
 * the question entirely — pestering on a refactor is worse than not asking.
 *
 * Everything here is wrapped so any failure degrades to `{ mode: "skip" }`: the
 * run never fails over the handoff. The host that has no `askUserQuestion`
 * callback installed, or whose renderer cannot resolve a `single-select`, still
 * completes — with `verified: false` reported honestly, never a deadlock.
 */
import { hasLocalDevice } from "../devices/local-devices.js";
import type { Registry } from "../registry/registry.js";
import type { AskUserQuestionRequest,
  AskUserQuestionResult } from "../types.js";

/** The verified answer modes a surface-detection result can take. */
export interface Surfaces {
  browser: boolean;
  mobile: boolean;
}

/** What the run should do to obtain evidence. */
export type HandoffMode = "agent" | "user" | "skip";

/** Result of {@link coordinateRunHandoff}. */
export interface RunHandoffResult {
  mode: HandoffMode;
  surfaces: Surfaces;
  /** The run's evidence directory (may not exist if mode is "skip"). */
  evidenceDir?: string;
  /**
   * A path the user named when they chose to run the app themselves. The verify
   * loop treats `activity_tail_file`/`media_analysis file:<this>` as evidence.
   */
  userEvidencePath?: string;
}

/** Option labels the host renders for the handoff question. */
const OPTION_AGENT = "You drive it";
const OPTION_USER = "I'll run it myself";
const OPTION_SKIP = "Skip verification";

// Browser/device tool-name candidates. Mirrors activity-monitor.ts so the
// detection matches what `activity_inspect` itself can actually drive.
const BROWSER_TOOLS = [
  "browser_navigate",
  "playwright_navigate",
  "mcp__playwright__browser_navigate",
  "browser_take_screenshot",
  "mcp__playwright__browser_take_screenshot",
];
const MOBILE_TOOLS = [
  // `mobile` is the built-in toolkit's own registry name (mobilecli-backed);
  // the action-derived names cover a prefixed/bridged registration.
  "mobile",
  "mobile_devices",
  "mobile_launch_app",
];

/**
 * True for a free-text answer that looks like a file path the user pasted as
 * their evidence location (a log/screenshot they produced running the app).
 * Conservative: requires a path separator AND a trailing extension, so prose
 * like "I'll do it" or "skip" never matches.
 */
function looksLikePath(s: string): boolean {
  if (!/[\/\\]/.test(s)) return false;
  const ext = s.slice(s.lastIndexOf("."));
  return ext.length > 1 && ext.length <= 8 && /^\.log|^\.[a-z0-9]+$/i.test(ext);
}

/**
 * Detect which automation surfaces are connected, by tool name. The candidates
 * mirror `activity_inspect`'s own finders so a surface we report as available is
 * one the inspect tool can actually drive.
 */
export function detectSurfaces(registry: Registry | undefined): Surfaces {
  const surfaces: Surfaces = { browser: false, mobile: false };
  if (!registry) return surfaces;
  for (const name of BROWSER_TOOLS) {
    if (registry.getTool(name)) {
      surfaces.browser = true;
      break;
    }
  }
  for (const name of MOBILE_TOOLS) {
    if (registry.getTool(name)) {
      surfaces.mobile = true;
      break;
    }
  }
  return surfaces;
}

/**
 * True if a handoff is needed: at least one written path's verification method
 * requires a running app (visual or endpoint). Logic/static/none do not.
 */
export function needsRunningApp(methods: Array<string | undefined>): boolean {
  return methods.some((m) => m === "visual" || m === "endpoint");
}

export interface CoordinateRunHandoffInput {
  registry: Registry | undefined;
  /** The host callback, same shape the loop installs. */
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  /** Declared methods for the written paths, to decide if a handoff is needed. */
  declaredMethods: Array<string | undefined>;
  /** The run's evidence directory, for the user-driven path. */
  evidenceDir?: string;
  signal?: AbortSignal;
}

/**
 * Decide who runs the app for verification. Asks the user ONLY when a running
 * app is needed; otherwise returns `{ mode: "agent" }` silently (the verify
 * loop will use whatever surfaces/commands are available, and report honestly).
 *
 * The question uses `phase: "perfect"` — it must stay inside the host's typed
 * union (`'prepare'|'plan'|'perform'|'perfect'`) and the resolve-match key.
 */
export async function coordinateRunHandoff(
  input: CoordinateRunHandoffInput,
): Promise<RunHandoffResult> {
  const surfaces = detectSurfaces(input.registry);
  // A booted simulator/emulator is a mobile surface even without mobilecli —
  // `activity_inspect` drives it through simctl/adb. Reporting `mobile: false`
  // here would withhold the mobile guidance from the verify round on exactly
  // the setup that needs it most. Checked async (it shells out), which is why
  // it lives here rather than in the sync `detectSurfaces`.
  if (!surfaces.mobile && (await hasLocalDevice().catch(() => false))) {
    surfaces.mobile = true;
  }
  const base: RunHandoffResult = { mode: "agent", surfaces, ...(input.evidenceDir ? { evidenceDir: input.evidenceDir } : {}) };

  // No running app needed → no question. The verify loop runs checks directly.
  if (!needsRunningApp(input.declaredMethods)) return base;
  // No host callback → can't ask. Degrade: agent tries, rest reported unverified.
  if (!input.askUserQuestion) return { ...base, mode: "agent" };
  if (input.signal?.aborted) return { ...base, mode: "skip" };

  try {
    const canDrive = surfaces.browser || surfaces.mobile;
    const request: AskUserQuestionRequest = {
      phase: "perfect",
      kind: "clarification",
      question:
        "I need to verify the change against a running app. " +
        "Should I drive it, or will you run it and share the result?",
      reason:
        "Verifying a visual or endpoint change needs a running app. You may have " +
        "a dev server, seeded data, a device, or credentials I can't reproduce.",
      answerMode: "single-select",
      options: canDrive
        ? [OPTION_AGENT, OPTION_USER, OPTION_SKIP]
        : [OPTION_USER, OPTION_SKIP],
      choices: [
        ...(canDrive
          ? [{
              label: OPTION_AGENT,
              description: "I'll start/drive the app with the browser MCP or the device toolkit.",
              recommended: true,
            }]
          : []),
        {
          label: OPTION_USER,
          description: input.evidenceDir
            ? `Run it yourself and drop a log/screenshot at ${input.evidenceDir} (or paste the path).`
            : "Run it yourself and share what you see.",
        },
        { label: OPTION_SKIP, description: "Skip verification; I'll mark the change unverified." },
      ],
      allowFreeText: true,
    };
    // The callback may answer with files alongside the text; this handoff is a
    // single-select verdict, so only the prose matters here.
    const answer = await input.askUserQuestion(request);
    const normalized = (typeof answer === "string" ? answer : answer.text).trim();
    if (normalized === OPTION_SKIP || /skip/i.test(normalized)) {
      return { ...base, mode: "skip" };
    }
    // A free-text path the user pasted (their own log/screenshot location) is
    // user-driven evidence. Checked before the keyword branches so a bare path
    // like `/Users/me/app/debug.log` is captured, not defaulted to "agent".
    if (looksLikePath(normalized)) {
      return { ...base, mode: "user", userEvidencePath: normalized };
    }
    if (normalized === OPTION_USER || /^i[''"]?ll\b/i.test(normalized) || /\bmyself\b/i.test(normalized)) {
      return { ...base, mode: "user" };
    }
    // Default: the agent drives. Includes the explicit OPTION_AGENT pick and
    // any free-text that didn't parse as user/skip/path.
    return { ...base, mode: "agent" };
  } catch {
    // Host aborted or errored the question. Never fail the run over the handoff.
    return { ...base, mode: "skip" };
  }
}
