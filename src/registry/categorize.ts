/**
 * 4P categorization heuristics (req #3).
 *
 * Maps a tool to the phase(s) it naturally serves when the tool author didn't
 * declare `phases` explicitly. The model is:
 *   - Prepare : understand the request, project, folders, files (read-only, discovery)
 *   - Plan    : read files + light bash to form a plan
 *   - Perform : execution — reads AND mutations
 *   - Perfect : verification — browsers, screenshots, db checks, audits, tests
 *
 * These are only defaults; a tool's explicit `phases` always wins, and the
 * orchestrator can be configured with a fixed per-phase toolset regardless.
 */
import type { AgentTool, Phase } from "../types.js";

/** name/description substrings → phase affinity. */
const PERFECT_HINTS = [
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
  // Backend verification: Perfect probes running endpoints (via bash/curl or an
  // HTTP tool) to confirm behaviour — the user's "call api using bash" path.
  "api",
  "endpoint",
  "curl",
  "http",
];

const PREPARE_HINTS = [
  "bash",
  "shell",
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
];

const PLAN_HINTS = ["read", "cat", "open", "fetch", "web", "docs", "outline", "diagram"];

const PERFORM_MUTATION_HINTS = [
  "write",
  "edit",
  "create",
  "delete",
  "remove",
  "apply",
  "patch",
  "install",
  "run",
  "exec",
  "generate",
  "commit",
  "deploy",
  "mkdir",
  "mv",
  "cp",
];

function haystack(tool: AgentTool): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

function anyHit(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/** Categorize a single tool into one or more phases. */
export function categorizeTool(tool: AgentTool): Phase[] {
  if (tool.phases?.length) return tool.phases;

  const hay = haystack(tool);
  const phases = new Set<Phase>();

  if (anyHit(hay, PERFECT_HINTS)) phases.add("perfect");

  // Mutations are the hallmark of Perform.
  if (tool.mutates || anyHit(hay, PERFORM_MUTATION_HINTS)) phases.add("perform");

  // Read-only discovery serves Prepare and Plan.
  if (anyHit(hay, PREPARE_HINTS)) {
    phases.add("prepare");
    phases.add("plan");
  }
  if (anyHit(hay, PLAN_HINTS)) {
    phases.add("plan");
    // A pure reader is also useful during Perform.
    if (!tool.mutates) phases.add("perform");
  }

  // Fallback: a non-mutating tool with no hints is generically useful for
  // understanding/planning; a mutating one belongs to Perform.
  if (phases.size === 0) {
    if (tool.mutates) phases.add("perform");
    else {
      phases.add("prepare");
      phases.add("plan");
    }
  }

  return [...phases];
}

/** Categorize a provider as the union of its tools' phases. */
export function categorizeProvider(tools: AgentTool[]): Phase[] {
  const set = new Set<Phase>();
  for (const t of tools) for (const p of categorizeTool(t)) set.add(p);
  return set.size ? [...set] : ["perform"];
}
