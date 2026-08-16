/**
 * On-disk cache of each MCP server's tool list.
 *
 * ## Why this exists
 *
 * Learning what tools an MCP server offers requires `spawn` → `initialize` →
 * `tools/list`. Since the model has to be TOLD which tools exist before it takes
 * its first turn, that forced every server to be connected eagerly, before the
 * run — so every app launch paid npx resolution, a possible download, a process
 * spawn and a handshake for every configured server, with readiness bounded by
 * the slowest one. Measured in a real app: ~15s for three servers.
 *
 * Caching the tool list turns startup into a file read. The server itself is
 * spawned only when one of its tools is actually invoked, where a pause is
 * expected and does not block the conversation.
 *
 * ## Correctness
 *
 * Entries are keyed by `mcpServerSignature(opts)` — derived from the command,
 * args, env and cwd — so editing a server's config is automatically a cache
 * miss. The live tool list is written back on every successful connect, so a
 * server that gains or loses tools is corrected the next time it runs.
 *
 * The residual risk is a stale entry: a server whose tools changed upstream but
 * whose config did not. The model may then be offered a tool that no longer
 * exists and get an error when it calls it — strictly better than the previous
 * behaviour, where a slow server meant NONE of its tools were offered at all.
 * {@link McpToolCache.forget} exists for a deliberate reset.
 *
 * Writes are best-effort: a cache that cannot be read or written must never
 * break a run, so every failure degrades to "no cache" and the eager path.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { JSONSchema } from "../types.js";

/** A tool definition as advertised by an MCP server, exactly as cached. */
export interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

interface CacheEntry {
  tools: CachedMcpTool[];
  cachedAt: number;
}

interface CacheFile {
  version: 1;
  /** signature -> entry */
  servers: Record<string, CacheEntry>;
}

const CACHE_VERSION = 1;

/** Default location when the host supplies no path. */
export function defaultMcpToolCachePath(): string {
  return join(tmpdir(), "turing-harness", "mcp-tool-cache.json");
}

export interface McpToolCacheOptions {
  /** Absolute path to the cache file. Hosts should point this at their own data dir. */
  path?: string;
  /**
   * Entries older than this are ignored (default: 30 days). Config changes are
   * already caught by the signature key; this only bounds unbounded staleness
   * for a server whose config never changes.
   */
  maxAgeMs?: number;
}

export class McpToolCache {
  private readonly path: string;
  private readonly maxAgeMs: number;
  /** Loaded lazily and kept in memory; the file is the durable copy. */
  private file?: CacheFile;

  constructor(opts: McpToolCacheOptions = {}) {
    this.path = opts.path ?? defaultMcpToolCachePath();
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  private read(): CacheFile {
    if (this.file) return this.file;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as CacheFile).version === CACHE_VERSION &&
        typeof (parsed as CacheFile).servers === "object"
      ) {
        this.file = parsed as CacheFile;
        return this.file;
      }
    } catch {
      // Missing, unreadable, or malformed — treat as empty rather than failing.
    }
    this.file = { version: CACHE_VERSION, servers: {} };
    return this.file;
  }

  /** Cached tools for a signature, or undefined on miss / expiry. */
  get(signature: string): CachedMcpTool[] | undefined {
    const entry = this.read().servers[signature];
    if (!entry) return undefined;
    if (this.maxAgeMs > 0 && Date.now() - entry.cachedAt > this.maxAgeMs) return undefined;
    return entry.tools.length > 0 ? entry.tools : undefined;
  }

  /** Record the live tool list for a signature. Best-effort. */
  set(signature: string, tools: readonly CachedMcpTool[]): void {
    const file = this.read();
    file.servers[signature] = {
      // Store only the fields a provider needs, so an unrelated protocol
      // addition can't bloat the file or break the shape.
      tools: tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      })),
      cachedAt: Date.now(),
    };
    this.flush();
  }

  /** Drop one signature (or everything) and persist. */
  forget(signature?: string): void {
    const file = this.read();
    if (signature === undefined) file.servers = {};
    else delete file.servers[signature];
    this.flush();
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that then reads as "no cache" for every server at once.
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, "utf-8");
      renameSync(tmp, this.path);
    } catch {
      // A read-only or full disk must not fail a run; the in-memory copy stands.
    }
  }
}
