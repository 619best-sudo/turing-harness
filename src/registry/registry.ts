/**
 * MCP / skills / tools registry (req #3).
 *
 * Holds every capability the harness can use, grouped into providers. A provider
 * is one of:
 *   - "tool"  : a single internal AgentTool (bundled)
 *   - "mcp"   : a bundle of tools exposed by an MCP server (internal or external)
 *   - "skill" : a bundle of tools/behaviour packaged as a skill (internal or external)
 *
 * Every provider carries a `source` ("internal" = bundled, "external" = user-loaded)
 * and is categorized into one or more of the 4P phases. The public API is:
 *   - list()   -> providers + aggregated description + category + full tool defs
 *   - add()    -> register a provider (used when a user adds a new mcp/skill)
 *   - remove() -> delete a provider
 * plus phase-scoped resolution used by the orchestrator.
 */
import type { AgentTool, Phase, Tool } from "../types.js";
import { PHASES } from "../types.js";
import { categorizeTool } from "./categorize.js";

export type ProviderKind = "tool" | "mcp" | "skill";
export type ProviderSource = "internal" | "external";

/** Input shape when adding a provider. */
export interface ProviderInput {
  id: string;
  kind: ProviderKind;
  source: ProviderSource;
  /** Display name (e.g. mcp server name, skill name). */
  name: string;
  /** Optional human description; if omitted it is synthesized from the tools. */
  description?: string;
  /** The full tool definitions this provider exposes. */
  tools: AgentTool[];
  /** Explicit 4P phases; if omitted they are inferred from the tools. */
  phases?: Phase[];
  /** Optional lifecycle hook to release external resources (mcp process, etc.). */
  dispose?: () => void | Promise<void>;
  /** Freeform metadata (transport, command, version...). */
  metadata?: Record<string, unknown>;
}

interface StoredProvider extends ProviderInput {
  phases: Phase[];
  description: string;
}

/**
 * Custom categorization strategy. Receives the built-in default phases for a tool
 * and returns the phases to actually use — lets an app redefine what each P
 * contains for its domain (mobile app, data pipeline, game, ...). (req: the fixed
 * per-P tools/mcps/skills must be customizable.)
 */
export type ToolCategorizer = (tool: AgentTool, defaultPhases: Phase[]) => Phase[];

export interface RegistryOptions {
  categorizer?: ToolCategorizer;
}

/** Declarative selection of a phase's toolset from the registry. */
export interface PhaseToolFilter {
  /** Start from the registry's category-resolved tools for the phase (default true). */
  fromCategory?: boolean;
  /** Tool names to add (from anywhere in the registry). */
  include?: string[];
  /** Tool names to remove. */
  exclude?: string[];
  /** Include every tool from these provider ids. */
  providers?: string[];
  /** Restrict the result to these provider kinds. */
  kinds?: ProviderKind[];
  /** Restrict the result to these provider sources. */
  sources?: ProviderSource[];
}

/** A function that computes a phase's toolset from the live registry. */
export type PhaseToolResolver = (registry: Registry, phase: Phase) => AgentTool[];

/**
 * Ways to define the "fixed" toolset for a phase:
 *   - `AgentTool[]`        — pin an exact list
 *   - `PhaseToolFilter`    — declaratively include/exclude on top of the category
 *   - `PhaseToolResolver`  — full programmatic control given the registry
 */
export type PhaseToolSpec = AgentTool[] | PhaseToolFilter | PhaseToolResolver;

/** What `list()` returns per provider. */
export interface ProviderListItem {
  id: string;
  kind: ProviderKind;
  source: ProviderSource;
  name: string;
  /** Aggregated description derived from all the tools it holds. */
  description: string;
  /** Which 4P phase(s) this provider serves. */
  phases: Phase[];
  /** Full tool definitions (name/description/parameters + mutates/phase hints). */
  tools: Array<Tool & { mutates: boolean; phases: Phase[] }>;
  metadata?: Record<string, unknown>;
}

export class Registry {
  private providers = new Map<string, StoredProvider>();
  /** tool name -> provider id, for fast lookup and duplicate detection. */
  private toolIndex = new Map<string, string>();
  private listeners = new Set<(event: RegistryEvent) => void>();
  private readonly categorizer: ToolCategorizer;

  constructor(opts: RegistryOptions = {}) {
    this.categorizer = opts.categorizer ?? ((_tool, def) => def);
  }

  /** Subscribe to add/remove/changed events (UI can keep its capability list in sync). */
  subscribe(fn: (event: RegistryEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Add (or replace) a provider. Runs categorization to attach 4P phases and to
   * synthesize a description from the tools when none was supplied (req #3).
   */
  add(input: ProviderInput): ProviderListItem {
    // Replacing: unregister the old entry synchronously (emits `removed` now, so
    // subscribers see removed→added in order); its dispose runs in the background
    // and must not surface as an unhandled rejection.
    const previous = this.unregister(input.id);
    if (previous?.dispose) void Promise.resolve(previous.dispose()).catch(() => {});

    const description = input.description ?? synthesizeDescription(input);

    // Normalize per-tool phases/mutates so downstream code never sees undefined.
    // Per-tool phases: explicit → custom categorizer(default) → default.
    const tools = input.tools.map((t) => ({
      ...t,
      mutates: t.mutates ?? false,
      phases: t.phases?.length ? t.phases : this.categorizer(t, categorizeTool(t)),
    }));
    const phases = input.phases?.length
      ? input.phases
      : dedupePhases(tools.flatMap((t) => t.phases));

    // Validate ALL tool names for collisions BEFORE mutating any state, so a
    // conflict can't leave the registry half-populated.
    for (const t of tools) {
      const existing = this.toolIndex.get(t.name);
      if (existing && existing !== input.id)
        throw new Error(
          `Tool name "${t.name}" already provided by "${existing}"; names must be unique across the registry.`,
        );
    }

    const stored: StoredProvider = { ...input, tools, phases, description };
    this.providers.set(input.id, stored);
    for (const t of tools) this.toolIndex.set(t.name, input.id);

    const item = this.toListItem(stored);
    this.emit({ type: "added", provider: item });
    return item;
  }

  /** Remove a provider by id, disposing its resources. Returns true if it existed. */
  async remove(id: string): Promise<boolean> {
    const stored = this.unregister(id);
    if (!stored) return false;
    if (stored.dispose) await stored.dispose();
    return true;
  }

  /**
   * Synchronously drop a provider from the maps and emit `removed`. Does NOT run
   * `dispose` (the caller decides how to await/handle it). Returns the removed
   * provider, or undefined if it wasn't present.
   */
  private unregister(id: string): StoredProvider | undefined {
    const stored = this.providers.get(id);
    if (!stored) return undefined;
    for (const t of stored.tools) this.toolIndex.delete(t.name);
    this.providers.delete(id);
    this.emit({ type: "removed", id });
    return stored;
  }

  /** List all providers with aggregated description + category + full tool defs. */
  list(filter?: { source?: ProviderSource; kind?: ProviderKind; phase?: Phase }): ProviderListItem[] {
    let items = [...this.providers.values()].map((p) => this.toListItem(p));
    if (filter?.source) items = items.filter((i) => i.source === filter.source);
    if (filter?.kind) items = items.filter((i) => i.kind === filter.kind);
    if (filter?.phase) items = items.filter((i) => i.phases.includes(filter.phase!));
    return items;
  }

  /** Get a single provider list item. */
  get(id: string): ProviderListItem | undefined {
    const p = this.providers.get(id);
    return p ? this.toListItem(p) : undefined;
  }

  /** Resolve the executable AgentTools available to a given phase (by category). */
  getToolsForPhase(phase: Phase): AgentTool[] {
    const out: AgentTool[] = [];
    for (const p of this.providers.values()) {
      for (const t of p.tools) {
        const tphases = t.phases?.length ? t.phases : p.phases;
        if (tphases.includes(phase)) out.push(t);
      }
    }
    // Only demote bash in phases that actually drive execution/verification
    // (Perform, Perfect). Prepare/Plan are read-only by nature and benefit
    // from keeping bash in its natural position.
    if (phase === "perform" || phase === "perfect") return this.demoteFallbackTools(out);
    return out;
  }

  /**
   * Reorder a tool list so generic shell tools (e.g. `bash`) appear LAST.
   *
   * Why: `bash` is a do-anything tool, so when the LLM sees it near the top of
   * the tool list it tends to reach for it first — even when more specific
   * tools (read/write/edit, browser_snapshot, etc.) would do the job better.
   * The phase prompts now mark `bash` as a fallback; this helper backs that
   * rule with ordering, so the dedicated tools get the model's first look.
   *
   * If a dedicated tool is needed and `bash` is the only option, it still
   * works — it just moves to the end of the list.
   */
  private demoteFallbackTools(tools: AgentTool[]): AgentTool[] {
    const FALLBACK_TOOLS = new Set(["bash"]);
    const primary: AgentTool[] = [];
    const fallback: AgentTool[] = [];
    for (const t of tools) {
      if (FALLBACK_TOOLS.has(t.name)) fallback.push(t);
      else primary.push(t);
    }
    return [...primary, ...fallback];
  }

  /**
   * Resolve a phase's toolset from a {@link PhaseToolSpec}. This is the single
   * place the orchestrator asks "what tools does phase X get?", so an app can make
   * the fixed per-P toolset anything it wants — an exact list, a filter over the
   * category, or a function.
   */
  selectPhaseTools(phase: Phase, spec?: PhaseToolSpec): AgentTool[] {
    if (!spec) return this.getToolsForPhase(phase);
    if (typeof spec === "function") return spec(this, phase);
    if (Array.isArray(spec)) return spec;
    return this.applyPhaseFilter(phase, spec);
  }

  private applyPhaseFilter(phase: Phase, f: PhaseToolFilter): AgentTool[] {
    const byName = new Map<string, AgentTool>();
    if (f.fromCategory !== false) for (const t of this.getToolsForPhase(phase)) byName.set(t.name, t);
    for (const pid of f.providers ?? []) {
      const p = this.providers.get(pid);
      if (p) for (const t of p.tools) byName.set(t.name, t);
    }
    for (const name of f.include ?? []) {
      const t = this.getTool(name);
      if (t) byName.set(name, t);
    }
    if (f.kinds || f.sources) {
      for (const name of [...byName.keys()]) {
        const p = this.providers.get(this.toolIndex.get(name)!);
        if (!p || (f.kinds && !f.kinds.includes(p.kind)) || (f.sources && !f.sources.includes(p.source)))
          byName.delete(name);
      }
    }
    for (const name of f.exclude ?? []) byName.delete(name);
    return [...byName.values()];
  }

  /**
   * Reassign the 4P phases of a single tool at runtime. Lets an app move a tool
   * between phases (e.g. put a custom "screenshot" tool into Perfect) without
   * re-registering its provider. Returns false if the tool is unknown.
   */
  setToolPhases(toolName: string, phases: Phase[]): boolean {
    const pid = this.toolIndex.get(toolName);
    if (!pid) return false;
    const p = this.providers.get(pid)!;
    const t = p.tools.find((x) => x.name === toolName);
    if (!t) return false;
    (t as AgentTool).phases = dedupePhases(phases);
    this.emit({ type: "changed", provider: this.toListItem(p) });
    return true;
  }

  /**
   * Reassign the 4P phases of a whole provider (and all its tools) at runtime,
   * e.g. put an entire MCP server into the Perfect phase. Returns false if unknown.
   */
  setProviderPhases(providerId: string, phases: Phase[]): boolean {
    const p = this.providers.get(providerId);
    if (!p) return false;
    const next = dedupePhases(phases);
    p.phases = next;
    for (const t of p.tools) (t as AgentTool).phases = [...next];
    this.emit({ type: "changed", provider: this.toListItem(p) });
    return true;
  }

  /** Look up a single executable tool by name. */
  getTool(name: string): AgentTool | undefined {
    const providerId = this.toolIndex.get(name);
    if (!providerId) return undefined;
    return this.providers.get(providerId)?.tools.find((t) => t.name === name);
  }

  /** Every executable tool across all providers. */
  allTools(): AgentTool[] {
    return [...this.providers.values()].flatMap((p) => p.tools);
  }

  /** A phase→tool-definitions map, e.g. for handing the plan phase its toolbox. */
  phaseMap(): Record<Phase, ProviderListItem["tools"]> {
    const map = Object.fromEntries(PHASES.map((p) => [p, [] as ProviderListItem["tools"]])) as Record<
      Phase,
      ProviderListItem["tools"]
    >;
    for (const item of this.list()) {
      for (const t of item.tools) for (const ph of t.phases) map[ph].push(t);
    }
    return map;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.providers.keys()]) await this.remove(id);
  }

  private toListItem(p: StoredProvider): ProviderListItem {
    return {
      id: p.id,
      kind: p.kind,
      source: p.source,
      name: p.name,
      description: p.description,
      phases: p.phases,
      tools: p.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        mutates: t.mutates ?? false,
        phases: t.phases?.length ? t.phases : p.phases,
      })),
      metadata: p.metadata,
    };
  }

  private emit(event: RegistryEvent): void {
    for (const l of this.listeners) l(event);
  }
}

export type RegistryEvent =
  | { type: "added"; provider: ProviderListItem }
  | { type: "removed"; id: string }
  | { type: "changed"; provider: ProviderListItem };

function dedupePhases(phases: Phase[]): Phase[] {
  return [...new Set(phases)];
}

/** Build a provider description from its tools (req #3: "based on all the tools it had"). */
function synthesizeDescription(input: ProviderInput): string {
  const names = input.tools.map((t) => t.name);
  const head = `${input.kind} "${input.name}" (${input.source}) — ${input.tools.length} tool${input.tools.length === 1 ? "" : "s"}: ${names.join(", ")}.`;
  const details = input.tools
    .slice(0, 6)
    .map((t) => `• ${t.name}: ${t.description}`)
    .join("\n");
  return details ? `${head}\n${details}` : head;
}
