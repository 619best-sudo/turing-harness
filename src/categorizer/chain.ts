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
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentEvent,
  AgentTool,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  LiveImage,
  ResolvedClarification,
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
import { ClarifyGate, normalizeQuestion, shellAuthoringTarget } from "../orchestrator/clarify-gate.js";
import { runToolLoop, type ToolLoopResult } from "../orchestrator/loop.js";
import { stripProbeLines } from "../probe-marker.js";
import { triageImageAttachment, triageDocumentAttachment, isDocumentRef } from "../orchestrator/attachment-triage.js";
import type { ModelRouter } from "../types.js";
import type { ProjectCategory } from "../presets/project-presets.js";
import {
  type CategorizerDefinition,
  type CategorizerDeliverable,
  type CategorizerHop,
  type CategorizerId,
  type CategorizerSetup,
  type CategorizerToolRecord,
} from "./types.js";
import { getCategory, entryCategories } from "./setup.js";
import { buildCategorizerSystemPrompt } from "./prompts.js";
import {
  createDeliverTool,
  deriveFallbackDeliverable,
  takeHandoff,
  DELIVER_TOOL_NAME,
  type DeliverBox,
} from "./deliver.js";
import { createClearingDoubtTool, CLEARING_DOUBT_TOOL_NAME } from "./clearing-doubt.js";
import { extractMentionTokens, resolveMentions, renderMentionNote } from "./mentions.js";
import { routeCategorizer, type RouterChoice } from "./router.js";
import { applyPolicyToRouted, decideFromDriver } from "./route-policy.js";
import { isNonFatalLoopError } from "../orchestrator/stall-guard.js";
import { ComprehensionStore } from "../tools/builtin/comprehension.js";

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
/**
 * The QA-hop automation surface: which kind of software this run drives.
 *
 * An explicit URL in the task wins over the project's category — verifying a
 * web dashboard from a mobile repo is still web work. Unknown category → no
 * gating (a host that detects nothing keeps today's behavior).
 */
function qaSurfaceFor(input: CategorizerChainInput): "web" | "mobile" | "none" | undefined {
  if (/https?:\/\//i.test(input.task)) return "web";
  switch (input.projectCategory) {
    case "mobile":
    case "games":
      return "mobile";
    case "frontend":
      return "web";
    case "backend":
      return "none";
    default:
      return undefined;
  }
}

const isQaHop = (def: CategorizerDefinition): boolean =>
  def.id === "activity_inspect" || def.id === "activity_reproduce" || def.toolScope === "activity_inspect";

const BROWSER_TOOL_RE = /^(browser_|chrome_|devtools_|playwright_|puppeteer_)/i;
const BROWSER_PROVIDER_RE = /playwright|chrome[-_]?devtools|puppeteer|selenium/i;
const DEVICE_TOOL_RE = /^(mobile_|device_|simulator_|android_|ios_|adb_)/i;
const DEVICE_PROVIDER_RE = /mobile|device|simulator|android|adb|appium/i;

function isBrowserAutomation(tool: AgentTool): boolean {
  return (
    tool.name === "drive" ||
    BROWSER_TOOL_RE.test(tool.name) ||
    (tool.providerId != null && BROWSER_PROVIDER_RE.test(tool.providerId))
  );
}

function isDeviceAutomation(tool: AgentTool): boolean {
  return (
    tool.name === "mobile" ||
    DEVICE_TOOL_RE.test(tool.name) ||
    (tool.providerId != null && DEVICE_PROVIDER_RE.test(tool.providerId))
  );
}

/**
 * Drop the QA hop's off-surface tools: mobile project → no browser automation,
 * web project → no device automation, backend → neither. Identifies tools by
 * the registry-stamped `providerId` first (an MCP server is the better signal
 * than any one tool's name) and name prefixes second.
 */
function gateQaSurface(
  tools: AgentTool[],
  def: CategorizerDefinition,
  input: CategorizerChainInput,
): { tools: AgentTool[]; surface: "web" | "mobile" | "none" | undefined; dropped: Array<{ tool: string; reason: string }> } {
  const surface = qaSurfaceFor(input);
  if (!isQaHop(def) || surface == null) return { tools, surface: undefined, dropped: [] };
  const dropped: Array<{ tool: string; reason: string }> = [];
  const kept = tools.filter((t) => {
    const browser = isBrowserAutomation(t);
    const device = isDeviceAutomation(t);
    if (surface === "mobile" && browser) {
      dropped.push({ tool: t.name, reason: "browser tool in a device-surface hop" });
      return false;
    }
    if (surface === "web" && device) {
      dropped.push({ tool: t.name, reason: "device tool in a browser-surface hop" });
      return false;
    }
    if (surface === "none" && (browser || device)) {
      dropped.push({ tool: t.name, reason: "UI automation in a no-UI (backend) hop" });
      return false;
    }
    return true;
  });
  return { tools: kept, surface, dropped };
}

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
    for (const t of input.registry?.getToolsForCategorizer(def.toolScope ?? def.id) ?? []) {
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

  // QA hops carry ONE automation surface, by project: a mobile project drives
  // the device toolkit, a web project the browser, a backend neither. Field
  // run that produced this: a Flutter/iOS inspect hop opened with ~62 tools,
  // two-thirds of them browser-MCP tools that could not touch the simulator —
  // and the model reasoned "my connected automation is browser-based" and
  // nearly declined to verify at all. See `gateQaSurface`.
  const gated = gateQaSurface([...byName.values()], def, input);
  if (gated.dropped.length) {
    input.logStore.append({
      tags: ["categorizer", "categorizer:tools", "categorizer:surface"],
      level: "info",
      message:
        `categorizer "${def.id}" surface=${gated.surface}: dropped ${gated.dropped.length} tool(s) ` +
        "of the other surface",
      data: { categorizer: def.id, surface: gated.surface, dropped: gated.dropped },
    });
  }

  const tools = gated.tools;
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
 * Enforce "create_plan always" in write_edit: every write/edit is refused until
 * a create_plan call has succeeded in this loop. STRICT — there is no
 * with-nudges bypass: every file change matches a plan step, and a model that
 * cannot call create_plan is stopped honestly by the stall guard rather than
 * editing outside the plan.
 *
 * The rule is taught at the DESCRIPTION layer too, not only enforced at the
 * gate: a small model chooses its next call from the tool schemas, and the
 * stock `create_plan` description ("for any task that spans more than one
 * file or more than one step") actively licenses skipping the plan for a
 * one-line change — the exact run that made this necessary. In this
 * categorizer the descriptions state the flow instead: create_plan is FIRST
 * always, and write/edit is refused before it. Wrapping happens here so the
 * flat loop (where plan-first is optional) keeps the stock descriptions.
 */
function enforcePlanFirst(tools: AgentTool[]): AgentTool[] {
  let planSeen = false;
  return tools.map((t) => {
    if (t.name === "create_plan") {
      return {
        ...t,
        description:
          t.description.replace(
            "Call this ONCE, before doing any implementation work, for any task that spans more than one file or more than one step.",
            "Call this ONCE, FIRST — before any implementation work.",
          ) +
          " In this categorizer it comes FIRST, ALWAYS — even for a single-file, one-line change " +
          "(the plan may be a single step): every write/edit is refused until this has succeeded.",
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
        description:
          t.description +
          " Plan-first: REFUSED until create_plan has succeeded in this categorizer — call create_plan first, then re-issue.",
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          // STRICT: there is no bypass. Every write/edit runs only after a
          // successful create_plan in this categorizer — the reward for the
          // model that calls create_plan is that its edits stop being refused.
          // The refusal names the single escape (create one step); a model that
          // cannot do that is stopped honestly by the stall guard rather than
          // editing outside the plan.
          if (!planSeen) {
            return {
              output:
                "create_plan comes FIRST in this categorizer — even a one-line change gets a plan " +
                "(it may be a single step). Call create_plan now, then re-issue this exact call; " +
                "nothing is lost.",
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

/**
 * Shell commands that UNDO work rather than observe it.
 *
 * Not authoring, so `detectShellAuthoring` does not see them, and worse than
 * authoring: `git checkout -- <file>` throws away changes with no record of what
 * they were. A QA hop ran exactly this on two source files mid-pass.
 */
const DESTRUCTIVE_GIT = /\bgit\s+(checkout\s+(--\s+)?\S+\.\w|restore\b|reset\s+--hard\b|clean\s+-[a-z]*f|stash\b(?!\s+list))/;

/**
 * `open`/`xdg-open` at the start of a bash command (optionally after a
 * `cd … &&`), which is the shape "pop this in the user's desktop browser"
 * takes. Narrow on purpose: a false positive costs one turn (one-shot refusal,
 * re-issue passes); a false negative costs a stray browser window.
 */
const DESKTOP_OPEN_RE = /^\s*(?:cd\s+[^&]+&&\s*)?(?:open|xdg-open)\s+\S/i;

/**
 * Refuse (once) opening the target in the user's DESKTOP browser, in any
 * categorizer hop. Nobody's job looks like that: it captures nothing, so it
 * cannot verify; it mutates the USER's desktop, not the run's; and the verify
 * pass opens the page in the harness's own browser anyway — which is the only
 * opener whose capture can reach `media_analysis`.
 *
 * From the field: the write pass ran `bash open index.html` "to verify", and
 * the inspect pass then opened the same page again through `drive`. One page,
 * two opens, one of them uninvited on the user's desktop. The refusal states
 * the distribution instead: finish this pass (`deliver`); the verify pass
 * owns opening, driving and capturing.
 */
export function enforceNoDesktopOpen(tools: AgentTool[], categorizerId: string): AgentTool[] {
  let refused = 0;
  return tools.map((t) => {
    if (bareName(t.name) !== "bash") return t;
    return {
      ...t,
      execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
        const command = typeof args?.command === "string" ? args.command : "";
        if (refused < 1 && DESKTOP_OPEN_RE.test(command)) {
          refused += 1;
          const qa = categorizerId === "activity_inspect" || categorizerId === "activity_reproduce";
          return {
            output:
              "bash refused ONCE — this command opens the page in the user's DESKTOP browser. That is not " +
              "verification: nothing is captured, nothing reaches `media_analysis`, and the user gets a " +
              "browser window they did not ask for.\n\n" +
              (qa
                ? "This pass verifies with its OWN browser: `drive { action: \"open\", url }` opens the page " +
                  "where `look`/`shot` can capture it (a device/simulator: the `mobile` tool). If you truly " +
                  "need the desktop `open` for something else, re-issue this exact call and it goes through."
                : "Opening, driving and capturing the result is the VERIFY pass's job, after you finish: make " +
                  "the change, confirm it in the source if you must (`grep`/`read`), and `deliver`. The chain " +
                  "routes verification with the right tools. If you truly need the desktop `open`, re-issue " +
                  "this exact call and it goes through."),
            isError: true,
          };
        }
        return t.execute(id, args, ctx);
      },
    };
  });
}

/**
 * Keep a QA hop out of the source tree.
 *
 * Both QA categorizers are told, at length, that they do not author product
 * code, and neither holds `write` or `edit`. Neither fact stops `bash`, which is
 * a global tool and can do anything — and on the run this exists for, the
 * reproduce hop never instrumented, never launched the app, and instead:
 *
 *     git checkout lib/providers/leads_provider.dart lib/services/…      (reverted work)
 *     cat /tmp/fix.patch                                                 (built a patch)
 *     python3 << 'PYTHON' … open('lib/providers/leads_provider.dart','w') (authored the fix)
 *
 * That is the fix hop's job, done blind, in the pass whose entire purpose is to
 * SEE the defect first — and it is why the run was stopped by hand.
 *
 * A hard refusal, not the one-shot kind used elsewhere: there is no situation in
 * which this hop should be rewriting project source, and refusing costs it
 * nothing — the evidence it owes can always still be gathered and delivered.
 * Scratch paths are exempt, so writing a throwaway script or a temp file to
 * exercise the code is still available; `detectShellAuthoring` only reports
 * source-shaped targets, and anything under a temp dir or outside the project is
 * not the source tree.
 */
export function enforceNoShellAuthoring(
  tools: AgentTool[],
  cwd: string,
  opts: {
    /**
     * What this categorizer should do INSTEAD of authoring. "observe" is the QA
     * hops (run it and look); "handoff" is a categorizer that has no business
     * touching files at all and must pass the change to `write_edit`.
     */
    instead?: "observe" | "handoff";
  } = {},
): AgentTool[] {
  const instead = opts.instead ?? "observe";
  return tools.map((t) => {
    // `bash_readonly` too. It carries its own block list, but that list is
    // shell-shaped (redirection, tee, rm/mv/cp) and an interpreter is not — a
    // `python3 -c` that opened a source file with mode 'w' went straight through
    // it in the read hop. Two independent layers now say no, because this one is
    // the layer that knows WHICH categorizer is asking.
    if (bareName(t.name) !== "bash" && bareName(t.name) !== "bash_readonly") return t;
    return {
      ...t,
      description:
        t.description +
        (instead === "handoff"
          ? " In this categorizer the shell only INSPECTS — it may not write project files by any means " +
            "(no heredoc, sed -i, redirect, or python/node one-liner). A change belongs in the deliver " +
            "report for `write_edit`, which is the only pass whose file changes the run records."
          : " In this categorizer the shell RUNS things — it may not write or revert project files " +
            "(no heredoc/sed/redirect into source, no `git checkout`/`restore`/`reset --hard`)."),
      execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
        const command = typeof args?.command === "string" ? args.command : "";
        if (command) {
          if (DESTRUCTIVE_GIT.test(command)) {
            return {
              output:
                "bash refused — this categorizer does not undo work. `git checkout`/`restore`/" +
                "`reset --hard`/`stash` discard changes that another pass made deliberately, and " +
                "nothing here needs a clean tree: you are establishing what the software DOES, not " +
                "changing what it is. Run it and observe instead.",
              isError: true,
            };
          }
          const authoring = shellAuthoringTarget(t.name, args);
          if (authoring && isProjectPath(cwd, authoring.path)) {
            return {
              output:
                `${t.name} refused — that command writes ${authoring.path} (${authoring.form}), and this ` +
                "categorizer does not author product code.\n\n" +
                (instead === "handoff"
                  ? "And a file changed this way is a file the run cannot see: changes are recorded " +
                    "through `write`/`edit`, so a shell-written file appears nowhere — nothing builds it, " +
                    "nothing runs it, nothing verifies it, and the run reports having changed nothing. " +
                    "That is how a task ends 'done' in this hop with the user's code quietly edited and " +
                    "never checked.\n\nSay what the change IS instead — file, line, exact old text, exact " +
                    "new text — and `deliver` it, nominating `write_edit`. That pass makes the edit with " +
                    "`edit` (which the run records), and the verify pass then proves it on the running app."
                  : "Two tools own the two legitimate reasons to touch a file here:\n" +
                    "  - a trace probe → `add_log` (log-only, and `activity_cleanup` takes it back out);\n" +
                    "  - the fix itself → not you. `write_edit` runs after you and works from your report; " +
                    "a fix written here is written blind, before anyone has seen the defect.\n\n" +
                    "What is missing from this pass is one observation. Launch it (`drive`/`mobile`), or " +
                    "run the project's own run/test command, and look at what it does.") +
                "\n\nA scratch file outside the project (a temp script, a throwaway harness) is still fine.",
              isError: true,
            };
          }
        }
        return t.execute(id, args, ctx);
      },
    };
  });
}

/** Is this path inside the project tree (as opposed to a temp/scratch location)? */
function isProjectPath(cwd: string, target: string): boolean {
  const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
  const tmp = os.tmpdir();
  if (resolved.startsWith(tmp) || resolved.startsWith("/tmp/") || resolved.startsWith("/var/tmp/")) return false;
  const relative = path.relative(cwd, resolved);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Tools that OBSERVE the software while it runs, as opposed to reading its source.
 *
 * Name-prefix matched so an MCP server's spelling (`chrome__browser_navigate`,
 * `mobilecli_tap`) counts too — the question is only "did this hop look at the
 * thing running", and a namespace prefix does not change the answer.
 *
 * `bash` is NOT here. It is the one tool that can be either, and the difference
 * decided a real run: see `isRuntimeCommand`.
 */
const OBSERVATION_TOOL_PREFIXES = [
  "drive",
  "mobile",
  "browser_",
  "activity_inspect",
  "activity_collect",
  "activity_study",
  "activity_search",
  "activity_tail_file",
  "take_screenshot",
  "take_snapshot",
  "media_analysis",
  "lighthouse_audit",
  "performance_",
];

/** Tools that place or remove instrumentation, rather than observe with it. */
const INSTRUMENTATION_TOOLS = ["activity_trace_start", "add_log", "remove_log", "activity_cleanup"];

const bareName = (name: string): string =>
  name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;

const isNamed = (name: string, names: readonly string[]): boolean => {
  const bare = bareName(name);
  return names.some((n) => bare === n || bare.startsWith(n));
};

/**
 * Shell commands that RUN the software, as opposed to asking questions about the
 * checkout.
 *
 * This distinction is the whole point and it cost a run to learn. `bash` used to
 * count as an observation unconditionally, so the QA hop's very first shell call
 * — `find … -name "*test*"` — marked the hop as having "observed the software
 * running". It then found a booted iPhone simulator with `flutter devices`,
 * decided it needed to work out how to launch the app, stripped its own probes
 * instead, and delivered a code analysis as a reproduced symptom. The guard
 * meant to stop exactly that had already been satisfied by a `find`.
 *
 * Builds are deliberately absent: `flutter build`, `tsc`, `cargo check` prove the
 * code COMPILES, which is the false confidence this guard exists to reject. Test
 * runners are deliberately present — a logic fix verified by its own suite is
 * genuinely verified. `flutter devices` / `adb devices` list hardware and run
 * nothing, so they are absent too.
 */
export function isRuntimeCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const text = command.toLowerCase();
  const RUNS = [
    // Test runners — running the code is the point of them.
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|dev|start|serve|e2e)\b/,
    /\b(vitest|jest|mocha|ava|playwright\s+test|cypress|nightwatch)\b/,
    /\bflutter\s+(run|test|drive|attach)\b/,
    /\b(pytest|python\s+-m\s+pytest|unittest|tox|nox)\b/,
    /\bgo\s+(test|run)\b/,
    /\bcargo\s+(test|run)\b/,
    /\b(dotnet|mvn|gradle|gradlew|sbt)\s+(test|run|bootrun)\b/,
    /\brspec\b|\brails\s+(server|s|test)\b|\bbundle\s+exec\s+(rspec|rails)\b/,
    /\bphpunit\b|\bartisan\s+(serve|test)\b/,
    /\bmake\s+(test|run|dev|start|e2e)\b/,
    // Mobile run commands beyond Flutter — React Native and Expo launch the
    // app the same way `flutter run` does.
    /\b(?:npx\s+)?react-native\s+run-/,
    /\b(?:npx\s+)?expo\s+(?:start|run)\b/,
    // Exercising a running service.
    /\bcurl\b|\bhttpie\b|\bwget\b|\bgrpcurl\b/,
    // Driving a device or emulator for real.
    /\b(xcrun\s+simctl\s+launch|adb\s+shell|idb\s+launch)\b/,
    // Reading what a run produced, live.
    /\b(tail|log(cat)?)\s+.*-f\b|\badb\s+logcat\b|\bxcrun\s+simctl\s+spawn\b/,
  ];
  return RUNS.some((re) => re.test(text));
}

/** Did this tool call observe the software actually running? */
export function isObservationCall(name: string, args?: Record<string, unknown>): boolean {
  if (isNamed(name, OBSERVATION_TOOL_PREFIXES)) return true;
  if (bareName(name) === "bash") return isRuntimeCommand(args?.command);
  return false;
}

/** Kept for callers that only have a tool NAME — a bash call needs its args. */
export function isObservationTool(name: string): boolean {
  return isNamed(name, OBSERVATION_TOOL_PREFIXES) || bareName(name) === "bash";
}

/**
 * Commands that produce an artifact and run nothing — the shapes the reproduce
 * hop reached for when it could not find a way to RUN the app (`flutter build
 * web`, three times, in one field run). Building is not reproducing: the
 * artifact sits on disk while the defect stays unobserved.
 */
const BUILD_ONLY_RE =
  /\bflutter\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bcargo\s+build\b|\bmake\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b(?![^\n]*\btest\b)|\bgradlew?\s+(?:build|assemble\w*)\b|\b(?:mvn|mvnw|maven)\s+(?:package|compile)\b|\bdotnet\s+build\b|\b(?:ng|vite|next)\s+build\b/;

/**
 * Whether a shell command is build-only: it matches {@link BUILD_ONLY_RE} and
 * nothing in it actually runs the software (`isRuntimeCommand`), so `flutter
 * build && flutter run` does not count — its second half runs.
 */
export function isBuildOnlyCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  return BUILD_ONLY_RE.test(command.toLowerCase()) && !isRuntimeCommand(command);
}

/**
 * Make a QA hop observe the software before it reports on it.
 *
 * Two failures, from two consecutive runs, produced the three rules here.
 *
 * The first: the QA hop spent eight and a half minutes on 25 `read`s, 6 `grep`s
 * and 6 `bash`es without one driving or capture call, then ended without
 * delivering. A hop that reads source and reasons is a read hop; the prompts say
 * so at length, and prose did not bind.
 *
 * The second, with the guard in place: it instrumented (one `add_log` landed,
 * four were refused for not being log-only), asked `flutter devices`, found a
 * booted simulator — and then called `activity_cleanup`, deleting the probes it
 * had just placed, read two more files, and delivered `reproduced: true` for a
 * defect it had never seen. Its own reasoning said it should use the simulator
 * "however I need to check if there's a way to run the app". Cleanup was the exit.
 *
 * So: an observation must be a RUN (not a `find`), instrumentation may not be
 * torn down before it has run, and a claim of reproduction that the harness can
 * positively disprove is corrected rather than passed on.
 *
 * Graceful throughout, because a hop that genuinely CANNOT observe must not
 * deadlock: the guard arms only when the hop holds an observation tool, and every
 * refusal is one-shot — re-issue the call and it goes through, so the worst case
 * costs a turn and the honest report still lands.
 */
export function enforceObserveFirst(
  tools: AgentTool[],
  opts: {
    probesBeforeLaunch?: boolean;
    /**
     * The QA handshake's answer, read lazily (it arrives mid-hop). When the USER
     * verifies or QA is SKIPPED, "you have not observed anything" is no longer a
     * finding about this hop — it is the user's instruction being followed, so
     * the deliver refusals stand down. See `enforceQaHandshake`.
     */
    qaMode?: () => QaMode | undefined;
  } = {},
): AgentTool[] {
  const canObserve = tools.some((t) => t.name !== DELIVER_TOOL_NAME && isObservationTool(t.name));
  if (!canObserve) return tools;
  // Only worth asking about probes when the hop can actually place them.
  const canInstrument =
    opts.probesBeforeLaunch === true &&
    tools.some((t) => isNamed(t.name, ["activity_trace_start", "add_log"]));
  let observed = false;
  let instrumented = false;
  // Evidence beyond "a process ran": a driving/capture call (screenshot, UI
  // walk) or probe lines actually collected. `observed` alone let a field run
  // launch the app, never walk it to the symptom, glimpse log lines in a bash
  // tail, and deliver `reproduced: true` from analysis.
  let droveOrCaptured = false;
  let collectedLines = 0;
  const refused = { deliver: 0, cleanup: 0, launch: 0, buildOnly: 0, undriven: 0 };
  return tools.map((t) => {
    if (t.name !== DELIVER_TOOL_NAME && isObservationTool(t.name)) {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          // A build is not a run. The reproduce hop that cannot find how to RUN
          // the app reaches for `flutter build web` et al — an artifact on disk,
          // the defect still unobserved, and the turn spent. One-shot, and only
          // in the reproduce hop: the verify hop's sequence has an explicit
          // BUILD step before its run.
          //
          // Deliberately does NOT arm once anything has been observed: a build
          // after the run (rebuilding with probes, say) is preparation this
          // pass has already earned.
          if (
            opts.probesBeforeLaunch === true &&
            bareName(t.name) === "bash" &&
            !observed &&
            refused.buildOnly < 1 &&
            isBuildOnlyCommand(args?.command)
          ) {
            refused.buildOnly += 1;
            return {
              output:
                "bash refused ONCE — this command BUILDS but runs nothing, and an artifact on disk is not a " +
                "reproduction.\n\n" +
                "If it was preparation to launch: the run command — whatever starts THIS app (the device " +
                "run, the dev server, the service entrypoint) — belongs in " +
                "`activity_trace_start { startCommand }` — that launches it AND pipes its stdout into the trace " +
                "file, where your probes' output is collected.\n\n" +
                "If you genuinely need the artifact (an install step, a bundle the device expects), re-issue this " +
                "exact call and it goes through.",
              isError: true,
            };
          }
          // Interrupt the FIRST launch of an uninstrumented build, once.
          //
          // The moment this exists for, from a run that otherwise went well: the
          // hop found a simulator, launched the app — and then reasoned "I'm
          // realizing that reproducing this bug visually is quite complex: it
          // requires having leads in enriching status, seeing that the status
          // doesn't update…". That is the exact problem probes solve, arrived at
          // one step too late, and it went back to reading source instead.
          //
          // Interrupting HERE and not at deliver is the whole point: a probe has
          // to be in the source before the build, so once this command runs the
          // choice is made for the next several minutes. So make it a choice. A
          // visible defect needs no probes and the model says so by re-issuing;
          // an invisible one — a value that never arrives, a status that does not
          // repaint — leaves nothing on a screenshot, and this is the only moment
          // it is cheap to say so.
          if (canInstrument && !instrumented && !observed && refused.launch < 1 && isObservationCall(t.name, args)) {
            refused.launch += 1;
            // Name WHAT was interrupted. The field run this wording grew from
            // interrupted `flutter test` on an empty suite and said "you are
            // about to run the app" — the model then spent a turn parsing the
            // mismatch instead of acting on the advice.
            const commandText = typeof args?.command === "string" ? args.command : "";
            const isTestRun =
              /\b(?:pytest|vitest|jest|mocha|rspec|unittest|flutter\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|(?:gradlew?|mvn|dotnet|go|cargo|make)\s+test)\b/i.test(
                commandText,
              );
            const opener = isTestRun
              ? `${t.name} refused ONCE — you are about to run the TEST suite with no probes in it. A test that ` +
                "exercises the reported path IS a legitimate way to run it — but for a defect that is a VALUE " +
                "THAT NEVER ARRIVES, the evidence is the probes, and they have to be compiled in before the run.\n\n"
              : `${t.name} refused ONCE — you are about to run the app with no probes in it.\n\n`;
            return {
              output:
                opener +
                "Decide which kind of defect this is, because after this command the answer is baked " +
                "into a build:\n" +
                "  - VISIBLE on screen (wrong text, wrong colour, a broken layout, a crash)? Then a " +
                "capture is the evidence. Re-issue this exact call and grab the screen.\n" +
                "  - A VALUE THAT NEVER ARRIVES (a status that does not repaint, a list that does not " +
                "refresh, a callback that does not fire)? A screenshot of a screen that looks normal " +
                "proves nothing. `activity_trace_start { startCommand }` — the run command as its " +
                "`startCommand`, so the app launches THROUGH the trace and its stdout is piped where " +
                "`activity_collect` reads — then `add_log` at the sites the code summary " +
                "named (the branch that returns early, the notify that is not called), THEN drive the " +
                "flow and `activity_collect`. Probes must be compiled in, which is why this is the last " +
                "moment they are cheap.",
              isError: true,
            };
          }
          const res = await t.execute(id, args, ctx);
          // The ARGS decide for bash, so this is checked per call, not per tool.
          if (!res.isError && isObservationCall(t.name, args)) observed = true;
          // A drive or a capture is evidence a UI was actually walked — a
          // screenshot, a look, a tap. The distinction from `observed`: a bare
          // run command proves a PROCESS ran, not that anyone reached the
          // screen the defect lives on.
          if (
            !res.isError &&
            (isNamed(t.name, ["mobile", "drive", "activity_inspect", "media_analysis"]) ||
              bareName(t.name).startsWith("browser_"))
          ) {
            droveOrCaptured = true;
          }
          // Collected probe lines are the evidence an INVISIBLE defect was
          // reached — `activity_collect` is itself an observation tool, so its
          // count is read here rather than in a wrapper the observation branch
          // would shadow. A collect that returns nothing after a launch means
          // the flow was never walked to the instrumented path.
          if (!res.isError && isNamed(t.name, ["activity_collect"])) {
            const captured = Number((res.details as { captured?: unknown } | undefined)?.captured ?? 0);
            if (captured > 0) collectedLines += captured;
          }
          return res;
        },
      };
    }
    // Placing a probe is a promise to run the flow it reports on.
    if (isNamed(t.name, ["activity_trace_start", "add_log"])) {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          const res = await t.execute(id, args, ctx);
          if (!res.isError) instrumented = true;
          return res;
        },
      };
    }
    // Tearing instrumentation down before it has run is giving up, not tidying.
    if (isNamed(t.name, ["remove_log", "activity_cleanup"])) {
      return {
        ...t,
        description:
          t.description +
          " Refused once if you instrumented and have NOT yet run the flow — probes record nothing " +
          "until the code executes.",
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          if (instrumented && !observed && refused.cleanup < 1) {
            refused.cleanup += 1;
            return {
              output:
                `${t.name} refused — you placed probes and have not run the flow yet, so they have ` +
                "recorded nothing. Taking them out now throws away the only evidence this pass was " +
                "going to produce.\n\nRun it — through the trace, so the probes' output lands where " +
                "`activity_collect` reads: `activity_trace_start { startCommand }` launches the app " +
                "with its stdout piped into the trace file (for a UI, `drive`/`mobile` then walk it " +
                "to the symptom); with no UI, the project's own run/test command through `bash`. " +
                "Then `activity_collect` to read what the probes saw. Strip them AFTER that.\n\nIf you " +
                "genuinely cannot run it — nothing to launch on, credentials you do not have — " +
                "re-issue this exact call and report `reproduced: false` with what you tried; the " +
                "cleanup will go through and the honest answer is worth more than a guess.",
              isError: true,
            };
          }
          return t.execute(id, args, ctx);
        },
      };
    }
    if (t.name === DELIVER_TOOL_NAME) {
      return {
        ...t,
        description:
          t.description +
          " Refused once if you have not yet RUN or CAPTURED anything in this categorizer — reading " +
          "source is not observing behaviour.",
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          // The user took the surface, or waved this pass off entirely: an
          // unobserved deliver is then the correct outcome, not a hop that gave
          // up, so the "go and run it" refusals stand down.
          //
          // The two modes part company on `reproduced: true`. When the USER
          // drove, they are the witness and the claim is theirs to make. When
          // the pass was SKIPPED, nobody witnessed anything — so that correction
          // below still applies, and the fixer is told it is holding a
          // hypothesis.
          const mode = opts.qaMode?.();
          if (mode === "user") return t.execute(id, args, ctx);
          if (mode === "skip" && args?.reproduced !== true) return t.execute(id, args, ctx);
          if (mode !== "skip" && !observed && refused.deliver < 1) {
            refused.deliver += 1;
            return {
              output:
                "deliver refused — this categorizer has not observed the software running. Reading " +
                "source and reasoning about it produces a hypothesis, and a hypothesis is what the " +
                "READ pass already delivered; what is missing is one observation. Run it and look: " +
                "`drive`/`mobile` for a UI, `activity_inspect` for a single screen, the project's own " +
                "run or test command through `bash` for an endpoint or a code path, then " +
                "`activity_collect` if you placed probes. Listing devices or searching for test files " +
                "is not running it. If you genuinely cannot reach it — no device, no credentials, no " +
                "way in — re-issue this exact call with `reproduced: false` and say what you tried; " +
                "it will go through.",
              isError: true,
            };
          }
          // The run launched something but nobody drove it. From the field: the
          // app was launched through the trace, the agent REASONED about
          // navigating to the reported screen ("let me look at what the app
          // looks like and navigate to the contacts page"), never made one
          // mobile/drive call, glimpsed log lines in a bash tail, and
          // delivered `reproduced: true` from analysis. One-shot, then the
          // correction below catches the re-issue.
          if (
            mode !== "skip" &&
            observed &&
            args?.reproduced === true &&
            !collectedLines &&
            !droveOrCaptured &&
            refused.undriven < 1
          ) {
            refused.undriven += 1;
            return {
              output:
                "deliver refused — the app RAN, but nobody drove it, and no probe line was ever collected. " +
                "An app idling on its first screen has exercised none of the reported flow; `reproduced: true` " +
                "from reading plus a launched process is the READ pass's hypothesis wearing a witness's " +
                "cloak.\n\n" +
                "Walk to the symptom: `mobile { action: \"look\" }` to see the screen it booted on, then " +
                "`tap`/`type` your way to the reported state (on web, `drive`; no UI — the endpoint/job " +
                "through `bash`), then `activity_collect { waitMs }` for what the probes saw. A capture or " +
                "one collected line is what turns analysis into a reproduction.\n\n" +
                "If you genuinely cannot reach the flow — a login nobody can cross, a device that will not " +
                "boot — re-issue this exact call with `reproduced: false` and say what stood in the way.",
              isError: true,
            };
          }
          // A claim the harness can positively disprove. Not invention: the hop
          // either ran something or it did not, and passing `reproduced: true`
          // downstream would tell the fixer a defect was witnessed when the run
          // holds no evidence that anything was.
          if (!observed && args?.reproduced === true) {
            const symptom = typeof args.symptom === "string" ? args.symptom : "";
            return t.execute(
              id,
              {
                ...args,
                reproduced: false,
                symptom:
                  `${symptom}\n\n(NOT OBSERVED — this pass ran nothing, so what follows is analysis, ` +
                  "not a witnessed symptom.)".trim(),
              },
              ctx,
            );
          }
          // The same correction for the launched-but-never-driven case: the
          // refusal above was the chance to go drive it, the re-issue is the
          // honest report.
          if (observed && args?.reproduced === true && !collectedLines && !droveOrCaptured) {
            const symptom = typeof args.symptom === "string" ? args.symptom : "";
            return t.execute(
              id,
              {
                ...args,
                reproduced: false,
                symptom:
                  `${symptom}\n\n(NOT DRIVEN — the app was launched but never walked to the symptom, ` +
                  "and no probe line was collected; what follows is analysis, not a witnessed symptom.)".trim(),
              },
              ctx,
            );
          }
          return t.execute(id, args, ctx);
        },
      };
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// The QA handshake: who runs the software, decided by the user, before anything
// is launched — in BOTH QA hops
// ---------------------------------------------------------------------------

/** Who runs and drives the software for a QA pass. The user's call, not the agent's. */
export type QaMode = "agent" | "user" | "skip";

/**
 * Which QA pass is asking. The two hops drive the same app for opposite reasons,
 * so they ask the same question about different work: `reproduce` asks who makes
 * the reported defect happen (before any fix exists), `verify` asks who checks
 * the change that was just made.
 */
export type QaHandshakeRole = "reproduce" | "verify";

/** A mutable holder so the handshake's answer is visible to the other wrappers. */
export interface QaModeBox {
  mode?: QaMode;
}

const SKIP_RE = /\b(?:skip|no qa|without qa|don'?t (?:verify|test|check|bother)|no (?:need|verification)|not needed|leave it)\b/;
const USER_RE =
  /\b(?:manual(?:ly)?|myself|by hand|human|i'?ll|i will|i can|i'?d rather|i'?m going to|i do it|my side|user (?:drive|drives|will|does|test|tests|check|checks))\b/;
const AGENT_RE = /\b(?:agent|you (?:drive|do|run|verify|test|check|handle)|automat\w*|go ahead|yes|proceed|please do)\b/;

/**
 * Read one of the three answers out of whatever the user actually typed.
 *
 * Order is load-bearing: "skip it, I'll check it myself later" contains both a
 * skip and a manual signal, and the instruction that matters is the one that
 * stops the agent driving — so skip is tested first, and the agent (keep going)
 * reading is last, since it is also the default when nothing matches.
 */
export function classifyQaMode(text: string | undefined): QaMode | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const t = text.toLowerCase();
  if (SKIP_RE.test(t)) return "skip";
  if (USER_RE.test(t)) return "user";
  if (AGENT_RE.test(t)) return "agent";
  return undefined;
}

/**
 * Does this question look like a QA handshake (so its answer already settled it)?
 *
 * Role-scoped, because the two questions are not interchangeable: "skip the
 * reproduction, I know what's wrong — just fix it" must not also skip the
 * verification of the fix. The chain's own in-memory record is the primary
 * channel (see `shared.qaModes`); this is the fallback for a host that collects
 * an answer out of band and restarts the run with it as a clarification.
 */
const QA_QUESTION_RE: Record<QaHandshakeRole, RegExp> = {
  reproduce: /\b(?:reproduc\w*|repro|see it happen|witness\w*)\b/i,
  verify: /\b(?:qa|verif\w*|test(?:ing)?|check\w*)\b/i,
};
/** Either role's phrasing — used when the caller does not say which pass is asking. */
const QA_QUESTION_ANY = /\b(?:qa|verif\w*|test(?:ing)?|check\w*|drive[sr]?|driving|reproduc\w*|repro)\b/i;

/**
 * The answer the user already gave THIS RUN, if any.
 *
 * The handshake is a run-level fact, not a hop-level one: the repair loop enters
 * `activity_inspect` again after every FAIL, and asking "who runs it?" once per
 * round would make the loop that exists to fix things feel like an
 * interrogation. `shared.clarifications` carries the Q&A across hops, so a
 * second visit reads the first visit's answer instead of asking again.
 */
export function qaModeFromClarifications(
  entries: readonly ResolvedClarification[] | undefined,
  role?: QaHandshakeRole,
): QaMode | undefined {
  const re = role ? QA_QUESTION_RE[role] : QA_QUESTION_ANY;
  for (const entry of [...(entries ?? [])].reverse()) {
    if (!re.test(entry.question ?? "")) continue;
    const mode = classifyQaMode(entry.answer);
    if (mode) return mode;
  }
  return undefined;
}

/** What one run has been told about each QA pass so far. */
export type QaModeRecord = Partial<Record<QaHandshakeRole, QaMode>>;

/**
 * The answer that applies to `role` now.
 *
 * Same role always wins. Failing that, the OTHER role's answer carries over —
 * but only when it is about WHO: "you drive" and "I'll drive" are facts about
 * this run (who is at the keyboard, whose device it is) and re-asking them per
 * hop is an interrogation. A SKIP never carries: "skip the reproduction, I know
 * what's broken" is a judgement about that step's value, and reading it as
 * permission to ship the fix unverified is exactly the silence this gate exists
 * to break.
 */
export function recallQaMode(record: QaModeRecord | undefined, role: QaHandshakeRole): QaMode | undefined {
  const own = record?.[role];
  if (own) return own;
  const other = record?.[role === "verify" ? "reproduce" : "verify"];
  return other === "skip" ? undefined : other;
}

/** The user's answer text, off an ANSWERED ask_user_question result. */
function answerTextOf(result: { output?: string; details?: unknown }): string | undefined {
  const details = result.details as { kind?: string; answered?: unknown } | undefined;
  if (details?.kind !== "ask_user_question" || details.answered !== true) return undefined;
  const match = /^User answered:\s*(.*)$/m.exec(result.output ?? "");
  // An answer of files alone is still an answer — it just classifies as nothing,
  // which the caller reads as "agent" (get on with it).
  return match ? match[1].trim() : "";
}

/** Per-role wording for the question, and for each answer being obeyed. */
const HANDSHAKE_TEXT: Record<
  QaHandshakeRole,
  { subject: string; ask: string; skip: string; user: string }
> = {
  verify: {
    subject: "who does the QA",
    ask:
      "Ask it as one `ask_user_question` with these three options: " +
      '"You verify it" (the agent builds, runs, drives the app and reports a verdict — recommended), ' +
      '"I\'ll verify it myself" (the user runs it and tells you what they see, so you judge from what ' +
      'they report and attach), "Skip QA" (deliver the change unverified, and say so). ' +
      "Say which surface you would run (the app / the dev server / the endpoint) and what you would look " +
      "at, so a one-click answer is enough.",
    skip:
      "the user chose to SKIP QA for this change. Do not build it, run it, drive it or " +
      "instrument it.\n\nFinish the hop honestly instead: `deliver` with no `verdict` (inconclusive) and " +
      "`findings` saying QA was skipped at the user's request, naming what WOULD have been checked and on " +
      "which surface, so they can run it themselves. If they later say otherwise, that answer overrides " +
      "this one.",
    user:
      "the user said THEY verify this one, so the app is theirs to run, not yours.\n\n" +
      "Your job now is to make their check cheap and then judge what it produces:\n" +
      "  1. `ask_user_question` with the EXACT steps to take (the surface, the route to the screen, the " +
      "thing to look at) and `requestAttachments` for a screenshot or the log — a screenshot they attach " +
      "becomes evidence you can actually judge;\n" +
      "  2. judge what they send (`media_analysis` lens:\"qa\" with `expected`, or read the log they " +
      "attach), then `deliver` a verdict that cites it;\n" +
      "  3. if they report it plainly in words, that is evidence too — quote it in `findings`.\n" +
      "Only take the surface back if they hand it back.",
  },
  reproduce: {
    subject: "who makes the defect happen",
    ask:
      "Ask it as one `ask_user_question` with these three options: " +
      '"You reproduce it" (the agent runs the app, instruments it and drives it to the reported state — ' +
      'recommended), "I\'ll reproduce it myself" (the user drives their own app and reports what they ' +
      'see, so you work from that), "Skip it — go straight to the fix" (no run at all; you deliver ' +
      "`reproduced: false` with the suspects reading gave you, and the fixer knows it is working from a " +
      "hypothesis). Say which surface you would run (the app / the dev server / the endpoint) and the " +
      "route you would take to the reported state, so a one-click answer is enough.",
    skip:
      "the user chose to SKIP the reproduction and go straight to the fix. Do not launch it, " +
      "drive it or instrument it.\n\nDeliver what reading gave you, honestly: `reproduced: false`, the " +
      "symptom AS REPORTED (not as witnessed), `suspects` with the lines a fix should target, and " +
      "`openQuestions` naming what only a run could have settled — the fixer needs to know it is working " +
      "from a hypothesis. If they later say otherwise, that answer overrides this one.",
    user:
      "the user said THEY will reproduce it, so their app is theirs to drive, not " +
      "yours.\n\nYour job now is to make their attempt count as evidence:\n" +
      "  1. `ask_user_question` with the EXACT steps you need walked (the screen, the trigger, what to " +
      "watch for) and `requestAttachments` for the capture or the log — for an INVISIBLE defect say which " +
      "log lines matter, because a screenshot of a normal-looking screen proves nothing;\n" +
      "  2. work from what they send: `media_analysis` on a capture, `read`/`activity_tail_file` on a log " +
      "they point at;\n" +
      "  3. `deliver` with `reproduced: true` ONLY if what they sent shows it, `symptom` in their words, " +
      "and `suspects` for the fixer.\n" +
      "Only take the surface back if they hand it back.",
  },
};

/**
 * STEP 0 OF THE PIPELINE, ENFORCED: a QA hop asks WHO runs the software before
 * it runs anything.
 *
 * The prompt has said this in prose for a while ("0. WHO DRIVES") and prose did
 * not bind. On the run this exists for, a development task changed a dialog
 * title in two files and the run ended with a report that could not say what the
 * new title was or whether anything had been verified — `ask_user_question` was
 * never called once in the whole run. The question is not optional politeness:
 * a QA pass on someone else's app can need a login, a seeded account, a device
 * they are holding, or nothing at all because they are watching the simulator
 * themselves, and only they know which.
 *
 * So every tool that RUNS, DRIVES, CAPTURES or INSTRUMENTS is refused until an
 * `ask_user_question` has been answered in this hop (or was answered earlier in
 * the run). Reading, grepping and searching the harness's own log stay open —
 * orienting first is fine; starting the app before asking is not.
 *
 * Then the answer is OBEYED, which is the half that makes asking honest:
 *   - the agent does it → nothing more happens here, the pipeline runs as written;
 *   - "I'll do it myself" → the driving tools stay shut and the hop's job becomes
 *     asking the user what they saw (with an attachment request) and judging THAT;
 *   - "skip" → nothing runs at all and the hop delivers the honest empty result:
 *     an unverified verdict, or `reproduced: false` with the suspects reading gave.
 *
 * BOTH QA HOPS ask it, because both of them run the user's app: `reproduce` asks
 * who makes the reported defect happen, `verify` asks who checks the change. The
 * two answers are tracked separately — "skip the reproduction, just fix it" is a
 * statement about that step's value, not permission to ship unverified — while a
 * "you drive" / "I drive" answer carries across, since who has their hands on the
 * device is a fact about the run and not about the step (see `shared.qaModes`).
 *
 * Never a deadlock: `deliver` is untouched by this wrapper, and the handshake
 * refusal itself stands down after `maxBlocks` so a model that cannot form the
 * question proceeds with a warning rather than spinning.
 */
export function enforceQaHandshake(
  tools: AgentTool[],
  opts: {
    box: QaModeBox;
    /** Which pass is asking (default "verify"). Decides the wording and the recall. */
    role?: QaHandshakeRole;
    /** The answer this run already gave for this role, from the chain's own record. */
    priorMode?: QaMode;
    priorAnswers?: readonly ResolvedClarification[];
    /** Told the mode the moment it is known, for the run log. */
    onMode?: (mode: QaMode, answer: string, source: "asked" | "earlier") => void;
    maxBlocks?: number;
  },
): AgentTool[] {
  const canAsk = tools.some((t) => isNamed(t.name, ["ask_user_question"]));
  // Nothing to enforce when the hop cannot ask (a host that stripped the tool):
  // holding QA hostage to a question that cannot be put would verify nothing at
  // all, which is the failure this whole gate is against.
  if (!canAsk) return tools;

  const role = opts.role ?? "verify";
  const text = HANDSHAKE_TEXT[role];
  const earlier = opts.priorMode ?? qaModeFromClarifications(opts.priorAnswers, role);
  if (earlier) {
    opts.box.mode = earlier;
    opts.onMode?.(earlier, "(answered earlier in this run)", "earlier");
  }
  let asked = earlier != null;
  let blocks = 0;
  const maxBlocks = opts.maxBlocks ?? 2;

  // Whether this tool can EVER be gated, decided at wrap time. `bash` is the
  // one that has to be wrapped and judged per call: the same tool runs the app
  // and reads the checkout, and only its arguments say which (`isRuntimeCommand`).
  const gatable = (name: string): boolean =>
    bareName(name) === "bash" ||
    isNamed(name, OBSERVATION_TOOL_PREFIXES) ||
    isNamed(name, INSTRUMENTATION_TOOLS);
  const gatedCall = (name: string, args?: Record<string, unknown>): boolean => {
    if (bareName(name) === "bash") return isRuntimeCommand(args?.command);
    return gatable(name);
  };
  // What the user does themselves when they said they would: reaching the app.
  // Judging evidence (`media_analysis` on a screenshot they attached), reading
  // collected logs and stripping probes are still this hop's work.
  const drivesTheApp = (name: string, args?: Record<string, unknown>): boolean => {
    if (bareName(name) === "bash") return isRuntimeCommand(args?.command);
    return isNamed(name, [
      "drive",
      "mobile",
      "browser_",
      "activity_inspect",
      "activity_trace_start",
      "take_screenshot",
      "take_snapshot",
      "lighthouse_audit",
      "performance_",
    ]);
  };

  return tools.map((t) => {
    if (isNamed(t.name, ["ask_user_question"])) {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          const res = await t.execute(id, args, ctx);
          if (res.isError) return res;
          const answer = answerTextOf(res);
          if (answer == null) return res; // not answered in-band; the host will collect it
          asked = true;
          const mode = classifyQaMode(answer) ?? "agent";
          opts.box.mode = mode;
          opts.onMode?.(mode, answer, "asked");
          return res;
        },
      };
    }
    if (t.name === DELIVER_TOOL_NAME || !gatable(t.name)) return t;
    return {
      ...t,
      description:
        t.description +
        ` Refused until you have asked the user ${text.subject} (you / they do it / skip) — that is ` +
        "step 0 of this categorizer, and their answer decides what runs.",
      execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
        if (!gatedCall(t.name, args)) return t.execute(id, args, ctx);
        if (!asked) {
          if (blocks < maxBlocks) {
            blocks += 1;
            return {
              output:
                `${t.name} refused — nothing runs in this categorizer until the user has said ` +
                `${text.subject}. That is step 0, and it is one question:\n\n${text.ask}\n\n` +
                "Then follow the answer and re-issue this call if it is still the right one. Ask ONCE — " +
                "this is the only question that comes before running; from there you drive and only stop " +
                "at a wall you have actually met.",
              isError: true,
            };
          }
          return t.execute(id, args, ctx);
        }
        if (opts.box.mode === "skip") {
          return { output: `${t.name} refused — ${text.skip}`, isError: true };
        }
        if (opts.box.mode === "user" && drivesTheApp(t.name, args)) {
          return { output: `${t.name} refused — ${text.user}`, isError: true };
        }
        return t.execute(id, args, ctx);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// A wall is a question, not a puzzle
// ---------------------------------------------------------------------------

/** Automation results that mean the screen did not move. */
const STALLED_DRIVE_RE =
  /\b(?:not found|no such element|could not (?:find|locate|tap|click)|unable to (?:find|locate)|no (?:match|element)|screen (?:did not|didn't) change|unchanged|timed? ?out|timeout)\b/i;

/**
 * Nudge — never block — an automation streak that is not getting anywhere.
 *
 * The wall (a login, an OTP, a form field whose value only the user has, an
 * upload, a paywall, an account picker) is the single most common way a QA pass
 * dies, and it dies quietly: the run keeps tapping, burns its budget at the same
 * screen, and reports what it never reached. The one move that crosses a wall is
 * `ask_user_question`, and on the run that motivated this it came after the
 * budget was gone.
 *
 * A NUDGE and not a refusal, deliberately: the model may be three taps from the
 * target, and a run that is making progress must never be stopped by a heuristic.
 * So the reminder rides along on the tool result the model is already reading,
 * fires once per streak, and resets the moment it asks, drives successfully, or
 * a call lands.
 */
export function nudgeAtWalls(tools: AgentTool[], opts: { maxNudges?: number } = {}): AgentTool[] {
  const maxNudges = opts.maxNudges ?? 3;
  let misses = 0;
  let streak = 0;
  let nudges = 0;

  const NOTE = [
    "",
    "",
    "── STUCK? ASK, DO NOT KEEP TAPPING ──",
    "This automation streak is not moving the screen. If what is in the way is a WALL — a login or",
    "signup, an OTP/2FA, a biometric or permission prompt, a paywall, an account selector, a form field",
    "whose value only the user has, a file to upload, a record that does not exist in this environment",
    "— then more taps will never cross it. Call `ask_user_question` NOW, naming the screen you are on",
    "and what you need. Three shapes of answer all unblock you: they type the VALUE, they ATTACH the",
    "file, or they DO that one step themselves on their machine and tell you to continue — you pick the",
    "run back up from the state they leave it in. A bypass counts too (a seeded account, a dev flag, a",
    "deep link past the gate). Ask once, keep working on anything that is not blocked, and never end a",
    "run reporting on a screen you never reached.",
  ].join("\n");

  return tools.map((t) => {
    if (isNamed(t.name, ["ask_user_question"])) {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          const res = await t.execute(id, args, ctx);
          // Asking IS the exit this nudge points at — the streak is over.
          if (!res.isError) {
            misses = 0;
            streak = 0;
          }
          return res;
        },
      };
    }
    if (!isNamed(t.name, ["drive", "mobile", "browser_", "take_screenshot", "take_snapshot"])) return t;
    return {
      ...t,
      execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
        const res = await t.execute(id, args, ctx);
        streak += 1;
        const stalled = res.isError === true || STALLED_DRIVE_RE.test(res.output ?? "");
        misses = stalled ? misses + 1 : 0;
        // Two calls in a row that went nowhere, or a long streak with nothing to
        // show for it. Both are streak-scoped: firing resets the counters, so a
        // pass that recovers is never nagged twice for the same stretch.
        if (nudges < maxNudges && (misses >= 2 || streak >= 8)) {
          nudges += 1;
          misses = 0;
          streak = 0;
          return { ...res, output: `${res.output ?? ""}${NOTE}` };
        }
        return res;
      },
    };
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
    clarifications: ResolvedClarification[];
  },
): string {
  const lines: string[] = [];
  lines.push(`TASK: ${input.task}`);
  lines.push(`WORKING DIRECTORY: ${input.cwd}`);
  if (ctx.imageNote) lines.push(ctx.imageNote);
  if (ctx.fileNote) lines.push(ctx.fileNote);
  for (const f of ctx.mentionFiles) lines.push(`MENTIONED FILE: ${f}`);
  if (ctx.mentionNote) lines.push(ctx.mentionNote);

  // Which automation surface this QA hop actually holds — stated so the model
  // stops reasoning about capabilities it does not have. From the field: an
  // inspect hop on a Flutter/iOS project, holding a pile of connected browser
  // MCP tools it could not use, reasoned "my connected automation is
  // browser-based, not a Flutter device MCP" and nearly declined to verify.
  // The gating now removes those tools; this line tells the model WHY, so the
  // absence reads as design and not as something missing.
  if (isQaHop(def)) {
    const surface = qaSurfaceFor(input);
    if (surface === "mobile") {
      lines.push(
        "AUTOMATION SURFACE: this is a mobile/device project. Your automation surface is the device " +
          "toolkit (`mobile` and the `activity_*` tools); there are no browser tools in this hop, by " +
          "design — do not reason about browser-based automation.",
      );
    } else if (surface === "web") {
      lines.push(
        "AUTOMATION SURFACE: this is a web project. Your automation surface is the browser (`drive` " +
          "and the `activity_*` tools); there are no device tools in this hop, by design.",
      );
    } else if (surface === "none") {
      lines.push(
        "AUTOMATION SURFACE: this is a backend project with no UI to drive. Verify through the " +
          "project's own run/test commands (`bash`) and the `activity_*` tools; there are no browser " +
          "or device tools in this hop, by design.",
      );
    }
  }

  // Placed immediately under TASK, and OUTSIDE the `accepts` contract below.
  //
  // `TASK:` above is the user's original wording, which never changes — so on a
  // request like "change the title to something else" it reads as unspecified for
  // the whole run, in every hop, even after the user has said what they want.
  // A hop that saw only that line asked the question a second time. The answer is
  // not another categorizer's finding to be granted or withheld by `accepts`; it
  // is what the user said, and every hop after it gets it.
  if (ctx.clarifications.length) {
    lines.push(
      [
        "ALREADY ANSWERED BY THE USER (this run) — treat as part of the task and DO NOT ask again:",
        ...ctx.clarifications.map((entry) => {
          const files = entry.attachments?.length
            ? `\n  they attached: ${entry.attachments
                .map((file) => `${file.path} (${file.mimeType})`)
                .join(", ")}`
            : "";
          return (
            `- asked: ${entry.question}\n  answered: ${entry.answer}` +
            (entry.reason ? `\n  why it was asked: ${entry.reason}` : "") +
            files
          );
        }),
        "These answers OUTRANK the task text above wherever they conflict — the task was written before the",
        "user answered. Attached images are already in your attachment set; read any other attached file",
        "rather than asking what it contains. Re-asking any of this is refused.",
      ].join("\n"),
    );
  }

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
    readCache: Map<string, string>;
    complexityByPath: Record<string, import("../types.js").ComplexityRating>;
    comprehensionStore: ComprehensionStore;
    /** True once the host flag OR the router says this run fixes a reported bug. */
    isBugFix: boolean;
    /**
     * Who runs the software, per QA pass, as the user has said this run. Written
     * by the handshake gate and read by the next hop, so the question is asked
     * once per role instead of once per visit (see `recallQaMode`).
     */
    qaModes: QaModeRecord;
    /**
     * Questions the user has answered, run-wide. Grown after every hop and
     * handed to the next one — the channel that stops a later categorizer
     * asking for a value the user already gave.
     */
    clarifications: ResolvedClarification[];
  },
): Promise<HopRun> {
  const model = input.modelFor(def);
  const box: DeliverBox = { delivered: false };
  let tools = resolveCategorizerTools(input, def, box, shared.mentionTools, hops);
  if (def.id === "write_edit") tools = enforcePlanFirst(tools);
  // The handshake's answer, shared between the wrappers: the QA gate writes it,
  // observe-first reads it (a hop the USER verifies owes no observation of its own).
  const qaBox: QaModeBox = {};
  // A categorizer that was not GIVEN `write`/`edit` may not author through the
  // shell either — by any spelling, in any language. Keyed off the toolset rather
  // than a list of ids, because the id list was the bug: the guard named the two
  // QA hops, and the run that broke this authored a source file from the READ
  // hop, which nobody had thought to name.
  const authorsFiles = tools.some((t) => bareName(t.name) === "write" || bareName(t.name) === "edit");
  if (!authorsFiles) {
    tools = enforceNoShellAuthoring(tools, input.cwd, {
      // The QA hops have somewhere to go (run it and look); everyone else owes
      // the change to `write_edit`, which is the only pass whose file changes the
      // run records.
      instead: def.id === "activity_reproduce" || def.id === "activity_inspect" ? "observe" : "handoff",
    });
  }
  // EVERY hop: opening the target in the user's DESKTOP browser is nobody's job.
  // From the field: the write pass ran `bash open index.html` to "verify", the
  // page popped in the user's browser, captured nothing — and the inspect pass
  // then opened it AGAIN in the harness's own browser, which is the only opener
  // that produces evidence. One page, two opens, one of them on the user's
  // desktop. The refusal names the real distribution: write finishes with
  // deliver; the verify pass opens and captures.
  tools = enforceNoDesktopOpen(tools, def.id);
  if (def.id === "activity_reproduce" || def.id === "activity_inspect") {
    tools = enforceObserveFirst(tools, {
      // Reproduction only. A verify pass legitimately builds and runs without
      // probes — it is measuring a change, not hunting for an invisible value.
      probesBeforeLaunch: def.id === "activity_reproduce",
      qaMode: () => qaBox.mode,
    });
    // A wall met while driving is the same question the handshake asks, arriving
    // later: nudge at it rather than letting the pass tap the budget away.
    tools = nudgeAtWalls(tools);
  }
  // Step 0 of BOTH QA pipelines, enforced: the user says who runs the software
  // before anything is built, launched, driven or instrumented. The reproduce
  // hop asks who makes the reported defect happen; the verify hop asks who
  // checks the change that was just made.
  if (def.id === "activity_inspect" || def.id === "activity_reproduce") {
    const role: QaHandshakeRole = def.id === "activity_reproduce" ? "reproduce" : "verify";
    tools = enforceQaHandshake(tools, {
      box: qaBox,
      role,
      // Asked once per run per role. A "you drive" / "I drive" answer carries
      // across roles — who has their hands on the device is a fact about the
      // run — while a SKIP does not: "skip the reproduction, just fix it" says
      // nothing about whether the fix should be verified.
      ...(recallQaMode(shared.qaModes, role) ? { priorMode: recallQaMode(shared.qaModes, role) as QaMode } : {}),
      priorAnswers: shared.clarifications,
      onMode: (mode, answer, source) => {
        shared.qaModes[role] = mode;
        input.logStore.append({
          tags: ["categorizer", "categorizer:qa-mode"],
          level: "info",
          message: `${role} mode: ${mode} (${source})`,
          data: { categorizer: def.id, role, mode, source, answer: trunc(answer, 240) },
        });
      },
    });
  }
  const toolNames = tools.map((t) => t.name);

  const systemPrompt = buildCategorizerSystemPrompt(def, toolNames, {
    authorOnlyWrites: input.authorOnlyWrites,
    // The run's live verdict, not just the host's flag: the router also reads the
    // request, and a bug report phrased outside the host's patterns used to lose
    // write_edit's reproduce-first directive along with everything else.
    isBugFix: shared.isBugFix || input.isBugFix,
    ...(input.projectCategory ? { projectCategory: input.projectCategory } : {}),
  });

  let opening = buildOpening(input, def, hops, {
    mentionNote: shared.mentionNote,
    imageNote: shared.imageNote,
    fileNote: shared.fileNote,
    mentionFiles: shared.mentionFiles,
    clarifications: shared.clarifications,
  });

  // Hop-start handover of comprehension. The read step paid a stronger model to
  // understand these files, but the analysis only reached a LATER hop when that
  // hop re-read the file — so the field reproduce hop re-read everything the
  // read pass had already covered, ~28 read/grep calls that produced nothing the
  // run did not already hold. Inject the analyses for the files the read
  // deliverable names, stamp them emitted for THIS loop (a later read of one
  // returns bytes + a pointer, not a second copy of the analysis), and seed the
  // loop's re-visit tracking so the first redundant re-read is flagged.
  const acceptedReadFiles = hops
    .filter((h) => h.id === "read" && (def.accepts?.from ?? []).includes(h.id))
    .flatMap((h) => {
      const files = (h.deliverable as { files?: Array<{ path?: unknown }> } | undefined)?.files;
      return (files ?? [])
        .map((f) => (typeof f.path === "string" ? f.path : ""))
        .filter((p) => p.length > 0);
    });
  let preComprehendedPaths: string[] = [];
  {
    const PER_FILE_CAP = 4_500;
    const TOTAL_CAP = 24_000;
    const MAX_FILES = 6;
    let budget = TOTAL_CAP;
    const sections: string[] = [];
    for (const rel of acceptedReadFiles) {
      if (sections.length >= MAX_FILES || budget <= 0) break;
      const abs = path.isAbsolute(rel) ? rel : path.resolve(input.cwd, rel);
      const entry = shared.comprehensionStore.recall(abs);
      if (!entry?.analysis) continue;
      const text =
        entry.analysis.length > PER_FILE_CAP
          ? `${entry.analysis.slice(0, PER_FILE_CAP)} …[truncated]`
          : entry.analysis;
      if (budget - text.length < 0) continue;
      budget -= text.length;
      entry.emitted = true;
      entry.emittedInLoop = `categorizer:${def.id}`;
      preComprehendedPaths.push(abs);
      sections.push(`--- ${rel} (rated ${entry.rating}, by ${entry.model}) ---\n${text}`);
    }
    if (sections.length > 0) {
      opening += `\n\n${[
        "WHOLE-FILE ANALYSES YOU ALREADY HOLD — the read step had a stronger model understand these",
        "files; its analysis of each is below, map and findings. Do NOT read them again to understand",
        "them: the map covers the file's line ranges, and reading returns what you already hold. Read a",
        "range of one ONLY for its exact bytes (an edit anchor, a verbatim quote).",
        ...sections,
      ].join("\n")}`;
    }
  }

  input.emit({ type: "categorizer_start", categorizer: def.id, model: model.openRouterSlug ?? model.id });
  input.logStore.append({
    tags: ["categorizer", `categorizer:${def.id}`],
    level: "info",
    message: `hop ${hops.length}: running categorizer "${def.id}" (${toolNames.length} tools, model ${model.openRouterSlug ?? model.id})`,
    data: { categorizer: def.id, tools: toolNames },
  });

  // Read deliverables hand their snippets to the authoring pass as bounded,
  // LABELED extracts (write/edit's Model-B context), not just opening prose —
  // via `handoffSnippets`, which never satisfies a `read` call.
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
    // The run-scoped comprehension store: the read hop's expert analyses are
    // visible to (and re-injected into) every later hop at zero model cost, so a
    // file is analysed once per run no matter how many hops touch it.
    sharedComprehension: shared.comprehensionStore,
    // The analyses already printed in this hop's opening message: the re-visit
    // advisor is armed for them from turn one.
    ...(preComprehendedPaths.length ? { preComprehended: preComprehendedPaths } : {}),
    // Read-deliverable snippets feed the AUTHORING context only (labeled as
    // extracts). They must not satisfy a `read` — write_edit's edit anchors
    // need the file's exact bytes, so a read in that hop executes for real
    // (the shared read cache still dedups identical repeats).
    ...(acceptedSnippets.length ? { handoffSnippets: acceptedSnippets } : {}),
    ...(shared.mediaFact ? { mediaFact: shared.mediaFact } : {}),
    ...(shared.triageCallback ? { triageAttachment: shared.triageCallback } : {}),
    sharedReadCache: shared.readCache,
    ...(Object.keys(shared.complexityByPath).length ? { complexityByPath: { ...shared.complexityByPath } } : {}),
    clarifyGate: shared.clarifyGate,
    ...(shared.clarifications.length ? { clarifications: [...shared.clarifications] } : {}),
    phase: def.id,
    ...(input.projectCategory ? { projectCategory: input.projectCategory } : {}),
    label: `categorizer:${def.id}`,
  });

  // Split the routing fields out of the payload before anything else touches it:
  // the deliverable is rendered verbatim into the next categorizer's opening, and
  // a note addressed to the CHAIN reads there as a note addressed to that hop.
  const handoff = takeHandoff(def, box.delivered ? box.deliverable : undefined);
  let deliverable = box.delivered
    ? handoff.deliverable
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

  // The read hop's deliverable carries the expert analyses the store holds for
  // the files it read, so the write_edit hop's OPENING context already includes
  // them — it can reason about the files before its first read, and the full
  // texts travel in the shared store for zero-cost re-injection on its reads.
  // Bounded here; `renderDeliverable` truncates the handoff in either case.
  if (def.id === "read") {
    const readSet = new Set(loop.readPaths.map((p) => path.normalize(p)));
    const comprehensions = shared.comprehensionStore
      .entries()
      .filter(({ path: p, value }) => Boolean(value.analysis) && readSet.has(path.normalize(p)))
      .map(({ path: p, value }) => ({
        path: p,
        rating: value.rating as "low" | "medium" | "high",
        model: value.model ?? "unknown",
        analysis: trunc(value.analysis ?? "", 700),
      }))
      .slice(0, 5);
    if (comprehensions.length) {
      deliverable = { ...(deliverable as object), comprehensions };
    }
  }

  const summaryText =
    (deliverable as { summary?: string }).summary ??
    (deliverable as { codeSummary?: string }).codeSummary ??
    (deliverable as { findings?: string }).findings ??
    // A repro report's headline is the symptom, prefixed with whether it was
    // actually seen — the router's one-line view of this hop must not read as
    // "the defect is confirmed" when the answer was could-not-reproduce.
    ((deliverable as { symptom?: string }).symptom
      ? `${(deliverable as { reproduced?: boolean }).reproduced === false ? "NOT reproduced" : "reproduced"}: ${(deliverable as { symptom?: string }).symptom}`
      : undefined) ??
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
    ...(handoff.nominations.length ? { nominations: handoff.nominations } : {}),
    ...(handoff.reason ? { nominationReason: handoff.reason } : {}),
  };
  if (handoff.nominations.length) {
    input.logStore.append({
      tags: ["categorizer", `categorizer:${def.id}`, "categorizer:handoff"],
      level: "info",
      message: `${def.id} nominated ${handoff.nominations.join(" → ")}`,
      data: { nominations: handoff.nominations, ...(handoff.reason ? { reason: handoff.reason } : {}) },
    });
  }

  // Progress telemetry only — the deliverable is the NEXT categorizer's
  // handoff, not UI content; the run's single user-facing summary is the final
  // one composed from every hop (see summarizeChain).
  input.emit({
    type: "categorizer_end",
    categorizer: def.id,
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

  // Images triage in PARALLEL: each is an independent describe pass, and
  // sequential awaits were the slowest part of multi-attachment startup.
  const triagedImages = await Promise.all(
    (input.images ?? []).map(async (img) => {
      if (!tctx) return { path: img.path, mimeType: img.mimeType };
      try {
        const { result, fact, usage: u } = await triageImageAttachment(img, input.task, tctx);
        if (fact) facts.push(fact);
        if (u) usage = usage ? addUsage(usage, u) : u;
        return {
          path: img.path,
          mimeType: img.mimeType,
          ...(result.category ? { category: result.category } : {}),
          ...(result.note ? { label: result.note } : {}),
        };
      } catch {
        // a failed triage leaves the image un-enriched, never blocks the run
        return { path: img.path, mimeType: img.mimeType };
      }
    }),
  );
  images.push(...triagedImages);
  for (const img of images) {
    notes.push(`${img.path}${img.label ? ` — ${img.label}` : ""} (${img.mimeType})`);
  }

  const fileLines: string[] = [];
  // Documents triage in parallel (independent OCR/text passes).
  await Promise.all(
    (input.files ?? []).map(async (f) => {
      fileLines.push(`${f.path} (${f.mimeType})`);
      if (!tctx || !isDocumentRef(f)) return;
      try {
        const { fact, usage: u } = await triageDocumentAttachment(f, input.task, tctx);
        if (fact) facts.push(fact);
        if (u) usage = usage ? addUsage(usage, u) : u;
      } catch {
        // enrichment is best-effort
      }
    }),
  );

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

async function stripRemainingProbes(
  input: CategorizerChainInput,
  paths: string[],
  model: Model,
  readCache: Map<string, string>,
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
    sharedReadCache: readCache,
    systemPrompt: [
      "You are the cleanup pass of a coding run. Whole-line probes have already been removed by rule;",
      "what is left needs judgement. Two shapes: a TURING_TRACE probe ENTANGLED with code",
      "(`if (x) { print(\"TURING_TRACE…\"); return; }`) — take the probe out and leave the statement",
      "working; and a block the removal left EMPTY (`} else { }`) — an instrumenting pass added it to",
      "host a probe, so collapse it back unless the surrounding code needs it. Leave everything else",
      "byte-identical. Use remove_log / activity_cleanup / edit. When every listed file is clean, stop.",
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

  // RUN-LEVEL EFFICIENCY STATE, threaded through every hop:
  //  • readCache — one dedup cache across hops (write_edit never re-pays a
  //    read the read categorizer already made; writes still invalidate).
  //  • comprehensionStore — one "analyse once per file" store across hops: the
  //    read hop's expert analyses are re-injected into each later driver's
  //    context at zero model cost instead of being re-rated/re-comprehended.
  //  • complexityByPath — difficulty floors (plan-task + tool-measured)
  //    ratchet UP across hops, so read's verdict reaches write_edit's gate.
  const readCache = new Map<string, string>();
  const comprehensionStore = new ComprehensionStore();
  const complexityByPath: Record<string, import("../types.js").ComplexityRating> = {};

  const shared = {
    clarifyGate: new ClarifyGate(),
    clarifications: [] as ResolvedClarification[],
    isBugFix: input.isBugFix === true,
    qaModes: {} as QaModeRecord,
    mentionTools,
    mentionNote,
    images: triage.images,
    imageNote: triage.imageNote,
    fileNote: triage.fileNote,
    mentionFiles,
    ...(triageCallback ? { triageCallback } : {}),
    ...(triage.mediaFact ? { mediaFact: triage.mediaFact } : {}),
    readCache,
    comprehensionStore,
    complexityByPath,
  };

  // --- hop loop ---
  let choices = entryCategories(input.setup);
  let lastSelection: RouterChoice | undefined;
  // What the last hop's driver said comes next, not yet consumed. The driver is
  // asked because it is the only party that has seen the code; the router is the
  // fallback for when it says nothing usable. See route-policy.ts.
  let nominationQueue: CategorizerId[] = [];
  // The router's own read on "is this a reported bug", OR-ed with the host flag:
  // bug detection used to hinge entirely on the host's regex list, so a bug
  // report phrased outside it lost every bug-specific policy in the run.
  let bugFixRun = shared.isBugFix;
  try {
    for (let hopIndex = 0; hopIndex < maxHops; hopIndex++) {
      if (input.signal?.aborted) throw new Error("aborted");

      const policyInput = {
        choices,
        hops,
        queue: nominationQueue,
        writtenPaths,
        isBugFix: bugFixRun,
        preferInspect: input.verifyEnabled !== false,
      };
      let decision = decideFromDriver(policyInput);
      if (!decision) {
        const routed = await routeCategorizer({
          setup: input.setup,
          choices,
          task: input.task,
          attachments: [...(input.images ?? []), ...(input.files ?? [])],
          ...(mentionNote ? { mentionNote } : {}),
          hops,
          ...(lastSelection ? { lastId: lastSelection } : {}),
          ...(bugFixRun ? { isBugFix: true } : {}),
          preferInspect: input.verifyEnabled !== false,
          llm: input.llm,
          model: input.routerModel,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        totalUsage = addUsage(totalUsage, routed.usage);
        if (routed.bugFixHint === true) {
          bugFixRun = true;
          shared.isBugFix = true;
        }
        decision = applyPolicyToRouted(
          { ...policyInput, isBugFix: bugFixRun },
          routed.selection,
          routed.reason,
          routed.fallback,
        );
      }
      nominationQueue = decision.queue;
      lastSelection = decision.selection;
      // The routing decision was previously unlogged — this failure mode could
      // only be diagnosed by reconstructing what the router must have seen.
      input.logStore.append({
        tags: ["categorizer", "categorizer:route"],
        level: "info",
        message: `route → ${decision.selection} (${decision.source})`,
        data: {
          selection: decision.selection,
          source: decision.source,
          reason: decision.reason,
          choices: choices.map((c) => c.id),
          queued: nominationQueue,
          isBugFix: bugFixRun,
          writes: writtenPaths.length,
        },
      });
      const routed = decision;

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
      // Ratchet the run's per-path difficulty floors (never down).
      const rank = { low: 0, medium: 1, high: 2 } as const;
      for (const [path, rating] of Object.entries(loop.complexityByPath ?? {})) {
        const prev = shared.complexityByPath[path];
        if (!prev || rank[rating] > rank[prev]) shared.complexityByPath[path] = rating;
      }
      // Carry the run's Q&A and its attachments forward. Both are run-level
      // facts: an answer the user gave in read is still their answer in
      // write_edit, and a mockup they attached to it is still an attachment of
      // this run. Before this, both died with the hop that collected them.
      for (const entry of loop.resolvedClarifications ?? []) {
        if (shared.clarifications.some((prior) => normalizeQuestion(prior.question) === normalizeQuestion(entry.question))) {
          continue;
        }
        shared.clarifications.push(entry);
        shared.clarifyGate.recordAnswer(entry);
      }
      for (const image of loop.liveImages ?? []) {
        if (shared.images.some((prior) => prior.path === image.path)) continue;
        shared.images.push(image);
      }
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
        // A hop that stalled or ran out of steps stopped EARLY — it did not
        // fail the run. Its writes are real, its routing debt is real, and the
        // user's change still deserves its verification pass. From the field:
        // a write hop landed both edits, spent three turns on unknown-tool
        // calls, stalled — and the chain aborted HERE, so FLOOR 0 never forced
        // the inspect pass and the run ended "failed" with the change
        // unverified purely because its author dithered after finishing.
        //
        // So: record the error for the final result, DROP the stalled driver's
        // nominations (a driver that stalled mid-work has no credible "what's
        // next"), and let the hop loop continue into routing — the router and
        // the floors decide what the run still owes, exactly as they would
        // after a clean deliver. Fatal errors (transport, aborts) still end
        // the run: there is no chain left to continue.
        error = loop.error;
        if (isNonFatalLoopError(loop.error)) {
          nominationQueue = [];
          input.logStore.append({
            tags: ["categorizer", "categorizer:hop-stalled"],
            level: "warn",
            message: `hop "${hop.id}" stopped early (${loop.error.slice(0, 120)}) — continuing to routing`,
            data: { categorizer: hop.id, error: loop.error },
          });
        } else {
          break;
        }
      }

      // The hop's own nomination REPLACES whatever remained of an older one: the
      // most recent driver has seen the most.
      if (hop.nominations?.length) nominationQueue = [...hop.nominations];

      choices = def.children
        .map((id) => input.setup.categories.find((c) => c.id === id))
        .filter((c): c is CategorizerDefinition => Boolean(c));
      if (choices.length === 0) break; // leaf categorizer → summarise
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // --- probe strip ---
  //
  // Deterministic FIRST, and outside the try that guards the model pass. The old
  // shape was a model loop only, which made cleanup as abortable as the run it
  // followed: one field run was stopped by hand, its strip loop died with it
  // (`end loop: cleanup:strip-probes error=aborted`), and 24 probe lines stayed
  // in three files. The NEXT run then read them as product code and authored a
  // fix around one of them.
  //
  // Scanned over everything the run READ as well as what it wrote: a stale probe
  // in a file this run only read is exactly the case above, and the file is
  // already in the read cache so looking is free.
  const probeCandidates = new Set<string>([...instrumented, ...writtenPaths, ...readPaths]);
  const mixedProbeFiles: string[] = [];
  try {
    const fsp = await import("node:fs/promises");
    for (const candidate of probeCandidates) {
      const abs = path.isAbsolute(candidate) ? candidate : path.join(input.cwd, candidate);
      let source: string;
      try {
        source = await fsp.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const result = stripProbeLines(source);
      if (result.content != null) {
        await fsp.writeFile(abs, result.content, "utf8");
        input.logStore.append({
          tags: ["categorizer", "categorizer:cleanup", "cleanup:probes"],
          level: "info",
          message: `stripped ${result.removed} probe line(s) from ${abs}`,
          data: { path: abs, removed: result.removed, mixed: result.mixed },
        });
      }
      // Two things a rule must not decide: a probe entangled with code (removing
      // it means re-authoring the statement) and a block the removal emptied
      // (whether `} else { }` should collapse depends on the code around it).
      // Both go to the model pass, which is what it is for.
      if (result.mixed.length || result.emptiedBlocks.length) {
        mixedProbeFiles.push(abs);
        if (result.emptiedBlocks.length) {
          input.logStore.append({
            tags: ["categorizer", "categorizer:cleanup", "cleanup:probes"],
            level: "warn",
            message: `stripping probes left ${result.emptiedBlocks.length} empty block(s) in ${abs}`,
            data: { path: abs, emptiedBlocks: result.emptiedBlocks },
          });
        }
      }
    }
  } catch {
    // best-effort: a cleanup failure never fails the run
  }
  try {
    if (mixedProbeFiles.length) {
      const stripUsage = await stripRemainingProbes(
        input,
        mixedProbeFiles,
        input.modelFor(getCategory(input.setup, "activity_inspect")),
        shared.readCache,
      );
      if (stripUsage) totalUsage = addUsage(totalUsage, stripUsage);
    }
  } catch {
    // cleanup is best-effort; never fails the run
  }

  // The harness's own browser session (drive) is per-run state: close it so a
  // finished run never leaves a headless Chrome alive in the host's process.
  try {
    const { closeWebSession } = await import("../tools/web-session.js");
    await closeWebSession();
  } catch {
    // best-effort
  }

  // --- summary ---
  // The summary turn always owns the closing statement, including for a lone
  // `conversation` hop. `deliver` is hop-scoped by design: its note is a handoff
  // to the next categorizer, not an answer addressed to the user. Promoting it
  // verbatim used to leave a read-only run with no closing turn of its own.
  let summary: string | undefined;
  if (hops.length) {
    const s = await summarizeChain(input, hops, writtenPaths, readPaths, refs);
    if (s?.usage) totalUsage = addUsage(totalUsage, s.usage);
    summary = s?.text ?? undefined;
  }
  // Only if the summary turn itself failed (network, empty completion) do we
  // fall back to a hop's own note — better a step-scoped answer than silence.
  for (let i = hops.length - 1; i >= 0 && !summary; i -= 1) {
    summary =
      String((hops[i].deliverable as { summary?: string })?.summary ?? hops[i].summary ?? "").trim() ||
      undefined;
  }
  // The run's ONE closing statement. Without this the last thing a host has to
  // render is the final `deliver` card — that hop's own note, which describes
  // only the step that happened to run last while reading as the verdict on the
  // whole run.
  if (summary) input.emit({ type: "run_summary", summary });

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

  const onlyConversation = hops.length === 1 && hops[0].id === "conversation";
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
    // A run that changed nothing was asked a question, not given a job: the
    // closing turn has to ANSWER it. Summarizing "the work just done" on a
    // read-only run throws away the very thing the user asked for.
    const answering = writtenPaths.length === 0 && !hops.some((h) => h.id === "write_edit");
    const lines: string[] = [];
    lines.push(
      answering
        ? `Answer the user's request below, using the record as your only source.`
        : `Summarize the work just done for this task, in 2-6 sentences.`,
    );
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
      answering
        ? `Reply with ONLY the answer. Ground every claim in the record above — never add detail it does` +
          ` not contain, and never imply a check ran that the record does not show. Keep the specifics the` +
          ` record gives you: file paths, symbol and identifier names, line numbers, exact values. If the` +
          ` record does not settle part of the request, say which part and what is still unknown.`
        : `Reply with ONLY the summary prose. Ground every claim in the record above — never add detail it` +
          ` does not contain, and never imply a check ran that the record does not show. If a step was` +
          ` cut short or left work undone, say so and what remains.`,
    );
    const msg = await input.llm.complete(
      input.summaryModel,
      {
        // Both modes open on the same sentence: it is the stable marker a host
        // (or a test stub) uses to recognise the closing summary turn.
        systemPrompt: [
          "You write the closing summary of a run, for the user who asked for it — the last thing they",
          "read, and the only part of the run addressed to them.",
          ...(answering
            ? [
                "This run changed nothing: the user asked a question, so this turn has to ANSWER it, not",
                "narrate the looking. You did NOT do the investigation — everything you know is in the record",
                "below. Write from it, and never add detail it does not contain: no invented file contents, no",
                "reasoning you did not see, and above all no test, build, or visual check the record does not",
                "say was actually run. Answer directly, in the first sentence. Carry the record's concrete",
                "specifics through instead of generalizing them away, and say plainly where it came up short.",
                "Run as long as the question needs and no longer. Markdown is fine.",
              ]
            : [
                "You did NOT do this work: everything you know is in the record below. Write from it, and never",
                "add detail it does not contain — no invented file contents, no reasoning you did not see, and",
                "above all no test, build, or visual check that the record does not say was actually run.",
                "Lead with what the user got. Name the files that changed by path, say plainly what is still",
                "incomplete or unverified, and stop. Plain prose, 2-6 sentences, no headings, no bullets.",
              ]),
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
