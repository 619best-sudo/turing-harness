/**
 * Internal tool: file_memory.
 *
 * Gives the agent read-oriented access to the durable file-memory index so it
 * can locate relevant files in one call before broad exploration.
 */
import type { AgentTool } from "../../types.js";
import type { FileMemory } from "../../memory/file-memory.js";
import { createLazyToolResultDetails } from "./lazy-tool-result.js";

/**
 * Resolve the file_memory action. `action` is optional: when the model omits it
 * (a common weak-model artifact that otherwise gets the whole call rejected up
 * front), infer intent from the other arguments — a `query` means search, an
 * explicit `paths` list means refresh, a single `path` means get — and fall back
 * to a harmless index summary. An explicit `action` always wins.
 */
export function resolveFileMemoryAction(args: Record<string, unknown>): string {
  const explicit = String(args.action ?? "").trim();
  if (explicit) return explicit;
  if (String(args.query ?? "").trim()) return "search";
  if (Array.isArray(args.paths) && args.paths.length > 0) return "refresh";
  if (String(args.path ?? "").trim()) return "get";
  return "stats";
}

export function createFileMemoryTool(memory: FileMemory): AgentTool {
  return {
    name: "file_memory",
        description:
          "Search or inspect the durable file-memory index. Actions: search, get, refresh, stats (default: inferred from the other arguments — `query`→search, `path`→get, `paths`→refresh, otherwise stats). Search uses path, summary, tags, keywords, symbols, dependencies, routes, and semantic metadata.",
    mutates: false,
    phases: ["prepare", "plan", "perform", "perfect"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "get", "refresh", "stats"],
          description: "Optional. search=rank files in one call; get=return one file entry; refresh=refresh indexed file entries; stats=index summary. If omitted, inferred from the other arguments (query→search, path→get, paths→refresh, else stats).",
        },
        query: { type: "string", description: "Natural-language or keyword search query for action=search." },
        path: { type: "string", description: "Absolute or cwd-relative file path for get/refresh." },
        paths: { type: "array", items: { type: "string" }, description: "Multiple file paths for refresh." },
        limit: { type: "number", description: "Maximum number of search results to return (default 10)." },
        extensions: { type: "array", items: { type: "string" }, description: "Optional extension filters for search, e.g. ['.ts', '.md']." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tag filters for search." },
      },
      required: [],
    },
    async execute(_id, args, ctx) {
      const action = resolveFileMemoryAction(args);
      switch (action) {
        case "search": {
          const query = String(args.query ?? "").trim();
          if (!query) return { output: "search requires `query`.", isError: true };
          const results = memory.search(query, {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            extensions: Array.isArray(args.extensions) ? (args.extensions as string[]) : undefined,
            tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          });
          const lines = results.length
            ? results.map((result) => {
              const extra = [
                result.language ? `language=${result.language}` : undefined,
                result.role ? `role=${result.role}` : undefined,
                result.tags.length ? `tags=${result.tags.join(",")}` : undefined,
                result.keywords.length ? `keywords=${result.keywords.join(",")}` : undefined,
                result.keySymbols.length ? `symbols=${result.keySymbols.join(",")}` : undefined,
                result.dependencies.length ? `deps=${result.dependencies.join(",")}` : undefined,
                result.routes.length ? `routes=${result.routes.join(",")}` : undefined,
                result.fresh ? "fresh" : "stale",
                result.reasons.length ? `why=${result.reasons.join("; ")}` : undefined,
              ]
                .filter(Boolean)
                .join(" | ");
              return `- ${result.path}\n  ${result.summary}${extra ? `\n  ${extra}` : ""}`;
            })
            // An empty result must not read as "the code does not exist". Say what
            // to try next, in this tool, before the loop's search ladder has to.
            : [
              "(no matching files)",
              `Worth trying: retry with ONE distinctive term (a symbol, filename fragment, route or error string) instead of a phrase, and drop any extensions/tags filters. Check the index is warm with action:"stats". After a few empty queries, searching with grep/bash is usually the better bet — an empty index entry is not evidence of a missing file.`,
            ];
          return {
            output: lines.join("\n"),
            details: await createLazyToolResultDetails(ctx, {
              toolName: "file_memory",
              action: "search",
              payload: results,
              itemCount: results.length,
            }),
          };
        }
        case "get": {
          const filePath = String(args.path ?? "").trim();
          if (!filePath) return { output: "get requires `path`.", isError: true };
          const entry = memory.get(filePath);
          if (!entry) return { output: `(no entry for ${filePath})`, details: null };
          return {
            output:
              `${entry.path}\n${entry.summary}\n` +
              `language=${entry.language ?? "—"}\n` +
              `keywords=${entry.keywords.join(", ") || "—"}\n` +
              `key_symbols=${entry.keySymbols.join(", ") || "—"}\n` +
              `dependencies=${entry.dependencies.join(", ") || "—"}\n` +
              `routes=${entry.routes.join(", ") || "—"}\n` +
              `interfaces=${entry.interfaces.join(", ") || "—"}\n` +
              `responsibilities=${entry.responsibilities.join(", ") || "—"}\n` +
              `role=${entry.role}\n` +
              `tags=${entry.tags.join(", ") || "—"}\n` +
              `framework_hints=${entry.frameworkHints.join(", ") || "—"}\n` +
              `summary_source=${entry.summarySource}${entry.summaryPending ? " (pending)" : ""}\n` +
              `state=${entry.stale ? `stale (${entry.staleReason ?? "unknown"})` : "fresh"}`,
            details: await createLazyToolResultDetails(ctx, {
              toolName: "file_memory",
              action: "get",
              payload: entry,
              itemCount: 1,
            }),
          };
        }
        case "refresh": {
          const paths = [
            ...((Array.isArray(args.paths) ? (args.paths as string[]) : []).filter(Boolean)),
            ...(args.path ? [String(args.path)] : []),
          ];
          if (!paths.length) return { output: "refresh requires `path` or `paths`.", isError: true };
          const refreshed = await memory.refreshMany(paths, { source: "refresh" });
          await memory.save();
          return {
            output: `Refreshed ${refreshed}/${paths.length} file-memory entries.`,
            details: { refreshed, requested: paths.length, stats: memory.stats() },
          };
        }
        case "stats": {
          const stats = memory.stats();
          return {
            output: `Indexed files: ${stats.totalFiles}\nStale files: ${stats.staleFiles}`,
            details: stats,
          };
        }
        default:
          return { output: `Unknown action "${action}".`, isError: true };
      }
    },
  };
}
