/**
 * Project presets — ready-made 4P tool/MCP/skill setups for common project types:
 * frontend (web), mobile, games (Godot), and backend.
 *
 * A preset is DECLARATIVE and offline-safe:
 *   - `phaseTools` sets which tools/MCP providers each phase uses (by category +
 *     provider id), applied synchronously — no processes spawned.
 *   - `models` sets sensible per-phase model defaults for the category.
 *   - `mcp` is a catalog of recommended MCP servers. They are only spawned when you
 *     opt in (`connectMcp: true`), and failures (server not installed, missing
 *     config) are reported, never thrown.
 *
 * Recommended servers (2026), by category:
 *   frontend: Playwright MCP, Chrome DevTools MCP, Figma MCP, Context7
 *   mobile:   mobile-mcp (mobile-next), Context7
 *   games:    Godot MCP, (assets via built-in assets_generator)
 *   backend:  Postgres MCP, Filesystem MCP, Context7
 *
 * Sources: builder.io/blog/best-mcp-servers-2026, thenewstack.io "10 MCP Servers
 * for Frontend Developers", github.com/mobile-next/mobile-mcp,
 * strayspark.studio game-dev MCP guide, bytebase.com top Postgres MCP servers.
 */
import type { Phase } from "../types.js";
import type { McpServerOptions } from "../mcp/client.js";
import type { PhaseModelConfig } from "../orchestrator/orchestrator.js";
import type { PhaseToolFilter } from "../registry/registry.js";
import type { Session } from "../session.js";

export type ProjectCategory = "frontend" | "mobile" | "games" | "backend";

/** Config supplied when materializing a preset's MCP servers. */
export interface PresetApplyContext {
  cwd: string;
  /** Extra env for spawned MCP servers (e.g. FIGMA_API_KEY). */
  env?: Record<string, string>;
  /** Database connection string (backend Postgres MCP). */
  dbUrl?: string;
  /** Root the filesystem MCP is scoped to (defaults to cwd). */
  filesystemDir?: string;
  /** Override the Godot MCP launch command (games). */
  engineCommand?: { command: string; args?: string[] };
}

/** One recommended MCP server in a preset. */
export interface PresetMcpEntry {
  id: string;
  /** 4P phases this server serves once connected. */
  phases: Phase[];
  /** Not connected unless explicitly requested / config present. */
  optional?: boolean;
  /** Setup note (what the user must have installed / configured). */
  note?: string;
  /** Config keys required to build options; if missing the entry is skipped. */
  requires?: string[];
  /** Build concrete server options; return undefined to skip (missing config). */
  build: (ctx: PresetApplyContext) => McpServerOptions | undefined;
}

export interface ProjectPreset {
  category: ProjectCategory;
  description: string;
  /** Phase → tool policy (built-in category tools + named MCP providers). */
  phaseTools: Partial<Record<Phase, PhaseToolFilter>>;
  /** Recommended MCP servers (connected only on opt-in). */
  mcp: PresetMcpEntry[];
  /** Recommended per-phase model defaults. */
  models: PhaseModelConfig;
}

// ---------------------------------------------------------------------------
// Reusable MCP entries
// ---------------------------------------------------------------------------

const context7 = (phases: Phase[]): PresetMcpEntry => ({
  id: "context7",
  phases,
  note: "Live, version-correct library docs. Runs via npx (@upstash/context7-mcp).",
  build: () => ({ id: "context7", name: "Context7", command: "npx", args: ["-y", "@upstash/context7-mcp"], mutates: false }),
});

const playwright: PresetMcpEntry = {
  id: "playwright",
  phases: ["perfect"],
  note: "Microsoft Playwright MCP — E2E, accessibility snapshots. npx @playwright/mcp.",
  build: () => ({ id: "playwright", name: "Playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"], mutates: true }),
};

const chromeDevtools: PresetMcpEntry = {
  id: "chrome-devtools",
  phases: ["perfect"],
  note: "Chrome DevTools MCP — console, network, performance from a live Chrome.",
  build: () => ({ id: "chrome-devtools", name: "Chrome DevTools", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], mutates: false }),
};

const figma: PresetMcpEntry = {
  id: "figma",
  phases: ["plan", "perform"],
  optional: true,
  requires: ["env.FIGMA_API_KEY"],
  note: "Figma MCP — read design spec/tokens. Requires FIGMA_API_KEY in env.",
  build: (ctx) =>
    ctx.env?.FIGMA_API_KEY
      ? {
          id: "figma",
          name: "Figma",
          command: "npx",
          args: ["-y", "figma-developer-mcp", "--stdio"],
          env: { FIGMA_API_KEY: ctx.env.FIGMA_API_KEY },
          mutates: false,
        }
      : undefined,
};

const mobile: PresetMcpEntry = {
  id: "mobile",
  phases: ["perfect"],
  note: "mobile-mcp (mobile-next) — drive iOS/Android simulators & devices, screenshots, vision element-finding.",
  build: () => ({ id: "mobile", name: "Mobile", command: "npx", args: ["-y", "@mobilenext/mobile-mcp@latest"], mutates: true }),
};

const godot: PresetMcpEntry = {
  id: "godot",
  phases: ["prepare", "plan", "perform", "perfect"],
  optional: true,
  note: "Godot MCP — scene mgmt, GDScript, run project, screenshot capture, input injection, debug output. Requires the Godot editor + the MCP bridge configured; override the launch command via engineCommand.",
  build: (ctx) => ({
    id: "godot",
    name: "Godot",
    command: ctx.engineCommand?.command ?? "npx",
    args: ctx.engineCommand?.args ?? ["-y", "godot-mcp"],
    env: ctx.env,
    mutates: true,
  }),
};

const postgres: PresetMcpEntry = {
  id: "postgres",
  phases: ["prepare", "plan", "perform", "perfect"],
  requires: ["dbUrl"],
  note: "Postgres MCP — schema introspection (Prepare/Plan), scoped writes/migrations (Perform), query to verify (Perfect). Use a read-only connection where possible; Postgres MCP Pro adds EXPLAIN/health.",
  build: (ctx) =>
    ctx.dbUrl
      ? { id: "postgres", name: "Postgres", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", ctx.dbUrl], mutates: true }
      : undefined,
};

const filesystem: PresetMcpEntry = {
  id: "filesystem",
  phases: ["prepare", "perform"],
  optional: true,
  note: "Filesystem MCP scoped to a directory (finer-grained access than built-in read/write).",
  build: (ctx) => ({
    id: "filesystem",
    name: "Filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ctx.filesystemDir ?? ctx.cwd],
    mutates: true,
  }),
};

// ---------------------------------------------------------------------------
// The presets
// ---------------------------------------------------------------------------

export const PROJECT_PRESETS: Record<ProjectCategory, ProjectPreset> = {
  frontend: {
    category: "frontend",
    description: "Web frontend: design-to-code + browser/visual verification.",
    phaseTools: {
      prepare: { fromCategory: true, providers: ["context7"] },
      plan: { fromCategory: true, providers: ["context7", "figma"] },
      // Perform uses dedicated read/write/edit + figma. `bash` is excluded so
      // the model can't reach for shell/curl checks during the build phase —
      // it must produce the artifact with the file tools and let Perfect
      // verify it via the browser.
      perform: { fromCategory: true, providers: ["figma"], exclude: ["bash"] },
      perfect: { fromCategory: true, providers: ["playwright", "chrome-devtools"] },
    },
    mcp: [context7(["prepare", "plan"]), figma, playwright, chromeDevtools],
    models: {
      orchestrator: "poolside/laguna-xs-2.1",
      prepare: "poolside/laguna-xs-2.1",
      plan: "poolside/laguna-xs-2.1",
      perform: "poolside/laguna-xs-2.1",
      perfect: "poolside/laguna-xs-2.1",
    },
  },

  mobile: {
    category: "mobile",
    description: "Mobile apps: build + on-device/simulator verification.",
    phaseTools: {
      prepare: { fromCategory: true, providers: ["context7"] },
      plan: { fromCategory: true, providers: ["context7"] },
      // Same `bash`-as-fallback policy as the frontend preset: in Perform
      // the model produces code with read/write/edit and lets Perfect drive
      // the simulator via Mobile MCP. bash is excluded so the model can't
      // fall back to `npx expo start` etc. from inside the harness. The
      // mobile provider is explicitly added so a future mobile_* tool can be
      // surfaced in Plan for env validation.
      perform: { fromCategory: true, providers: ["mobile"], exclude: ["bash"] },
      // Perfect: mobile tools FIRST (mandatory, not just first-listed) +
      // ui_screen_auditor. bash is explicitly included as a fallback for STEP
      // 0 (starting Metro) and cleanup, but the demote-bash-last ordering in
      // the registry keeps it behind every mobile_* tool in the tool list.
      perfect: { fromCategory: true, providers: ["mobile", "ui_screen_auditor"] },
    },
    mcp: [context7(["prepare", "plan"]), mobile],
    models: {
      orchestrator: "poolside/laguna-xs-2.1",
      prepare: "poolside/laguna-xs-2.1",
      plan: "poolside/laguna-xs-2.1",
      perform: "poolside/laguna-xs-2.1",
      perfect: "poolside/laguna-xs-2.1",
    },
  },

  games: {
    category: "games",
    description: "Games (Godot): engine-driven build + playtest verification.",
    phaseTools: {
      prepare: { fromCategory: true, providers: ["godot"] },
      plan: { fromCategory: true, providers: ["godot"] },
      perform: { fromCategory: true, providers: ["godot"] }, // + built-in assets_generator (sprites/audio/3d)
      perfect: { fromCategory: true, providers: ["godot"] },
    },
    mcp: [godot],
    models: {
      orchestrator: "poolside/laguna-xs-2.1",
      prepare: "poolside/laguna-xs-2.1",
      plan: "poolside/laguna-xs-2.1",
      perform: "poolside/laguna-xs-2.1",
      perfect: "poolside/laguna-xs-2.1",
    },
  },

  backend: {
    category: "backend",
    description: "Backend services & APIs: DB-aware build + data/API verification.",
    phaseTools: {
      prepare: { fromCategory: true, providers: ["context7", "postgres"] },
      plan: { fromCategory: true, providers: ["context7", "postgres"] },
      perform: { fromCategory: true, providers: ["postgres", "filesystem"] },
      perfect: { fromCategory: true, providers: ["postgres"] }, // + bash for tests/curl
    },
    mcp: [context7(["prepare", "plan"]), postgres, filesystem],
    models: {
      orchestrator: "poolside/laguna-xs-2.1",
      prepare: "poolside/laguna-xs-2.1",
      plan: "poolside/laguna-xs-2.1",
      perform: "poolside/laguna-xs-2.1",
      perfect: "poolside/laguna-xs-2.1",
    },
  },
};

// ---------------------------------------------------------------------------
// Applying a preset
// ---------------------------------------------------------------------------

export interface ApplyPresetOptions extends Omit<PresetApplyContext, "cwd"> {
  /** Working directory for MCP servers; defaults to the session's cwd. */
  cwd?: string;
  /** Spawn + register the preset's MCP servers (default false — offline-safe). */
  connectMcp?: boolean;
  /** Apply the phase-tool policy + model defaults (default true). */
  applyPolicy?: boolean;
  /** Also set per-phase model defaults (default true). */
  setModels?: boolean;
  /** Only connect these MCP server ids. */
  include?: string[];
  /** Skip these MCP server ids. */
  exclude?: string[];
}

export interface ApplyPresetReport {
  category: ProjectCategory;
  phaseTools: Phase[];
  modelsSet: boolean;
  connected: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

/**
 * Apply a project preset to a session. By default this only applies the
 * (offline-safe) phase-tool policy + model defaults. Pass `connectMcp: true` to
 * also spawn the recommended MCP servers, tolerating any that aren't installed.
 */
export async function applyProjectPreset(
  session: Session,
  category: ProjectCategory,
  opts: ApplyPresetOptions = {},
): Promise<ApplyPresetReport> {
  const preset = PROJECT_PRESETS[category];
  const ctx: PresetApplyContext = {
    cwd: opts.cwd ?? session.cwd,
    env: opts.env,
    dbUrl: opts.dbUrl,
    filesystemDir: opts.filesystemDir,
    engineCommand: opts.engineCommand,
  };
  const report: ApplyPresetReport = { category, phaseTools: [], modelsSet: false, connected: [], skipped: [], failed: [] };

  // 1. Phase-tool policy (runtime overrides — win over prior config).
  if (opts.applyPolicy !== false) {
    for (const phase of Object.keys(preset.phaseTools) as Phase[]) {
      session.setPhaseTools(phase, preset.phaseTools[phase]);
      report.phaseTools.push(phase);
    }
    // 2. Model defaults.
    if (opts.setModels !== false) {
      for (const [target, slug] of Object.entries(preset.models)) {
        if (slug) session.orchestrator.setModel(target as Phase | "orchestrator", slug);
      }
      report.modelsSet = true;
    }
  }

  // 3. MCP servers (opt-in). Spawn in parallel — each `addMcpServer` is an
  // independent child_process + JSON-RPC handshake, so serialising them was
  // the largest pre-prompt latency contributor. Individual failures are
  // captured into `report.failed`; the top-level await never rejects.
  if (opts.connectMcp) {
    await Promise.allSettled(
      preset.mcp.map(async (entry) => {
        if (opts.include && !opts.include.includes(entry.id)) return;
        if (opts.exclude?.includes(entry.id)) return;
        const options = entry.build(ctx);
        if (!options) {
          report.skipped.push({
            id: entry.id,
            reason: `missing config${entry.requires ? ` (${entry.requires.join(", ")})` : ""}`,
          });
          return;
        }
        try {
          const item = await session.addMcpServer(options);
          session.setProviderPhases(item.id, entry.phases);
          report.connected.push(entry.id);
        } catch (err) {
          report.failed.push({ id: entry.id, error: (err as Error).message });
        }
      }),
    );
  }
  return report;
}

/** The phase-tool policy + models a preset applies (for merging at construction). */
export function presetPolicy(category: ProjectCategory): {
  phaseTools: Partial<Record<Phase, PhaseToolFilter>>;
  models: PhaseModelConfig;
} {
  const p = PROJECT_PRESETS[category];
  return { phaseTools: p.phaseTools, models: p.models };
}
