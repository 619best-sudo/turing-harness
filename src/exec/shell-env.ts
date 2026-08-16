/**
 * The environment every shell command in this harness actually runs in.
 *
 * WHY THIS FILE EXISTS
 *
 * `child_process.exec("flutter analyze")` runs `/bin/sh -c` with whatever
 * `process.env` the PARENT happened to have. That is fine when the parent is a
 * CLI the user launched from their terminal — it inherited the terminal's env,
 * which the login shell built from `.zprofile` / `.bash_profile` / `.profile`.
 * It is NOT fine when the parent is a desktop app: macOS launches GUI processes
 * from `launchd`, whose PATH is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else. Homebrew, nvm/volta/asdf, pyenv, the Android SDK, `fvm`, `pnpm`, the
 * Flutter SDK — none of them are on that PATH.
 *
 * The observable symptom is a run where `git` works and every real tool answers
 * `command not found`, which the model reads as "this environment has no
 * toolchain" and then declares the work unverifiable. That is a lie caused by
 * process plumbing, and it is invisible from inside the model.
 *
 * So: resolve the user's LOGIN SHELL environment once per process, cache it, and
 * hand it to every command the harness runs. The probe is a real login shell
 * (`$SHELL -lic 'env'`), which is the only way to learn what the user's own
 * terminal would have had, because that env is defined by rc files we must not
 * try to parse ourselves.
 *
 * THREE DELIBERATE CHOICES
 *
 *  1. PATH is a UNION, never a replacement. The login shell's entries come
 *     first (the user's own precedence — a pyenv shim must beat /usr/bin/python),
 *     then whatever the parent process already had (a host that deliberately
 *     injected a directory keeps it), then a fixed list of standard install
 *     locations as a floor for when the probe fails entirely.
 *
 *  2. Everything else is ADDITIVE. Keys the parent set win, because a host that
 *     put `OPENROUTER_API_KEY` in `process.env` means it; keys only the login
 *     shell has (JAVA_HOME, ANDROID_HOME, FLUTTER_ROOT, LANG…) get added. The
 *     one exception is Electron's own plumbing, stripped below — `NODE_OPTIONS`
 *     and `ELECTRON_RUN_AS_NODE` leaking into a child `node` breaks it outright.
 *
 *  3. Commands run under the USER'S shell, not `/bin/sh`. `/bin/sh` on macOS is
 *     bash in POSIX mode: `[[ ]]`, `source`, `**` globs and process substitution
 *     all fail there but work in the terminal the user tested the command in.
 *     A command that works when the user types it must work when we run it.
 */
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface ShellEnvironment {
  /** Environment to hand to every spawned command. */
  env: NodeJS.ProcessEnv;
  /** Shell executable to run commands with (`exec`'s `shell` option). */
  shell: string;
  /** Where `env` came from — `process` means the login-shell probe did not work. */
  source: "login-shell" | "process" | "windows";
  /** One-line diagnostic, logged once so a broken probe is visible in the trace. */
  note: string;
  /** PATH directories gained from the login shell that the parent did not have. */
  addedPathDirs: string[];
}

/**
 * Marker wrapping the probe's payload.
 *
 * rc files print things — version notices, `fortune`, a framework banner — and
 * that noise lands on the same stdout as `env`. Delimiting the payload is what
 * makes the parse deterministic instead of "hope nothing was printed".
 */
const MARKER = "__TURING_SHELL_ENV_2f8a__";

/**
 * How long the probe may take before it is abandoned.
 *
 * An rc file that blocks (waiting on a network call, or on input it will never
 * get without a tty) must degrade to "use process.env" rather than hang the
 * first shell command of the run. Measured cost of a healthy zsh probe on macOS
 * is well under 200ms.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Standard install locations, appended to PATH as a FLOOR — never a substitute
 * for the login shell.
 *
 * These exist for the case where the probe itself failed (no `$SHELL`, a locked
 * down container, Windows Subsystem edge cases). Without them a failed probe
 * inside a GUI app leaves PATH at launchd's four directories, which is the exact
 * failure this module was written for.
 */
function fallbackPathDirs(): string[] {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  const dirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".mise", "shims"),
    path.join(home, ".rbenv", "shims"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".pub-cache", "bin"),
  ];
  if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "pnpm"));
    dirs.push(path.join(home, "Library", "Android", "sdk", "platform-tools"));
    dirs.push(path.join(home, "Library", "Android", "sdk", "emulator"));
  }
  return dirs;
}

/**
 * Electron plumbing that must not reach a user command.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes a spawned `node` behave as Electron's node
 * fork; `NODE_OPTIONS` from an Electron parent commonly points at loaders that
 * do not exist for the project's own node. Both produce failures that look like
 * the project is broken. They are dropped only when the login shell has no
 * opinion of its own — if the user's profile sets `NODE_OPTIONS`, that wins.
 */
const ELECTRON_ONLY_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_NO_ASAR",
  "ELECTRON_FORCE_IS_PACKAGED",
  "ELECTRON_IS_DEV",
] as const;

function runningUnderElectron(): boolean {
  return Boolean((process.versions as Record<string, string | undefined>).electron) ||
    process.env.ELECTRON_RUN_AS_NODE === "1";
}

/** Candidate shells, best first. */
function shellCandidates(): string[] {
  const out: string[] = [];
  const fromEnv = process.env.SHELL;
  // A login shell of `/sbin/nologin` or `/usr/bin/false` is not a shell.
  if (fromEnv && !/\b(nologin|false)$/.test(fromEnv)) out.push(fromEnv);
  if (process.platform === "darwin") out.push("/bin/zsh");
  out.push("/bin/bash", "/bin/sh");
  return [...new Set(out)];
}

/**
 * Argument sets tried in order.
 *
 *  - `-lic`: login + interactive. Reads BOTH the login files (`.zprofile`,
 *    `.bash_profile`) and the interactive ones (`.zshrc`, `.bashrc`). Most
 *    machines put PATH in one or the other with no consistency, so asking for
 *    both is the only way to reproduce the terminal the user actually uses.
 *  - `-lc`: login only. The fallback for an rc file that misbehaves without a
 *    tty (a prompt framework, a `read`, an `exec` of another shell).
 *  - `-c`: neither. Last resort; usually returns the same env we already have,
 *    but costs nothing to try before giving up.
 */
const PROBE_ARGS: string[][] = [["-lic"], ["-lc"], ["-c"]];

/**
 * `env -0` is NUL-separated, which is the only encoding safe for values that
 * contain newlines (a multi-line `LS_COLORS`, a shell function exported by
 * bash). The `|| env` keeps a shell whose `env` lacks `-0` working; the parser
 * below detects which of the two shapes it got.
 */
const PROBE_SCRIPT = `printf '%s' '${MARKER}'; env -0 2>/dev/null || env; printf '%s' '${MARKER}'`;

function parseProbeOutput(raw: string): NodeJS.ProcessEnv | undefined {
  const first = raw.indexOf(MARKER);
  if (first < 0) return undefined;
  const rest = raw.slice(first + MARKER.length);
  const second = rest.indexOf(MARKER);
  const payload = second >= 0 ? rest.slice(0, second) : rest;
  // NUL-separated when `env -0` worked; newline-separated when it fell back.
  const parts = payload.includes("\0") ? payload.split("\0") : payload.split("\n");
  const env: NodeJS.ProcessEnv = {};
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return Object.keys(env).length ? env : undefined;
}

function probeOnce(shell: string, args: string[]): Promise<NodeJS.ProcessEnv | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [...args, PROBE_SCRIPT], {
        // stderr is dropped on purpose: rc files warn, and a warning is not a
        // failed probe. The marker check below is the real validity test.
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          // Lets a cooperative rc file skip slow interactive-only setup, and
          // makes the probe identifiable if a user ever wonders what ran it.
          TURING_SHELL_ENV_PROBE: "1",
          // Common opt-outs for shell frameworks that phone home on startup.
          DISABLE_AUTO_UPDATE: "true",
          CI: process.env.CI ?? "",
        },
      });
    } catch {
      resolve(undefined);
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value: NodeJS.ProcessEnv | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    // A hung rc file must not keep the host process alive.
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(parseProbeOutput(out)));
  });
}

/** Union of PATH entries, first occurrence wins, empties dropped. */
export function mergePathEntries(...lists: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.join(path.delimiter);
}

/**
 * Combine the probed login env with the parent's, per the rules in the file
 * header. Exported for tests, which must be able to assert the merge without
 * spawning a shell.
 */
export function mergeShellEnv(
  parentEnv: NodeJS.ProcessEnv,
  loginEnv: NodeJS.ProcessEnv | undefined,
  options: { electron?: boolean } = {},
): { env: NodeJS.ProcessEnv; addedPathDirs: string[] } {
  const merged: NodeJS.ProcessEnv = { ...parentEnv };

  if (loginEnv) {
    for (const [key, value] of Object.entries(loginEnv)) {
      // PATH is merged explicitly below; everything else is fill-in-the-blanks
      // so a host-provided value is never silently replaced by a stale one.
      if (key === "PATH" || key === "Path") continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  if (options.electron ?? runningUnderElectron()) {
    for (const key of ELECTRON_ONLY_KEYS) delete merged[key];
    // Keep the user's own NODE_OPTIONS if they have one; drop Electron's.
    if (loginEnv?.NODE_OPTIONS !== undefined) merged.NODE_OPTIONS = loginEnv.NODE_OPTIONS;
    else delete merged.NODE_OPTIONS;
  }

  const parentPath = parentEnv.PATH ?? parentEnv.Path;
  const beforeDirs = new Set((parentPath ?? "").split(path.delimiter).map((d) => d.trim()).filter(Boolean));
  const nextPath = mergePathEntries(loginEnv?.PATH, parentPath, fallbackPathDirs().join(path.delimiter));
  merged.PATH = nextPath;
  // Windows resolves `Path`; keep the two spellings in step rather than leaving
  // a stale one that wins by casing accident.
  if (parentEnv.Path !== undefined) merged.Path = nextPath;

  const addedPathDirs = nextPath
    .split(path.delimiter)
    .filter((dir) => dir && !beforeDirs.has(dir));

  return { env: merged, addedPathDirs };
}

let cached: Promise<ShellEnvironment> | undefined;

/**
 * The environment and shell every command in this harness should use.
 *
 * Memoized for the life of the process: the user's profile does not change
 * mid-run, and paying a shell spawn per `bash` call would be a real cost on the
 * hottest tool in the harness.
 */
export function resolveShellEnvironment(): Promise<ShellEnvironment> {
  if (!cached) cached = computeShellEnvironment();
  return cached;
}

/** Drop the memoized result. For tests, and for a host that changes `SHELL`. */
export function resetShellEnvironment(): void {
  cached = undefined;
}

/**
 * Warm the cache before the first tool call.
 *
 * Optional, and safe to call more than once — a host that knows a run is about
 * to start can pay the probe during idle time instead of inside the first
 * `bash` call. Failures are swallowed; the lazy path handles them identically.
 */
export function primeShellEnvironment(): void {
  void resolveShellEnvironment().catch(() => undefined);
}

async function computeShellEnvironment(): Promise<ShellEnvironment> {
  if (process.platform === "win32") {
    const { env, addedPathDirs } = mergeShellEnv(process.env, undefined, { electron: runningUnderElectron() });
    return {
      env,
      shell: process.env.ComSpec ?? "cmd.exe",
      source: "windows",
      note: "windows: using the parent process environment",
      addedPathDirs,
    };
  }

  const shells = shellCandidates();
  for (const shell of shells) {
    for (const args of PROBE_ARGS) {
      const loginEnv = await probeOnce(shell, args);
      if (!loginEnv?.PATH) continue;
      const { env, addedPathDirs } = mergeShellEnv(process.env, loginEnv);
      return {
        env,
        shell,
        source: "login-shell",
        note:
          `resolved from ${shell} ${args.join(" ")}` +
          (addedPathDirs.length ? ` (+${addedPathDirs.length} PATH dirs)` : " (PATH unchanged)"),
        addedPathDirs,
      };
    }
  }

  // Every probe failed. Still merge, so the fallback directories apply — a GUI
  // launched app with no working shell is exactly the case that needs them.
  const { env, addedPathDirs } = mergeShellEnv(process.env, undefined);
  return {
    env,
    shell: shells[shells.length - 1] ?? "/bin/sh",
    source: "process",
    note:
      "login-shell probe failed; using the parent environment plus standard install directories" +
      (addedPathDirs.length ? ` (+${addedPathDirs.length} PATH dirs)` : ""),
    addedPathDirs,
  };
}
