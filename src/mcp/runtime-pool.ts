import type { ProviderInput } from "../registry/registry.js";
import {
  connectMcpServer,
  connectMcpServerFromCache,
  primeMcpServerCache,
  type McpServerOptions,
} from "./client.js";
import type { McpToolCache } from "./tool-cache.js";

/**
 * Minimal logger shape the pool accepts. Kept dependency-free so the library
 * can be used standalone (it just logs to console) or wired to a host app's
 * logger (OpenWaggleMain passes its file logger here).
 */
export interface PoolLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

const consolePoolLogger: PoolLogger = {
  debug: (m, d) => console.debug(`[mcp-pool] ${m}`, d),
  info: (m, d) => console.info(`[mcp-pool] ${m}`, d),
  warn: (m, d) => console.warn(`[mcp-pool] ${m}`, d),
  error: (m, d) => console.error(`[mcp-pool] ${m}`, d),
};

/** Stable signature for a given McpServerOptions (ignoring transient fields like timeout) */
export function mcpServerSignature(opts: McpServerOptions): string {
  // Build a normalized object with all stable fields, using null for missing
  // values. This ensures consistent signatures across calls regardless of
  // whether a field is undefined, null, or a specific value.
  const stable: Record<string, unknown> = {
    id: opts.id ?? null,
    name: opts.name ?? null,
    command: opts.command,
    args: Array.isArray(opts.args) ? [...opts.args] : [],
    env: opts.env && typeof opts.env === "object"
      ? Object.fromEntries(Object.entries(opts.env).sort(([a], [b]) => a.localeCompare(b)))
      : null,
    cwd: opts.cwd ?? null,
    mutates: opts.mutates ?? null,
  };
  // Use a sorted-key JSON.stringify for guaranteed key-order consistency
  const sortedKeys = Object.keys(stable).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) sortedObj[k] = stable[k];
  return JSON.stringify(sortedObj);
}

/** Wall clock, isolated so tests can reason about the failure cooldown. */
function nowMs(): number {
  return Date.now();
}

/** Truncate a signature for log lines. */
function short(sig: string): string {
  return sig.length > 80 ? `${sig.slice(0, 80)}…` : sig;
}

/** A pooled entry: shared provider + borrow count */
interface PooledEntry {
  provider: ProviderInput;
  borrowedBy: Set<string>;
  idleTimer?: NodeJS.Timeout;
  /** The options this entry was connected with — kept so callers can evict by id. */
  opts: McpServerOptions;
}

/** Options for McpRuntimePool */
export interface McpRuntimePoolOptions {
  /** How long to keep idle MCP clients alive after last borrow (default: 5 minutes) */
  idleTimeoutMs?: number;
  /**
   * How long to remember that a server FAILED to connect, so a repeated
   * prewarm does not retry it immediately (default: 60s; 0 disables).
   *
   * A server that cannot start often cannot start *slowly* — a bad npm spec
   * spends ~30s in resolution before erroring. Without this, every prewarm
   * (project open, model change, settings save) pays that cost again, and the
   * run's bridge-attach window expires waiting on a doomed spawn.
   */
  failureCooldownMs?: number;
  /**
   * Tool-metadata cache. When supplied, a server whose tools are already cached
   * is registered WITHOUT spawning: the tool list comes from disk and the child
   * process starts on the first tool call.
   *
   * This is what makes startup a file read instead of N process spawns. Omit it
   * and the pool behaves exactly as before (always connect eagerly).
   */
  toolCache?: McpToolCache;
  /**
   * Run `npm cache add` before a COLD spawn (default true).
   *
   * This belongs here, not in the caller. A caller cannot know whether a server
   * is about to spawn or be served from the tool cache, so priming there had to
   * be an up-front barrier over every server — which blocked cache-backed
   * servers (that never spawn) behind `npm cache add` for ones that do. Here it
   * runs only on the path that actually spawns, and only for that server.
   */
  primeBeforeSpawn?: boolean;
  /** Optional logger. When omitted, logs to console. Host apps pass their own. */
  log?: PoolLogger;
}

/** A shared pool of MCP runtime clients, reusable across multiple Session instances. */
export class McpRuntimePool {
  private static instanceCounter = 0;
  private readonly pool = new Map<string, PooledEntry>();
  /**
   * In-flight connection promises, keyed by server signature. Without this,
   * two concurrent `borrow()` calls for the same server (e.g. a background
   * prewarm racing a run) BOTH fall through to `connectMcpServer` and spawn
   * duplicate child processes — one wins the pool slot, the other becomes an
   * orphaned process leaking resources. Deduping on the in-flight promise
   * guarantees a single spawn per signature.
   */
  private readonly inflight = new Map<string, Promise<ProviderInput>>();
  private readonly idleTimeoutMs: number;
  private readonly failureCooldownMs: number;
  private readonly toolCache?: McpToolCache;
  private readonly primeBeforeSpawn: boolean;
  /** signature -> epoch ms when a failed connect may be retried. */
  private readonly failedUntil = new Map<string, number>();
  private readonly log: PoolLogger;
  /** Stable instance id for diagnostics (detect prewarm/run pool mismatch). */
  private readonly instanceId = ++McpRuntimePool.instanceCounter;

  constructor(opts?: McpRuntimePoolOptions) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 5 * 60 * 1000;
    this.failureCooldownMs = opts?.failureCooldownMs ?? 60 * 1000;
    if (opts?.toolCache) this.toolCache = opts.toolCache;
    this.primeBeforeSpawn = opts?.primeBeforeSpawn ?? true;
    this.log = opts?.log ?? consolePoolLogger;
  }

  /** Expose instance id for diagnostics. */
  getInstanceId(): number {
    return this.instanceId;
  }

  /**
   * Borrow a shared MCP provider for a given session. If the provider isn't already
   * connected, creates it first. Concurrent borrows for the same signature share
   * a single in-flight connection (no duplicate spawns).
   */
  async borrow(opts: McpServerOptions, sessionId: string): Promise<ProviderInput> {
    const sig = mcpServerSignature(opts);

    // If already pooled and connected, just increment borrow count
    const existing = this.pool.get(sig);
    if (existing) {
      this.clearIdleTimer(existing);
      existing.borrowedBy.add(sessionId);
      this.log.debug('borrow HIT (warm pool)', { instanceId: this.instanceId, sessionId, sig: short(sig) });
      return existing.provider;
    }

    const provider = await this.connectShared(opts, sessionId);
    // Now resolved & in the pool. Record this session as a borrower (and clear
    // any idle timer that may have been set by a prior return()/prewarm()).
    const entry = this.pool.get(sig);
    if (entry) {
      this.clearIdleTimer(entry);
      entry.borrowedBy.add(sessionId);
    }
    return provider;
  }

  /**
   * Connect a server into the pool WITHOUT taking a borrow on it.
   *
   * This is the warm-up entry point: call it from wherever the user is already
   * waiting (a settings screen, a project-open hook) so that the later `borrow()`
   * on the latency-sensitive path is a Map lookup instead of a process spawn.
   *
   * Unlike `borrow(opts, 'prewarm')`, this leaves the entry with zero borrowers,
   * so the idle timer governs its lifetime normally. Borrowing under a fake
   * session id instead pins the entry forever: nothing ever calls `return()` for
   * that id, so `borrowedBy` never empties and the idle timer never starts.
   *
   * Resolves once the server is connected and pooled. Concurrent `prewarm()` /
   * `borrow()` calls for the same signature share one spawn. Rejects if the
   * connect fails, and the failure is remembered for `failureCooldownMs` so a
   * repeated prewarm does not pay a doomed ~30s spawn again — call
   * {@link clearFailureCooldowns} when the cause may have been fixed.
   */
  async prewarm(opts: McpServerOptions): Promise<void> {
    const sig = mcpServerSignature(opts);
    const existing = this.pool.get(sig);
    if (existing) {
      this.log.debug('prewarm HIT (already pooled)', { instanceId: this.instanceId, sig: short(sig) });
      return;
    }
    await this.connectShared(opts, 'prewarm');
    // Start the idle countdown now: a prewarmed entry has no borrower, so
    // without this it would sit in the pool untimed until someone borrows and
    // returns it.
    this.startIdleTimer(sig);
  }

  /**
   * Shared connect path for `borrow()` and `prewarm()`, with in-flight dedup so
   * a background prewarm racing a run spawns exactly one child process.
   */
  private connectShared(opts: McpServerOptions, who: string): Promise<ProviderInput> {
    const sig = mcpServerSignature(opts);

    // Cache hit: register from disk and defer the spawn. No npm work, no
    // handshake, nothing to wait for — this is the whole point of the cache.
    // Deliberately ahead of the failure cooldown: a server that failed to SPAWN
    // can still have a valid cached tool list, and going lazy means we do not
    // retry the doomed spawn until the model actually calls one of its tools.
    if (this.toolCache) {
      const lazy = connectMcpServerFromCache(opts, this.toolCache, sig);
      if (lazy) {
        this.pool.set(sig, { provider: lazy, borrowedBy: new Set(), opts });
        this.log.debug('connect LAZY (tools from cache, spawn deferred)', {
          instanceId: this.instanceId,
          who,
          sig: short(sig),
          tools: lazy.tools.length,
        });
        return Promise.resolve(lazy);
      }
    }

    const pending = this.inflight.get(sig);
    if (pending) {
      this.log.debug('connect INFLIGHT-SHARED (dedup)', { instanceId: this.instanceId, who, sig: short(sig) });
      return pending;
    }
    const cooldownUntil = this.failedUntil.get(sig);
    if (cooldownUntil !== undefined) {
      if (cooldownUntil > nowMs()) {
        this.log.debug('connect SKIPPED (recent failure)', { instanceId: this.instanceId, who, sig: short(sig) });
        return Promise.reject(
          new Error(
            'MCP server failed to connect recently and is in cooldown; not retried yet',
          ),
        );
      }
      this.failedUntil.delete(sig);
    }
    this.log.debug('connect COLD (spawning child process)', { instanceId: this.instanceId, who, sig: short(sig) });
    const started = (async () => {
      // Prime inside the cold path so it never delays a cache-backed server.
      if (this.primeBeforeSpawn) {
        await primeMcpServerCache(opts).catch(() => undefined);
      }
      return connectMcpServer(
        opts,
        this.toolCache ? { cache: this.toolCache, signature: sig } : undefined,
      );
    })()
      .then((provider) => {
        // Insert into the pool with an empty borrower set; callers add
        // themselves once the promise resolves. Clear the in-flight marker only
        // on success so a failed connect can be retried.
        this.pool.set(sig, { provider, borrowedBy: new Set(), opts });
        this.inflight.delete(sig);
        this.log.debug('connect COLD done', { instanceId: this.instanceId, who, sig: short(sig) });
        return provider;
      })
      .catch((err) => {
        this.inflight.delete(sig);
        if (this.failureCooldownMs > 0) {
          this.failedUntil.set(sig, nowMs() + this.failureCooldownMs);
        }
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('connect COLD failed', {
          instanceId: this.instanceId,
          who,
          sig: short(sig),
          error: message,
          cooldownMs: this.failureCooldownMs,
        });
        throw err;
      });
    this.inflight.set(sig, started);
    return started;
  }

  /**
   * Whether a server with this signature is already connected in the pool.
   * Lets callers skip expensive prep (e.g. npm cache priming) on the warm path.
   */
  has(opts: McpServerOptions): boolean {
    return this.pool.has(mcpServerSignature(opts));
  }

  /**
   * Provider ids of every currently pooled server. Lets a host reconcile the
   * pool against a changed config ("which of these are no longer enabled?")
   * without having to reconstruct each server's exact spawn options.
   */
  pooledIds(): string[] {
    return Array.from(this.pool.values(), (entry) => entry.opts.id);
  }

  /**
   * Dispose every pooled server whose provider id matches, regardless of the
   * rest of its options. Use this when a server is disabled or removed from
   * config: the options that produced its signature may no longer be
   * reconstructable, but the id is stable.
   *
   * Also kills entries that are still borrowed — a disabled server must not
   * keep serving tools to an in-flight run.
   */
  async evictById(id: string): Promise<void> {
    const sigs = Array.from(this.pool.entries())
      .filter(([, entry]) => entry.opts.id === id)
      .map(([sig]) => sig);
    if (sigs.length === 0) return;
    this.log.debug('evictById', { instanceId: this.instanceId, id, count: sigs.length });
    await Promise.allSettled(sigs.map((sig) => this.disposeEntry(sig)));
  }

  /**
   * Return a previously borrowed MCP provider to the pool. If this is the last
   * borrower, starts an idle timer before disposing the client.
   */
  return(opts: McpServerOptions, sessionId: string): void {
    const sig = mcpServerSignature(opts);
    const entry = this.pool.get(sig);
    if (!entry) return;

    entry.borrowedBy.delete(sessionId);

    // If no one is using it anymore, schedule disposal after idle timeout
    if (entry.borrowedBy.size === 0) {
      this.startIdleTimer(sig);
    }
  }

  private clearIdleTimer(entry: PooledEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /** (Re)start the idle countdown for an unborrowed entry. */
  private startIdleTimer(sig: string): void {
    const entry = this.pool.get(sig);
    if (!entry) return;
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      void this.disposeEntry(sig);
    }, this.idleTimeoutMs);
    // Don't let a pooled MCP server's idle timer hold the process open.
    entry.idleTimer.unref?.();
  }

  /**
   * Immediately dispose a pooled MCP client (if present) and remove it from the pool.
   */
  async evict(opts: McpServerOptions): Promise<void> {
    const sig = mcpServerSignature(opts);
    await this.disposeEntry(sig);
  }

  /**
   * Forget any recorded connect failures so the next borrow/prewarm retries
   * immediately. Call this when the cause may have been fixed — a config edit,
   * or a user explicitly asking to reconnect.
   */
  clearFailureCooldowns(): void {
    this.failedUntil.clear();
  }

  /** Dispose all pooled clients and clear the pool. */
  async dispose(): Promise<void> {
    const sigs = Array.from(this.pool.keys());
    await Promise.allSettled(sigs.map((sig) => this.disposeEntry(sig)));
  }

  private async disposeEntry(sig: string): Promise<void> {
    const entry = this.pool.get(sig);
    if (!entry) return;

    this.pool.delete(sig);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    // Dispose the underlying MCP client (kills the child process)
    await entry.provider.dispose?.();
  }
}

/** Wraps a pooled ProviderInput to make sure its dispose() just returns to the pool instead of killing the client */
export function wrapPooledProvider(
  pooled: ProviderInput,
  pool: McpRuntimePool,
  opts: McpServerOptions,
  sessionId: string,
): ProviderInput {
  return {
    ...pooled,
    dispose: async () => {
      // Instead of disposing the real provider (which would kill the shared client),
      // just return it to the pool so other sessions can use it
      pool.return(opts, sessionId);
    },
  };
}
