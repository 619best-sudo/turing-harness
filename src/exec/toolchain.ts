/**
 * Project-pinned toolchains: finding the binary the PROJECT means.
 *
 * WHY THIS FILE EXISTS
 *
 * A correct PATH is necessary but not sufficient. Modern projects deliberately
 * do NOT put their toolchain on PATH — they pin a version inside the repo and
 * expect you to reach it through a launcher:
 *
 *   Flutter   `.fvm/flutter_sdk/bin/flutter`, or `fvm flutter`   (.fvmrc)
 *   Node      `node_modules/.bin/<tool>`                          (package.json)
 *   Gradle    `./gradlew`                                         (wrapper)
 *   Maven     `./mvnw`
 *   Python    `.venv/bin/<tool>`
 *   Ruby      `bundle exec <tool>`                                (Gemfile)
 *   PHP       `vendor/bin/<tool>`
 *
 * On such a project the bare name is not on PATH ANYWHERE — not in the desktop
 * app, not in the user's own terminal. `flutter analyze` answers `command not
 * found` and a model that takes that at face value concludes "Flutter is not
 * available in this environment" and stops verifying. That is precisely the
 * failure this module removes: the toolchain was there the whole time, one
 * directory down, named in a file the repo checks in.
 *
 * WHAT IT DOES
 *
 * Before a shell command runs, the leading executable of each top-level segment
 * is checked against PATH. Anything unresolvable gets one lookup against the
 * project's own pins, and a hit is substituted in place with a note saying what
 * happened and why. Nothing else about the command is touched.
 *
 * TWO GUARDRAILS
 *
 *  - Substitution is EVIDENCE-BASED, never a guess. Every strategy below is
 *    anchored to a file that exists in the repo (a wrapper script, a lockfile, a
 *    version pin, a venv). If nothing is found, the command runs unchanged and
 *    fails honestly — a wrong binary is worse than a clear error.
 *  - The model is TOLD. The substitution note rides on the tool output, so the
 *    next command it writes uses the right invocation on its own rather than
 *    depending on this module forever.
 */
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ToolchainSubstitution {
  /** The bare executable that PATH could not resolve. */
  missing: string;
  /** What replaced it, exactly as it now appears in the command. */
  replacement: string;
  /** The evidence in the repo that justified the replacement. */
  reason: string;
}

export interface ResolvedCommand {
  /** The command to actually run (identical to the input when nothing matched). */
  command: string;
  substitutions: ToolchainSubstitution[];
  /** Executables that PATH could not resolve and the project did not pin. */
  unresolved: string[];
  /** Every bare executable this command invokes, resolvable or not. */
  executables: string[];
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** A top-level command segment: `a && b | c` is three segments. */
interface Segment {
  start: number;
  end: number;
}

/**
 * Split a command into top-level segments, respecting quotes and substitutions.
 *
 * Deliberately conservative: `$( … )`, backticks and parenthesised subshells are
 * treated as opaque. A wrong split would rewrite something that is not an
 * executable, and the cost of missing a nested command is only that we do not
 * help there — the command still runs exactly as written.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;

  const push = (end: number) => {
    if (end > start) segments.push({ start, end });
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;

    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }

    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(i);
      start = i + 2;
      i += 1;
      continue;
    }
    if (ch === "&") {
      // `2>&1`, `&>log`, `>&2` — a redirection, not a command boundary. Splitting
      // there produced a phantom segment whose "executable" was `1`.
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === ">" || prev === "<" || next === ">") continue;
      push(i);
      start = i + 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      push(i);
      start = i + 1;
      continue;
    }
  }
  push(command.length);
  return segments;
}

/**
 * Shell words that are not executables to resolve.
 *
 * Builtins and keywords never live on PATH, so treating them as "missing" would
 * fire a project lookup on `cd` or `if` on every command.
 */
const SHELL_WORDS = new Set([
  "cd", "echo", "export", "set", "unset", "source", ".", "eval", "exec", "test", "[", "[[",
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "function", "return", "shift", "read", "local", "declare", "typeset", "trap", "wait",
  "true", "false", "alias", "unalias", "pushd", "popd", "dirs", "jobs", "fg", "bg", "kill",
  "printf", "let", "ulimit", "umask", "type", "hash", "times", "break", "continue", "{", "}",
]);

/**
 * Words that PREFIX a real command and must be stepped over to find it.
 * `sudo flutter analyze` invokes flutter, not sudo.
 */
const WRAPPER_WORDS = new Set(["sudo", "command", "exec", "nohup", "time", "nice", "setsid", "stdbuf"]);

interface ExecutableToken {
  name: string;
  start: number;
  end: number;
}

/** The executable a segment invokes, with its exact position in the command. */
function executableToken(command: string, segment: Segment): ExecutableToken | undefined {
  let i = segment.start;
  const end = segment.end;

  // Up to a few wrapper words / env assignments before the real executable.
  for (let guard = 0; guard < 8; guard += 1) {
    while (i < end && /\s/.test(command[i]!)) i += 1;
    if (i >= end) return undefined;

    // Redirections and other punctuation lead nowhere useful.
    if (/[<>()&|;]/.test(command[i]!)) return undefined;

    let j = i;
    while (j < end && !/\s/.test(command[j]!)) j += 1;
    const word = command.slice(i, j);

    // `FOO=bar cmd` — skip the assignment and keep looking.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i = j;
      continue;
    }
    if (WRAPPER_WORDS.has(word)) {
      i = j;
      continue;
    }
    return { name: word, start: i, end: j };
  }
  return undefined;
}

/**
 * Is this token a bare executable name we may look up?
 *
 * Anything already carrying a path, a variable, a quote or a glob is the
 * caller's explicit choice and must be left exactly as written.
 */
function isBareName(word: string): boolean {
  if (!word) return false;
  if (SHELL_WORDS.has(word)) return false;
  if (/[/\\$'"`*?~=]/.test(word)) return false;
  if (!/^[A-Za-z0-9._+-]+$/.test(word)) return false;
  // A bare number is a file descriptor left over from a redirection, never a
  // command. Executables starting with a digit (`7z`) still pass.
  if (/^\d+$/.test(word)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// PATH lookup
// ---------------------------------------------------------------------------

/**
 * Extensions that make a file executable on Windows.
 *
 * On POSIX the execute bit is the whole answer. On Windows there is no execute
 * bit, and the thing a launcher installs is `tsc.cmd`, not `tsc` — checking the
 * bare name there finds the extensionless shell script npm also ships, which
 * `cmd.exe` cannot run. So the name is expanded before any lookup.
 */
function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  if (path.extname(name)) return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...exts.map((ext) => name + ext.toLowerCase()), name];
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    // Windows reports X_OK for anything readable, so the extension check in
    // `executableNames` is what carries the meaning there.
    if (process.platform !== "win32") await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<dir>/<name>` if it exists and can be run, honouring Windows extensions. */
async function executableIn(dir: string, name: string): Promise<string | undefined> {
  for (const candidate of executableNames(name)) {
    const full = path.join(dir, candidate);
    if (await isExecutableFile(full)) return full;
  }
  return undefined;
}

/** Absolute path of `name` on PATH, or undefined. */
export async function whichExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const raw = env.PATH ?? env.Path ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir.trim()) continue;
    const found = await executableIn(dir.trim(), name);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Project pins
// ---------------------------------------------------------------------------

/** `cwd` and each ancestor, nearest first, bounded so a deep path cannot stall. */
function ancestors(cwd: string, limit = 10): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < limit; i += 1) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Quote a path for the shell only when it needs it. */
function shellQuote(value: string): string {
  return /[^A-Za-z0-9._\-/=:]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

interface Launcher {
  replacement: string;
  reason: string;
}
/**
 * What KIND of project this is, from the manifests it checks in.
 *
 * Two jobs. It gates the weaker strategies — a machine-wide SDK guess is only
 * reasonable on a repo of that stack, so `flutter` on a Rust project stays
 * unresolved rather than pointing at a stray SDK. And it decides which
 * dependency-runner (`bundle exec`, `poetry run`, `yarn`) is the project's own.
 *
 * Detected from files, never from the tool name being looked up: the question
 * "what is this repo" has one answer, and it should not change with which
 * binary happened to be missing.
 */
interface ProjectSignals {
  root: string;
  files: Set<string>;
}

/**
 * Manifests worth noticing. Kept as a flat list because every consumer below
 * asks a different question of it, and a per-stack enum would just be a second
 * thing to keep in sync with this one.
 */
const MANIFEST_FILES = [
  "package.json", "pnpm-workspace.yaml", ".pnp.cjs", ".pnp.loader.mjs", ".yarnrc.yml",
  "pubspec.yaml",
  "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "environment.yml",
  "poetry.lock", "uv.lock", "Pipfile.lock",
  "Gemfile", "Gemfile.lock",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "global.json", "mix.exs", "stack.yaml", "cabal.project", "build.sbt",
  "mise.toml", ".mise.toml", ".tool-versions",
  "Makefile", "Package.swift", "Podfile",
] as const;

/**
 * Nearest ancestor that looks like a project root, plus which manifests it has.
 *
 * "Nearest" matters in a monorepo: a package's own `package.json` should decide
 * before the workspace root's does.
 */
async function projectSignals(cwd: string): Promise<ProjectSignals> {
  const found = new Set<string>();
  let root = path.resolve(cwd);
  let rootSet = false;
  for (const dir of ancestors(cwd)) {
    const here = await Promise.all(
      MANIFEST_FILES.map(async (file) => ((await exists(path.join(dir, file))) ? file : undefined)),
    );
    const hits = here.filter(Boolean) as string[];
    if (hits.length && !rootSet) {
      root = dir;
      rootSet = true;
    }
    for (const hit of hits) found.add(hit);
    // Also record ancestor-level manifests (a monorepo root's lockfile is the
    // one that governs), keyed the same way — presence is all any caller needs.
  }
  return { root, files: found };
}

const has = (signals: ProjectSignals, ...files: string[]) => files.some((f) => signals.files.has(f));

const isNodeProject = (s: ProjectSignals) => has(s, "package.json", "pnpm-workspace.yaml");
const isDartProject = (s: ProjectSignals) => has(s, "pubspec.yaml");
const isPythonProject = (s: ProjectSignals) =>
  has(s, "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "environment.yml");
const isRubyProject = (s: ProjectSignals) => has(s, "Gemfile", "Gemfile.lock", "Podfile");
const isGoProject = (s: ProjectSignals) => has(s, "go.mod");
const isJvmProject = (s: ProjectSignals) =>
  has(s, "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts");
const isDotnetProject = (s: ProjectSignals) => has(s, "global.json");

/** File contents, or undefined if it is not there / not readable. */
async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Strategy 1 — directories the repo itself installs binaries into
// ---------------------------------------------------------------------------

/**
 * Per-project bin directories, in the order a developer would look.
 *
 * `bin/` is included because binstubs live there on Rails and friends
 * (`bin/rails`, `bin/rake`), and a file in the repo named exactly the missing
 * command is about as direct as evidence gets.
 */
const REPO_BIN_DIRS: Array<{ segments: string[]; reason: string }> = [
  { segments: ["node_modules", ".bin"], reason: "node_modules/.bin (project dependency)" },
  { segments: [".venv", "bin"], reason: ".venv/bin (virtualenv)" },
  { segments: ["venv", "bin"], reason: "venv/bin (virtualenv)" },
  { segments: ["env", "bin"], reason: "env/bin (virtualenv)" },
  { segments: [".venv", "Scripts"], reason: ".venv/Scripts (virtualenv)" },
  { segments: ["venv", "Scripts"], reason: "venv/Scripts (virtualenv)" },
  { segments: ["vendor", "bin"], reason: "vendor/bin (composer)" },
  { segments: ["bin"], reason: "bin/ (project binstub)" },
  { segments: [".bin"], reason: ".bin/ (project script)" },
];

async function findInRepoBinDirs(name: string, cwd: string): Promise<Launcher | undefined> {
  for (const root of ancestors(cwd)) {
    for (const { segments, reason } of REPO_BIN_DIRS) {
      const found = await executableIn(path.join(root, ...segments), name);
      if (found) return { replacement: shellQuote(found), reason };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strategy 2 — build-tool wrappers, which exist so the bare tool is not needed
// ---------------------------------------------------------------------------

const WRAPPERS: Record<string, Array<{ rel: string[]; reason: string }>> = {
  gradle: [
    { rel: ["gradlew"], reason: "gradlew (Gradle wrapper)" },
    { rel: ["android", "gradlew"], reason: "android/gradlew (Gradle wrapper)" },
  ],
  mvn: [{ rel: ["mvnw"], reason: "mvnw (Maven wrapper)" }],
  sbt: [
    { rel: ["sbt"], reason: "sbt (project launcher)" },
    { rel: ["sbtx"], reason: "sbtx (project launcher)" },
  ],
  bazel: [
    { rel: ["bazelw"], reason: "bazelw (Bazel wrapper)" },
    { rel: ["tools", "bazel"], reason: "tools/bazel (Bazel wrapper)" },
  ],
};

async function findWrapper(name: string, cwd: string): Promise<Launcher | undefined> {
  const candidates = WRAPPERS[name];
  if (!candidates) return undefined;
  for (const root of ancestors(cwd)) {
    for (const { rel, reason } of candidates) {
      const found = await executableIn(path.join(root, ...rel.slice(0, -1)), rel[rel.length - 1]!);
      if (found) return { replacement: shellQuote(found), reason };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strategy 3 — SDK roots the user's own shell exports
// ---------------------------------------------------------------------------

/**
 * `$JAVA_HOME`, `$ANDROID_HOME`, `$GOROOT`… — set by the user's profile, which
 * means they are AUTHORITATIVE for this machine, not guesses. They arrive here
 * because `exec/shell-env.ts` resolves the login environment; before that they
 * were simply absent inside a desktop app.
 *
 * `gate` keeps the two that describe a *session* rather than a machine
 * (`VIRTUAL_ENV`, `CONDA_PREFIX` — whatever the user last activated in some
 * terminal) from being applied to a project they have nothing to do with.
 */
const SDK_ROOT_VARS: Array<{
  variable: string;
  subdirs: string[][];
  gate?: (s: ProjectSignals) => boolean;
}> = [
  { variable: "VIRTUAL_ENV", subdirs: [["bin"], ["Scripts"]], gate: isPythonProject },
  { variable: "CONDA_PREFIX", subdirs: [["bin"], ["Scripts"]], gate: isPythonProject },
  { variable: "JAVA_HOME", subdirs: [["bin"]] },
  { variable: "GOROOT", subdirs: [["bin"]] },
  { variable: "GOPATH", subdirs: [["bin"]] },
  { variable: "CARGO_HOME", subdirs: [["bin"]] },
  { variable: "DOTNET_ROOT", subdirs: [[]] },
  { variable: "PUB_CACHE", subdirs: [["bin"]] },
  { variable: "BUN_INSTALL", subdirs: [["bin"]] },
  { variable: "DENO_INSTALL", subdirs: [["bin"]] },
  {
    variable: "ANDROID_HOME",
    subdirs: [["platform-tools"], ["emulator"], ["cmdline-tools", "latest", "bin"], ["tools", "bin"], ["build-tools"]],
  },
  {
    variable: "ANDROID_SDK_ROOT",
    subdirs: [["platform-tools"], ["emulator"], ["cmdline-tools", "latest", "bin"], ["tools", "bin"]],
  },
];

async function findInSdkRoots(
  name: string,
  env: NodeJS.ProcessEnv,
  signals: ProjectSignals,
): Promise<Launcher | undefined> {
  for (const { variable, subdirs, gate } of SDK_ROOT_VARS) {
    const root = env[variable];
    if (!root) continue;
    if (gate && !gate(signals)) continue;
    for (const sub of subdirs) {
      const found = await executableIn(path.join(root, ...sub), name);
      if (found) return { replacement: shellQuote(found), reason: `$${variable}` };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strategy 4 — dependency runners: the project's tool exists, just not on PATH
// ---------------------------------------------------------------------------

/**
 * `bundle exec rspec`, `poetry run pytest`, `yarn tsc`.
 *
 * These are not path lookups. The tool IS installed — inside a bundle, a
 * poetry-managed venv, a Yarn PnP zip — and the runner is the only way to reach
 * it. Each entry is gated on the lockfile that proves the project uses that
 * runner AND on the runner itself resolving, so a `poetry run` is never
 * suggested to a machine without poetry.
 *
 * Yarn PnP is the one that matters most in modern JS: there is no
 * `node_modules/.bin` at all, so strategy 1 finds nothing and every CLI in the
 * project looks missing.
 */
const DEPENDENCY_RUNNERS: Array<{
  runner: string;
  prefix: string;
  markers: string[];
  reason: string;
  /** Optional extra check that this specific tool belongs to the runner. */
  owns?: (name: string, signals: ProjectSignals) => Promise<boolean>;
}> = [
  {
    runner: "yarn",
    prefix: "yarn",
    markers: [".pnp.cjs", ".pnp.loader.mjs"],
    reason: "Yarn Plug'n'Play — dependencies have no node_modules/.bin",
  },
  { runner: "poetry", prefix: "poetry run", markers: ["poetry.lock"], reason: "poetry.lock (poetry-managed venv)" },
  { runner: "uv", prefix: "uv run", markers: ["uv.lock"], reason: "uv.lock (uv-managed venv)" },
  { runner: "pipenv", prefix: "pipenv run", markers: ["Pipfile.lock", "Pipfile"], reason: "Pipfile (pipenv venv)" },
  {
    runner: "bundle",
    prefix: "bundle exec",
    markers: ["Gemfile.lock", "Gemfile"],
    reason: "Gemfile (bundler-managed gem)",
    // A Gemfile does not make every missing command a gem. Requiring the name
    // to appear in the bundle keeps `bundle exec` off unrelated binaries.
    owns: async (name, signals) => {
      const lock = await readTextIfExists(path.join(signals.root, "Gemfile.lock"));
      const gemfile = await readTextIfExists(path.join(signals.root, "Gemfile"));
      const haystack = `${lock ?? ""}\n${gemfile ?? ""}`;
      if (!haystack.trim()) return false;
      // The binary and the gem that ships it are usually the same word, but not
      // always (`pod` comes from `cocoapods`), so both spellings are accepted.
      const candidates = [name, ...(GEM_BINARY_OWNERS[name] ?? [])];
      return candidates.some((gem) =>
        new RegExp(`(^|[\\s"'(])${gem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s"',)]|$)`, "m").test(haystack),
      );
    },
  },
  {
    runner: "mise",
    prefix: "mise exec --",
    markers: ["mise.toml", ".mise.toml", ".tool-versions"],
    reason: "mise-managed toolchain",
  },
];

/** Binaries whose gem is named something else. Extra spellings, not replacements. */
const GEM_BINARY_OWNERS: Record<string, string[]> = {
  pod: ["cocoapods"],
  rspec: ["rspec-core"],
  rails: ["railties"],
  sidekiq: ["sidekiq"],
};

async function findDependencyRunner(
  name: string,
  env: NodeJS.ProcessEnv,
  signals: ProjectSignals,
): Promise<Launcher | undefined> {
  for (const entry of DEPENDENCY_RUNNERS) {
    if (!has(signals, ...entry.markers)) continue;
    if (entry.owns && !(await entry.owns(name, signals))) continue;
    if (!(await whichExecutable(entry.runner, env))) continue;
    return { replacement: `${entry.prefix} ${name}`, reason: entry.reason };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strategy 5 — machine-wide SDK installs, gated on the repo being that stack
// ---------------------------------------------------------------------------

/**
 * The weakest evidence, and the only strategy that can be wrong in a way the
 * repo did not ask for. Hence the gate: `flutter` is only guessed at on a repo
 * with a `pubspec.yaml`, `dotnet` only with a .NET manifest, and so on. On any
 * other project the name stays unresolved and the command fails honestly.
 *
 * `~` is expanded at use, not at module load, so a host that changes HOME
 * between runs is followed.
 */
const MACHINE_SDK_DIRS: Array<{
  gate: (s: ProjectSignals) => boolean;
  dirs: string[];
  reason: string;
}> = [
  {
    gate: isGoProject,
    dirs: ["/usr/local/go/bin", "/opt/homebrew/opt/go/libexec/bin", "~/go/bin", "~/sdk/go/bin"],
    reason: "Go toolchain",
  },
  {
    gate: isDotnetProject,
    dirs: ["/usr/local/share/dotnet", "~/.dotnet", "/opt/homebrew/opt/dotnet/bin"],
    reason: ".NET SDK",
  },
  {
    gate: isJvmProject,
    dirs: ["/opt/homebrew/opt/openjdk/bin", "/usr/local/opt/openjdk/bin", "/Library/Java/JavaVirtualMachines"],
    reason: "JDK install",
  },
  {
    gate: (s) => isJvmProject(s) || isDartProject(s),
    dirs: [
      "~/Library/Android/sdk/platform-tools",
      "~/Library/Android/sdk/emulator",
      "~/Library/Android/sdk/cmdline-tools/latest/bin",
      "~/Android/Sdk/platform-tools",
      "~/Android/Sdk/emulator",
    ],
    reason: "Android SDK",
  },
  {
    gate: isPythonProject,
    dirs: [
      "~/miniconda3/bin",
      "~/anaconda3/bin",
      "/opt/homebrew/Caskroom/miniconda/base/bin",
      "~/.pyenv/shims",
    ],
    reason: "Python install",
  },
  {
    gate: isRubyProject,
    dirs: ["~/.rbenv/shims", "~/.rvm/bin", "/opt/homebrew/opt/ruby/bin"],
    reason: "Ruby install",
  },
];

function expandHome(dir: string): string {
  return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

async function findInMachineSdkDirs(name: string, signals: ProjectSignals): Promise<Launcher | undefined> {
  for (const { gate, dirs, reason } of MACHINE_SDK_DIRS) {
    if (!gate(signals)) continue;
    for (const dir of dirs) {
      const found = await executableIn(expandHome(dir), name);
      if (found) return { replacement: shellQuote(found), reason };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Flutter / Dart — the one stack with enough pinning mechanisms to need its own
// ---------------------------------------------------------------------------

/** Tools whose home is the Flutter SDK, so one resolution serves both. */
const FLUTTER_SDK_TOOLS = new Set(["flutter", "dart"]);

/**
 * Ordered by how authoritative the evidence is: an `.fvm` symlink the repo
 * checks in beats a version string in `.fvmrc`, which beats an environment
 * variable, which beats a guess at a common install directory.
 */
async function findFlutterSdk(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signals: ProjectSignals,
): Promise<Launcher | undefined> {
  for (const root of ancestors(cwd)) {
    // 1. The symlink `fvm use` creates, checked into most fvm projects.
    const pinned = await executableIn(path.join(root, ".fvm", "flutter_sdk", "bin"), name);
    if (pinned) {
      return { replacement: shellQuote(pinned), reason: ".fvm/flutter_sdk (fvm pin)" };
    }

    // 2. `.fvmrc` names the version; the SDK itself lives in fvm's cache.
    const version = await readFvmVersion(path.join(root, ".fvmrc"));
    if (version) {
      const caches = [
        path.join(root, ".fvm", "versions", version, "bin"),
        path.join(os.homedir(), "fvm", "versions", version, "bin"),
        path.join(os.homedir(), ".fvm", "versions", version, "bin"),
        path.join(os.homedir(), "Library", "Application Support", "fvm", "versions", version, "bin"),
      ];
      for (const dir of caches) {
        const found = await executableIn(dir, name);
        if (found) return { replacement: shellQuote(found), reason: `.fvmrc pins Flutter ${version}` };
      }
      // The version is pinned but not downloaded — `fvm` can still run it.
      if (await whichExecutable("fvm", env)) {
        return { replacement: `fvm ${name}`, reason: `.fvmrc pins Flutter ${version}; \`fvm\` resolves it` };
      }
    }
  }

  // Everything above was pinned BY THIS REPO. Everything below is a guess at
  // where an SDK lives on this machine, so it is gated on the repo actually
  // being a Dart/Flutter project.
  if (!isDartProject(signals)) return undefined;

  // 3. An explicit SDK root in the environment.
  if (env.FLUTTER_ROOT) {
    const found = await executableIn(path.join(env.FLUTTER_ROOT, "bin"), name);
    if (found) return { replacement: shellQuote(found), reason: "$FLUTTER_ROOT" };
  }

  // 4. Common install locations, plus whatever fvm has cached.
  const roots = [
    "~/development/flutter",
    "~/flutter",
    "~/sdk/flutter",
    "~/Developer/flutter",
    "/usr/local/flutter",
    "/opt/flutter",
    "/opt/homebrew/Caskroom/flutter/latest/flutter",
  ];
  for (const root of roots) {
    const found = await executableIn(path.join(expandHome(root), "bin"), name);
    if (found) return { replacement: shellQuote(found), reason: `Flutter SDK at ${root}` };
  }
  return newestFvmCacheBin(name);
}

async function readFvmVersion(fvmrc: string): Promise<string | undefined> {
  const raw = await readTextIfExists(fvmrc);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { flutter?: unknown; flutterSdkVersion?: unknown };
    const version = parsed.flutter ?? parsed.flutterSdkVersion;
    return typeof version === "string" && version ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Newest SDK in fvm's cache, as a last resort.
 *
 * Weaker evidence than everything above — the project did not ask for this
 * specific version — so it is tried only after every pinned source has missed,
 * and the reason line says where it came from.
 */
async function newestFvmCacheBin(name: string): Promise<Launcher | undefined> {
  const caches = [
    path.join(os.homedir(), "fvm", "versions"),
    path.join(os.homedir(), ".fvm", "versions"),
  ];
  for (const cache of caches) {
    let entries: string[];
    try {
      entries = await fs.readdir(cache);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      const found = await executableIn(path.join(cache, entry, "bin"), name);
      if (found) {
        return { replacement: shellQuote(found), reason: `fvm cache (${entry}) — no project pin matched` };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The one lookup
// ---------------------------------------------------------------------------

/**
 * Given an executable PATH cannot resolve, what did the PROJECT mean?
 *
 * Strategies run strongest-evidence-first, and the first hit wins. Returns
 * undefined when nothing supports a substitution — the caller then runs the
 * command unchanged so the failure is the project's, not ours.
 */
export async function findProjectLauncher(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Launcher | undefined> {
  const signals = await projectSignals(cwd);
  return (
    (await findInRepoBinDirs(name, cwd)) ??
    (await findWrapper(name, cwd)) ??
    (FLUTTER_SDK_TOOLS.has(name) ? await findFlutterSdk(name, cwd, env, signals) : undefined) ??
    (await findInSdkRoots(name, env, signals)) ??
    (await findDependencyRunner(name, env, signals)) ??
    (await findInMachineSdkDirs(name, signals))
  );
}

// ---------------------------------------------------------------------------
// When nothing resolves: why, in this project's terms
// ---------------------------------------------------------------------------

/**
 * The most common reason a tool is missing is not that it was never installed —
 * it is that the project's dependencies have not been fetched in this checkout.
 * Saying which install command this repo needs turns a dead end into one step.
 */
export async function installHint(cwd: string): Promise<string | undefined> {
  const signals = await projectSignals(cwd);
  const root = signals.root;
  const checks: Array<{ when: boolean; dir: string; hint: string }> = [
    {
      when: isNodeProject(signals) && !has(signals, ".pnp.cjs"),
      dir: "node_modules",
      hint: "`npm install` (or pnpm/yarn/bun install) — dependencies are not installed in this checkout",
    },
    { when: isDartProject(signals), dir: ".dart_tool", hint: "`flutter pub get` / `dart pub get`" },
    { when: isRubyProject(signals), dir: "vendor/bundle", hint: "`bundle install`" },
    { when: has(signals, "composer.json"), dir: "vendor", hint: "`composer install`" },
  ];
  for (const check of checks) {
    if (!check.when) continue;
    if (await exists(path.join(root, check.dir))) continue;
    return check.hint;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Rewrite a command so its executables resolve, using the project's own pins.
 *
 * Never throws: a resolution failure returns the original command with the
 * missing names listed, which the caller turns into an actionable error.
 */
export async function resolveProjectToolchain(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCommand> {
  const substitutions: ToolchainSubstitution[] = [];
  const unresolved: string[] = [];
  const executables: string[] = [];

  // Collect first, rewrite after: splicing while scanning would invalidate every
  // index the scan produced.
  const edits: Array<{ start: number; end: number; text: string }> = [];
  // One decision per distinct name, so `flutter … && flutter …` costs one lookup
  // and gets one note.
  const decided = new Map<string, Launcher | undefined>();

  for (const segment of splitSegments(command)) {
    const token = executableToken(command, segment);
    if (!token || !isBareName(token.name)) continue;
    if (!executables.includes(token.name)) executables.push(token.name);

    if (!decided.has(token.name)) {
      const onPath = await whichExecutable(token.name, env);
      decided.set(token.name, onPath ? undefined : await findProjectLauncher(token.name, cwd, env));
      if (!onPath && !decided.get(token.name)) unresolved.push(token.name);
    }

    const launcher = decided.get(token.name);
    if (!launcher) continue;

    edits.push({ start: token.start, end: token.end, text: launcher.replacement });
    if (!substitutions.some((s) => s.missing === token.name)) {
      substitutions.push({ missing: token.name, replacement: launcher.replacement, reason: launcher.reason });
    }
  }

  if (!edits.length) return { command, substitutions, unresolved, executables };

  let out = command;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return { command: out, substitutions, unresolved, executables };
}

/** The note prepended to tool output when a substitution happened. */
export function substitutionNote(substitutions: ToolchainSubstitution[]): string {
  return substitutions
    .map(
      (s) =>
        `[toolchain] \`${s.missing}\` is not on PATH; ran \`${s.replacement}\` instead — ${s.reason}. ` +
        `Use that invocation for the rest of this run.`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// After the fact: reading `command not found` out of output
// ---------------------------------------------------------------------------

const NOT_FOUND_PATTERNS = [
  /(?:^|\n)[^\n]*?:\s*([A-Za-z0-9._+-]+):\s*command not found/g,
  /(?:^|\n)[^\n]*?command not found:\s*([A-Za-z0-9._+-]+)/g,
  /(?:^|\n)[^\n]*?:\s*([A-Za-z0-9._+-]+):\s*not found/g,
  /'([A-Za-z0-9._+-]+)' is not recognized as an internal or external command/g,
];

/**
 * Executables a command's OUTPUT reports as missing.
 *
 * This exists because exit codes lie. `flutter analyze 2>&1 | head -50` exits 0
 * — the exit status belongs to `head` — so a missing toolchain arrives as a
 * SUCCESSFUL tool result whose text happens to say `command not found`. The
 * model read that as "the check ran", and every gate downstream agreed. Reading
 * the text is the only way to catch it.
 */
export function commandNotFoundNames(output: string): string[] {
  const names = new Set<string>();
  for (const pattern of NOT_FOUND_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output))) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * The message handed back when a command's executable could not be found.
 *
 * Written to stop the specific wrong conclusion that follows a bare "command not
 * found": that the environment has no toolchain and the work therefore cannot be
 * verified. It names what was searched, so the next step is a lookup rather than
 * a surrender.
 */
export function missingExecutableGuidance(names: string[], hint?: string): string {
  const list = names.map((n) => `\`${n}\``).join(", ");
  return [
    `[toolchain] ${list} could not be resolved: not on PATH, and no project-pinned copy was found`,
    "(searched repo bin dirs — node_modules/.bin, .venv|venv/bin, vendor/bin, bin/ — build wrappers",
    "(gradlew/mvnw/sbt/bazel), the fvm pins, the SDK roots this shell exports ($JAVA_HOME, $ANDROID_HOME,",
    "$GOROOT, $VIRTUAL_ENV, $CONDA_PREFIX, $DOTNET_ROOT…), dependency runners (yarn PnP, poetry/uv/pipenv,",
    "bundler, mise), and the standard SDK install locations for this project's stack).",
    ...(hint ? ["", `MOST LIKELY: ${hint}. Do that first, then re-run.`] : []),
    "",
    "This is a RESOLUTION failure, not proof the toolchain is absent — do NOT conclude the environment",
    "cannot build or run this project, and do not downgrade verification on the strength of it. Next:",
    "  1. read the project's README / CLAUDE.md / AGENTS.md / CI workflow for how the tool is invoked here;",
    "  2. look for a wrapper or pin in the repo (a `*w` script, a `.tool-versions`, a `Makefile` target,",
    "     a `scripts/` entry, a devcontainer or docker command);",
    "  3. if it genuinely is not installed, say so plainly and ask the user — do not silently declare the",
    "     change verified by reading the file back.",
  ].join("\n");
}
