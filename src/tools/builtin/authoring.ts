/**
 * Authoring helper for mutating tools (write/edit).
 *
 * When a host pins a permission-decision `authorModel` on a write/edit call, a
 * SECOND model (Model B) authors the on-disk bytes from scratch — instead of
 * writing the requesting model's (Model A's) draft. Model A has already emitted
 * its args by the time the permission decision is made, so the authoring pass
 * happens INSIDE the tool, before `fs.writeFile`. This mirrors the internal-LLM
 * pattern in `image-analysis.ts` / `activity-monitor.ts` (`ctx.llm.complete`
 * with a self-contained Context) so the runner still does no content reasoning.
 */
import type {
  ComplexityCategory,
  ComplexityRating,
  Context,
  GeneratedAssetRef,
  ImageContent,
  LLMBridge,
  Model,
  Usage,
  UserContent,
} from "../../types.js";
import { emptyUsage } from "../../types.js";
import * as fs from "node:fs/promises";
import { guessMimeType } from "../../multimodal/attachment.js";
import { CODE_RISK_FOR_AUTHORING } from "../../code-risk.js";
import { sanitizeAuthoredText, type SanitizedOutput } from "./authored-output.js";

/**
 * Instruction set for the authoring model: produce ONLY raw file contents.
 *
 * You are here because the call was rated medium/high and the host escalated, so
 * the correctness checklist is the point of the extra spend — not the formatting
 * rules, which merely keep the output writable to disk.
 */
/**
 * The only fixed instruction: a format contract.
 *
 * The steering that once wrapped this prompt — the change-zone/keep-zone framing,
 * the draft-intent clause, the "you are the strongest model" preamble, the
 * "prefer the boring version" closer — was removed after it was found to suppress
 * the work it was meant to improve (that closer made a model draw conservative
 * SVG). ~3.6KB of instruction the model never sees in a normal chat turn.
 *
 * This is what a verbatim file write needs and a chat turn does not: output ONLY
 * the file contents, no fences, no prose. `stripFences` below catches the
 * occasional slip; the contract keeps the common case clean.
 *
 * The correctness checklist is the one piece that came back — see `systemFor`,
 * which adds it for code and withholds it for `ui`/`svg` and vision passes. The
 * task, the current file, and the anchor (for edits) remain the spec.
 */
const FORMAT_CONTRACT = [
  "Your output is written to disk verbatim as the file contents.",
  "Output ONLY the raw file contents — no markdown code fences, no commentary,",
  "no explanation, no leading or trailing prose. Do not wrap it in ```.",
].join("\n");

/**
 * The risk checklist, added back for CODE authoring only.
 *
 * History matters here. All steering was stripped from this prompt because it
 * suppressed the work it was meant to improve — and the documented example was
 * visual: a model told to "prefer the boring version" draws conservative SVG.
 * That diagnosis was right about `ui`/`svg`, but it took the correctness
 * checklist down with it, and the two are not the same thing. Under
 * `authorOnlyWrites` this model writes every byte of logic in the project while
 * being told only how to format its output.
 *
 * So it returns on the axis where it never misfired, and stays off the axis where
 * it did: `category: "ui" | "svg"` keeps the bare format contract, everything else
 * gets the checklist. The "prefer the boring version" closer is gone for good —
 * that line was the specific quality suppressor, not the enumeration.
 */
/**
 * The reuse boundary for a borrowed design blueprint.
 *
 * Added to the authoring prompt only when a blueprint is actually present, so a
 * run with no reference pays nothing for it. It is stated as a hard rule rather
 * than advice because the failure is not a quality problem — a blueprint carries
 * the source's real copy, hex values, image names and brand marks, and a model
 * handed structured JSON will reproduce the values in it unless told not to.
 * Shipping someone else's headline and palette is the one outcome that makes the
 * whole lookup a liability instead of a head start.
 */
const DESIGN_REUSE_BOUNDARY = [
  "A DESIGN REFERENCE is included below. It was reverse-engineered from SOMEONE ELSE'S design.",
  "TAKE: the layout skeleton, the element order and hierarchy, spacing and size RELATIONSHIPS,",
  "  the responsive behaviour, the component anatomy, and the motion (triggers, per-layer",
  "  keyframes, easing, durations) — these are structure, and structure is what you are borrowing.",
  "DO NOT TAKE: its copy, headings, labels, names or numbers; its hex values, gradients or",
  "  fonts; its image filenames, `srcHint`s, logos, icons or brand marks. None of it is yours",
  "  to ship, and none of it is about THIS project.",
  "USE THE `rationale` IF IT IS THERE — it is the one part meant to be reasoned from rather than",
  "  reproduced. It says why THAT focal element carries the section (`whyThisElement`), what the section is",
  "  for (`businessGoal`), who it addresses (`audience`), and what the motion is arguing",
  "  (`animationIntent`). Apply the REASONING to this product and let it pick a different answer: if the",
  "  reference led with a dashboard because the buyer's open question was \"can it do my job\", ask what THIS",
  "  product's open question is — it may be trust, or price, or speed — and lead with whatever answers that.",
  "  Copying the conclusion while ignoring the reason is how a fintech hero ends up on a meditation app.",
  "INSTEAD: use this project's own content and its existing theme tokens (CSS custom properties,",
  "  Tailwind classes, theme file — whatever the current file already uses), its icon set, and its",
  "  real copy. Where the task or the project does not supply a value, write a neutral placeholder",
  "  that is obviously this project's, never the reference's. Match the reference's ROLE for an",
  "  element (\"a short benefit line under the heading\"), not its words.",
].join("\n");

/**
 * The modify-in-place rule, added when `write` overwrites an EXISTING file.
 *
 * This is the `OVERWRITE_SCOPE` the doc comments reference: a whole-file write
 * that re-authors an existing file must preserve the bytes the task did not ask
 * to change. Without it the authoring model treats "output the COMPLETE updated
 * file" as "produce the file for this task" and re-derives it from the task text
 * alone — regressing parts the task never mentioned. The observed failure: an
 * already-correct `<title>kofin</title>` was rewritten to `<title>Solar
 * System</title>` because the run-level task said "solar system" and the
 * authoring model, asked for the whole file with no preserve-unchanged
 * instruction, normalised the title toward the dominant signal.
 *
 * Stated as a hard rule rather than advice because the regression is silent:
 * the call succeeds, the file is valid, and only the diff reveals that work
 * which was already done has been undone. The existing file is the ground
 * truth; the task names only the delta.
 */
const OVERWRITE_SCOPE = [
  "This write OVERWRITES an existing file. The current file contents are provided below as the ground truth.",
  "Your job is to apply the task's intended change to that file — NOT to re-derive or reimagine the file.",
  "KEEP UNCHANGED everything the task does not explicitly ask to change: copy it VERBATIM from the current",
  "  contents, byte for byte, including code, text, comments, formatting and ordering you might otherwise",
  "  'improve'. A whole-file rewrite that silently normalises, rephrases, or reverts already-correct content",
  "  (a title that was just set, a fix that was just applied) is a regression, not a cleanup.",
  "If the task names a specific, narrow change (a title, a value, one function), apply ONLY that change and",
  "  leave the rest of the file exactly as it is. When in doubt, the existing bytes win over your reading of",
  "  the task.",
].join("\n");

/**
 * Replication guidance when the reference is a raw IMAGE attached to the call.
 *
 * The structural counterpart to {@link DESIGN_REUSE_BOUNDARY}, for the case
 * where no blueprint was extracted and the screen image is handed to the
 * authoring model directly. Without this, a vision authoring pass for a UI
 * write got only {@link FORMAT_CONTRACT} — the same bare "output raw file
 * contents" a logic write gets — so nothing told the model to replicate the
 * image faithfully or, just as important, to fill it with THIS project's
 * content and theme tokens instead of the source's verbatim copy, hex values
 * and brand marks. The image is enough input; this prompt is what makes the
 * output a *replication* rather than an improvisation on the image.
 *
 * The discipline mirrors the boundary: structure is borrowed (layout, spacing
 * rhythm, component anatomy, hierarchy, section order, motion), surface is
 * replaced (copy, hex, fonts, imagery, icons). The boundary governs a
 * structured blueprint; this governs the raw image. Both apply only to
 * `ui`/`svg` authoring — a logic write with an image (a screenshot of an error)
 * is reference material, not a thing to replicate.
 */
const REPLICATE_FROM_IMAGE = [
  "A reference IMAGE is attached. Reproduce its STRUCTURE faithfully and rebuild it as this project's own.",
  "KEEP FAITHFUL (this is structure, and structure is what you are replicating):",
  "  - the layout grid and the section order top-to-bottom;",
  "  - the spacing rhythm and the RELATIVE sizes (a heading is ~3x body, a card gap is ~half its padding) —",
  "    absolute pixels are not required, the ratios are;",
  "  - the component anatomy — which parts each component has, how they nest, alignment and distribution;",
  "  - the hierarchy — what is primary, secondary, tertiary; which element carries each section;",
  "  - the responsive behaviour, sticky/fixed elements, overflow/truncation, z-order you can infer;",
  "  - any motion you can see (sticky, parallax, scroll-tied) — reproduce it via CSS scroll-timeline,",
  "    IntersectionObserver + rAF, or the project's animation library.",
  "REPLACE WITH THIS PROJECT'S OWN (this is surface, and surface is never borrowed):",
  "  - copy — every heading, label, button text, nav item, caption. Write the project's real copy where you",
  "    know it, or an obvious neutral placeholder where you do not. Never the source's words.",
  "  - colors — map each role you see (\"primary accent\", \"surface\", \"muted text\", \"primary gradient\") to",
  "    THIS project's theme tokens (CSS custom properties, Tailwind classes, the theme file the current file",
  "    already uses). Never the source's literal hex values.",
  "  - fonts and type — use the project's type scale, not the source's family.",
  "  - images, logos, icons and brand marks — describe their ROLE and aspect ratio, then regenerate them with",
  "    `assets_generator` or use the project's existing icon set. Never assume the source's image filenames or",
  "    reproduce its brand marks.",
  "Where you cannot tell something from the image (a crop edge, a state not shown, the platform), say so in a",
  "  comment rather than inventing it. Match the image's ROLE for each element; fill that role with this",
  "  project's content.",
].join("\n");

/**
 * The escalated read's analysis, rendered for the authoring prompt.
 *
 * Attributed and fenced off as ANALYSIS so the author never mistakes it for file
 * bytes or for the task, and labelled with the model that produced it — the same
 * discipline `read` uses when it appends this to the orchestrator's context.
 */
function comprehensionSection(
  comprehension: { analysis: string; model: string; why?: string } | undefined,
): string | undefined {
  if (!comprehension?.analysis.trim()) return undefined;
  return [
    `ANALYSIS OF THIS FILE (from ${comprehension.model}, which read it in full` +
      `${comprehension.why ? `; rated hard because: ${comprehension.why}` : ""}):`,
    "This is prior analysis, not file contents and not instructions to copy.",
    "It names the invariants and traps in this file — honour them in what you write.",
    comprehension.analysis,
  ].join("\n");
}

/** Render the harness-generated assets as a prompt block, or undefined if none. */
function generatedAssetsSection(assets: GeneratedAssetRef[] | undefined): string | undefined {
  if (!assets?.length) return undefined;
  const list = assets
    .map((a) => `- ${a.role} (${a.kind})${a.placeholder ? " [PLACEHOLDER — no real backend; swap in a real file or flag it to the user]" : ""}: ${a.path}`)
    .join("\n");
  return (
    "GENERATED ASSETS (the harness generated these from the design reference — " +
    "embed the path for each role, e.g. <img src> / <video src> / <audio src>):\n" +
    list
  );
}

function systemFor(category: ComplexityCategory | undefined, hasImages: boolean): string {
  // Vision authoring is judged against the image, and the checklist is prose
  // about control flow — it competes for attention with the thing being matched.
  if (hasImages || category === "ui" || category === "svg") return FORMAT_CONTRACT;
  return `${FORMAT_CONTRACT}\n\n${CODE_RISK_FOR_AUTHORING}`;
}

/**
 * Assemble the system prompt, layering reference guidance by precedence.
 *
 * Three tiers, in order:
 *   1. `hasDesign` — a structured blueprint from `inspiration_generator` or the
 *      design skill. Governs reuse via {@link DESIGN_REUSE_BOUNDARY}.
 *   2. raw image, `ui`/`svg` only — no blueprint, but a screen image travels
 *      with the call. Governs replication via {@link REPLICATE_FROM_IMAGE}.
 *   3. bare — format contract alone (or with the code checklist for logic).
 *
 * A blueprint always wins over a raw image, because a blueprint is already the
 * structured extraction an image would be asked to produce. The replication
 * block is withheld from logic writes that happen to carry an image (a
 * screenshot of a stack trace is reference material, not a thing to replicate)
 * — the `ui`/`svg` gate is what holds that line.
 */
function systemWithReference(
  category: ComplexityCategory | undefined,
  hasImages: boolean,
  hasDesign: boolean,
): string {
  const base = systemFor(category, hasImages);
  if (hasDesign) return `${base}\n\n${DESIGN_REUSE_BOUNDARY}`;
  if (hasImages && (category === "ui" || category === "svg")) {
    return `${base}\n\n${REPLICATE_FROM_IMAGE}`;
  }
  return base;
}

export interface AuthorFileContentInput {
  llm: LLMBridge;
  model: Model;
  /** Absolute (or cwd-relative) path being authored. */
  path: string;
  /**
   * What kind of work this is: `code` (logic, config, tests), `ui` (rendered
   * interface), or `svg` (vector artwork).
   *
   * It selects the system prompt (see `systemFor`): `code` gets the correctness
   * checklist, `ui`/`svg` get the bare format contract. It is ALSO the axis the
   * HOST routes on: `ctx.routeModel`
   * is asked for a model by (kind, rating, category), so "author this UI from a
   * mockup" can be pinned to a model strong at spatial reasoning rather than one
   * picked for logic. Carried here so the record of what this call was survives to
   * the logs and to any host-supplied backend.
   */
  category?: ComplexityCategory;
  /** The originating task the chain is working on. */
  task?: string;
  /** Structured PLAN_JSON handed from Plan to Perform, if any. */
  planJson?: unknown[];
  /** Borrowed section blueprints; see {@link AuthoringContext.designReference}. */
  designReference?: unknown[];
  /**
   * Informational text the authoring model should KNOW (e.g. OCR of an
   * informational attachment, a captured spec). Distinct from `images` (pixels
   * to replicate) and `designReference` (structure to borrow): this is reference
   * text the task already paid to extract. See {@link AuthoringContext.mediaFact}.
   */
  mediaFact?: string;
  /** Harness-generated assets; see {@link AuthoringContext.generatedAssets}. */
  generatedAssets?: GeneratedAssetRef[];
  /**
   * Model A's own draft of the file contents — what it decided this write should
   * produce. See `AuthorEditReplacementInput.draftReplacement`: same reasoning,
   * same failure if omitted. B authors the bytes; this states the intent.
   */
  draft?: string;
  /** Bounded snippets of surrounding files, if any. */
  fileSnippets?: Array<{ path: string; content: string }>;
  /**
   * Current full contents of the target file, when it already exists.
   *
   * Load-bearing, not context: `write` OVERWRITES, so without this the authoring
   * model was asked to produce a whole file from the task text alone and had no
   * way to know what was already there. "Redesign the header" then produced an
   * entire invented site, because a full-file author with no file is a full-file
   * author from imagination. Its presence also switches the system prompt into
   * modify-in-place mode (see `OVERWRITE_SCOPE`).
   */
  currentContent?: string;
  /**
   * Image references for a vision authoring pass. When present, `model` is
   * expected to be vision-capable and the file is authored from the image(s).
   * Each entry is a path/URL read by this helper (the media_analysis pattern),
   * not inline base64 on the input.
   */
  images?: Array<{ path: string; mimeType: string }>;
  /**
   * What the escalated `read` worked out about this file, when there was one.
   *
   * This is the hand-off that makes the two halves one system. Without it the
   * strong model's analysis reached the author only as the ORCHESTRATOR's
   * paraphrase — B explains the file, A summarises the explanation, and B-as-author
   * writes the bytes having never seen the original. Passed through verbatim.
   */
  comprehension?: { analysis: string; model: string; why?: string };
  /**
   * The READ's independent difficulty rating for this file, when one exists.
   *
   * Not the orchestrator's self-declared `complexity` argument: that is a claim by
   * the model asking for the write, about a file it may only half understand. This
   * one was produced by a pass that had the bytes in hand. It sets the authoring
   * effort (see {@link AUTHORING_EFFORT}).
   */
  rating?: ComplexityRating;
  signal?: AbortSignal;
}

export interface AuthorEditReplacementInput {
  llm: LLMBridge;
  model: Model;
  /** Absolute (or cwd-relative) path being edited. */
  path: string;
  /** See {@link AuthorFileContentInput.category}. */
  category?: ComplexityCategory;
  /** Model A's anchor: the exact text being replaced. Preserved verbatim. */
  oldString: string;
  /**
   * Model A's own draft replacement — what it decided this edit should DO.
   *
   * Load-bearing, not diagnostics. Without it Model B receives an anchor plus the
   * RUN-level task ("redesign the header") and has to invent the replacement, so it
   * never learns what this particular edit was for. Model A planned the edit with
   * the whole conversation in view; B gets one string. The observed result was B
   * re-deriving the goal from scratch per anchor, the driver seeing a change it did
   * not ask for and editing again to correct it, and the file progressively being
   * consumed.
   *
   * B still authors the bytes — this is the INTENT to execute well, not text to
   * copy.
   */
  draftReplacement?: string;
  /** The originating task the chain is working on. */
  task?: string;
  /** Borrowed section blueprints; see {@link AuthoringContext.designReference}. */
  designReference?: unknown[];
  /** Informational reference text; see {@link AuthorFileContentInput.mediaFact}. */
  mediaFact?: string;
  /** Harness-generated assets; see {@link AuthorFileContentInput.generatedAssets}. */
  generatedAssets?: GeneratedAssetRef[];
  /** Current full contents of the target file (read from disk by the tool). */
  currentContent?: string;
  /**
   * Image references for a vision authoring pass (same contract as the write
   * helper's `images`). The anchor is still preserved; only the replacement text
   * is authored from the image(s).
   */
  images?: Array<{ path: string; mimeType: string }>;
  /** See {@link AuthorFileContentInput.comprehension}. */
  comprehension?: { analysis: string; model: string; why?: string };
  /** See {@link AuthorFileContentInput.rating}. */
  rating?: ComplexityRating;
  signal?: AbortSignal;
}

export interface AuthorResult {
  /** The authored text (file contents for write, replacement for edit). */
  text: string;
  /** Token usage incurred by the authoring call (folded into the chain total). */
  usage: Usage;
  /**
   * Markdown artifacts removed from the reply, when any were.
   *
   * Surfaced rather than swallowed: silently repairing a model's output makes a
   * misbehaving model look like a working one, and the first anyone knew of the
   * old stripper's gaps was corrupted source in a user's repo. A caller that
   * reports this puts "the author wrapped its answer in a fence" in the
   * transcript, where it is a fact about the model rather than a mystery.
   */
  sanitized?: { fencesRemoved: number; proseRemoved: boolean };
}

/**
 * Have Model B author the full contents of a file from scratch. Returns the raw
 * text (with any accidental ``` fences stripped) and the call's usage. On any
 * failure (empty output / endpoint error) the caller surfaces a clear error and
 * never falls back to Model A's draft — the contract is "B authors".
 */
export async function authorFileContent(input: AuthorFileContentInput): Promise<AuthorResult> {
  const imageBlocks = await loadImages(input.images);
  const baseSystemPrompt = systemWithReference(
    input.category,
    imageBlocks.length > 0,
    (input.designReference?.length ?? 0) > 0,
  );
  // When overwriting an existing file, add the modify-in-place rule so the
  // authoring model preserves unchanged content instead of re-deriving the
  // whole file from the task and silently regressing work already on disk.
  // Truthiness, not `!= null`: an empty `currentContent` is a creation, not a
  // modification (mirrors the gate in coding.ts that forwards it at all).
  const systemPrompt = input.currentContent ? `${baseSystemPrompt}\n\n${OVERWRITE_SCOPE}` : baseSystemPrompt;
  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: buildWriteUserMessage(input, imageBlocks),
        timestamp: Date.now(),
      },
    ],
  };
  return completeWithRetry(input.llm, input.model, context, input.signal, input.rating, input.path);
}

/**
 * Run the authoring completion, retrying ONCE if it comes back empty.
 *
 * An empty completion is usually transient — a truncated stream, a momentary
 * refusal — and the caller's alternative is expensive: the tool fails, nothing is
 * written, and the model spends a whole extra turn re-issuing the same call with
 * the same arguments. One cheap retry converts most of those turns into a write.
 *
 * The retry nudges rather than repeats verbatim: an identical request to a
 * temperature-0 endpoint tends to reproduce an identical (empty) answer.
 * Usage from BOTH attempts is billed, because both were paid for.
 */
async function completeWithRetry(
  llm: LLMBridge,
  model: Model,
  context: Context,
  signal?: AbortSignal,
  rating?: ComplexityRating,
  /** Target path, so Markdown keeps its fences and code does not. */
  path?: string,
): Promise<AuthorResult> {
  const budget = authoringBudget(rating);
  const first = await llm.complete(model, context, { temperature: 0, signal, ...budget });
  // The bridge does NOT throw on a failed request — it returns a message with
  // `stopReason: "error"` and the cause in `errorMessage`. Ignoring that made a
  // request that never reached the provider (bad slug, auth, quota, network)
  // indistinguishable from a model that answered with nothing, and reported the
  // wrong one. Retrying it is pointless: the second call fails identically.
  if (first.stopReason === "error") {
    throw new AuthoringError(
      `the authoring request to ${model.openRouterSlug ?? model.id} FAILED before producing ` +
        `any output: ${first.errorMessage ?? "no error detail returned"}. ` +
        `No request reached the provider, so this is a configuration or transport problem, ` +
        `not a model-quality one.`,
    );
  }
  const cleaned = stripFences(extractText(first.content), path);
  const text = cleaned.text;
  const usage = first.usage ?? emptyUsage();
  if (text.trim()) {
    // Truncated bytes are worse than none: a half-written file overwrites a whole
    // one, and the caller cannot tell the difference from a successful author.
    if (first.stopReason === "length") {
      throw new AuthoringError(
        `output was truncated at the completion limit (${usage.output} output tokens). ` +
          `The file was NOT written. Raise the limit or split the change into smaller edits.`,
      );
    }
    return {
      text,
      usage,
      ...(cleaned.fencesRemoved || cleaned.proseRemoved ? { sanitized: { fencesRemoved: cleaned.fencesRemoved, proseRemoved: cleaned.proseRemoved } } : {}),
    };
  }
  // Empty text with a thinking block is the reasoning-runaway signature: the model
  // spent its budget in `reasoning` and never emitted `content`. This is the MOST
  // recoverable empty response — the model was mid-thought, not refusing — so it
  // takes the same nudge-and-retry as a plain empty answer, at LOWERED reasoning
  // effort (the first attempt proved the effort outruns the budget). Throwing
  // here, as this used to, is a field-proven triple loss: the 32k-token bill is
  // paid, the tool fails, and the calling model burns extra turns rediscovering
  // the self-serve path (read again → shell edit refused → read again).
  const runaway = hasThinking(first.content);

  const retryContext: Context = {
    ...context,
    messages: [
      ...context.messages,
      {
        role: "user",
        content:
          "Your last response was empty. Output the file contents now — raw text only, " +
          "no fences, no commentary, no explanation of why." +
          (runaway ? " Do NOT reason first: emit the contents as your response." : ""),
        timestamp: Date.now(),
      },
    ],
  };
  const second = await llm.complete(model, retryContext, {
    temperature: 0,
    signal,
    ...(runaway ? { reasoning: "low" } : budget),
  });
  if (second.stopReason === "error") {
    throw new AuthoringError(
      `the authoring retry to ${model.openRouterSlug ?? model.id} also failed: ` +
        `${second.errorMessage ?? "no error detail returned"}.`,
    );
  }
  const cleanedSecond = stripFences(extractText(second.content), path);
  const secondText = cleanedSecond.text;
  const total = mergeUsage(usage, second.usage ?? emptyUsage());
  if (!secondText.trim() && (runaway || hasThinking(second.content))) {
    throw new AuthoringError(
      `model returned only reasoning and no content on both attempts (${total.output} output ` +
        `tokens total, including a retry at LOW reasoning effort). It never began writing the ` +
        `file. Cap reasoning tokens for authoring, or pin a model that answers within its budget.`,
    );
  }
  if (secondText.trim() && second.stopReason === "length") {
    throw new AuthoringError(
      `output was truncated at the completion limit on retry (${total.output} output tokens). ` +
        `The file was NOT written.`,
    );
  }
  return {
    text: secondText,
    usage: total,
    ...(cleanedSecond.fencesRemoved || cleanedSecond.proseRemoved
      ? { sanitized: { fencesRemoved: cleanedSecond.fencesRemoved, proseRemoved: cleanedSecond.proseRemoved } }
      : {}),
  };
}

/**
 * Reasoning EFFORT for every internal authoring call.
 *
 * The strong model was escalated to precisely because its judgment is the point —
 * so on a hard write it must think at the hardest effort the provider offers, not
 * the default. The provider default is `medium`, and a hard write at medium effort
 * is indistinguishable from the orchestrator's own turn. That is the failure mode
 * this whole feature exists to prevent.
 *
 * Expressed as `effort` (→ OpenAI `reasoning_effort` / Anthropic thinking level),
 * the axis that actually drives quality for GPT-5-family and Claude. The earlier
 * form was `{ reasoningMaxTokens: 8000 }`, which the bridge turns into
 * `reasoning: { max_tokens }` — a CEILING, not a level. For OpenAI models a token
 * ceiling is near-meaningless, so the escalation silently ran at provider-default
 * effort and a top-tier model produced orchestrator-grade bytes. `effort` is what
 * closes that gap; `max_tokens` never could.
 *
 * `effort` and `max_tokens` are mutually exclusive on OpenRouter (a request with
 * both is a 400 that never reaches the provider and leaves no upstream trace), so
 * exactly one is sent. The runaway failure the old ceiling guarded against — a
 * model that thinks until `content: null` — is handled structurally below, in
 * `completeWithRetry`: truncation (`stopReason: "length"`) and reasoning-only-no-
 * content both throw `AuthoringError` instead of producing a silent bad write, so
 * dropping the ceiling does not reintroduce the empty-response trap.
 *
 * SCALED BY RATING, as of the comprehension hand-off. The paragraph above argues
 * for `high` on a HARD write and it is still right about that — what it did not
 * cover is the easy one. Every authored call ran at max effort regardless, which
 * put a cheap model at maximum effort on a trivial file: that is the exact
 * reasoning-runaway this file already carries a retry for (`completeWithRetry`,
 * "returned ONLY reasoning and no content"). The ceiling for a hard write has not
 * moved; only the floor for an easy one has.
 *
 * The rating is the READ's independent judgement of the file where one exists,
 * not the orchestrator's self-declared `complexity` argument — see
 * `recallComprehension`. That is the point of the whole change: the model that
 * understood the file decides how hard the model that writes it should think.
 */
const AUTHORING_EFFORT: Record<ComplexityRating, "medium" | "high"> = {
  // Never below medium: this model is authoring bytes that land on disk, and the
  // provider default is what the orchestrator already runs at.
  low: "medium",
  medium: "high",
  high: "high",
};

function authoringBudget(rating: ComplexityRating | undefined) {
  return { reasoning: AUTHORING_EFFORT[rating ?? "high"] };
}

/** Whether a response carried a reasoning/thinking block. */
function hasThinking(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((c) => typeof c === "object" && c !== null && (c as { type?: string }).type === "thinking")
  );
}

/** Authoring failure with a message the caller surfaces verbatim to the model. */
export class AuthoringError extends Error {}

/** Sum the usage of both authoring attempts so cost accounting stays honest. */
function mergeUsage(a: Usage, b: Usage): Usage {
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

/**
 * Have Model B author the replacement text for an anchored edit region. The
 * caller keeps Model A's `oldString` anchor (an edit needs an anchor); this
 * produces only the `newString`. Returns the raw replacement + usage.
 */
export async function authorEditReplacement(input: AuthorEditReplacementInput): Promise<AuthorResult> {
  const imageBlocks = await loadImages(input.images);
  const systemPrompt = systemWithReference(
    input.category,
    imageBlocks.length > 0,
    (input.designReference?.length ?? 0) > 0,
  );
  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: buildEditUserMessage(input, imageBlocks),
        timestamp: Date.now(),
      },
    ],
  };
  return completeWithRetry(input.llm, input.model, context, input.signal, input.rating, input.path);
}

function buildWriteUserMessage(input: AuthorFileContentInput, imageBlocks: ImageContent[]): string | UserContent[] {
  const parts: string[] = [];
  const modifying = input.currentContent != null;
  parts.push(`${modifying ? "MODIFY THE EXISTING FILE" : "AUTHOR THE FILE"}: ${input.path}`);
  if (input.task) parts.push(`TASK:\n${input.task}`);
  const analysisForWrite = comprehensionSection(input.comprehension);
  if (analysisForWrite) parts.push(analysisForWrite);
  if (modifying) {
    parts.push(`CURRENT FILE CONTENTS:\n\`\`\`\n${input.currentContent}\n\`\`\``);
  }
  if (input.planJson?.length) parts.push(`PLAN:\n${JSON.stringify(input.planJson, null, 2)}`);
  if (input.designReference?.length) {
    parts.push(`DESIGN REFERENCE (structure only — see the reuse rules):\n${JSON.stringify(input.designReference, null, 2)}`);
  }
  if (input.mediaFact) {
    parts.push(`KNOWN CONTEXT FROM AN ATTACHMENT (informational — use this text; do not re-derive it):\n${input.mediaFact}`);
  }
  const genAssetsW = generatedAssetsSection(input.generatedAssets);
  if (genAssetsW) parts.push(genAssetsW);
  if (input.fileSnippets?.length) {
    const sections = input.fileSnippets
      .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n");
    parts.push(`RELATED FILES:\n${sections}`);
  }
  parts.push(
    modifying
      ? "Output the COMPLETE updated file — the current contents with ONLY the task's change applied, everything else verbatim."
      : "Output ONLY the raw contents of the file named above.",
  );
  const text = parts.join("\n\n");
  if (!imageBlocks.length) return text;
  return [{ type: "text", text: imageIntro(input.images) + text }, ...imageBlocks];
}

function buildEditUserMessage(input: AuthorEditReplacementInput, imageBlocks: ImageContent[]): string | UserContent[] {
  const parts: string[] = [];
  parts.push(`FILE BEING EDITED: ${input.path}`);
  if (input.task) parts.push(`TASK:\n${input.task}`);
  const analysisForEdit = comprehensionSection(input.comprehension);
  if (analysisForEdit) parts.push(analysisForEdit);
  if (input.currentContent != null) {
    parts.push(`CURRENT FILE CONTENTS:\n\`\`\`\n${input.currentContent}\n\`\`\``);
  }
  // "do NOT include it in your output" used to sit on the header line here. It
  // meant "don't echo the fences", but it reads as "don't reproduce this text" —
  // and a model replacing a multi-line region obeyed it literally, returning only
  // the one line it wanted to change. The tool splices that back with
  // `text.replace(oldString, newString)`, so every other line the anchor spanned
  // was DELETED, silently and with a successful result. Stating the splice
  // explicitly is what stops it: the output stands in for the whole anchor, so
  // anything inside the anchor that should survive has to be in the output.
  if (input.designReference?.length) {
    parts.push(`DESIGN REFERENCE (structure only — see the reuse rules):\n${JSON.stringify(input.designReference, null, 2)}`);
  }
  if (input.mediaFact) {
    parts.push(`KNOWN CONTEXT FROM AN ATTACHMENT (informational — use this text; do not re-derive it):\n${input.mediaFact}`);
  }
  const genAssetsE = generatedAssetsSection(input.generatedAssets);
  if (genAssetsE) parts.push(genAssetsE);
  parts.push("TEXT TO REPLACE (the anchor):");
  parts.push("```");
  parts.push(input.oldString);
  parts.push("```");
  parts.push(
    "Your output REPLACES the entire anchor above, exactly. Anything in the anchor " +
      "that should remain in the file must appear in your output — omitting a line " +
      "deletes it. Output ONLY the replacement text (no fences, no commentary).",
  );
  const text = parts.join("\n\n");
  if (!imageBlocks.length) return text;
  return [{ type: "text", text: imageIntro(input.images) + text }, ...imageBlocks];
}

/** Prefix telling the authoring model images follow the instructions. */
function imageIntro(images: Array<{ path: string; mimeType: string }> | undefined): string {
  if (!images?.length) return "";
  const list = images.map((img, i) => `${i + 1}. ${img.path} (${img.mimeType})`).join("\n");
  return `Author this file from the image(s) below. Reference:\n${list}\n\n`;
}

/**
 * Read the referenced images into base64 `{type:"image"}` blocks (mirrors
 * media_analysis). A path that can't be read is dropped (the model still gets
 * the rest); MIME falls back to extension guessing when the caller didn't pin it.
 * Returns an empty array when no images are supplied so the caller can keep the
 * plain-text authoring path unchanged.
 */
async function loadImages(
  images: Array<{ path: string; mimeType: string }> | undefined,
): Promise<ImageContent[]> {
  if (!images?.length) return [];
  const out: ImageContent[] = [];
  for (const entry of images) {
    try {
      const bytes = await fs.readFile(entry.path);
      out.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: entry.mimeType || guessMimeType(entry.path),
      });
    } catch {
      // Skip unreadable images; the model still gets the textual instructions.
    }
  }
  return out;
}

/** Pull the concatenated text blocks out of an assistant message's content. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Strip markdown artifacts from authored output.
 *
 * Delegates to `authored-output.ts`, which handles the shapes a real model
 * emits — unbalanced fences, tilde fences, surrounding narration, a fence with
 * a trailing space in its info string — rather than only the perfectly balanced
 * one this function used to match. See that module for the run it comes from.
 *
 * `path` decides whether a fence is content: a Markdown target keeps its
 * fences, everything else does not.
 */
function stripFences(text: string, path?: string): SanitizedOutput {
  return sanitizeAuthoredText(text, path ? { path } : {});
}
