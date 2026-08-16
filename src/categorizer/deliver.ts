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

/** Resolve the deliver schema: explicit override → built-in per kind → minimal. */
export function deliverSchemaFor(def: CategorizerDefinition) {
  return (
    def.returns.deliverSchema ??
    DEFAULT_DELIVER_SCHEMAS[def.returns.kind] ?? {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    }
  );
}

/**
 * Build the `deliver` tool for one categorizer hop. The result output confirms
 * to the model that the categorizer is complete — it is the LAST tool result it
 * sees.
 */
export function createDeliverTool(def: CategorizerDefinition, box: DeliverBox): AgentTool {
  return {
    name: DELIVER_TOOL_NAME,
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
    default:
      return { summary: text || "(no deliverable produced)" };
  }
}
