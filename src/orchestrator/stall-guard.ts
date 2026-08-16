/**
 * Stall detection for the tool loops.
 *
 * The loops are completion-driven: a loop ends when the model stops calling
 * tools, not when some step counter runs out. A fixed cap was the wrong control
 * — it cut real work mid-edit on big tasks while doing nothing about a model
 * that had actually gone in circles. So instead of counting steps we watch for
 * the two shapes a non-converging loop actually takes:
 *
 *   1. repetition — a turn whose tool calls are all ones this loop already made
 *      (same tool, same arguments), so the turn added no new information;
 *   2. failure    — a turn in which every tool call errored.
 *
 * Either shape earns a NUDGE first: the model is told what it is doing and asked
 * to change approach or wrap up. Only if the pattern persists across several
 * consecutive turns does the guard stop the loop, and it stops with a reason
 * that names the pattern rather than a budget number.
 */

/** The tool calls of one assistant turn, as seen by a loop. */
export interface StallGuardCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** The tool results produced for those calls. */
export interface StallGuardResult {
  toolCallId: string;
  isError?: boolean;
}

export type StallVerdict =
  | { kind: "continue" }
  /** Inject `note` as a user message, then keep going. */
  | { kind: "nudge"; note: string }
  /** End the loop with `reason` as its error. */
  | { kind: "stop"; reason: string };

export interface StallGuardOptions {
  /** Consecutive no-new-progress turns tolerated before stopping. Default 3. */
  stallTurns?: number;
  /** How many times `grantGrace()` may reprieve the loop. Default 2. */
  maxGraces?: number;
}

/** Prefix of the error a stalled loop ends with. */
export const LOOP_STALLED = "loop stalled";
/** Prefix of the error a loop ends with when a host-configured cap ran out. */
export const STEP_BUDGET_EXHAUSTED = "step budget exhausted";

/**
 * True for loop errors that mean "this loop stopped early", not "the run is
 * broken". They leave the step recorded as unfinished but must not abandon the
 * remaining steps of a plan the user approved.
 */
export function isNonFatalLoopError(error: string | undefined): boolean {
  if (!error) return false;
  return error.startsWith(LOOP_STALLED) || error.startsWith(STEP_BUDGET_EXHAUSTED);
}

export class StallGuard {
  /** Every `tool:args` signature this loop has already issued. */
  private readonly seen = new Set<string>();
  private repeatStreak = 0;
  private failureStreak = 0;
  private graces = 0;

  constructor(private readonly opts: StallGuardOptions = {}) {}

  /**
   * Reprieve the loop for one more attempt. Called when the loop has just handed
   * the model something NEW to act on — a bash fallback recipe for a tool that
   * kept failing — because stopping on the same turn as that advice would mean
   * the model never got to use it. Bounded (`maxGraces`, default 2) so advice
   * cannot become an infinite extension.
   */
  grantGrace(): boolean {
    if (this.graces >= (this.opts.maxGraces ?? 2)) return false;
    this.graces++;
    this.repeatStreak = 0;
    this.failureStreak = 0;
    return true;
  }

  /** Judge one completed turn. Call once per turn, after its tool results. */
  observe(calls: StallGuardCall[], results: StallGuardResult[]): StallVerdict {
    if (!calls.length) return { kind: "continue" };
    const stallTurns = this.opts.stallTurns ?? 3;

    const errorById = new Map(results.map((r) => [r.toolCallId, r.isError ?? false]));
    let novel = 0;
    let errored = 0;
    let repeated = 0;
    for (const call of calls) {
      const sig = `${call.name}:${canonicalArgs(call.arguments)}`;
      const isError = errorById.get(call.id) ?? false;
      const fresh = !this.seen.has(sig);
      this.seen.add(sig);
      if (isError) errored++;
      if (!fresh) repeated++;
      // Progress means a call that was both new AND worked. A fresh call that
      // errored teaches the model something, but it is not work done.
      if (fresh && !isError) novel++;
    }

    if (errored === calls.length) this.failureStreak++;
    else this.failureStreak = 0;
    if (novel > 0) this.repeatStreak = 0;
    else this.repeatStreak++;

    if (this.repeatStreak >= stallTurns) {
      // Both shapes are "no progress"; name the one that actually dominated so the
      // reason is diagnostic rather than generic.
      const allFailing = this.failureStreak >= this.repeatStreak;
      return {
        kind: "stop",
        reason: allFailing
          ? `${LOOP_STALLED}: ${this.failureStreak} consecutive turns in which every tool call failed — ` +
            `stopping rather than retrying indefinitely`
          : `${LOOP_STALLED}: ${this.repeatStreak} consecutive turns produced no new successful tool call — ` +
            `the loop was repeating itself`,
      };
    }
    if (this.repeatStreak > 0) {
      const parts: string[] = [];
      if (repeated) parts.push(`${repeated} of ${calls.length} call${calls.length === 1 ? "" : "s"} repeated a call you already made with the same arguments`);
      if (errored) parts.push(`${errored} of ${calls.length} call${calls.length === 1 ? "" : "s"} failed`);
      const remaining = stallTurns - this.repeatStreak;
      return {
        kind: "nudge",
        note:
          `NOTE: that turn made no progress (${parts.join("; ")}). ` +
          `Do not repeat the same call again. Either take a different, concrete action toward finishing the task, ` +
          `or — if the remaining work is blocked or already done — reply with your summary of what you completed and what remains. ` +
          `${remaining} more turn${remaining === 1 ? "" : "s"} like this and the run will be stopped as stalled.`,
      };
    }
    return { kind: "continue" };
  }
}

/** Stable, order-independent serialization of tool args. */
function canonicalArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return "";
  }
}
