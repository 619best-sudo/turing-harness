/**
 * The injected terminal `deliver` tool.
 *
 * Every categorizer has ONE expectation. `deliver` is how it states the
 * expectation is met: one structured call whose schema comes from the
 * categorizer's `returns` spec. The tool is marked `terminal`, so the loop ends
 * once it executes — completion is a deterministic signal, not an inference from
 * "the model stopped calling tools". Its `execute` captures the arguments into
 * the hop's box; the chain reads the box after the loop ends.
 */
import type { AgentTool } from "../types.js";
import type { CategorizerDeliverable, CategorizerDefinition } from "./types.js";
import { DEFAULT_DELIVER_SCHEMAS } from "./prompts.js";

export const DELIVER_TOOL_NAME = "deliver";

/**
 * The box the deliverable lands in. Created per hop; the chain reads it after
 * the loop ends (terminal tools end the loop, so ordering is guaranteed).
 */
export interface DeliverBox {
  deliverable?: CategorizerDeliverable;
  delivered: boolean;
}

/** Field names the chain reads for routing and strips from the deliverable. */
export const NEXT_CATEGORIZERS_FIELD = "nextCategorizers";
export const HANDOFF_REASON_FIELD = "handoffReason";

/**
 * Resolve the deliver schema: explicit override → built-in per kind → minimal,
 * plus the handoff tail every categorizer with children gets.
 *
 * The tail is added HERE rather than in each schema so it cannot drift: it is a
 * property of the chain (a hop hands off), not of any one return kind, and a
 * host shipping a custom `deliverSchema` gets it without knowing it exists.
 * `enum` is the categorizer's own `children` plus `summarise`, so the driver
 * cannot nominate a category the graph does not allow after it — an id outside
 * the enum is rejected by the loop's own argument validation before the chain
 * ever sees it.
 */
export function deliverSchemaFor(def: CategorizerDefinition) {
  const base =
    def.returns.deliverSchema ??
    DEFAULT_DELIVER_SCHEMAS[def.returns.kind] ?? {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
  // Optional-chained: a caller may hand in a partial definition (the schema is
  // public API), and a categorizer with no children hands off to nothing.
  if (!def.children?.length) return base;
  const properties = (base as { properties?: Record<string, unknown> }).properties ?? {};
  return {
    ...base,
    properties: {
      ...properties,
      [NEXT_CATEGORIZERS_FIELD]: {
        type: "array",
        description:
          "REQUIRED. What must happen next, in order, chosen from: " +
          `${def.children.join(", ")}, summarise. You have just done the work and know things a ` +
          "one-line summary of it cannot carry — say where it goes. List SEVERAL when several are " +
          "needed (a reported bug is usually reproduce-then-fix: activity_inspect, then write_edit). " +
          'Use ["summarise"] only when the run is genuinely COMPLETE — the user asked to understand ' +
          "something and now they can, or nothing needs changing. Describing a defect is not fixing it.",
        items: { type: "string", enum: [...def.children, "summarise"] },
      },
      [HANDOFF_REASON_FIELD]: {
        type: "string",
        description: "One sentence: why that is what comes next. Shown in the run log.",
      },
    },
  };
}

/**
 * Split a captured `deliver` payload into the deliverable and the routing
 * fields.
 *
 * Stripped rather than left in place: the deliverable is rendered verbatim into
 * the NEXT categorizer's opening, and a routing instruction addressed to the
 * chain reads there as an instruction addressed to that categorizer.
 */
export function takeHandoff(
  def: CategorizerDefinition,
  deliverable: CategorizerDeliverable | undefined,
): {
  deliverable: CategorizerDeliverable | undefined;
  nominations: string[];
  reason?: string;
} {
  if (!deliverable || typeof deliverable !== "object") return { deliverable, nominations: [] };
  const record = { ...(deliverable as Record<string, unknown>) };
  const rawNext = record[NEXT_CATEGORIZERS_FIELD];
  const rawReason = record[HANDOFF_REASON_FIELD];
  delete record[NEXT_CATEGORIZERS_FIELD];
  delete record[HANDOFF_REASON_FIELD];
  // A small model may answer with a bare string where an array was asked for.
  const list = Array.isArray(rawNext) ? rawNext : typeof rawNext === "string" ? rawNext.split(/[,\s]+/) : [];
  const allowed = new Set([...(def.children ?? []), "summarise"]);
  const nominations: string[] = [];
  for (const entry of list) {
    const id = String(entry ?? "").trim();
    if (!allowed.has(id) || nominations.includes(id)) continue;
    nominations.push(id);
    // Everything after a "summarise" is unreachable by definition.
    if (id === "summarise") break;
  }
  return {
    deliverable: record as CategorizerDeliverable,
    nominations,
    ...(typeof rawReason === "string" && rawReason.trim() ? { reason: rawReason.trim() } : {}),
  };
}

/**
 * Build the `deliver` tool for one categorizer hop. The result output confirms
 * to the model that the categorizer is complete — it is the LAST tool result it
 * sees.
 */
export function createDeliverTool(def: CategorizerDefinition, box: DeliverBox): AgentTool {
  return {
    name: DELIVER_TOOL_NAME,
    title: "Finish and hand off the result",
    description:
      `Deliver the ${def.name} categorizer's result and END it. This is the ONLY way to finish: ` +
      `call it once, with the result, when (and only when) the expectation is met. ` +
      def.returns.description,
    parameters: deliverSchemaFor(def),
    mutates: false,
    terminal: true,
    async execute(toolCallId: string, args: Record<string, unknown>) {
      // Capture happens HERE: the loop has already validated/coerced the args
      // against the schema above, so what lands in the box is exactly what the
      // contract produced. The `terminal` flag is what stops the loop.
      captureDeliverable(box, args);
      return {
        output:
          `Delivered. The ${def.name} categorizer is complete — stop calling tools; ` +
          `the chain takes it from here.`,
        // Scope marker for hosts: this card is ONE STEP's handoff, never the
        // run's closing word. Even when it is the last call of the run, its
        // body describes only this categorizer — the run's summary arrives as
        // the `run_summary` event, composed from every hop.
        details: { scope: "hop", categorizer: def.id },
      };
    },
  };
}

/**
 * Fold a terminal `deliver` call into its box. Invoked by the tool loop right
 * after a successful `deliver` execution, so coercion/normalization has already
 * happened and the recorded arguments are exactly what the schema produced.
 */
export function captureDeliverable(box: DeliverBox, args: Record<string, unknown>): void {
  if (box.delivered) return; // first call wins; a repeat is the model re-stating
  box.deliverable = args as CategorizerDeliverable;
  box.delivered = true;
}

/**
 * Derive a fallback deliverable when a categorizer's loop ended WITHOUT calling
 * `deliver` (small models sometimes just stop). Grounded in what the loop
 * actually tracked, never invented:
 *   - write_edit   → write-report from the loop's `writtenPaths`
 *   - read         → code-summary from `readPaths` + the final text
 *   - anything else→ summary from the final text
 */
export function deriveFallbackDeliverable(
  def: CategorizerDefinition,
  loop: { writtenPaths: string[]; readPaths: string[]; finalText: string },
): CategorizerDeliverable {
  const text = loop.finalText.trim();
  switch (def.returns.kind) {
    case "write-report":
      return {
        writes: loop.writtenPaths.map((path) => ({ tool: "write", path })),
        notes: text
          ? `(derived from the loop's closing report — deliver was not called)\n${text}`
          : "(deliver was not called; paths from loop tracking)",
      };
    case "code-summary":
      return {
        files: loop.readPaths.map((path) => ({ path })),
        codeSummary: text || "(deliver was not called; file list from loop tracking)",
      };
    case "repro-report":
      // `reproduced: false` is the only honest default for a hop that stopped
      // without saying. Defaulting to true would hand the fixer a confirmed
      // symptom that nobody confirmed.
      return {
        reproduced: false,
        symptom: text
          ? `(derived from the loop's closing report — deliver was not called)\n${text}`
          : "(deliver was not called; the hop ended without reporting what it saw)",
        logPaths: [],
        suspects: loop.readPaths.map((path) => ({ path })),
      };
    default:
      return { summary: text || "(no deliverable produced)" };
  }
}
