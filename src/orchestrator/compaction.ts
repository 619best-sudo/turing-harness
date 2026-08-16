/**
 * Context compaction for a long-running tool loop.
 *
 * The loop appends every assistant turn and every tool result to one growing
 * history and never removes anything. Individual results are now bounded (see
 * `boundToolResultText`), which stops ONE result from ending a run — but forty
 * bounded results still add up, and the failure mode is identical: the provider
 * rejects the request (`413`, or a context-length error) and a run that was
 * working dies with no partial credit.
 *
 * A cap on turns is the wrong fix for that — it truncates short runs to protect
 * long ones. Compaction is the right one: when the history gets large, replace
 * the OLD part with a summary of what it established and keep working. The run
 * continues; only the verbatim transcript of early work is traded away, which is
 * the part the model has already extracted what it needs from.
 *
 * ## The correctness trap
 *
 * A `toolResult` message is only valid immediately after the assistant message
 * whose tool call it answers. Cutting the history at an arbitrary index can
 * leave a result whose call is gone — providers reject that outright, so a naive
 * compactor turns a recoverable size problem into a hard 400. Every cut here is
 * therefore made at a turn boundary; see `findCutIndex`.
 */
import type { AssistantMessage, Context, LLMBridge, Message, Model, Usage } from "../types.js";
import { emptyUsage } from "../types.js";

/** Default threshold in characters (~75k tokens). Override with the env var. */
const DEFAULT_THRESHOLD_CHARS = 300_000;

/** Env var naming the character budget above which the loop compacts. */
export const COMPACTION_ENV_VAR = "TURING_COMPACT_THRESHOLD_CHARS";

/**
 * How many trailing messages stay verbatim.
 *
 * The recent turns are the ones the model is actively reasoning against — the
 * file it just read, the error it is mid-way through fixing. Summarising those
 * is what makes a compacted run feel like it lost its train of thought, so they
 * are never touched.
 */
const KEEP_RECENT = 12;

/**
 * Resolve the threshold.
 *
 * `0` or a negative value disables compaction — an explicit escape hatch for a
 * host that manages context itself. An unparseable value falls back to the
 * default rather than disabling: a typo in an env var should not silently remove
 * the protection that keeps long runs alive.
 */
export function resolveCompactionThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env[COMPACTION_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_THRESHOLD_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_THRESHOLD_CHARS;
  return parsed <= 0 ? Infinity : parsed;
}

/**
 * Per-media allowance when estimating history size. Providers tokenise media
 * (images, audio, video) separately from text characters, so counting the full
 * base64 vastly overstates its share of the request. Worse, inlined base64 lets
 * one or two captures blow the compaction threshold and summarise away the run's
 * load-bearing TEXT context — a user's ask_user answer, completed edits, the file
 * already found — which is how a run "forgets" what it just did and re-asks the
 * same question. Counting a fixed text-equivalent allowance per media block keeps
 * the threshold honest about the part that actually grows without bound: text.
 * (Media COUNT is bounded separately by `pruneHistoricalMedia` in the loop, and
 * non-image media is materialised to a path at the source, so the request stays
 * sane for every modality — image, audio, video, file.)
 */
const MEDIA_SIZE_ALLOWANCE = 1500;

const MEDIA_BLOCK_TYPES = new Set(["image", "audio", "video", "file"]);

/** A content block that represents inlined or referenced media of any modality. */
function isMediaBlock(block: unknown): boolean {
  return (
    block != null &&
    typeof block === "object" &&
    MEDIA_BLOCK_TYPES.has((block as { type?: string }).type ?? "")
  );
}

/** Whether a media block carries inlined base64 `data` (the thing that bloats). */
function mediaHasInlineData(block: unknown): boolean {
  if (!isMediaBlock(block)) return false;
  const t = (block as { type?: string }).type;
  // ImageContent.data is required, so an image block always carries bytes.
  if (t === "image") return true;
  const data = (block as { data?: unknown }).data;
  return typeof data === "string" && data.length > 0;
}

/** Approximate size of a history as the provider will see it — TEXT, not bytes. */
export function historySize(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += sizeOfContent((m as { content?: unknown }).content);
    n += 64; // role / toolName / id / timestamp overhead
  }
  return n;
}

function sizeOfContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (typeof block === "string") {
      n += block.length;
      continue;
    }
    if (isMediaBlock(block)) {
      // Base64 is NOT counted — see MEDIA_SIZE_ALLOWANCE. A path/uri still counts
      // (it is text the provider sends), so a path-based block is charged honestly.
      n += MEDIA_SIZE_ALLOWANCE;
      const uri = (block as { uri?: unknown }).uri;
      if (typeof uri === "string") n += uri.length;
    } else if (block && typeof block === "object") {
      const bt = (block as { type?: string }).type;
      if (bt === "text") {
        n += String((block as { text?: unknown }).text ?? "").length;
      } else {
        // thinking blocks, tool-call args, tool-result details: small, count honestly.
        n += JSON.stringify(block).length;
      }
    }
  }
  return n;
}

/**
 * How many of the most recent media-bearing messages keep their inlined media.
 * The model only needs the latest capture to reason about the current state;
 * anything older is history, and re-sending its base64 every turn is pure cost
 * (and the thing that used to trip compaction off a screenshot or audio clip).
 */
const KEEP_RECENT_MEDIA_MESSAGES = 2;

const PRUNED_MEDIA_MARKER =
  "[an earlier media capture from this run (screenshot / audio / video / file) was omitted from history " +
  "to keep the context small — its saved path was named when it was produced; re-capture or re-read it if needed]";

/**
 * Drop INLINED (base64) media blocks — image, audio, video or file — from all
 * but the last {@link KEEP_RECENT_MEDIA_MESSAGES} media-bearing messages,
 * replacing each dropped block with a short text marker.
 *
 * Captures arrive as base64 blocks that otherwise accumulate in the history
 * forever — every turn re-sends every prior capture, ballooning the provider
 * request. This keeps only the most recent captures and turns the rest into a
 * marker. Path/uri-only media blocks (no `data`) are LEFT ALONE: they are small,
 * and they are how a persisted capture should travel once materialised to disk.
 * Mutates `messages` in place; returns the number of blocks pruned.
 */
export function pruneHistoricalMedia(messages: Message[]): number {
  const mediaMsgIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const c = (messages[i] as { content?: unknown }).content;
    if (Array.isArray(c) && c.some((b) => mediaHasInlineData(b))) {
      mediaMsgIdx.push(i);
    }
  }
  const keepFrom = mediaMsgIdx.length - KEEP_RECENT_MEDIA_MESSAGES;
  let pruned = 0;
  for (let k = 0; k < keepFrom; k++) {
    const i = mediaMsgIdx[k]!;
    const content = (messages[i] as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    (messages[i] as { content: unknown[] }).content = content.map((b) =>
      mediaHasInlineData(b) ? { type: "text", text: PRUNED_MEDIA_MARKER } : b,
    );
    pruned++;
  }
  return pruned;
}

/**
 * The earliest index at or after `from` that is safe to keep from.
 *
 * Safe means "not a `toolResult`": a result kept without the assistant message
 * that called it is an orphan the provider rejects. Returns -1 when no safe cut
 * exists (every remaining message is a tool result), in which case the caller
 * must not compact — better a large request than a malformed one.
 */
export function findCutIndex(messages: Message[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    if (messages[i]!.role !== "toolResult") return i;
  }
  return -1;
}

export interface CompactionInput {
  messages: Message[];
  llm: LLMBridge;
  model: Model;
  /** Characters above which compaction runs. */
  threshold: number;
  signal?: AbortSignal;
}

export interface CompactionResult {
  messages: Message[];
  /** True when the history was actually rewritten. */
  compacted: boolean;
  /** Characters removed (0 when nothing happened). */
  savedChars: number;
  usage: Usage;
}

/**
 * What the summary must carry for the run to CONTINUE, not merely to be described.
 *
 * The distinction is the whole design. A readable recap of what happened is
 * useless to an agent mid-task; it needs the things it would otherwise have to
 * rediscover, and the things it must not silently get wrong. Each section below
 * exists because losing it breaks the next turn in a specific way:
 *
 * - the PLAN and step status, or it restarts work already finished;
 * - user instructions VERBATIM, because a paraphrase of "use the tokens file,
 *   never raw hex" drifts into "use the project's styling conventions", which
 *   permits exactly what the user forbade;
 * - what was VERIFIED versus assumed, or it reports success on work nobody ran;
 * - the RUNTIME facts (ports, servers, working commands) it paid to discover;
 * - and dead ends, or it re-explores them with the same result.
 *
 * The length cap is not tidiness: a summary that grows without bound defeats the
 * compaction that produced it.
 */
const SUMMARY_SYSTEM = [
  "You are compacting the transcript of a coding agent's run. The agent is MID-TASK and will keep working from",
  "what you write — your output REPLACES the transcript. Anything you leave out is gone for the rest of the run.",
  "You are not writing a report for a human; you are writing the agent's working memory.",
  "",
  "Record, only where the transcript actually shows it:",
  "- TASK & PLAN: what is being built, the steps agreed, and which are DONE / IN PROGRESS / NOT STARTED.",
  "- USER INSTRUCTIONS: quote them VERBATIM, especially corrections. \"Colors come from src/theme/tokens.ts,",
  "  never raw hex\" must survive word for word — paraphrasing a constraint into a generality permits exactly",
  "  what the user ruled out.",
  "- FILES touched, by exact path, and what each is now — created, edited (what changed), or read (what it",
  "  contains that matters). Name the symbols, functions and exports involved.",
  "- FINDINGS: how the relevant code actually works, and DEAD ENDS — a path already ruled out, with why, so it",
  "  is not re-explored.",
  "- COMMANDS run and what they actually returned: tests passing or failing (which ones), build errors verbatim,",
  "  HTTP statuses and response bodies.",
  "- VERIFIED vs ASSUMED: state plainly what was actually observed to work and what was only written. Anything",
  "  not verified must be listed as still needing verification.",
  "- RUNTIME/ENVIRONMENT facts that were expensive to learn: a dev server already running and on which port, the",
  "  command that works for this project, credentials or fixtures already set up, a device or emulator in use.",
  "- OPEN QUESTIONS asked of the user and the answers received.",
  "- NEXT: the immediate next action the run was about to take.",
  "",
  "Rules:",
  "- Be specific and quote: exact paths, symbol names, error text, numbers, commands. A vague summary is worse",
  "  than none, because the agent acts on it as if it were complete.",
  "- Do NOT reproduce file contents. Summarise what a file IS; the agent re-reads it when it needs the bytes.",
  "- Do NOT narrate the transcript (\"then it called read\"). Record what is TRUE about the project and the task.",
  "- Do NOT speculate, advise, or invent. If something is unknown or was never confirmed, say so.",
  "- Keep it under ~600 words. It has to be smaller than what it replaces.",
].join("\n");

/**
 * Compact `messages` when they exceed `threshold`.
 *
 * Keeps the first message (the task — losing it means losing what the run is
 * FOR), replaces the middle with one summary, and keeps the last `KEEP_RECENT`
 * messages verbatim. Returns the input unchanged when it is under threshold,
 * when there is nothing substantial to compact, or when the summariser fails —
 * a failed compaction must degrade to "carry on with a big context", never to a
 * broken history.
 */
export async function compactHistory(input: CompactionInput): Promise<CompactionResult> {
  const { messages, threshold } = input;
  const before = historySize(messages);
  const noop: CompactionResult = { messages, compacted: false, savedChars: 0, usage: emptyUsage() };
  if (before <= threshold) return noop;

  // Keep the opening message: it carries the task, the working directory and the
  // user's own words. A run that forgets what it was asked is worse than one
  // that runs out of room.
  const head = messages.length > 0 ? [messages[0]!] : [];
  const tailStart = findCutIndex(messages, Math.max(1, messages.length - KEEP_RECENT));
  if (tailStart < 0) return noop;
  const middle = messages.slice(1, tailStart);
  // Nothing worth the round trip — the size is in the head or the recent tail,
  // and summarising two messages saves less than the summary costs.
  if (middle.length < 4) return noop;

  const transcript = middle
    .map((m) => {
      const role = m.role === "toolResult" ? `tool:${(m as { toolName?: string }).toolName ?? "?"}` : m.role;
      const text = extractText(m);
      return text ? `[${role}] ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  const ctx: Context = {
    systemPrompt: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: `TRANSCRIPT TO COMPACT:\n\n${transcript}`, timestamp: Date.now() }],
  };

  let summary = "";
  let usage = emptyUsage();
  try {
    const reply = await input.llm.complete(input.model, ctx, {
      temperature: 0,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (reply.stopReason === "error") return noop;
    summary = extractText(reply).trim();
    usage = reply.usage ?? emptyUsage();
  } catch {
    // The bridge threw (transport, abort). Carrying a large context is still a
    // working run; a half-applied compaction is not.
    return noop;
  }
  if (!summary) return noop;

  const summaryMessage: Message = {
    role: "user",
    content:
      `[COMPACTED CONTEXT] Earlier turns of this run were summarised to stay within the context limit. The ` +
      `record below is what they established: treat it as work ALREADY DONE and do not redo it.\n\n` +
      // The dangerous failure after compaction is not forgetting — it is
      // misplaced confidence. The transcript that proved a file was read is gone,
      // but the summary still describes that file, so a model can believe it
      // knows the contents and edit against a remembered anchor. `edit` needs a
      // byte-exact `oldString`; a remembered one either fails or, worse, matches
      // the wrong place. Say this here rather than trusting the general guidance,
      // because the general guidance says "you already read it this run".
      `IMPORTANT: you no longer have the file contents, only this description of them. Before you edit or ` +
      `overwrite ANY file mentioned here, \`read\` it again — an anchor you remember is not an anchor on disk. ` +
      `Do not re-run work listed as done, and do not claim anything listed as unverified has been verified.\n\n` +
      `${summary}`,
    timestamp: Date.now(),
  } as Message;

  const next = [...head, summaryMessage, ...messages.slice(tailStart)];
  const after = historySize(next);
  // A "compaction" that grew the history is a failure, not a saving.
  if (after >= before) return noop;
  return { messages: next, compacted: true, savedChars: before - after, usage };
}

/** Concatenated text of any message shape the loop stores. */
function extractText(message: Message | AssistantMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => c.text)
    .join("\n");
}
