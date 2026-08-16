/**
 * Internal tool: create_plan.
 *
 * Breaks a task into an ordered, multi-file plan and puts it in front of the
 * user before any of it runs. The review loop is the point of the tool:
 *
 *   draft → host shows it → user approves, or comments and it is re-drafted
 *                        → user may attach notes/files to individual steps
 *
 * Five things make this different from the free-form planning turn it supersedes:
 *
 *   1. The planning PROMPT is configuration (`PlanToolConfig.systemPrompt`), not
 *      a constant, so a host can change how planning works without forking the
 *      tool. {@link DEFAULT_PLAN_SYSTEM_PROMPT} is exported to extend rather than
 *      replace it.
 *   2. The MODEL is configuration too (`PlanToolConfig.model`). Planning is the
 *      one call where paying for a stronger model reliably pays back, because a
 *      bad decomposition is inherited by every step that follows it.
 *   3. The plan is returned as STRUCTURED data (`details.planSet`), so the host
 *      renders a real plan object instead of scraping prose — including
 *      `complexity` per task (which becomes the model-selection floor when that
 *      step runs) and `isCompleted`, which starts false on every task and is
 *      flipped to true IN PLACE by `Orchestrator.run` as each step's work loop
 *      finishes. The model never authors that field; the harness owns it.
 *   4. Attachments flow both ways. Files the user attached to the RUN are listed
 *      to the planner so it can route each one to the step that needs it, and
 *      files the user attaches DURING review land on the step they were dropped
 *      on. Either way the file reaches that step's work loop and nothing else.
 *   5. Per-step user notes ride ON the plan, so a reviewer's instruction for step
 *      3 is in front of the agent when step 3 runs — not lost in chat history.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentTool,
  Context,
  PlanApprovalDecision,
  PlanApprovalRequest,
  PlanAttachment,
  PlanSet,
  PlanStepEdit,
  PlanTask,
  ToolContext,
  Usage,
} from "../../types.js";
import { extractPlanSet, normalizeLegacyPlanJson, extractPlanJson } from "../../orchestrator/plan-extract.js";
import { guessMimeType } from "../../multimodal/attachment.js";
// The planning call is its own isolated context, so the shared complexity scale has
// to travel INTO it. This is the same text the loop and the phases carry: the
// per-task rating emitted here becomes the per-file floor when that step runs and
// decides which model authors the bytes, so a private scale here would mean the
// producer and the consumer disagree about what "medium" is.
import { COMPLEXITY_CONTRACT } from "../../categorizer/guidance.js";

/**
 * The default planning prompt. Exported so a host can compose with it
 * (`systemPrompt: DEFAULT_PLAN_SYSTEM_PROMPT + "\n" + houseRules`) instead of
 * rewriting the JSON contract from scratch — get that contract wrong and the
 * plan silently fails to parse.
 */
export const DEFAULT_PLAN_SYSTEM_PROMPT = `You are a senior engineer breaking a task into an ordered implementation plan that ANOTHER agent will execute step by step. You are the task breaker for this run: what you emit is what gets built, in the order you put it.

Rules:
- Decompose by FILE-LEVEL UNITS OF WORK. Each task should be independently executable and verifiable.
- Order tasks by real dependency: a task must not depend on work a later task does.
- Every task names the exact files it touches and whether each is an "edit" (file exists) or a "write" (new file).
- Rate each task's complexity on the scale below. It is not a label: the executing agent inherits your rating per file, and it decides which model authors those bytes.
- State how each task is verified. "It compiles" is not verification.
- Call out real risks. Do not pad with generic caution.
- Prefer FEWER, MEANINGFUL tasks over many trivial ones. Do not split a two-line change into three steps.

COVER THE WHOLE JOB, END TO END. The executing agent does exactly what your steps say and nothing more, so a plan that stops at "implement the feature" ships a feature nobody wired up. Include, when the task actually needs them: dependencies to install or config to add; the implementation itself; the wiring that makes it reachable (routes, exports, registration, entry points); data/schema/migration changes; tests; and the concrete verification run at the end. Never write a step that defers work vaguely ("finish the remaining pieces", "polish", "handle edge cases") — name the pieces or leave them out.

THIS PLAN IS REVIEWED BEFORE ANY OF IT RUNS. The user sees it, and either approves it or sends it back with comments — so write for a reader deciding whether to let this happen, not for a machine: titles that say what changes, summaries in their terms. They can also attach a file or a note to ONE step, which reaches that step alone when it runs. Two consequences for you: put a real architecture fork in the plan as the shape you chose and why, rather than burying it (they can redirect you here, cheaply, before any code exists); and keep steps individually meaningful, because a step is the unit they comment on.

USER ATTACHMENTS. When the run has attached files, they are listed for you under ATTACHMENTS. Route each one to the step that needs it by putting it in that task's "attachments": [{"path":"<the path exactly as listed>","note":"why this step needs it"}]. A mockup of the hero section belongs on the hero step, not on every step. Reference an attachment's content in the task summary too, so the executing agent knows what it is looking at.

If an attachment is a design, screenshot, recording or spec and the CONTEXT you were given does not already describe its contents, say so in the plan rather than guessing at it: a decomposition invented from a filename is worse than one that admits it needs a look first. The caller is expected to analyse attachments (media_analysis) BEFORE planning, because what the design contains is what the steps ARE — which sections exist, which components repeat, which states must be built, what the shared tokens are — and because you cannot route a file to the right step until you know what it shows.

MARKETING / PRODUCT / HERO SITES WITH ANIMATION. For a landing or product page, decompose by SECTION (hero, feature grid, social proof, pricing, footer) rather than by technology layer, because a section is what a person reviews and what a mockup shows. For anything animated, the plan must be specific enough to build from — per animated element, say WHAT moves, its trigger (page load, scroll position, hover, in-view), rough duration and easing, and whether it is CSS/keyframes or a JS library (name the library, and add installing it as its own step). Include as real steps, not afterthoughts: the design tokens/theme the sections share (set these up FIRST so sections do not each invent their own); responsive behaviour at mobile/tablet/desktop; a \`prefers-reduced-motion\` path for every animation; image/font/asset handling and their loading strategy; and a performance/verification step (no layout shift, animations run at 60fps, above-the-fold content is not gated on JS). If an asset the design needs does not exist, say so in that step's risks rather than assuming it will appear.

${COMPLEXITY_CONTRACT}

Do NOT author "isCompleted" — the harness owns it and flips it to true as each step finishes.

Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:

PLANS_JSON:
{"plans":[{"id":"plan-1","title":"...","summary":"...","tasks":[{"id":"t1","order":1,"title":"...","summary":"...","files":["src/a.ts"],"fileMutations":{"src/a.ts":"edit"},"complexity":"medium","verification":"...","risks":"...","attachments":[{"path":"/abs/path/hero.png","note":"the hero this step builds"}]}]}],"executionOrder":["plan-1"]}`;

/** Instruction block appended when the user sent the plan back for a redo. */
function revisionInstructions(comments: string): string {
  return [
    "",
    "THIS IS A RE-PLAN. The user reviewed your previous plan and asked for these changes:",
    "---",
    comments,
    "---",
    "Apply the user's feedback directly. Their instructions override your earlier judgement.",
    "Do not defend the previous plan and do not explain the changes — return the corrected PLANS_JSON only.",
  ].join("\n");
}

/**
 * Default model for the planning call — the plan's "authoring model".
 *
 * Same principle as write/edit authoring: the model that PRODUCES the artifact is
 * chosen for that job, not inherited from whatever happens to be driving the loop.
 * Planning earns it more than most calls, because a bad decomposition is inherited
 * by every step after it and no later model gets to disagree with it.
 *
 * Named rather than inlined so the host has one symbol to point at when it swaps
 * the planner, and so a run that never configured `plan.model` still plans on a
 * model picked for planning instead of on the cheap driver tier.
 */
export const DEFAULT_PLAN_MODEL = "tencent/hy3";

export interface PlanToolConfig {
  /**
   * The planning system prompt. Defaults to {@link DEFAULT_PLAN_SYSTEM_PROMPT}.
   * Change this to change how planning behaves — it is the whole point of the
   * tool being configurable.
   */
  systemPrompt?: string;
  /**
   * Model slug for the planning call — the way to run planning on a STRONGER
   * model than the loop itself. Planning is the highest-leverage reasoning in a
   * run (a bad decomposition costs every step after it), so pinning a capable
   * model here is usually worth it even when the loop is driven by a cheap one.
   *
   * Resolution order: this slug → the model the permission gate selected for this
   * call (the tool's `complexityHint: 0.8` already biases that upward when the
   * host wired `toolModelCandidates`) → the loop's current model.
   */
  model?: string;
  /**
   * How many times the user may send a plan back before the tool stops. Guards
   * against an unbounded review loop; the last draft is returned with a note
   * when the budget runs out. Default 3.
   */
  maxRevisions?: number;
}

export interface CreatePlanDetails {
  /** Discriminator so the loop can recognize a plan result. */
  kind: "plan_set";
  planSet: PlanSet;
  /** How many drafts it took (1 = approved first time). */
  revisions: number;
  /** Whether a host actually approved it, vs. auto-approved with no callback. */
  approved: boolean;
  /** True when the revision budget ran out before approval. */
  revisionBudgetExhausted?: boolean;
}

export function createPlanTool(config: PlanToolConfig = {}): AgentTool<any, CreatePlanDetails> {
  const maxRevisions = Math.max(0, config.maxRevisions ?? 3);

  return {
    name: "create_plan",
    description:
      "Break the task into an ordered, multi-file implementation plan and submit it to the user for review. " +
      "Returns the approved plan. Call this ONCE, before doing any implementation work, for any task that " +
      "spans more than one file or more than one step.",
    mutates: false,
    categorizers: ["write_edit"],
    // Planning is the highest-leverage reasoning in a run; bias model selection up.
    complexityHint: 0.8,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to plan, stated in full. Do not abbreviate the user's request.",
        },
        context: {
          type: "string",
          description:
            "What you already know that should shape the plan: relevant files, constraints, findings from earlier reads.",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths of files the plan should account for (mockups, specs, data samples). Files the USER attached to " +
            "this run are included automatically — only pass this to add ones the run does not already carry.",
        },
      },
      required: ["task"],
    },

    async execute(_id, args, ctx) {
      if (!ctx.llm) {
        return {
          output: "create_plan requires an LLM bridge in the tool context.",
          isError: true,
          details: emptyDetails(),
        };
      }
      const task = String(args.task ?? "").trim();
      if (!task) {
        return {
          output: "create_plan: missing required argument 'task'. State what to plan and retry.",
          isError: true,
          details: emptyDetails(),
        };
      }
      const context = args.context ? String(args.context) : undefined;
      // Everything the user attached to this run, plus anything the caller named
      // explicitly. The planner cannot route a mockup to the step that needs it
      // if it never learns the mockup exists.
      const attachments = await collectRunAttachments(args.attachments, ctx);

      let comments: string | undefined;
      let usage: Usage | undefined;
      let planSet: PlanSet | undefined;
      let revision = 0;

      // Draft → review → (re-draft). The +1 is the initial draft; `maxRevisions`
      // counts how many times the user may send it BACK.
      for (let attempt = 0; attempt <= maxRevisions; attempt++) {
        revision = attempt + 1;
        const drafted = await draftPlan({ ctx, config, task, context, comments, attachments });
        usage = mergeUsage(usage, drafted.usage);

        if (!drafted.planSet) {
          // A draft that won't parse is a hard stop, not something to retry
          // blindly — retrying the same prompt usually reproduces it, and the
          // model needs to see the failure to correct course.
          return {
            output:
              `create_plan: the planning model did not return parseable PLANS_JSON (draft ${revision}). ` +
              `Raw output:\n${drafted.raw.slice(0, 600)}`,
            isError: true,
            details: emptyDetails(),
            ...(usage ? { usage } : {}),
          };
        }
        planSet = drafted.planSet;

        // No host reviewer ⇒ auto-approve. A library/headless run must not hang
        // waiting for an approval that can never arrive.
        if (!ctx.planApproval) {
          return finish({ planSet, revision, approved: false, usage });
        }

        const request: PlanApprovalRequest = {
          planSet,
          revision,
          task,
          revisionsRemaining: maxRevisions - attempt,
          ...(comments ? { priorComments: comments } : {}),
        };
        ctx.log({
          timestamp: Date.now(),
          level: "info",
          tags: ["tool:create_plan", "plan:review"],
          message: `plan draft ${revision} submitted for review (${countTasks(planSet)} step(s))`,
        });

        const decision: PlanApprovalDecision = await ctx.planApproval(request);

        // Step edits apply on BOTH paths: approving a plan while attaching a
        // mockup to step 3 is the common case, and must not cost a re-plan.
        if (decision.stepEdits?.length) {
          planSet = await applyStepEdits(planSet, decision.stepEdits, ctx);
        }

        if (decision.cancelled) {
          return {
            output: "create_plan: the user cancelled plan review. No plan was produced; do not start implementing.",
            isError: true,
            details: { ...emptyDetails(), planSet, revisions: revision },
            ...(usage ? { usage } : {}),
          };
        }
        if (decision.approved) {
          ctx.log({
            timestamp: Date.now(),
            level: "info",
            tags: ["tool:create_plan", "plan:approved"],
            message: `plan approved at draft ${revision}`,
          });
          return finish({ planSet, revision, approved: true, usage });
        }

        comments = decision.comments?.trim() || "The user rejected the plan without specifying why. Reconsider the decomposition from scratch.";
      }

      // Budget exhausted: return the last draft, clearly labelled. Losing the
      // work would be worse than handing back an unapproved plan the caller can
      // still see and judge.
      return finish({
        planSet: planSet!,
        revision,
        approved: false,
        usage,
        revisionBudgetExhausted: true,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function emptyDetails(): CreatePlanDetails {
  return { kind: "plan_set", planSet: { plans: [], executionOrder: [] }, revisions: 0, approved: false };
}

function countTasks(planSet: PlanSet): number {
  return planSet.plans.reduce((n, p) => n + p.tasks.length, 0);
}

function finish(input: {
  planSet: PlanSet;
  revision: number;
  approved: boolean;
  usage?: Usage;
  revisionBudgetExhausted?: boolean;
}): { output: string; details: CreatePlanDetails; usage?: Usage } {
  const details: CreatePlanDetails = {
    kind: "plan_set",
    planSet: input.planSet,
    revisions: input.revision,
    approved: input.approved,
    ...(input.revisionBudgetExhausted ? { revisionBudgetExhausted: true } : {}),
  };
  return {
    output: renderPlan(input.planSet, input.revisionBudgetExhausted),
    details,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

/** The LLM-facing rendering: the plan as an ordered checklist the model executes. */
function renderPlan(planSet: PlanSet, budgetExhausted?: boolean): string {
  const lines: string[] = [];
  if (budgetExhausted) {
    lines.push(
      "NOTE: the plan review budget ran out before the user approved this plan. It is the last draft — proceed with care.",
      "",
    );
  }
  lines.push("APPROVED PLAN — execute these steps in order:");
  const order = planSet.executionOrder.length ? planSet.executionOrder : planSet.plans.map((p) => p.id);
  for (const planId of order) {
    const doc = planSet.plans.find((p) => p.id === planId);
    if (!doc) continue;
    if (planSet.plans.length > 1) lines.push(`\n## ${doc.title}`);
    for (const t of [...doc.tasks].sort((a, b) => a.order - b.order)) {
      // The checkbox reflects `isCompleted`, which the harness flips as each step
      // finishes — so a plan re-rendered mid-run shows what is actually left.
      lines.push(`\n${t.order}. [${t.isCompleted ? "x" : " "}] [${t.id}] ${t.title} (${t.complexity})`);
      lines.push(`   ${t.summary}`);
      if (t.files.length) lines.push(`   files: ${t.files.map((f) => `${f} (${t.fileMutations[f] ?? "edit"})`).join(", ")}`);
      if (t.verification) lines.push(`   verify: ${t.verification}`);
      if (t.risks) lines.push(`   risks: ${t.risks}`);
      // User additions are stated last and marked, so they read as the final word.
      if (t.userNotes) lines.push(`   USER INSTRUCTIONS FOR THIS STEP: ${t.userNotes}`);
      if (t.attachments?.length) {
        lines.push(
          `   USER ATTACHED: ${t.attachments.map((a) => `${a.path}${a.note ? ` — ${a.note}` : ""}`).join(", ")}`,
        );
      }
    }
  }
  return lines.join("\n");
}

async function draftPlan(input: {
  ctx: ToolContext;
  config: PlanToolConfig;
  task: string;
  context?: string;
  comments?: string;
  attachments?: PlanAttachment[];
}): Promise<{ planSet?: PlanSet; raw: string; usage?: Usage }> {
  const { ctx, config } = input;
  const systemPrompt =
    (config.systemPrompt ?? DEFAULT_PLAN_SYSTEM_PROMPT) +
    (input.comments ? revisionInstructions(input.comments) : "");

  const parts = [`TASK:\n${input.task}`];
  if (input.context) parts.push(`CONTEXT:\n${input.context}`);
  if (input.attachments?.length) {
    parts.push(
      "ATTACHMENTS (files the user attached to this run — route each to the step that needs it, using the path " +
        "exactly as written here):\n" +
        input.attachments
          .map((a) => `- ${a.path} (${a.mimeType})${a.note ? ` — ${a.note}` : ""}`)
          .join("\n"),
    );
  }
  parts.push("Return the PLANS_JSON object now.");

  // Host config wins; otherwise the dedicated planner, NOT the driver model.
  // Falling through to `ctx.model` here meant an unconfigured host planned on the
  // loop's cheap tier — the one call where that is least affordable.
  const slug = config.model ?? DEFAULT_PLAN_MODEL;
  const model = slug ? ctx.llm!.resolveModel(slug) : ctx.model!;
  const llmContext: Context = {
    systemPrompt,
    messages: [{ role: "user", content: parts.join("\n\n"), timestamp: Date.now() }],
  };
  const msg = await ctx.llm!.complete(model, llmContext, { temperature: 0, signal: ctx.signal });
  const raw = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const parsed = parsePlanOutput(raw);
  // Normalize before anyone sees it: `isCompleted` must exist on every task from
  // the start (a client rendering checkboxes cannot distinguish "not done" from
  // "field missing"), and attachment paths the model named have to be resolved
  // and verified now rather than failing mid-execution.
  const planSet = parsed?.plans.length ? await normalizePlan(parsed, input.attachments, input.ctx) : undefined;
  return {
    ...(planSet ? { planSet } : {}),
    raw,
    ...(msg.usage ? { usage: msg.usage } : {}),
  };
}

/**
 * Files the user attached to this run, as plan attachments. `ctx.images` is the
 * channel the loop already forwards run-level attachments through; an explicit
 * `attachments` arg adds to it. Unreadable paths are dropped with a warning here,
 * at plan time, where the user is still looking at the plan.
 */
async function collectRunAttachments(
  argPaths: unknown,
  ctx: ToolContext,
): Promise<PlanAttachment[]> {
  const fromArgs = (Array.isArray(argPaths) ? argPaths : [])
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => ({ path: p.trim(), mimeType: "" }));
  const fromRun = (ctx.images ?? []).map((img) => ({ path: img.path, mimeType: img.mimeType }));

  const seen = new Set<string>();
  const merged: PlanAttachment[] = [];
  for (const att of [...fromRun, ...fromArgs]) {
    const key = path.isAbsolute(att.path) ? att.path : path.join(ctx.cwd, att.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(att);
  }
  return resolveAttachments(merged, ctx);
}

/**
 * Stamp `isCompleted: false` on every task and resolve any attachments the model
 * routed to a step.
 *
 * The model is told not to author `isCompleted`, and it must not: the harness
 * flips it to `true` in place on this same PlanSet as each step's work loop ends
 * (see `Orchestrator.run`). Initializing it here means the field is always
 * present and always starts false, whatever the model did or didn't emit.
 */
async function normalizePlan(
  planSet: PlanSet,
  runAttachments: PlanAttachment[] | undefined,
  ctx: ToolContext,
): Promise<PlanSet> {
  const known = new Map((runAttachments ?? []).map((a) => [path.basename(a.path), a] as const));
  const plans = await Promise.all(
    planSet.plans.map(async (doc) => ({
      ...doc,
      tasks: await Promise.all(
        doc.tasks.map(async (t): Promise<PlanTask> => {
          const routed = await resolveAttachments(
            // A model that retyped a path slightly still gets its intent honoured
            // when the basename matches an attachment the run actually has.
            (t.attachments ?? []).map((a) => {
              const match = known.get(path.basename(a.path));
              return match ? { ...a, path: match.path, mimeType: a.mimeType || match.mimeType } : a;
            }),
            ctx,
          );
          // The model's raw `attachments` must be DROPPED, not merged: `routed` is
          // that same list after resolution, so spreading `...t` would keep any
          // entry resolution rejected (an invented path) alongside the good ones.
          const { attachments: _unresolved, ...rest } = t;
          return {
            ...rest,
            // Always false at creation. The extractor already refuses to read this
            // field from the model's JSON; stamping it here makes the guarantee
            // local and total — the field always exists, always starts false, and
            // only `Orchestrator.run` ever sets it true.
            isCompleted: false,
            ...(routed.length ? { attachments: routed } : {}),
          };
        }),
      ),
    })),
  );
  return { ...planSet, plans };
}

/**
 * Parse a planning reply into a {@link PlanSet}, tolerantly.
 *
 * The shared extractor keys on a `PLANS_JSON:` marker, but the prompt also tells
 * the model to emit strict JSON with no prose — and a model that obeys that
 * literally returns a bare object with no marker. Requiring the marker would
 * fail exactly the outputs that followed instructions best, so a bare
 * `{"plans":[...]}` is accepted by synthesizing the marker and re-parsing.
 */
export function parsePlanOutput(raw: string): PlanSet | undefined {
  const marked = extractPlanSet(raw);
  if (marked) return marked;

  const legacy = normalizeLegacyPlanJson(extractPlanJson(raw));
  if (legacy) return legacy;

  // Bare object: find the first `{` that starts an object containing "plans".
  const start = raw.indexOf("{");
  if (start === -1) return undefined;
  const candidate = raw.slice(start);
  if (!/"plans"\s*:/.test(candidate)) return undefined;
  return extractPlanSet(`PLANS_JSON:\n${candidate}`);
}

/**
 * Fold the user's per-step notes/attachments into the plan.
 *
 * Attachment paths are resolved against cwd and verified to exist here, at
 * review time — a path that only fails later, mid-execution, surfaces as a
 * confusing tool error several minutes after the user attached it.
 */
async function applyStepEdits(
  planSet: PlanSet,
  edits: PlanStepEdit[],
  ctx: ToolContext,
): Promise<PlanSet> {
  const byId = new Map(edits.map((e) => [e.taskId, e] as const));
  const plans = await Promise.all(
    planSet.plans.map(async (doc) => ({
      ...doc,
      tasks: await Promise.all(
        doc.tasks.map(async (t): Promise<PlanTask> => {
          const edit = byId.get(t.id);
          if (!edit) return t;
          const attachments = await resolveAttachments(edit.attachments, ctx);
          return {
            ...t,
            ...(edit.notes?.trim()
              ? { userNotes: t.userNotes ? `${t.userNotes}\n${edit.notes.trim()}` : edit.notes.trim() }
              : {}),
            ...(attachments.length
              ? { attachments: [...(t.attachments ?? []), ...attachments] }
              : {}),
          };
        }),
      ),
    })),
  );

  const unmatched = edits.filter((e) => !plans.some((p) => p.tasks.some((t) => t.id === e.taskId)));
  for (const miss of unmatched) {
    // Silently dropping a user's attachment is the worst outcome here, so it is
    // logged loudly even though it cannot be applied.
    ctx.log({
      timestamp: Date.now(),
      level: "warn",
      tags: ["tool:create_plan", "plan:step-edit"],
      message: `step edit references unknown task "${miss.taskId}"; its notes/attachments were NOT applied`,
    });
  }

  return { ...planSet, plans };
}

async function resolveAttachments(
  attachments: PlanAttachment[] | undefined,
  ctx: ToolContext,
): Promise<PlanAttachment[]> {
  if (!attachments?.length) return [];
  const out: PlanAttachment[] = [];
  for (const att of attachments) {
    const abs = path.isAbsolute(att.path) ? att.path : path.join(ctx.cwd, att.path);
    try {
      await fs.access(abs);
      // Fill in a missing `mimeType` rather than trusting the caller for it.
      // It is typed as required, but this value crosses a HOST boundary — a UI
      // dropping a file onto a step, or JSON off the wire — where the type
      // cannot enforce anything. Everything downstream routes on it (an image
      // becomes vision input; anything else is listed as a file to read), and
      // an absent one used to take the whole run down at step time, minutes
      // after the user attached it. Deriving it here is both the earliest and
      // the only place that knows the path is real.
      out.push({ ...att, path: abs, mimeType: att.mimeType || guessMimeType(abs) });
    } catch (err) {
      ctx.log({
        timestamp: Date.now(),
        level: "warn",
        tags: ["tool:create_plan", "plan:step-edit"],
        message: `attached file is unreadable and was dropped: ${abs} (${(err as Error).message})`,
      });
    }
  }
  return out;
}

function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
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
