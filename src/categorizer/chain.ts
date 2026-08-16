/**
 * The categorizer chain — v2's run driver.
 *
 * Replaces both the 4P phase chain and the classic flat run. The shape:
 *
 *   mentions → [router] → categorizer (scoped tools + own model + deliver)
 *                     ↑                ↓ deliverable
 *                     └── [router over children ∪ summarise] … loop
 *   → probe-strip cleanup → summary turn → RunLoopResult
 *
 * Context passing is the whole point: each categorizer runs a FRESH loop (the
 * first hop receives nothing but the task), and a later hop receives ONLY what
 * its `accepts` names — deliverables from `accepts.from`, raw call records for
 * `accepts.tools`. No shared transcript, ever; that is what keeps a small model
 * effective.
 *
 * The per-call escalation machinery (Model-B authoring by complexity/category,
 * staged reads, routeModel/toolModelCandidates) is NOT re-implemented here — it
 * lives in `runToolLoop`, which this chain drives once per categorizer with the
 * categorizer's scoped toolset and driver model.
 */
import * as path from "node:path";
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  LiveImage,
  LLMBridge,
  MediaRef,
  Model,
  PlanApprovalCallback,
  PlanSet,
  RunStep,
  ThinkingLevel,
  ThreadFollowUpContext,
  ToolContext,
  TranscriptMode,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import type { Registry } from "../registry/registry.js";
import type { LogStore } from "../logging/logger.js";
import { PermissionGate } from "../orchestrator/permission.js";
import { ClarifyGate } from "../orchestrator/clarify-gate.js";
import { runToolLoop, type ToolLoopResult } from "../orchestrator/loop.js";
import { PROBE_MARKER_RE } from "../probe-marker.js";
import { triageImageAttachment, triageDocumentAttachment, isDocumentRef } from "../orchestrator/attachment-triage.js";
import type { ModelRouter } from "../types.js";
import type { ProjectCategory } from "../presets/project-presets.js";
import {
  type CategorizerDefinition,
  type CategorizerDeliverable,
  type CategorizerHop,
  type CategorizerSetup,
  type CategorizerToolRecord,
} from "./types.js";
import { getCategory, entryCategories } from "./setup.js";
import { buildCategorizerSystemPrompt } from "./prompts.js";
import {
  createDeliverTool,
  deriveFallbackDeliverable,
  DELIVER_TOOL_NAME,
  type DeliverBox,
} from "./deliver.js";
import { createClearingDoubtTool, CLEARING_DOUBT_TOOL_NAME } from "./clearing-doubt.js";
import { extractMentionTokens, resolveMentions, renderMentionNote } from "./mentions.js";
import { routeCategorizer, type RouterChoice } from "./router.js";

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface CategorizerChainInput {
  task: string;
  setup: CategorizerSetup;
  llm: LLMBridge;
  permission: PermissionGate;
  registry?: Registry;
  logStore: LogStore;
  emit: (e: AgentEvent) => void;
  cwd: string;
  signal?: AbortSignal;
  /** Image attachments (enrichment/triage is run by the chain itself). */
  images?: Array<{ path: string; mimeType: string }>;
  /** Non-image attachments. */
  files?: Array<{ path: string; mimeType: string }>;
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>;
  planApproval?: PlanApprovalCallback;
  /** Show the plan review card (write_edit's create_plan). False ⇒ auto-approve. */
  planMode?: boolean;
  transcriptMode?: TranscriptMode;
  emitReasoning?: boolean;
  emitText?: boolean;
  toolModelCandidates?: string[];
  routeModel?: ModelRouter;
  visionModel?: string;
  authorOnlyWrites?: boolean;
  /** Host-flagged bug fix (router hint + write_edit directive). */
  isBugFix?: boolean;
  /** Triage image/document attachments up front (default true). */
  autoTriageAttachments?: boolean;
  /** RunOptions.verify !== false (router hint: prefer an inspect hop). */
  verifyEnabled?: boolean;
  maxStepsPerCategorizer?: number;
  temperature?: number;
  /** Base reasoning effort; a categorizer's own `reasoning` wins. */
  reasoning?: ThinkingLevel;
  /** Per-categorizer reasoning resolution (role-slot overrides). Wins over `reasoning`. */
  reasoningFor?: (def: CategorizerDefinition) => ThinkingLevel | undefined;
  projectCategory?: ProjectCategory;
  followUpContext?: ThreadFollowUpContext;
  /** Resolved driver model for a categorizer (id → Model). Owned by the caller. */
  modelFor: (def: CategorizerDefinition) => Model;
  /**
   * Extra tools per categorizer beyond the setup list (preset/host policy).
   * Unioned in, deduped by name; never replaces the setup's own tools.
   */
  extraToolsFor?: (categorizerId: string) => AgentTool[];
  routerModel: Model;
  summaryModel: Model;
  doubtModel: Model;
  /** Host hook after each completed hop (Session memory reconciliation). */
  afterCategorizer?: (hop: CategorizerHop, def: CategorizerDefinition) => Promise<void> | void;
}

export interface CategorizerChainResult {
  route: "conversational" | "task";
  success: boolean;
  summary?: string;
  steps: RunStep[];
  planSet?: PlanSet;
  refs: MediaRef[];
  usage: Usage;
  pendingUserQuestion?: AskUserQuestionRequest;
  error?: string;
  hops: CategorizerHop[];
  writtenPaths: string[];
  readPaths: string[];
  discoveredPaths: string[];
  verified?: boolean;
}

/** Fold usage records. */
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

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------
// Toolset assembly
// ---------------------------------------------------------------------------

/**
 * Resolve a categorizer's executable toolset: its own tools + the setup's
 * global tools + mention-resolved providers, injected `deliver` (terminal) and
 * `clearing_doubt`. Missing names are skipped with a logged warning so a setup
 * can list optional tools (the *_memory set exists only in project sessions).
 */
function resolveCategorizerTools(
  input: CategorizerChainInput,
  def: CategorizerDefinition,
  box: DeliverBox,
  mentionTools: AgentTool[],
  hops: CategorizerHop[],
): AgentTool[] {
  const wanted = [...def.tools, ...input.setup.globalTools];
  const byName = new Map<string, AgentTool>();
  const missing: string[] = [];
  const all = input.registry?.allTools() ?? [];
  for (const name of wanted) {
    let tool: AgentTool | undefined;
    try {
      tool = input.registry?.getTool(name);
    } catch {
      tool = undefined;
    }
    // An MCP/pool wrapper of the same tool carries a namespaced name
    // (`server__web_search`); a category that gets `web_search` gets the
    // wrapper too — the capability is what the setup names, not the spelling.
    if (!tool) {
      tool = all.find((t) => t.name.endsWith(`__${name}`));
    }
    if (tool) byName.set(tool.name, tool);
    else missing.push(name);
  }
  for (const t of mentionTools) if (!byName.has(t.name)) byName.set(t.name, t);
  // Registry scope: tools registered + scoped to this categorizer id join it
  // (a host's custom tool, an MCP server a preset scoped here). This is how a
  // registered capability reaches the categorizers its scope names.
  try {
    for (const t of input.registry?.getToolsForCategorizer(def.id) ?? []) {
      if (!byName.has(t.name)) byName.set(t.name, t);
    }
  } catch {
    // scope resolution is additive; a failure never blocks the hop
  }
  // Preset/host policy: extras scoped to this categorizer. Extras OVERRIDE a
  // same-named default (a host pinning a wrapped/spy tool wins over the
  // registry's), which is what `setCategorizerTools(id, [tools])` promises.
  try {
    for (const t of input.extraToolsFor?.(def.id) ?? []) {
      byName.set(t.name, t);
    }
  } catch {
    // policy extras are additive; a failure never blocks the hop
  }

  if (missing.length) {
    input.logStore.append({
      tags: ["categorizer", "categorizer:tools"],
      level: "warn",
      message: `categorizer "${def.id}": ${missing.length} configured tool(s) not registered — skipped`,
      data: { categorizer: def.id, missing },
    });
  }

  const tools = [...byName.values()];
  tools.push(createDeliverTool(def, box));
  if (!byName.has(CLEARING_DOUBT_TOOL_NAME)) {
    tools.push(
      createClearingDoubtTool({
        llm: input.llm,
        model: input.doubtModel,
        task: input.task,
        categorizer: def.id,
        hops,
        toolNames: tools.map((t) => t.name),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
  }
  return tools;
}

/**
 * Enforce "create_plan always" in write_edit: the first write/edit is refused
 * (twice, then allowed — a deadlock is worse than a soft nudge) until a
 * create_plan call has succeeded in this loop.
 */
function enforcePlanFirst(tools: AgentTool[]): AgentTool[] {
  let planSeen = false;
  let refusals = 0;
  return tools.map((t) => {
    if (t.name === "create_plan") {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          const res = await t.execute(id, args, ctx);
          if (!res.isError) planSeen = true;
          return res;
        },
      };
    }
    if (t.name === "write" || t.name === "edit") {
      return {
        ...t,
        mutates: t.mutates,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          if (!planSeen && refusals < 2) {
            refusals++;
            return {
              output:
                "create_plan comes FIRST in this categorizer: break the work into plan steps, " +
                "then make this change. Call create_plan now and re-issue this call.",
              isError: true,
            };
          }
          return t.execute(id, args, ctx);
        },
      };
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// Opening message (smart context passing)
// ---------------------------------------------------------------------------

function renderDeliverable(d: CategorizerDeliverable): string {
  try {
    return trunc(JSON.stringify(d, null, 2), 4000);
  } catch {
    return "(unserializable deliverable)";
  }
}

function buildOpening(
  input: CategorizerChainInput,
  def: CategorizerDefinition,
  hops: CategorizerHop[],
  ctx: {
    mentionNote?: string;
    imageNote?: string;
    fileNote?: string;
    mentionFiles: string[];
  },
): string {
  const lines: string[] = [];
  lines.push(`TASK: ${input.task}`);
  lines.push(`WORKING DIRECTORY: ${input.cwd}`);
  if (ctx.imageNote) lines.push(ctx.imageNote);
  if (ctx.fileNote) lines.push(ctx.fileNote);
  for (const f of ctx.mentionFiles) lines.push(`MENTIONED FILE: ${f}`);
  if (ctx.mentionNote) lines.push(ctx.mentionNote);

  if (hops.length === 0) {
    const fu = input.followUpContext;
    if (fu?.mode === "structured_continue" && fu.previousRun) {
      const prev = fu.previousRun;
      lines.push(
        [
          `PREVIOUS RUN IN THIS THREAD (continuity — do not redo what it finished):`,
          `  its task: ${prev.task}`,
          `  outcome: ${prev.summary}`,
          prev.readPaths?.length ? `  files it read: ${prev.readPaths.join(", ")}` : "",
          prev.writtenPaths?.length ? `  files it wrote: ${prev.writtenPaths.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return lines.join("\n\n");
  }

  // Accepted context ONLY (the v2 contract).
  const from = new Set(def.accepts?.from ?? []);
  const tools = new Set(def.accepts?.tools ?? []);
  if (from.size === 0 && tools.size === 0) {
    lines.push(
      "CONTEXT: this categorizer starts fresh by design — only the task, attachments and this " +
        "note travel with you.",
    );
    return lines.join("\n\n");
  }
  lines.push("CONTEXT FROM EARLIER STEPS (this is everything they handed you):");
  for (const hop of hops) {
    if (from.has(hop.id) && hop.deliverable) {
      lines.push(`--- deliverable from ${hop.id} ---\n${renderDeliverable(hop.deliverable)}`);
    }
    if (tools.size > 0 && hop.toolRecords.length) {
      const records = hop.toolRecords.filter((r) => tools.has(r.tool));
      for (const r of records) {
        lines.push(
          `--- ${r.tool} call from ${hop.id}${r.target ? ` (${r.target})` : ""} ---` +
            (r.reasoning ? `\nreasoning: ${r.reasoning}` : "") +
            (r.output ? `\nresult: ${r.output}` : ""),
        );
      }
    }
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool-record extraction (accepted.tools channel)
// ---------------------------------------------------------------------------

/** Compact per-call records from a finished loop's message history. */
function extractToolRecords(
  messages: ToolLoopResult["messages"],
): CategorizerToolRecord[] {
  const out: CategorizerToolRecord[] = [];
  const argsById = new Map<string, Record<string, unknown>>();
  let lastReasoning = "";
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) lastReasoning = text;
      for (const c of m.content) {
        if (c.type === "toolCall") argsById.set(c.id, c.arguments);
      }
    } else if (m.role === "toolResult") {
      const args = argsById.get(m.toolCallId) ?? {};
      const target =
        (typeof args.path === "string" && args.path) ||
        (typeof args.query === "string" && args.query) ||
        (typeof args.command === "string" && trunc(args.command, 120)) ||
        (typeof args.url === "string" && args.url) ||
        undefined;
      const output = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (!m.isError) {
        out.push({
          tool: m.toolName,
          ...(target ? { target: trunc(target, 200) } : {}),
          ...(output ? { output: trunc(output, 700) } : {}),
          ...(lastReasoning ? { reasoning: trunc(lastReasoning, 300) } : {}),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One hop
// ---------------------------------------------------------------------------

interface HopRun {
  hop: CategorizerHop;
  loop: ToolLoopResult;
}

async function runCategorizerHop(
  input: CategorizerChainInput,
  def: CategorizerDefinition,
  hops: CategorizerHop[],
  shared: {
    clarifyGate: ClarifyGate;
    mentionTools: AgentTool[];
    mentionNote?: string;
    images: LiveImage[];
    fileNote?: string;
    imageNote?: string;
    mentionFiles: string[];
    mediaFact?: string;
    triageCallback?: (img: { path: string; mimeType: string }) => Promise<{ fact?: string; note?: string; category?: string } | undefined>;
  },
): Promise<HopRun> {
  const model = input.modelFor(def);
  const box: DeliverBox = { delivered: false };
  let tools = resolveCategorizerTools(input, def, box, shared.mentionTools, hops);
  if (def.id === "write_edit") tools = enforcePlanFirst(tools);
  const toolNames = tools.map((t) => t.name);

  const systemPrompt = buildCategorizerSystemPrompt(def, toolNames, {
    authorOnlyWrites: input.authorOnlyWrites,
    isBugFix: input.isBugFix,
    ...(input.projectCategory ? { projectCategory: input.projectCategory } : {}),
  });

  const opening = buildOpening(input, def, hops, {
    mentionNote: shared.mentionNote,
    imageNote: shared.imageNote,
    fileNote: shared.fileNote,
    mentionFiles: shared.mentionFiles,
  });

  input.emit({ type: "categorizer_start", categorizer: def.id, model: model.openRouterSlug ?? model.id });
  input.logStore.append({
    tags: ["categorizer", `categorizer:${def.id}`],
    level: "info",
    message: `hop ${hops.length}: running categorizer "${def.id}" (${toolNames.length} tools, model ${model.openRouterSlug ?? model.id})`,
    data: { categorizer: def.id, tools: toolNames },
  });

  // Read deliverables hand their snippets to the authoring pass as bounded
  // file contents (write/edit's Model-B context), not just opening prose.
  const acceptedSnippets = hops
    .filter((h) => (def.accepts?.from ?? []).includes(h.id))
    .flatMap((h) => {
      const files = (h.deliverable as { files?: Array<{ path: string; snippet?: string }> } | undefined)?.files;
      return (files ?? []).filter((f): f is { path: string; snippet: string } => Boolean(f.snippet));
    })
    .map((f) => ({ path: f.path, content: f.snippet }));

  const loop = await runToolLoop({
    task: input.task,
    authoringTask: input.task,
    systemPrompt,
    userMessage: opening,
    tools,
    model,
    toolModelCandidates: input.toolModelCandidates,
    ...(input.routeModel ? { routeModel: input.routeModel } : {}),
    ...(input.visionModel ? { visionModel: input.visionModel } : {}),
    llm: input.llm,
    permission: input.permission,
    ...(input.registry ? { registry: input.registry } : {}),
    logStore: input.logStore,
    emit: input.emit,
    cwd: input.cwd,
    ...(input.signal ? { signal: input.signal } : {}),
    maxSteps: def.maxSteps ?? input.maxStepsPerCategorizer,
    temperature: input.temperature,
    reasoning: def.reasoning ?? input.reasoningFor?.(def) ?? input.reasoning,
    ...(input.transcriptMode ? { transcriptMode: input.transcriptMode } : {}),
    ...(input.emitReasoning != null ? { emitReasoning: input.emitReasoning } : {}),
    ...(input.emitText != null ? { emitText: input.emitText } : {}),
    ...(input.askUserQuestion ? { askUserQuestion: input.askUserQuestion } : {}),
    // The plan review card exists only in plan mode; without it the plan tool
    // auto-approves its first draft silently (see plan.ts).
    ...(def.id === "write_edit" && input.planMode && input.planApproval
      ? { planApproval: input.planApproval }
      : {}),
    ...(shared.images.length ? { images: shared.images } : {}),
    ...(acceptedSnippets.length ? { attachedFileContents: acceptedSnippets } : {}),
    ...(shared.mediaFact ? { mediaFact: shared.mediaFact } : {}),
    ...(shared.triageCallback ? { triageAttachment: shared.triageCallback } : {}),
    clarifyGate: shared.clarifyGate,
    phase: def.id,
    ...(input.projectCategory ? { projectCategory: input.projectCategory } : {}),
    label: `categorizer:${def.id}`,
  });

  const deliverable = box.delivered
    ? box.deliverable
    : deriveFallbackDeliverable(def, {
        writtenPaths: loop.writtenPaths,
        readPaths: loop.readPaths,
        finalText: loop.finalText,
      });
  if (!box.delivered) {
    input.logStore.append({
      tags: ["categorizer", `categorizer:${def.id}`],
      level: "warn",
      message: `categorizer "${def.id}" ended without calling deliver — derived a fallback deliverable`,
    });
  }

  const summaryText =
    (deliverable as { summary?: string }).summary ??
    (deliverable as { codeSummary?: string }).codeSummary ??
    (deliverable as { findings?: string }).findings ??
    (deliverable as { notes?: string }).notes ??
    trunc(loop.finalText, 200) ??
    "(no summary)";

  const hop: CategorizerHop = {
    id: def.id,
    index: hops.length,
    deliverable,
    summary: trunc(String(summaryText).trim() || "(no summary)", 240),
    delivered: box.delivered,
    toolRecords: extractToolRecords(loop.messages),
    writtenPaths: loop.writtenPaths,
    readPaths: loop.readPaths,
    ...(loop.planSet ? { planSet: loop.planSet } : {}),
  };

  input.emit({
    type: "categorizer_end",
    categorizer: def.id,
    summary: hop.summary,
    ...(deliverable ? { deliverable } : {}),
    ...(loop.writtenPaths.length ? { writtenPaths: loop.writtenPaths } : {}),
    ...(loop.readPaths.length ? { readPaths: loop.readPaths } : {}),
  });
  if (input.afterCategorizer) {
    try {
      await input.afterCategorizer(hop, def);
    } catch {
      // host hook failures never break the chain
    }
  }
  return { hop, loop };
}

// ---------------------------------------------------------------------------
// Attachment triage (ported from the classic run, unchanged in spirit)
// ---------------------------------------------------------------------------

async function triageAttachments(input: CategorizerChainInput): Promise<{
  images: LiveImage[];
  mediaFact?: string;
  usage?: Usage;
  imageNote?: string;
  fileNote?: string;
}> {
  const images: LiveImage[] = [];
  const facts: string[] = [];
  let usage: Usage | undefined;
  let mediaTool: AgentTool | undefined;
  try {
    mediaTool = input.registry?.getTool("media_analysis");
  } catch {
    mediaTool = undefined;
  }
  const notes: string[] = [];
  const tctx = mediaTool && input.registry
    ? {
        tool: mediaTool,
        cwd: input.cwd,
        llm: input.llm,
        registry: input.registry,
        logStore: input.logStore,
        ...(input.signal ? { signal: input.signal } : {}),
      }
    : undefined;

  for (const img of input.images ?? []) {
    if (tctx) {
      try {
        const { result, fact, usage: u } = await triageImageAttachment(img, input.task, tctx);
        if (fact) facts.push(fact);
        if (u) usage = usage ? addUsage(usage, u) : u;
        images.push({
          path: img.path,
          mimeType: img.mimeType,
          ...(result.category ? { category: result.category } : {}),
          ...(result.note ? { label: result.note } : {}),
        });
        continue;
      } catch {
        // fall through to un-enriched
      }
    }
    images.push({ path: img.path, mimeType: img.mimeType });
  }
  for (const img of images) {
    notes.push(`${img.path}${img.label ? ` — ${img.label}` : ""} (${img.mimeType})`);
  }

  const fileLines: string[] = [];
  for (const f of input.files ?? []) {
    fileLines.push(`${f.path} (${f.mimeType})`);
    if (tctx && isDocumentRef(f)) {
      try {
        const { fact, usage: u } = await triageDocumentAttachment(f, input.task, tctx);
        if (fact) facts.push(fact);
        if (u) usage = usage ? addUsage(usage, u) : u;
      } catch {
        // enrichment is best-effort
      }
    }
  }

  return {
    images,
    ...(facts.length ? { mediaFact: facts.join("\n") } : {}),
    ...(usage ? { usage } : {}),
    ...(notes.length
      ? { imageNote: `ATTACHED IMAGES (roles triaged):\n${notes.map((n) => `- ${n}`).join("\n")}` }
      : {}),
    ...(fileLines.length
      ? { fileNote: `ATTACHED FILES (available to read/analyze):\n${fileLines.map((n) => `- ${n}`).join("\n")}` }
      : {}),
  };
}

/** The mid-run triage callback, or undefined when triage is off/no tool. */
function buildTriageCallback(
  input: CategorizerChainInput,
): ((img: { path: string; mimeType: string }) => Promise<{ fact?: string; note?: string; category?: string } | undefined>) | undefined {
  const registry = input.registry;
  if (input.autoTriageAttachments === false || !registry) return undefined;
  let mediaTool: AgentTool | undefined;
  try {
    mediaTool = registry.getTool("media_analysis");
  } catch {
    mediaTool = undefined;
  }
  if (!mediaTool) return undefined;
  return async (img) => {
    if (input.signal?.aborted) return undefined;
    try {
      const { result, fact } = await triageImageAttachment(img, input.task, {
        tool: mediaTool,
        cwd: input.cwd,
        llm: input.llm,
        registry,
        logStore: input.logStore,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        ...(fact ? { fact } : {}),
        ...(result.category ? { category: result.category } : {}),
        ...(result.note ? { note: result.note } : {}),
      };
    } catch {
      return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Probe stripping (post-chain cleanup)
// ---------------------------------------------------------------------------

async function scanForProbeMarkers(cwd: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const fs = await import("node:fs/promises");
  const remaining: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const content = await fs.readFile(abs, "utf8");
      if (PROBE_MARKER_RE.test(content)) remaining.push(p);
    } catch {
      // missing/unreadable → can't confirm a marker; skip
    }
  }
  return remaining;
}

async function stripRemainingProbes(
  input: CategorizerChainInput,
  paths: string[],
  model: Model,
): Promise<Usage | undefined> {
  const tools: AgentTool[] = [];
  for (const name of ["activity_cleanup", "remove_log", "bash_readonly", "read"]) {
    try {
      const t = input.registry?.getTool(name);
      if (t) tools.push(t);
    } catch {
      /* skip */
    }
  }
  if (!tools.some((t) => t.name === "activity_cleanup" || t.name === "remove_log")) return undefined;
  const loop = await runToolLoop({
    task: input.task,
    systemPrompt: [
      "You are the cleanup pass of a coding run. Earlier categorizers instrumented these files with",
      "activity-monitor probes (`__t(...)` / TURING_TRACE lines). Strip every probe marker from each",
      "file, leaving all other content byte-identical. Use remove_log / activity_cleanup. When every",
      "listed file is clean, stop.",
    ].join(" "),
    userMessage: `Files still carrying probe markers:\n${paths.map((p) => `- ${p}`).join("\n")}`,
    tools,
    model,
    llm: input.llm,
    permission: input.permission,
    ...(input.registry ? { registry: input.registry } : {}),
    logStore: input.logStore,
    emit: input.emit,
    cwd: input.cwd,
    ...(input.signal ? { signal: input.signal } : {}),
    maxSteps: 6,
    phase: "activity_inspect",
    label: "cleanup:strip-probes",
  });
  input.logStore.append({
    tags: ["categorizer", "categorizer:cleanup"],
    level: "warn",
    message: `stripped instrumentation from ${paths.length} file(s) after the chain`,
    data: { paths },
  });
  return loop.usage;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** Run the categorizer chain for one task. Never throws. */
export async function runCategorizerChain(input: CategorizerChainInput): Promise<CategorizerChainResult> {
  const maxHops = input.setup.maxHops ?? 6;
  const hops: CategorizerHop[] = [];
  let error: string | undefined;
  let pendingUserQuestion: AskUserQuestionRequest | undefined;
  const refs: MediaRef[] = [];
  const writtenPaths: string[] = [];
  const readPaths: string[] = [];
  const discoveredPaths: string[] = [];
  const instrumented = new Set<string>();

  // --- mentions ---
  let mentionTools: AgentTool[] = [];
  let mentionNote: string | undefined;
  let mentionFiles: string[] = [];
  if (input.registry) {
    try {
      const res = await resolveMentions(extractMentionTokens(input.task), input.registry, input.cwd);
      mentionTools = res.tools;
      mentionFiles = res.files;
      mentionNote = renderMentionNote(res);
      if (res.providers.length) {
        input.logStore.append({
          tags: ["categorizer", "categorizer:mentions"],
          level: "info",
          message: `mentions resolved: providers [${res.providers.join(", ")}], files [${res.files.join(", ")}]`,
        });
      }
    } catch {
      // mention resolution is best-effort
    }
  }

  // --- attachment triage ---
  const triage =
    input.autoTriageAttachments === false
      ? {
          images: (input.images ?? []).map((i) => ({ path: i.path, mimeType: i.mimeType })),
          mediaFact: undefined as string | undefined,
          usage: undefined as Usage | undefined,
          imageNote: undefined as string | undefined,
          fileNote: undefined as string | undefined,
        }
      : await triageAttachments(input);
  let totalUsage = triage.usage ?? emptyUsage();

  // Mid-run triage callback (user answers, plan-review step attachments): the
  // same describe→ocr pass the up-front pre-pass runs.
  const triageCallback = buildTriageCallback(input);

  const shared = {
    clarifyGate: new ClarifyGate(),
    mentionTools,
    mentionNote,
    images: triage.images,
    imageNote: triage.imageNote,
    fileNote: triage.fileNote,
    mentionFiles,
    ...(triageCallback ? { triageCallback } : {}),
    ...(triage.mediaFact ? { mediaFact: triage.mediaFact } : {}),
  };

  // --- hop loop ---
  let choices = entryCategories(input.setup);
  let lastSelection: RouterChoice | undefined;
  try {
    for (let hopIndex = 0; hopIndex < maxHops; hopIndex++) {
      if (input.signal?.aborted) throw new Error("aborted");

      const routed = await routeCategorizer({
        setup: input.setup,
        choices,
        task: input.task,
        attachments: [...(input.images ?? []), ...(input.files ?? [])],
        ...(mentionNote ? { mentionNote } : {}),
        hops,
        ...(lastSelection ? { lastId: lastSelection } : {}),
        ...(input.isBugFix != null ? { isBugFix: input.isBugFix } : {}),
        preferInspect: input.verifyEnabled !== false,
        llm: input.llm,
        model: input.routerModel,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      totalUsage = addUsage(totalUsage, routed.usage);
      lastSelection = routed.selection;

      if (routed.selection === "summarise") {
        if (hops.length === 0) {
          // Nothing ran yet and the router says done: answer conversationally.
          choices = input.setup.categories.filter((c) => c.id === "conversation");
          if (choices.length) continue;
        }
        break;
      }
      // Loop guard: never run the same categorizer twice in a row.
      if (hops.length > 0 && hops[hops.length - 1].id === routed.selection) {
        input.logStore.append({
          tags: ["categorizer", "categorizer:loop-guard"],
          level: "warn",
          message: `router repeated "${routed.selection}" — forcing summarise`,
        });
        break;
      }

      const def = getCategory(input.setup, routed.selection);
      const { hop, loop } = await runCategorizerHop(input, def, hops, shared);
      hops.push(hop);
      totalUsage = addUsage(totalUsage, loop.usage);
      refs.push(...loop.refs);
      for (const p of loop.writtenPaths) if (!writtenPaths.includes(p)) writtenPaths.push(p);
      for (const p of loop.readPaths) if (!readPaths.includes(p)) readPaths.push(p);
      for (const p of loop.discoveredPaths) if (!discoveredPaths.includes(p)) discoveredPaths.push(p);
      for (const p of loop.instrumentedPaths) instrumented.add(p);

      if (loop.pendingUserQuestion) {
        pendingUserQuestion = loop.pendingUserQuestion;
        break;
      }
      if (loop.error) {
        error = loop.error;
        break;
      }

      choices = def.children
        .map((id) => input.setup.categories.find((c) => c.id === id))
        .filter((c): c is CategorizerDefinition => Boolean(c));
      if (choices.length === 0) break; // leaf categorizer → summarise
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // --- probe strip ---
  try {
      for (const p of writtenPaths) instrumented.add(p);
      const remaining = await scanForProbeMarkers(input.cwd, [...instrumented]);
    if (remaining.length) {
      const stripUsage = await stripRemainingProbes(input, remaining, input.modelFor(getCategory(input.setup, "activity_inspect")));
      if (stripUsage) totalUsage = addUsage(totalUsage, stripUsage);
    }
  } catch {
    // cleanup is best-effort; never fails the run
  }

  // --- summary ---
  const onlyConversation = hops.length === 1 && hops[0].id === "conversation";
  let summary: string | undefined;
  if (onlyConversation) {
    summary = String(
      (hops[0].deliverable as { summary?: string })?.summary ?? hops[0].summary ?? "",
    ).trim() || undefined;
  }
  if (!summary && hops.length) {
    const s = await summarizeChain(input, hops, writtenPaths, readPaths, refs);
    if (s?.usage) totalUsage = addUsage(totalUsage, s.usage);
    summary = s?.text ?? undefined;
  }

  // --- run steps (write_edit plan tasks) ---
  const steps: RunStep[] = [];
  let planSet: PlanSet | undefined;
  for (const hop of hops) {
    if (!hop.planSet) continue;
    planSet = hop.planSet;
    for (const plan of hop.planSet.plans) {
      for (const t of plan.tasks) {
        const isCompleted =
          t.files.length > 0 && t.files.every((f) => writtenPaths.some((w) => w.endsWith(f) || f.endsWith(w)));
        // Flip the task in place (the harness owns isCompleted; the model never
        // authors it) so hosts reading the planSet see the same truth as steps.
        t.isCompleted = isCompleted;
        steps.push({
          planId: plan.id,
          taskId: t.id,
          title: t.title,
          summary: t.summary,
          complexity: t.complexity,
          isCompleted,
          files: t.files,
        });
      }
    }
  }

  // --- verified (last inspect verdict) ---
  let verified: boolean | undefined;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (hops[i].id !== "activity_inspect") continue;
    const verdict = (hops[i].deliverable as { verdict?: string } | undefined)?.verdict;
    if (verdict === "pass") verified = true;
    else if (verdict === "fail") verified = false;
    break;
  }

  const route: "conversational" | "task" = onlyConversation && writtenPaths.length === 0 ? "conversational" : "task";
  const success = !error && Boolean(summary);

  return {
    route,
    success,
    ...(summary ? { summary } : {}),
    steps,
    ...(planSet ? { planSet } : {}),
    refs,
    usage: totalUsage,
    ...(pendingUserQuestion ? { pendingUserQuestion } : {}),
    ...(error ? { error } : {}),
    hops,
    writtenPaths,
    readPaths,
    discoveredPaths,
    ...(verified != null ? { verified } : {}),
  };
}

// ---------------------------------------------------------------------------
// Summary turn
// ---------------------------------------------------------------------------

async function summarizeChain(
  input: CategorizerChainInput,
  hops: CategorizerHop[],
  writtenPaths: string[],
  readPaths: string[],
  refs: MediaRef[],
): Promise<{ text?: string; usage?: Usage } | undefined> {
  try {
    const lines: string[] = [];
    lines.push(`Summarize the work just done for this task, in 2-6 sentences.`);
    lines.push(`TASK: ${input.task}`);
    lines.push(
      `WHAT EACH STEP DELIVERED (structured deliverables — your evidence):\n` +
        hops.map((h) => `--- ${h.id} ---\n${renderDeliverable(h.deliverable ?? {})}`).join("\n"),
    );
    if (writtenPaths.length) lines.push(`FILES CHANGED: ${writtenPaths.join(", ")}`);
    if (readPaths.length) lines.push(`FILES READ: ${readPaths.join(", ")}`);
    const assetRefs = refs.filter((r) => !/^(https?|data|blob):/i.test(r.uri));
    if (assetRefs.length) {
      lines.push(
        `ASSETS GENERATED (produced by tools, not hand-edited):\n` +
          assetRefs.map((r) => `- ${r.uri} (${r.mimeType})${r.summary ? ` — ${r.summary}` : ""}`).join("\n"),
      );
    }
    lines.push(
      `Reply with ONLY the summary prose. Ground every claim in the record above — never add detail it` +
        ` does not contain, and never imply a check ran that the record does not show. If a step was` +
        ` cut short or left work undone, say so and what remains.`,
    );
    const msg = await input.llm.complete(
      input.summaryModel,
      {
        systemPrompt: [
          "You write the closing summary of a coding run, for the user who asked for it.",
          "You did NOT do this work: everything you know is in the record below. Write from it, and never",
          "add detail it does not contain — no invented file contents, no reasoning you did not see, and",
          "above all no test, build, or visual check that the record does not say was actually run.",
          "Lead with what the user got. Name the files that changed by path, say plainly what is still",
          "incomplete or unverified, and stop. Plain prose, 2-6 sentences, no headings, no bullets.",
        ].join(" "),
        messages: [{ role: "user", content: lines.join("\n\n"), timestamp: Date.now() }],
      },
      { reasoning: "off", ...(input.signal ? { signal: input.signal } : {}) },
    );
    const text = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return { ...(text ? { text } : {}), ...(msg.usage ? { usage: msg.usage } : {}) };
  } catch {
    return undefined;
  }
}
