/**
 * The environment shell commands run in.
 *
 * Regression target: a desktop-app host launched from Finder has launchd's
 * four-directory PATH, so every real tool answers `command not found` and the
 * model concludes the machine has no toolchain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";

import {
  mergePathEntries,
  mergeShellEnv,
  resolveShellEnvironment,
  resetShellEnvironment,
} from "../dist/exec/shell-env.js";

test("mergePathEntries unions, keeps first-seen precedence, drops empties", () => {
  const merged = mergePathEntries("/a:/b", "/b:/c", ":/c:/d:");
  assert.equal(merged, ["/a", "/b", "/c", "/d"].join(path.delimiter));
});

test("login PATH wins precedence over the parent's, and neither is lost", () => {
  const { env } = mergeShellEnv(
    { PATH: "/usr/bin:/bin", HOST_ONLY: "keep" },
    { PATH: "/opt/homebrew/bin:/usr/bin", LOGIN_ONLY: "added" },
  );
  const dirs = env.PATH.split(path.delimiter);
  assert.ok(dirs.indexOf("/opt/homebrew/bin") < dirs.indexOf("/usr/bin"), "login entries lead");
  assert.ok(dirs.includes("/bin"), "parent entries survive");
});

test("host-set variables are never overwritten by the login shell", () => {
  const { env } = mergeShellEnv(
    { PATH: "/usr/bin", OPENROUTER_API_KEY: "host-value" },
    { PATH: "/usr/bin", OPENROUTER_API_KEY: "stale-shell-value", JAVA_HOME: "/opt/jdk" },
  );
  assert.equal(env.OPENROUTER_API_KEY, "host-value", "host wins on conflict");
  assert.equal(env.JAVA_HOME, "/opt/jdk", "login-only keys are added");
});

test("a bare launchd PATH still gains the standard install directories", () => {
  const { env, addedPathDirs } = mergeShellEnv({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, undefined);
  assert.ok(env.PATH.includes("/opt/homebrew/bin") || process.platform === "win32");
  assert.ok(addedPathDirs.length > 0, "reports what it added");
});

test("Electron plumbing does not leak into user commands", () => {
  const { env } = mergeShellEnv(
    { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require=/electron/thing" },
    { PATH: "/usr/bin" },
    { electron: true },
  );
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("the user's own NODE_OPTIONS survives the Electron strip", () => {
  const { env } = mergeShellEnv(
    { PATH: "/usr/bin", NODE_OPTIONS: "--require=/electron/thing" },
    { PATH: "/usr/bin", NODE_OPTIONS: "--max-old-space-size=8192" },
    { electron: true },
  );
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=8192");
});

test("resolveShellEnvironment yields a usable shell + PATH, and memoizes", async () => {
  resetShellEnvironment();
  const first = await resolveShellEnvironment();
  assert.ok(first.env.PATH, "has a PATH");
  assert.ok(first.shell, "has a shell to run commands with");
  assert.ok(["login-shell", "process", "windows"].includes(first.source));
  const second = await resolveShellEnvironment();
  assert.equal(first, second, "cached across calls");
});

test("the resolved PATH is at least as complete as the parent's", async () => {
  resetShellEnvironment();
  const { env } = await resolveShellEnvironment();
  const resolved = new Set(env.PATH.split(path.delimiter));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) assert.ok(resolved.has(dir), `kept ${dir}`);
  }
});

test("on macOS the probe recovers a login-only PATH entry", async (t) => {
  if (process.platform !== "darwin") return t.skip("darwin only");
  resetShellEnvironment();
  const { env, source } = await resolveShellEnvironment();
  if (source !== "login-shell") return t.skip("no login shell available here");
  // Homebrew's shellenv runs from a login file on every standard macOS setup.
  assert.ok(
    env.PATH.includes("/opt/homebrew/bin") || env.PATH.includes("/usr/local/bin"),
    "a real login shell contributes a package-manager bin dir",
  );
  assert.ok(env.HOME === undefined || env.HOME === os.homedir());
});
