/**
 * bash LISTEN mode (`background: true, waitMs`) — the sleep/tail killer.
 *
 * A real run started a flutter build in the background, got "pending", and then
 * burned its turns on `sleep 30 && tail -n 80 <log>` loops (one tail even asked
 * for a 300s blocking timeout). LISTEN mode makes ONE tool call do the waiting:
 * it watches the output stream and returns on the outcome — ready, failed,
 * exited (code 0 = success), or settled (output line-quiet for debounceMs).
 * These tests pin each outcome against real short-lived processes.
 *
 * Run via: npm test. Timing-margined, offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CODING_TOOLS } from "../dist/index.js";

const bashTool = CODING_TOOLS.find((t) => t.name === "bash");

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `bash-listen-${name}-`));
}

const ctx = (cwd, signal) => ({ cwd, log: () => {}, ...(signal ? { signal } : {}) });

// Generous debounce (500ms floor) and wait windows: these are outcome tests,
// not stopwatch tests.
const D = 600;

test("ready: a server-style startup resolves on the ready line, not on a timer", async () => {
  const dir = await scratch("ready");
  const res = await bashTool.execute("b1", {
    command: "echo 'waiting'; sleep 0.3; echo 'ready in 47 ms'; sleep 5",
    background: true,
    waitMs: 8000,
    debounceMs: D,
  }, ctx(dir));
  assert.notEqual(res.isError, true, res.output);
  assert.match(res.output, /Startup confirmed/);
  assert.equal(res.details.status, "ready");
});

test("failed: an error line resolves as a failure with the log", async () => {
  const dir = await scratch("fail");
  const res = await bashTool.execute("b2", {
    command: "echo 'starting'; sleep 0.3; echo 'Error: cannot find module'; sleep 5",
    background: true,
    waitMs: 8000,
    debounceMs: D,
  }, ctx(dir));
  assert.equal(res.isError, true);
  assert.equal(res.details.status, "failed");
  assert.match(res.output, /cannot find module/);
});

test("exited: a clean exit code 0 is reported as COMPLETED (build success)", async () => {
  const dir = await scratch("exit0");
  const res = await bashTool.execute("b3", {
    command: "echo 'compiling'; sleep 0.3; echo 'done'",
    background: true,
    waitMs: 8000,
    debounceMs: D,
  }, ctx(dir));
  assert.notEqual(res.isError, true, res.output);
  assert.equal(res.details.status, "exited");
  assert.equal(res.details.exitCode, 0);
  assert.match(res.output, /COMPLETED \(exit code 0\)/);
});

test("failed: a non-zero exit is a failure, not a settle", async () => {
  const dir = await scratch("exit3");
  const res = await bashTool.execute("b4", {
    command: "echo 'compiling'; sleep 0.3; exit 3",
    background: true,
    waitMs: 8000,
    debounceMs: D,
  }, ctx(dir));
  assert.equal(res.isError, true);
  assert.equal(res.details.status, "failed");
  assert.equal(res.details.exitCode, 3);
});

test("settled: output goes line-quiet while the process lives — reported, with no sleep-polling taught", async () => {
  const dir = await scratch("settled");
  const res = await bashTool.execute("b5", {
    // Prints two lines then goes quiet for a long time: no ready/fail pattern,
    // no exit — the debounce is the only thing that can resolve this call.
    command: "echo 'phase 1 done'; sleep 0.4; echo 'phase 2 queued'; sleep 30",
    background: true,
    waitMs: 10000,
    debounceMs: D,
  }, ctx(dir));
  assert.notEqual(res.isError, true, res.output);
  assert.equal(res.details.status, "settled");
  assert.ok(res.details.quietForMs >= D - 100, `quiet for ${res.details.quietForMs}ms`);
  assert.match(res.output, /SETTLED/);
  assert.match(res.output, /Do NOT sleep or tail-poll/);
});

test("timeout: output keeps changing past waitMs — honest timeout, not an error", async () => {
  const dir = await scratch("timeout");
  const res = await bashTool.execute("b6", {
    command: "for i in $(seq 1 100); do echo line $i; sleep 0.05; done",
    background: true,
    waitMs: 1500,
    debounceMs: D,
  }, ctx(dir));
  assert.notEqual(res.isError, true, res.output);
  assert.equal(res.details.status, "timeout");
  assert.match(res.output, /still CHANGING|Still running/);
});

test("already running: waitMs attaches the listener to the running copy instead of spawning a twin", async () => {
  const dir = await scratch("attach");
  const first = await bashTool.execute("b7", {
    command: "echo 'booting'; sleep 0.5; echo 'ready in 100 ms'; sleep 20",
    background: true,
    // No waitMs: returns pending fast, leaving the process live.
    pollMs: 250,
  }, ctx(dir));
  assert.ok(first.details.logFile, "pending result carries the log path");
  const second = await bashTool.execute("b8", {
    command: "echo 'booting'; sleep 0.5; echo 'ready in 100 ms'; sleep 20",
    background: true,
    waitMs: 8000,
    debounceMs: D,
  }, ctx(dir));
  assert.match(second.output, /already running/i);
  assert.equal(second.details.status, "ready", "the listener resolved on the FIRST copy's ready line");
  assert.equal(second.details.logFile, first.details.logFile, "same log — no twin was spawned");
});

test("pending (legacy): no waitMs keeps the old shape, and points at LISTEN instead of tail", async () => {
  const dir = await scratch("legacy");
  const res = await bashTool.execute("b9", {
    command: "echo 'booting'; sleep 30",
    background: true,
    pollMs: 300,
  }, ctx(dir));
  assert.notEqual(res.isError, true, res.output);
  assert.equal(res.details.status, "pending");
  assert.match(res.output, /waitMs/, "teaches LISTEN, not tail-polling");
  assert.doesNotMatch(res.output, /tail -n 80/);
});
