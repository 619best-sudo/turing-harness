/**
 * The ask-before-you-invent gate — a sibling of {@link ReproductionGate} and
 * {@link VerificationGate}, and it exists for the same reason both of those do:
 * prose does not bind.
 *
 * `ASKING_THE_USER` (in phases/prompts.ts) is a page of careful guidance about
 * when a decision belongs to the user. On the run that motivated this file, the
 * model read that guidance, reached the right conclusion five separate times in
 * its own reasoning — the request had not said what to change the value to, so it
 * should ask — and then wrote a guess anyway, four times, cycling through
 * candidates while trying to work out which one had been wanted.
 * `ask_user_question` was in the toolset the whole time and was never called.
 *
 * What that run needed was not better advice. It needed the first `edit` to be
 * refused.
 *
 * ---
 *
 * WHERE THE JUDGEMENT COMES FROM. This gate does not classify the request itself.
 * It is handed a verdict by the intent router (`INTENT_ROUTER_PROMPT`), which
 * already reads every incoming task to pick a route and detect a bug fix, and now
 * also answers one more question: does this request name a value to change without
 * saying what to change it to?
 *
 * Doing it there rather than here is deliberate, and it is the whole design.
 * A keyword test — a list of change verbs, a list of value nouns, a list of forms
 * that count as supplying a value — is the obvious implementation and it is wrong
 * for a library. It encodes one language's vocabulary, so every user not writing
 * English gets a gate that never fires; it encodes one guess at what a "value"
 * is, so projects whose domain nouns are not on the list get nothing; and it
 * misfires on ordinary phrasing in a way that BLOCKS WRITES, which is the most
 * expensive direction to be wrong in. The router is already an LLM call on the
 * task text, it costs nothing extra, and it judges intent in whatever language
 * the user actually wrote.
 *
 * So the rule here is mechanical and vocabulary-free: if the router said the value
 * is unspecified, the first mutation is refused until the user has been asked.
 *
 * The bias is toward silence. The router is instructed to answer NO when unsure,
 * an attachment stands the gate down (an attachment is usually the missing
 * specification), and `maxBlocks` defaults to a single refusal — one intervention,
 * not a deadlock.
 */

import { isMutationTool, shellAuthoringTarget } from "./reproduction-gate.js";

/** A refusal, or permission to proceed. */
export type ClarifyDecision =
  | { kind: "allow" }
  | { kind: "block"; message: string };

export interface ClarifyGateOptions {
  /**
   * The intent router's verdict: the request asks for a new value and does not
   * say what it is. Absent or false ⇒ the gate is inert for the whole run.
   */
  valueUnspecified?: boolean;
  /**
   * Whether the run carries attachments. An attachment is usually the missing
   * specification (a mockup carrying the new copy, a screenshot of the target
   * state), so the gate stands down rather than asking for what it already has.
   */
  hasAttachments?: boolean;
  /**
   * The user's request, quoted back in the refusal so the model can see what it is
   * being asked to clarify. Never parsed, and only quoted when it is SHORT enough
   * to be the request itself.
   *
   * A host may pass far more than the user typed. One passes its whole runtime
   * preamble — connected MCP tool listings, transcript-mode rules, then the user
   * task at the end — and quoting that verbatim put 3.6KB of tool names inside a
   * refusal about a missing value. The model has the task already; echoing it is a
   * convenience, so it is dropped rather than truncated when it is clearly not
   * just the request.
   */
  task?: string;
  /**
   * How many mutations to refuse before giving up and letting the run proceed.
   * Default 1: one refusal is the whole intervention. The point is to make the
   * model notice the hole in the request at the moment it matters, not to
   * deadlock a run whose model will not ask no matter what — the reproduce gate
   * learned that lesson with `maxBlocks` and this inherits it.
   */
  maxBlocks?: number;
}

/** What the gate did, for the run report. */
export interface ClarifyReport {
  /** Whether the request was judged to be missing a value. */
  triggered: boolean;
  /** How many mutations were refused. */
  blocks: number;
  /** Whether the model asked the user at any point. */
  asked: boolean;
}

/**
 * Track whether a run whose request is missing its value has asked for it, and
 * refuse the first mutation until it does.
 */
export class ClarifyGate {
  private readonly armed: boolean;
  private asked = false;
  private blocks = 0;

  constructor(private readonly opts: ClarifyGateOptions = {}) {
    this.armed = opts.valueUnspecified === true && !opts.hasAttachments;
  }

  /** True when this run's request is missing a value only the user can supply. */
  get active(): boolean {
    return this.armed;
  }

  /**
   * Record a completed tool call. Only one tool matters: asking the user. Once
   * asked, the gate is satisfied for the rest of the run — the model has the
   * answer (or the user declined to give one), and either way the decision is no
   * longer being made silently.
   */
  observe(toolName: string): void {
    if (toolName === "ask_user_question" || toolName.endsWith("__ask_user_question")) {
      this.asked = true;
    }
  }

  /**
   * Judge a tool call about to run. Refuses a mutation while the value is still
   * unknown and unasked; allows everything else, always.
   */
  check(toolName: string, args?: Record<string, unknown>): ClarifyDecision {
    if (!this.armed || this.asked) return { kind: "allow" };
    // Only a call that AUTHORS FILE CONTENTS is refused — `write`, `edit`, or a
    // shell command that writes source. Deliberately not the loop's `mutates`
    // flag, which `bash` carries because bash *can* write.
    //
    // Using `mutates` refused `bash {command: "find . -name '*.dart'"}` on the
    // first turn of a real run: a read-only search, blocked by a gate about an
    // unspecified value. The model then asked its question having read nothing, so
    // it could not offer the current value or any options — the exact thing this
    // gate's own message tells it to do. Exploring is how you find out what to
    // offer; only the write has to wait.
    //
    // Same predicates the reproduce gate uses, so the two gates cannot disagree
    // about what counts as a write.
    const writes = isMutationTool(toolName) || shellAuthoringTarget(toolName, args) !== null;
    if (!writes) return { kind: "allow" };
    if (this.blocks >= (this.opts.maxBlocks ?? 1)) return { kind: "allow" };
    this.blocks += 1;
    // See `task`: quote it only when it plausibly IS the request.
    const raw = this.opts.task?.trim();
    const quoted = raw && raw.length <= 300 && !raw.includes("\n\n") ? raw : undefined;
    return {
      kind: "block",
      message:
        `${toolName} refused — this request does not say what the new value should BE.\n\n` +
        (quoted ? `The request was: "${quoted}"\n\n` : "") +
        `You have found what to change; nothing in the code can tell you what to change it TO, because that ` +
        `choice exists only in the user's head. The file will offer plausible candidates — a nearby label, the ` +
        `convention the surrounding code follows — and picking one feels like respecting the project's ` +
        `conventions. It is not: it is choosing for the user, and a wrong guess means doing this twice.\n\n` +
        `Call \`ask_user_question\` now. Offer the candidates you can actually name as \`options\`, mark your best ` +
        `as \`recommended\` — the user can always type something else instead — then make the change once ` +
        `to the value they picked.\n\n` +
        `If the value IS determined — the user did state it, or there is exactly one possible reading — re-issue ` +
        `this exact call and it will go through.`,
    };
  }

  /** The run report. */
  toReport(): ClarifyReport {
    return { triggered: this.armed, blocks: this.blocks, asked: this.asked };
  }
}
