/**
 * The `clearing_doubt` tool — available to EVERY categorizer.
 *
 * Small-model orchestrators fail in a specific way: they hesitate, loop, or
 * quietly pick something wrong rather than admit the task is beyond them. This
 * tool is the pressure valve: when the categorizer's model is in doubt or the
 * work looks beyond its capability, it calls `clearing_doubt`, and a BIG model
 * (senior tier, configurable) is consulted with the task, the doubt, the toolset
 * and the chain state. The big model answers with an execution plan in STEPS
 * phrased against the categorizer's own tools — the small model then executes
 * those steps with its internal tools. Guidance, not takeover: the loop and its
 * model stay in charge.
 */
import type { AgentTool, Context, LLMBridge, Model, ToolContext } from "../types.js";
import type { CategorizerHop } from "./types.js";

export const CLEARING_DOUBT_TOOL_NAME = "clearing_doubt";

/** The senior model consulted by default (same tier the plan tool authors on). */
export const DEFAULT_DOUBT_MODEL = "tencent/hy3";

const CONSULT_PROMPT = [
  "You are the senior engineer a smaller coding agent consults when it is stuck. It runs with a",
  "LIMITED toolset and a small context; your job is NOT to do the work, but to give it an execution",
  "plan it can follow with what it has.",
  "",
  "Rules for your answer:",
  "- Think about the doubt, the task and the state below.",
  "- Reply with NUMBERED STEPS (3-8), each one phrased as an action using ONLY the tools listed.",
  "- Name the tool call concretely where you can (which tool, which argument shape), so the agent",
  "  can execute the step directly.",
  "- If the task is genuinely impossible with the toolset (a missing credential, a capability",
  "  nobody has), say so in step 1 and tell the agent to ask the user via ask_user_question.",
  "- If the agent is on the right track and just needs confidence, say THAT in one line and give",
  "  the next 1-2 steps only.",
  "- No preamble, no closing summary — just the steps.",
].join("\n");

/** Render the run state the big model sees (compact, transcript-free). */
function renderState(hops: CategorizerHop[]): string {
  if (!hops.length) return "(the run just started; no categorizer has completed yet)";
  return hops
    .map((h) => {
      const d = h.deliverable as Record<string, unknown> | undefined;
      const gist =
        d && typeof d === "object"
          ? JSON.stringify(d).slice(0, 600)
          : "(no structured deliverable)";
      return `- ${h.id}: ${h.summary}\n  delivered: ${gist}`;
    })
    .join("\n");
}

export interface ClearingDoubtDeps {
  llm: LLMBridge;
  /** Resolved big model descriptor (slug → Model done by the chain). */
  model: Model;
  /** The originating task. */
  task: string;
  /** Id of the categorizer currently running. */
  categorizer: string;
  /** Completed hops, for run state. */
  hops: CategorizerHop[];
  /**
   * Names of the tools the CURRENT categorizer holds (the small model executes
   * the steps with these; the big model must not recommend anything else).
   */
  toolNames: string[];
  signal?: AbortSignal;
}

export function createClearingDoubtTool(deps: ClearingDoubtDeps): AgentTool {
  return {
    name: CLEARING_DOUBT_TOOL_NAME,
    description:
      "Consult a senior model for step-by-step guidance. Call it when you are UNSURE how to " +
      "proceed, when your attempts keep failing, or when the task feels beyond your capability. " +
      "State the doubt precisely; you receive numbered steps to execute with your own tools.",
    parameters: {
      type: "object",
      properties: {
        doubt: {
          type: "string",
          description:
            "What you are unsure about or stuck on, precisely — what you tried, what happened, " +
            "what you cannot decide",
        },
      },
      required: ["doubt"],
    },
    mutates: false,
    async execute(toolCallId: string, args: Record<string, unknown>, ctx: ToolContext) {
      const doubt = typeof args.doubt === "string" ? args.doubt.trim() : "";
      if (!doubt) {
        return { output: "No doubt stated. Describe precisely what you are unsure about.", isError: true };
      }
      const toolNames = deps.toolNames;
      const context: Context = {
        systemPrompt: CONSULT_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              `TASK: ${deps.task}`,
              `CATEGORIZER RUNNING: ${deps.categorizer}`,
              `THE DOUBT: ${doubt}`,
              `TOOLS AVAILABLE TO THE AGENT: ${toolNames.length ? toolNames.join(", ") : "(its declared toolset)"}`,
              `RUN STATE:`,
              renderState(deps.hops),
            ].join("\n\n"),
            timestamp: Date.now(),
          },
        ],
      };
      try {
        const msg = await deps.llm.complete(deps.model, context, {
          reasoning: "low",
          // The steps ARE the payload; bound thinking so it does not eat the budget.
          reasoningMaxTokens: 2000,
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        if (msg.stopReason === "error") {
          return {
            output: `The senior model could not be consulted (${msg.errorMessage ?? "error"}). Proceed with your best judgement, or ask the user.`,
            isError: true,
          };
        }
        const text = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (!text) {
          return {
            output: "The senior model returned an empty answer. Proceed with your best judgement, or ask the user.",
            isError: true,
          };
        }
        return {
          output: `SENIOR GUIDANCE — execute these steps with your own tools:\n\n${text}`,
          ...(msg.usage ? { usage: msg.usage } : {}),
        };
      } catch (err) {
        return {
          output: `The senior model could not be consulted (${(err as Error).message}). Proceed with your best judgement, or ask the user.`,
          isError: true,
        };
      }
    },
  };
}
