/**
 * Plan extraction (shared by the loop driver and tests).
 *
 * Parses the model's `PLANS_JSON:` / `PLAN_JSON:` output into a normalized
 * {@link PlanSet} of {@link PlanDocument}s and {@link PlanTask}s, preserving
 * each task's `complexity` rating. Extracted from phase-runner so the new flat
 * loop (and its tests) can depend on it without pulling in phase machinery.
 *
 * The marker/JSON helpers here are private copies kept self-contained; the
 * phase-runner retains its own copies for its remaining phase extraction.
 */
import type {
  ComplexityRating,
  PlanAttachment,
  PlanDocument,
  PlanFileMutationMode,
  PlanSet,
  PlanTask,
} from "../types.js";
import { parseJsonArrayLoose, parseJsonObjectLoose } from "../robust-json.js";

/** Parse the "PLANS_JSON:" object into a normalized {@link PlanSet}. */
export function extractPlanSet(text: string): PlanSet | undefined {
  const body = extractSection(text, "PLANS_JSON");
  if (!body) return undefined;
  const parsed = parseFirstJsonObject(body);
  if (!parsed || typeof parsed !== "object") return undefined;
  const rawPlans = (parsed as { plans?: unknown }).plans;
  if (!Array.isArray(rawPlans) || !rawPlans.length) return undefined;
  const plans: PlanDocument[] = [];
  for (const raw of rawPlans) {
    const doc = normalizePlanDocument(raw);
    if (doc) plans.push(doc);
  }
  if (!plans.length) return undefined;
  const declaredOrder = (parsed as { executionOrder?: unknown }).executionOrder;
  const validIds = new Set(plans.map((plan) => plan.id));
  const executionOrder = Array.isArray(declaredOrder)
    ? declaredOrder.filter((id): id is string => typeof id === "string" && validIds.has(id))
    : [];
  for (const plan of plans) if (!executionOrder.includes(plan.id)) executionOrder.push(plan.id);
  return { plans, executionOrder };
}

/** Turn a legacy PLAN_JSON step array into a single-plan {@link PlanSet}. */
export function normalizeLegacyPlanJson(planJson: unknown[] | undefined): PlanSet | undefined {
  if (!planJson?.length) return undefined;
  const tasks = planJson.map((entry, index) => normalizePlanTask(entry, index)).filter((t): t is PlanTask => Boolean(t));
  if (!tasks.length) return undefined;
  const plan: PlanDocument = { id: "plan-1", title: "Implementation plan", summary: "", tasks };
  return { plans: [plan], executionOrder: [plan.id] };
}

export function normalizePlanDocument(raw: unknown): PlanDocument | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : undefined;
  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  const tasks = rawTasks.map((task, index) => normalizePlanTask(task, index)).filter((t): t is PlanTask => Boolean(t));
  if (!id || !tasks.length) return undefined;
  return {
    id,
    title: typeof obj.title === "string" ? obj.title : id,
    ...(typeof obj.repo === "string" && obj.repo.trim() ? { repo: obj.repo.trim() } : {}),
    summary: typeof obj.summary === "string" ? obj.summary : "",
    tasks,
  };
}

export function normalizePlanTask(raw: unknown, index: number): PlanTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const files = Array.isArray(obj.files)
    ? obj.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : [];
  const fileMutations: Record<string, PlanFileMutationMode> = {};
  if (obj.fileMutations && typeof obj.fileMutations === "object") {
    for (const [file, mode] of Object.entries(obj.fileMutations as Record<string, unknown>)) {
      if (mode === "edit" || mode === "write") fileMutations[file.trim()] = mode;
    }
  }
  const complexityRaw = typeof obj.complexity === "string" ? obj.complexity.toLowerCase() : undefined;
  const complexity: ComplexityRating =
    complexityRaw === "low" || complexityRaw === "medium" || complexityRaw === "high" ? complexityRaw : "medium";
  const orderRaw = typeof obj.order === "number" && Number.isFinite(obj.order) ? obj.order : index + 1;
  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `task-${index + 1}`,
    order: orderRaw,
    title: typeof obj.title === "string" ? obj.title : `Step ${index + 1}`,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    files,
    fileMutations,
    complexity,
    ...(Array.isArray(obj.tools)
      ? { tools: obj.tools.filter((t): t is string => typeof t === "string" && t.trim().length > 0) }
      : {}),
    ...(typeof obj.verification === "string" ? { verification: obj.verification } : {}),
    ...(typeof obj.risks === "string" ? { risks: obj.risks } : {}),
    // Attachments the planner ROUTED to this step (the run's own attached files,
    // assigned to the task that needs them). Preserved because the plan tool asks
    // the model for exactly this; paths are resolved and existence-checked by the
    // tool afterwards, so an invented path is dropped there rather than here.
    ...(normalizeTaskAttachments(obj.attachments) ?? {}),
  };
  // `isCompleted` is deliberately NOT read from the model's JSON: the harness owns
  // that field and flips it as each step's work loop finishes. A plan may not
  // arrive with work pre-declared done.
}

/**
 * Validate the `attachments` array on a planned task. Anything without a usable
 * `path` is dropped rather than carried as a malformed entry — a bad attachment
 * that survives to execution surfaces as a confusing tool error minutes later.
 */
function normalizeTaskAttachments(raw: unknown): { attachments: PlanAttachment[] } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attachments: PlanAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path) continue;
    attachments.push({
      path,
      mimeType: typeof obj.mimeType === "string" ? obj.mimeType : "",
      ...(typeof obj.note === "string" && obj.note.trim() ? { note: obj.note.trim() } : {}),
    });
  }
  return attachments.length ? { attachments } : undefined;
}

/** Parse the "PLAN_JSON:" array (legacy single-plan form). */
export function extractPlanJson(text: string): unknown[] | undefined {
  const body = extractSection(text, "PLAN_JSON");
  if (!body) return undefined;
  for (const candidate of normalizePlanJsonCandidates(body)) {
    const parsed = parseJsonArrayLoose(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

/** A `MARKER:` block up to the next ALL-CAPS section header (or end of text). */
export function extractSection(text: string, marker: string): string | undefined {
  const block = findMarkerBlock(text, marker);
  if (!block) return undefined;
  const body = block.bodyLines.join("\n").trim();
  return body || undefined;
}

/**
 * The first JSON object in a text blob, however the model wrapped it.
 *
 * Was a local balanced-brace scanner plus two `JSON.parse` attempts; now the
 * shared parser, which additionally survives a fence, a trailing remark, a
 * trailing comma, and a plan that was cut off mid-task.
 */
export function parseFirstJsonObject(body: string): unknown {
  for (const candidate of normalizePlanJsonCandidates(body)) {
    const parsed = parseJsonObjectLoose(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function findMarkerBlock(text: string, marker: string): { bodyLines: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  const matches: Array<{ index: number; inline: string | undefined }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = matchMarkerHeader(lines[index] ?? "", marker);
    if (match !== undefined) {
      matches.push({ index, inline: match });
    }
  }
  const target = matches.at(-1);
  if (!target) return undefined;
  const bodyLines: string[] = [];
  if (target.inline) {
    bodyLines.push(target.inline);
  }
  let started = Boolean(target.inline);
  for (let index = target.index + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isStructuredSectionHeader(line)) break;
    if (!started && !line.trim()) continue;
    started = true;
    bodyLines.push(line);
  }
  return bodyLines.length ? { bodyLines } : undefined;
}

function matchMarkerHeader(line: string, marker: string): string | undefined {
  const stripped = line.trim().replace(/\*/g, "").trim();
  if (!stripped) return undefined;
  if (stripped === marker || stripped === `${marker}:`) return "";
  if (stripped.startsWith(`${marker}:`)) return stripped.slice(marker.length + 1).trim();
  if (stripped.startsWith(`${marker} `)) return stripped.slice(marker.length + 1).trim();
  return undefined;
}

function isStructuredSectionHeader(line: string): boolean {
  const stripped = line.trim().replace(/\*/g, "").trim();
  if (!stripped) return false;
  return /^[A-Z][A-Z _]{2,}(?::.*)?$/.test(stripped);
}

function normalizePlanJsonCandidates(body: string): string[] {
  const out = new Set<string>();
  const trimmed = body.trim();
  if (trimmed) out.add(trimmed);
  const withoutMarkdown = trimmed
    .replace(/^\*\*+\s*/g, "")
    .replace(/\s*\*\*+$/g, "")
    .trim();
  if (withoutMarkdown) out.add(withoutMarkdown);
  const fenced = withoutMarkdown.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) out.add(fenced);
  const arraySlice = extractFirstJsonArray(withoutMarkdown);
  if (arraySlice) out.add(arraySlice);
  const fencedArraySlice = fenced ? extractFirstJsonArray(fenced) : undefined;
  if (fencedArraySlice) out.add(fencedArraySlice);
  return [...out];
}


function extractFirstJsonArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }
  return undefined;
}
