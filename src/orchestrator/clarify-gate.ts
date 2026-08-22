/**
 * The ask-before-you-invent gate — a sibling of the observe-first wrappers in
 * `categorizer/chain.ts` (`enforceObserveFirst` and friends), and it exists for
 * the same reason those do: prose does not bind.
 *
 * `ASKING_THE_USER` (in `categorizer/guidance.ts`) is a page of careful guidance about
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

import { detectShellAuthoring } from "../tools/builtin/coding.js";
import type { ResolvedClarification } from "../types.js";

/**
 * Collapse a question to a comparable key.
 *
 * Two hops asking for the same value rarely phrase it identically — the run that
 * motivated this asked "What should the new title be for the delete account
 * popup?" and then "What should the new title of the delete account popup be?".
 * Word-set equality catches that; word ORDER and punctuation do not survive.
 */
export function normalizeQuestion(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !QUESTION_STOP_WORDS.has(word));
  return [...new Set(words)].sort().join(" ");
}

const QUESTION_STOP_WORDS = new Set([
  "a", "an", "the", "be", "is", "are", "was", "were", "do", "does", "did", "to", "of", "for", "in",
  "on", "at", "it", "this", "that", "should", "would", "could", "will", "what", "which", "who",
  "whom", "how", "and", "or", "please", "you", "your", "i", "me", "my", "we", "us", "new",
]);

/** Whether a tool call is the ask-the-user tool, under either name. */
function isAskTool(name: string): boolean {
  return name === "ask_user_question" || name.endsWith("__ask_user_question");
}

/** Whether a tool call is the harness's own file mutation pair. */
export function isMutationTool(name: string): boolean {
  return name === "write" || name === "edit";
}

/**
 * Whether a tool call authors file CONTENTS through the shell — the bash escape
 * path around the write/edit gate. Returns the offending path so the message can
 * name it; `null` for a bash call that is not authoring (build/test/grep/mkdir)
 * or for any non-bash tool.
 */
export function shellAuthoringTarget(
  name: string,
  args: Record<string, unknown> | undefined,
): { path: string; form: string } | null {
  // Every shell surface, not just the one called `bash`. `bash_readonly` is the
  // one that actually got through: the read hop authored a Dart file with a
  // `python3 -c` script and this function, asked only about "bash", said no
  // authoring had happened. An MCP-prefixed spelling counts too.
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare !== "bash" && bare !== "bash_readonly") return null;
  const command = typeof args?.command === "string" ? args.command : "";
  if (!command) return null;
  return detectShellAuthoring(command);
}

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
  /** How many re-asks of an already-answered question were refused. */
  reAsksRefused?: number;
}

/**
 * Track whether a run whose request is missing its value has asked for it, and
 * refuse the first mutation until it does.
 */
export class ClarifyGate {
  private readonly armed: boolean;
  private asked = false;
  private blocks = 0;
  /** Answers the user has given, keyed by normalized question. */
  private readonly answers = new Map<string, ResolvedClarification>();
  /** Normalized questions already refused once, so a re-ask cannot deadlock. */
  private readonly reAsksRefused = new Set<string>();

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
    if (isAskTool(toolName)) {
      this.asked = true;
    }
  }

  /**
   * Record an answer the user actually gave.
   *
   * The gate outlives a single hop (the chain shares one instance across all of
   * them), which makes it the only component that sees the whole run's Q&A. It
   * already knew a question had been ASKED; it now knows what came back, which is
   * what lets it refuse the second hop's re-ask by handing over the answer.
   */
  recordAnswer(entry: ResolvedClarification): void {
    const key = normalizeQuestion(entry.question);
    if (!key) return;
    this.asked = true;
    if (!this.answers.has(key)) this.answers.set(key, entry);
  }

  /** Every answer the run has collected, in the order they were given. */
  get answered(): ResolvedClarification[] {
    return [...this.answers.values()];
  }

  /**
   * Judge a tool call about to run. Refuses a mutation while the value is still
   * unknown and unasked; allows everything else, always.
   */
  check(toolName: string, args?: Record<string, unknown>): ClarifyDecision {
    // Asking again for something the user already answered. Checked BEFORE the
    // armed/asked short-circuit below, because this refusal has nothing to do
    // with whether the request was missing a value — a hop can re-ask a question
    // the gate was never armed for.
    //
    // The answer reaches a later hop as an ALREADY ANSWERED block in its opening,
    // but that block competes with the verbatim task line (still unspecified,
    // forever) and with a page of guidance about asking when a value is unnamed.
    // On the run this fixes, the block's information was present in read's
    // deliverable prose and lost that argument. Prose does not bind; this does.
    if (isAskTool(toolName)) {
      const asked = typeof args?.question === "string" ? args.question : "";
      const key = normalizeQuestion(asked);
      const prior = key ? this.answers.get(key) : undefined;
      if (prior && !this.reAsksRefused.has(key)) {
        this.reAsksRefused.add(key);
        const files = prior.attachments?.length
          ? `\n\nThey also attached: ${prior.attachments.map((file) => file.path).join(", ")} — ` +
            `images are already in your attachment set; read any other file rather than asking for its contents.`
          : "";
        return {
          kind: "block",
          message:
            `${toolName} refused — the user has already answered this.\n\n` +
            `They were asked: "${prior.question}"\n` +
            `They answered: ${prior.answer}${files}\n\n` +
            `That answer is the value for this run. An earlier step asked and got it; the request text you ` +
            `were handed still reads as unspecified because it is the user's ORIGINAL wording, from before ` +
            `they answered. Asking again spends a second round trip on something you are holding.\n\n` +
            `Act on it now. If you genuinely need something DIFFERENT from what was answered, ask that ` +
            `narrower question instead — a re-worded version of the same one will go through unrefused and ` +
            `waste the user's time.`,
        };
      }
    }
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
    return {
      triggered: this.armed,
      blocks: this.blocks,
      asked: this.asked,
      ...(this.reAsksRefused.size ? { reAsksRefused: this.reAsksRefused.size } : {}),
    };
  }
}
