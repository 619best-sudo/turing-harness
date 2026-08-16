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
 *   mobile:   Context7 only — device automation is the BUILT-IN mobile_* toolkit
 *             (src/devices/mobilecli.ts), not a spawned server
 *   games:    Godot MCP, (assets via built-in assets_generator)
 *   backend:  Postgres MCP, Filesystem MCP, Context7
 *
 * Sources: builder.io/blog/best-mcp-servers-2026, thenewstack.io "10 MCP Servers
 * for Frontend Developers", github.com/mobile-next/mobilecli,
 * strayspark.studio game-dev MCP guide, bytebase.com top Postgres MCP servers.
 */
import type { McpServerOptions } from "../mcp/client.js";
import type { PhaseModelConfig } from "../orchestrator/orchestrator.js";
import type { CategorizerToolFilter } from "../registry/registry.js";
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
  /** Categorizer ids this server serves once connected. */
  categorizers: string[];
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
  /** Categorizer → tool policy (built-in scoped tools + named MCP providers). */
  categorizerTools: Partial<Record<string, CategorizerToolFilter>>;
  /** Recommended MCP servers (connected only on opt-in). */
  mcp: PresetMcpEntry[];
  /** Recommended per-phase model defaults. */
  models: PhaseModelConfig;
}

// ---------------------------------------------------------------------------
// Reusable MCP entries
// ---------------------------------------------------------------------------

const context7 = (categorizers: string[]): PresetMcpEntry => ({
  id: "context7",
  categorizers,
  note: "Live, version-correct library docs. Runs via npx (@upstash/context7-mcp).",
  build: () => ({ id: "context7", name: "Context7", command: "npx", args: ["-y", "@upstash/context7-mcp"], mutates: false }),
});

const playwright: PresetMcpEntry = {
  id: "playwright",
  categorizers: ["activity_inspect"],
  note: "Microsoft Playwright MCP — E2E, accessibility snapshots. npx @playwright/mcp.",
  build: () => ({ id: "playwright", name: "Playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"], mutates: true }),
};

const chromeDevtools: PresetMcpEntry = {
  id: "chrome-devtools",
  categorizers: ["activity_inspect"],
  note: "Chrome DevTools MCP — console, network, performance from a live Chrome.",
  build: () => ({ id: "chrome-devtools", name: "Chrome DevTools", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], mutates: false }),
};

const figma: PresetMcpEntry = {
  id: "figma",
  categorizers: ["write_edit"],
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

// NOTE: there is deliberately no `mobile` MCP entry any more.
//
// Device automation used to be an external device-MCP server, spawned per run. It
// is now the BUILT-IN `mobile_*` toolkit backed by the `mobilecli` binary
// (src/devices/mobilecli.ts) — no server to spawn, no npx download on every
// run, no MCP tool-name resolution, and a coordinate contract this repo has
// actually verified against a device. The tools register unconditionally, so
// nothing needs to be added here to make a mobile project work.

const godot: PresetMcpEntry = {
  id: "godot",
  categorizers: ["read", "write_edit", "activity_inspect"],
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
  categorizers: ["read", "write_edit", "activity_inspect"],
  requires: ["dbUrl"],
  note: "Postgres MCP — schema introspection (Prepare/Plan), scoped writes/migrations (Perform), query to verify (Perfect). Use a read-only connection where possible; Postgres MCP Pro adds EXPLAIN/health.",
  build: (ctx) =>
    ctx.dbUrl
      ? { id: "postgres", name: "Postgres", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", ctx.dbUrl], mutates: true }
      : undefined,
};

const filesystem: PresetMcpEntry = {
  id: "filesystem",
  categorizers: ["read", "write_edit"],
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
    categorizerTools: {
      read: { fromScope: true, providers: ["context7"] },
      write_edit: { fromScope: true, providers: ["figma"] },
      activity_inspect: { fromScope: true, providers: ["playwright", "chrome-devtools"] },
    },
    mcp: [context7(["read", "write_edit"]), figma, playwright, chromeDevtools],
    models: {
      orchestrator: "xiaomi/mimo-v2.5",
      prepare: "xiaomi/mimo-v2.5",
      plan: "xiaomi/mimo-v2.5",
      perform: "xiaomi/mimo-v2.5",
      perfect: "xiaomi/mimo-v2.5",
    },
  },

  mobile: {
    category: "mobile",
    description: "Mobile apps: build + on-device/simulator verification.",
    categorizerTools: {
      read: { fromScope: true, providers: ["context7"] },
      // The built-in mobile toolkit is named explicitly so it is present for
      // env validation; the demote-bash-last registry ordering keeps the
      // mobile_* tools ahead of bash in the tool list.
      activity_inspect: { fromScope: true, providers: ["builtin:mobile", "builtin:media_analysis"] },
    },
    mcp: [context7(["read", "write_edit"])],
    models: {
      orchestrator: "xiaomi/mimo-v2.5",
      prepare: "xiaomi/mimo-v2.5",
      plan: "xiaomi/mimo-v2.5",
      perform: "xiaomi/mimo-v2.5",
      perfect: "xiaomi/mimo-v2.5",
    },
  },

  games: {
    category: "games",
    description: "Games (Godot): engine-driven build + playtest verification.",
    categorizerTools: {
      read: { fromScope: true, providers: ["godot"] },
      write_edit: { fromScope: true, providers: ["godot"] }, // + built-in assets_generator (sprites/audio/3d)
      activity_inspect: { fromScope: true, providers: ["godot"] },
    },
    mcp: [godot],
    models: {
      orchestrator: "xiaomi/mimo-v2.5",
      prepare: "xiaomi/mimo-v2.5",
      plan: "xiaomi/mimo-v2.5",
      perform: "xiaomi/mimo-v2.5",
      perfect: "xiaomi/mimo-v2.5",
    },
  },

  backend: {
    category: "backend",
    description: "Backend services & APIs: DB-aware build + data/API verification.",
    categorizerTools: {
      read: { fromScope: true, providers: ["context7", "postgres"] },
      write_edit: { fromScope: true, providers: ["postgres", "filesystem"] },
      activity_inspect: { fromScope: true, providers: ["postgres"] }, // + bash for tests/curl
    },
    mcp: [context7(["read", "write_edit"]), postgres, filesystem],
    models: {
      orchestrator: "xiaomi/mimo-v2.5",
      prepare: "xiaomi/mimo-v2.5",
      plan: "xiaomi/mimo-v2.5",
      perform: "xiaomi/mimo-v2.5",
      perfect: "xiaomi/mimo-v2.5",
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
  categorizerTools: string[];
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
  const report: ApplyPresetReport = { category, categorizerTools: [], modelsSet: false, connected: [], skipped: [], failed: [] };

  // 1. Categorizer-tool policy (runtime overrides — win over prior config).
  if (opts.applyPolicy !== false) {
    for (const id of Object.keys(preset.categorizerTools)) {
      session.setCategorizerTools(id, preset.categorizerTools[id]!);
      report.categorizerTools.push(id);
    }
    // 2. Model defaults (role slots: prepare=router/conversation, perform=work,
    //    perfect=summary).
    if (opts.setModels !== false) {
      for (const [target, slug] of Object.entries(preset.models)) {
        if (slug) session.orchestrator.setModel(target, slug);
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
          session.setProviderCategorizers(item.id, entry.categorizers);
          report.connected.push(entry.id);
        } catch (err) {
          report.failed.push({ id: entry.id, error: (err as Error).message });
        }
      }),
    );
  }
  return report;
}

/** The categorizer-tool policy + models a preset applies (for merging at construction). */
export function presetPolicy(category: ProjectCategory): {
  categorizerTools: Partial<Record<string, CategorizerToolFilter>>;
  models: PhaseModelConfig;
} {
  const p = PROJECT_PRESETS[category];
  return { categorizerTools: p.categorizerTools, models: p.models };
}
