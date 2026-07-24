/**
 * Internal tool: activity_monitor (req #6).
 *
 * Watches activity logs and lets the agent search them by tag string to cut noise,
 * then study the filtered slice. Two sources:
 *   - the in-memory {@link LogStore} the harness writes to (default), and
 *   - an external log file (tail + filter), for app logs outside the harness.
 *
 * "study" optionally asks a model to summarize the filtered lines.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, Context } from "../../types.js";
import type { LogStore } from "../../logging/logger.js";

export interface ActivityMonitorConfig {
  logStore: LogStore;
  /** Model slug used by the "study" action. */
  studyModel?: string;
}

const DEFAULT_STUDY_MODEL = "poolside/laguna-xs-2.1";

export function createActivityMonitorTool(config: ActivityMonitorConfig): AgentTool {
  const { logStore } = config;
  return {
    name: "activity_monitor",
    description:
      "Search and study activity logs. Filter by tag(s) and/or text to remove noise, tail an external log file, list available tags, or ask the model to study a filtered slice.",
    mutates: false,
    phases: ["perfect"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "tags", "tail_file", "study"],
          description: "search=filter the harness log; tags=list tag histogram; tail_file=read+filter an external log file; study=filter then summarize with a model.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Require ALL of these tags." },
        anyTags: { type: "array", items: { type: "string" }, description: "Match ANY of these tags." },
        text: { type: "string", description: "Substring (or regex) to match in messages." },
        regex: { type: "boolean", description: "Treat `text` as a regular expression." },
        level: { type: "string", enum: ["debug", "info", "warn", "error"] },
        limit: { type: "number", description: "Max lines to return (default 200)." },
        file: { type: "string", description: "Path to an external log file (for tail_file)." },
      },
      required: ["action"],
    },
    async execute(_id, args, ctx) {
      const action = String(args.action);
      const limit = args.limit ? Number(args.limit) : 200;

      if (action === "tags") {
        const hist = logStore.tagHistogram();
        const sorted = Object.entries(hist).sort((a, b) => b[1] - a[1]);
        return {
          output: sorted.map(([t, n]) => `${t}: ${n}`).join("\n") || "(no tags yet)",
          details: hist,
        };
      }

      if (action === "tail_file") {
        const file = path.isAbsolute(String(args.file)) ? String(args.file) : path.join(ctx.cwd, String(args.file));
        try {
          const text = await fs.readFile(file, "utf8");
          let lines = text.split("\n");
          if (args.text) {
            const re = args.regex ? new RegExp(String(args.text), "i") : undefined;
            const needle = String(args.text).toLowerCase();
            lines = lines.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(needle)));
          }
          const tail = lines.slice(-limit).join("\n");
          return { output: tail || "(no matching lines)", details: { file, matched: lines.length } };
        } catch (err) {
          return { output: `Failed to read ${file}: ${(err as Error).message}`, isError: true };
        }
      }

      // search / study both filter the harness log store.
      const entries = logStore.search({
        tags: args.tags as string[] | undefined,
        anyTags: args.anyTags as string[] | undefined,
        text: args.text ? String(args.text) : undefined,
        regex: Boolean(args.regex),
        level: args.level as any,
        limit,
      });
      const rendered = entries
        .map((e) => `${new Date(e.timestamp).toISOString()} [${e.level}] (${e.tags.join(",")}) ${e.message}`)
        .join("\n");

      if (action === "search") {
        return { output: rendered || "(no matching entries)", details: { count: entries.length } };
      }

      // study
      if (!ctx.llm) {
        return { output: rendered || "(no matching entries)", details: { count: entries.length, studied: false } };
      }
      const slug = config.studyModel ?? ctx.model?.openRouterSlug ?? DEFAULT_STUDY_MODEL;
      const model = ctx.llm.resolveModel(slug);
      const context: Context = {
        systemPrompt:
          "You analyze activity logs. Summarize what happened, surface errors/anomalies, and note likely root causes. Be concise and concrete.",
        messages: [
          { role: "user", content: `Study these ${entries.length} log lines and report findings:\n\n${rendered}`, timestamp: Date.now() },
        ],
      };
      const msg = await ctx.llm.complete(model, context, { temperature: 0, signal: ctx.signal });
      const study = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
      return { output: study, details: { count: entries.length, studied: true } };
    },
  };
}
