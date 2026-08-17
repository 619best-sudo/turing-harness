/**
 * Internal tool: media_analysis.
 *
 * Sends one or more attachments — image, video, audio or document — plus a prompt
 * to a multimodal model over OpenRouter and returns the model's analysis.
 *
 * This is the general-purpose "look at this and tell me about it" tool: read a
 * screenshot, understand a mockup BEFORE building it, diagnose a visual bug, skim
 * a spec PDF, transcribe a voice note, find where a screen recording breaks. It
 * replaces the image-only `image_analysis` (itself formerly `ui_screen_auditor`) —
 * every modality the LLM bridge can carry is now reachable through one tool.
 *
 * The caller can pass a single `file` or a list of `files`, and may pin `type`
 * when the extension is misleading; otherwise the modality is inferred per file.
 * Attachments are read from disk on demand, so a run that never analyzes one
 * never pays to load it.
 *
 * Generation is deliberately NOT here — `assets_generator` owns producing media.
 * This tool only ever reads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, Context, ToolContext, Usage, UserContent } from "../../types.js";
import type { Registry } from "../../registry/registry.js";
import {
  hashImageBytes,
  hashPrompt,
  rememberMediaAnalysis,
  recallMediaAnalysis,
} from "./media-analysis-reuse.js";

/** The modalities this tool can hand to a model. */
export type MediaKind = "image" | "video" | "audio" | "document";

/** One attachment the tool resolved, classified and verified readable. */
export interface ResolvedMedia {
  /** Absolute path on disk. */
  path: string;
  kind: MediaKind;
  mimeType: string;
  /** Size in bytes. */
  bytes: number;
  /**
   * Whether the backend should ship the bytes inline (base64) or reference the
   * path. Video is always referenced; anything over {@link MAX_INLINE_BYTES} is
   * too, so one oversized attachment can't blow up the request.
   */
  inline: boolean;
}

export interface MediaAnalysisResult {
  /** The model's analysis. */
  analysis: string;
  /** Attachments actually sent (rejected paths are reported, not sent). */
  analyzed: ResolvedMedia[];
  /** Path of the screenshot this call captured from `url`, when it did. */
  screenshot?: string;
  /**
   * Auto-triage of the attachment's ROLE in the task, so the loop can route it
   * (informational text → fold into context; ui-replicate → vision authoring;
   * ui-bug → debugging authoring) without a second analysis. Parsed from the
   * trailing `CATEGORY:` line every lens prompt asks for; absent when the model
   * omits it (the loop then treats the attachment as undifferentiated).
   */
  category?: MediaAnalysisCategory;
  /**
   * Verbatim text extracted under the `ocr` lens. Populated ONLY for
   * `lens:"ocr"`; other lenses leave this unset. Mirrors `analysis` (kept as the
   * model-facing output) but as a discrete field so downstream tool calls can
   * consume the OCR text without re-parsing prose.
   */
  ocr?: { text: string };
}

export type MediaAnalysisCategory = "informational" | "ui-replicate" | "ui-bug" | "other";

/**
 * The single category directive appended to every lens prompt. Kept constant so
 * the parser in `execute` can recover it from the trailing line regardless of
 * lens. The four values match the loop's routing needs, not the lens taxonomy:
 * even an `ocr` run triages whether the text is reference info or a UI bug.
 */
const CATEGORY_DIRECTIVE =
  "\n\nEnd your response with a final line of exactly the form `CATEGORY: <value>` where <value> is ONE of:\n" +
  "- informational — the attachment is reference material the task should know (text, a stack trace, a spec, a screenshot of data).\n" +
  "- ui-replicate — the attachment is a UI mockup/screenshot the task should rebuild (replicate) in code.\n" +
  "- ui-bug — the attachment shows a UI defect the task is fixing (broken layout, wrong render, visual glitch).\n" +
  "- other — none of the above. This line is mandatory.";

/**
 * Appended to every lens alongside the category directive. A coordinate an
 * analysis reports is about to be converted and tapped, so it must live in the
 * coordinate system of the ACTUAL image bytes — not a presumed 1080p/retina
 * frame. A real run asked for an element's position, got (860,100) "in image
 * pixels" for a 185×402 image, and burned its remaining turns reconciling
 * impossible numbers. State the real dimensions first; never report a
 * coordinate outside them.
 */
const DIMENSIONS_DIRECTIVE =
  "\n\nIf you report any position, box or coordinate: FIRST state the pixel dimensions of the image you " +
  "actually see (e.g. 'Image: 185×402 px'), and give every coordinate IN THOSE pixels, within those " +
  "bounds. Never scale to an assumed screen size or normalize to another coordinate system — report " +
  "raw image pixels only.";

const DEFAULT_ANALYSIS_MODEL = "google/gemini-3.7-flash";

/**
 * Above this, bytes are referenced by path instead of inlined. Base64 inflates
 * payloads ~33% and most providers cap request size well before a large video or
 * scanned PDF would fit, so the cutoff protects the request rather than the disk.
 */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** extension → [kind, mimeType]. The inference table, single source of truth. */
const MEDIA_TYPES: Record<string, readonly [MediaKind, string]> = {
  // images
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".svg": ["image", "image/svg+xml"],
  ".bmp": ["image", "image/bmp"],
  ".avif": ["image", "image/avif"],
  ".heic": ["image", "image/heic"],
  // video
  ".mp4": ["video", "video/mp4"],
  ".mov": ["video", "video/quicktime"],
  ".webm": ["video", "video/webm"],
  ".mkv": ["video", "video/x-matroska"],
  ".avi": ["video", "video/x-msvideo"],
  ".m4v": ["video", "video/x-m4v"],
  // audio
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".m4a": ["audio", "audio/mp4"],
  ".aac": ["audio", "audio/aac"],
  ".ogg": ["audio", "audio/ogg"],
  ".flac": ["audio", "audio/flac"],
  ".opus": ["audio", "audio/opus"],
  // documents
  ".pdf": ["document", "application/pdf"],
  ".docx": ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".pptx": ["document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".xlsx": ["document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".csv": ["document", "text/csv"],
  ".txt": ["document", "text/plain"],
  ".md": ["document", "text/markdown"],
};

/** Fallback mime per kind, used when `type` is pinned but the extension is unknown. */
const KIND_FALLBACK_MIME: Record<MediaKind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/octet-stream",
};

/**
 * Resolve a (possibly relative) media path to an absolute one that exists.
 *
 * Absolute paths are taken as-is. Relative paths are first joined to `cwd`
 * (the run's project directory); if that file does not exist, the host
 * process CWD is tried as a fallback. The fallback exists because MCP tools —
 * notably browser/screenshot servers — write artifacts relative to the MCP
 * SERVER's own working directory, which is the host process CWD, not the
 * project `cwd` this run edits. Without the fallback a path like
 * `.playwright-mcp/page-*.png` resolves under the project dir and ENOENTs,
 * even though the file exists where the MCP server actually wrote it.
 *
 * Returns the resolved path and whether it exists; the caller still `stat`s
 * it for size, so a non-existent resolution is reported normally.
 */
export async function resolveMediaPath(
  p: string,
  cwd: string,
): Promise<{ path: string; exists: boolean }> {
  if (path.isAbsolute(p)) {
    try {
      await fs.stat(p);
      return { path: p, exists: true };
    } catch {
      return { path: p, exists: false };
    }
  }
  const underCwd = path.join(cwd, p);
  try {
    await fs.stat(underCwd);
    return { path: underCwd, exists: true };
  } catch {
    // Fall through to the process CWD only when it differs from `cwd`: a host
    // whose process already runs in the project dir gains nothing from a retry
    // against the same base, and the double stat would just delay the ENOENT.
    const procCwd = process.cwd();
    if (procCwd && path.resolve(procCwd) !== path.resolve(cwd)) {
      const underProc = path.join(procCwd, p);
      try {
        await fs.stat(underProc);
        return { path: underProc, exists: true };
      } catch {
        return { path: underCwd, exists: false };
      }
    }
    return { path: underCwd, exists: false };
  }
}

/**
 * Classify one path. `pinned` (the caller's `type`) wins over the extension —
 * that is the escape hatch for a screenshot saved as `.tmp` or a PDF with no
 * suffix. Returns undefined when neither source can name a modality, so the
 * caller can ask for an explicit `type` instead of guessing and burning tokens
 * on a payload the model can't interpret.
 */
export function classifyMedia(
  file: string,
  pinned?: MediaKind,
): { kind: MediaKind; mimeType: string } | undefined {
  const known = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (pinned) {
    return {
      kind: pinned,
      mimeType: known?.[0] === pinned ? known[1] : KIND_FALLBACK_MIME[pinned],
    };
  }
  if (!known) return undefined;
  return { kind: known[0], mimeType: known[1] };
}

/** What the tool hands a backend: the resolved prompt + the media to look at. */
export interface MediaAnalysisRequest {
  /** The caller's prompt. */
  prompt: string;
  /** The system prompt framing the analysis. */
  systemPrompt: string;
  /** Resolved attachments, already classified and verified readable. */
  attachments: ResolvedMedia[];
  /** Model slug the caller/config pinned, if any. */
  model?: string;
}

/**
 * A multimodal backend: given attachments + a prompt, return the model's text.
 *
 * This is the seam for hosts that don't want the bundled OpenRouter path — e.g.
 * routing analysis through a different provider, a proxy, or a local model. The
 * tool keeps ownership of everything around the call (resolving paths, classifying
 * modality, deciding inline vs. by-reference), so a backend only has to do the
 * request itself.
 */
export type MediaAnalysisBackend = (
  req: MediaAnalysisRequest,
  ctx: ToolContext,
) => Promise<{ text: string; usage?: Usage }>;

export interface MediaAnalysisConfig {
  /** Model slug used for the analysis pass. MUST be multimodal. */
  model?: string;
  /**
   * Host-supplied backend. When omitted, the bundled OpenRouter path runs via
   * `ctx.llm` — so this stays optional and the tool works out of the box.
   */
  analyze?: MediaAnalysisBackend;
  /**
   * Whether repeated analyses of the same attachment (same bytes + lens +
   * prompt) reuse a cached result instead of re-calling the model. Default
   * `true`: a run that looks at a screen twice should not pay twice. A test or
   * host that needs every call to hit the provider sets this `false`.
   */
  cache?: boolean;
}

/**
 * The lenses this tool can look through.
 *
 * One generic "describe this" prompt served every caller badly: transcription
 * wants verbatim text and no interpretation, rebuilding a screen wants structure
 * and design tokens, a single component wants anatomy and states, and verifying an
 * implementation wants a pass/fail verdict with defects. Same model, same
 * attachments — what changes is what it is asked to produce.
 */
export type MediaLens = "describe" | "ocr" | "ui" | "component" | "qa" | "compare";

/** The per-lens system prompts (with the shared directives appended). */
export const LENS_SYSTEM: Record<MediaLens, string> = {
  describe: [
    "You are a precise media analyst. You are given one or more attachments — images, video, audio or",
    "documents — and a question or instruction. Answer it directly and concretely, grounded in what the",
    "attachment actually contains. For visuals, describe layout, text, colors, spacing, components, states",
    "and any errors or anomalies you can see. For audio, report what is said or heard. For documents, answer",
    "from the text. Quote text verbatim when the attachment contains text. Do not speculate about what is not",
    "there, and say so plainly when the attachment does not contain the answer. No preamble, no markdown fences.",
  ].join(" "),

  ocr: [
    "You are an OCR engine. Extract the text from the attachment(s) VERBATIM — exact wording, exact casing,",
    "exact punctuation, including numbers, units, currency symbols and codes. Preserve reading order and",
    "structure: keep headings, lists, table rows/columns and line breaks as they appear, and use plain text or",
    "simple markdown to convey structure. Do NOT summarize, translate, correct spelling, expand abbreviations,",
    "or describe the visual design. If a passage is illegible or cut off, write [illegible] or [cut off] in",
    "place of the missing text rather than guessing at it. If the attachment contains no text, say so plainly.",
    "Output the extracted text only — no preamble, no commentary, no fences.",
  ].join(" "),

  ui: [
    "You are a UI analyst looking at a full screen or page (web or mobile) that will be REBUILT from your",
    "description, so be structural and specific rather than impressionistic. Report, in this order:",
    "(1) the platform and the apparent viewport/device, and whether this is a full page or a viewport crop;",
    "(2) the layout skeleton top to bottom — each region/section, its role, and how it is laid out",
    "(stack/grid/columns, alignment, how content is bounded and centered);",
    "(3) every component you can identify, section by section, with its variant and state, and the visible",
    "text in it quoted verbatim;",
    "(4) the design system you can infer: the color palette with approximate hex values and where each is",
    "used, the type scale (relative sizes, weights, apparent families), spacing rhythm, corner radii, borders,",
    "shadows, and icon style;",
    "(5) imagery and media — what each is, its aspect ratio, and whether it is photographic, illustrative or a",
    "generated/decorative graphic;",
    "(6) anything that constrains the rebuild: sticky/fixed elements, scroll position, overflow, truncation,",
    "z-order/overlays, apparent responsive breakpoint, dark or light theme, and any visible error or empty state.",
    "Distinguish what you can SEE from what you are inferring — mark inferences as such. Approximate colors and",
    "sizes are fine and useful; say they are approximate. No preamble, no fences.",
  ].join(" "),

  component: [
    "You are analyzing ONE UI component in isolation (a crop or an exported piece of a larger screen), for",
    "someone about to implement it. Cover: its anatomy — every part, nested structure, and the visible text",
    "quoted verbatim; the exact-as-you-can-tell metrics — padding, gaps, height, corner radius, border width,",
    "font size/weight, and the colors of each part with approximate hex; which state this instance is in and",
    "which other states it must plainly support (default, hover, focus, active, disabled, loading, error,",
    "empty, selected) — flagging any you cannot see and are inferring from convention; the interaction",
    "affordances visible (clickable areas, inputs, toggles, drag handles, scroll); and how it should behave",
    "when its container narrows or its text grows longer than shown. If a part is cut off at the crop edge,",
    "say so rather than inventing what continues. No preamble, no fences.",
  ].join(" "),

  qa: [
    "You are a visual QA analyst. You are given attachment(s) of an implementation and a statement of what was",
    "EXPECTED — often the spec that was actually built (token values, copy strings, the element structure,",
    "the states implemented). Your job is a verdict, not a description. Check the expectation CLAIM BY CLAIM:",
    "for every color named, is that color what is rendered; for every string, does it appear verbatim; for",
    "every element or section listed, is it present, in that order, in that role; for every state, is the one",
    "on screen the right one. A claim you cannot check is not a pass. Then report: a first line of exactly 'VERDICT: PASS' or 'VERDICT: FAIL'; then each defect as",
    "its own bullet with a severity (blocker / major / minor), WHERE it is on the screen, what you see, and what",
    "was expected instead. Look specifically for: missing or extra elements, wrong text (quote it), broken or",
    "overflowing layout, overlapping or clipped content, misalignment, unreadable contrast, obviously wrong",
    "spacing or sizing, images that failed to load, and any visible error state.",
    "SCOPE OF THE VERDICT: FAIL means the screen contradicts an EXPECTED claim, or shows overt breakage",
    "(an error, a broken or overflowing layout, a failed image). You see pixels, not code — you cannot know",
    "that an element STATE (a disabled button, an empty list, a loading spinner, a deselected tab) is",
    "unintended unless the expectation says otherwise. A state the expectation does not mention goes under",
    "an 'OBSERVED' heading as a non-deciding observation, never as a defect that fails the screen.",
    "Judge only what is visible — if the expectation covers something the attachment cannot show",
    "(behaviour, an interaction, an off-screen region), list it under 'NOT VERIFIABLE HERE' instead of guessing,",
    "and do not let it decide the verdict. Be strict: a screenshot that merely looks plausible is not a pass if",
    "it contradicts the expectation. No preamble, no fences.",
  ].join(" "),

  // The replication lens. `qa` checks a screen against a WRITTEN expectation;
  // this checks it against the DESIGN ITSELF, and its output is graded on being
  // actionable: every difference has to name a region, a measurement and a fix,
  // because the consumer is the next write/edit and "the spacing looks off" is
  // not something a model can act on.
  compare: [
    "You are a visual diff engine comparing a REFERENCE design against an IMPLEMENTATION screenshot of it.",
    "The attachments are labelled in the prompt; the reference is what the implementation is supposed to look",
    "like. The pair may instead be TWO SCREENS OF THE SAME APP — then the job is CONSISTENCY: same design",
    "language, component variants, type scale, spacing rhythm, colors and states on both, and every",
    "deviation is a difference to report the same way. Your output is read by a coding model that will edit",
    "the code from it, so every line you write must be specific enough to act on without seeing the images.",
    "",
    "FIRST, normalize. State the pixel dimensions of each image and the scale factor between them. If they",
    "differ in size, compare PROPORTIONALLY (normalize by width) and say so — a 1440px design against a 1280px",
    "screenshot is not 160px of error. Report every measurement in IMPLEMENTATION pixels, and mark values you",
    "are estimating as approximate.",
    "",
    "Then output a first line of exactly 'VERDICT: MATCH' or 'VERDICT: MISMATCH'.",
    "",
    "Then list the differences, worst first. For EACH one give, on its own lines:",
    "  - REGION: the element, named by its role and the visible text that identifies it ('primary CTA \"Get",
    "    started\"'), plus where it sits ('hero, right of the heading').",
    "  - BOX: the element's bounding box in the implementation as [x, y, w, h] in pixels, and the reference's",
    "    box as [x, y, w, h]. Give both even when only one axis is wrong.",
    "  - DELTA: the measured difference — dx/dy for position, dw/dh for size, the two hex values for color, the",
    "    two values for font size/weight/line-height/letter-spacing, the two values for padding/gap/radius/",
    "    border/shadow. Numbers, not adjectives.",
    "  - FIX: one imperative instruction naming what to change ('increase the hero's bottom padding from 32px",
    "    to 64px'), written for someone editing the code.",
    "",
    "Check every axis, in this order, and do not stop at the first category that has problems: missing or extra",
    "elements; wrong order or nesting; position and alignment; size and proportion; spacing (padding, gaps,",
    "margins) and the rhythm between sections; color (background, text, border, and any gradient/overlay);",
    "typography (family, size, weight, line-height, letter-spacing, case); corner radius, border width, shadow;",
    "imagery (right asset, crop, aspect ratio, object-fit); iconography (right glyph, size, stroke weight);",
    "text content quoted verbatim from both; and the state shown (empty, loading, error, hover, selected).",
    "",
    "Be exact about small things — a 4px radius rendered as 8px, a #111827 heading rendered as #000000, a font",
    "weight of 600 rendered as 700 — because those are what make a rebuild read as a copy rather than the",
    "original. Ignore differences under ~2px unless several of them compound in the same region, and ignore",
    "content that is legitimately dynamic (real data in place of placeholder copy, a different avatar), calling",
    "that out once rather than as a defect per instance.",
    "",
    "Judge only what is visible. Anything the screenshot cannot show (hover behaviour, an off-screen section,",
    "scroll or animation) goes under 'NOT VERIFIABLE HERE' and does not decide the verdict. If the two images",
    "show different screens entirely, say that as the single finding instead of diffing them region by region.",
    "No preamble, no fences.",
  ].join(" "),
};

// Append the triage directive to every lens so a single analysis call also
// classifies the attachment's role. Built once, at module load.
for (const lens of Object.keys(LENS_SYSTEM) as MediaLens[]) {
  LENS_SYSTEM[lens] = LENS_SYSTEM[lens] + CATEGORY_DIRECTIVE + DIMENSIONS_DIRECTIVE;
}

/**
 * Recover the `CATEGORY: <value>` line the directive asks for. Returns the
 * normalized category and the analysis with that line stripped; when no parseable
 * line is found, returns `undefined` and the analysis unchanged (the loop treats
 * a missing category as undifferentiated rather than failing the call).
 */
function parseCategoryLine(analysis: string): {
  category: MediaAnalysisCategory | undefined;
  analysis: string;
} {
  const m = analysis.match(/\n\s*CATEGORY\s*:\s*([a-z-]+)\s*$/i);
  if (!m) return { category: undefined, analysis };
  const raw = m[1]!.toLowerCase();
  const category: MediaAnalysisCategory | undefined =
    raw === "informational" || raw === "ui-replicate" || raw === "ui-bug" || raw === "other" ? raw : undefined;
  // Strip the trailing line (and any blank line just before it).
  const stripped = analysis.slice(0, m.index).replace(/\n[ \t]*$/, "");
  return { category, analysis: stripped };
}

/** Resolve the requested lens, tolerating unknown values (they fall back to a
 *  general description rather than failing the whole call). */
export function resolveLens(raw: unknown): MediaLens {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "ocr" ||
    value === "ui" ||
    value === "component" ||
    value === "qa" ||
    value === "compare"
    ? value
    : "describe";
}

/** The system prompt for a lens. Exported so a host can inspect or extend them. */
export function lensSystemPrompt(lens: MediaLens): string {
  return LENS_SYSTEM[lens];
}

/**
 * Turn one resolved attachment into a content block the bridge understands.
 * `image` and `audio` have dedicated block types; `video` and `document` ride as
 * `video`/`file` blocks, which the bridge maps onto OpenRouter's `file` part.
 */
async function toContentBlock(media: ResolvedMedia): Promise<UserContent> {
  const blockType = media.kind === "document" ? "file" : media.kind;
  if (!media.inline) {
    // Address-only. An image too large to inline still goes as a `file` block,
    // because the `image` block type has no by-reference form.
    return { type: blockType === "image" ? "file" : blockType, uri: media.path, mimeType: media.mimeType };
  }
  const data = (await fs.readFile(media.path)).toString("base64");
  if (blockType === "image") return { type: "image", data, mimeType: media.mimeType };
  return { type: blockType, data, mimeType: media.mimeType };
}

/**
 * The bundled backend: build the content blocks and call OpenRouter through the
 * harness bridge. Exported so a host can wrap it (e.g. fall back to it when its
 * own provider is unconfigured) instead of reimplementing it.
 */
export const openRouterMediaAnalysisBackend: MediaAnalysisBackend = async (req, ctx) => {
  if (!ctx.llm) throw new Error("media_analysis: no LLM bridge in the tool context");
  const content: UserContent[] = [{ type: "text", text: req.prompt }];
  for (const media of req.attachments) content.push(await toContentBlock(media));

  const slug = req.model ?? ctx.model?.openRouterSlug ?? DEFAULT_ANALYSIS_MODEL;
  const model = ctx.llm.resolveModel(slug);
  const context: Context = {
    systemPrompt: req.systemPrompt,
    messages: [{ role: "user", content, timestamp: Date.now() }],
  };
  const msg = await ctx.llm.complete(model, context, { temperature: 0, signal: ctx.signal });
  // The bridge swallows transport/provider errors and returns an empty message
  // with `stopReason: "error"` (see bridge.ts `complete`). Without this check a
  // 401, a network failure, a model that rejected the image, or an abort all
  // read as "the model returned no analysis" — a successful-looking empty result
  // that hides the real failure from the model and the host. Surface it instead:
  // a thrown error becomes an `isError` tool result the model can react to, and
  // the orchestrator's triage pass catches it and degrades to an un-enriched
  // image (orchestrator.ts triageAttachments try/catch).
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    const reason = msg.errorMessage ?? (msg.stopReason === "aborted" ? "aborted" : "provider error");
    throw new Error(`media_analysis: the analysis model call failed (${reason})`);
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, ...(msg.usage ? { usage: msg.usage } : {}) };
};

/**
 * Wrap a host media-analysis client as a {@link MediaAnalysisBackend}.
 *
 * Hosts that route vision through their OWN backend (e.g. OpenWaggleMain's
 * `/turing-machine/media/analysis` proxy, which authenticates via JWT and bills
 * centrally) can pass a thin adapter here instead of using the bundled
 * OpenRouter path. The adapter receives the already-resolved attachments
 * (paths + mime + inline flag) so it can read bytes / pass URIs as needed.
 *
 * Equivalent to assigning the function to {@link MediaAnalysisConfig.analyze}
 * directly; this factory exists for symmetry with the image backend and to make
 * the intent explicit at the call site.
 */
export function createBackendMediaAnalysisBackend(
  backend: MediaAnalysisBackend,
): MediaAnalysisBackend {
  return backend;
}

/**
 * Playwright MCP tool names, in preference order, plus the loose suffix match that
 * catches any other prefixing scheme a host might register them under.
 */
const NAVIGATE_TOOLS = ["browser_navigate", "mcp__playwright__browser_navigate", "playwright_navigate"];
const SCREENSHOT_TOOLS = [
  "browser_take_screenshot",
  "mcp__playwright__browser_take_screenshot",
  "playwright_screenshot",
];

function findBrowserTool(registry: Registry | undefined, candidates: string[]): AgentTool | undefined {
  if (!registry) return undefined;
  for (const name of candidates) {
    const tool = registry.getTool(name);
    if (tool) return tool;
  }
  const bare = candidates[0]!;
  return registry.allTools().find((t) => t.name.toLowerCase().endsWith(bare));
}

/** Where captured screenshots land, so a later step can re-read the same file. */
const SCREENSHOT_DIR = path.join(".turing", "screenshots");

export interface CapturedScreenshot {
  path: string;
  /** The tool that produced it, for the log/output trail. */
  via: string;
}

/**
 * Navigate a browser MCP to `url` and persist the screenshot to disk.
 *
 * The bytes have to become a FILE because everything downstream in this tool
 * works on paths — and because a captured screen is worth keeping: a later QA pass
 * can diff against it, and the plan can attach it to a step.
 *
 * MCP servers disagree on how they return an image (an `image` content block, or
 * prose naming a path they already wrote), so both shapes are handled and a
 * failure to find either is reported rather than silently analyzing nothing.
 */
export async function captureScreenshot(
  url: string,
  ctx: ToolContext,
  opts: { selector?: string; fullPage?: boolean } = {},
): Promise<{ shot?: CapturedScreenshot; error?: string }> {
  const registry = ctx.registry as Registry | undefined;
  const navTool = findBrowserTool(registry, NAVIGATE_TOOLS);
  const shotTool = findBrowserTool(registry, SCREENSHOT_TOOLS);
  if (!navTool || !shotTool) {
    return {
      error:
        "media_analysis: capturing a `url` needs a browser MCP (e.g. `npx @playwright/mcp@latest`) and none is " +
        "connected. Pass `file` with an image you already have, or attach the browser MCP. Do not substitute " +
        "bash+curl — it cannot render or screenshot a page.",
    };
  }

  const nav = await navTool.execute(`media-nav-${Date.now()}`, { url }, ctx);
  if (nav.isError) return { error: `media_analysis: could not open ${url}.\n${nav.output ?? ""}` };

  // Only pass args the caller actually asked for: MCP servers commonly reject
  // unknown properties, and a rejected screenshot call reads as "no browser".
  const shotArgs: Record<string, unknown> = {};
  if (opts.selector) shotArgs.selector = opts.selector;
  if (opts.fullPage) shotArgs.fullPage = true;
  const shot = await shotTool.execute(`media-shot-${Date.now()}`, shotArgs, ctx);
  if (shot.isError) return { error: `media_analysis: the browser could not screenshot ${url}.\n${shot.output ?? ""}` };

  const dir = path.join(ctx.cwd, SCREENSHOT_DIR);
  const stamp = `${hostSlug(url)}-${Date.now()}`;

  // Shape 1: an inline image block — write the bytes ourselves.
  const image = (shot.content ?? []).find(
    (c): c is { type: "image"; data: string; mimeType: string } =>
      typeof c === "object" && c !== null && (c as { type?: string }).type === "image" &&
      typeof (c as { data?: unknown }).data === "string",
  );
  if (image?.data) {
    await fs.mkdir(dir, { recursive: true });
    const ext = (image.mimeType?.split("/")[1] || "png").replace("jpeg", "jpg");
    const file = path.join(dir, `${stamp}.${ext}`);
    await fs.writeFile(file, Buffer.from(image.data, "base64"));
    return { shot: { path: file, via: shotTool.name } };
  }

  // Shape 2: the server wrote the file itself and named it in its output.
  const named = /(\/[^\s"'`]+\.(?:png|jpe?g|webp))/i.exec(shot.output ?? "")?.[1];
  if (named) {
    try {
      await fs.access(named);
      return { shot: { path: named, via: shotTool.name } };
    } catch {
      /* fall through to the error below */
    }
  }

  return {
    error:
      `media_analysis: ${shotTool.name} returned no readable image for ${url} (no inline image block, and no ` +
      `existing file path in its output). Screenshot the page another way and pass \`file\`.`,
  };
}

/** A filesystem-safe stem from a URL's host + path, for the screenshot name. */
function hostSlug(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
  } catch {
    return "page";
  }
}

export function createMediaAnalysisTool(
  config: MediaAnalysisConfig = {},
): AgentTool<any, MediaAnalysisResult> {
  return {
    name: "media_analysis",
    title: "Analyze an image or video",
    actionParam: "lens",
    actionTitles: {
      describe: "Describe what is in this",
      ocr: "Read the text in this",
      ui: "Read this design's layout",
      component: "Break this UI into components",
      qa: "Check this against what was asked",
      compare: "Compare this against the reference",
    },
    description:
      "Analyze attachment(s) with a multimodal model and return what they contain. Works on images, " +
      "video, audio and documents (PDF/DOCX/…). Use it to read a screenshot, understand a design mockup " +
      "BEFORE building it, diagnose a visual bug, review a screen recording, or answer from a spec document. " +
      "VISUAL QA: `lens:\"qa\"` with `prompt` = what the screen SHOULD show returns VERDICT: PASS/FAIL with " +
      "located defects — this is the judge `activity_inspect` runs for you. CONSISTENCY: `lens:\"compare\"` " +
      "with `files:[a,b]` diffs two UI captures (design vs build, or screen vs screen) and reports measured " +
      "differences with fixes. Pass `file` for one attachment or `files` for several; the modality is " +
      "inferred from the extension.",
    mutates: false,
    // Available in every phase: understanding a mockup or a spec belongs at the
    // START of the work, not only at the verify step the old auditor was scoped to.
    categorizers: ["read", "write_edit", "activity_inspect"],
    complexityHint: 0.5,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to analyze — the question to answer about the attachment(s).",
        },
        file: {
          type: "string",
          description: "Path to the attachment to analyze (absolute, or relative to cwd).",
        },
        url: {
          type: "string",
          description:
            "A page to screenshot and then analyze — use this to study a live site you are replicating or " +
            "verifying, instead of hunting for an image of it. The screenshot is saved under " +
            "`.turing/screenshots/` and its path is returned, so later steps can reuse or diff against it. " +
            "Needs a browser MCP. Combine with lens:\"ui\" for a rebuild spec.",
        },
        selector: {
          type: "string",
          description: "With `url`: screenshot just this CSS selector — pair with lens:\"component\".",
        },
        expected: {
          type: "string",
          description:
            "With lens:\"qa\": WHAT YOU BUILT, so the check is against the real spec instead of a memory of " +
            "it. Paste the parts that are visually checkable — the token values you used (hex, radii, " +
            "spacing, font sizes), the exact copy strings, the element/section structure you rendered, the " +
            "states you implemented — including interactive states that are intended (\"Confirm disabled " +
            "until the email is typed\"), so an intended state is not judged as a defect. The analyst compares " +
            "the screenshot to THIS. Without it a QA pass can only judge whether the screen looks plausible, " +
            "which passes a page that renders the wrong brand color and the wrong heading perfectly.",
        },
        fullPage: {
          type: "boolean",
          description: "With `url`: capture the whole scrollable page rather than the viewport.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths to several attachments to analyze together — use this to compare (e.g. before/after screenshots).",
        },
        reference: {
          type: "string",
          description:
            "With lens:\"compare\": the DESIGN you are replicating (the mockup the user attached). The other " +
            "attachment(s) — `file`, `files`, or the screenshot `url` captures — are the implementation. " +
            "Naming the reference here is what tells the analyst which image is the target and which is the " +
            "attempt, so the deltas point the right way.",
        },
        lens: {
          type: "string",
          enum: ["describe", "ocr", "ui", "component", "qa", "compare"],
          description:
            "What kind of analysis to run (default: describe). " +
            "ocr = extract the text verbatim, no interpretation. " +
            "ui = a full web/mobile screen, reported as a rebuild spec: layout skeleton, every component, the " +
            "inferred design system (palette, type scale, spacing, radii, shadows). " +
            "component = ONE component in isolation: anatomy, metrics, colors, and the states it must support. " +
            "qa = compare an implementation against what was EXPECTED and return VERDICT: PASS/FAIL plus defects " +
            "(state the expectation in `prompt`, and pass what you built in `expected`). " +
            "compare = you are REPLICATING a design: pass the mockup as `reference` and your screenshot as " +
            "`file`/`url`, and get back per-region bounding boxes, pixel deltas and a FIX line per difference — " +
            "the form a following write/edit can act on directly.",
        },
        type: {
          type: "string",
          enum: ["image", "video", "audio", "document"],
          description:
            "Override the modality for every file in this call. Only needed when the file extension is " +
            "missing or misleading; otherwise it is inferred per file.",
        },
        model: {
          type: "string",
          description: "Override the analysis model slug (must be multimodal).",
        },
      },
      required: ["prompt"],
    },
    async execute(_id, args, ctx) {
      const analyze = config.analyze ?? openRouterMediaAnalysisBackend;
      // Only the bundled backend needs the bridge; a host backend may reach any
      // provider it likes, so this precondition is scoped to the default path.
      if (!config.analyze && !ctx.llm) {
        return {
          output:
            "media_analysis requires an LLM bridge in the tool context (or a configured `analyze` backend).",
          isError: true,
          details: { analysis: "", analyzed: [] },
        };
      }
      const lens = resolveLens(args.lens);
      const prompt = String(args.prompt ?? "").trim();
      // `expected` is the built spec for a QA pass. Appended as its own labelled
      // block rather than merged into `prompt` so the analyst can tell the
      // QUESTION from the CLAIMS it has to check one by one.
      const expected = String(args.expected ?? "").trim();
      if (!prompt) {
        return {
          output: "media_analysis: missing required argument 'prompt'. Say what to analyze and retry.",
          isError: true,
          details: { analysis: "", analyzed: [] },
        };
      }

      const pinned = args.type as MediaKind | undefined;
      // `file` and `files` are both accepted (and may be combined) so the model
      // can't get the arity wrong. Falls back to the host-injected attachments
      // (`ctx.images`) so an attached mockup is still analyzable when the model
      // didn't name it in the call.
      const requested = [
        ...(args.file ? [String(args.file)] : []),
        ...((args.files as string[] | undefined) ?? []),
      ];

      // A `url` is captured first and then analyzed like any other file, so the
      // screenshot is a real artifact on disk that later steps can reuse — not a
      // transient the run has to re-capture to look at twice.
      let captured: CapturedScreenshot | undefined;
      const url = String(args.url ?? "").trim();
      if (url) {
        const { shot, error } = await captureScreenshot(url, ctx, {
          ...(args.selector ? { selector: String(args.selector) } : {}),
          ...(args.fullPage === true ? { fullPage: true } : {}),
        });
        if (error) return { output: error, isError: true, details: { analysis: "", analyzed: [] } };
        captured = shot;
        if (shot) requested.unshift(shot.path);
      }

      // The reference goes FIRST, after any capture, so attachment order matches
      // the roles the compare prompt names. Order is the only channel a vision
      // model has for telling the target design from the attempt at it, and
      // getting it backwards inverts every delta in the report.
      const referenceArg = String(args.reference ?? "").trim();
      if (referenceArg) requested.unshift(referenceArg);

      const paths = requested.length ? requested : (ctx.images ?? []).map((img) => img.path);

      if (!paths.length) {
        return {
          output:
            "media_analysis: no attachment to analyze. Pass `file: path` (or `files: [path, ...]`), or `url` to " +
            "screenshot a live page. A screenshot an earlier `activity_inspect` / `browser_take_screenshot` took was " +
            "saved under `.turing/screenshots/` — its path was named in that tool's result; pass it here as `file:` " +
            "to analyze that capture (see AVAILABLE IMAGES too).",
          isError: true,
          details: { analysis: "", analyzed: [] },
        };
      }

      // Resolve, classify and verify BEFORE handing anything to a backend, so
      // every backend gets the same guarantee: paths that exist, are readable,
      // and carry a known modality.
      const analyzed: ResolvedMedia[] = [];
      const rejected: string[] = [];
      for (const p of paths) {
        // A relative path from another tool (notably an MCP browser tool, which
        // saves screenshots/snapshots relative to the MCP SERVER's CWD, not this
        // run's `ctx.cwd`) resolves against the wrong base here and ENOENTs. When
        // a relative path does not exist under `ctx.cwd`, fall back to the host
        // process CWD before giving up — that is where MCP servers typically run.
        const resolved = await resolveMediaPath(p, ctx.cwd);
        const abs = resolved.path;
        const classified = classifyMedia(abs, pinned);
        if (!classified) {
          rejected.push(`${abs} (unrecognized extension — pass \`type\` to analyze it anyway)`);
          continue;
        }
        try {
          const stat = await fs.stat(abs);
          analyzed.push({
            path: abs,
            kind: classified.kind,
            mimeType: classified.mimeType,
            bytes: stat.size,
            // Video is referenced regardless of size: inlining a recording is
            // rarely what a provider accepts, and the bridge carries the address.
            inline: classified.kind !== "video" && stat.size <= MAX_INLINE_BYTES,
          });
        } catch (err) {
          rejected.push(`${abs} (${(err as Error).message})`);
        }
      }

      if (!analyzed.length) {
        return {
          output: `media_analysis: none of the given attachments could be analyzed:\n${rejected.map((r) => `  - ${r}`).join("\n")}`,
          isError: true,
          details: { analysis: "", analyzed: [] },
        };
      }

      // A diff needs two sides. With one attachment the lens would quietly
      // degrade into a description of it, and a run replicating a design would
      // read that as "no differences found".
      if (lens === "compare" && analyzed.length < 2) {
        return {
          output:
            'media_analysis: lens "compare" needs two attachments — the design you are replicating and your ' +
            "implementation of it. Pass the mockup as `reference` and your screenshot as `file` (or `url` to " +
            "capture it now).",
          isError: true,
          details: { analysis: "", analyzed: [] },
        };
      }

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:media_analysis"],
        message: `analyze (${lens}) ${analyzed.map((m) => `${m.kind}${m.inline ? "" : " (by reference)"}`).join(", ")}`,
      });

      // Which image is which. A vision model receives the attachments as an
      // ordered list with no roles attached, so under `compare` the roles are
      // stated in the prompt — otherwise the analyst has to guess which one is
      // the target, and a guess that lands backwards reports every delta with
      // the wrong sign while looking perfectly authoritative.
      const roleRoster =
        lens === "compare"
          ? [
              "ATTACHMENTS, in order:",
              ...analyzed.map(
                (m, i) =>
                  `  ${i + 1}. ${m.path} — ${
                    i === 0
                      ? `REFERENCE: the design to match${referenceArg ? "" : " (assumed from position — pass `reference` to be explicit)"}`
                      : "IMPLEMENTATION: what the code currently renders"
                  }`,
              ),
            ].join("\n")
          : undefined;

      const req: MediaAnalysisRequest = {
        // Rejected paths are surfaced to the model rather than hidden, so a
        // partial analysis is never mistaken for a complete one.
        prompt: [
          prompt,
          ...(roleRoster ? [roleRoster] : []),
          ...(expected ? [`WHAT WAS BUILT (check the screen against every claim here):\n${expected}`] : []),
          ...(rejected.length
            ? [`[note: could not analyze ${rejected.length} attachment(s): ${rejected.join("; ")}]`]
            : []),
        ].join("\n\n"),
        systemPrompt: lensSystemPrompt(lens),
        attachments: analyzed,
        ...(args.model || config.model ? { model: String(args.model ?? config.model) } : {}),
      };

      const effectivePrompt = req.prompt;
      // Cache lookup — but only for the single-attachment case. Multi-attachment
      // calls are comparisons (before/after, two candidates) that vary with the
      // set, and the prompt rarely repeats verbatim, so they are uncached. The
      // single-attachment case is the hot one: a run that describes a screen and
      // then comes back to it, or that the design-reference categorizer asks
      // about. Keyed on bytes + lens + prompt, so two different questions about
      // the same image correctly miss and re-run.
      let cached: string | undefined;
      let cacheKey: { path: string; fileHash: string; promptHash: string } | undefined;
      if (config.cache !== false && analyzed.length === 1) {
        try {
          const bytes = await fs.readFile(analyzed[0]!.path);
          const fileHash = hashImageBytes(bytes);
          const promptHash = hashPrompt(effectivePrompt);
          cached = recallMediaAnalysis(analyzed[0]!.path, fileHash, lens, promptHash);
          cacheKey = { path: analyzed[0]!.path, fileHash, promptHash };
        } catch {
          // Bytes vanished between stat and read; skip the cache, run the call.
        }
      }
      let analysis: string;
      let usage: Usage | undefined;
      if (cached !== undefined) {
        analysis = cached;
        usage = undefined; // a cache hit cost nothing to serve.
        ctx.log({
          timestamp: Date.now(),
          level: "debug",
          tags: ["tool:media_analysis", "media_analysis:reused"],
          message: `reused cached (${lens}) analysis for ${analyzed[0]!.path} — no provider call`,
        });
      } else {
        let result: { text: string; usage?: Usage };
        try {
          result = await analyze(req, ctx);
        } catch (err) {
          // The backend throws on a real provider/transport failure (a swallowed
          // `complete()` error — auth, network, model rejection, abort). Return an
          // explicit `isError` so the model sees a clean, actionable failure rather
          // than a propagating "Tool threw:" wrapper, and the triage pass's own
          // try/catch degrades the image to un-enriched.
          const message = err instanceof Error ? err.message : String(err);
          return {
            output: `media_analysis: ${message}`,
            isError: true,
          };
        }
        analysis = result.text.trim();
        usage = result.usage;
        // Record for reuse on the same single-attachment key. Empty results are
        // not worth caching (see rememberMediaAnalysis), and a transient failure
        // should not be frozen as a permanent empty.
        if (cacheKey && analysis) {
          rememberMediaAnalysis(cacheKey.path, cacheKey.fileHash, lens, cacheKey.promptHash, analysis);
        }
      }
      // Recover the trailing CATEGORY line every lens prompt appends. The
      // category classifies the attachment's ROLE (informational / ui-replicate /
      // ui-bug / other) so the loop can route it without a second call. The line
      // is stripped from `analysis` so the model-facing output stays clean.
      const { category, analysis: cleanAnalysis } = parseCategoryLine(analysis);
      analysis = cleanAnalysis;
      // Under the ocr lens, expose the verbatim text as a discrete field too, so
      // downstream consumers don't have to reparse prose. Mirrors `analysis`.
      const ocr = lens === "ocr" && analysis ? { text: analysis } : undefined;
      // Name the saved screenshot in the model-facing output: the next step can
      // attach or re-analyze that exact file instead of capturing the page again.
      const header = captured ? `Screenshot saved: ${captured.path} (via ${captured.via})\n\n` : "";
      return {
        output: `${header}${analysis || "(the model returned no analysis)"}`,
        details: {
          analysis,
          analyzed,
          ...(captured ? { screenshot: captured.path } : {}),
          ...(category ? { category } : {}),
          ...(ocr ? { ocr } : {}),
        },
        ...(usage ? { usage } : {}),
      };
    },
  };
}
