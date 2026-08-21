/**
 * Comprehension helpers for the staged `read` tool.
 *
 * `authoring.ts` is the write/edit half of the two-step mutation contract: Model
 * A drafts, and a pinned Model B authors the bytes that hit disk. This module is
 * the read half, and it closes the same loop in the other direction:
 *
 *   1. RATE       — a cheap internal call judges how hard the file just loaded is
 *                   for the current model to reason about (`rateFileComplexity`).
 *   2. COMPREHEND — if the rating says the file is beyond the current model, a
 *                   STRONGER model reads it and produces an analysis that is
 *                   appended to the raw bytes (`comprehendFile`).
 *
 * The asymmetry with authoring is deliberate. Escalation for write/edit is
 * decided by the HOST, pre-flight, via `PermissionDecision.authorModel` — the
 * host has the diff-shaped args in hand and can judge. For a read there is
 * nothing to judge until the bytes exist, so the escalation decision is made
 * INTERNALLY, after stage 1, with no host round-trip and no user prompt.
 *
 * Both halves keep the same invariant: the LLM call lives inside the tool, so the
 * runner never reasons over file contents.
 */
import { createHash } from "node:crypto";
import type { Context, LLMBridge, Model, Usage } from "../../types.js";
import { emptyUsage, type ComplexityCategory, type ComplexityRating } from "../../types.js";
import { CODE_RISK_FOR_COMPREHENSION, CODE_RISK_FOR_RATING, UI_RISK_FOR_COMPREHENSION } from "../../code-risk.js";

/**
 * Rater instructions. Deliberately narrow: the rater judges DIFFICULTY, not
 * correctness, and must answer in one token-cheap line we can parse. It is asked
 * about the reading model's own capacity, not about the file in the abstract — a
 * 2000-line generated barrel file is long but trivial; a 60-line lock-free queue
 * is not.
 */
const RATE_SYSTEM = [
  "You judge how hard a source file is to REASON ABOUT correctly — not how long it is.",
  "Judge it FOR THE SPECIFIC MODEL NAMED BELOW as the reader, not in the abstract. The same file is",
  "routine for a frontier model and beyond a small one, and the answer decides whether a stronger model",
  "is paid for. If no reader is named, assume a mid-tier model.",
  "Consider: control-flow and concurrency subtlety, implicit invariants, non-obvious coupling",
  "to other modules, dense generics/metaprogramming, and how badly a wrong edit here would break things.",
  "",
  CODE_RISK_FOR_RATING,
  "",
  "Answer with EXACTLY one line, no prose, no fences, in this form:",
  "RATING: <low|medium|high> | WHY: <at most 15 words>",
].join("\n");

/**
 * Comprehension instructions for the escalation model. It must NOT restate the
 * file (the caller keeps the raw bytes) — it contributes the understanding the
 * weaker model would have missed, in a form that is directly actionable for a
 * subsequent edit.
 */
function comprehendSystem(category: ComplexityCategory | undefined): string {
  return [
    "You are the stronger model in a two-stage read. A weaker model has the raw file already,",
    "so do NOT summarize or restate the code. Contribute ONLY what it is likely to get wrong:",
    "the invariants that must hold, the non-obvious control flow and coupling, the parts that look",
    "safe to change but are not, and the specific traps for the stated task.",
    "",
    // The driver's own reasoning is part of the analyst's input (ComprehendFileInput.
    // driverReasoning). Without being told what it already covered, the analyst
    // re-derives the same points the driver just thought through — two models, two
    // passes over the obvious, and the driver still misses the gaps. The contract
    // below is what makes the escalation COMPENSATE the driver instead of doubling it.
    "THE WEAKER MODEL IS ALSO REASONING ABOUT THIS FILE AS IT READS. Under 'DRIVER'S REASONING'",
    "below is what it has already worked out about THIS task. Do NOT restate any of it, do NOT",
    "improve its phrasing, do NOT re-derive the points it already made. Your output must be",
    "DISJOINT from its reasoning: the things it got wrong, missed, or cannot see from this file",
    "alone. If the driver's reasoning already covers everything this file contributes to the",
    "task, say so in one line ('nothing beyond the driver's reasoning') and stop — an accurate",
    "one-line close is a better result than a confident review it already has.",
    "",
    // Mirrors `systemFor` on the authoring side: interface work gets the interface
    // risks, not the logic enumeration.
    category === "ui" || category === "svg" ? UI_RISK_FOR_COMPREHENSION : CODE_RISK_FOR_COMPREHENSION,
    "",
    "LEAD WITH THE TASK. When a TASK is given, your FIRST lines must be what bears on THAT change: where in",
    "this file it lives (by line), and what would make an edit there go wrong. If the task names a specific",
    "thing, locate that thing — a reader who still has to search for it got nothing from you. Everything else",
    "is secondary and belongs after it, or nowhere. An accurate audit of code the task does not touch is a",
    "cost, not a contribution: the reader has to work out that none of it applies to what they asked.",
    "",
    // The rule above created its own failure mode. Told to lead with the task and
    // given none, a model does not say so — it picks a plausible feature out of
    // the file and writes a confident analysis of a change nobody requested. That
    // analysis is then appended to the reader's context under a banner calling it
    // authoritative, and the reader goes and works on the invented task.
    "NEVER INVENT THE TASK. If no TASK line appears below, you do not know what is being changed, and you must",
    "not guess one from the file's contents. Do not write a 'TASK:' line of your own, do not open with 'the",
    "user wants to…', and do not pick a feature out of the file and analyse a change to it. With no task,",
    "report only what is true of the file as it stands — the invariants and the genuinely fragile parts — and",
    "say nothing about what an edit would do. A confident analysis of a change nobody asked for is the single",
    "most expensive thing you can return: the reader believes it and acts on it.",
    "",
    // The analyst is a chat model; its planning text reaches the caller verbatim
    // unless it is told not to emit any, and a reader cannot tell a model
    // thinking aloud from a model reporting a finding.
    "OUTPUT THE ANALYSIS ONLY. No thinking aloud, no 'let me…', no 'wait, actually…', no restating the task",
    "back to yourself, no closing summary of what you just wrote. The first character of your reply is the",
    "first character of the analysis.",
    "",
    "THE LIST ABOVE IS A SEARCH ORDER, NOT AN OUTLINE. Do not emit a heading per item and do not fill one in",
    "to be thorough — \"no loops exist in this file\" is not a finding, it is a heading with nothing behind it,",
    "and it costs the reader the same attention as a real one. Report only what you actually found, in as few",
    "words as it takes. Three real risks beat seven sections.",
    "",
    "PRESENT-TENSE RISKS ONLY. Report what is wrong, fragile or surprising about the code AS IT STANDS, and",
    "what the stated change would collide with. Do NOT enumerate what would break if someone later removed a",
    "guard, renamed an export, changed a library's signature or deleted an import that nobody proposed",
    "touching — that is true of all code and distinguishes nothing. If a risk only exists under a",
    "hypothetical future edit, leave it out.",
    "",
    "Name only the risks that are REAL in this file — a file with no async and no callers does not need",
    "paragraphs about await and blast radius. Where you cannot see something the reader needs (a caller in",
    "another file, the installed version of a library), say so explicitly and name what they should check.",
    "CITE EXACT LINE NUMBERS from the numbered source you were given — the reader is looking at those same",
    "numbers. Never write an approximate or guessed line (\"~150\"); if you are unsure, quote the line's text",
    "instead. No fences, no preamble.",
  ].join("\n");
}

/**
 * How much room B gets to narrate, by how hard the file turned out to be.
 *
 * A flat cap was the wrong instrument. The whole reason this call happens is that
 * stage 1 judged the file beyond the reading model — so the file that most needs
 * explaining was being held to the same budget as the borderline one, and the
 * analysis that came back for a genuinely hard file was truncated exactly where it
 * got interesting. Length follows difficulty: `high` gets room to walk the file,
 * `medium` stays terse because terse is usually enough there.
 */
const NARRATION_BUDGET: Record<ComplexityRating, string> = {
  low: "Use terse bullets, at most 150 words.",
  medium: "Use terse bullets, at most 250 words.",
  high:
    "Take the room the FINDINGS need — up to about 700 words, and well under it when there is less to say. " +
    "This file was rated hard, so explain the parts that are genuinely hard: the invariants, the order " +
    "things must happen in, and what breaks if they do not. A truncated analysis of a hard file is worse " +
    "than none, because it reads as if the file were simple — but so is a padded one, which buries the two " +
    "findings that mattered in five that did not. The budget is a ceiling for a file full of real risk, " +
    "not a target to reach.",
};

/**
 * Reasoning effort for the escalation call, by rating.
 *
 * `effort`, not a token ceiling. `authoring.ts` learned this the expensive way
 * (see `AUTHORING_BUDGET`): `reasoningMaxTokens` becomes `reasoning.max_tokens`,
 * which is a CEILING and near-meaningless for OpenAI-family models, so the call
 * silently ran at the provider default. This module was still doing exactly that
 * — escalating to a stronger model and then asking it to think no harder than the
 * orchestrator does. The escalation is the whole point of the spend; the effort
 * has to match what stage 1 said the file costs.
 */
const COMPREHEND_EFFORT: Record<ComplexityRating, "low" | "medium" | "high"> = {
  // `low` is unreachable from the staged read, which returns before stage 2 once
  // the rater says low — there is nothing to escalate for. It is kept because the
  // map is total over the rating type and this module is callable directly, so a
  // caller that escalates a low-rated file on its own terms still gets a sane
  // effort rather than an undefined one.
  low: "low",
  medium: "medium",
  high: "high",
};

/** What the escalated read worked out about a file, kept for the later write. */
export interface RememberedComprehension {
  /** Stage 1's independent judgement of the file — NOT the orchestrator's claim. */
  rating: ComplexityRating;
  /**
   * B's analysis, verbatim. Absent on a RATING-ONLY entry — a `low` verdict is
   * remembered (so the file is never re-rated) without paying for an analysis
   * there is nothing to escalate for. Every consumer must treat a missing
   * analysis as "no comprehension", never as an empty one.
   */
  analysis?: string;
  /** Which model produced it, for the log and the authoring prompt's provenance. */
  model?: string;
  /** The rater's one-line justification, when there was one. */
  why?: string;
  /**
   * Digest of the WHOLE file as it stood when this analysis was produced.
   *
   * Half of the reuse gate. Re-reading a file the run has already comprehended
   * must not re-run the escalation, but reusing an analysis of DIFFERENT bytes
   * would be worse than re-running it — so the file has to match, not just the
   * path.
   *
   * Deliberately the whole file rather than the slice that was read: a run reads
   * a file once in full and then keeps coming back for windows of it, and hashing
   * the window makes every one of those a miss for a file that never changed.
   */
  fileHash?: string;
  /**
   * Which part of the file the analysis actually covers — `"full"`, or
   * `"<offset>:<limit>"` for a windowed read.
   *
   * The other half of the gate, and the reason the file hash alone is not enough:
   * an analysis of lines 1–50 does not describe the rest of the file, so reusing
   * it for a full read would hand the author a confident account of code nobody
   * looked at. A `"full"` analysis, on the other hand, covers any window.
   */
  coveredRange?: string;
  /**
   * Every range this run has already comprehended for the path, for files too
   * large to send whole (`coveredRange` stays the LATEST one). A windowed read
   * of a huge file that misses the latest range but matches an earlier one is
   * still reusable — and a hard per-file comprehension cap (see
   * {@link ComprehensionStore}) means this array is never allowed to grow past
   * the cap's length, so no third comprehension for one file.
   */
  coveredRanges?: string[];
  /**
   * Whether this analysis has ALREADY been appended to a read result.
   *
   * A run re-reads the same file constantly — check a detail, grep, come back —
   * and every one of those repeats re-appended the whole analysis. Observed: one
   * 14KB analysis emitted six times against six different windows of the same
   * file, including a 12-line window, for ~88KB of context spent restating
   * something the model had already been told once. (It was also wrong, which is
   * how it got noticed, but it would have been waste either way.)
   *
   * Emission is tracked PER LOOP (`emittedInLoop`), not just once per run: the
   * analysis must be appended to EVERY driver context that touches the file —
   * the read hop's driver sees it on its first read, and the write_edit hop's
   * driver, whose context never contained the read hop's transcript, sees it
   * again on ITS first read (free, from the store). Within one loop, later reads
   * get a reuse note instead of the full text.
   */
  emitted?: boolean;
  /** The loop (`ToolLoopInput.label`) that last had this analysis appended. */
  emittedInLoop?: string;
}

/** Whether an analysis covering `covered` can answer a read of `wanted`. */
export function coversRange(covered: string | undefined, wanted: string): boolean {
  if (!covered) return false;
  return covered === "full" || covered === wanted;
}

/** Whether any range an analysis covers can answer a read of `wanted`. */
export function coversAnyRange(entry: Pick<RememberedComprehension, "coveredRange" | "coveredRanges">, wanted: string): boolean {
  if (coversRange(entry.coveredRange, wanted)) return true;
  return (entry.coveredRanges ?? []).some((r) => r === wanted || r === "full");
}

/** Stable digest of the file text an analysis was produced from. */
export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/**
 * Comprehension carried from `read` to the `write`/`edit` that follows it.
 *
 * Keyed by the path as the tool received it. Deliberately process-local and
 * unbounded-but-tiny: one entry per file a run escalated on, holding a few
 * hundred words each, discarded when the process ends.
 *
 * The reason it exists: `read` escalates to a stronger model precisely because the
 * file is beyond the orchestrator, and then hands that model's analysis back into
 * the ORCHESTRATOR's context. When the orchestrator later calls `write`/`edit`,
 * the authoring model is given the task and the file but not that analysis — so
 * the understanding reaches the author, if at all, as the weaker model's summary
 * of it. This closes the loop directly: B explains the file, and B authors it.
 *
 * Superseded on re-read, so a file that changed under us gets the fresh analysis
 * rather than a stale one.
 */
/**
 * The run-scoped comprehension store.
 *
 * This is the "the strong model reasons once, and the reasoning becomes tool-chain
 * state" part of the architecture. The chain creates ONE store per run and threads
 * it into every categorizer loop (`ToolContext.comprehensionStore`), so:
 *
 *   - the read hop's comprehension of a file is visible to the write_edit hop —
 *     its first read of the same file re-injects the analysis from the store with
 *     zero additional model calls;
 *   - the "analyse once" guarantee is per RUN, not per process: one rater + one
 *     comprehension per file per run (within the size cap), no matter how many
 *     windows/hops touch it afterwards;
 *   - the per-file comprehension cap below guarantees a huge file is never
 *     comprehended a third time.
 *
 * A default instance backs the module-level `remember/recall/forget/reanchor`
 * functions so direct tool use and existing tests keep working unthreaded.
 */
export class ComprehensionStore {
  private readonly byPath = new Map<string, RememberedComprehension>();
  /** How many times each path has been comprehended this run (huge-file cap). */
  private readonly comprehendCount = new Map<string, number>();

  constructor(private readonly maxComprehensionsPerFile = 2) {}

  recall(path: string): RememberedComprehension | undefined {
    return this.byPath.get(path);
  }

  put(path: string, value: RememberedComprehension): void {
    this.byPath.set(path, value);
  }

  /** Drop a path's analysis once the file has been rewritten — it describes the old bytes. */
  forget(path: string): void {
    this.byPath.delete(path);
  }

  /**
   * Keep a path's analysis but re-anchor it to the file's NEW bytes — sound only
   * for a literal-only edit (see the module-level `reanchorComprehension`).
   */
  reanchor(path: string, fileHash: string): void {
    const existing = this.byPath.get(path);
    if (!existing) return;
    this.byPath.set(path, { ...existing, fileHash });
  }

  /** Whether this path still has comprehension budget left (huge-file cap). */
  canComprehend(path: string): boolean {
    return (this.comprehendCount.get(path) ?? 0) < this.maxComprehensionsPerFile;
  }

  /** Record that one more comprehension ran for a path. */
  noteComprehended(path: string): void {
    this.comprehendCount.set(path, (this.comprehendCount.get(path) ?? 0) + 1);
  }

  clear(): void {
    this.byPath.clear();
    this.comprehendCount.clear();
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Every stored entry (paths that got at least a rating this run). */
  entries(): Array<{ path: string; value: RememberedComprehension }> {
    return [...this.byPath.entries()].map(([path, value]) => ({ path, value }));
  }
}

const defaultStore = new ComprehensionStore();

export function rememberComprehension(path: string, value: RememberedComprehension): void {
  defaultStore.put(path, value);
}

export function recallComprehension(path: string): RememberedComprehension | undefined {
  return defaultStore.recall(path);
}

/** Drop a path's analysis once the file has been rewritten — it describes the old bytes. */
export function forgetComprehension(path: string): void {
  defaultStore.forget(path);
}

/**
 * Keep a path's analysis but re-anchor it to the file's NEW bytes.
 *
 * For an edit that changed only literal content — a string, a number — the
 * analysis is still true: the control flow, the invariants, the couplings and the
 * line numbers it cites are all unmoved. Discarding it there is pure waste, and it
 * was expensive waste: a run that touched one file four times paid for four full
 * escalations of a file whose structure never changed, and appended four
 * near-identical multi-KB analyses into the conversation.
 *
 * Only sound because the caller has already PROVEN the change was literal-only
 * (see `literalOnlyReplacement` in coding.ts). Any structural edit must still call
 * {@link forgetComprehension} — an analysis that reads as current while describing
 * code that has moved is worse than having none.
 */
export function reanchorComprehension(path: string, fileHash: string): void {
  defaultStore.reanchor(path, fileHash);
}

/** Test seam (clears the default, unthreaded store only). */
export function clearComprehensionMemory(): void {
  defaultStore.clear();
}

/**
 * Whether the UNTHREADED store still has comprehension budget for a path
 * (huge-file cap). The threaded store's own `canComprehend` is consulted when a
 * run passes one; these module helpers keep the direct-tool path governed by the
 * same cap.
 */
export function comprehensionBudgetLeft(path: string): boolean {
  return defaultStore.canComprehend(path);
}

/** Record one comprehension against the unthreaded store's per-path budget. */
export function spendComprehensionBudget(path: string): void {
  defaultStore.noteComprehended(path);
}

export interface RateFileInput {
  llm: LLMBridge;
  /** Model doing the rating — cheap by design; usually the loop's current model. */
  model: Model;
  path: string;
  /** The file text as returned to the caller (line-numbered is fine). */
  content: string;
  /** The originating task, so difficulty is judged relative to the work at hand. */
  task?: string;
  /** What KIND of file this is; selects the risk framing. See {@link ComprehendFileInput.category}. */
  category?: ComplexityCategory;
  /**
   * Identity of the model that will do the reading.
   *
   * Load-bearing, not decoration: the rating is meant to answer "is this file
   * beyond THIS reader", and without a reader named the question collapses to
   * "is this file hard", which is not the question and cannot justify the spend.
   */
  readerModel?: string;
  signal?: AbortSignal;
}

export interface RateFileResult {
  rating: ComplexityRating;
  why?: string;
  usage: Usage;
}

export interface ComprehendFileInput {
  llm: LLMBridge;
  /** The escalation model (Model B) — stronger than the one that asked for the read. */
  model: Model;
  path: string;
  content: string;
  task?: string;
  /** The rater's justification, so B knows what looked hard. */
  why?: string;
  /**
   * What KIND of file this is. Selects the risk framing, mirroring the authoring
   * side (`systemFor` in authoring.ts), which has always given `ui`/`svg` the bare
   * contract and reserved the logic enumeration for code.
   *
   * The read side had no such gate, and the cost was concrete: a UI file read
   * during a copy change came back with a seven-point audit of `await` usage,
   * loop boundaries and blast radius across methods the task never touched —
   * several KB per read, repeated on every re-read, describing risks that were
   * real in the file but irrelevant to the work. The reading model spent turns
   * trying to reconcile it with what it had asked for.
   */
  category?: ComplexityCategory;
  /**
   * Stage 1's rating. Drives both how hard B is asked to think and how much room
   * it gets to narrate — see {@link COMPREHEND_EFFORT} and
   * {@link NARRATION_BUDGET}. Defaults to `high`, because the only caller that
   * omits it is one that decided to escalate without saying why.
   */
  rating?: ComplexityRating;
  /**
   * The weaker model's OWN reasoning about this file (its current turn's thinking
   * blocks), so the analyst does not restate it.
   *
   * The driver reasons as it reads — a small model produces a lot of thinking
   * around every file — and the whole point of the escalation is to contribute
   * what the driver cannot see, not to say the same thing better. Without this
   * input the analyst has no way to know what was already covered, so it re-covers
   * it: two models, two passes over the same obvious points, and the reader gets a
   * wall of prose it mostly already knows. With it, the instructions change from
   * "contribute only what the weaker model is likely to get wrong" to "here is
   * exactly what it already worked out — add only the gaps".
   *
   * Bounded before it is sent (the reasoning is only context for the analyst, not
   * something the reader needs back).
   */
  driverReasoning?: string;
  signal?: AbortSignal;
}

export interface ComprehendFileResult {
  /** B's analysis, to be APPENDED to the raw bytes (never to replace them). */
  analysis: string;
  usage: Usage;
  /**
   * True when the model DID answer but the answer was unusable — leaked
   * reasoning with nothing behind it, or a degenerate symbol run — and both the
   * first attempt and the retry were rejected by {@link sanitizeAnalysis}.
   *
   * Distinct from a plain empty result (the call itself failed) because the two
   * want different handling downstream: a failed call is infrastructure, while
   * this means the escalation was PAID FOR and produced nothing, on a file that
   * stage 1 said the reading model should not be trusted with. The reader is
   * told, rather than being left to assume the file was simple enough not to
   * need explaining.
   */
  rejected?: boolean;
}

/**
 * Stage 1: rate the file's reasoning difficulty. Never throws — a rater failure
 * degrades to `"low"` (no escalation, today's plain-read behavior) rather than
 * failing the read, because a read that dies takes the whole step with it. This
 * is the opposite of the authoring contract, where an empty result IS an error:
 * authoring failure would write wrong bytes, while rating failure only forgoes
 * an optimization.
 */
export async function rateFileComplexity(input: RateFileInput): Promise<RateFileResult> {
  const context: Context = {
    systemPrompt: RATE_SYSTEM,
    messages: [
      {
        role: "user",
        content: buildRateMessage(input),
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const msg = await input.llm.complete(input.model, context, {
      temperature: 0,
      signal: input.signal,
      // One line of output. Unbounded reasoning here spends the whole budget
      // thinking and returns no content, which parses as `low` and silently
      // disables escalation.
      reasoningMaxTokens: 512,
    });
    const parsed = parseRating(extractText(msg.content));
    return { ...parsed, usage: msg.usage ?? emptyUsage() };
  } catch {
    return { rating: "low", usage: emptyUsage() };
  }
}

/**
 * Stage 2: have the stronger model produce the analysis the weaker model would
 * have missed. Never throws for the same reason as above — on failure the caller
 * still returns the raw bytes, which is exactly today's behavior.
 */
export async function comprehendFile(input: ComprehendFileInput): Promise<ComprehendFileResult> {
  const rating = input.rating ?? "high";
  const context: Context = {
    systemPrompt: `${comprehendSystem(input.category)}\n${NARRATION_BUDGET[rating]}`,
    messages: [
      {
        role: "user",
        content: buildComprehendMessage(input),
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const msg = await input.llm.complete(input.model, context, {
      temperature: 0,
      signal: input.signal,
      // Effort, not a ceiling — and scaled to what stage 1 said this file costs.
      // The length bound now lives in the system prompt, where it constrains the
      // ANSWER rather than the thinking that produces it.
      reasoning: COMPREHEND_EFFORT[rating],
    });
    const first = sanitizeAnalysis(extractText(msg.content));
    let usage = msg.usage ?? emptyUsage();
    if (first) return { analysis: first, usage };

    // ---- one retry ----
    //
    // Rejecting the answer and stopping there is the wrong trade when the READER
    // is a weak model: the analysis exists precisely to compensate for that, and
    // stage 1 has already said this file is beyond it. A collapsed generation is
    // usually a bad sample rather than a model that cannot do the job, and one
    // more attempt is cheap next to leaving the reader unaided on a file rated
    // hard.
    //
    // The retry appends a corrective line rather than re-sending the same
    // prompt. At temperature 0 an identical request re-draws the identical
    // sample, so a bare retry would reproduce the same garbage and bill for it.
    const retryContext: Context = {
      systemPrompt: context.systemPrompt,
      messages: [
        {
          role: "user",
          content:
            `${buildComprehendMessage(input)}\n\n` +
            `YOUR PREVIOUS REPLY WAS DISCARDED: it was not an analysis — it contained thinking-aloud, ` +
            `stray markup, or repeated symbols instead of findings. Reply with the findings ONLY, as plain ` +
            `bullets citing exact line numbers. Begin at the first character of the first finding.`,
          timestamp: Date.now(),
        },
      ],
    };
    const retry = await input.llm.complete(input.model, retryContext, {
      temperature: 0,
      signal: input.signal,
      reasoning: COMPREHEND_EFFORT[rating],
    });
    usage = mergeUsage(usage, retry.usage) ?? usage;
    const second = sanitizeAnalysis(extractText(retry.content));
    if (second) return { analysis: second, usage };
    return { analysis: "", usage, rejected: true };
  } catch {
    return { analysis: "", usage: emptyUsage() };
  }
}

/**
 * Reasoning-channel markers that leak into the CONTENT of some models' replies.
 *
 * Both halves are seen in the wild: a properly paired `<think>…</think>`, and an
 * unpaired closer where the opener was emitted on a separate channel and only the
 * close tag reached the text — observed literally as `</think:opensource>`, with
 * ~4KB of the model's planning ("Let me write the analysis now…", "Actually, the
 * task is a bit contradictory…") sitting in front of it.
 *
 * Everything up to and including the LAST closer is thinking, so the fix is the
 * same for both shapes: cut there.
 */
const THINK_CLOSE_RE = /<\/\s*(?:think|thinking|reasoning|antml:thinking)[^>]*>/gi;

/** A line that is a model narrating its own process rather than reporting a finding. */
const NARRATION_LINE_RE =
  /^\s*(?:wait|okay|ok|hmm|alright|now|so)\b[,.]?\s|^\s*let(?:'s| me| us)\b|^\s*(?:actually|first,? let)\b|^\s*i(?:'ll| will| should| need to)\b/i;

/**
 * Strip the analyst's thinking and reject output that is not an analysis.
 *
 * Three defects, all observed in ONE returned analysis, all of which reached the
 * reading model verbatim under a banner describing it as authoritative:
 *
 *   1. ~4KB of first-person planning followed by a stray `</think:opensource>`
 *      tag — the reasoning channel bleeding into the content channel.
 *   2. A ~600-character wall of `{`, `//` and `>` with no words in it: a
 *      degenerate generation, appended raw.
 *   3. `TASK: The user wants to change the "Lock screen Widget" label…` on a run
 *      whose task was to change a delete-account dialog title — a task the model
 *      invented (see `NEVER INVENT THE TASK` above, and `ToolContext.task`).
 *
 * (3) is fixed upstream by giving the analyst the real task; (1) and (2) are
 * fixed here, because no prompt reliably prevents them. Returning `""` is a
 * supported outcome — the caller falls back to a plain read, which is strictly
 * better than an analysis nobody can trust.
 */
export function sanitizeAnalysis(raw: string): string {
  if (!raw.trim()) return "";
  // 1. Everything before the last reasoning closer is thinking.
  let text = raw;
  const closers = [...text.matchAll(THINK_CLOSE_RE)];
  const last = closers[closers.length - 1];
  if (last?.index !== undefined) text = text.slice(last.index + last[0].length);
  // A dangling OPENER with no closer means the reply is thinking all the way down.
  if (/<\s*(?:think|thinking|reasoning)[^>]*>/i.test(text)) return "";

  // 2. Drop leading junk: degenerate symbol runs and first-person narration. Only
  //    from the TOP — a narration-shaped line in the middle of a real analysis is
  //    far more likely to be prose about the code than a relapse into planning.
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]!;
    if (!line.trim()) { start += 1; continue; }
    if (NARRATION_LINE_RE.test(line)) { start += 1; continue; }
    if (isSymbolNoise(line)) { start += 1; continue; }
    break;
  }
  text = lines.slice(start).join("\n").trim();

  // 3. Whatever survived must actually read like prose about code. A reply that
  //    is mostly punctuation is a collapsed generation, not a terse analysis.
  return looksLikeAnalysis(text) ? text : "";
}

/** True for a line with essentially no words — the shape of a degenerate run. */
function isSymbolNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return true;
  const words = trimmed.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return words === 0;
}

/**
 * Whether the text is plausibly an analysis rather than noise.
 *
 * Deliberately crude and deliberately lenient: this is a floor that only a
 * genuinely broken generation falls through. A terse, correct three-bullet
 * analysis must always pass, so the bar is "has real sentences in it", not any
 * judgement about quality.
 */
function looksLikeAnalysis(text: string): boolean {
  const trimmed = text.trim();
  // Length is NOT the signal, and an early version of this that demanded 40
  // characters and 20 words was wrong: "L3: acquire() may reenter." is a
  // complete, useful analysis, and the prompt explicitly asks for as few words as
  // the findings take. Short is the goal, not the symptom.
  if (trimmed.length < 12) return false;
  const words = trimmed.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  if (words < 3) return false;
  // Symbol dominance IS the signal. The observed degenerate run was a wall of
  // `{`, `//` and `>` scoring ~0.4 here; ordinary prose about code, including
  // quoted identifiers and short snippets, sits around 0.05.
  const symbols = (trimmed.match(/[{}<>/\\|]/g)?.length ?? 0) / trimmed.length;
  return symbols < 0.3;
}

function buildRateMessage(input: RateFileInput): string {
  const parts = [`FILE: ${input.path}`];
  if (input.readerModel) parts.push(`THE READER IS: ${input.readerModel}`);
  if (input.task) parts.push(`TASK THE READER IS WORKING ON:\n${input.task}`);
  parts.push(`CONTENTS:\n\`\`\`\n${input.content}\n\`\`\``);
  parts.push("Reply with the single RATING line only.");
  return parts.join("\n\n");
}

function buildComprehendMessage(input: ComprehendFileInput): string {
  const parts = [`FILE: ${input.path}${input.category ? ` (${input.category})` : ""}`];
  if (input.task) parts.push(`TASK:\n${input.task}`);
  if (input.why) parts.push(`WHY THIS FILE WAS FLAGGED AS COMPLEX:\n${input.why}`);
  parts.push(`CONTENTS:\n\`\`\`\n${input.content}\n\`\`\``);
  if (input.driverReasoning) {
    parts.push(
      `DRIVER'S REASONING (what the weaker model already worked out about this file/task — your findings must be DISJOINT from this):\n` +
        `\`\`\`\n${input.driverReasoning}\n\`\`\``,
    );
  }
  parts.push("Give the analysis now. No summary of the code itself.");
  return parts.join("\n\n");
}

/**
 * Parse the rater's `RATING: x | WHY: y` line. Tolerant of casing, missing WHY,
 * and surrounding chatter (we scan for the first rating word rather than
 * demanding an exact match), because a strict parse that misses means a silent
 * un-escalation. Unparseable ⇒ `"low"`, matching the never-throw contract.
 */
export function parseRating(text: string): { rating: ComplexityRating; why?: string } {
  const rating = /\b(low|medium|high)\b/i.exec(text)?.[1]?.toLowerCase() as ComplexityRating | undefined;
  const why = /WHY:\s*(.+)$/im.exec(text)?.[1]?.trim();
  return { rating: rating ?? "low", ...(why ? { why } : {}) };
}

/** Sum two optional usages into one (both stages of a staged read are billed to
 *  the caller's `ToolResult.usage`, so the run's cost accounting stays honest). */
export function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** Pull the concatenated text blocks out of an assistant message's content. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("");
}
