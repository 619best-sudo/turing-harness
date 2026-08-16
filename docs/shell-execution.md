# Shell execution

How `bash`, `bash_readonly`, `activity_trace_start`'s `startCommand`, and every other
process the harness spawns actually run: which environment they get, which shell
interprets them, and how the project's own toolchain is found.

Everything here is automatic. There is no option to turn on, and no change to how a
model writes a command.

---

## The failure this exists to prevent

A real run, on a Flutter app:

```
model → bash: cd <app> && flutter analyze lib/screens/profile/profile_screen.dart 2>&1 | head -50
tool  → /bin/sh: flutter: command not found        ← isError: false
model → "Flutter is not available in this environment"
model → DECLARE { "tier": "static", "method": "none" }
```

The change shipped verified by nothing but reading the file back. Three separate
defects stacked up to produce that, and each is closed below.

---

## 1. The environment: the user's shell, not the parent process's

`child_process.exec` inherits `process.env` and runs `/bin/sh -c`. That is fine for a
CLI the user started from their terminal — it already holds the environment the login
shell built. It is wrong for a desktop app: macOS starts GUI processes from `launchd`,
whose `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew, nvm/volta/asdf, pyenv, the
Android SDK, `fvm`, `pnpm` — none of them are on it.

[`exec/shell-env.ts`](../src/exec/shell-env.ts) resolves the user's login-shell
environment once per process (`$SHELL -lic 'env'`, marker-delimited, 5s timeout,
memoized) and hands it to every spawn.

| | Rule |
|---|---|
| **PATH** | Union. Login-shell entries first (the user's own precedence — a pyenv shim must beat `/usr/bin/python`), then the parent's, then standard install directories as a floor. |
| **Other vars** | Additive. Host-set values always win; login-only values (`JAVA_HOME`, `ANDROID_HOME`, `FLUTTER_ROOT`, `LANG`…) are added. |
| **Electron plumbing** | Stripped. `ELECTRON_RUN_AS_NODE` and Electron's `NODE_OPTIONS` break a spawned `node` outright — unless the user's own profile sets them, in which case theirs wins. |
| **Shell** | `$SHELL`, not `/bin/sh`. `[[ ]]`, `source`, `**` globs and process substitution work in the terminal the user tested the command in, so they must work here. |

If the probe fails (no shell, a locked-down container, an rc file that hangs), the
result degrades to the parent environment **plus** the standard directories — never to
a bare `PATH`.

```ts
import { primeShellEnvironment, resolveShellEnvironment } from "turing-harness";

primeShellEnvironment();                       // optional: pay the probe during idle time
const { shell, source, addedPathDirs } = await resolveShellEnvironment();
// source: "login-shell" | "process" | "windows"
```

## 2. The toolchain: what the *project* means by `flutter`

A correct `PATH` is necessary but not sufficient. Projects deliberately keep their
toolchain **off** `PATH`, and every ecosystem does it differently. Nothing about this is
Flutter-specific — fvm is just the one that surfaced the bug.

[`exec/toolchain.ts`](../src/exec/toolchain.ts) checks the leading executable of each
top-level command segment and, when `PATH` cannot resolve it, runs five strategies in
strongest-evidence-first order. The first hit wins.

| # | Strategy | Covers |
|---|---|---|
| 1 | **Repo bin dirs** (nearest ancestor first) | `node_modules/.bin`, `.venv`/`venv`/`env` `/bin` \| `/Scripts`, `vendor/bin` (Composer), `bin/` binstubs (`bin/rails`, `bin/rake`) |
| 2 | **Build wrappers** | `gradle`→`./gradlew` or `android/gradlew`, `mvn`→`./mvnw`, `sbt`→`./sbt`/`./sbtx`, `bazel`→`./bazelw`/`tools/bazel` |
| — | **Flutter / Dart** | `.fvm/flutter_sdk`, `.fvmrc` → fvm cache, `fvm flutter`, `$FLUTTER_ROOT`, standard SDK install dirs |
| 3 | **SDK roots your shell exports** | `$JAVA_HOME`, `$ANDROID_HOME`/`$ANDROID_SDK_ROOT` (platform-tools, emulator, cmdline-tools), `$GOROOT`, `$GOPATH`, `$CARGO_HOME`, `$DOTNET_ROOT`, `$PUB_CACHE`, `$BUN_INSTALL`, `$DENO_INSTALL`, `$VIRTUAL_ENV`, `$CONDA_PREFIX` |
| 4 | **Dependency runners** | Yarn PnP → `yarn <tool>`, `poetry run`, `uv run`, `pipenv run`, `bundle exec`, `mise exec --` |
| 5 | **Machine SDK installs** | Go, .NET, JDK, Android SDK, conda/pyenv, rbenv/rvm — each gated on the repo being that stack |

Strategy 4 matters more than it looks. Those tools *are* installed — inside a bundle, a
poetry venv, a Yarn PnP zip — and the runner is the only way to reach them. Yarn PnP in
particular has no `node_modules/.bin` at all, so every CLI in the project looks missing.

Version managers (nvm, asdf, mise, pyenv, rbenv, volta) mostly need no strategy here:
their shims come back on `PATH` from §1.

The substitution note rides on the tool output on purpose — the model writes the next
command itself, rather than depending on this layer forever:

```
[toolchain] `flutter` is not on PATH; ran
`/Users/…/cards_mobile_app/.fvm/flutter_sdk/bin/flutter` instead — .fvm/flutter_sdk
(fvm pin). Use that invocation for the rest of this run.

Flutter 3.38.4 • channel stable • …
```

The note rides on the tool output on purpose: the model writes the next command
itself, rather than depending on this layer forever.

**Three guardrails.**

- Every substitution is anchored to a file that exists in the repo — a wrapper script, a
  lockfile, a version pin, a venv. `bundle exec` additionally requires the gem to appear
  in the `Gemfile`/`Gemfile.lock`, so a Gemfile does not turn every missing command into
  a gem.
- Machine-wide guesses are gated on the repo *being* that stack: `flutter` on a Rust repo
  and `adb` on a Node repo stay unresolved. `$VIRTUAL_ENV` and `$CONDA_PREFIX` describe
  whatever the user last activated in some terminal, so they are gated the same way.
- When nothing is found the command runs **unchanged** and fails honestly. A wrong binary
  is worse than a clear error.

Paths, variables, globs, quoted text, shell builtins and redirections (`2>&1`) are never
rewritten. On Windows, lookups expand `PATHEXT`, so `node_modules/.bin/tsc.cmd` resolves
where the extensionless POSIX script would not.

## 3. `command not found` is a failure, whatever the exit code says

`flutter analyze 2>&1 | head -50` exits 0 — the status belongs to `head`. A missing
toolchain therefore arrived as a **successful** tool result whose text merely mentioned
the problem, and every verification gate downstream believed it.

The output is now read for a missing-executable report in any shell's phrasing, and the
result becomes an error when the name reported missing is one this command actually
tried to run. (Grepping a log that *mentions* `command not found` is not a failure, and
is not flagged.)

The error names what was searched, and — because the most common cause is not "never
installed" but "not fetched in this checkout" — the install command *this* project needs:

```
MOST LIKELY: `npm install` (or pnpm/yarn/bun install) — dependencies are not installed
in this checkout. Do that first, then re-run.
```

`installHint()` covers npm/pnpm/yarn/bun, `flutter pub get`, `bundle install` and
`composer install`, and stays quiet once the dependencies are there. The rest of the
message forbids the conclusion that started all this: never downgrade verification, or
report the environment as toolchain-less, on the strength of one `command not found`.

## 4. Timeouts and long-running commands

| | Default |
|---|---|
| Ordinary command | 120s |
| Build-shaped command (`flutter build/test/analyze`, `pod install`, Gradle, `xcodebuild`, `npm install`, `cargo build`, `make`, `docker build`…) | 600s |

A cold native build routinely exceeds two minutes; killing one at 120s and returning a
truncated log looks exactly like a build failure, and the model then "fixes" code that
was never broken. An explicit `timeoutMs` always wins.

App launches (`flutter run`, `react-native run-ios/run-android`, `bootRun`) are
**backgrounded** — they never exit on their own, so in the foreground they burned the
whole timeout and returned a killed process. They get a 90s readiness window (a cold
build is minutes away from its first ready line), Flutter-aware ready patterns
(`Syncing files to device`, `Flutter DevTools … available at`) and failure patterns
(`No supported devices connected`, `Error launching application`) so a device-less
launch fails in a second instead of hanging.

## 5. Devices: a booted simulator is a surface, with or without an MCP

`activity_inspect`'s mobile half was wired exclusively to a device MCP. With none
connected it answered "no device automation tools available" — true about the registry,
and read by the model as "this change cannot be verified".

It now falls back to [`devices/local-devices.ts`](../src/devices/local-devices.ts):
`xcrun simctl` and `adb` drive the booted simulator/emulator directly — list, launch a
bundle id, open a deep link, screenshot. A device MCP still wins when one is connected
(it can do more: element trees, taps, gestures); this is the floor, not the ceiling.

```ts
const res = await activityInspect.execute("i", { target: "mobile", bundleId: "com.example.app" }, ctx);
// **Device inspection**
// - Device: `E25EC6B1-…` — iPhone 17 Pro (26.5) (local simulator/emulator — no device MCP connected)
// **Screenshot** (via local_device_screenshot) — attached below.
```

Captures land in `.turing/screenshots/` and ride out as image blocks, so `media_analysis`
can be pointed straight at them.

Nothing booted and no MCP is still an error — but one that names the next step instead of
reporting a missing capability.

## 6. How the app gets onto the device — read from the project

A screenshot of a simulator with no app on it is a screenshot of someone else's screen, so
the verify round has to say how the app gets there. The tempting way to write that is a
stack list — Flutter → this, React Native → that — and every such list is wrong somewhere.
The app that prompted this cannot be launched by a bare `flutter run` at all: it has
flavors, and its own `CLAUDE.md` says
`flutter run --flavor staging -t lib/main_staging.dart`. A hardcoded default would have
named a command that fails, confidently.

[`exec/run-commands.ts`](../src/exec/run-commands.ts) reads what the project declares:

| Source | Read as |
|---|---|
| `package.json` `scripts` | `npm run <name>`, classified by the script body and by its name (`ios`, `android`, `run:ios`…) |
| `Makefile` targets | `make <name>`, classified from the recipe lines and the target name |
| `CLAUDE.md` / `AGENTS.md` / `README.md` / `CONTRIBUTING.md` / `DEVELOPMENT.md` | shell lines inside fenced blocks |

Each is labelled `device` / `dev-server` / `build` / `test`, and the classification that
has to be right is `device` vs `build`: `flutter build apk` and `gradle assembleDebug`
produce an artifact and install nothing, while `flutter run` and `react-native run-ios`
put the app on a screen. Matching is on the **verb**, not the framework, so a stack nobody
anticipated classifies correctly if it uses the same vocabulary.

The verify round then quotes the project back to itself:

```
This project declares:
  - `flutter run --flavor staging -t lib/main_staging.dart`  — CLAUDE.md
  - `flutter run --flavor production -t lib/main_production.dart`  — CLAUDE.md
```

When the project declares nothing recognisable, **no command is invented** — the round
says where to look (package scripts, Makefile, README/CLAUDE.md/AGENTS.md, the CI
workflow) and why guessing fails on mobile. A model can read files; a hardcoded list
cannot.

Two parsing details earn their keep. Fences are walked as a state machine over *all* of
them, because a regex that only recognises shell fences pairs the opening ``` of one block
with the closing ``` of a later one and swallows the prose between — on the real
`CLAUDE.md`, a ```dart block sat between two shell blocks and two paragraphs of
performance-tuning prose came back as commands. And candidate lines are shape-checked
(no backticks, no bold, no list markers), because docs quote commands inside sentences
constantly. Underscores and `*` are deliberately *not* treated as markdown — `-t
lib/main_staging.dart` and `rm build/*.apk` are ordinary shell.

```ts
import { detectRunCommands, detectDeviceRunCommands, describeDeviceLaunch } from "turing-harness";

const device = await detectDeviceRunCommands(cwd);   // [{ command, source, kind: "device" }]
const paragraph = describeDeviceLaunch(device);      // what the verify round carries
```

```ts
import { setLocalDeviceProbe, listLocalDevices } from "turing-harness";

setLocalDeviceProbe(async () => myDeviceFarm.booted());   // host-supplied inventory
process.env.TURING_DISABLE_LOCAL_DEVICES = "1";           // or: MCP-only
```

---

## Where it lives

| File | Role |
|---|---|
| [`src/exec/shell-env.ts`](../src/exec/shell-env.ts) | Login-shell environment + which shell runs commands |
| [`src/exec/toolchain.ts`](../src/exec/toolchain.ts) | Project-pinned launcher resolution, `command not found` diagnosis |
| [`src/exec/run-commands.ts`](../src/exec/run-commands.ts) | How the project says it runs itself (scripts, Makefile, docs) |
| [`src/devices/local-devices.ts`](../src/devices/local-devices.ts) | simctl/adb device list, launch, open-url, screenshot |
| [`src/tools/builtin/coding.ts`](../src/tools/builtin/coding.ts) | `bash` / `bash_readonly`, timeouts, background classification |
| [`src/tools/builtin/activity-monitor.ts`](../src/tools/builtin/activity-monitor.ts) | `startCommand` spawn, `activity_inspect` device fallback |

Tests: `tests/shell-env.test.mjs`, `tests/toolchain.test.mjs`,
`tests/toolchain-stacks.test.mjs` (one case per mechanism, across stacks),
`tests/run-commands.test.mjs`, `tests/bash-environment.test.mjs`,
`tests/activity-monitor.test.mjs`, `tests/reproduce-first-cycle.test.mjs`.

## Adding a stack

Every strategy is a table at the top of its section in `exec/toolchain.ts` —
`REPO_BIN_DIRS`, `WRAPPERS`, `SDK_ROOT_VARS`, `DEPENDENCY_RUNNERS`, `MACHINE_SDK_DIRS`.
Adding an ecosystem is a row plus a case in `tests/toolchain-stacks.test.mjs`. If the new
strategy can be wrong on a repo of a different stack, give it a `gate`.
