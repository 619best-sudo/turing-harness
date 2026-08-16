/**
 * Categorizer scoping heuristics.
 *
 * Maps a tool to the categorizer id(s) it naturally serves when the tool author
 * didn't declare `categorizers` explicitly. The model (v2 defaults):
 *   - conversation     : (globals cover it — web/bash are setup-level)
 *   - read             : read-only discovery (ls/grep/memory/readonly shell)
 *   - write_edit       : execution — reads AND mutations
 *   - activity_inspect : verification — browsers, screenshots, logs, traces, tests
 *
 * These are only defaults; a tool's explicit `categorizers` always wins, and a
 * setup names its tools explicitly anyway (this drives fallback scoping and
 * hosts that re-scope at runtime).
 */
import type { AgentTool } from "../types.js";

/** name/description substrings → inspect affinity. */
const INSPECT_HINTS = [
  "playwright",
  "puppeteer",
  "browser",
  "chrome",
  "devtools",
  "snapshot",
  "screenshot",
  "screen",
  "audit",
  "sqlite",
  "sql",
  "test",
  "verify",
  "validate",
  "lint",
  "typecheck",
  "assert",
  "mobile",
  "mobilecli",
  "simulator",
  "device",
  "e2e",
  "activity",
  "trace",
  "log",
  "monitor",
  "probe",
  // Backend verification: inspect probes running endpoints (via bash/curl or an
  // HTTP tool) to confirm behaviour.
  "api",
  "endpoint",
  "curl",
  "http",
];

const READ_HINTS = [
  "bash_readonly",
  "ls",
  "list",
  "find",
  "glob",
  "grep",
  "search",
  "tree",
  "stat",
  "which",
  "explore",
  "read",
  "memory",
];

const WRITE_MUTATION_HINTS = [
  "write",
  "edit",
  "create",
  "delete",
  "remove",
  "apply",
  "patch",
  "install",
  "generate",
  "commit",
  "deploy",
  "mkdir",
  "mv",
  "cp",
  "assets",
];

function haystack(tool: AgentTool): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

function anyHit(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/** Scope a single tool into one or more default categorizer ids. */
export function categorizeTool(tool: AgentTool): string[] {
  if (tool.categorizers?.length) return tool.categorizers;

  const hay = haystack(tool);
  const ids = new Set<string>();

  if (anyHit(hay, INSPECT_HINTS)) ids.add("activity_inspect");

  // Mutations are the hallmark of write_edit.
  if (tool.mutates || anyHit(hay, WRITE_MUTATION_HINTS)) ids.add("write_edit");

  // Read-only discovery serves read (and write_edit — a work pass reads too).
  if (!tool.mutates && anyHit(hay, READ_HINTS)) {
    ids.add("read");
    if (!ids.has("write_edit")) ids.add("write_edit");
  }

  // Fallback: a mutating tool with no hints belongs to write_edit; a
  // non-mutating one is generically useful wherever reading happens.
  if (ids.size === 0) {
    if (tool.mutates) ids.add("write_edit");
    else ids.add("read");
  }

  return [...ids];
}

/** Scope a provider as the union of its tools' categorizers. */
export function categorizeProvider(tools: AgentTool[]): string[] {
  const set = new Set<string>();
  for (const t of tools) for (const id of categorizeTool(t)) set.add(id);
  return set.size ? [...set] : ["write_edit"];
}
