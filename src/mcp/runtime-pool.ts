import { randomUUID } from "node:crypto";
import type { ProviderInput } from "../registry/registry.js";
import { connectMcpServer, type McpServerOptions } from "./client.js";

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

/** A pooled entry: shared provider + borrow count */
interface PooledEntry {
  provider: ProviderInput;
  borrowedBy: Set<string>;
  idleTimer?: NodeJS.Timeout;
}

/** Options for McpRuntimePool */
export interface McpRuntimePoolOptions {
  /** How long to keep idle MCP clients alive after last borrow (default: 5 minutes) */
  idleTimeoutMs?: number;
}

/** A shared pool of MCP runtime clients, reusable across multiple Session instances. */
export class McpRuntimePool {
  private readonly pool = new Map<string, PooledEntry>();
  private readonly idleTimeoutMs: number;

  constructor(opts?: McpRuntimePoolOptions) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 5 * 60 * 1000;
  }

  /**
   * Borrow a shared MCP provider for a given session. If the provider isn't already
   * connected, creates it first.
   */
  async borrow(opts: McpServerOptions, sessionId: string): Promise<ProviderInput> {
    const sig = mcpServerSignature(opts);

    // If already pooled and connected, just increment borrow count
    const existing = this.pool.get(sig);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      existing.borrowedBy.add(sessionId);
      return existing.provider;
    }

    // Not pooled: create new provider and add to pool
    const provider = await connectMcpServer(opts);
    const entry: PooledEntry = {
      provider,
      borrowedBy: new Set([sessionId]),
    };
    this.pool.set(sig, entry);
    return provider;
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
      entry.idleTimer = setTimeout(() => {
        this.disposeEntry(sig);
      }, this.idleTimeoutMs);
    }
  }

  /**
   * Immediately dispose a pooled MCP client (if present) and remove it from the pool.
   */
  async evict(opts: McpServerOptions): Promise<void> {
    const sig = mcpServerSignature(opts);
    await this.disposeEntry(sig);
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
