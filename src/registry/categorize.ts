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

  // QA-surface tools are inspect-EXCLUSIVE. A browser/screenshot/device/test
  // tool must never ride into read or write_edit on the strength of incidental
  // description words: a real chrome-devtools `browser_navigate` says it will
  // "create a new tab" and "list console errors", and those hits scoped it
  // into write_edit — whose hop then burned turns driving a dead file://
  // screen while the real QA pass re-did the work. Explicit
  // `tool.categorizers` still wins for hosts that genuinely want dual scope.
  if (anyHit(hay, INSPECT_HINTS)) return ["activity_inspect"];

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

/**
 * A provider whose tools are OVERWHELMINGLY a QA surface.
 *
 * The per-tool test reads one tool's name and blurb, which is all it has and not
 * enough. `chrome-devtools` ships `browser_navigate` (obviously inspect) beside
 * `list_pages` and `get_network_request` — neither of which contains a single
 * inspect keyword, so both fell through to the generic non-mutating default and
 * joined the READ hop. A read categorizer holding `get_network_request` is the
 * same class of mistake the per-tool guard was written to stop, arriving from the
 * other side: not a false positive on incidental words, but a false negative on
 * their absence.
 *
 * The server is the better signal. A tool sitting in a browser-automation server
 * is part of a browser-automation surface no matter how neutrally it describes
 * itself, so when most of a provider's tools are inspect-exclusive the rest are
 * read that way too. A tool that declared `categorizers` for itself is untouched
 * — an explicit scope always wins.
 *
 * "Most" and not "any": a general-purpose server with one screenshot tool must
 * not have its whole surface pulled into QA.
 */
export function isInspectSurface(tools: AgentTool[]): boolean {
  const undeclared = tools.filter((t) => !t.categorizers?.length);
  if (undeclared.length < 3) return false;
  const inspect = undeclared.filter((t) => anyHit(haystack(t), INSPECT_HINTS)).length;
  return inspect * 2 > undeclared.length;
}

/** Scope a provider as the union of its tools' categorizers. */
export function categorizeProvider(tools: AgentTool[]): string[] {
  const set = new Set<string>();
  for (const t of tools) for (const id of categorizeTool(t)) set.add(id);
  return set.size ? [...set] : ["write_edit"];
}
