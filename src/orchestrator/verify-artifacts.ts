/**
 * A per-run home for verification artifacts (logs/screenshots the host or user
 * drops during the run-handoff), so the run-handoff and the verification loop
 * agree on a single path without scattering evidence across `os.tmpdir()`.
 *
 * Layout: `<cwd>/.turing/verify/<runId>/`. `.turing/` is already gitignored by
 * both turing-harness and OpenWaggleMain. The directory is created lazily and
 * never throws — a failure to create it degrades to "no evidence dir", which
 * the run-handoff handles by skipping the user-driven path.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** `.turing/verify` — sibling of `.turing/screenshots/` used by media_analysis. */
const VERIFY_ROOT = path.join(".turing", "verify");

/** A fresh, run-scoped id. */
export function newRunId(): string {
  return `run-${Date.now()}-${randomBytes(2).toString("hex")}`;
}

/** Absolute path to a run's evidence directory. Does not create it. */
export function runArtifactDir(cwd: string, runId: string): string {
  return path.join(cwd, VERIFY_ROOT, runId);
}

/**
 * Lazily create and return the run's evidence directory. Returns `undefined`
 * on any error — callers treat a missing dir as "user-driven evidence off".
 */
export async function ensureArtifactDir(cwd: string, runId: string): Promise<string | undefined> {
  const dir = runArtifactDir(cwd, runId);
  try {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/** List evidence files a user/host dropped in the run's dir, newest first. */
export async function listEvidence(dir: string | undefined): Promise<string[]> {
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((n) => !n.startsWith("."))
      .map((n) => path.join(dir, n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write a blob the agent captured to the run's evidence dir. Used by the
 * run-handoff to persist host-injected evidence. Best-effort: returns the path
 * on success, `undefined` on failure.
 */
export async function writeEvidence(
  dir: string | undefined,
  name: string,
  data: Uint8Array,
): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    const file = path.join(dir, name);
    await fs.writeFile(file, data);
    return file;
  } catch {
    return undefined;
  }
}

/** Sync variant for cheap existence checks inside the verify loop. */
export function evidenceDirExists(dir: string | undefined): boolean {
  if (!dir) return false;
  try {
    return fsSync.existsSync(dir);
  } catch {
    return false;
  }
}
