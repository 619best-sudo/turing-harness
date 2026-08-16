/**
 * Internal tool: graph_memory.
 *
 * Read-oriented graph queries over durable file/symbol dependency memory.
 */
import type { AgentTool } from "../../types.js";
import type { FileMemory } from "../../memory/file-memory.js";
import type { GraphMemory } from "../../memory/graph-memory.js";
import type { FileGraphNode, SymbolGraphNode } from "../../memory/graph-adapters/base.js";
import { createLazyToolResultDetails } from "./lazy-tool-result.js";

/**
 * Resolve the graph_memory action. `action` is optional: when the model omits it
 * (otherwise the whole call is rejected up front), infer intent from the other
 * arguments — a `paths` list means refresh, a `symbol`/`qualifiedName` means
 * find_symbol, a single `path` means file_deps — and fall back to a harmless
 * index summary. An explicit `action` always wins.
 */
export function resolveGraphMemoryAction(args: Record<string, unknown>): string {
  const explicit = String(args.action ?? "").trim();
  if (explicit) return explicit;
  if (Array.isArray(args.paths) && args.paths.length > 0) return "refresh";
  if (String(args.symbol ?? "").trim() || String(args.qualifiedName ?? "").trim()) return "find_symbol";
  if (String(args.path ?? "").trim()) return "file_deps";
  return "stats";
}

export function createGraphMemoryTool(memory: GraphMemory, fileMemory?: FileMemory): AgentTool {
  return {
    name: "graph_memory",
    description:
      "Query durable dependency and symbol graphs. Actions: stats, refresh, file_deps, symbol_deps, blast_radius, get_file_node, get_symbol_node, find_symbol (default: inferred — paths→refresh, symbol/qualifiedName→find_symbol, path→file_deps, otherwise stats).",
    mutates: false,
    phases: ["prepare", "plan", "perform", "perfect"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["stats", "refresh", "file_deps", "symbol_deps", "blast_radius", "get_file_node", "get_symbol_node", "find_symbol"],
          description: "Optional. If omitted, inferred from the other arguments (paths→refresh, symbol/qualifiedName→find_symbol, path→file_deps, else stats).",
        },
        path: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        symbol: { type: "string" },
        qualifiedName: { type: "string" },
        direction: { type: "string", enum: ["inbound", "outbound", "both"] },
        depth: { type: "number" },
        includeTransitive: { type: "boolean" },
      },
      required: [],
    },
    async execute(_id, args, ctx) {
      const action = resolveGraphMemoryAction(args);
      switch (action) {
        case "stats": {
          const stats = memory.stats();
          return {
            output: `Indexed files: ${stats.totalFiles}\nIndexed symbols: ${stats.totalSymbols}\nEdges: ${stats.totalEdges}\nStale files: ${stats.staleFiles}\nLanguages: ${stats.languages.join(", ") || "—"}\nFrameworks: ${stats.frameworks.join(", ") || "—"}`,
            details: stats,
          };
        }
        case "refresh": {
          const paths = [
            ...((Array.isArray(args.paths) ? (args.paths as string[]) : []).filter(Boolean)),
            ...(args.path ? [String(args.path)] : []),
          ];
          if (!paths.length) return { output: "refresh requires `path` or `paths`.", isError: true };
          const refreshed = await memory.refreshMany(paths);
          await memory.save();
          return {
            output: `Refreshed graph memory for ${paths.length} path(s); indexed ${refreshed} files.`,
            details: { refreshed, requested: paths.length, stats: memory.stats() },
          };
        }
        case "file_deps": {
          const filePath = String(args.path ?? "").trim();
          if (!filePath) return { output: "file_deps requires `path`.", isError: true };
          const result = memory.fileDeps(filePath, normalizeDirection(args.direction), {
            depth: typeof args.depth === "number" ? args.depth : undefined,
            includeTransitive: typeof args.includeTransitive === "boolean" ? args.includeTransitive : undefined,
          });
          return {
            output: summarizeFileTraversal(result),
            details: await createLazyToolResultDetails(ctx, {
              toolName: "graph_memory",
              action: "file_deps",
              payload: { text: renderFileTraversal(result, fileMemory), result },
              itemCount: result.direct.length + result.transitive.length,
            }),
          };
        }
        case "symbol_deps": {
          const result = memory.symbolDeps(
            {
              filePath: typeof args.path === "string" ? args.path : undefined,
              symbol: typeof args.symbol === "string" ? args.symbol : undefined,
              qualifiedName: typeof args.qualifiedName === "string" ? args.qualifiedName : undefined,
            },
            normalizeDirection(args.direction),
            {
              depth: typeof args.depth === "number" ? args.depth : undefined,
              includeTransitive: typeof args.includeTransitive === "boolean" ? args.includeTransitive : undefined,
            },
          );
          return {
            output: summarizeSymbolTraversal(result),
            details: await createLazyToolResultDetails(ctx, {
              toolName: "graph_memory",
              action: "symbol_deps",
              payload: { text: renderSymbolTraversal(result), result },
              itemCount: result.direct.length + result.transitive.length,
            }),
          };
        }
        case "blast_radius": {
          const targetType = args.symbol || args.qualifiedName ? "symbol" : "file";
          const result =
            targetType === "file"
              ? memory.blastRadius({
                targetType: "file",
                path: String(args.path ?? ""),
                depth: typeof args.depth === "number" ? args.depth : undefined,
                includeTransitive: typeof args.includeTransitive === "boolean" ? args.includeTransitive : undefined,
                directions: normalizeDirection(args.direction),
              })
              : memory.blastRadius({
                targetType: "symbol",
                path: typeof args.path === "string" ? args.path : undefined,
                symbol: typeof args.symbol === "string" ? args.symbol : undefined,
                qualifiedName: typeof args.qualifiedName === "string" ? args.qualifiedName : undefined,
                depth: typeof args.depth === "number" ? args.depth : undefined,
                includeTransitive: typeof args.includeTransitive === "boolean" ? args.includeTransitive : undefined,
                directions: normalizeDirection(args.direction),
              });
          return {
            output: summarizeBlastRadius(result),
            details: await createLazyToolResultDetails(ctx, {
              toolName: "graph_memory",
              action: "blast_radius",
              payload: { text: renderBlastRadius(result, fileMemory), result },
              itemCount:
                result.directFiles.length +
                result.directSymbols.length +
                result.transitiveFiles.length +
                result.transitiveSymbols.length,
            }),
          };
        }
        case "get_file_node": {
          const filePath = String(args.path ?? "").trim();
          if (!filePath) return { output: "get_file_node requires `path`.", isError: true };
          const node = memory.getFileNode(filePath);
          return {
            output: node ? `${node.path}\n${node.language ?? "unknown"}\nstate=${node.stale ? `stale (${node.staleReason ?? "unknown"})` : "fresh"}` : `(no file graph node for ${filePath})`,
            details: node ?? null,
          };
        }
        case "get_symbol_node":
        case "find_symbol": {
          const nodes = memory.findSymbol({
            filePath: typeof args.path === "string" ? args.path : undefined,
            symbol: typeof args.symbol === "string" ? args.symbol : undefined,
            qualifiedName: typeof args.qualifiedName === "string" ? args.qualifiedName : undefined,
          });
          return {
            output: summarizeFindSymbol(nodes),
            details: await createLazyToolResultDetails(ctx, {
              toolName: "graph_memory",
              action: "find_symbol",
              payload: {
                text: nodes.length
                  ? nodes.map((node) => `- ${node.qualifiedName} (${node.symbolKind}) in ${node.filePath}`).join("\n")
                  : "(no matching symbols)",
                result: nodes,
              },
              itemCount: nodes.length,
            }),
          };
        }
        default:
          return { output: `Unknown action "${action}".`, isError: true };
      }
    },
  };
}

function normalizeDirection(direction: unknown): "inbound" | "outbound" | "both" {
  return direction === "inbound" || direction === "outbound" ? direction : "both";
}

function renderFileTraversal(result: ReturnType<GraphMemory["fileDeps"]>, fileMemory?: FileMemory): string {
  if (!result.target) return "(no matching file graph node)";
  const lines = [
    `Target: ${result.target.path}`,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    "",
    "Direct:",
    ...renderFiles(result.direct, fileMemory),
  ];
  if (result.notes?.length) lines.splice(3, 0, ...result.notes.map((note) => `Note: ${note}`), "");
  if (result.transitive.length) {
    lines.push("", "Transitive:", ...renderFiles(result.transitive, fileMemory));
  }
  return lines.join("\n");
}

function summarizeFileTraversal(result: ReturnType<GraphMemory["fileDeps"]>): string {
  if (!result.target) return "(no matching file graph node)";
  return [
    `Target: ${result.target.path}`,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    `Direct dependencies: ${result.direct.length}`,
    `Transitive dependencies: ${result.transitive.length}`,
    ...(result.notes?.length ? [`Notes: ${result.notes.length}`] : []),
  ].join("\n");
}

function renderSymbolTraversal(result: ReturnType<GraphMemory["symbolDeps"]>): string {
  if (!result.target) return "(no matching symbol graph node)";
  const lines = [
    `Target: ${result.target.qualifiedName} (${result.target.symbolKind})`,
    `File: ${result.target.filePath}`,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    "",
    "Direct:",
    ...renderSymbols(result.direct),
  ];
  if (result.notes?.length) lines.splice(4, 0, ...result.notes.map((note) => `Note: ${note}`), "");
  if (result.transitive.length) {
    lines.push("", "Transitive:", ...renderSymbols(result.transitive));
  }
  return lines.join("\n");
}

function summarizeSymbolTraversal(result: ReturnType<GraphMemory["symbolDeps"]>): string {
  if (!result.target) return "(no matching symbol graph node)";
  return [
    `Target: ${result.target.qualifiedName} (${result.target.symbolKind})`,
    `File: ${result.target.filePath}`,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    `Direct dependencies: ${result.direct.length}`,
    `Transitive dependencies: ${result.transitive.length}`,
    ...(result.notes?.length ? [`Notes: ${result.notes.length}`] : []),
  ].join("\n");
}

function renderBlastRadius(result: ReturnType<GraphMemory["blastRadius"]>, fileMemory?: FileMemory): string {
  if (!result.target) return "(no blast-radius target found)";
  const title =
    result.targetType === "file"
      ? `File blast radius: ${(result.target as FileGraphNode).path}`
      : `Symbol blast radius: ${(result.target as SymbolGraphNode).qualifiedName}`;
  return [
    title,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    ...(result.notes?.length ? result.notes.map((note) => `Note: ${note}`) : []),
    "",
    `Direct files (${result.directFiles.length}):`,
    ...renderFiles(result.directFiles, fileMemory),
    "",
    `Direct symbols (${result.directSymbols.length}):`,
    ...renderSymbols(result.directSymbols),
    ...(result.transitiveFiles.length
      ? ["", `Transitive files (${result.transitiveFiles.length}):`, ...renderFiles(result.transitiveFiles, fileMemory)]
      : []),
    ...(result.transitiveSymbols.length
      ? ["", `Transitive symbols (${result.transitiveSymbols.length}):`, ...renderSymbols(result.transitiveSymbols)]
      : []),
  ].join("\n");
}

function summarizeBlastRadius(result: ReturnType<GraphMemory["blastRadius"]>): string {
  if (!result.target) return "(no blast-radius target found)";
  const title =
    result.targetType === "file"
      ? `File blast radius: ${(result.target as FileGraphNode).path}`
      : `Symbol blast radius: ${(result.target as SymbolGraphNode).qualifiedName}`;
  return [
    title,
    `State: ${result.stale}`,
    `Capability: ${result.capabilityLevel ?? result.target.capabilityLevel ?? "unknown"}`,
    `Direct files: ${result.directFiles.length}`,
    `Direct symbols: ${result.directSymbols.length}`,
    `Transitive files: ${result.transitiveFiles.length}`,
    `Transitive symbols: ${result.transitiveSymbols.length}`,
    ...(result.notes?.length ? [`Notes: ${result.notes.length}`] : []),
  ].join("\n");
}

function renderFiles(files: FileGraphNode[], fileMemory?: FileMemory): string[] {
  return files.length
    ? files.map((file) => {
      const summary = fileMemory?.get(file.path)?.summary;
      const meta = [file.language, file.framework, file.capabilityLevel].filter(Boolean).join(", ");
      return `- ${file.path}${summary ? ` — ${summary}` : ""}${meta ? ` [${meta}]` : ""}`;
    })
    : ["(none)"];
}

function renderSymbols(symbols: SymbolGraphNode[]): string[] {
  return symbols.length ? symbols.map((node) => `- ${node.qualifiedName} (${node.symbolKind}) in ${node.filePath}${node.capabilityLevel ? ` [${node.capabilityLevel}]` : ""}`) : ["(none)"];
}

/**
 * "Where is this symbol?" answered with the location, not a count.
 *
 * This summary used to be `Matches: 1` plus a bare name and kind — everything
 * except the one fact the question was about. A real run asked for
 * `showDeleteConfirmationModal`, got back `Matches: 1 / Preview:
 * showDeleteConfirmationModal (function)`, learned nothing it did not already
 * know, and went back to grepping. The path was sitting in `details` the whole
 * time, where the model never sees it: only `output` reaches the conversation.
 */
function summarizeFindSymbol(nodes: SymbolGraphNode[]): string {
  if (!nodes.length) return "(no matching symbols)";
  const lines = nodes
    .slice(0, 10)
    .map((node) => {
      const where = node.range?.start ? `${node.filePath}:${node.range.start}` : node.filePath;
      return `- ${node.qualifiedName} (${node.symbolKind}) — ${where}`;
    });
  return [
    `Matches: ${nodes.length}`,
    ...lines,
    ...(nodes.length > 10 ? [`(+${nodes.length - 10} more)`] : []),
  ].join("\n");
}
