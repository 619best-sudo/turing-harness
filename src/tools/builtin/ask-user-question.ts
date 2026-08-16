/**
 * Internal tool: ask_user_question.
 *
 * The escape hatch from guessing. Most decisions inside a run are the agent's to
 * make — but a few are genuinely the USER's, and getting those wrong costs far
 * more than the interruption: which architecture to commit to, which of two
 * readings of an ambiguous requirement to build, a credential only they can
 * supply, an irreversible action.
 *
 * Two things make the question worth asking rather than annoying:
 *
 *   1. It BLOCKS in place when the host installed `ctx.askUserQuestion`. The
 *      answer comes back as this call's tool result, so the model continues in the
 *      same conversation with no new run and no lost context. Without that
 *      callback the question rides out on `details` for a host that prefers to
 *      cancel and restart with the answer.
 *   2. It can offer CHOICES, not just a blank box. A well-formed set of options
 *      with their trade-offs turns "what should I do?" — which hands the thinking
 *      back to the user — into a decision they can make in one click, which is the
 *      only part they actually own.
 */
import * as path from "node:path";
import type {
  AgentTool,
  AskUserQuestionAnswer,
  AskUserQuestionAttachment,
  AskUserQuestionAttachmentRequest,
  AskUserQuestionOption,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  Phase,
} from "../../types.js";

interface AskUserQuestionDetails {
  kind: "ask_user_question";
  /**
   * True once the user has ANSWERED — the blocking path, where the answer is
   * already this call's tool result and the run continues.
   *
   * Load-bearing, not decorative. `details.kind === "ask_user_question"` is how
   * the work loop recognises an OUTSTANDING question and stops the run so the
   * host can collect an answer out of band. Emitting details on the answered
   * path without this flag makes a question that was just answered look like one
   * still waiting, and the run halts on the spot.
   */
  answered?: true;
  question: string;
  reason?: string;
  placeholder?: string;
  answerMode?: "text" | "single-select" | "multi-select";
  options?: string[];
  choices?: AskUserQuestionOption[];
  allowFreeText?: boolean;
  /** Files the agent showed WITH the question. */
  attachments?: AskUserQuestionAttachment[];
  /** What the agent asked the user to attach. */
  requestAttachments?: AskUserQuestionAttachmentRequest;
  /**
   * Files the USER attached to their answer.
   *
   * This is the field the work loop reads (see `attachmentsFromToolResult` in
   * `orchestrator/loop.ts`): a file that arrives here joins the run's live image
   * set, so the write/edit authoring pass that follows sees the pixels — exactly
   * as if the user had attached it to the prompt up front. Without that the file
   * would be named in a sentence and then never looked at, which is the failure
   * that makes asking for one pointless.
   */
  answerAttachments?: AskUserQuestionAttachment[];
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Accept both option shapes: a bare string, or `{label, description, recommended}`.
 * Strings keep every existing caller working; the object form is what lets the
 * host show the trade-off next to each choice.
 *
 * Capped at 6 — past that a "simplifying" picker is just a second problem — and at
 * most one option keeps `recommended`, because two recommendations recommend
 * nothing.
 */
export function sanitizeChoices(value: unknown): AskUserQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices: AskUserQuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const label = sanitizeString(entry);
      if (label) choices.push({ label });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const label = sanitizeString(obj.label) ?? sanitizeString(obj.value) ?? sanitizeString(obj.title);
    if (!label) continue;
    const description = sanitizeString(obj.description);
    choices.push({
      label,
      ...(description ? { description } : {}),
      ...(obj.recommended === true ? { recommended: true } : {}),
    });
  }
  if (!choices.length) return undefined;
  const capped = choices.slice(0, 6);
  let seenRecommended = false;
  return capped.map((choice) => {
    if (!choice.recommended) return choice;
    if (seenRecommended) {
      const { recommended: _drop, ...rest } = choice;
      return rest;
    }
    seenRecommended = true;
    return choice;
  });
}

function sanitizeAnswerMode(
  value: unknown,
): "text" | "single-select" | "multi-select" | undefined {
  return value === "text" || value === "single-select" || value === "multi-select"
    ? value
    : undefined;
}

/** Extension → mime, for attachments a host names by path alone. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

function guessMime(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Normalize an attachment list from either side of the exchange.
 *
 * Tolerant of a bare path string, because that is what a model writes when a
 * schema says "an array of files" — and, on the answer side, what a host that
 * only tracks paths returns. A missing `mimeType` is inferred rather than
 * dropping the file: an attachment the run silently ignores is the one failure
 * this whole feature exists to prevent.
 */
export function sanitizeAttachments(
  value: unknown,
  cwd?: string,
): AskUserQuestionAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AskUserQuestionAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const raw =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? String((entry as AskUserQuestionAttachment).path ?? "")
          : "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Absolute paths only downstream: the file is handed to tools and authoring
    // passes that do not share this call's working directory.
    const abs = path.isAbsolute(trimmed) || /^https?:\/\//i.test(trimmed)
      ? trimmed
      : path.join(cwd ?? process.cwd(), trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const obj = typeof entry === "object" && entry ? (entry as AskUserQuestionAttachment) : undefined;
    const mimeType = sanitizeString(obj?.mimeType) ?? guessMime(abs);
    const note = sanitizeString(obj?.note);
    out.push({ path: abs, mimeType, ...(note ? { note } : {}) });
  }
  return out.length ? out : undefined;
}

/** True for a mime the vision/authoring path can actually use as pixels. */
export function isImageAttachment(a: AskUserQuestionAttachment): boolean {
  return a.mimeType.startsWith("image/");
}

/** Normalize the `requestAttachments` argument; anything unusable → undefined. */
export function sanitizeAttachmentRequest(
  value: unknown,
): AskUserQuestionAttachmentRequest | undefined {
  if (value === true) return { mode: "optional" };
  if (typeof value === "string") {
    return value === "required" || value === "optional" ? { mode: value } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const mode = obj.mode === "required" ? "required" : obj.mode === "optional" ? "optional" : undefined;
  if (!mode) return undefined;
  const accept = Array.isArray(obj.accept)
    ? obj.accept.map(sanitizeString).filter((s): s is string => !!s)
    : undefined;
  const hint = sanitizeString(obj.hint);
  return {
    mode,
    ...(accept?.length ? { accept } : {}),
    ...(hint ? { hint } : {}),
    ...(obj.multiple === true ? { multiple: true } : {}),
  };
}

/**
 * Normalize whatever the host callback returned.
 *
 * A bare string is the pre-attachment contract and still means "text only", so
 * no host has to change to keep working. An object may carry files, and may
 * carry an EMPTY `text` — when the question was "send me the mockup", the files
 * are the entire answer and demanding prose alongside them would be pedantry.
 */
export function normalizeAnswer(result: AskUserQuestionResult, cwd?: string): AskUserQuestionAnswer {
  if (typeof result === "string") return { text: result };
  if (!result || typeof result !== "object") return { text: String(result ?? "") };
  const text = typeof result.text === "string" ? result.text : "";
  const attachments = sanitizeAttachments(result.attachments, cwd);
  return { text, ...(attachments ? { attachments } : {}) };
}

export const askUserQuestionTool: AgentTool = {
  name: "ask_user_question",
  description:
    "Ask the user a question and wait for their answer. For the decisions that are genuinely THEIRS, not yours: " +
    "which architecture or library to commit to, which reading of an ambiguous requirement to build, a product " +
    "or UX trade-off, an irreversible/destructive action, or access only they can grant. Offer `options` with " +
    "their trade-offs whenever the answer is a choice between paths you can name — a picker they can answer in " +
    "one click beats a blank box. NOT for things you can settle yourself by reading the code, the tests or the " +
    "docs, and not for permission to do work they already asked for.",
  mutates: false,
  // Every phase. A question that can only be asked while PLANNING is a question
  // that cannot be asked at the moment it usually arises — mid-implementation,
  // when the ambiguity actually bites, or when a trace needs the user to exercise
  // the app. The failure ladder also escalates here from any phase.
  phases: ["prepare", "plan", "perform", "perfect"],
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The exact clarification question to ask the user.",
      },
      reason: {
        type: "string",
        description: "Why this answer is required before execution can continue.",
      },
      placeholder: {
        type: "string",
        description: "Optional short hint for the expected answer format.",
      },
      answerMode: {
        type: "string",
        enum: ["text", "single-select", "multi-select"],
        description:
          "How the host should render the answer UI. Use text for freeform input, single-select for one choice, or multi-select for multiple suggested choices.",
      },
      options: {
        type: "array",
        description:
          "The choices to offer, when the answer is a decision between paths you can name. Either short strings, " +
          "or objects {label, description, recommended} — the description says what CHOOSING that option means " +
          "(its consequence or trade-off, not a restatement of the label), and `recommended: true` marks the one " +
          "you would pick, on at most one option. Pair with answerMode single-select (or multi-select when more " +
          "than one can apply). Max 6.",
        items: {
          type: ["string", "object"],
          properties: {
            label: { type: "string", description: "The short answer text." },
            description: { type: "string", description: "What choosing this means — the trade-off." },
            recommended: { type: "boolean", description: "Mark the option you would pick (at most one)." },
          },
        },
      },
      attachments: {
        type: "array",
        description:
          "Files to show the user WITH the question — a screenshot of the defect you want confirmed, two " +
          "candidate renders to choose between, a generated asset you want approved. A question about " +
          "something visual is far cheaper to answer when the thing is on screen next to it. Each entry is " +
          "{path, note} where `note` says what they are looking at. Use paths that exist (an attachment, a " +
          "capture you just took, a file you generated).",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to show." },
            note: { type: "string", description: "What this file is / what to look at." },
          },
          required: ["path"],
        },
      },
      requestAttachments: {
        type: "object",
        description:
          "Ask the user to attach a FILE with their answer. Use this whenever what you need is a file rather " +
          "than a sentence: the mockup you are supposed to match, a screenshot of the error, the CSV whose " +
          "columns decide the schema, an export you have to parse. Asking in prose for something that only " +
          "exists as a file is the round trip this avoids. Anything the user attaches becomes available to " +
          "your later calls automatically — images reach write/edit as vision input, so you do not need to " +
          "ask them to describe it.",
        properties: {
          mode: {
            type: "string",
            enum: ["optional", "required"],
            description:
              "\"required\" when the question is unanswerable without the file; \"optional\" to offer the " +
              "picker without insisting.",
          },
          accept: {
            type: "array",
            items: { type: "string" },
            description: "Extensions or mime types to hint the picker, e.g. [\".png\",\"image/*\"].",
          },
          hint: {
            type: "string",
            description: "What to attach, in the user's terms — \"the Figma export of the hero\".",
          },
          multiple: { type: "boolean", description: "Whether several files are wanted." },
        },
        required: ["mode"],
      },
    },
    required: ["question"],
  },
  async execute(_toolCallId, args, ctx) {
    const question = sanitizeString(args.question);
    if (!question) {
      return {
        output:
          "ask_user_question: missing required argument 'question'. Provide one concrete clarification question and retry.",
        isError: true,
      };
    }
    const reason = sanitizeString(args.reason);
    const placeholder = sanitizeString(args.placeholder);
    const choices = sanitizeChoices(args.options) ?? sanitizeChoices(args.choices);
    const options = choices?.map((choice) => choice.label);
    // Offering choices without saying how to render them leaves a host guessing;
    // infer the obvious mode rather than dropping the picker.
    const answerMode = sanitizeAnswerMode(args.answerMode) ?? (choices?.length ? "single-select" : undefined);
    // Every picker carries a free-text escape. The model names the paths it can
    // see; the answer the user wants is often the one it could not ("neither —
    // reuse the existing queue"). Without a box that user must pick something
    // wrong or kill the run, and the model never learns what they actually meant.
    const allowFreeText = (choices?.length ?? 0) > 0 ? true : undefined;
    const attachments = sanitizeAttachments(args.attachments, ctx?.cwd);
    const requestAttachments = sanitizeAttachmentRequest(args.requestAttachments);
    const request: AskUserQuestionRequest = {
      // Report where the question actually came from. The tool used to hardcode
      // "plan" because that was the only phase it was registered for; it now runs
      // in all of them, and a mislabeled question is one a host routes wrong.
      phase: (ctx?.phase as Phase | undefined) ?? "plan",
      question,
      ...(reason ? { reason } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(answerMode ? { answerMode } : {}),
      ...(options?.length ? { options } : {}),
      ...(choices?.length ? { choices } : {}),
      ...(allowFreeText ? { allowFreeText } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(requestAttachments ? { requestAttachments } : {}),
    };

    // Preferred path: the host installed `ctx.askUserQuestion`, so block here and
    // let the LLM continue in the SAME conversation with the user's answer as
    // the tool result. No new run, no context loss.
    if (ctx?.askUserQuestion) {
      try {
        const answer = normalizeAnswer(await ctx.askUserQuestion(request), ctx?.cwd);
        const files = answer.attachments ?? [];
        const lines = [
          // An answer can legitimately be files alone ("send me the mockup"), so
          // say so rather than printing an empty quote the model has to interpret.
          answer.text
            ? `User answered: ${answer.text}`
            : files.length
              ? `User answered with ${files.length === 1 ? "a file" : `${files.length} files`} and no text.`
              : "User answered: (empty)",
          `(clarification for: ${question})`,
          ...(reason ? [`Reason this was needed: ${reason}`] : []),
        ];
        if (files.length) {
          const images = files.filter(isImageAttachment);
          lines.push(
            "",
            `The user attached ${files.length === 1 ? "this file" : "these files"}:`,
            ...files.map((f) => `  - ${f.path} (${f.mimeType})${f.note ? ` — ${f.note}` : ""}`),
          );
          // Route them, rather than leaving a list of paths the model has to
          // guess what to do with. This mirrors the run-level attachment
          // guidance: images are already threaded as vision input, everything
          // else has a tool that reads it.
          if (images.length) {
            lines.push(
              `The image${images.length === 1 ? " is" : "s are"} now part of this run's attachments — pass ` +
                `${images.length === 1 ? "the path" : "the paths"} in \`images\` on write/edit to author from ` +
                `${images.length === 1 ? "it" : "them"}, or to \`media_analysis\` (lens:"ui" to rebuild a ` +
                `screen, "ocr" for exact text, "component" for one piece) to read ${images.length === 1 ? "it" : "them"} first.`,
            );
          }
          if (files.length > images.length) {
            lines.push(
              "Non-image files: `media_analysis` reads video, audio and documents (PDF/DOCX); use `read` for " +
                "text and code.",
            );
          }
        }
        return {
          output: lines.join("\n"),
          details: {
            kind: "ask_user_question",
            answered: true,
            question,
            ...(reason ? { reason } : {}),
            ...(answerMode ? { answerMode } : {}),
            ...(options?.length ? { options } : {}),
            ...(choices?.length ? { choices } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(requestAttachments ? { requestAttachments } : {}),
            ...(files.length ? { answerAttachments: files } : {}),
          } satisfies AskUserQuestionDetails,
        };
      } catch (error) {
        // The host aborted/errored. Surface it as a tool error so the model
        // sees the failure and can either retry or choose a safe default.
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: `ask_user_question: failed to get user answer (${message}). Ask again or proceed without this clarification.`,
          isError: true,
        };
      }
    }

    // Backwards-compatible fallback: no host callback installed. Surface the
    // question via `details` so a non-blocking host can handle it by
    // cancelling and restarting the run with the answer.
    const lines = [
      `User clarification required: ${question}`,
      ...(reason ? [`Reason: ${reason}`] : []),
      ...(answerMode ? [`Answer mode: ${answerMode}`] : []),
      ...(allowFreeText ? ["(the user may also type an answer of their own)"] : []),
      ...(choices?.length
        ? [
          "Choices:",
          ...choices.map(
            (choice) =>
              `  - ${choice.label}${choice.recommended ? " (recommended)" : ""}${choice.description ? ` — ${choice.description}` : ""}`,
          ),
        ]
        : []),
      ...(attachments?.length
        ? [
          "Shown with the question:",
          ...attachments.map((a) => `  - ${a.path} (${a.mimeType})${a.note ? ` — ${a.note}` : ""}`),
        ]
        : []),
      ...(requestAttachments
        ? [
          `A file is ${requestAttachments.mode === "required" ? "REQUIRED" : "invited"} with the answer` +
            `${requestAttachments.hint ? `: ${requestAttachments.hint}` : "."}` +
            `${requestAttachments.accept?.length ? ` (accepts ${requestAttachments.accept.join(", ")})` : ""}`,
        ]
        : []),
    ];
    return {
      output: lines.join("\n"),
      details: {
        kind: "ask_user_question",
        question,
        ...(reason ? { reason } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(answerMode ? { answerMode } : {}),
        ...(options?.length ? { options } : {}),
        ...(choices?.length ? { choices } : {}),
        ...(allowFreeText ? { allowFreeText } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(requestAttachments ? { requestAttachments } : {}),
      } satisfies AskUserQuestionDetails,
    };
  },
};
