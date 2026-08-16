/**
 * Shared stub plumbing for driving the v2 categorizer chain offline.
 *
 * The chain makes three kinds of LLM calls:
 *   - complete() × router turns   — system contains "CATEGORIZER ROUTER"
 *   - complete() × create_plan    — system contains the planner contract
 *   - complete() × summary turn   — system contains "closing summary"
 *   - complete() × Model-B author — everything else (the authoring helper)
 *   - stream()  × categorizer loop turns — system contains the categorizer
 *     template's identity line (e.g. "WRITE/EDIT categorizer")
 *
 * `makeChainBridge` wires all of that; tests supply the mutation call and the
 * Model-B reply. Router defaults to write_edit → summarise.
 */
import { OpenRouterBridge } from "../../dist/index.js";

export function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function usageWith(output) {
  return {
    input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

/**
 * @param {object} opts
 * @param {string[]} [opts.routerChoices] category picks in order; "summarise" ends.
 * @param {object}   [opts.planJson]      PLANS_JSON for create_plan's planner call.
 * @param {(ctx: any) => any} [opts.authorReply] complete() reply for authoring/other calls.
 * @param {string}   [opts.summaryText]   the closing summary.
 * @param {(turn: number) => any[] | null} [opts.turns] stream() content per
 *        categorizer-loop turn; null ends the script (plain text close).
 */
export function makeChainBridge(opts = {}) {
  const llm = new OpenRouterBridge();
  const routerChoices = opts.routerChoices ?? ["write_edit", "summarise"];
  let routerIdx = 0;
  const calls = { complete: [], stream: [] };

  llm.complete = async (model, ctx) => {
    calls.complete.push(ctx);
    const sys = ctx.systemPrompt ?? "";
    let text;
    if (/CATEGORIZER ROUTER/.test(sys)) {
      text = `CATEGORY: ${routerChoices[Math.min(routerIdx++, routerChoices.length - 1)]}`;
    } else if (/breaking a task into an ordered implementation plan/.test(sys)) {
      text = `PLANS_JSON:\n${JSON.stringify(opts.planJson ?? minimalPlan())}`;
    } else if (/closing summary/.test(sys)) {
      text = opts.summaryText ?? "Chain summary.";
    } else if (opts.authorReply) {
      return opts.authorReply(ctx, model);
    } else {
      text = "ok";
    }
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      model: model?.openRouterSlug ?? model?.id ?? "test/model-a",
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };

  let turn = 0;
  llm.stream = async function* (model, ctx) {
    calls.stream.push(ctx);
    yield {
      type: "start",
      partial: {
        role: "assistant", content: [], model: "test/model-a",
        api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: "stop", timestamp: 0,
      },
    };
    const content = opts.turns ? opts.turns(turn++, ctx) : null;
    const hasTool = Array.isArray(content) && content.some((c) => c?.type === "toolCall");
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: content ?? [{ type: "text", text: "done" }],
        model: "test/model-a", api: "openrouter", provider: "test",
        usage: zeroUsage(), stopReason: hasTool ? "tool_use" : "stop", timestamp: 0,
      },
    };
  };

  return { llm, calls };
}

/** A one-task plan over the given file (mode "edit" or "write"). */
export function minimalPlan(target, mode = "edit", complexity = "high") {
  return {
    plans: [{
      id: "p1", title: "The change", summary: "x",
      tasks: [{
        id: "t1", order: 1, title: "update", summary: "x",
        files: [target], fileMutations: { [target]: mode }, complexity,
      }],
    }],
    executionOrder: ["p1"],
  };
}

/**
 * The default write_edit turn script: create_plan → mutation → deliver.
 * `mutation` is the toolCall content of the middle turn.
 */
export function writeEditScript(mutation) {
  return (turn) => {
    if (turn === 0) {
      return [{ type: "toolCall", id: "c-plan", name: "create_plan", arguments: { task: "the change" } }];
    }
    if (turn === 1) {
      return Array.isArray(mutation) ? mutation : [mutation];
    }
    if (turn === 2) {
      return [{ type: "toolCall", id: "c-deliver", name: "deliver", arguments: { writes: [], notes: "done" } }];
    }
    return null;
  };
}

/** The default read turn script: deliver the code summary directly. */
export function readScript(deliverable) {
  return (turn) => {
    if (turn === 0) {
      return [{ type: "toolCall", id: "c-deliver", name: "deliver", arguments: deliverable }];
    }
    return null;
  };
}
