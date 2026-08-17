/**
 * Internal tool: project_memory.
 *
 * Gives the agent read/write access to the durable project memory — the detected
 * category + tech stack and any facts learned across runs. The Prepare phase can
 * read it to skip re-discovering the stack; any phase can `remember` a durable
 * fact (e.g. "tests run via `pnpm test`", "API base path is /v1").
 *
 * Bound to a specific {@link ProjectMemory} instance via the factory.
 */
import type { AgentTool } from "../../types.js";
import type { ProjectMemory } from "../../memory/project-memory.js";
import { createLazyToolResultDetails } from "./lazy-tool-result.js";

/**
 * Resolve the project_memory action. `action` is optional: when the model omits
 * it (otherwise the whole call is rejected up front), infer a SAFE, read-only
 * intent from the other arguments — a `category` means set_category (that arg is
 * only used there), a `text` filter means recall (read, never a silent write),
 * and the fallback is a full read. Writing (`remember`) is never inferred; it
 * must be requested explicitly. An explicit `action` always wins.
 */
export function resolveProjectMemoryAction(args: Record<string, unknown>): string {
  const explicit = String(args.action ?? "").trim();
  if (explicit) return explicit;
  if (String(args.category ?? "").trim()) return "set_category";
  if (String(args.text ?? "").trim()) return "recall";
  return "get";
}

export function createProjectMemoryTool(memory: ProjectMemory): AgentTool {
  return {
    name: "project_memory",
    title: "Recall project conventions",
    actionParam: "action",
    resolveAction: resolveProjectMemoryAction,
    actionTitles: {
      get: "Read what we know about this project",
      remember: "Remember this for future runs",
      recall: "Recall a past decision",
      set_category: "Correct the project type",
    },
    description:
      "Read or update durable project memory — the ONLY thing that outlives this conversation: the project's " +
      "category (frontend/mobile/games/backend) + tech stack, and the rules learned across runs. " +
      "`remember` the two things that would otherwise be re-learned every run: a STANDING PREFERENCE the user " +
      "states or corrects you on (\"colors come from the tokens file, never raw hex\"), and a RESOLVED FAILURE " +
      "you hit twice (\"playwright needs the dev server already running\") — the rule and its cause, never the " +
      "symptom, and never anything the code already states. " +
      "Actions: get, remember, recall, set_category (default: inferred — category→set_category, text→recall, " +
      "otherwise get; `remember` must be explicit).",
    // Reads dominate; remembering a fact is a low-risk local note, not a code change.
    mutates: false,
    categorizers: ["read", "write_edit", "activity_inspect"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "remember", "recall", "set_category"],
          description: "Optional. get=full memory; remember=append a fact; recall=filter facts; set_category=correct the project category. If omitted, inferred (category→set_category, text→recall, else get).",
        },
        text: { type: "string", description: "Fact text (remember) or substring filter (recall)." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for the fact (remember) or a tag filter (recall)." },
        category: { type: "string", enum: ["frontend", "mobile", "games", "backend"], description: "New category (set_category)." },
      },
      required: [],
    },
    async execute(_id, args, ctx) {
      const action = resolveProjectMemoryAction(args);
      switch (action) {
        case "get": {
          const d = memory.data;
          return {
            output: `Project category: ${d.category}\nLanguages: ${d.stack.languages.join(", ") || "—"}\nFrameworks: ${d.stack.frameworks.join(", ") || "—"}${d.stack.engine ? `\nEngine: ${d.stack.engine}` : ""}\nPackage manager: ${d.stack.packageManager ?? "—"}\nFacts (${d.facts.length}):\n${d.facts.map((f) => `- ${f.text}`).join("\n") || "  (none yet)"}`,
            details: await createLazyToolResultDetails(ctx, {
              toolName: "project_memory",
              action: "get",
              payload: d,
              itemCount: d.facts.length,
            }),
          };
        }
        case "remember": {
          if (!args.text) return { output: "remember requires `text`.", isError: true };
          const fact = await memory.remember(String(args.text), {
            tags: (args.tags as string[]) ?? [],
            source: `phase`,
          });
          ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:project_memory", "memory"], message: `remembered: ${fact.text}` });
          return { output: `Remembered (${fact.id}): ${fact.text}`, details: fact };
        }
        case "recall": {
          const facts = memory.recall({
            tag: args.tags ? (args.tags as string[])[0] : undefined,
            text: args.text ? String(args.text) : undefined,
          });
          return {
            output: facts.map((f) => `- ${f.text}`).join("\n") || "(no matching facts)",
            details: await createLazyToolResultDetails(ctx, {
              toolName: "project_memory",
              action: "recall",
              payload: facts,
              itemCount: facts.length,
            }),
          };
        }
        case "set_category": {
          if (!args.category) return { output: "set_category requires `category`.", isError: true };
          await memory.setCategory(args.category as any, { auto: false });
          return {
            output: `Category set to ${args.category}. (Note: preset tools already active for this session are unchanged.)`,
            details: await createLazyToolResultDetails(ctx, {
              toolName: "project_memory",
              action: "set_category",
              payload: memory.data,
              itemCount: memory.data.facts.length,
            }),
          };
        }
        default:
          return { output: `Unknown action "${action}".`, isError: true };
      }
    },
  };
}
