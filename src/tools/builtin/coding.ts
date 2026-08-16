/**
 * Built-in coding tools: bash, bash_readonly, read, write, edit, ls, grep.
 * These mirror pi's default toolset plus a strict read-only shell for Prepare/Plan,
 * and are pre-tagged with 4P phases.
 */
import { exec, spawn } from "node:child_process";
import { PROBE_MARKER_RE } from "../../probe-marker.js";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentTool,
  ComplexityCategory,
  ComplexityRating,
  Model,
  ToolContext,
  ToolResult,
  Usage,
} from "../../types.js";
import { ratingToScore } from "../../types.js";
import { authorEditReplacement, authorFileContent, AuthoringError } from "./authoring.js";
import { isBlankLineDriftOnly } from "./authored-output.js";
import { coerceToString } from "../../orchestrator/tool-arg-coercion.js";
import {
  comprehendFile,
  coversRange,
  forgetComprehension,
  reanchorComprehension,
  hashContent,
  mergeUsage,
  rateFileComplexity,
  recallComprehension,
  rememberComprehension,
} from "./comprehension.js";
import { selectModel } from "../../llm/model-selector.js";
import { resolveModel } from "../../llm/models.js";
import { resolveShellEnvironment } from "../../exec/shell-env.js";
import { GREP_ONLY_EXCLUDED_DIRS, IGNORED_PROJECT_DIRS } from "../../project-tree.js";
import type { ProjectCategory } from "../../presets/project-presets.js";
import {
  commandNotFoundNames,
  installHint,
  missingExecutableGuidance,
  resolveProjectToolchain,
  substitutionNote,
} from "../../exec/toolchain.js";
import { guessMimeType } from "../../multimodal/attachment.js";
import {
  ambiguityNote,
  scopeImagesForTarget,
  type ImageScope,
  type LiveImage,
} from "../../multimodal/attachment-routing.js";

/**
 * Self-assessment fields shared by `write` and `edit`.
 *
 * The mutating tools are the one place where the model already holds everything
 * an escalation decision needs — the target path and the actual code — at the
 * moment the call is made. Asking for a rating here costs ZERO extra LLM calls,
 * which is why the write half declares its complexity inline while the read half
 * has to spend a rater call (there is nothing to judge until the bytes exist).
 *
 * Both fields are OPTIONAL by design. A model that omits them leaves the call on
 * the pre-flight arithmetic estimate — i.e. exactly the previous behavior — so
 * this cannot regress a host or a model that does not know about them.
 *
 * The rubric mirrors `CODE_RISK_FOR_RATING`, and the framing is deliberately
 * about the FILE AND TASK rather than "the code you just drafted": when an
 * authoring model is pinned, that draft is discarded and the bytes are written
 * from scratch (see `writeTool`), so a rating of the draft would describe work
 * that never reaches disk.
 */
const SELF_ASSESSMENT_PARAMS = {
  complexity: {
    type: "string",
    enum: ["low", "medium", "high"],
    description:
      "How hard is this file and change to get RIGHT — not how long it is. " +
      "high = subtle control flow or concurrency, invariants that are not stated locally, " +
      "dense generics, or a wrong edit here breaks callers elsewhere. " +
      "medium = real logic you could plausibly get wrong. " +
      "low = mechanical, self-contained, obviously correct on inspection. " +
      "Judge the target file and the task, NOT the text you are passing in this call. " +
      "Answer honestly: a higher rating buys a stronger model for the actual write.",
  },
  category: {
    type: "string",
    enum: ["ui", "svg", "code"],
    description:
      "What kind of work this is. ui = rendered interface (components, layout, styling, visual states). " +
      "svg = vector artwork edited as markup, where paths and geometry matter. " +
      "code = everything else (logic, types, config, tests, build). " +
      "Independent of `complexity`: this selects what the escalation model must be strong at, not whether to escalate.",
  },
};

const pexec = promisify(exec);
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/**
 * Ceiling for commands that are SUPPOSED to take minutes.
 *
 * The 120s default is right for the inspection commands that make up most of a
 * run, and wrong for every native build there is: a cold `flutter build`, a
 * `pod install` that resolves a spec repo, a Gradle sync, an `xcodebuild` — all
 * routinely exceed two minutes on a first run. Killing one at 120s and handing
 * back a truncated log looks exactly like a build failure, and the model then
 * "fixes" code that was never broken. Callers can still pass `timeoutMs`; this
 * only moves the DEFAULT for commands whose shape says they are slow.
 */
const HEAVY_BASH_TIMEOUT_MS = 600_000;
const HEAVY_COMMAND_PATTERNS = [
  /\bflutter\s+(build|test|analyze|precache|clean|pub\b)/i,
  /\bdart\s+(pub\b|compile|analyze)/i,
  /\bpod\s+(install|update|repo)\b/i,
  /\bxcodebuild\b/i,
  /\bgradlew?\b/i,
  /\bmvnw?\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|i)\b/i,
  /\bbundle\s+install\b/i,
  /\bcargo\s+(build|test|check|clippy)\b/i,
  /\bgo\s+(build|test)\b/i,
  /\bmake\b/i,
  /\bdocker\s+(build|compose)\b/i,
  /\bxcrun\s+simctl\s+(boot|install|erase)\b/i,
];
const DEFAULT_BACKGROUND_POLL_MS = 8_000;
/**
 * Longer readiness window for app launches on a device/simulator.
 *
 * A web dev server prints its URL in a second or two, so 8s is generous there.
 * `flutter run` compiles the app, installs it, and only then boots it — the
 * first ready line is minutes away on a cold build. Returning "pending" after 8s
 * is not wrong, but it costs the model a poll loop on the single command it most
 * needs to succeed, so this window is sized for the slower surface.
 */
const DEVICE_RUN_POLL_MS = 90_000;
const DEFAULT_BACKGROUND_POLL_INTERVAL_MS = 500;
/**
 * LISTEN mode (`waitMs`): how long the output must stay line-quiet before the
 * command counts as SETTLED. This replaces the sleep/tail polling loop the
 * model used to run while a build compiled: the tool itself watches the log
 * and returns the moment there is an outcome to report.
 */
const DEFAULT_LISTEN_DEBOUNCE_MS = 4_000;
const MIN_LISTEN_DEBOUNCE_MS = 500;
const MAX_BACKGROUND_WAIT_MS = 600_000;
const DEFAULT_READY_PATTERNS = [
  /ready in/i,
  /local:\s+http/i,
  /serving!/i,
  /metro waiting/i,
  /started server on/i,
  /serving http on/i,
  /compiled successfully/i,
  /listening on/i,
  // Mobile: the lines a device/simulator launch prints once the app is up.
  /flutter run key commands/i,
  /syncing files to device/i,
  /(dart vm service|flutter devtools).{0,40}available at/i,
  /application .{0,40}(launched|started) on/i,
  /\bbuild succeeded\b/i,
  /successfully launched/i,
];
const DEFAULT_FAILURE_PATTERNS = [
  /eaddrinuse/i,
  /address already in use/i,
  /port \d+ is already in use/i,
  /command not found/i,
  /npm error/i,
  /\berr!\b/i,
  /failed to compile/i,
  /cannot find module/i,
  /module not found/i,
  /error:\s/i,
  /uncaught/i,
  /exception/i,
  // Mobile: a launch with nowhere to launch TO. Distinct from a build error and
  // fixable in one step (boot a simulator), so it must fail fast rather than
  // sit in the poll loop until the window closes.
  /no supported devices connected/i,
  /no devices found/i,
  /error launching application/i,
  /unable to find a destination/i,
];
const START_COMMAND_PATTERNS = [
  /\bnpm\s+run\s+(dev|start|preview)\b/i,
  /\bpnpm\s+(dev|start|preview)\b/i,
  /\byarn\s+(dev|start|preview)\b/i,
  /\bnpx\s+(vite|next|expo|serve)\b/i,
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\b(?:vite|next|expo)\s+(?:dev|start|preview)\b/i,
  // App launches on a device/simulator. These never exit on their own — run in
  // the foreground they burn the whole timeout and return a killed process,
  // which is why a visual check on a mobile repo could never get off the ground.
  /\bflutter\s+run\b/i,
  /\breact-native\s+(?:start|run-(?:ios|android))\b/i,
  /\bgradlew?\s+.*\bbootRun\b/i,
];
/** Commands whose readiness window should be `DEVICE_RUN_POLL_MS`. */
const DEVICE_RUN_PATTERNS = [
  /\bflutter\s+run\b/i,
  /\breact-native\s+run-(?:ios|android)\b/i,
];

function isHeavyCommand(command: string): boolean {
  return HEAVY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function defaultPollMs(command: string): number {
  return DEVICE_RUN_PATTERNS.some((pattern) => pattern.test(command))
    ? DEVICE_RUN_POLL_MS
    : DEFAULT_BACKGROUND_POLL_MS;
}
const READONLY_SHELL_BLOCKS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(^|[\s;|&(])(?:\d*>>?|\d*>\|?|&>>?|&>|\|?\s*tee\b)/i,
    reason: "redirection writes or tee output",
  },
  {
    pattern: /\b(mkdir|rm|mv|cp|touch|install)\b/i,
    reason: "filesystem mutation command",
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|create|dlx|dev|start|preview|serve)\b/i,
    reason: "package install/start command",
  },
  {
    pattern: /\bnpx\s+(?:vite|next|expo|serve|create-[\w-]+|create)\b/i,
    reason: "package start/bootstrap command",
  },
  {
    pattern: /\b(?:nohup|setsid|disown)\b|(^|[^&])&\s*$/i,
    reason: "background process launch",
  },
];

function resolveInCwd(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  return abs;
}

type MutationDiffLine =
  | { type: "context"; line: string }
  | { type: "add"; line: string }
  | { type: "remove"; line: string };

function normalizeDiffText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function splitDiffLines(text: string): string[] {
  const normalized = normalizeDiffText(text);
  if (!normalized) return [];
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function diffLines(beforeLines: string[], afterLines: string[]): MutationDiffLine[] {
  const pairCount = beforeLines.length * afterLines.length;
  if (pairCount > 120_000) return fastDiffLines(beforeLines, afterLines);

  const dp = Array.from({ length: beforeLines.length + 1 }, () => new Array<number>(afterLines.length + 1).fill(0));
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        beforeLines[i] === afterLines[j]
          ? (dp[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }

  const out: MutationDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      out.push({ type: "context", line: beforeLines[i]! });
      i += 1;
      j += 1;
      continue;
    }
    if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: "remove", line: beforeLines[i]! });
      i += 1;
      continue;
    }
    out.push({ type: "add", line: afterLines[j]! });
    j += 1;
  }
  while (i < beforeLines.length) {
    out.push({ type: "remove", line: beforeLines[i]! });
    i += 1;
  }
  while (j < afterLines.length) {
    out.push({ type: "add", line: afterLines[j]! });
    j += 1;
  }
  return out;
}

function fastDiffLines(beforeLines: string[], afterLines: string[]): MutationDiffLine[] {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: MutationDiffLine[] = [];
  for (const line of beforeLines.slice(0, prefix)) out.push({ type: "context", line });
  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) out.push({ type: "remove", line });
  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) out.push({ type: "add", line });
  for (const line of beforeLines.slice(beforeLines.length - suffix)) out.push({ type: "context", line });
  return out;
}

function formatUnifiedRange(start: number, count: number): string {
  return `${start},${count}`;
}

function buildUnifiedDiff(file: string, before: string, after: string): { diff?: string; additions: number; deletions: number } {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const lines = diffLines(beforeLines, afterLines);
  const additions = lines.filter((line) => line.type === "add").length;
  const deletions = lines.filter((line) => line.type === "remove").length;
  if (additions === 0 && deletions === 0) return { additions, deletions };

  const oldStart = beforeLines.length === 0 ? 0 : 1;
  const newStart = afterLines.length === 0 ? 0 : 1;
  const body = lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.line}`);
  return {
    additions,
    deletions,
    diff: [
      `--- ${file}`,
      `+++ ${file}`,
      `@@ -${formatUnifiedRange(oldStart, beforeLines.length)} +${formatUnifiedRange(newStart, afterLines.length)} @@`,
      ...body,
    ].join("\n"),
  };
}

async function readExistingFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Collect the image references for a vision authoring pass on write/edit, SCOPED
 * to the file being written.
 *
 * This used to be a union: the call's `images` arg plus every image the host had
 * injected on `ctx.images`. That is right for the single-mockup run and wrong for
 * every other one — a run carrying three screens handed all three to each file,
 * so `Login.tsx` was authored while looking at the checkout design. Routing is
 * delegated to {@link scopeImagesForTarget}, which passes an image only when it
 * can say why it belongs to THIS file (see that module for the order of
 * evidence). An explicit `images` arg still wins outright.
 *
 * Returns the scope rather than a bare list so the caller can report an
 * `ambiguous` outcome back to the model instead of silently authoring blind.
 */
function collectImageRefs(
  target: string,
  argImages: unknown,
  ctxImages: readonly LiveImage[] | undefined,
): ImageScope {
  const seen = new Set<string>();
  const named: LiveImage[] = [];
  if (Array.isArray(argImages)) {
    for (const entry of argImages) {
      if (typeof entry !== "string") continue;
      const p = entry.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      named.push({ path: p, mimeType: guessMimeType(p) });
    }
  }
  const live: LiveImage[] = [];
  if (Array.isArray(ctxImages)) {
    for (const entry of ctxImages) {
      if (!entry || typeof entry.path !== "string" || seen.has(entry.path)) continue;
      seen.add(entry.path);
      live.push({ ...entry, mimeType: entry.mimeType || guessMimeType(entry.path) });
    }
  }
  return scopeImagesForTarget(target, live, named);
}

/**
 * File extensions that hold AUTHORED content — the bytes `authorOnlyWrites`
 * exists to route through Model B. Deliberately a source/asset list, not "any
 * path": `npm run build > build.log` must keep working, and a `.log`, `.txt` or
 * `.tmp` redirect is plumbing, not authorship.
 */
const AUTHORED_EXTENSIONS =
  /\.(m?[jt]sx?|css|s[ac]ss|html?|json|ya?ml|md|dart|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|php|sql|svg|vue|svelte|astro|toml|sh|bash|zsh|lua|r|sc|scala|clj|ex|exs|erl|elm|fs|hs|ml|nim|pl|pm|tcl|vala|v)$/i;

/**
 * Shell fragments that write file CONTENTS, paired with the path they target.
 *
 * Only content-authoring forms are listed. `mkdir`, `rm`, `cp`, `mv`, `touch`,
 * `git`, package managers and build tools are all absent on purpose: they move,
 * remove or produce files without any model deciding what the bytes say, which
 * is the thing this guard is about.
 */
const SHELL_AUTHORING_FORMS: Array<{ label: string; re: RegExp; fullCommand?: boolean }> = [
  { label: "heredoc redirect", re: /(?:>{1,2})\s*([^\s<>|;&]+)[\s\S]*?<<-?\s*['"]?\w+/g },
  { label: "output redirect", re: /(?:^|[^0-9<>])>{1,2}\s*([^\s<>|;&]+)/g },
  { label: "sed -i", re: /\bsed\b[^|;&]*\s-i(?:\.\w+)?\b[^|;&]*?\s([^\s|;&]+)\s*$/g },
  { label: "tee", re: /\btee\b(?:\s+-a)?\s+([^\s|;&]+)/g },
  { label: "python inline write", re: /\bpython3?\b[^|;&]*\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g },
  // `pathlib.Path("file").write_text(...)` / `write_bytes(...)` — the form a
  // model reaches for when `open(...,'w')` is recognised but it still wants to
  // author through the shell. `fullCommand: true` because a `python3 -c` one-
  // liner or heredoc separates the import (`from pathlib import Path;`) from the
  // write with a Python `;`, and the shell-segment split would break that apart.
  { label: "python pathlib write", re: /\bPath\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?\bwrite_(?:text|bytes)\s*\(/g, fullCommand: true },
];

/**
 * Under `authorOnlyWrites`, decide whether a shell command is authoring file
 * contents behind the authoring model's back.
 *
 * `authorOnlyWrites` only ever swapped the `write`/`edit` SCHEMAS, so the
 * guarantee it appears to make — "the bytes are authored by Model B" — held
 * exactly as long as the driver chose those two tools. `bash` is `mutates: true`
 * and always shipped in the same toolset, so a heredoc or a `>` redirect wrote
 * source with no authoring pass, no task context and no record of who authored
 * it. That is not a sandbox failure (the shell is meant to be powerful); it is
 * the mode quietly not covering its own claim.
 *
 * Returns the offending path when the command writes authored content, else null.
 */
export function detectShellAuthoring(command: string): { path: string; form: string } | null {
  // `fullCommand` forms (the python pathlib write) are matched against the WHOLE
  // command, because a `python3 -c` one-liner separates statements with `;` and
  // the per-segment split below would break `Path(x); Path(x).write_text(y)` in
  // two. The shell forms are matched per-segment so `npm test && cat > x.ts` is
  // judged by its second segment alone.
  for (const { label, re, fullCommand } of SHELL_AUTHORING_FORMS) {
    if (!fullCommand) continue;
    for (const m of command.matchAll(re)) {
      const target = m[1]?.replace(/^['"]|['"]$/g, "");
      if (target && AUTHORED_EXTENSIONS.test(target)) return { path: target, form: label };
    }
  }
  // Split on separators so `npm test && cat > src/x.ts <<EOF` is judged per segment.
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    for (const { label, re, fullCommand } of SHELL_AUTHORING_FORMS) {
      if (fullCommand) continue;
      // ALL matches, not the first. `echo '<h1>x</h1>' > index.html` contains a
      // `>` inside the payload that matches the redirect pattern before the real
      // redirect does; taking only `exec`'s first hit let exactly the commands
      // this guard exists to catch slip past, because HTML is full of `>`.
      for (const m of segment.trim().matchAll(re)) {
        const target = m[1]?.replace(/^['"]|['"]$/g, "");
        if (target && AUTHORED_EXTENSIONS.test(target)) return { path: target, form: label };
      }
    }
  }
  return null;
}

/**
 * Activity-monitor probe markers. Local copy, as in `loop.ts`/`orchestrator.ts`/
 * `activity-monitor.ts` — one regex is not worth a cross-module import.
 */

/**
 * Whether replacing `oldString` with `newString` only ADDS or REMOVES trace
 * instrumentation, changing no other line — and which direction it goes.
 *
 * Two callers share this one definition, and they must agree or the system
 * contradicts itself: the reproduce gate uses it to decide whether an `edit` is
 * instrumentation (allowed while a trace is open) or a fix (refused until the bug
 * is observed), and `edit` itself uses it to decide whether a `probe` payload may
 * be written VERBATIM in author-only mode. A form one accepted and the other
 * rejected would mean an edit the gate permits and the tool refuses.
 *
 * The test is a probe-marker delta plus "every meaningful line survives, in
 * order": blank lines and probe lines are ignored entirely, so inserting `__t()`
 * calls — or the helper block the trace tool hands back, whose body lines do not
 * all carry a marker — passes, while rewriting a condition or deleting a branch
 * fails, because the original line is gone from the other side.
 *
 * A fix that is a PURE addition (a guard inserted, nothing rewritten) paired with
 * a probe in the same call would pass. That limit is accepted in the gate, where
 * `maxBlocks` would have let such an edit through anyway; it is the reason the
 * `probe` argument is documented as instrumentation-only rather than as a general
 * escape from the authoring model.
 */
export function probeOnlyReplacement(oldString: string, newString: string): "insert" | "strip" | null {
  const markers = (s: string) => (s.match(new RegExp(PROBE_MARKER_RE.source, "g")) ?? []).length;
  const meaningful = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !PROBE_MARKER_RE.test(l));
  const preserved = (before: string, after: string) => {
    const from = meaningful(before);
    const to = meaningful(after);
    let i = 0;
    for (const line of to) if (i < from.length && from[i] === line) i += 1;
    return i === from.length;
  };
  const before = markers(oldString);
  const after = markers(newString);
  if (after > before && preserved(oldString, newString)) return "insert";
  if (before > after && preserved(newString, oldString)) return "strip";
  return null;
}

/**
 * Whether an edit changes ONLY literal content — the text inside quotes and the
 * numbers — leaving the code structure around them byte-identical.
 *
 * This is the second verbatim escape from the authoring pass, alongside
 * {@link probeOnlyReplacement}, and it exists because discarding the driver's
 * `newString` has a failure mode that the "B sees the whole file, so the change
 * is specified" argument does not cover: a change whose ONLY specification is the
 * literal itself.
 *
 * The observed run: task "change title of delete account popup", anchor on
 * `Text('Delete account?')`, driver's `newString` `Text('Delete Account')`. The
 * draft was dropped, so the authoring model received the anchor, the file, and an
 * ambiguous task — and authored `'Delete Account?'`, then on the next attempt
 * `'Delete Your Account?'`. Neither is wrong from what it was given; neither is
 * what was asked for. The driver then re-edited the same six lines four times,
 * which is precisely the symptom `executeEdit` documents as the signal that
 * dropping the draft has regressed.
 *
 * The fix is narrow on purpose. A stronger model authoring the replacement is
 * right whenever the change has to be DESIGNED — layout, logic, a component. When
 * the change IS the literal, there is nothing to design: the driver already
 * carries the exact bytes, and routing them through a second model can only
 * corrupt them. So a replacement that touches nothing but literals is applied
 * exactly as written, and everything else still escalates unchanged.
 *
 * Returns true only when the skeletons match exactly AND some literal differs, so
 * a no-op edit and a structural rewrite both fall through to authoring.
 */
export function literalOnlyReplacement(oldString: string, newString: string): boolean {
  if (typeof oldString !== "string" || typeof newString !== "string") return false;
  if (!oldString || !newString || oldString === newString) return false;

  /**
   * Replace every string literal and numeric literal with a positional
   * placeholder, and collect the literals in order. Quote-aware so an apostrophe
   * inside a double-quoted string does not open a literal, and escape-aware so
   * `'it\'s'` closes where it should.
   */
  const skeletonize = (src: string): { skeleton: string; literals: string[] } => {
    const literals: string[] = [];
    let skeleton = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch;
        let j = i + 1;
        let body = "";
        while (j < src.length) {
          if (src[j] === "\\" && j + 1 < src.length) {
            body += src.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (src[j] === quote) break;
          body += src[j];
          j += 1;
        }
        // An unterminated literal means we cannot reason about this snippet at
        // all; bail out to authoring rather than guess where it ended.
        if (j >= src.length) return { skeleton: `\x00unterminated`, literals: [] };
        literals.push(body);
        skeleton += `${quote}\x00${quote}`;
        i = j + 1;
        continue;
      }
      // A numeric literal, but only where a number can legitimately start — so
      // the `1` in `w1` or `Color1` is part of an identifier, not a literal.
      if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "")) {
        const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i))!;
        literals.push(m[0]);
        skeleton += "\x00";
        i += m[0].length;
        continue;
      }
      skeleton += ch;
      i += 1;
    }
    return { skeleton, literals };
  };

  const a = skeletonize(oldString);
  const b = skeletonize(newString);
  if (a.skeleton.startsWith("\x00unterminated") || b.skeleton.startsWith("\x00unterminated")) return false;
  // Compare skeletons with whitespace collapsed: re-indenting the anchor is not a
  // structural change, and a model quoting the file back rarely reproduces its
  // leading whitespace exactly.
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  if (collapse(a.skeleton) !== collapse(b.skeleton)) return false;
  if (a.literals.length !== b.literals.length) return false;
  return a.literals.some((lit, idx) => lit !== b.literals[idx]);
}

/** Matches one `grep` call may return before it is cut short. */
const GREP_MAX_MATCHES = 200;
/** Hard byte ceiling on the child process, so a pathological search cannot buffer GBs. */
const GREP_MAX_BUFFER = 2 * 1024 * 1024;
/** Characters of grep output handed back, after which it is truncated with a notice. */
const GREP_MAX_CHARS = 20_000;

/**
 * Trim grep output to something a conversation can carry, and SAY it was
 * trimmed.
 *
 * Silence is the dangerous part: a model that receives 200 of 5,000 matches and
 * is not told will conclude it has seen every use of a symbol, and then edit as
 * if that were true.
 */
function capGrepOutput(raw: string, pattern: string): string {
  const text = raw.trim();
  if (!text) return "(no matches)";
  // `rg -m N` caps the MATCH COUNT at the source. When it stops at N matches,
  // more were dropped — yet N short lines can sit well under the character
  // ceiling below, which would then return them with no notice. That silence is
  // the exact case this function exists to prevent: a model that receives 200 of
  // 80,000 matches and concludes it has seen every use of a symbol.
  const matchCount = text.split("\n").length;
  const hitMatchCap = matchCount >= GREP_MAX_MATCHES;
  if (text.length <= GREP_MAX_CHARS && !hitMatchCap) return text;
  // Match cap bit but the chars still fit: show every line we have, then flag it.
  if (hitMatchCap && text.length <= GREP_MAX_CHARS) {
    return (
      `${text}\n\n` +
      `… [showing the first ~${matchCount} matching lines for ${JSON.stringify(pattern)}. There are MORE ` +
      `matches than this. Narrow the search — pass \`path\` to a specific directory, add a \`glob\`, or use a ` +
      `more specific pattern — before concluding anything about how many places this appears.]`
    );
  }
  const kept = text.slice(0, GREP_MAX_CHARS);
  const lines = kept.split("\n").length;
  return (
    `${kept.slice(0, kept.lastIndexOf("\n"))}\n\n` +
    `… [truncated: showing the first ~${lines} matching lines for ${JSON.stringify(pattern)}. There are MORE ` +
    `matches than this. Narrow the search — pass \`path\` to a specific directory, add a \`glob\`, or use a ` +
    `more specific pattern — before concluding anything about how many places this appears.]`
  );
}

export const bashTool: AgentTool = {
  name: "bash",
  description:
    "Run a shell command to understand the project, inspect files/folders, or execute build/test/lint commands. Returns stdout+stderr. " +
    "Long startups (builds, dev servers, device launches) take `background: true` + `waitMs`: the call then LISTENS to the " +
    "output and returns on the outcome — ready, failed, exited, or output settled (line-quiet debounce) — so you never " +
    "sleep or tail-poll.",
  mutates: true,
  // Mutating shell is only available once the chain reaches execution /
  // verification phases. Prepare/Plan must stay read-only.
  categorizers: ["write_edit", "activity_inspect"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeoutMs: { type: "number", description: "Timeout in ms for blocking commands (default 120000)." },
      background: {
        type: "boolean",
        description:
          "Start the command as a background process and poll briefly for readiness instead of waiting for exit. Useful for dev servers/watchers. If this exact command is already running in the background it is NOT started again — you get its status and log tail instead.",
      },
      waitMs: {
        type: "number",
        description:
          "Background only — LISTEN mode. Keep watching the command's output until it is ready, fails, exits, or the " +
          "output settles (no new lines for debounceMs), then return the outcome + tail. Use this for builds instead of " +
          "sleep/tail polling (e.g. 300000 for a cold mobile build). Max 600000.",
      },
      debounceMs: {
        type: "number",
        description:
          "Background LISTEN only: how long the output must stay line-quiet before the command counts as settled (default 4000, min 500).",
      },
      force: {
        type: "boolean",
        description:
          "Background only: start a second copy even though this exact command is already running. Almost never right — two dev servers or two device launches fight over the same port or device.",
      },
      pollMs: {
        type: "number",
        description: "How long to poll a background command for readiness before returning pending (default 8000).",
      },
      readyPattern: {
        type: "string",
        description: "Optional regex/string to match in background command logs when startup is complete.",
      },
      failurePattern: {
        type: "string",
        description: "Optional regex/string to match in background command logs when startup has failed and should return early.",
      },
    },
    required: ["command"],
  },
  async execute(_id, args, ctx) {
    const command = String(args.command ?? args.cmd ?? "");
    const timeout = Number(
      args.timeoutMs ?? (isHeavyCommand(command) ? HEAVY_BASH_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS),
    );
    if (!command.trim()) {
      // Empty/missing 'command' is almost always a streaming artifact or
      // a placeholder turn-end call. Don't actually exec — return a clear,
      // self-correctable error so the model can retry with a real command.
      return {
        output: "bash: missing required argument 'command'. Provide a shell command and retry.",
        isError: true,
        details: { command: "" },
      };
    }
    ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:bash", "exec"], message: command });
    const runInBackground =
      args.background === true || (args.background == null && isLikelyBackgroundCommand(command));
    if (runInBackground) {
      return startBackgroundCommand(command, args, ctx);
    }
    return runBlockingShellCommand(command, timeout, ctx, "bash");
  },
};

export const bashReadonlyTool: AgentTool = {
  name: "bash_readonly",
  description:
    "Run a read-only shell inspection command in Prepare/Plan. Blocks file writes, package install/start commands, and background processes.",
  mutates: false,
  categorizers: ["read"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "A read-only shell command to inspect the workspace." },
      timeoutMs: { type: "number", description: "Timeout in ms for read-only inspection commands (default 120000)." },
    },
    required: ["command"],
  },
  async execute(_id, args, ctx) {
    const command = String(args.command ?? args.cmd ?? "");
    const timeout = Number(
      args.timeoutMs ?? (isHeavyCommand(command) ? HEAVY_BASH_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS),
    );
    if (!command.trim()) {
      return {
        output: "bash_readonly: missing required argument 'command'. Provide a read-only shell command and retry.",
        isError: true,
        details: { command: "" },
      };
    }
    const blocked = validateReadonlyShellCommand(command);
    if (blocked) {
      return {
        output: `bash_readonly: blocked "${command}" because it looks like ${blocked}. Use read/ls/grep for inspection, and reserve mutating shell for PERFORM/PERFECT.`,
        isError: true,
        details: { command, blockedReason: blocked },
      };
    }
    ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:bash_readonly", "exec"], message: command });
    return runBlockingShellCommand(command, timeout, ctx, "bash_readonly");
  },
};

/**
 * Background commands this process started that are still alive, keyed by the
 * normalized command text.
 *
 * Exists to stop a run launching the SAME long startup twice. A `background: true`
 * command that has not printed its ready signal yet returns "still running,
 * readiness is not confirmed" — which is honest, and which a model reads as "that
 * did not work". Observed on one run: three BYTE-IDENTICAL `flutter run` commands
 * launched against one simulator, plus `pkill -f flutter` twice to clean up the
 * mess, inside a 25-call stretch that never produced a running app. Two device
 * launches fighting over one device is never what was wanted, and the model has no
 * way to see that the first one is still making progress.
 *
 * Keyed on the exact normalized command, deliberately, rather than on a guess at
 * "the same kind of launch". That catches the repeat-verbatim case that actually
 * happens while leaving a DELIBERATE restart alone: the same run's
 * `pkill -f flutter || true; sleep 2; <same command>` is a different command and
 * still spawns, which is correct — the model said what it wanted.
 */
const LIVE_BACKGROUND: Map<string, { pid?: number; logFile: string; startedAt: number; child: { exitCode: number | null; killed: boolean } }> = new Map();

/** Collapse whitespace so trivial reformatting is still recognised as the same command. */
function backgroundKey(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Drop finished entries so a genuine relaunch after exit is never blocked. */
function pruneLiveBackground(): void {
  for (const [key, entry] of LIVE_BACKGROUND) {
    if (entry.child.exitCode !== null || entry.child.killed) LIVE_BACKGROUND.delete(key);
  }
}

async function startBackgroundCommand(
  command: string,
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
) {
  // LISTEN mode: instead of returning "pending" for the model to sleep/tail-poll,
  // keep watching the output stream until there is an outcome.
  const waitMs = Math.max(0, Math.min(Number(args.waitMs ?? 0) || 0, MAX_BACKGROUND_WAIT_MS));
  const debounceMs = Math.max(MIN_LISTEN_DEBOUNCE_MS, Number(args.debounceMs ?? DEFAULT_LISTEN_DEBOUNCE_MS) || DEFAULT_LISTEN_DEBOUNCE_MS);

  // ---- already running? ----
  pruneLiveBackground();
  const key = backgroundKey(command);
  const existing = args.force === true ? undefined : LIVE_BACKGROUND.get(key);
  if (existing) {
    const ageMs = Date.now() - existing.startedAt;
    // With `waitMs`, attach the listener to the RUNNING copy — that is the
    // whole point of the flag: wait for THIS one, don't spawn a competitor.
    if (waitMs > 0) {
      const poll = await pollBackgroundCommand({
        pid: existing.pid,
        logFile: existing.logFile,
        pollMs: 250,
        signal: ctx.signal,
        waitMs,
        debounceMs,
        child: existing.child,
      });
      const res = await formatBackgroundOutcome(poll, {
        command,
        note: "",
        resolved: { command, substitutions: [], unresolved: [], executables: [] },
        pid: existing.pid,
        logFile: existing.logFile,
        waitedMs: Date.now() - existing.startedAt,
        ctx,
      });
      return {
        ...res,
        output:
          `(This exact command was already running${existing.pid ? `, pid ${existing.pid}` : ""}, started ` +
          `${Math.round(ageMs / 1000)}s ago — the listener attached to IT instead of starting a second copy.)\n\n` +
          res.output,
        details: { ...((res.details ?? {}) as Record<string, unknown>), alreadyRunning: true, ageMs },
      };
    }
    let tail = "";
    try {
      const text = await fs.readFile(existing.logFile, "utf8");
      tail = text.split("\n").slice(-40).join("\n");
    } catch {
      tail = "(log not readable yet)";
    }
    return {
      output:
        `This exact command is ALREADY RUNNING in the background${existing.pid ? ` (pid ${existing.pid})` : ""}, ` +
        `started ${Math.round(ageMs / 1000)}s ago. It was NOT started again — a second copy of the same startup ` +
        `competes with the first for the same port or device, which is how a launch that was merely slow becomes ` +
        `a launch that is broken.\n\n` +
        `Wait for THIS one: re-issue the same command with \`waitMs\` and the call listens until it is ready, ` +
        `fails or settles.\n` +
        `If you believe it is genuinely wedged, kill it first and then relaunch, or pass \`force: true\` to run a ` +
        `second copy anyway.\n\nRecent log output:\n${tail}`,
      details: { command, logFile: existing.logFile, pid: existing.pid, alreadyRunning: true, ageMs },
    };
  }

  const pollMs = Math.max(250, Number(args.pollMs ?? defaultPollMs(command)));
  const readyPattern = compileReadyPattern(args.readyPattern);
  const failurePattern = compileReadyPattern(args.failurePattern);
  const { shellEnv, resolved } = await prepareShellCommand(command, ctx.cwd);
  const note = substitutionNote(resolved.substitutions);
  if (note) {
    ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:bash", "background", "toolchain"], message: note });
  }
  const { logFile } = await createBackgroundLogFile();
  const fd = syncFs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(resolved.command, {
      cwd: ctx.cwd,
      // The user's shell, not `/bin/sh` — a background command is written the
      // same way as a foreground one and must not silently lose zsh/bash syntax.
      shell: shellEnv.shell,
      env: shellEnv.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    syncFs.closeSync(fd);
  }

  child.unref();
  ctx.log({
    timestamp: Date.now(),
    level: "info",
    tags: ["tool:bash", "background"],
    message: `${resolved.command} [pid=${child.pid ?? "unknown"} log=${logFile}]`,
  });

  // Track BEFORE listening: in LISTEN mode this call may block for minutes, and
  // an identical relaunch during that window is exactly the duplicate the map
  // exists to prevent. The entry is pruned once the child exits, so a relaunch
  // after a real failure still works.
  LIVE_BACKGROUND.set(key, { ...(child.pid ? { pid: child.pid } : {}), logFile, startedAt: Date.now(), child });

  const poll = await pollBackgroundCommand({
    pid: child.pid,
    logFile,
    pollMs,
    readyPattern,
    failurePattern,
    signal: ctx.signal,
    ...(waitMs > 0 ? { waitMs, debounceMs } : {}),
    child,
  });

  return formatBackgroundOutcome(poll, {
    command,
    note,
    resolved,
    pid: child.pid,
    logFile,
    waitedMs: Date.now() - LIVE_BACKGROUND.get(key)!.startedAt,
    ctx,
  });
}

/**
 * One formatter for every background outcome, so the statuses say what they
 * mean and never teach the model to sleep-poll.
 */
async function formatBackgroundOutcome(
  poll: Awaited<ReturnType<typeof pollBackgroundCommand>>,
  meta: {
    command: string;
    note: string;
    resolved: Awaited<ReturnType<typeof prepareShellCommand>>["resolved"];
    pid?: number;
    logFile: string;
    waitedMs: number;
    ctx: Parameters<AgentTool["execute"]>[2];
  },
): Promise<ToolResult> {
  const { command, note, resolved, pid, logFile, ctx } = meta;
  const detailBase = {
    command,
    ...(resolved.command !== command ? { executedCommand: resolved.command } : {}),
    ...(resolved.substitutions.length ? { toolchain: resolved.substitutions } : {}),
    background: true,
    ...(pid ? { pid } : {}),
    logFile,
    status: poll.status,
    ...(poll.failureMatch ? { failureMatch: poll.failureMatch } : {}),
    ...(poll.exitCode !== undefined ? { exitCode: poll.exitCode } : {}),
    ...(poll.quietForMs !== undefined ? { quietForMs: poll.quietForMs } : {}),
  };

  if (poll.status === "failed") {
    const out = [
      poll.failureMatch
        ? `Background command reported a failure${poll.failureMatch ? ` via ${JSON.stringify(poll.failureMatch)}` : ""}.`
        : poll.exitCode !== undefined && poll.exitCode !== null
          ? `Background command exited with code ${poll.exitCode}.`
          : `Background command exited before it became ready.`,
      `Log file: ${logFile}`,
      poll.snippet ? `Log output:\n${poll.snippet}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    ctx.log({ timestamp: Date.now(), level: "error", tags: ["tool:bash", "background", "error"], message: out });
    const missing = notFoundEscalation(poll.snippet ?? "", resolved.executables);
    return {
      output: [note, out, missing.length ? missingExecutableGuidance(missing, await installHint(ctx.cwd)) : undefined]
        .filter(Boolean)
        .join("\n\n"),
      isError: true,
      details: detailBase,
    };
  }

  const outcome =
    poll.status === "ready"
      ? `Startup confirmed${poll.match ? ` via ${JSON.stringify(poll.match)}` : ""}. The process is running${pid ? ` (pid ${pid})` : ""}.`
      : poll.status === "exited"
        ? `Command COMPLETED (exit code 0) — for a build/install this is the success signal.`
        : poll.status === "settled"
          ? `Output SETTLED — no new lines for ${Math.round((poll.quietForMs ?? 0) / 1000)}s; the process is still running${pid ? ` (pid ${pid})` : ""}. ` +
            `Read the tail below and act on what it says (a finished build phase, or a server that is up and idle). ` +
            `Do NOT sleep or tail-poll — this call already waited for the output to go quiet.`
          : poll.status === "timeout"
            ? `Still running after ${Math.round(meta.waitedMs / 1000)}s with output still CHANGING — no ready/failure signal yet. ` +
              `Re-issue with a larger \`waitMs\` to keep listening, or act on the tail below.`
            : `Process is still running, but readiness is not confirmed yet. Re-issue with \`waitMs\` (e.g. 300000) to LISTEN ` +
              `until it is ready, fails or settles — do NOT sleep/tail-poll.`;

  const lines = [
    `Started background command${pid ? ` (pid ${pid})` : ""}. ${outcome}`,
    `Log file: ${logFile}`,
    poll.snippet ? `Recent log output:\n${poll.snippet}` : "Recent log output:\n(no output yet)",
  ];

  return {
    output: [note, lines.join("\n")].filter(Boolean).join("\n\n"),
    details: {
      ...detailBase,
      ...(poll.match ? { readyMatch: poll.match } : {}),
    },
  };
}

async function createBackgroundLogFile() {
  const dir = path.join(os.tmpdir(), "turing-harness-bg");
  await fs.mkdir(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logFile = path.join(dir, `bash-${stamp}.log`);
  await fs.writeFile(logFile, "", "utf8");
  return { dir, logFile };
}

/**
 * Watch a background command's log until there is an OUTCOME, not just a poll
 * window. Without `waitMs` this is the legacy readiness poll: return at the
 * first ready/failure signal or at `pollMs`. With `waitMs` (LISTEN mode) the
 * loop keeps watching the OUTPUT STREAM and resolves on the first of:
 *
 *   failed   — a failure pattern matched (custom or the built-in set), or the
 *              process died with a non-zero exit / was killed.
 *   ready    — a readiness pattern matched.
 *   exited   — the process exited cleanly (code 0): the command RAN TO
 *              COMPLETION, which for a build is the success signal.
 *   settled  — the output had content and then went line-quiet for
 *              `debounceMs`: a build between phases, or a server that is up
 *              and idle. Reported, not guessed at.
 *   timeout  — `waitMs` elapsed with output still changing.
 *
 * The debounce is the point: it is what lets ONE tool call replace the
 * `sleep 30 && tail` loops a model otherwise burns a turn budget on.
 */
async function pollBackgroundCommand(input: {
  pid?: number;
  logFile: string;
  pollMs: number;
  readyPattern?: RegExp;
  failurePattern?: RegExp;
  signal?: AbortSignal;
  /** LISTEN mode: total deadline. 0/undefined = legacy poll window only. */
  waitMs?: number;
  /** LISTEN mode: line-quiet period that counts as settled (default 4s). */
  debounceMs?: number;
  /** The spawned child (for exit-code truth); entries replayed from
   *  LIVE_BACKGROUND carry the same shape. */
  child?: { exitCode: number | null; killed: boolean };
}): Promise<{
  status: "ready" | "pending" | "failed" | "exited" | "settled" | "timeout";
  match?: string;
  failureMatch?: string;
  snippet?: string;
  quietForMs?: number;
  exitCode?: number | null;
}> {
  const startedAt = Date.now();
  const listen = (input.waitMs ?? 0) > 0;
  const deadline = listen
    ? Math.min(input.waitMs!, MAX_BACKGROUND_WAIT_MS)
    : input.pollMs;
  const debounce = Math.max(
    MIN_LISTEN_DEBOUNCE_MS,
    input.debounceMs ?? DEFAULT_LISTEN_DEBOUNCE_MS,
  );
  let lastSignature = -1;
  let lastChangeAt = startedAt;
  let sawOutput = false;

  const exitOutcome = async () => {
    // Killed with no code is a signal death — report it as a failure, not a
    // clean completion.
    const code = input.child?.exitCode ?? null;
    const killed = input.child?.killed === true;
    const dead = input.child
      ? input.child.exitCode !== null || killed
      : input.pid
        ? !isProcessAlive(input.pid)
        : false;
    if (!dead) return undefined;
    if (input.child) {
      return code === 0 && !killed
        ? ({ status: "exited", exitCode: code, snippet: await readLogSnippet(input.logFile) } as const)
        : ({ status: "failed", exitCode: code, snippet: await readLogSnippet(input.logFile) } as const);
    }
    // pid-only path (no child handle): exit code unknown, treat as failure —
    // a background startup that died before readiness never succeeded.
    return { status: "failed", snippet: await readLogSnippet(input.logFile) } as const;
  };

  while (Date.now() - startedAt < deadline) {
    if (input.signal?.aborted) {
      return {
        status: listen ? "timeout" : "pending",
        snippet: await readLogSnippet(input.logFile),
      };
    }
    const text = await readLogText(input.logFile);
    const snippet = snippetOf(text);
    const failed = matchFailure(text, input.failurePattern);
    if (failed) return { status: "failed", failureMatch: failed, snippet };
    const ready = matchReady(text, input.readyPattern);
    if (ready) return { status: "ready", match: ready, snippet };
    const exited = await exitOutcome();
    if (exited) return exited;
    if (listen && text.trim()) {
      // Signature = size + line count: any appended (or rewritten) line moves it.
      const signature = text.length * 1_000_003 + (text.match(/\n/g)?.length ?? 0);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangeAt = Date.now();
        sawOutput = true;
      } else if (sawOutput && Date.now() - lastChangeAt >= debounce) {
        return {
          status: "settled",
          quietForMs: Date.now() - lastChangeAt,
          snippet,
        };
      }
    }
    await delay(DEFAULT_BACKGROUND_POLL_INTERVAL_MS);
  }

  const text = await readLogText(input.logFile);
  const snippet = snippetOf(text);
  const exited = await exitOutcome();
  if (exited) return exited;
  if (listen) return { status: "timeout", snippet };
  return {
    status: matchFailure(text, input.failurePattern) ? "failed" : "pending",
    failureMatch: matchFailure(text, input.failurePattern),
    snippet,
  };
}

/** Full log text ("" when unreadable) — the listener reasons over all of it. */
async function readLogText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Tail-clamp a full log into a result snippet. */
function snippetOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > 1500 ? `…${trimmed.slice(-1500)}` : trimmed;
}

async function readLogSnippet(file: string): Promise<string> {
  return snippetOf(await readLogText(file));
}

function compileReadyPattern(value: unknown): RegExp | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  try {
    return new RegExp(raw, "i");
  } catch {
    return new RegExp(escapeRegExp(raw), "i");
  }
}

function matchReady(output: string, custom?: RegExp): string | undefined {
  if (!output) return undefined;
  const patterns = custom ? [custom] : DEFAULT_READY_PATTERNS;
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

function matchFailure(output: string, custom?: RegExp): string | undefined {
  if (!output) return undefined;
  const patterns = custom ? [custom] : DEFAULT_FAILURE_PATTERNS;
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLikelyBackgroundCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/[;&|]\s*(pkill|kill)\b/i.test(trimmed)) return false;
  if (/\bnohup\b/i.test(trimmed) || /(^|[^\w])(?:setsid)\b/i.test(trimmed)) return true;
  if (/(^|[^&])&\s*$/.test(trimmed)) return true;
  return START_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateReadonlyShellCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  // Redirecting to /dev/null discards output rather than writing a file, so it is
  // not the "redirection writes" this guard exists to stop. Strip it before the
  // rules run, so `cat f 2>/dev/null | head` reads as the read-only inspection it is.
  const suppressed = trimmed.replace(/(?:\d*&?|&)>>?\s*&?\s*\/dev\/null\b/g, " ");
  for (const rule of READONLY_SHELL_BLOCKS) {
    if (rule.pattern.test(suppressed)) return rule.reason;
  }
  return undefined;
}

/** Characters of shell output handed back before it is truncated with a notice. */
const SHELL_MAX_CHARS = 20_000;

/**
 * Trim shell output, keeping the HEAD and the TAIL.
 *
 * Both ends matter for a command: the head shows what it started doing, and the
 * tail carries the exit summary — the failing assertion, the compiler's error
 * count, the last line before it died. A build log or a recursive `find` fills
 * the middle with lines nobody needs, and left whole it is what makes the next
 * request too large to send.
 */
function capShellOutput(text: string): string {
  if (text.length <= SHELL_MAX_CHARS) return text;
  const keep = Math.floor(SHELL_MAX_CHARS / 2) - 120;
  const dropped = text.length - keep * 2;
  return (
    `${text.slice(0, keep)}\n\n` +
    `… [${dropped.toLocaleString("en-US")} characters omitted from the middle of this output. The head and tail ` +
    `are shown. Re-run with a narrower command (grep the log, \`tail -n\`, a specific target) if you need what ` +
    `is between them.] …\n\n${text.slice(-keep)}`
  );
}

/**
 * Prepare a command for execution: the user's shell environment, plus the
 * project's own toolchain pins.
 *
 * Shared by the blocking and background paths so a command cannot behave one way
 * in the foreground and another when it is backgrounded — the difference between
 * `flutter analyze` and `flutter run` should be how long they take, not whether
 * the SDK is findable.
 */
async function prepareShellCommand(command: string, cwd: string) {
  const shellEnv = await resolveShellEnvironment();
  const resolved = await resolveProjectToolchain(command, cwd, shellEnv.env);
  return { shellEnv, resolved };
}

/**
 * Turn a `command not found` in the OUTPUT into an actual error.
 *
 * `flutter analyze 2>&1 | head -50` exits 0 because `head` did, so a missing
 * toolchain arrived as a successful tool result whose text merely mentioned the
 * problem. The model treated that as "the check ran and said nothing", and every
 * verification gate downstream believed it. The name match against the command's
 * OWN executables is what keeps a `grep "command not found" build.log` from
 * being flagged: we only escalate when the thing reported missing is the thing
 * this command tried to run.
 */
function notFoundEscalation(out: string, executables: string[]): string[] {
  const reported = commandNotFoundNames(out);
  return reported.filter((name) => executables.includes(name));
}

/** Shape of the error `child_process.exec` rejects with. */
interface ExecFailure {
  stdout?: string;
  stderr?: string;
  message?: string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  code?: number | string | null;
  name?: string;
}

/**
 * Say WHY a command failed, in the cases where the raw error says nothing.
 *
 * From a real run: `flutter build apk --debug 2>&1 | tail -30` with
 * `timeoutMs: 180000` came back as the single line
 * `Command failed: flutter build apk --debug 2>&1 | tail -30`. No stdout, no
 * stderr, no mention of a timeout. The model read that as "the build is
 * failing, likely due to dependencies still resolving", abandoned the plan to
 * put the app on a simulator, and finished the run with the UI change
 * unverified. The build had not failed — it had been killed at three minutes,
 * roughly half way through a cold debug build.
 *
 * The empty output is not an accident either, and it is worth naming: `tail`
 * and `head -c` emit at EOF, so when the shell is killed they are holding the
 * entire log and it dies with them. A timeout plus a trailing `| tail` is total
 * blindness, every time.
 */
function describeExecFailure(e: ExecFailure, timeout: number, command: string, capturedOutput: string): string | undefined {
  const timedOut = e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
  if (timedOut && e.name !== "AbortError") {
    const seconds = Math.round(timeout / 1000);
    const lines = [
      `[timeout] Killed after ${seconds}s — the command did NOT fail, it ran out of time.`,
    ];
    if (!capturedOutput.trim() && /\|\s*(tail|head)\b/.test(command)) {
      lines.push(
        "No output came back because the pipeline ends in `tail`/`head`, which only emit at EOF — killed mid-run, " +
          "they take the whole log with them. Drop the pipe (or redirect to a file and read it) so a kill still leaves evidence.",
      );
    }
    if (isHeavyCommand(command)) {
      lines.push(
        `This command's shape (native build / dependency install) routinely exceeds ${seconds}s — the harness default ` +
          `for it is ${Math.round(HEAVY_BASH_TIMEOUT_MS / 1000)}s, which an explicit \`timeoutMs\` overrode. Re-run without ` +
          "`timeoutMs`, or with a larger one.",
      );
    }
    lines.push(
      "For anything that does not exit on its own (a dev server, `flutter run`, a watcher) do not raise the timeout — " +
        "pass `background: true` and poll the log it returns.",
    );
    return lines.join("\n");
  }
  if (e.name === "AbortError") return "[aborted] The run was cancelled before this command finished.";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "[output limit] The command produced more than 10 MB and was cut off. Narrow it (grep the log, `tail -n`, a specific target).";
  }
  return undefined;
}

async function runBlockingShellCommand(
  command: string,
  timeout: number,
  ctx: Parameters<AgentTool["execute"]>[2],
  toolName: "bash" | "bash_readonly",
) {
  const { shellEnv, resolved } = await prepareShellCommand(command, ctx.cwd);
  const note = substitutionNote(resolved.substitutions);
  if (note) {
    ctx.log({ timestamp: Date.now(), level: "info", tags: [`tool:${toolName}`, "toolchain"], message: note });
  }
  const decorate = (text: string) => (note ? `${note}\n\n${text}` : text);
  const details = {
    command,
    ...(resolved.command !== command ? { executedCommand: resolved.command } : {}),
    ...(resolved.substitutions.length ? { toolchain: resolved.substitutions } : {}),
    shellSource: shellEnv.source,
  };

  try {
    const { stdout, stderr } = await pexec(resolved.command, {
      cwd: ctx.cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      signal: ctx.signal,
      // The user's environment and the user's shell — see `exec/shell-env.ts`.
      env: shellEnv.env,
      shell: shellEnv.shell,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    const missing = notFoundEscalation(out, resolved.executables);
    if (missing.length) {
      const body = `${capShellOutput(out)}\n\n${missingExecutableGuidance(missing, await installHint(ctx.cwd))}`;
      ctx.log({ timestamp: Date.now(), level: "error", tags: [`tool:${toolName}`, "toolchain", "missing"], message: missing.join(", ") });
      return { output: decorate(body), isError: true, details: { ...details, missingExecutables: missing } };
    }
    return { output: decorate(capShellOutput(out) || "(no output)"), details };
  } catch (err) {
    const e = err as ExecFailure;
    const captured = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    const out = [captured, e.message].filter(Boolean).join("\n").trim();
    ctx.log({ timestamp: Date.now(), level: "error", tags: [`tool:${toolName}`, "error"], message: out });
    const missing = notFoundEscalation(out, resolved.executables);
    // Why it failed comes FIRST: on a timeout the raw error is one uninformative
    // line, and whatever the model reads first is what it will diagnose from.
    const why = describeExecFailure(e, timeout, resolved.command, captured);
    const body = [
      why,
      capShellOutput(out) || (why ? undefined : "command failed"),
      missing.length ? missingExecutableGuidance(missing, await installHint(ctx.cwd)) : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      output: decorate(body),
      isError: true,
      details: {
        ...details,
        ...(missing.length ? { missingExecutables: missing } : {}),
        ...(e.killed || e.code === "ETIMEDOUT" ? { timedOutAfterMs: timeout } : {}),
      },
    };
  }
}

/**
 * Prefix every line with its 1-based number, in the same `N\tline` form `read`
 * returns to the caller. Used for the comprehension pass so the analysis cites
 * numbers the reader can actually navigate to — and the SAME numbers the reader is
 * looking at, which is the part that matters.
 */
function numberLines(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${i + 1}\t${l}`)
    .join("\n");
}

/**
 * `read`'s accepted arguments, named so `execute` can validate against the same
 * declaration the model was shown. See the undeclared-argument refusal below.
 */
const READ_PROPERTIES = {
  path: { type: "string", description: "File path (absolute or relative to cwd)." },
  offset: { type: "number", description: "1-based start line." },
  limit: { type: "number", description: "Max number of lines (a COUNT, not a last-line number)." },
} as const;

export const readTool: AgentTool = {
  name: "read",
  description: "Read a UTF-8 text file. Supports optional line offset/limit for large files.",
  mutates: false,
  categorizers: ["read", "write_edit", "activity_inspect"],
  parameters: {
    type: "object",
    properties: { ...READ_PROPERTIES },
    required: ["path"],
  },
  async execute(_id, args, ctx) {
    const rawPath = args.path;
    if (rawPath == null || String(rawPath).trim() === "") {
      return {
        output: "read: missing required argument 'path'. Provide a file path and retry.",
        isError: true,
      };
    }
    // An argument this tool does not declare is refused HERE rather than ignored
    // and warned about afterwards, because for `read` specifically an ignored
    // argument does not degrade the result — it silently changes which lines come
    // back. A call asking for a window around line 900 under any name this schema
    // does not know returns line 1 onward, which looks like a successful read of
    // the wrong thing. A model then reasons about source it did not ask for, and
    // the most common conclusion is that its own recent edit never landed.
    //
    // Derived from the schema, not from a list of names to look out for: whatever
    // `parameters.properties` declares is accepted and everything else is not, so
    // this needs no guesses about what a caller might type and stays correct if
    // the schema gains an argument.
    const declared = new Set<string>(Object.keys(READ_PROPERTIES));
    const undeclared = Object.keys(args).filter((k) => !declared.has(k));
    if (undeclared.length) {
      const plural = undeclared.length > 1;
      return {
        output:
          `read: ${undeclared.map((k) => `'${k}'`).join(", ")} ${plural ? "are" : "is"} not an argument of this tool, ` +
          `so nothing was read — an unrecognised window argument would silently return a DIFFERENT part of the ` +
          `file than you asked for, which is worse than an error. This tool takes: ` +
          `${[...declared].map((k) => `'${k}'`).join(", ")}. ` +
          `'offset' is the 1-based first line and 'limit' is a COUNT of lines (not a last-line number). Re-issue the call.`,
        isError: true,
        details: { path: String(rawPath), undeclaredArgs: undeclared },
      };
    }
    const file = resolveInCwd(ctx.cwd, String(rawPath));
    ctx.log({ timestamp: Date.now(), level: "debug", tags: ["tool:read"], message: file });
    try {
      const text = await fs.readFile(file, "utf8");
      let lines = text.split("\n");
      const offset = args.offset ? Math.max(1, Number(args.offset)) : 1;
      if (args.offset || args.limit) {
        const limit = args.limit ? Number(args.limit) : lines.length;
        lines = lines.slice(offset - 1, offset - 1 + limit);
      }
      const numbered = lines.map((l, i) => `${offset + i}\t${l}`).join("\n");
      // Identify the FILE (not the window) for comprehension reuse, plus which
      // part of it this call actually looked at.
      const fileHash = hashContent(text);
      const readRange = args.offset || args.limit ? `${offset}:${args.limit ?? "end"}` : "full";

      // ---- stage 2: rate, and escalate comprehension if the file is too hard ----
      // Mirrors the write/edit two-step, with the escalation decision made here
      // instead of by the host: there is nothing to judge until the bytes exist.
      const staged = await stageRead({ ctx, file, numbered, fullText: text, fileHash, readRange });

      return {
        output: !staged.analysis
          ? staged.analysisFailed && staged.comprehendedBy && staged.rating
            ? `${numbered}\n\n${comprehensionUnavailable(staged.comprehendedBy, staged.rating)}`
            : numbered
          : staged.repeated
            ? `${numbered}\n\n${comprehensionPointer(staged.comprehendedBy!)}`
            : `${numbered}\n\n${comprehensionBanner(staged.comprehendedBy!)}\n${staged.analysis}`,
        details: {
          path: file,
          lineCount: lines.length,
          ...(staged.rating ? { complexity: staged.rating } : {}),
          ...(staged.why ? { complexityWhy: staged.why } : {}),
          ...(staged.comprehendedBy ? { comprehendedBy: staged.comprehendedBy } : {}),
        },
        ...(staged.rating ? { measuredComplexity: staged.rating, measuredPath: file } : {}),
        ...(staged.usage ? { usage: staged.usage } : {}),
      };
    } catch (err) {
      return { output: `Failed to read ${file}: ${(err as Error).message}`, isError: true };
    }
  },
};


/**
 * Pick the model that will author these bytes.
 *
 * Two things had to be true and only one of them was: the HOST could pin an
 * authoring model via `PermissionDecision.authorModel`, but a run with no such
 * callback collected the images and then wrote Model A's text-only draft anyway —
 * so "here is the mockup, build it" quietly became "build it from the words".
 *
 * So when images are in play the tool escalates on its own, the same way the
 * staged `read` does: if the pinned model cannot see (or nothing was pinned), take
 * the cheapest vision-capable model in the run's candidate pool. Returns undefined
 * when there is nothing better available, which leaves today's behaviour intact.
 */
function resolveAuthorModel(
  ctx: ToolContext,
  images: Array<{ path: string; mimeType: string }>,
  /** The file being authored, so an undeclared category can be inferred from it. */
  file?: string,
): { model: Model; reason: "host-pinned" | "vision-escalated" } | undefined {
  const pinned = ctx.authorModel;
  const needsVision = images.length > 0;
  if (pinned && (!needsVision || pinned.input?.includes("image"))) {
    return { model: pinned, reason: "host-pinned" };
  }
  // The tier this call deserves. A declaration for THIS call beats a rating
  // measured for the path, which beats a bare guess.
  const tier = ctx.declaredComplexity ?? ctx.knownComplexity ?? "medium";

  // Ask the host's routing table FIRST, for EVERY write — plain code edits too,
  // not only vision. The host's policy (by kind/rating/category) is what decides
  // which model authors the bytes. Consulting it only for vision left plain code
  // edits unrouted, so they fell through to the driver — a silent breach of
  // author-only mode where the driver authored code the host never chose. The
  // routed slug is honoured as-is for a plain write; for a vision write it must
  // also be able to see, and if it cannot the candidate-pool fallback below finds
  // a model with eyes.
  if (ctx.routeModel) {
    // The category the host routes on. A declaration for THIS call wins; absent
    // one it is inferred from the file and the project, exactly as the authoring
    // PROMPT already does.
    //
    // Previously `category` was simply omitted when undeclared, which split the
    // two halves of the same decision: the prompt was told "this is `ui` work"
    // while the model that would carry it out was chosen with no category at all.
    // A host routing table keyed on category could not see UI work unless the
    // model happened to declare it, so the common case — an undeclared edit —
    // was routed as if category did not exist.
    const category = ctx.declaredCategory ?? (file ? categoryForPath(file, ctx.projectCategory) : undefined);
    const routedSlug = ctx.routeModel({
      kind: "write",
      rating: tier,
      ...(category ? { category } : {}),
      hasAttachment: needsVision,
    });
    if (routedSlug) {
      const routed = resolveModel(routedSlug);
      if (!needsVision || routed.input?.includes("image")) {
        return { model: routed, reason: "host-pinned" };
      }
    }
  }

  // No route, or a vision route that could not see: fall back to the candidate
  // pool for a vision-capable model. Plain writes have no pool fallback — the
  // host's routeModel (or a pinned authorModel) is the only source, so an
  // unrouted plain write resolves to `undefined` and, under author-only mode,
  // errors loudly instead of being silently authored by the driver.
  if (!needsVision || !ctx.toolModelCandidates?.length) {
    return pinned ? { model: pinned, reason: "host-pinned" } : undefined;
  }
  const { model } = selectModel({
    candidates: ctx.toolModelCandidates,
    // The tier decides capability; the images decide it must be a model with eyes.
    complexity: {
      score: ratingToScore(tier),
      signals: { inheritedComplexity: tier },
    },
    refs: images.map((img, i) => ({
      id: `author-image-${i}`,
      kind: "image" as const,
      uri: img.path,
      mimeType: img.mimeType,
    })),
  });
  if (!model.input?.includes("image")) return pinned ? { model: pinned, reason: "host-pinned" } : undefined;
  return { model, reason: "vision-escalated" };
}

/** Header marking B's analysis so the reading model never mistakes it for file bytes. */
function comprehensionBanner(model: string): string {
  return `--- ANALYSIS OF THE FILE ABOVE (from ${model}, a stronger model; the numbered lines above are the authoritative file contents) ---`;
}

/**
 * What a RE-READ of an already-analysed file gets instead of the analysis again.
 *
 * The analysis is already in the conversation, above; repeating it verbatim on
 * every window of the same file bought the reader nothing and cost real context
 * (six emissions of one 14KB analysis in an observed run). A pointer keeps the
 * fact that an analysis exists without paying for it twice.
 */
function comprehensionPointer(model: string): string {
  return (
    `--- (${model}'s analysis of this file is unchanged and was already given with an earlier read of it; ` +
    `scroll back rather than re-reading the file to get it again) ---`
  );
}

/**
 * What the reader is told when the escalation produced nothing usable.
 *
 * The alternative is to fall back to a plain read, which is what used to happen
 * and which is quietly wrong: stage 1 judged this file BEYOND the reading model,
 * a stronger model was paid to explain it, and the explanation was thrown away.
 * Saying nothing leaves the reader looking at an ordinary read result with no
 * indication that the file is one it was not trusted with — the exact impression
 * the escalation exists to prevent.
 *
 * So the read says so, briefly, and says what to do instead. It does NOT include
 * the rejected text: a hallucinated or collapsed analysis under a banner calling
 * it authoritative is how a run gets derailed, and "here is the bad analysis,
 * ignore it" is not a safe instruction to give a model that is already
 * struggling with this file.
 */
function comprehensionUnavailable(model: string, rating: ComplexityRating): string {
  return [
    `--- NOTE: this file was rated ${rating.toUpperCase()} — hard enough that a stronger model (${model}) was ` +
      `asked to explain it. Its answer came back unusable (twice) and was discarded, so you have the raw bytes ` +
      `and nothing else. ---`,
    `Do not treat that as "the file is simple". Work more carefully here than usual: re-read the specific ` +
      `region you intend to change plus its callers, keep the edit as narrow as the task allows, and prefer ` +
      `\`grep\`/\`graph_memory\` to confirm what else touches it rather than inferring from this file alone.`,
    `(The file's measured rating still stands, so a write/edit here is escalated to the stronger model for ` +
      `authoring regardless of this failure.)`,
  ].join("\n");
}

interface StageReadResult {
  rating?: ComplexityRating;
  why?: string;
  analysis?: string;
  comprehendedBy?: string;
  usage?: Usage;
  /**
   * True when this analysis was already appended to an earlier read result in
   * this run, so the caller emits a one-line pointer instead of the whole text.
   */
  repeated?: boolean;
  /**
   * The escalation ran and its output was rejected as unusable (both attempts).
   * The read still returns the bytes, but the reader is TOLD — see
   * {@link comprehensionUnavailable}.
   */
  analysisFailed?: boolean;
}

/**
 * The staged half of `read`: rate the file's reasoning difficulty, and when it
 * exceeds what the current model should be trusted with, have a stronger model
 * produce an analysis to append.
 *
 * Degrades silently to a plain read (returns `{}`) whenever the plumbing for
 * escalation is absent — no `llm`, no route and no candidate pool, or a file the
 * cheap prefilter says is obviously simple. That is why no config flag gates
 * this: a host that wires neither `routeModel` nor `toolModelCandidates` gets
 * exactly today's behavior.
 */
/**
 * Largest file sent WHOLE to the comprehension model when the caller asked for a
 * window. Beyond this the window is analysed instead — a request that never
 * reaches the provider helps nobody. ~80k chars is roughly 20k tokens, which the
 * escalation tier handles comfortably alongside its own output.
 */
const FULL_COMPREHENSION_MAX_CHARS = 80_000;

async function stageRead(input: {
  ctx: ToolContext;
  file: string;
  numbered: string;
  /** Digest of the whole file, so a windowed re-read of unchanged bytes still hits. */
  fileHash: string;
  /** The WHOLE file, regardless of which window the caller asked for. */
  fullText: string;
  /** Which part of the file this call read: `"full"` or `"<offset>:<limit>"`. */
  readRange: string;
}): Promise<StageReadResult> {
  const { ctx, file, numbered, fullText, fileHash, readRange } = input;
  // What the run is actually doing. `authoringContext` only exists for a
  // write/edit, so reading the task from it alone left the analyst with NOTHING
  // on every `read` — and its instructions open with "LEAD WITH THE TASK", so it
  // confabulated one from the file. `ctx.task` is populated on every call for
  // exactly this; the authoring context stays first because on a mutating call it
  // carries the clarified form.
  const readTask = ctx.authoringContext?.task ?? ctx.task;

  // Comprehend the WHOLE file when it is small enough to send, even though the
  // caller only asked for a window.
  //
  // Two reasons, and the second is why re-reads kept re-escalating. First, an
  // analysis of lines 200-300 cannot see the invariant established at line 40 or
  // the caller at line 900 — the things that make a file hard are exactly the
  // things a window hides. Second, an analysis scoped to one window is only
  // reusable for that same window, so a run that reads a file in three different
  // slices paid for three escalations of a file that never changed. Analysing the
  // file once makes the result answer every later window of it.
  //
  // Above the cap the file cannot be sent whole without risking the request, so
  // the window is analysed instead and recorded as covering only itself.
  const withinFullCap = fullText.length <= FULL_COMPREHENSION_MAX_CHARS;
  // NUMBER the text either way. The windowed branch already carried numbers; the
  // full-file branch sent the RAW file, and that quietly wrecked the output it
  // exists to produce.
  //
  // An analysis is only actionable if the reader can get to the line it names, and
  // a model handed unnumbered source has to count lines itself — which it does
  // badly. Observed on a 1,280-line file: EVERY citation came back approximate
  // ("line ~795"), and they were wrong by up to 275 lines (the function it placed
  // at ~795 was at 1070). Those estimates are then appended under a banner that
  // tells the reading model "the numbered lines above are the authoritative file
  // contents", so it trusts the numbers, jumps to unrelated code, and re-reads to
  // work out what happened. A confidently wrong line number is worse than none.
  const comprehendText = withinFullCap ? numberLines(fullText) : numbered;
  const comprehendRange = withinFullCap ? "full" : readRange;
  // Either escalation route will do — a host may wire the router and no pool.
  if (!ctx.llm || !ctx.model || !(ctx.toolModelCandidates?.length || ctx.routeModel)) return {};

  // ---- reuse: this run already comprehended these exact bytes ----
  //
  // Runs re-read files constantly — the model checks a detail, greps, comes back.
  // Each of those repeats cost a rating call AND a full escalation on the big
  // model, for a file that had not changed: one observed run rated the same
  // 1000-line provider THREE times and escalated all three, with no write in
  // between to justify any of it. The analysis is deterministic in the bytes, so
  // once it exists for this exact content there is nothing to recompute.
  //
  // Gated on the content hash, not the path: an analysis of different bytes would
  // be worse than no analysis, because it reads as current.
  const reusable = recallComprehension(file);
  if (reusable && !(reusable.fileHash === fileHash && coversRange(reusable.coveredRange, readRange))) {
    // Say WHICH precondition failed. "Escalated again" on its own is unactionable
    // — it cannot distinguish a genuinely changed file from a cache that is
    // silently never hitting, and telling those apart took a live log dig.
    ctx.log({
      timestamp: Date.now(),
      level: "debug",
      tags: ["tool:read", "escalation", "escalation:miss"],
      message:
        `${file}: cannot reuse prior analysis — ` +
        (reusable.fileHash !== fileHash
          ? "the file changed since it was analysed"
          : `it covers ${reusable.coveredRange ?? "an unrecorded range"} but this read wants ${readRange}`),
    });
  }
  if (reusable?.fileHash === fileHash && coversRange(reusable.coveredRange, readRange)) {
    ctx.log({
      timestamp: Date.now(),
      level: "info",
      tags: ["tool:read", "escalation", "escalation:reused"],
      message: `${file} unchanged since it was comprehended; reusing ${reusable.model} analysis (no re-rate, no re-escalation)`,
    });
    return {
      rating: reusable.rating,
      ...(reusable.why ? { why: reusable.why } : {}),
      ...(reusable.analysis
        ? { analysis: reusable.analysis, comprehendedBy: reusable.model, repeated: reusable.emitted === true }
        : {}),
    };
  }

  // A rating the run already holds beats spending a call to recompute it.
  let rating = ctx.knownComplexity;
  let why: string | undefined;
  let usage: Usage | undefined;

  if (!rating) {
    if (looksTrivial(file, numbered)) return { rating: "low" };
    const rated = await rateFileComplexity({
      llm: ctx.llm,
      model: ctx.model,
      path: file,
      content: numbered,
      category: categoryForPath(file, ctx.projectCategory),
      // Who is actually reading. The rating is "beyond THIS model?", so the
      // rater needs to know which model that is.
      ...(ctx.model?.openRouterSlug ?? ctx.model?.id
        ? { readerModel: ctx.model.openRouterSlug ?? ctx.model.id }
        : {}),
      ...(readTask ? { task: readTask } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    rating = rated.rating;
    why = rated.why;
    usage = rated.usage;
  }

  if (rating === "low") return { rating, ...(why ? { why } : {}), ...(usage ? { usage } : {}) };

  // The host's routing table wins: it names a model for this exact (kind,
  // rating) pair. Only when it has no opinion do we fall back to indexing the
  // candidate pool by score — which picks a tier by pool ORDER and arity, not by
  // anything the host stated. If that lands on the model already doing the
  // reading, there is nothing to escalate TO.
  const score = ratingToScore(rating);
  const routed = ctx.routeModel?.({ kind: "read", rating, category: categoryForPath(file, ctx.projectCategory), path: file });
  const escalated = routed
    ? resolveModel(routed)
    : selectModel({
        candidates: ctx.toolModelCandidates,
        complexity: { score, signals: { inheritedComplexity: rating } },
      }).model;
  const currentId = ctx.model?.openRouterSlug ?? ctx.model?.id;
  const escalatedId = escalated.openRouterSlug ?? escalated.id;
  if (!escalatedId || escalatedId === currentId) {
    return { rating, ...(why ? { why } : {}), ...(usage ? { usage } : {}) };
  }

  ctx.log({
    timestamp: Date.now(),
    level: "info",
    tags: ["tool:read", "escalation"],
    message: `${file} rated ${rating}${why ? ` (${why})` : ""}; comprehension escalated to ${escalatedId}`,
  });

  const comprehended = await comprehendFile({
    llm: ctx.llm,
    model: escalated,
    path: file,
    content: comprehendText,
    rating,
    // What kind of file this is, so the analysis is aimed at the risks that
    // actually apply — and so it matches the framing the authoring pass for this
    // same file will get.
    category: categoryForPath(file, ctx.projectCategory),
    ...(readTask ? { task: readTask } : {}),
    ...(why ? { why } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  // Remember what B worked out, keyed by path, so the authoring pass for a later
  // write/edit inherits it. Without this the understanding only ever reaches the
  // author by way of the ORCHESTRATOR's paraphrase of it — the strong model
  // explains the file, the weak model summarises the explanation, and the model
  // that actually writes the bytes never sees the original.
  if (comprehended.analysis) {
    rememberComprehension(file, {
      rating,
      analysis: comprehended.analysis,
      model: escalatedId,
      fileHash,
      coveredRange: comprehendRange,
      // This read is about to append it in full; every later read of the same
      // bytes gets the pointer.
      emitted: true,
      ...(why ? { why } : {}),
    });
  }

  // Paid for, produced nothing usable. Recorded loudly: this is a MODEL problem
  // (a collapsed generation, leaked reasoning) and the only way anyone finds out
  // that an escalation model has gone bad is if the harness says so.
  if (comprehended.rejected) {
    ctx.log({
      timestamp: Date.now(),
      level: "warn",
      tags: ["tool:read", "escalation", "escalation:rejected"],
      message:
        `${file}: ${escalatedId} returned no usable analysis (rejected twice as leaked reasoning or ` +
        `degenerate output); the read returns raw bytes with a warning. If this recurs, the escalation ` +
        `model is the problem, not the file.`,
    });
  }

  return {
    rating,
    ...(why ? { why } : {}),
    ...(comprehended.analysis ? { analysis: comprehended.analysis, comprehendedBy: escalatedId } : {}),
    ...(comprehended.rejected ? { analysisFailed: true, comprehendedBy: escalatedId } : {}),
    usage: mergeUsage(usage, comprehended.usage) ?? undefined,
  };
}

/** Extensions whose contents are data or prose, never worth an escalation call. */
const TRIVIAL_EXTENSIONS = new Set([
  // `.svg` is deliberately NOT here. Vector markup being edited by hand is real
  // work with its own escalation category, and treating it as data auto-rated it
  // `low` so it could never escalate. Machine-generated SVG is still filtered — it
  // is emitted as one long line, which the `< 40 lines` check below catches.
  ".json", ".lock", ".md", ".txt", ".yml", ".yaml", ".toml", ".ini", ".env",
  ".csv", ".snap", ".map",
]);

/** Extensions that are rendered interface work wherever they appear. */
const UI_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less",
  ".styl", ".html", ".htm", ".storyboard", ".xib", ".xaml",
]);

/**
 * Extensions that are interface work only in context — a `.dart` or `.swift` file
 * is as likely to be a model or a service as a screen. Counted as `ui` when the
 * PROJECT's product is a screen; see {@link categoryForPath}.
 */
const CONTEXTUAL_UI_EXTENSIONS = new Set([
  ".dart", ".swift", ".kt", ".kts", ".java", ".ts", ".js", ".mjs", ".cjs",
]);

/**
 * Best-effort category for a file, inferred from its extension and the project.
 *
 * A model-DECLARED category always wins over this — that is strictly better, since
 * a `.tsx` file may be pure logic and frequently is. This is the floor for a call
 * that declared nothing, and for a `read`, which has no declaration to offer and
 * where spending a rater call to ask would cost more than the precision is worth.
 *
 * The project category is consulted because the extension list alone was web-only,
 * and this is not a cosmetic classification: it is passed to
 * `authorEditReplacement`/`authorFileContent` as `category`, which is what the
 * host's routing table uses to pick the model that WRITES THE BYTES. So on any
 * non-web UI stack, an undeclared interface edit was categorised `code` and
 * authored by a model chosen for logic — a UI change written by the wrong model,
 * with nothing in the result saying so.
 */
function categoryForPath(file: string, projectCategory?: ProjectCategory): ComplexityCategory {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") return "svg";
  if (UI_EXTENSIONS.has(ext)) return "ui";
  const rendersScreens =
    projectCategory === "frontend" || projectCategory === "mobile" || projectCategory === "games";
  if (rendersScreens && CONTEXTUAL_UI_EXTENSIONS.has(ext)) return "ui";
  return "code";
}

/**
 * Cheap structural prefilter, run BEFORE spending a rater call. `read` is the
 * highest-frequency tool in the loop, so the common case — a short file, a config
 * file, generated output — must cost zero tokens to classify.
 *
 * Length alone is deliberately NOT a trivia signal in either direction: a long
 * generated barrel file is trivial, and a 60-line lock-free queue is not. We only
 * shortcut on signals that are hard to be wrong about.
 */
function looksTrivial(file: string, content: string): boolean {
  if (TRIVIAL_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  if (/^\s*(\/\/|#|\/\*)?\s*@generated\b/m.test(content)) return true;
  const lines = content.split("\n");
  if (lines.length < 40) return true;
  // Mostly-blank or mostly-comment files carry little logic to misread.
  const substantive = lines.filter((l) => {
    const t = l.replace(/^\d+\t/, "").trim();
    return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("#");
  });
  return substantive.length < 30;
}

/**
 * JSON-schema `parameters` for the `write` tool. In `authorOnly` mode the
 * `content` property is DROPPED entirely (and removed from `required`), so the
 * calling model never spends tokens generating a full-file draft that — once an
 * authoring model is in play — is discarded anyway (see the authoring branch
 * below). The authoring model authors the bytes from the run task + current
 * file contents; Model A contributes only the `path` (and self-assessment).
 */
function writeParameters(authorOnly: boolean) {
  return {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)." },
      ...(authorOnly
        ? {}
        : { content: { type: "string", description: "Full file contents." } }),
      images: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional image paths/URLs to author the file FROM (e.g. a design mockup). " +
          "Use only with an authoring/vision model — the file bytes are then generated from the image(s) " +
          "rather than from `content`. Ignored when no authoring model is configured.",
      },
      ...SELF_ASSESSMENT_PARAMS,
    },
    required: authorOnly ? ["path"] : ["path", "content"],
  };
}

/**
 * Shared `write` body. `authorOnly` is the only behavioural fork: when true the
 * tool was registered without a `content` schema property, so a missing draft is
 * expected (not an error), AND the absence of a resolved authoring model is a
 * hard error — the tool is useless without one in that mode, and silently
 * writing nothing would be invisible to the model.
 */
async function executeWrite(
  // Reassigned below when `content` arrives in a joinable shape.
  args: Record<string, unknown>,
  ctx: ToolContext,
  authorOnly: boolean,
) {
  if (!args.path || (!args.content && !authorOnly)) {
    return {
      output:
        `write: missing required argument 'path'${authorOnly ? "" : " and 'content'"}.` +
        ` Got path=${String(args.path ?? "")}${authorOnly ? "" : ` contentLen=${String(args.content ?? "").length}`}.`,
      isError: true,
    };
  }
  // `content` gets the same treatment as `edit`'s `oldString`/`newString`: an
  // array of lines is a serialisation difference, not a wrong answer, and
  // `String(["a","b"])` would otherwise write "a,b" to disk. Joined here rather
  // than only in the loop's schema-driven pass, because under `authorOnlyWrites`
  // the schema does not declare `content` at all.
  const contentCoerced: string[] = [];
  if (args.content != null && typeof args.content !== "string") {
    const fixed = coerceToString(args.content);
    if (fixed) {
      args = { ...args, content: fixed.text };
      contentCoerced.push(`'content' arrived as ${fixed.from}`);
    } else {
      return {
        output:
          `write: 'content' must be a STRING, got ${Array.isArray(args.content) ? "an array" : typeof args.content} ` +
          `whose contents could not be read as text. Nothing was written. Pass the file's literal bytes as one ` +
          `string, not a list or an object wrapping it.`,
        isError: true,
        details: { path: String(args.path), badArgument: "content" },
      };
    }
  }
  const file = resolveInCwd(ctx.cwd, String(args.path));
  ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:write", "mutation"], message: file });
  try {
    const draft = String(args.content ?? "");
    const previousContent = await readExistingFile(file);

    // Image refs for vision authoring, SCOPED to this file: the call's own
    // `images` arg when it named one, otherwise whichever host-injected image the
    // run can tie to `file`. A run holding several designs does not hand them all
    // to every write — see `attachment-routing.ts`.
    const imageScope = collectImageRefs(file, args.images, ctx.images);
    const images = imageScope.images;

    // If the host pinned an authoring model (decision.authorModel), a SECOND
    // model authors the file from scratch; Model A's draft is discarded for
    // authoring (kept below as `details.draft` for diagnostics). The authoring
    // call lives here in the tool, matching the image-analysis pattern, so
    // the runner never reasons over content. When `images` are supplied the
    // authoring model is expected to be vision-capable and authors FROM them.
    // We do NOT fall back to the draft on authoring failure — the contract is
    // "the authoring model authors".
    let nextContent = draft;
    let authoredUsage;
    let authoredBy: string | undefined;
    // Resolve the authoring model. The host chooses it: `routeModel` (consulted
    // for EVERY write now, plain and vision — see resolveAuthorModel) or a pinned
    // `authorModel`. As a last resort, an UNROUTED author-only write authors on
    // the loop's driver model (`ctx.model`) so a host that has not routed every
    // tier still gets its bytes written rather than erroring. A host that routes
    // every tier (as OpenWaggleMain does — low/medium/high all resolve) never
    // hits this fallback: every write is authored by an explicitly routed model.
    const writeAuthor = ctx.llm
      ? (resolveAuthorModel(ctx, images, file) ??
        (authorOnly && ctx.model ? { model: ctx.model, reason: "driver-fallback" as const } : undefined))
      : undefined;
    if (writeAuthor && ctx.llm) {
        // Log EVERY authoring call. A host-pinned escalation that then fails
        // upstream was previously invisible: no log here, and no provider-side
        // record either, so the only symptom was the driver's own draft
        // appearing on disk. The `driver-fallback` case (an unrouted write
        // authoring on the loop model) is logged too, but is NOT an escalation.
        const isEscalation = writeAuthor.reason !== "driver-fallback";
        ctx.log({
          timestamp: Date.now(),
          level: "info",
          tags: [
            "tool:write",
            ...(isEscalation ? ["escalation"] : []),
            ...(writeAuthor.reason === "vision-escalated" ? ["vision"] : []),
          ],
          message:
            `${file}: authoring ${isEscalation ? "escalated to" : "on driver model"}` +
            ` ${writeAuthor.model.openRouterSlug ?? writeAuthor.model.id}` +
            ` (${writeAuthor.reason}${images.length ? `, ${images.length} image(s)` : ""})`,
        });
        // What the escalated READ worked out about this file, if the run read it
        // before writing it. This is the hand-off that keeps the strong model's
        // understanding out of the orchestrator's paraphrase — and its `rating` is
        // an independent judgement of the file, unlike `ctx.declaredComplexity`,
        // which is the requesting model's claim about work it has not done yet.
        const priorRead = recallComprehension(file);
        const authored = await authorFileContent({
          llm: ctx.llm,
          model: writeAuthor.model,
          path: file,
          ...(priorRead
            ? {
                rating: priorRead.rating,
                comprehension: {
                  analysis: priorRead.analysis,
                  model: priorRead.model,
                  ...(priorRead.why ? { why: priorRead.why } : {}),
                },
              }
            : {}),
          // What kind of work this is. It no longer selects a system prompt (the
          // authoring call carries only a format contract now), but it is the axis the
          // host routes the AUTHORING MODEL on — see `resolveAuthorModel`, which passes
          // it to `ctx.routeModel` so `ui`/`svg` work can be pinned to a model strong at
          // spatial reasoning. The model's own declaration wins when present; otherwise
          // infer from the path, because the driver empirically omits `category` on many
          // calls and an unrouted `.html`/`.svg` write is the case that suffers most.
          category: ctx.declaredCategory ?? categoryForPath(file, ctx.projectCategory),
          // Model A's DRAFT IS INTENTIONALLY NOT FORWARDED.
          //
          // The strong model authors from the TASK plus (when it exists) the file's
          // CURRENT CONTENTS — not from Model A's draft of what the result should
          // look like. The draft was load-bearing for one thing: bounding a MODIFY
          // to the region A intended. But that role is already filled — the task
          // states the change, and the current contents are the ground truth — so
          // the draft is redundant *and* a liability.
          //
          // The liability is the reason it's gone. Observed against SVG/visual work:
          // the same prompt sent raw to the same strong model in a chat UI produced
          // far better output than the harness did, because the chat UI draws from
          // scratch while the harness was quietly anchoring the strong model to A's
          // weak draft ("keep its scope and purpose"). For work where the *shape* of
          // the output is the point — geometry, layout, structure — an anchor that is
          // weak at exactly that shape drags the result down to the anchor's level.
          // Forwarding A's draft made "strong model" mean "strong model refining a
          // weak model's art", which is not what escalation buys.
          //
          // The helper still accepts a `draft` for callers that want it; the tool
          // deliberately does not supply one. If a MODIFY ever needs A's region
          // intent disambiguated beyond what the task + current contents give, the
          // fix is to make the task say so, not to re-introduce the anchor.
          ...(ctx.authoringContext?.task ? { task: ctx.authoringContext.task } : {}),
          ...(ctx.authoringContext?.designReference?.length
            ? { designReference: ctx.authoringContext.designReference }
            : {}),
          ...(ctx.authoringContext?.mediaFact ? { mediaFact: ctx.authoringContext.mediaFact } : {}),
          ...(ctx.authoringContext?.generatedAssets?.length
            ? { generatedAssets: ctx.authoringContext.generatedAssets }
            : {}),
          ...(ctx.authoringContext?.planJson?.length ? { planJson: ctx.authoringContext.planJson } : {}),
          ...(ctx.authoringContext?.fileSnippets?.length ? { fileSnippets: ctx.authoringContext.fileSnippets } : {}),
          // The file being overwritten, when there is one. Without this the author
          // regenerated the whole file from the task text alone and silently deleted
          // everything the task did not mention.
          //
          // Truthiness, not `!= null`: `readExistingFile` returns "" for a missing
          // file, and an empty string here would put the modify-in-place prompt on a
          // brand-new file and tell it to preserve contents that do not exist. An
          // existing-but-empty file is a creation for authoring purposes anyway.
          ...(previousContent ? { currentContent: previousContent } : {}),
          ...(images.length ? { images } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!authored.text.trim()) {
          return {
            output: `write: authoring model ${writeAuthor.model.openRouterSlug ?? writeAuthor.model.id} returned empty content for ${file}; nothing was written. Draft preserved in details.draft for diagnostics.`,
            isError: true,
            details: { path: file, draft },
          };
        }
        nextContent = authored.text;
        authoredUsage = authored.usage;
        authoredBy = writeAuthor.model.openRouterSlug ?? writeAuthor.model.id;
      } else if (authorOnly) {
        // Unreachable in a real run: authorOnly + an LLM bridge always resolves
        // a model above (escalated, or the driver fallback). Reaching here means
        // `ctx.llm` itself was absent — a misconfigured host with no bridge at
        // all. Name it rather than silently writing nothing.
        return {
          output:
            `write: content-less mode is enabled but no LLM bridge is available to author ${file}. ` +
            `This host has no bridge wired; content-less write cannot run.`,
          isError: true,
          details: { path: file, authorOnly: true },
        };
      }

      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, nextContent, "utf8");
      // The stored analysis described the bytes that were just replaced. Keeping it
      // would hand the NEXT authoring pass a description of a file that no longer
      // exists — worse than having none, because it reads as current.
      forgetComprehension(file);
      // An `ambiguous` scope means the run holds designs but could not tell which
      // one depicts this file, so it authored without any. Say so on the result:
      // the model can see the analyses and settle it in one more call, whereas
      // silence reads as "there was no design to use".
      const scopeNote =
        imageScope.reason === "ambiguous" && imageScope.candidates?.length
          ? `\n\n${ambiguityNote(file, imageScope.candidates)}`
          : "";
      return {
        output: `Wrote ${file}${authoredBy ? ` (authored by ${authoredBy})` : ""}${scopeNote}`,
        details: {
          path: file,
          ...buildUnifiedDiff(file, previousContent, nextContent),
          ...(authoredBy ? { authoredBy, draft } : {}),
          ...(images.length ? { imagesUsed: images.map((i) => i.path), imageRouting: imageScope.reason } : {}),
          ...(imageScope.reason === "ambiguous" ? { imageCandidates: imageScope.candidates } : {}),
        },
        ...(authoredUsage ? { usage: authoredUsage } : {}),
      };
    } catch (err) {
      if (err instanceof AuthoringError) {
        // Nothing was written. Say so explicitly and name the cause, so the model
        // retries differently instead of re-issuing the identical call.
        return {
          output: `write: authoring escalation failed for ${file} — ${err.message} Nothing was written.`,
          isError: true,
          details: { path: file, authoringFailure: err.message },
        };
      }
      return { output: `Failed to write ${file}: ${(err as Error).message}`, isError: true };
    }
}

/**
 * The `write` tool. With `authorOnly` the schema omits `content` and the tool
 * requires a resolved authoring model to run — so Model A emits only the path
 * and the authoring model is the sole author of the file's bytes (one
 * generation, not two). Default behaviour (`authorOnly: false`) is unchanged.
 */
export function createWriteTool(authorOnly = false): AgentTool {
  return {
    name: "write",
    description: authorOnly
      ? "Create or overwrite a file. An authoring model writes the file contents from the task — do NOT pass content; supply the path and self-assessment only."
      : "Create or overwrite a file with the given contents.",
    mutates: true,
    categorizers: ["write_edit"],
    parameters: writeParameters(authorOnly),
    async execute(_id, args, ctx) {
      return executeWrite(args, ctx, authorOnly);
    },
  };
}

/** Backwards-compatible default `write` tool (content required). */
export const writeTool: AgentTool = createWriteTool(false);

/**
 * JSON-schema `parameters` for the `edit` tool. In `authorOnly` mode the
 * `newString` property is DROPPED (and removed from `required`), so Model A
 * emits only the `oldString` anchor (cheap — one string saying *where*) and the
 * authoring model authors the *replacement*. The anchor is kept because an edit
 * still needs to name its location; only the (discarded-anyway) replacement
 * draft is what we stop generating.
 */
function editParameters(authorOnly: boolean) {
  return {
    type: "object" as const,
    properties: {
      path: { type: "string" },
      oldString: { type: "string", description: "Exact text to replace." },
      ...(authorOnly
        ? {}
        : { newString: { type: "string", description: "Replacement text." } }),
      replaceAll: { type: "boolean" },
      images: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional image paths/URLs to author the replacement FROM (e.g. an updated mockup). " +
          "Use only with an authoring/vision model — the replacement text is then generated from the image(s) " +
          "rather than from `newString`. The `oldString` anchor is still preserved. Ignored when no authoring model is configured.",
      },
      ...SELF_ASSESSMENT_PARAMS,
    },
    required: authorOnly ? ["path", "oldString"] : ["path", "oldString", "newString"],
  };
}

/**
 * Shared `edit` body. `authorOnly` mirrors the write tool: when true a missing
 * `newString` is expected, and the absence of a resolved authoring model is a
 * hard error rather than a silent no-op.
 */
async function executeEdit(
  // Reassigned below when a string argument arrives in a joinable shape, so the
  // rest of this function only ever sees plain strings.
  args: Record<string, unknown>,
  ctx: ToolContext,
  authorOnly: boolean,
) {
  if (!args.path || args.oldString == null || (args.newString == null && !authorOnly)) {
    return {
      output:
        `edit: missing required argument(s). Need 'path' and 'oldString'` +
        `${authorOnly ? "" : " and 'newString'"}.` +
        ` Got path=${String(args.path ?? "")} oldLen=${String(args.oldString ?? "").length}` +
        `${authorOnly ? "" : ` newLen=${String(args.newString ?? "").length}`}.`,
      isError: true,
    };
  }
  // The anchor and the replacement must be STRINGS, and `String(value)` is happy
  // to coerce anything: `String(["Delete Account"])` is `"Delete Account"`, so an
  // array silently became its own sole element, and an object spliced the literal
  // text `[object Object]` into the user's source.
  //
  // Rejecting that was the first fix and it was only half right. A model that
  // sends `newString: ["…"]` has said exactly what it wants written — the shape
  // is wrong, the intent is not — and refusing costs a turn it will spend making
  // the same mistake. So JOIN what has one unambiguous reading, and reject only
  // what genuinely does not.
  //
  // This has to live HERE rather than only in the loop's schema-driven coercion,
  // because under `authorOnlyWrites` the schema does not declare `newString` at
  // all (see `editParameters`) — so a schema-driven pass has nothing to match on
  // and skips it, which is exactly how this kept failing after that pass was
  // added. The tool knows it reads these keys as strings whatever the schema
  // variant says; the schema does not.
  const coercedKeys: string[] = [];
  for (const key of ["oldString", "newString"] as const) {
    const value = args[key];
    if (value == null) continue; // absent `newString` is legitimate in author-only mode
    if (typeof value === "string") continue;
    const fixed = coerceToString(value);
    if (fixed) {
      args = { ...args, [key]: fixed.text };
      coercedKeys.push(`'${key}' arrived as ${fixed.from}`);
      continue;
    }
    return {
      output:
        `edit: '${key}' must be a STRING, got ${Array.isArray(value) ? "an array" : typeof value} ` +
        `whose contents could not be read as text. ` +
        `Nothing was changed. Pass the literal text — ${key === "oldString" ? "the exact bytes to find" : "the exact bytes to write"} — ` +
        `not a list or an object wrapping it. Re-issue the call with '${key}' as a plain string.`,
      isError: true,
      details: { path: String(args.path), badArgument: key, receivedType: Array.isArray(value) ? "array" : typeof value },
    };
  }
  const file = resolveInCwd(ctx.cwd, String(args.path));
  const oldStr = String(args.oldString);
  const draftNewStr = String(args.newString ?? "");
  ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:edit", "mutation"], message: file });
  try {
    const text = await fs.readFile(file, "utf8");
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { output: `oldString not found in ${file}`, isError: true };
    if (count > 1 && !args.replaceAll)
      return {
        output: `oldString appears ${count} times in ${file}; pass replaceAll or make it unique.`,
        isError: true,
      };

    // Image refs for vision authoring, scoped to this file. See writeTool.
    const imageScope = collectImageRefs(file, args.images, ctx.images);
    const images = imageScope.images;

    // ---- trace probes: the one payload an author-only run writes verbatim ----
    //
    // Without this, instrumenting is impossible in author-only mode and the
    // reproduce gate's no-MCP route (trace → probes → collect) is unreachable:
    // the driver has no channel for the probe text, and routing it through the
    // authoring model authors a FIX from the anchor and the task, not a `__t()`
    // line. `probeOnlyReplacement` is what keeps this from being a hole — the
    // same predicate the reproduce gate judges instrumentation by, so the tool
    // and the gate cannot disagree about what a probe edit is.
    const probeEdit =
      typeof args.newString === "string" ? probeOnlyReplacement(oldStr, draftNewStr) : null;

    // ---- literal-only edits: the driver's bytes ARE the specification ----
    //
    // See `literalOnlyReplacement`. When the replacement differs from the anchor
    // only inside quotes and numbers, there is no design decision left for a
    // stronger model to make, and handing it the anchor plus an ambiguous task is
    // how `'Delete Account'` became `'Delete Your Account?'`. Checked only when
    // the driver actually supplied a replacement, so author-only mode (no
    // `newString` by construction) is untouched.
    const literalEdit =
      !probeEdit && typeof args.newString === "string" && literalOnlyReplacement(oldStr, draftNewStr);

    // If the host pinned an authoring model, a SECOND model authors the
    // replacement (`newString`); Model A's `oldString` anchor is preserved
    // (an edit needs an anchor). Model A's draft `newString` is discarded for
    // authoring and kept as `details.draftNewString` for diagnostics. When
    // `images` are supplied the authoring model authors the replacement FROM
    // them (the anchor is still preserved). No silent fallback on failure.
    let newStr = draftNewStr;
    let authoredUsage;
    let authoredBy: string | undefined;
    let authoredSanitized: { fencesRemoved: number; proseRemoved: boolean } | undefined;
    // See the write path: the host chooses the author model (routeModel, now
    // consulted for every write, or a pinned authorModel); an UNROUTED
    // author-only edit authors on the loop's driver model as a last resort. A
    // host that routes every tier never hits the fallback.
    const editAuthor = ctx.llm
      ? (resolveAuthorModel(ctx, images, file) ??
        (authorOnly && ctx.model ? { model: ctx.model, reason: "driver-fallback" as const } : undefined))
      : undefined;
    // A certified probe edit skips authoring entirely: the bytes are already the
    // verbatim snippet, and an authoring pass over them would replace the probe
    // with its own idea of the change.
    if (probeEdit || literalEdit) {
      // nothing to author — the bytes are already exactly what must be written
    } else if (editAuthor && ctx.llm) {
        // Log EVERY authoring call; the `driver-fallback` case is not an
        // escalation. See the write path for the full rationale.
        const isEscalation = editAuthor.reason !== "driver-fallback";
        ctx.log({
          timestamp: Date.now(),
          level: "info",
          tags: [
            "tool:edit",
            ...(isEscalation ? ["escalation"] : []),
            ...(editAuthor.reason === "vision-escalated" ? ["vision"] : []),
          ],
          message:
            `${file}: authoring ${isEscalation ? "escalated to" : "on driver model"}` +
            ` ${editAuthor.model.openRouterSlug ?? editAuthor.model.id}` +
            ` (${editAuthor.reason}${images.length ? `, ${images.length} image(s)` : ""})`,
        });
        // See the write path: the read's own analysis and rating, not the
        // orchestrator's self-assessment.
        const priorRead = recallComprehension(file);
        const authored = await authorEditReplacement({
          llm: ctx.llm,
          model: editAuthor.model,
          path: file,
          oldString: oldStr,
          ...(priorRead
            ? {
                rating: priorRead.rating,
                comprehension: {
                  analysis: priorRead.analysis,
                  model: priorRead.model,
                  ...(priorRead.why ? { why: priorRead.why } : {}),
                },
              }
            : {}),
          // See the write path: declared category wins, else infer from the path.
          category: ctx.declaredCategory ?? categoryForPath(file, ctx.projectCategory),
          // Model A's DRAFT REPLACEMENT IS INTENTIONALLY NOT FORWARDED — same
          // reasoning as the write path. The strong model authors the replacement
          // from the ANCHOR (where) + the WHOLE FILE (context) + the TASK (intent).
          // The draft was added to stop B "inventing a different change" from a bare
          // task+anchor, but that failure's preconditions no longer hold: B now
          // receives the whole file, so the change is specified, not guessed.
          //
          // Symptom to watch if this regresses: the driver editing the same region
          // repeatedly as if it had no understanding of B's result. If that returns,
          // restoring `draftReplacement` here is the one-line revert (the helper
          // still accepts it). Until then, forwarding A's draft anchors B to A's
          // take on the change — the same anchor liability that hurt visual writes.
          ...(ctx.authoringContext?.task ? { task: ctx.authoringContext.task } : {}),
          ...(ctx.authoringContext?.designReference?.length
            ? { designReference: ctx.authoringContext.designReference }
            : {}),
          ...(ctx.authoringContext?.mediaFact ? { mediaFact: ctx.authoringContext.mediaFact } : {}),
          ...(ctx.authoringContext?.generatedAssets?.length
            ? { generatedAssets: ctx.authoringContext.generatedAssets }
            : {}),
          currentContent: text,
          ...(images.length ? { images } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (!authored.text.trim()) {
          return {
            output: `edit: authoring model ${editAuthor.model.openRouterSlug ?? editAuthor.model.id} returned an empty replacement for ${file}; nothing was changed. Draft preserved in details.draftNewString.`,
            isError: true,
            details: { path: file, draftNewString: draftNewStr },
          };
        }
        // The author returned the draft with extra blank lines and nothing else
        // changed — drift, not authoring. Keep the draft. See
        // `isBlankLineDriftOnly`: it fires ONLY when the two are identical once
        // blank lines are ignored, so real authoring work can never be discarded.
        if (isBlankLineDriftOnly(authored.text, draftNewStr)) {
          ctx.log({
            timestamp: Date.now(),
            level: "warn",
            tags: ["tool:edit", "authoring", "authoring:blank-line-drift"],
            message:
              `${file}: ${editAuthor.model.openRouterSlug ?? editAuthor.model.id} returned the draft with ` +
              `extra blank lines and no other change; keeping the draft`,
          });
          newStr = draftNewStr;
        } else {
          newStr = authored.text;
          authoredBy = editAuthor.model.openRouterSlug ?? editAuthor.model.id;
        }
        authoredUsage = authored.usage;
        authoredSanitized = authored.sanitized;
      } else if (authorOnly) {
        // Unreachable in a real run — see executeWrite's symmetric branch.
        return {
          output:
            `edit: content-less mode is enabled but no LLM bridge is available to author ${file}. ` +
            `This host has no bridge wired; content-less edit cannot run.`,
          isError: true,
          details: { path: file, authorOnly: true },
        };
      }

      const updated = args.replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      await fs.writeFile(file, updated, "utf8");
      // The stored analysis described the bytes that were just replaced. Keeping it
      // would hand the NEXT authoring pass a description of a file that no longer
      // exists — worse than having none, because it reads as current.
      //
      // UNLESS the change was literal-only. Then nothing the analysis says has
      // moved: same control flow, same invariants, same line numbers. Discarding it
      // there cost four full escalations of one unchanged file in a single observed
      // run — and four multi-KB analyses appended into the conversation, each one
      // near-identical to the last. Re-anchor to the new bytes instead.
      if (literalEdit) {
        reanchorComprehension(file, hashContent(updated));
      } else {
        forgetComprehension(file);
      }
      // Anchor-scope signal. A splice whose replacement is shorter than the region
      // it replaced deletes the difference — legitimate when the edit is a removal,
      // silent corruption when the author simply failed to carry lines over (the
      // failure the anchor wording above now guards against). We cannot tell the two
      // apart here, so this does not fail the call; it reports the shrink in the
      // output the driver reads, where "removed 5 line(s)" is impossible to miss.
      // Without it the result string was identical either way and the driver's only
      // clue was the file breaking several turns later.
      const anchorLines = oldStr.split("\n").length;
      const replacementLines = newStr.split("\n").length;
      const shrank = authoredBy != null && anchorLines > 1 && replacementLines < anchorLines;
      return {
        output:
          `Edited ${file} (${args.replaceAll ? count : 1} replacement(s))${authoredBy ? ` (replacement authored by ${authoredBy})` : ""}` +
          // Say when an argument had to be joined. The call SUCCEEDED, so without
          // this the model has no signal its shape was wrong and keeps sending it.
          (coercedKeys.length
            ? ` — NOTE: ${coercedKeys.join("; ")} and was joined into a plain string. Send string arguments as ONE string next time (a single value with \n between lines), not a list or an object.`
            : "") +
          // Say when the reply had to be repaired. A model that wraps its answer
          // in markdown is a fact worth seeing in the transcript — silently
          // fixing it makes a misbehaving model look like a working one.
          (authoredSanitized
            ? ` — NOTE: the authoring reply arrived wrapped in markdown (${authoredSanitized.fencesRemoved} code-fence line(s)${authoredSanitized.proseRemoved ? " plus surrounding commentary" : ""} removed before writing)`
            : "") +
          (probeEdit
            ? ` — trace probes ${probeEdit === "insert" ? "inserted" : "removed"} verbatim, no authoring pass. ` +
              `Run the flow, then \`activity_collect\`; strip these before the run ends.`
            : "") +
          (literalEdit
            ? ` — literal-only change (text/number content, identical structure), written VERBATIM as you specified it; no authoring pass.`
            : "") +
          (shrank
            ? ` — NOTE: the replacement is ${anchorLines - replacementLines} line(s) shorter than the anchor it replaced, so that many lines were removed. Read the file to confirm nothing needed was dropped.`
            : "") +
          // See the write path: an unresolved design choice is reported, not hidden.
          (imageScope.reason === "ambiguous" && imageScope.candidates?.length
            ? `\n\n${ambiguityNote(file, imageScope.candidates)}`
            : ""),
        details: {
          path: file,
          ...buildUnifiedDiff(file, text, updated),
          ...(literalEdit ? { verbatim: "literal-only" as const } : {}),
          ...(authoredBy ? { authoredBy, draftNewString: draftNewStr } : {}),
          ...(images.length ? { imagesUsed: images.map((i) => i.path), imageRouting: imageScope.reason } : {}),
          ...(imageScope.reason === "ambiguous" ? { imageCandidates: imageScope.candidates } : {}),
        },
        ...(authoredUsage ? { usage: authoredUsage } : {}),
      };
    } catch (err) {
      if (err instanceof AuthoringError) {
        return {
          output: `edit: authoring escalation failed for ${file} — ${err.message} Nothing was changed.`,
          isError: true,
          details: { path: file, authoringFailure: err.message },
        };
      }
      return { output: `Failed to edit ${file}: ${(err as Error).message}`, isError: true };
    }
}

/**
 * The `edit` tool. With `authorOnly` the schema omits `newString` (Model A emits
 * only the `oldString` anchor) and the tool requires a resolved authoring model.
 * Default behaviour (`authorOnly: false`) is unchanged.
 */
export function createEditTool(authorOnly = false): AgentTool {
  return {
    name: "edit",
    description: authorOnly
      ? "Replace an exact string in a file. An authoring model writes the replacement — supply path and oldString (the anchor), NOT newString. To add logging, use `add_log` instead: it writes your lines verbatim and is not a code change."
      : "Replace an exact string in a file with a new string. `oldString` must appear exactly once unless `replaceAll` is set.",
    mutates: true,
    categorizers: ["write_edit"],
    parameters: editParameters(authorOnly),
    async execute(_id, args, ctx) {
      return executeEdit(args, ctx, authorOnly);
    },
  };
}

/** Backwards-compatible default `edit` tool (newString required). */
export const editTool: AgentTool = createEditTool(false);

export const lsTool: AgentTool = {
  name: "ls",
  description: "List directory entries (non-recursive) to understand project structure.",
  mutates: false,
  categorizers: ["read"],
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory (default: cwd)." } },
  },
  async execute(_id, args, ctx) {
    const dir = resolveInCwd(ctx.cwd, String(args.path ?? "."));
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n");
      return { output: out || "(empty)", details: { path: dir, count: entries.length } };
    } catch (err) {
      return { output: `Failed to list ${dir}: ${(err as Error).message}`, isError: true };
    }
  },
};

/**
 * Directories `grep` does not search: the project-tree ignore list every other
 * walker in this codebase already uses, plus VCS and cache dirs that only a
 * text search encounters.
 *
 * Searching them is almost never what was meant, and it is how a one-word pattern
 * turns into megabytes: the failure that ended a run at ten tool calls with a 413
 * from the provider. `rg` skips some of these via .gitignore, but only inside a
 * git repo and only when the ignore file actually lists them; plain `grep -r`
 * skips nothing at all.
 *
 * The harness's own memory directory is in the shared list, and that matters more
 * than it looks: it holds a generated symbol index that mentions every symbol in
 * the project, so before it was excluded a search for any symbol returned its
 * index entries and nothing else. An artifact we generate must never come back as
 * a search result — the model reads "the only hits are in a JSON blob" as "there
 * are no real call sites" and goes back to walking directories by hand.
 */
const GREP_EXCLUDED_DIRS = [...IGNORED_PROJECT_DIRS, ...GREP_ONLY_EXCLUDED_DIRS];

export const grepTool: AgentTool = {
  name: "grep",
  description:
    "Search files for an EXTENDED regex pattern (alternation `a|b`, groups `(a|b)`, `+`, `?` all work; " +
    "uses ripgrep when available, else `grep -rE`). Skips dependency, build and generated-index directories.",
  mutates: false,
  categorizers: ["read"],
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Extended regex (ERE/rg syntax). Case-sensitive unless you write it otherwise." },
      path: { type: "string", description: "Directory/file to search (default cwd)." },
      glob: { type: "string", description: "Optional file glob filter." },
    },
    required: ["pattern"],
  },
  async execute(_id, args, ctx) {
    const target = resolveInCwd(ctx.cwd, String(args.path ?? "."));
    const pattern = String(args.pattern);
    const globArg = args.glob ? ` -g ${JSON.stringify(String(args.glob))}` : "";
    const rgExcl = GREP_EXCLUDED_DIRS.map((d) => `-g ${JSON.stringify(`!**/${d}/**`)}`).join(" ");
    const grepExcl = GREP_EXCLUDED_DIRS.map((d) => `--exclude-dir=${JSON.stringify(d)}`).join(" ");
    // Cap the MATCH COUNT at the source. Truncating after the fact still pays to
    // produce and buffer the whole thing; `-m` stops the search early. The
    // fallback gets the same cap — without it, `grep -r` on a repo with a big
    // generated file buffers the whole match set before anyone can trim it.
    //
    // `-E` on the fallback is not cosmetic. `grep -rn` on macOS/BSD is BASIC
    // regex, where `|` is a LITERAL PIPE and `\(` opens a group. A model writing
    // the syntax this tool's description promises got, on a real run:
    //   "delete.*account|Delete Account"  → exit 1 → reported as "(no matches)"
    //   "showDeleteConfirmationModal\\("  → exit 2 "parentheses not balanced"
    // Five searches, four of them silently wrong, and the model concluded the
    // symbol was not in the codebase. `-E` makes the fallback agree with `rg`.
    // `-I` skips binary files, which BSD grep otherwise reports as a bare
    // "Binary file X matches" line that carries no information.
    const cmd =
      `command -v rg >/dev/null 2>&1 && rg -n --no-heading -m ${GREP_MAX_MATCHES} ${rgExcl}${globArg} ${JSON.stringify(pattern)} ${JSON.stringify(target)} ` +
      `|| grep -rEnI -m ${GREP_MAX_MATCHES} ${grepExcl} ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    try {
      const { stdout } = await pexec(cmd, { cwd: ctx.cwd, maxBuffer: GREP_MAX_BUFFER, signal: ctx.signal });
      return { output: capGrepOutput(stdout, pattern), details: { pattern } };
    } catch (err) {
      const e = err as { stdout?: string; code?: unknown; message?: string };
      // grep/rg exit 1 on no match — that is a result, not a failure. ANYTHING
      // else is an error and must not be reported as "(no matches)", which reads
      // as "I searched and it is not there".
      //
      // The old test was `e.code > 1`, which silently mis-reported two whole
      // classes of failure as an empty result: a bad-regex exit 2 whose code
      // arrived as a string, and a `maxBuffer` overrun, whose `code` is the
      // STRING `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` — and `"ERR_…" > 1` is
      // `false`. Inverting the test (only a numeric 1 is "no matches") makes the
      // default outcome for an unrecognised failure "tell the caller", not
      // "claim the pattern is absent".
      const partial = (e.stdout ?? "").trim();
      if (partial) return { output: capGrepOutput(partial, pattern), details: { pattern } };
      const noMatch = e.code === 1 || e.code === "1";
      if (!noMatch) {
        const detail = typeof e.code === "number" ? `exit ${e.code}` : String(e.code ?? e.message ?? "unknown error");
        return {
          output:
            `grep FAILED (${detail}) for ${JSON.stringify(pattern)} in ${target} — this is NOT "no matches", ` +
            `the search did not complete. Likely causes: invalid regex, or the output exceeded the buffer ` +
            `(narrow the pattern, or pass \`path\`/\`glob\` to scope it). Do not conclude the pattern is absent.`,
          isError: true,
          details: { pattern, failure: detail },
        };
      }
      return { output: "(no matches)", details: { pattern } };
    }
  },
};

/**
 * Parse a concern-lines spec into a deduped, sorted list of 1-based line numbers.
 * Accepts both compact forms the model may emit:
 *   - ranges:  "42-44"            → [42, 43, 44]
 *   - lists:   "42,43,44"         → [42, 43, 44]
 *   - mixed:   "1,3-5,7"          → [1, 3, 4, 5, 7]
 * Tokens that don't parse as `n` or `a-b` (or are < 1) are skipped silently so a
 * stray typo doesn't void the whole declaration. Exported for unit testing.
 */
export function parseConcernLines(input: string): number[] {
  if (typeof input !== "string" || !input.trim()) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      let a = Number(rangeMatch[1]);
      let b = Number(rangeMatch[2]);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n += 1) {
        if (n >= 1 && !seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
      continue;
    }
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.sort((x, y) => x - y);
}

export const markConcernLinesTool: AgentTool = {
  name: "mark_concern_lines",
  description:
    "Flag the specific lines of a file you just read that matter for the task (the lines a change targets, or the evidence for a finding). Call it right after `read` when specific lines stand out; skip it when the whole file is relevant or nothing does. Lines may be a range like \"42-44\" or a list like \"42,43,44\".",
  mutates: false,
  categorizers: ["read", "write_edit", "activity_inspect"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd). Must match a file you just read." },
      lines: { type: "string", description: "1-based line numbers: a range like \"42-44\" or a list like \"42,43,44\"." },
      why: { type: "string", description: "Optional one-line reason: why these lines matter." },
    },
    required: ["path", "lines"],
  },
  async execute(_id, args, ctx) {
    const rawPath = args.path;
    const rawLines = args.lines;
    if (rawPath == null || String(rawPath).trim() === "") {
      return {
        output: "mark_concern_lines: missing required argument 'path'. Provide a file path and retry.",
        isError: true,
      };
    }
    if (rawLines == null || String(rawLines).trim() === "") {
      return {
        output: "mark_concern_lines: missing required argument 'lines'. Provide a range like \"42-44\" or a list like \"42,43,44\" and retry.",
        isError: true,
      };
    }
    const file = resolveInCwd(ctx.cwd, String(rawPath));
    const lines = parseConcernLines(String(rawLines));
    if (!lines.length) {
      return {
        output: `mark_concern_lines: could not parse any valid line numbers from "${String(rawLines)}". Use a range like "42-44" or a list like "42,43,44".`,
        isError: true,
      };
    }
    const why = args.why != null && String(args.why).trim() ? String(args.why).trim() : undefined;
    ctx.log({
      timestamp: Date.now(),
      level: "debug",
      tags: ["tool:mark_concern_lines"],
      message: `${file} lines=${lines.join(",")}${why ? ` why=${why}` : ""}`,
    });
    return {
      output: `Marked ${lines.length} concern line(s) in ${file}: ${lines.join(",")}.`,
      details: { path: file, lines, ...(why ? { why } : {}) },
    };
  },
};

export const CODING_TOOLS: AgentTool[] = [
  bashTool,
  bashReadonlyTool,
  readTool,
  writeTool,
  editTool,
  lsTool,
  grepTool,
  markConcernLinesTool,
];

/**
 * Build the coding toolset. With `authorOnlyWrites` true, the `write`/`edit`
 * tools are registered with content-less schemas (see `createWriteTool`/
 * `createEditTool`): Model A emits only the path (+ `oldString` for edit) and a
 * resolved authoring model authors the bytes — one generation instead of two.
 * The tool names are unchanged so plan machinery (`fileMutations: "write"|
 * "edit"`) and the loop's authoring trigger keep working without edits.
 */
/**
 * `bash` with the shell-authoring bypass closed. Used only under
 * `authorOnlyWrites`, where writing source through the shell contradicts the
 * mode; the default toolset keeps the unrestricted `bash`.
 *
 * Scoped to content-authoring forms targeting source-like paths, so builds,
 * installs, test runs, `git`, `mkdir`, `rm` and log redirects are untouched. The
 * error names the path and points at the tool that WILL author it, so the driver
 * re-issues the work through `write`/`edit` instead of treating it as a failure.
 */
const authorOnlyBashTool: AgentTool = {
  ...bashTool,
  async execute(id, args, ctx) {
    const offending = detectShellAuthoring(String(args.command ?? ""));
    if (offending) {
      return {
        output:
          `bash: refusing to author file contents through the shell (${offending.form} → ${offending.path}). ` +
          `This run authors files with a dedicated model, so source must go through \`write\` or \`edit\` — ` +
          `call \`write\` with path="${offending.path}" instead. ` +
          `Shell commands that build, install, test, move or delete files are unaffected.`,
        isError: true,
        details: { blockedPath: offending.path, form: offending.form },
      };
    }
    return bashTool.execute(id, args, ctx);
  },
};

export function createCodingTools(opts: { authorOnlyWrites?: boolean } = {}): AgentTool[] {
  const authorOnly = opts.authorOnlyWrites === true;
  return [
    authorOnly ? authorOnlyBashTool : bashTool,
    bashReadonlyTool,
    readTool,
    ...(authorOnly ? [createWriteTool(true), createEditTool(true)] : [writeTool, editTool]),
    lsTool,
    grepTool,
    markConcernLinesTool,
  ];
}
