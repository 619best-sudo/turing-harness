/**
 * Minimal MCP (Model Context Protocol) stdio client (req #3, "External" providers).
 *
 * Spawns an MCP server process, performs the initialize handshake, lists its
 * tools, and wraps each as an {@link AgentTool}. Use {@link connectMcpServer} to
 * get a {@link ProviderInput} you can hand to `registry.add(...)`.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 * Pure Node child_process — works in an Electron main process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentTool, JSONSchema, ToolResultContent } from "../types.js";
import type { ProviderInput } from "../registry/registry.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface McpServerOptions {
  /** Unique provider id used in the registry. */
  id: string;
  /** Display name; defaults to id. */
  name?: string;
  /** Executable to spawn (e.g. "npx"). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Treat all tools as mutating (default true — external tools are opaque). */
  mutates?: boolean;
  /** Handshake/timeout in ms. */
  timeoutMs?: number;
}

/**
 * npx and pnpm dlx optimisation. Detects `npx -y <pkg>` style invocations and
 * returns an args list with cache-friendly flags injected so subsequent calls
 * don't re-hit the registry:
 *   - `npx -y ...`        → `npx -y --prefer-offline ...`  (use cache if warm)
 *   - `npx -y --no ...`   → unchanged (user explicitly asked for offline)
 *   - `pnpm dlx ...`      → unchanged (pnpm's store is already content-addressed)
 *   - everything else     → unchanged
 *
 * `--prefer-offline` makes npx skip the registry check when the package is in
 * the npm cache, so the dominant cost on the second run becomes the actual
 * `npx` process spawn (≈100 ms) instead of a 1–3 s network round-trip.
 */
export function optimizeMcpArgs(command: string, args: readonly string[] | undefined): {
  command: string;
  args: string[];
} {
  const base = command.split("/").pop() ?? command;
  if (base !== "npx") return { command, args: [...(args ?? [])] };
  const list = [...(args ?? [])];
  if (list.includes("--offline") || list.includes("--prefer-offline") || list.includes("--no")) {
    return { command, args: list };
  }
  // `--prefer-offline` is the lowest-impact cache-first flag; npm treats it
  // as "use cache if present, fall back to network". Insert right after the
  // existing `-y`/`--yes` so the user-visible invocation order is preserved.
  const yesIdx = list.findIndex((a) => a === "-y" || a === "--yes");
  if (yesIdx >= 0) {
    list.splice(yesIdx + 1, 0, "--prefer-offline");
  } else {
    list.unshift("--prefer-offline");
  }
  return { command, args: list };
}

/**
 * Best-effort npm cache priming for an `npx -y <pkg> ...` invocation. Spawns
 * `npm cache add <pkg>` and returns a promise that resolves when the cache
 * population finishes (or the spawned child errors / closes).
 *
 * Callers SHOULD await this before calling `addMcpServer` so the subsequent
 * `npx` call finds the package in the npm cache and skips the registry
 * fetch. Without awaiting, the priming races with the spawn and offers no
 * latency win.
 *
 * Safe to call for non-npx commands: it resolves immediately.
 */
export function primeMcpServerCache(
  opts: Pick<McpServerOptions, "command" | "args" | "id">,
): Promise<void> {
  const base = opts.command.split("/").pop() ?? opts.command;
  if (base !== "npx") return Promise.resolve();
  const list = opts.args ?? [];
  // Find the first non-flag arg after `-y`/`--yes`/`--prefer-offline`/etc.
  // That's the package name. Skip args starting with `-` (e.g. `--mcp`).
  const pkg = list.find((a) => !a.startsWith("-"));
  if (!pkg) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      const child = spawn("npm", ["cache", "add", pkg], { stdio: "ignore" });
      const finish = () => {
        resolve();
      };
      child.once("error", finish);
      child.once("close", finish);
      // Best-effort log; the priming child is fire-and-forget.
      console.log(`[mcp] priming npm cache for "${opts.id}" via "npm cache add ${pkg}"`);
    } catch {
      resolve();
    }
  });
}

export class McpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  // Keyed by String(id) so a server echoing the id as a string still matches.
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private stderrTail = "";
  private closed = false;

  constructor(private readonly opts: McpServerOptions) {}

  async start(): Promise<McpToolDef[]> {
    const t0 = Date.now();
    // Inject --prefer-offline for npx so cached packages don't re-hit the
    // registry. The original `opts.command`/`opts.args` are preserved on the
    // instance for diagnostic logging; only the spawn uses the optimised set.
    const { command, args } = optimizeMcpArgs(this.opts.command, this.opts.args);
    this.proc = spawn(command, args, {
      env: { ...process.env, ...this.opts.env },
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const tSpawn = Date.now() - t0;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Drain stderr so a chatty server can't fill the pipe buffer and deadlock.
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
    this.proc.on("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("MCP server closed"));
      this.pending.clear();
    });
    this.proc.on("error", (err) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    // On any handshake failure, kill the child so it can't leak.
    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "turing-harness", version: "0.1.0" },
      });
      this.notify("notifications/initialized", {});
      const listed = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
      // Per-server cost breakdown. `tSpawn` is the child-process creation cost
      // (the largest contributor for `npx`/`uv run` commands); `Date.now() - t0`
      // is the full handshake + tools/list wall-clock. Logged once per start
      // so consumers can identify slow servers and consumers parallelising
      // attaches can see the overlapping effect.
      console.log(
        `[mcp] ${this.opts.id} ready in ${Date.now() - t0}ms (spawn=${tSpawn}ms, command=${this.opts.command}${this.opts.args?.length ? " " + this.opts.args.join(" ") : ""}, tools=${listed.tools?.length ?? 0})`,
      );
      return listed.tools ?? [];
    } catch (err) {
      await this.stop();
      const detail = this.stderrTail.trim();
      throw new Error(
        `MCP server "${this.opts.id}" failed to start: ${(err as Error).message}${detail ? `\nstderr: ${detail}` : ""}`,
      );
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // non-JSON stderr-ish noise on stdout
      }
      const key = msg.id != null ? String(msg.id) : undefined;
      if (key !== undefined && this.pending.has(key)) {
        const p = this.pending.get(key)!;
        this.pending.delete(key);
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      }
    }
  }

  private send(payload: object): void {
    if (!this.proc || this.closed) throw new Error("MCP server not running");
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const key = String(id);
    const timeout = this.opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`MCP request "${method}" timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: ToolResultContent[]; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    const content: ToolResultContent[] = (result.content ?? []).map((c) => {
      if (c.type === "image" && c.data)
        return { type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" };
      return { type: "text", text: c.text ?? JSON.stringify(c) };
    });
    return { content, isError: result.isError ?? false };
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.proc?.kill();
  }
}

/**
 * Connect to an MCP server and return a ProviderInput ready for `registry.add`.
 * Each MCP tool becomes an AgentTool that proxies through the live client.
 */
export async function connectMcpServer(opts: McpServerOptions): Promise<ProviderInput> {
  const client = new McpClient(opts);
  const toolDefs = await client.start();

  const tools: AgentTool[] = toolDefs.map((def) => ({
    name: def.name,
    description: def.description ?? `MCP tool ${def.name}`,
    parameters: def.inputSchema ?? { type: "object", properties: {} },
    mutates: opts.mutates ?? true,
    async execute(_id, args, ctx) {
      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["mcp", `mcp:${opts.id}`, `tool:${def.name}`],
        message: `call ${def.name}`,
        data: args,
      });
      try {
        const { content, isError } = await client.callTool(def.name, args);
        const output = content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n");
        return { output: output || (isError ? "error" : "ok"), content, isError };
      } catch (err) {
        return { output: `MCP call failed: ${(err as Error).message}`, isError: true };
      }
    },
  }));

  return {
    id: opts.id,
    kind: "mcp",
    source: "external",
    name: opts.name ?? opts.id,
    tools,
    dispose: () => client.stop(),
    metadata: { command: opts.command, args: opts.args, transport: "stdio" },
  };
}
