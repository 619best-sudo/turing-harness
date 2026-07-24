import type { AgentTool, AskUserQuestionRequest } from "../../types.js";

interface AskUserQuestionDetails {
  kind: "ask_user_question";
  question: string;
  reason?: string;
  placeholder?: string;
  answerMode?: "text" | "single-select" | "multi-select";
  options?: string[];
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((entry) => sanitizeString(entry))
    .filter((entry): entry is string => typeof entry === "string");
  return options.length > 0 ? options.slice(0, 6) : undefined;
}

function sanitizeAnswerMode(
  value: unknown,
): "text" | "single-select" | "multi-select" | undefined {
  return value === "text" || value === "single-select" || value === "multi-select"
    ? value
    : undefined;
}

export const askUserQuestionTool: AgentTool = {
  name: "ask_user_question",
  description:
    "Pause PLAN and ask the user a specific clarification question when execution cannot proceed safely without that answer.",
  mutates: false,
  phases: ["plan"],
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
          "Optional short suggested answers. Pair with single-select or multi-select when the host should render explicit choices.",
        items: { type: "string" },
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
    const answerMode = sanitizeAnswerMode(args.answerMode);
    const options = sanitizeOptions(args.options);
    const request: AskUserQuestionRequest = {
      // The tool is only registered for `plan` (see `phases` above), so this is
      // the only phase in which it can fire. If a future caller registers it for
      // another phase, surface that explicitly rather than silently mislabeling.
      phase: "plan",
      question,
      ...(reason ? { reason } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(answerMode ? { answerMode } : {}),
      ...(options?.length ? { options } : {}),
    };

    // Preferred path: the host installed `ctx.askUserQuestion`, so block here and
    // let the LLM continue in the SAME conversation with the user's answer as
    // the tool result. No new run, no context loss.
    if (ctx?.askUserQuestion) {
      try {
        const answer = await ctx.askUserQuestion(request);
        const lines = [
          `User answered: ${answer}`,
          `(clarification for: ${question})`,
          ...(reason ? [`Reason this was needed: ${reason}`] : []),
        ];
        return { output: lines.join("\n") };
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
      ...(options?.length ? [`Suggested answers: ${options.join(" | ")}`] : []),
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
      } satisfies AskUserQuestionDetails,
    };
  },
};
