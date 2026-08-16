/**
 * The "wait for the user to run the app" step that was missing from the verify
 * flow.
 *
 * When the run-handoff settles on USER mode ("I'll run it myself"), the agent
 * instruments the code and then the USER runs the app. There was no first-class
 * wait for that: the old verify round told the model "evidence is dropped at
 * <dir>, read it" in the same breath, so the model read an empty directory,
 * concluded nothing was there, and either gave up or went off and drove the app
 * itself — the exact handoff the user had just declined. This makes the wait a
 * real, bounded, visible state between INSTRUMENT and INSPECT.
 *
 * It polls an evidence directory (and/or a named path) for files that appear or
 * change after a baseline snapshot, emitting progress while it waits. It is
 * deliberately non-fatal: a timeout returns an empty list and the caller
 * proceeds to INSPECT, where the model either reads what arrived late or
 * honestly reports the change unverified. Aborts are honoured promptly.
 *
 * This only watches for files the USER drops (a screenshot, a log they saved).
 * The trace the agent's own probes produce is a different channel — the model
 * reads it with `activity_collect { waitMs }` at the INSPECT stage, which polls
 * the trace file itself. The two are complementary, not redundant.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Default wait: long enough to boot an app and reproduce a flow, not unbounded. */
const DEFAULT_DEADLINE_MS = 180_000;
const DEFAULT_POLL_MS = 1_500;

export interface WaitForUserEvidenceOptions {
  /** Directory the user was told to drop evidence into. */
  dir?: string;
  /** A specific path the user named as their evidence. */
  userEvidencePath?: string;
  /** Maximum time to wait. Default 180s. */
  deadlineMs?: number;
  /** Poll interval. Default 1.5s (mirrors `activity_collect`'s tick). */
  pollMs?: number;
  signal?: AbortSignal;
  /** Progress callback: fired on each poll with how long we have waited. */
  onProgress?: (note: { waitedMs: number; found: string[] }) => void;
}

export interface UserEvidenceResult {
  /** Absolute paths of files that appeared or changed during the wait. */
  files: string[];
  /** True if the deadline elapsed before anything appeared. */
  timedOut: boolean;
  /** How long the wait actually lasted, in ms. */
  waitedMs: number;
}

interface EntrySignature {
  path: string;
  mtimeMs: number;
}

async function snapshot(dir: string | undefined): Promise<EntrySignature[]> {
  if (!dir) return [];
  try {
    const names = await readdir(dir);
    const out: EntrySignature[] = [];
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const s = await stat(p);
        if (s.isFile()) out.push({ path: p, mtimeMs: s.mtimeMs });
      } catch {
        // entry vanished between readdir and stat — ignore.
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function sigOfFile(p: string | undefined): Promise<EntrySignature | undefined> {
  if (!p) return undefined;
  try {
    const s = await stat(p);
    if (s.isFile()) return { path: p, mtimeMs: s.mtimeMs };
  } catch {
    // not present yet.
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Wait until evidence appears in {@link WaitForUserEvidenceOptions.dir} or at
 * {@link WaitForUserEvidenceOptions.userEvidencePath}, or the deadline elapses.
 * Returns the files that appeared/changed after the baseline snapshot taken on
 * entry. Never throws — a poll error or abort returns what was found so far.
 */
export async function waitForUserEvidence(
  opts: WaitForUserEvidenceOptions,
): Promise<UserEvidenceResult> {
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();

  const baselineDir = await snapshot(opts.dir);
  const baselineFile = await sigOfFile(opts.userEvidencePath);

  // A named path that already existed counts if it CHANGES during the wait;
  // everything else is "appeared after baseline".
  for (;;) {
    if (opts.signal?.aborted) {
      return { files: [], timedOut: false, waitedMs: Date.now() - start };
    }
    const current = await snapshot(opts.dir);
    const named = await sigOfFile(opts.userEvidencePath);
    const found: string[] = [];
    for (const e of current) {
      const was = baselineDir.find((b) => b.path === e.path);
      if (!was || e.mtimeMs > was.mtimeMs) found.push(e.path);
    }
    if (named && (!baselineFile || named.mtimeMs > baselineFile.mtimeMs) && !found.includes(named.path)) {
      found.push(named.path);
    }

    opts.onProgress?.({ waitedMs: Date.now() - start, found });

    if (found.length > 0) {
      return { files: found, timedOut: false, waitedMs: Date.now() - start };
    }
    if (Date.now() - start >= deadline) {
      return { files: [], timedOut: true, waitedMs: Date.now() - start };
    }
    await sleep(pollMs, opts.signal);
  }
}
