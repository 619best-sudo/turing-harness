/**
 * Build readiness before capture.
 *
 * The root cause of "started QA on a stale app while the new build was still
 * compiling": `activity_trace_start { startCommand }` returned after a fixed
 * 2.5s regardless of whether the dev server was actually up. It now polls the
 * port until it accepts connections (the "built and serving" signal). These
 * tests pin the two helpers that implement that poll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { waitForPort, portIsListening, waitForAppReady } from "../dist/tools/builtin/activity-monitor.js";

/** A port that is NOT listening: bind to :0, take the port, close the server. */
async function closedPort() {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test("portIsListening is true for a port a server is bound to, false for a closed one", async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  assert.equal(await portIsListening(port), true);
  await new Promise((r) => server.close(r));
  // After close it is no longer listening.
  assert.equal(await portIsListening(port), false);
});

test("waitForPort resolves ready quickly when a server is already up", async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const r = await waitForPort(port, 5000);
  assert.equal(r.ready, true);
  assert.ok(r.waitedMs < 4000, `should resolve fast, waited ${r.waitedMs}ms`);
  await new Promise((r) => server.close(r));
});

test("waitForPort waits for a server that boots shortly after, then reports ready", async () => {
  const port = (await closedPort()) + 1; // unlikely to collide
  const server = http.createServer(() => {});
  // Bring the server up after ~600ms, mid-poll.
  setTimeout(() => server.listen(port, "127.0.0.1", () => {}), 600);
  const r = await waitForPort(port, 5000);
  assert.equal(r.ready, true);
  await new Promise((r) => server.close(r)).catch(() => {});
});

test("waitForPort returns not-ready within the deadline when nothing comes up", async () => {
  const port = await closedPort();
  const r = await waitForPort(port, 2200);
  assert.equal(r.ready, false);
  assert.ok(r.waitedMs >= 1500, `should have polled, waited ${r.waitedMs}ms`);
  assert.ok(r.waitedMs <= 4000, `should respect the deadline, waited ${r.waitedMs}ms`);
});

// ---- general readiness: web (port) vs mobile (log marker) vs failure --------

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function tmpTrace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ready-"));
  return path.join(dir, "trace.log");
}

test("waitForAppReady: a WEB command is ready when its port accepts connections", async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const traceFile = await tmpTrace();
  const r = await waitForAppReady({ traceFile, port, isWeb: true, deadlineMs: 5000 });
  assert.equal(r.ready, true);
  assert.equal(r.reason, "port");
  await new Promise((r) => server.close(r));
  await fs.rm(path.dirname(traceFile), { recursive: true, force: true });
});

test("waitForAppReady: a MOBILE command (no port) is ready on a launch marker, not a port", async () => {
  const traceFile = await tmpTrace();
  // Simulate `flutter run` printing its ready line after ~600ms (mid-poll).
  setTimeout(() => fs.appendFile(traceFile, "\nSyncing files to device iPhone\nFlutter run key commands.\n"), 600);
  const r = await waitForAppReady({ traceFile, port: 52345, isWeb: false, deadlineMs: 5000 });
  assert.equal(r.ready, true);
  assert.equal(r.reason, "marker", "mobile readiness comes from the log, not the unused port");
  await fs.rm(path.dirname(traceFile), { recursive: true, force: true });
});

test("waitForAppReady: a fatal process exit returns failed FAST, not after the deadline", async () => {
  const traceFile = await tmpTrace();
  setTimeout(() => fs.appendFile(traceFile, "\n# Process exited with code 1\n"), 400);
  const r = await waitForAppReady({ traceFile, isWeb: false, deadlineMs: 20000 });
  assert.equal(r.ready, false);
  assert.ok(["failed", "exited"].includes(r.reason), `reason ${r.reason}`);
  assert.ok(r.waitedMs < 5000, `should return fast on failure, waited ${r.waitedMs}ms`);
  await fs.rm(path.dirname(traceFile), { recursive: true, force: true });
});

test("waitForAppReady: nothing happening → timeout at the deadline", async () => {
  const traceFile = await tmpTrace();
  const r = await waitForAppReady({ traceFile, isWeb: false, deadlineMs: 2200 });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "timeout");
  await fs.rm(path.dirname(traceFile), { recursive: true, force: true });
});
