/**
 * MCP / skills / tools registry.
 *
 * Holds every capability the harness can use, grouped into providers. A provider
 * is one of:
 *   - "tool"  : a single internal AgentTool (bundled)
 *   - "mcp"   : a bundle of tools exposed by an MCP server (internal or external)
 *   - "skill" : a bundle of tools/behaviour packaged as a skill (internal or external)
 *
 * Every provider carries a `source` ("internal" = bundled, "external" = user-loaded)
 * and is scoped to one or more CATEGORIZER ids (v2; the 4P phases are retired).
 * The public API is:
 *   - list()   -> providers + aggregated description + scope + full tool defs
 *   - add()    -> register a provider (used when a user adds a new mcp/skill)
 *   - remove() -> delete a provider
 * plus categorizer-scoped resolution used by the chain.
 */
import type { AgentTool, Tool } from "../types.js";
import { categorizeTool, isInspectSurface } from "./categorize.js";

export type ProviderKind = "tool" | "mcp" | "skill";
export type ProviderSource = "internal" | "external";

/** Input shape when adding a provider. */
export interface ProviderInput {
  id: string;
  kind: ProviderKind;
  source: ProviderSource;
  /** Display name (e.g. mcp server name, skill name). */
  name: string;
  /**
   * Human-readable label for the provider group in UI surfaces. Same rule as
   * {@link Tool.title}: presentational only, and it should say what the group
   * is for rather than restate `name` ("Activity monitor" → "Logs & runtime
   * debugging"). One that restates the name is dropped; absent means render
   * nothing, not the raw name.
   */
  title?: string;
  /** Optional human description; if omitted it is synthesized from the tools. */
  description?: string;
  /** The full tool definitions this provider exposes. */
  tools: AgentTool[];
  /** Explicit categorizer ids; if omitted they are inferred from the tools. */
  categorizers?: string[];
  /** Optional lifecycle hook to release external resources (mcp process, etc.). */
  dispose?: () => void | Promise<void>;
  /** Freeform metadata (transport, command, version...). */
  metadata?: Record<string, unknown>;
}

interface StoredProvider extends ProviderInput {
  categorizers: string[];
  description: string;
}

/**
 * Custom scoping strategy. Receives the built-in default categorizer ids for a
 * tool and returns the ids to actually use — lets an app redefine which
 * categorizers a tool belongs to for its domain.
 */
export type ToolCategorizer = (tool: AgentTool, defaults: string[]) => string[];

export interface RegistryOptions {
  categorizer?: ToolCategorizer;
  /**
   * How EXTERNAL MCP servers scope into the chain when they declare no
   * categorizers of their own.
   *
   *   - "selection" (default): connected ≠ in-chain. The provider's tools get
   *     NO categorizers and reach no hop until `selectExternalMcps` (or an
   *     explicit `setProviderCategorizers`) names it. Before this mode, the
   *     name heuristics in categorize.ts silently scoped any connected
   *     browser-flavoured MCP into the QA hops of every project — a Flutter/iOS
   *     run opening with ~62 tools, two-thirds of them unable to touch the
   *     target, and the model reasoning "my automation is browser-based".
   *   - "auto": the legacy behavior — heuristic scoping at registration.
   *     Escape hatch for hosts that relied on it.
   */
  externalMcpScoping?: "selection" | "auto";
}

/** Declarative selection of a categorizer's toolset from the registry. */
export interface CategorizerToolFilter {
  /** Start from the registry's scope-resolved tools for the categorizer (default true). */
  fromScope?: boolean;
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

/** A function that computes a categorizer's toolset from the live registry. */
export type CategorizerToolResolver = (registry: Registry, categorizer: string) => AgentTool[];

/**
 * Does an MCP server match one of the selected names? Ids are hosts' own
 * (`playwright`, `turing-machine:mcp:chrome-devtools`); the UI knows display
 * names (`chrome-devtools`). Match exact id, an id's `:name` suffix, or the
 * name itself — all case-insensitive.
 */
export function mcpNameMatches(id: string, name: string | undefined, selected: readonly string[]): boolean {
  const wanted = selected.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return false;
  const idLower = id.toLowerCase();
  const nameLower = name?.trim().toLowerCase();
  return wanted.some(
    (n) => idLower === n || idLower.endsWith(`:${n}`) || nameLower === n,
  );
}

/**
 * Ways to define a categorizer's "fixed" toolset:
 *   - `AgentTool[]`              — pin an exact list
 *   - `CategorizerToolFilter`    — declaratively include/exclude on top of the scope
 *   - `CategorizerToolResolver`  — full programmatic control given the registry
 */
export type CategorizerToolSpec = AgentTool[] | CategorizerToolFilter | CategorizerToolResolver;

/** What `list()` returns per provider. */
export interface ProviderListItem {
  id: string;
  kind: ProviderKind;
  source: ProviderSource;
  name: string;
  /** Human-readable group label; absent means render nothing (never the raw name). */
  title?: string;
  /** Aggregated description derived from all the tools it holds. */
  description: string;
  /** Which categorizer(s) this provider serves. */
  categorizers: string[];
  /** Full tool definitions (name/description/parameters + mutates hints). */
  tools: Array<Tool & { mutates: boolean; categorizers: string[] }>;
  metadata?: Record<string, unknown>;
}

export class Registry {
  private providers = new Map<string, StoredProvider>();
  /** tool name -> provider id, for fast lookup and duplicate detection. */
  private toolIndex = new Map<string, string>();
  private listeners = new Set<(event: RegistryEvent) => void>();
  private readonly categorizer: ToolCategorizer;
  private readonly externalMcpScoping: "selection" | "auto";

  constructor(opts: RegistryOptions = {}) {
    this.categorizer = opts.categorizer ?? ((_tool, def) => def);
    this.externalMcpScoping = opts.externalMcpScoping ?? "selection";
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

    // Normalize per-tool scopes/mutates so downstream code never sees undefined.
    // Per-tool categorizers: explicit → custom categorizer(default) → default.
    // Cohort scoping, decided once for the whole provider: a tool that names no
    // QA keyword but sits in a QA server is still QA. See `isInspectSurface`.
    //
    // EXCEPTION — external MCP servers under "selection" scoping: their
    // undeclared tools get NO categorizers. Connected is not selected; the
    // heuristics below decide where a tool belongs, never whether the user
    // offered it to the run. Explicit declarations still win for hosts that
    // genuinely want a server in-chain unconditionally.
    const isExternalMcp = input.kind === "mcp" && input.source === "external";
    const deferToSelection = isExternalMcp && this.externalMcpScoping === "selection";
    const qaSurface = input.categorizers?.length ? false : isInspectSurface(input.tools);
    const tools = input.tools.map((t) => ({
      ...t,
      providerId: input.id,
      mutates: t.mutates ?? false,
      categorizers: t.categorizers?.length
        ? t.categorizers
        : deferToSelection && !input.categorizers?.length
          ? []
          : this.categorizer(t, qaSurface ? ["activity_inspect"] : categorizeTool(t)),
    }));
    const categorizers = input.categorizers?.length
      ? input.categorizers
      : dedupeIds(tools.flatMap((t) => t.categorizers));

    // Validate ALL tool names for collisions BEFORE mutating any state, so a
    // conflict can't leave the registry half-populated.
    for (const t of tools) {
      const existing = this.toolIndex.get(t.name);
      if (existing && existing !== input.id)
        throw new Error(
          `Tool name "${t.name}" already provided by "${existing}"; names must be unique across the registry.`,
        );
    }

    const stored: StoredProvider = { ...input, tools, categorizers, description };
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
  list(filter?: { source?: ProviderSource; kind?: ProviderKind; categorizer?: string }): ProviderListItem[] {
    let items = [...this.providers.values()].map((p) => this.toListItem(p));
    if (filter?.source) items = items.filter((i) => i.source === filter.source);
    if (filter?.kind) items = items.filter((i) => i.kind === filter.kind);
    if (filter?.categorizer) items = items.filter((i) => i.categorizers.includes(filter.categorizer!));
    return items;
  }

  /** Get a single provider list item. */
  get(id: string): ProviderListItem | undefined {
    const p = this.providers.get(id);
    return p ? this.toListItem(p) : undefined;
  }

  /** Resolve the executable AgentTools available to a given categorizer (by scope). */
  getToolsForCategorizer(categorizer: string): AgentTool[] {
    const out: AgentTool[] = [];
    for (const p of this.providers.values()) {
      for (const t of p.tools) {
        const scopes = t.categorizers?.length ? t.categorizers : p.categorizers;
        if (scopes.includes(categorizer)) out.push(t);
      }
    }
    // Demote bash in work-driving categorizers; read stays read-only by nature
    // and benefits from keeping bash in its natural position.
    if (["write_edit", "activity_inspect", "activity_reproduce", "perform", "perfect"].includes(categorizer)) {
      return this.demoteFallbackTools(out);
    }
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
   * Resolve a categorizer's toolset from a {@link CategorizerToolSpec}. This is
   * the single place a caller asks "what tools does categorizer X get?", so an
   * app can make the fixed toolset anything it wants — an exact list, a filter
   * over the scope, or a function.
   */
  selectCategorizerTools(categorizer: string, spec?: CategorizerToolSpec): AgentTool[] {
    if (!spec) return this.getToolsForCategorizer(categorizer);
    if (typeof spec === "function") return spec(this, categorizer);
    if (Array.isArray(spec)) return spec;
    return this.applyCategorizerFilter(categorizer, spec);
  }

  private applyCategorizerFilter(categorizer: string, f: CategorizerToolFilter): AgentTool[] {
    const byName = new Map<string, AgentTool>();
    if (f.fromScope !== false) for (const t of this.getToolsForCategorizer(categorizer)) byName.set(t.name, t);
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
   * Reassign the categorizer scope of a single tool at runtime. Lets an app move
   * a tool between categorizers (e.g. put a custom "screenshot" tool into
   * activity_inspect) without re-registering its provider. Returns false if the
   * tool is unknown.
   */
  setToolCategorizers(toolName: string, categorizers: string[]): boolean {
    const pid = this.toolIndex.get(toolName);
    if (!pid) return false;
    const p = this.providers.get(pid)!;
    const t = p.tools.find((x) => x.name === toolName);
    if (!t) return false;
    (t as AgentTool).categorizers = dedupeIds(categorizers);
    this.emit({ type: "changed", provider: this.toListItem(p) });
    return true;
  }

  /**
   * Reassign the scope of a whole provider (and all its tools) at runtime, e.g.
   * put an entire MCP server into activity_inspect. Returns false if unknown.
   */
  setProviderCategorizers(providerId: string, categorizers: string[]): boolean {
    const p = this.providers.get(providerId);
    if (!p) return false;
    const next = dedupeIds(categorizers);
    p.categorizers = next;
    for (const t of p.tools) (t as AgentTool).categorizers = [...next];
    this.emit({ type: "changed", provider: this.toListItem(p) });
    return true;
  }

  /**
   * Apply a per-run MCP selection: every EXTERNAL MCP server whose id or name
   * matches a selected name (exact id; the `…:name` suffix a host's
   * namespacing produces; or the display name the UI knows) is scoped to
   * `categorizers`; every other external MCP drops to NO scope, so it stays
   * connected but reaches no hop. Non-MCP and builtin providers are untouched.
   * Returns what it did, for the run log.
   */
  selectExternalMcps(names: readonly string[], categorizers: string[]): { selected: string[]; dropped: string[] } {
    const selected: string[] = [];
    const dropped: string[] = [];
    for (const p of this.providers.values()) {
      if (p.kind !== "mcp" || p.source !== "external") continue;
      if (mcpNameMatches(p.id, p.name, names)) {
        this.setProviderCategorizers(p.id, categorizers);
        selected.push(p.id);
      } else {
        this.setProviderCategorizers(p.id, []);
        dropped.push(p.id);
      }
    }
    return { selected, dropped };
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

  /** A categorizer→tool-definitions map over every scope actually in use. */
  categorizerMap(): Record<string, ProviderListItem["tools"]> {
    const map: Record<string, ProviderListItem["tools"]> = {};
    for (const item of this.list()) {
      for (const t of item.tools) {
        for (const id of t.categorizers) (map[id] ??= []).push(t);
      }
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
      ...titleField(p.name, p.title),
      description: p.description,
      categorizers: p.categorizers,
      tools: p.tools.map((t) => ({
        name: t.name,
        ...titleField(t.name, t.title),
        description: t.description,
        parameters: t.parameters,
        mutates: t.mutates ?? false,
        categorizers: t.categorizers?.length ? t.categorizers : p.categorizers,
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

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
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

/**
 * A title is only worth emitting when it TELLS the reader something the name
 * doesn't. "media_analysis" titled "Media Analysis" is the duplicate header
 * this field exists to remove, so it is dropped here rather than pushed onto
 * every host to detect: absent `title` means render nothing — NOT fall back to
 * the raw tool name.
 */
/**
 * The label to show for ONE call: the per-action title when the tool dispatches
 * on a verb, otherwise the tool's own title. Returns undefined when there is
 * nothing meaningful to show — render nothing then, never the raw name or the
 * raw enum token ("stats", "search"), which is what the user sees today.
 */
export function callTitle(tool: AgentTool, args: Record<string, unknown> = {}): string | undefined {
  const { actionParam, actionTitles } = tool;
  if (actionParam && actionTitles) {
    const raw = String(args[actionParam] ?? "").trim();
    // `action` is optional on these tools — they infer it from the other args,
    // and an inferred call is the common one, so label it the same way.
    const action = raw || (tool.resolveAction ? tool.resolveAction(args) : "");
    const label = action ? actionTitles[action] : undefined;
    if (label) return label;
  }
  return titleField(tool.name, tool.title).title;
}

export function titleField(name: string, title?: string): { title?: string } {
  if (!title) return {};
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return norm(title) === norm(name) ? {} : { title };
}
