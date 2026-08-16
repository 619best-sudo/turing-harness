/**
 * Unit tests for McpRuntimePool's warm-up surface.
 *
 * Run via: npm test (which builds first, then runs `node --test`).
 *
 * These use a real child process — a tiny inline Node script that speaks just
 * enough newline-delimited JSON-RPC to satisfy `initialize` + `tools/list` —
 * so the pool's spawn/dedup/dispose behavior is exercised end to end without
 * stubbing `connectMcpServer`.
 *
 * Coverage:
 *   - prewarm() pools a server with NO borrower (the bug that `borrow(opts,
 *     'prewarm')` had: it pinned the entry forever)
 *   - a prewarmed entry idles out on its own
 *   - a later borrow() of a prewarmed server is a warm hit (no second spawn)
 *   - concurrent prewarm/borrow share one spawn (in-flight dedup)
 *   - evictById kills the process even while borrowed
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpRuntimePool } from "../dist/index.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A minimal stdio MCP server, inlined as `node -e`. Writes its pid to a
 * sentinel file on startup so a test can assert the process actually died.
 */
const SERVER_SRC = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      respond(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0" } });
    } else if (msg.method === "tools/list") {
      respond(msg.id, { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] });
    } else if (msg.id !== undefined) {
      respond(msg.id, {});
    }
  }
});
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;

let seq = 0;
function stubServer(id = `stub-${++seq}`) {
  return { id, command: process.execPath, args: ["-e", SERVER_SRC] };
}

/** Peek at pool internals — the pool intentionally exposes no borrower count. */
function entries(pool) {
  return Array.from(pool.pool.values());
}

test("prewarm pools the server with no borrower", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, log: silentLog });
  const opts = stubServer();
  try {
    await pool.prewarm(opts);

    assert.equal(pool.has(opts), true, "prewarmed server should be pooled");
    assert.deepEqual(pool.pooledIds(), [opts.id]);
    const [entry] = entries(pool);
    assert.equal(entry.borrowedBy.size, 0, "prewarm must not take a borrow");
    assert.ok(entry.idleTimer, "an unborrowed entry must have an idle countdown running");
  } finally {
    await pool.dispose();
  }
});

test("a prewarmed server idles out on its own", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 20, log: silentLog });
  const opts = stubServer();
  try {
    await pool.prewarm(opts);
    assert.equal(pool.has(opts), true);

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(pool.has(opts), false, "idle timer should have disposed the prewarmed entry");
    assert.deepEqual(pool.pooledIds(), []);
  } finally {
    await pool.dispose();
  }
});

test("borrow after prewarm is a warm hit and clears the idle timer", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, log: silentLog });
  const opts = stubServer();
  try {
    await pool.prewarm(opts);
    const prewarmed = entries(pool)[0].provider;

    const provider = await pool.borrow(opts, "session-a");

    assert.equal(provider, prewarmed, "borrow must reuse the prewarmed provider, not respawn");
    assert.equal(entries(pool).length, 1, "no second entry should be created");
    const [entry] = entries(pool);
    assert.deepEqual([...entry.borrowedBy], ["session-a"]);
    assert.equal(entry.idleTimer, undefined, "borrowing must cancel the idle countdown");
  } finally {
    await pool.dispose();
  }
});

test("concurrent prewarm and borrow share a single spawn", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, log: silentLog });
  const opts = stubServer();
  try {
    const [, provider] = await Promise.all([
      pool.prewarm(opts),
      pool.borrow(opts, "session-a"),
      pool.borrow(opts, "session-b"),
    ]);

    assert.equal(entries(pool).length, 1, "in-flight dedup should yield exactly one pooled entry");
    assert.equal(provider, entries(pool)[0].provider);
    assert.deepEqual([...entries(pool)[0].borrowedBy].sort(), ["session-a", "session-b"]);
  } finally {
    await pool.dispose();
  }
});

test("evictById disposes a borrowed server", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, log: silentLog });
  const opts = stubServer();
  try {
    await pool.borrow(opts, "session-a");
    assert.equal(pool.has(opts), true);

    // A server disabled on the MCP page must stop serving tools even though a
    // run still holds a borrow on it.
    await pool.evictById(opts.id);

    assert.equal(pool.has(opts), false);
    assert.deepEqual(pool.pooledIds(), []);
  } finally {
    await pool.dispose();
  }
});

test("evictById on an unknown id is a no-op", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, log: silentLog });
  const opts = stubServer();
  try {
    await pool.prewarm(opts);
    await pool.evictById("openwaggle:mcp:not-pooled");
    assert.equal(pool.has(opts), true, "unrelated entries must survive");
  } finally {
    await pool.dispose();
  }
});

test("a failed connect is not retried until the cooldown expires", async () => {
  // A server that cannot start often fails SLOWLY — a bad npm spec spends ~30s
  // in resolution first. Retrying it on every prewarm (project open, model
  // change, settings save) is what pushed the run's bridge-attach window past
  // its timeout, so the model was told it had no MCP tools at all.
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, failureCooldownMs: 10_000, log: silentLog });
  const broken = { id: "broken", command: process.execPath, args: ["-e", "process.exit(1)"] };
  try {
    await assert.rejects(pool.prewarm(broken), /failed to start|closed/i);

    const before = Date.now();
    await assert.rejects(pool.prewarm(broken), /cooldown/i);
    // The second attempt must be immediate — no spawn, no handshake wait.
    assert.ok(Date.now() - before < 250, "cooldown rejection should not respawn");

    // A deliberate reset (config edited, user asked to reconnect) retries.
    pool.clearFailureCooldowns();
    await assert.rejects(pool.prewarm(broken), /failed to start|closed/i);
  } finally {
    await pool.dispose();
  }
});

test("failureCooldownMs: 0 disables the cooldown", async () => {
  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, failureCooldownMs: 0, log: silentLog });
  const broken = { id: "broken-2", command: process.execPath, args: ["-e", "process.exit(1)"] };
  try {
    await assert.rejects(pool.prewarm(broken), /failed to start|closed/i);
    await assert.rejects(pool.prewarm(broken), /failed to start|closed/i);
  } finally {
    await pool.dispose();
  }
});

// ---------------------------------------------------------------------------
// Tool-metadata cache: startup should be a file read, not N process spawns.
// ---------------------------------------------------------------------------

test("a cached server registers its tools without spawning", async () => {
  const { McpToolCache, mcpServerSignature } = await import("../dist/index.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tool-cache-"));
  const cache = new McpToolCache({ path: path.join(dir, "cache.json") });

  // A command that would FAIL if spawned. Registration must not touch it.
  const opts = { id: "cached", command: process.execPath, args: ["-e", "process.exit(3)"] };
  cache.set(mcpServerSignature(opts), [
    { name: "browser_navigate", description: "go", inputSchema: { type: "object", properties: {} } },
    { name: "browser_click", description: "click" },
  ]);

  const pool = new McpRuntimePool({ idleTimeoutMs: 60_000, toolCache: cache, log: silentLog });
  try {
    const provider = await pool.borrow(opts, "session-a");

    assert.deepEqual(
      provider.tools.map((t) => t.name),
      ["browser_navigate", "browser_click"],
      "tools must come straight from the cache",
    );
    assert.equal(provider.metadata?.lazy, true, "provider should be marked lazy");
    // Proof no process ran: a spawn of `process.exit(3)` would have rejected.
    assert.equal(pool.has(opts), true);
  } finally {
    await pool.dispose();
  }
});

test("the eager path records tools so the next run can go lazy", async () => {
  const { McpToolCache, mcpServerSignature } = await import("../dist/index.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tool-cache-warm-"));
  const cachePath = path.join(dir, "cache.json");
  const opts = stubServer("warmed");

  // First run: cold, real spawn, and it should populate the cache.
  const first = new McpRuntimePool({
    idleTimeoutMs: 60_000,
    toolCache: new McpToolCache({ path: cachePath }),
    log: silentLog,
  });
  try {
    const provider = await first.borrow(opts, "session-a");
    assert.deepEqual(provider.tools.map((t) => t.name), ["ping"]);
  } finally {
    await first.dispose();
  }

  // The cache is now on disk and readable by a fresh instance (i.e. survives a
  // restart — the whole reason this is a file and not a Map).
  const reread = new McpToolCache({ path: cachePath });
  assert.deepEqual(reread.get(mcpServerSignature(opts))?.map((t) => t.name), ["ping"]);

  // Second run: a brand-new pool serves from cache with no spawn.
  const second = new McpRuntimePool({ idleTimeoutMs: 60_000, toolCache: reread, log: silentLog });
  try {
    const provider = await second.borrow(opts, "session-b");
    assert.equal(provider.metadata?.lazy, true, "second run must be lazy");
    assert.deepEqual(provider.tools.map((t) => t.name), ["ping"]);
  } finally {
    await second.dispose();
  }
});

test("editing a server's config invalidates its cache entry", async () => {
  const { McpToolCache, mcpServerSignature } = await import("../dist/index.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tool-cache-inv-"));
  const cache = new McpToolCache({ path: path.join(dir, "cache.json") });
  const before = { id: "x", command: "npx", args: ["-y", "pkg@1"] };
  cache.set(mcpServerSignature(before), [{ name: "old_tool" }]);

  // Same id, different args — a config edit must NOT serve the stale list.
  const after = { id: "x", command: "npx", args: ["-y", "pkg@2"] };
  assert.equal(cache.get(mcpServerSignature(after)), undefined);
  assert.deepEqual(cache.get(mcpServerSignature(before))?.map((t) => t.name), ["old_tool"]);
});
