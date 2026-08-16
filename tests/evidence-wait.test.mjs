/**
 * The user-driven verify wait — the missing "wait for the user to run the app"
 * state between INSTRUMENT and INSPECT.
 *
 * Bounded, abort-aware, non-fatal: returns files that appear/change after a
 * baseline snapshot, or [] on timeout. Uses real fs in a temp dir; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { waitForUserEvidence } from "../dist/orchestrator/evidence-wait.js";

const touch = (p, body = "x") => fs.writeFile(p, body);

test("times out with an empty list when nothing appears (non-fatal, timedOut true)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evwait-empty-"));
  const r = await waitForUserEvidence({ dir, deadlineMs: 120, pollMs: 40 });
  assert.deepEqual(r.files, []);
  assert.equal(r.timedOut, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("returns a file that appears after baseline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evwait-appear-"));
  const target = path.join(dir, "screenshot.png");
  // Start the wait; shortly after, the "user" drops evidence.
  const waitP = waitForUserEvidence({ dir, deadlineMs: 2000, pollMs: 40 });
  setTimeout(() => touch(target), 120);
  const r = await waitP;
  assert.equal(r.timedOut, false);
  assert.ok(r.files.includes(target), `found ${r.files.join(",")}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("returns a file whose mtime advances after baseline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evwait-mtime-"));
  const target = path.join(dir, "app.log");
  await touch(target, "before"); // present at baseline
  const waitP = waitForUserEvidence({ dir, deadlineMs: 2000, pollMs: 40 });
  setTimeout(() => touch(target, "after the user ran the app"), 120);
  const r = await waitP;
  assert.equal(r.timedOut, false);
  assert.ok(r.files.includes(target));
  await fs.rm(dir, { recursive: true, force: true });
});

test("a named userEvidencePath appearing mid-wait is returned", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evwait-named-"));
  const named = path.join(dir, "pasted.log");
  const waitP = waitForUserEvidence({ dir, userEvidencePath: named, deadlineMs: 2000, pollMs: 40 });
  setTimeout(() => touch(named), 120);
  const r = await waitP;
  assert.equal(r.timedOut, false);
  assert.ok(r.files.includes(named));
  await fs.rm(dir, { recursive: true, force: true });
});

test("aborts promptly and does not throw", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evwait-abort-"));
  const ac = new AbortController();
  const waitP = waitForUserEvidence({ dir, deadlineMs: 10000, pollMs: 1000, signal: ac.signal });
  setTimeout(() => ac.abort(), 60);
  const r = await waitP;
  assert.deepEqual(r.files, []);
  assert.ok(r.waitedMs < 2000, `abort should return promptly, waited ${r.waitedMs}ms`);
  await fs.rm(dir, { recursive: true, force: true });
});
