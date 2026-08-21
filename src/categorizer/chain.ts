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
import { PROBE_MARKER_RE } from "../probe-marker.js";
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
export function enforceNoShellAuthoring(tools: AgentTool[], cwd: string): AgentTool[] {
  return tools.map((t) => {
    if (bareName(t.name) !== "bash") return t;
    return {
      ...t,
      description:
        t.description +
        " In this categorizer the shell RUNS things — it may not write or revert project files " +
        "(no heredoc/sed/redirect into source, no `git checkout`/`restore`/`reset --hard`).",
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
          const authoring = shellAuthoringTarget("bash", args);
          if (authoring && isProjectPath(cwd, authoring.path)) {
            return {
              output:
                `bash refused — that command writes ${authoring.path} (${authoring.form}), and this ` +
                "categorizer does not author product code. Two tools own the two legitimate reasons " +
                "to touch a file here:\n" +
                "  - a trace probe → `add_log` (log-only, and `activity_cleanup` takes it back out);\n" +
                "  - the fix itself → not you. `write_edit` runs after you and works from your report; " +
                "a fix written here is written blind, before anyone has seen the defect.\n\n" +
                "What is missing from this pass is one observation. Launch it (`drive`/`mobile`), or " +
                "run the project's own run/test command, and look at what it does. A scratch file " +
                "outside the project (a temp script, a throwaway harness) is still fine.",
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
export function enforceObserveFirst(tools: AgentTool[]): AgentTool[] {
  const canObserve = tools.some((t) => t.name !== DELIVER_TOOL_NAME && isObservationTool(t.name));
  if (!canObserve) return tools;
  let observed = false;
  let instrumented = false;
  const refused = { deliver: 0, cleanup: 0 };
  return tools.map((t) => {
    if (t.name !== DELIVER_TOOL_NAME && isObservationTool(t.name)) {
      return {
        ...t,
        execute: async (id: string, args: Record<string, unknown>, ctx: ToolContext) => {
          const res = await t.execute(id, args, ctx);
          // The ARGS decide for bash, so this is checked per call, not per tool.
          if (!res.isError && isObservationCall(t.name, args)) observed = true;
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
                "going to produce.\n\nRun it: `mobile {action:\"launch\"}` or `drive {action:\"open\"}` " +
                "for a UI, the project's own run/test command through `bash` otherwise — then " +
                "`activity_collect` to read what the probes saw. Strip them AFTER that.\n\nIf you " +
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
          if (!observed && refused.deliver < 1) {
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
  if (def.id === "activity_reproduce" || def.id === "activity_inspect") {
    tools = enforceObserveFirst(enforceNoShellAuthoring(tools, input.cwd));
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

  const opening = buildOpening(input, def, hops, {
    mentionNote: shared.mentionNote,
    imageNote: shared.imageNote,
    fileNote: shared.fileNote,
    mentionFiles: shared.mentionFiles,
    clarifications: shared.clarifications,
  });

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

async function scanForProbeMarkers(cwd: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const fs = await import("node:fs/promises");
  // Parallel reads: the scan runs after every chain and the files are
  // independent.
  const checked = await Promise.all(
    paths.map(async (p) => {
      const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
      try {
        const content = await fs.readFile(abs, "utf8");
        return PROBE_MARKER_RE.test(content) ? p : null;
      } catch {
        // missing/unreadable → can't confirm a marker; skip
        return null;
      }
    }),
  );
  return checked.filter((p): p is string => p !== null);
}

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
        error = loop.error;
        break;
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
  try {
      for (const p of writtenPaths) instrumented.add(p);
      const remaining = await scanForProbeMarkers(input.cwd, [...instrumented]);
    if (remaining.length) {
      const stripUsage = await stripRemainingProbes(
        input,
        remaining,
        input.modelFor(getCategory(input.setup, "activity_inspect")),
        shared.readCache,
      );
      if (stripUsage) totalUsage = addUsage(totalUsage, stripUsage);
    }
  } catch {
    // cleanup is best-effort; never fails the run
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
