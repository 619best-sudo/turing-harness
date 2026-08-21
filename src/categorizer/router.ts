/**
 * The categorizer router.
 *
 * One cheap, tool-free LLM turn that answers a single question: which
 * categorizer gets the work next — or is the run done (`summarise`)? The
 * choices are rendered WITH their descriptions, prompts-in-brief and return
 * contracts so the selection can be made on substance, not on id spelling.
 *
 * The router is deliberately dumb-safe: any parse failure, transport error or
 * absent LLM falls back to a deterministic heuristic, and an unknown answer
 * token falls back to `summarise` (never an exception, never a stuck chain).
 */
import type { LLMBridge, Model, Usage } from "../types.js";
import { emptyUsage } from "../types.js";
import type { CategorizerDefinition, CategorizerHop, CategorizerId, CategorizerSetup } from "./types.js";
import { DEFAULT_ROUTER_PROMPT } from "./prompts.js";

export type RouterChoice = CategorizerId | "summarise";

/** Fold two Usage records (same helper the orchestrator uses, kept local). */
function addUsage(a: Usage, b: Usage): Usage {
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

export interface RouteCategorizerInput {
  setup: CategorizerSetup;
  /** The choices offered: entry set on the first call, children afterwards. */
  choices: CategorizerDefinition[];
  task: string;
  /** Attachment descriptors for the router's eyes (paths/kinds, not bytes). */
  attachments?: Array<{ path: string; mimeType: string }>;
  /** Mention resolution note (providers/files/unknown). */
  mentionNote?: string;
  /** Completed hops, for run state. */
  hops: CategorizerHop[];
  /** The categorizer that would repeat if chosen again (loop guard hint). */
  lastId?: CategorizerId;
  /** Bug-fix runs bias read→activity_inspect and remind write_edit of evidence. */
  isBugFix?: boolean;
  /** verify:false discourages a post-write inspect hop. */
  preferInspect?: boolean;
  llm: LLMBridge;
  model: Model;
  signal?: AbortSignal;
}

export interface RouteCategorizerResult {
  selection: RouterChoice;
  reason: string;
  usage: Usage;
  /** True when the heuristic fallback produced the answer (no/bad LLM reply). */
  fallback: boolean;
  /** The router's read on whether this is a reported-bug task (hint only). */
  bugFixHint?: boolean;
}

/** Render the choice menu: id + description + returns contract + children. */
function renderChoices(choices: CategorizerDefinition[], lastId?: CategorizerId): string {
  const lines = choices.map((c) => {
    const parts = [`- ${c.id} — ${c.description}`, `    delivers: ${c.returns.description}`];
    if (c.id === lastId) parts.push("    (this one JUST ran — only pick it if it was cut short)");
    return parts.join("\n");
  });
  lines.push("- summarise — nothing more is needed; write the final answer for the user");
  return lines.join("\n");
}

/** Compact one-line state per completed hop. */
function renderState(hops: CategorizerHop[]): string {
  if (!hops.length) return "(nothing has run yet — this is the first choice of the run)";
  return hops.map((h) => `- ${h.id}: ${h.summary}${h.delivered ? "" : " (ended without calling deliver)"}`).join("\n");
}

function parseReply(text: string, choices: CategorizerDefinition[]): RouterChoice | undefined {
  const upper = text.toUpperCase();
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^CATEGORY\s*:/i.test(l));
  const token = (line ?? text).replace(/^CATEGORY\s*:/i, "").trim().toUpperCase();
  if (token.includes("SUMMARISE") || token.includes("SUMMARIZE")) return "summarise";
  const hit = choices.find((c) => upper.includes(c.id.toUpperCase()));
  return hit ? hit.id : undefined;
}

/**
 * Deterministic fallback for when the router LLM cannot answer. Conservative:
 * conversation beats everything on chat-shaped input; otherwise read (gather
 * before mutate); verify preference adds an inspect hop after writes.
 */
export function heuristicRoute(input: RouteCategorizerInput): RouterChoice {
  const { choices, hops, task, preferInspect } = input;
  const has = (id: CategorizerId) => choices.some((c) => c.id === id);
  const last = hops[hops.length - 1];
  const t = task.toLowerCase();

  // After a write hop, inspect when wanted, else summarise.
  if (last?.id === "write_edit") {
    if (preferInspect !== false && has("activity_inspect")) return "activity_inspect";
    return "summarise";
  }
  // After an inspect hop: repair only when defects were found.
  if (last?.id === "activity_inspect") {
    const verdict = (last.deliverable as { verdict?: string } | undefined)?.verdict;
    if (verdict === "fail" && has("write_edit")) return "write_edit";
    return "summarise";
  }
  if (last?.id === "read") {
    // A reported bug gets SEEN before it gets fixed. `activity_reproduce`, not
    // `activity_inspect`: there is nothing to verify yet.
    if (input.isBugFix && has("activity_reproduce")) return "activity_reproduce";
    if (has("write_edit")) return "write_edit";
    return "summarise";
  }
  // Reproduction hands to the fixer whether or not it managed to reproduce —
  // a could-not-reproduce report is still the input a fix works from.
  if (last?.id === "activity_reproduce") {
    if (has("write_edit")) return "write_edit";
    return "summarise";
  }
  // No hops yet (or conversation ran): chat-shaped input stays conversational.
  const looksLikeWork =
    /\b(add|create|fix|change|update|refactor|implement|build|write|edit|delete|test|debug|install|bug|error|crash|broken|fail)\b/.test(t) ||
    /[./\\]\w{2,}/.test(task);
  if (has("conversation") && !looksLikeWork && task.trim().length < 400) return "conversation";
  if (has("read")) return "read";
  if (has("write_edit")) return "write_edit";
  if (has("activity_inspect")) return "activity_inspect";
  if (has("conversation")) return "conversation";
  return "summarise";
}

/** Ask the router model to pick the next categorizer. Never throws. */
export async function routeCategorizer(input: RouteCategorizerInput): Promise<RouteCategorizerResult> {
  const fallbackSelection = heuristicRoute(input);
  let usage = emptyUsage();
  try {
    const system = input.setup.routerPrompt ?? DEFAULT_ROUTER_PROMPT;
    const user = [
      `USER REQUEST: ${input.task}`,
      input.attachments?.length
        ? `ATTACHMENTS: ${input.attachments.map((a) => `${a.path} (${a.mimeType})`).join(", ")}`
        : "ATTACHMENTS: none",
      input.mentionNote ? `MENTIONS: ${input.mentionNote}` : "MENTIONS: none",
      input.isBugFix === true ? "NOTE: the host flagged this run as a reported-bug fix." : "",
      input.preferInspect === false ? "NOTE: verification is disabled for this run — do not pick activity_inspect." : "",
      `RUN STATE:`,
      renderState(input.hops),
      ``,
      `CHOICES:`,
      renderChoices(input.choices, input.lastId),
      ``,
      `Answer with the two lines "CATEGORY: <id or summarise>" and "BUGFIX: <yes|no>".`,
    ]
      .filter((l) => l !== "")
      .join("\n");

    const msg = await input.llm.complete(
      input.model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { reasoning: "off", ...(input.signal ? { signal: input.signal } : {}) },
    );
    if (msg.usage) usage = addUsage(usage, msg.usage);
    if (msg.stopReason === "error") {
      return { selection: fallbackSelection, reason: "router model error — heuristic fallback", usage, fallback: true };
    }
    const text = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // The router reads the request anyway, so its own verdict on "is this a bug
    // report" is free. OR-ed with the host flag by the chain: detection used to
    // depend entirely on the host's regex list, so a bug phrased outside that list
    // lost every bug-specific policy in the run.
    const bugFixHint = /^\s*BUGFIX\s*:\s*(yes|true)\b/im.test(text)
      ? true
      : /^\s*BUGFIX\s*:\s*(no|false)\b/im.test(text)
        ? false
        : undefined;
    const parsed = parseReply(text, input.choices);
    if (!parsed) {
      return {
        selection: fallbackSelection,
        reason: `unparseable router reply — heuristic fallback`,
        usage,
        fallback: true,
        ...(bugFixHint != null ? { bugFixHint } : {}),
      };
    }
    return {
      selection: parsed,
      reason: text.trim().slice(0, 300),
      usage,
      fallback: false,
      ...(bugFixHint != null ? { bugFixHint } : {}),
    };
  } catch (err) {
    return {
      selection: fallbackSelection,
      reason: `router call failed (${(err as Error).message}) — heuristic fallback`,
      usage,
      fallback: true,
    };
  }
}
