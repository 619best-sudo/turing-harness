/**
 * Internal tool provider: activity monitor (req #6).
 *
 * Registered like an MCP server — a PROVIDER exposing several small tools rather
 * than one tool behind an `action` switch:
 *
 *   activity_search      filter the harness log by tag/text/level
 *   activity_tags        the tag histogram, to find what to filter on
 *   activity_tail_file   tail + filter a log file outside the harness
 *   activity_study       ask a model to summarize a log slice or a trace
 *   activity_trace_start open a trace session: id + logging snippet
 *   activity_collect     read a trace session's output
 *   activity_cleanup     delete the trace file, kill auto-started processes
 *   activity_inspect     reach the screen, capture a screenshot, judge it (VERDICT)
 *
 * WHY separate tools rather than one `action` argument: each step becomes its own
 * tool call in the transcript, with its own arguments, its own result, and the
 * model's reasoning in between. The previous single `activity_monitor` tool hid a
 * whole debugging session inside one call — worst of all its `trace` action, which
 * ran a private LLM sub-loop that read and edited files through its own dispatch.
 * From outside, minutes passed with nothing to show but a spinner, and none of the
 * model's reasoning or file edits were visible or reviewable. That sub-loop is
 * gone: the MAIN loop now drives the trace workflow with its ordinary tools.
 *
 * The trace workflow, all of it visible:
 *   1. `activity_trace_start` — returns a traceId + a `TURING_TRACE ...` logging snippet for
 *      the project's language. Optionally starts the dev server piping into the
 *      trace file (`startCommand`).
 *   2. The model inserts `TURING_TRACE ...` calls with its normal `read`/`edit` calls — real
 *      tool calls, reviewable in the transcript, subject to the permission gate.
 *   3. The user (or the model) runs the flow.
 *   4. `activity_collect` — reads the trace file back.
 *   5. `activity_study` — reasons over the collected trace.
 *   6. `activity_cleanup` — deletes the file, kills anything auto-started.
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { exec, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { AgentTool, Context, JSONSchema, LiveImage, ToolResult, ToolResultContent } from "../../types.js";
import type { LogStore } from "../../logging/logger.js";
import type { Registry } from "../../registry/registry.js";
// The one definition of "this change only adds or removes logging". Shared with the
// reproduce gate so the tool cannot accept a form the gate would call a fix.
import { probeOnlyReplacement } from "./coding.js";
import { hasLocalDevice, localDeviceTools } from "../../devices/local-devices.js";
import {
  elementCenter,
  imageToLogical,
  matchElement,
  mobileCliAvailable,
  mobileCliDeviceInfo,
  mobileCliDevices,
  mobileCliElements,
  mobileCliLaunch,
  mobileCliOpenUrl,
  mobileCliScreen,
  mobileCliScreenshot,
  mobileCliTap,
  mobileCliTapTargets,
  resolveTap,
  screenSignature,
  snapToTarget,
  type VisionChannel,
  type MobileCliScreen,
  type MobileCliTarget,
} from "../../devices/mobilecli.js";
import { resolveShellEnvironment } from "../../exec/shell-env.js";
import { resolveProjectToolchain } from "../../exec/toolchain.js";
import { ANY_MARKER_RE, PROBE_MARKER_RE, TRACE_MARKER_PREFIX, traceMarker } from "../../probe-marker.js";
import { imagePixelDimensions, sniffImageFormat } from "../../image-dims.js";

export interface ActivityMonitorConfig {
  logStore: LogStore;
  /** Model slug used by the "study" action. */
  studyModel?: string;
}

const DEFAULT_STUDY_MODEL = "xiaomi/mimo-v2.5";

/**
 * How long an un-probed trace session is considered "the one you just opened".
 *
 * Past this it is leftover state from a run that ended without cleaning up, and
 * refusing a new session on its behalf would wedge every later run in the process.
 * Generous enough to cover a model reading a few files before it instruments;
 * short enough that abandoned sessions never accumulate.
 */
const STALE_TRACE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Trace session state (in-process, survives across tool calls within a run)
// ---------------------------------------------------------------------------

/** One `add_log` call: the lines it added, and the helper if it was the first. */
interface TraceLogEntry {
  /** Short id handed back to the caller, e.g. `log-3`. */
  logId: string;
  /** Absolute path of the file it logged. */
  path: string;
  /** Exact text of the `TURING_TRACE ...` lines this call added. */
  lines: string[];
  /** What the caller was watching, for the removal report. */
  label?: string;
}

interface TraceSession {
  traceId: string;
  traceFile: string;
  language: string;
  runMode: "manual" | "auto";
  instrumentedFiles: Set<string>;
  /** When the session was opened, for reaping sessions a previous run abandoned. */
  startedAt: number;
  /** The project this session belongs to, so an empty session is never reused across projects. */
  cwd: string;
  /**
   * Every `add_log` call, addressable by its own id.
   *
   * Grouped per CALL rather than flattened per file, because a call is the unit a
   * caller can name: it added these lines, and "undo that one" has to mean exactly
   * them. The recorded text is EXACT — removal matches what was written instead of
   * classifying lines by shape, which is the only way to take logging out without
   * ever touching project code. A pattern that "looks like a log" cannot be trusted:
   * `if (x) print("TURING_TRACE y")` carries a marker and a guard on one line, and deleting it
   * would silently drop the guard.
   */
  logs?: TraceLogEntry[];
  childPid?: number;
  childProcess?: ChildProcess;
  /** Local HTTP sink that catches trace lines from code with no filesystem. */
  collector?: import("node:http").Server;
  /** Where that sink listens, e.g. http://127.0.0.1:53411/t. */
  collectorUrl?: string;
}

/** Map of traceId → TraceSession, keyed in-process so collect/cleanup/inspect
 *  can reference the same session the instrument call created. Survives for the
 *  duration of the harness process (cleared on cleanup). */
const activeTraces = new Map<string, TraceSession>();

/**
 * The session map, exposed for one test: that a session abandoned by an EARLIER run
 * is reaped rather than allowed to refuse a later run's first step. Ageing a session
 * is the only way to exercise that without waiting out the window.
 */
export const __activeTracesForTest = activeTraces;

/**
 * Counter behind the log ids (`log-1`, `log-2`, …). Module-level, not per-session,
 * so an id identifies exactly one log group across the whole process — which is what
 * lets `remove_log` find the session from the id alone. Per-session numbering looked
 * tidier and made `log-1` ambiguous the moment a second session existed.
 */
let logSeq = 0;

// ---------------------------------------------------------------------------
// Language detection & logging snippets
// ---------------------------------------------------------------------------

const LANGUAGE_SIGNATURES: Array<{ lang: string; file: string; weight: number }> = [
  { lang: "typescript", file: "tsconfig.json", weight: 10 },
  { lang: "typescript", file: "*.ts", weight: 5 },
  { lang: "typescript", file: "*.tsx", weight: 5 },
  { lang: "javascript", file: "package.json", weight: 7 },
  { lang: "javascript", file: "*.js", weight: 4 },
  { lang: "javascript", file: "*.jsx", weight: 4 },
  { lang: "python", file: "requirements.txt", weight: 8 },
  { lang: "python", file: "pyproject.toml", weight: 8 },
  { lang: "python", file: "Pipfile", weight: 8 },
  { lang: "python", file: "*.py", weight: 4 },
  { lang: "go", file: "go.mod", weight: 10 },
  { lang: "go", file: "*.go", weight: 4 },
  { lang: "rust", file: "Cargo.toml", weight: 10 },
  { lang: "rust", file: "*.rs", weight: 4 },
  { lang: "ruby", file: "Gemfile", weight: 8 },
  { lang: "ruby", file: "*.rb", weight: 4 },
  { lang: "java", file: "pom.xml", weight: 8 },
  { lang: "java", file: "build.gradle", weight: 8 },
  { lang: "java", file: "*.java", weight: 4 },
];

/**
 * Source extension → language, used by the census fallback in `detectLanguage`.
 *
 * Deliberately extension-only: an extension is a mechanical fact about a file,
 * where a "signature" is a guess about a framework. Adding a language here costs
 * one line and needs no knowledge of how its projects are laid out — which is
 * the property the signature table above lacks.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".dart": "dart",
  ".swift": "swift",
  ".cs": "csharp",
  ".php": "php",
};

/** Directories never worth walking when censusing a repo's languages. */
const CENSUS_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  ".dart_tool",
  "Pods",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
]);

/**
 * A tiny local HTTP sink that appends POSTed trace lines to the trace file.
 *
 * This exists because of a specific, repeated failure: browser code cannot write
 * to disk. The `TURING_TRACE ...` snippet's `require("fs")` call is a no-op in a browser (and
 * throws in ESM), so an instrumented React component logged happily to the devtools
 * console and the trace file stayed EMPTY — after which the only recovery was
 * asking the user to run the flow again. Front-end and any sandboxed runtime now
 * POST here instead, and the line lands in the same file as everything else, in
 * order, so `activity_collect` sees one merged timeline.
 *
 * Deliberately: bound to 127.0.0.1 only (never a public interface), permissive
 * CORS because the page is served from a different localhost port, and failure to
 * start is non-fatal — the Node path still works and the snippet degrades to
 * console-only rather than taking the trace down with it.
 */
async function startTraceCollector(
  traceFile: string,
): Promise<{ server: import("node:http").Server; url: string } | undefined> {
  try {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      // Preflight: the browser asks before it is allowed to POST cross-origin.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        // A runaway client must not be able to buffer the harness to death.
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        const line = body.trim();
        if (line) {
          // Appended synchronously-ish and newline-terminated so interleaved
          // writes from server and browser never share a line.
          fsSync.appendFile(traceFile, line.endsWith("\n") ? line : line + "\n", () => {});
        }
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") return undefined;
    return { server, url: `http://127.0.0.1:${address.port}/t` };
  } catch {
    return undefined;
  }
}

/**
 * Generate a short unique trace id: "turing-trace-" + 8 random hex chars.
 */
function generateTraceId(): string {
  return `turing-trace-${randomBytes(4).toString("hex")}`;
}

/** Trace file lives in os.tmpdir() so it's easy to find + auto-clean on reboot. */
/**
 * The probe marker (`TURING_TRACE`) lives in `probe-marker.ts` and is shared
 * with the loop, orchestrator and `coding.ts` so the detector and the snippet
 * cannot drift apart. `activity_cleanup` uses it to name the real files to
 * strip (the session's `instrumentedFiles` set is empty in practice).
 */

/**
 * Scan the working tree (shallowly) for source files that still contain an
 * activity-monitor probe marker. Skips node_modules/.git and binary/asset
 * files, and caps the scan so a huge repo never blocks cleanup. Returns
 * cwd-relative paths the model can pass back to `edit`.
 */
async function findProbeMarkerFiles(cwd: string): Promise<string[]> {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".turing", "coverage"]);
  const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf", ".otf"]);
  const found: string[] = [];
  const MAX_FILES = 2000;
  let visited = 0;
  async function walk(dir: string): Promise<void> {
    if (visited >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (visited >= MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        visited++;
        const ext = path.extname(ent.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        try {
          const content = await fs.readFile(full, "utf8");
          if (PROBE_MARKER_RE.test(content)) found.push(path.relative(cwd, full) || full);
        } catch {
          /* binary or unreadable — skip */
        }
      }
    }
  }
  await walk(cwd);
  return found;
}

function traceFilePath(traceId: string): string {
  return path.join(os.tmpdir(), `${traceId}.log`);
}

/**
 * Logging snippet that writes to BOTH console AND the trace file.
 * Returns language-specific code the agent should insert. Parameterized by the
 * SESSION marker so every probe names the investigation it belongs to.
 */
function printByExample(marker: string): Record<string, { call: string; example: string }> {
  return {
    typescript: { call: "console.log", example: `console.log("${marker} " + new Date().toISOString() + " screen=profile loaded=" + loaded);` },
    javascript: { call: "console.log", example: `console.log("${marker} " + new Date().toISOString() + " screen=profile loaded=" + loaded);` },
    python: { call: "print", example: `print("${marker}", "screen=profile", "loaded=", loaded)` },
    dart: { call: "print", example: `print("${marker} screen=profile loaded=" + loaded.toString());` },
    go: { call: "fmt.Println", example: `fmt.Println("${marker}", "screen=profile", "loaded=", loaded)` },
    rust: { call: "println!", example: `println!("${marker} screen=profile loaded={:?}", loaded);` },
    default: { call: "print / console.log", example: `<print>("${marker} [<time>] <what this point is> <values>")` },
  };
}

/**
 * One convention for every language: a normal print/console.log line that STARTS
 * with this SESSION's marker (`TURING_TRACE_<suffix>` — unique to this trace, see
 * {@link traceMarker}). No injected helper, no imports, no file writes — the
 * language's own stdout call sends the line out, `activity_trace_start`'s
 * `startCommand` pipes stdout into the trace file, and `activity_collect` greps
 * that file for the session marker (lines carrying any OTHER probe marker — a
 * previous session's leftovers — are reported, not collected). The prefix line
 * is both the message and the marker.
 */
function loggingSnippet(language: string, traceId: string, traceFile: string, _collectorUrl?: string): string {
  const marker = traceMarker(traceId);
  const out = printByExample(marker)[language] ?? printByExample(marker).default;
  return [
    `// --- Activity Monitor trace (insert a log line at the key flow points) ---`,
    `// Add ONE line, in this file's own ${out.call}, STARTING with ${marker} (THIS session's marker — unique to this trace).`,
    `// No helper, no imports — stdout is piped into the trace file (${traceFile}).`,
    `// (add a timestamp with your language's clock if you want one)`,
    `// Example:`,
    `//   ${out.example}`,
    `// activity_collect returns every line that contains ${marker}.`,
    "",
  ].join("\n");
}

/**
 * Count source files by language, walking a bounded slice of the tree.
 *
 * This is the general half of `detectLanguage`. The signature table it backs up
 * only ever looked at the cwd ROOT and only at names it already knew, so it was
 * blind in the two most ordinary situations: a repo whose sources live in a
 * subdirectory (`lib/`, `src/`, `app/`), and any language nobody had added a
 * signature for. Counting extensions has neither blind spot — it finds the
 * sources wherever they are, and it needs no per-framework layout knowledge.
 *
 * Bounded on purpose: breadth-first, capped at `maxFiles` counted and `maxDirs`
 * visited, skipping vendor/build directories. Detection runs on every
 * `activity_trace_start`, so it must stay cheap on a large monorepo; a partial
 * census is enough to pick the dominant language.
 */
async function censusLanguages(
  cwd: string,
  { maxFiles = 4000, maxDirs = 400 } = {},
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const queue: string[] = [cwd];
  let files = 0;
  let dirs = 0;

  while (queue.length > 0 && files < maxFiles && dirs < maxDirs) {
    const dir = queue.shift()!;
    dirs += 1;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — not fatal to the census
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (CENSUS_SKIP_DIRS.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (CENSUS_SKIP_DIRS.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const lang = EXTENSION_LANGUAGES[path.extname(entry.name).toLowerCase()];
      if (!lang) continue;
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
      files += 1;
      if (files >= maxFiles) break;
    }
  }
  return counts;
}

/**
 * Auto-detect the project language.
 *
 * Two passes, and the ORDER matters: the census decides, and the signature table
 * only breaks ties among languages the census already saw. A config file proves
 * a toolchain is present, not that the code is written in that language — a
 * Flutter app ships a `build.gradle`, an Expo app ships a `pyproject.toml` in
 * some setups, and scoring those as votes is how a repo gets misread. Actual
 * source files are the stronger evidence, so they lead.
 *
 * Returns `"unknown"` when nothing recognizable is found. That case previously
 * returned `"javascript"` as a "safe default", which was the real defect behind
 * the wrong-snippet bug: it is not a default, it is a confident wrong answer,
 * and it silently handed a `console.log` snippet to non-JS projects. `unknown`
 * routes to `loggingSnippet`'s generic branch, which tells the model to write
 * its own logging in the project's language instead of pretending we know.
 */
async function detectLanguage(cwd: string): Promise<string> {
  const census = await censusLanguages(cwd);

  // Signature hits, used ONLY to rank languages the census already found.
  const signals = new Map<string, number>();
  for (const sig of LANGUAGE_SIGNATURES) {
    if (sig.file.includes("*")) continue; // the census covers extensions better
    try {
      await fs.access(path.join(cwd, sig.file));
      signals.set(sig.lang, (signals.get(sig.lang) ?? 0) + sig.weight);
    } catch {
      /* file doesn't exist */
    }
  }

  if (census.size > 0) {
    const ranked = [...census.entries()].sort((a, b) => {
      const byCount = b[1] - a[1];
      if (byCount !== 0) return byCount;
      return (signals.get(b[0]) ?? 0) - (signals.get(a[0]) ?? 0);
    });
    return ranked[0]![0];
  }

  // No source files reachable within the census bounds (a bare repo, or one
  // whose sources sit deeper than the walk). Fall back to signatures alone.
  if (signals.size > 0) {
    return [...signals.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Auto-restart helpers
// ---------------------------------------------------------------------------

async function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  // Same environment as the `bash` tool — see `exec/shell-env.ts`. `lsof` and
  // `kill` live in /usr/bin so they survive a bare PATH, but a helper that
  // quietly runs in a different environment than every other command in the
  // harness is a bug waiting to be found the hard way.
  const { env, shell } = await resolveShellEnvironment();
  return new Promise((resolve) => {
    exec(command, { timeout: 10_000, env, shell }, (err, stdout, stderr) => {
      resolve({ stdout: (stdout ?? "").trim(), stderr: (err?.message ?? stderr ?? "").trim() });
    });
  });
}

/**
 * Resolve a `startCommand` the same way the `bash` tool resolves one.
 *
 * `activity_trace_start` boots the app whose logs the whole trace loop depends
 * on. If that spawn cannot find the project's toolchain, the trace file fills
 * with `command not found` and the loop reports "no output" — a failure that
 * reads like the instrumentation is wrong rather than the process never started.
 */
async function prepareStartCommand(startCommand: string, cwd: string) {
  const shellEnv = await resolveShellEnvironment();
  const resolved = await resolveProjectToolchain(startCommand, cwd, shellEnv.env);
  return { shellEnv, resolvedCommand: resolved.command, substitutions: resolved.substitutions };
}

async function killPort(port: number): Promise<string[]> {
  const killed: string[] = [];
  try {
    const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null`);
    if (stdout.trim()) {
      const pids = stdout.trim().split("\n");
      for (const pid of pids) {
        if (!pid.trim()) continue;
        await execAsync(`kill -9 ${pid.trim()} 2>/dev/null`);
        killed.push(pid.trim());
      }
    }
  } catch {
    /* lsof not available or no process on port — fine */
  }
  return killed;
}

/** One non-blocking TCP probe: resolves true if the port accepts a connection. */
export function portIsListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Poll a port until the dev/app server is ACCEPTING CONNECTIONS — the reliable
 * signal that a build/startup has finished serving. This exists because a fixed
 * 2.5s wait returned "ready" while a cold build (Flutter/Expo/Next) was still
 * compiling, so the model captured a stale or not-yet-running app and QA'd the
 * wrong thing. Cold first builds take minutes, so the deadline is generous;
 * `onPoll` lets the caller emit progress while it waits.
 */
export async function waitForPort(
  port: number,
  deadlineMs: number,
  onPoll?: (note: { waitedMs: number; ready: boolean }) => void,
): Promise<{ ready: boolean; waitedMs: number }> {
  const start = Date.now();
  const tick = 1500;
  // A quick first probe — the common case where the server was already up.
  if (await portIsListening(port)) {
    const waitedMs = Date.now() - start;
    onPoll?.({ waitedMs, ready: true });
    return { ready: true, waitedMs };
  }
  while (Date.now() - start < deadlineMs) {
    onPoll?.({ waitedMs: Date.now() - start, ready: false });
    await new Promise((r) => setTimeout(r, tick));
    if (await portIsListening(port)) {
      const waitedMs = Date.now() - start;
      onPoll?.({ waitedMs, ready: true });
      return { ready: true, waitedMs };
    }
  }
  const waitedMs = Date.now() - start;
  onPoll?.({ waitedMs, ready: false });
  return { ready: false, waitedMs };
}

/**
 * A `startCommand` that opens an HTTP port we can probe. Mobile/device runs
 * (`flutter run -d <simulator>`, `react-native run-ios`) do NOT — they have no
 * port, and waiting on one times out falsely. Only treat the command as web
 * when it actually serves over HTTP.
 */
export const WEB_RUN_RE =
  /--web-port|--port\b|\bserve\b|\bvite\b|\bnext (start|dev)\b|\bnuxt dev\b|\bexpo start\b|http\.server|uvicorn|gunicorn|\brails s\b|npm run dev|yarn dev|pnpm (run )?dev|webpack serve|live-server|http-server|astro dev|svelte-?kit dev/i;

/** Output markers that mean the app has FINISHED starting and is running. */
export const READY_MARKERS = [
  /\bSyncing files to device\b/,                       // flutter: pushing to device after build
  /\bFlutter run key commands\b/,                      // flutter run interactive-ready
  /\bDart VM Service|Debug service listening\b/,       // flutter VM service up
  /\bRestarted application\b/,                         // flutter hot restart done
  /\bMetro\b[\s\S]{0,40}\bready|Bundling [\s\S]{0,60} done|Running .* on (iOS|Android)/i, // RN/Metro
  /\bBUILD SUCCESSFUL\b/,                              // gradle build done
  /\bInstalled on .* device\b|\bStarting: Intent\b|\bLAUNCHED\b/i, // android install/launch
  /\blistening on\b|\bready in\b|\bstarted on\b|\bLocal:\s+https?:\/\//i, // generic dev server
  /\bApp listening\b|\bServer ready\b|\bNow listening on\b|\bcompiled\b/i,
];

/** Output markers that mean the start FAILED (so we stop waiting). */
export const FAIL_MARKERS = [
  /\[ERROR\]/,
  /\bError:\s/,
  /\bException[:\s]/,
  /\bcommand not found\b/i,
  /\bnot recognized as/i,
  /\bspawn ENOENT\b/,
  /\bno connected devices\b/i,
  /\bno devices\b/i,
  /\bBUILD FAILED\b/,
  /\bfatal error\b/i,
];

export interface AppReadyResult {
  ready: boolean;
  reason: "port" | "marker" | "exited" | "failed" | "timeout";
  waitedMs: number;
  tail: string;
}

/**
 * Wait until the started app is READY — generically, across web and mobile/native.
 * Web/dev-server commands are confirmed by the port accepting connections; a
 * mobile/device run (which has no port) is confirmed by a readiness marker in
 * its output. Either way, an early exit or a fatal-error marker means it failed,
 * so we stop waiting instead of blocking for the whole deadline on a dead process.
 *
 * This replaces polling a port blindly: a `flutter run -d <simulator>` was given
 * a `port` it never opens, so the old check timed out at NOT-READY even though
 * the app ran fine on the simulator. The command shape decides what "ready" means.
 */
export async function waitForAppReady(opts: {
  traceFile: string;
  port?: number;
  isWeb: boolean;
  deadlineMs: number;
  signal?: AbortSignal;
  onPoll?: (n: { waitedMs: number; state: "ready" | "building" | "failed" }) => void;
}): Promise<AppReadyResult> {
  const start = Date.now();
  const tick = 1500;
  const readTail = async () => {
    try {
      const text = await fs.readFile(opts.traceFile, "utf8");
      return text.slice(-4000);
    } catch {
      return "";
    }
  };

  for (;;) {
    if (opts.signal?.aborted) {
      return { ready: false, reason: "timeout", waitedMs: Date.now() - start, tail: await readTail() };
    }
    const tail = await readTail();

    // The spawn's exit handler writes this line on process end.
    const exitMatch = tail.match(/# Process exited with code (-?\d+)/);
    if (exitMatch) {
      const code = Number(exitMatch[1]);
      const wasReady = READY_MARKERS.some((re) => re.test(tail));
      if (!wasReady || code !== 0) {
        opts.onPoll?.({ waitedMs: Date.now() - start, state: "failed" });
        return { ready: false, reason: code !== 0 ? "failed" : "exited", waitedMs: Date.now() - start, tail };
      }
    }
    if (FAIL_MARKERS.some((re) => re.test(tail))) {
      opts.onPoll?.({ waitedMs: Date.now() - start, state: "failed" });
      return { ready: false, reason: "failed", waitedMs: Date.now() - start, tail };
    }

    // Web: the port accepting connections is the strongest signal.
    if (opts.isWeb && opts.port && (await portIsListening(opts.port))) {
      opts.onPoll?.({ waitedMs: Date.now() - start, state: "ready" });
      return { ready: true, reason: "port", waitedMs: Date.now() - start, tail };
    }
    // Any framework: a readiness marker in the output.
    if (READY_MARKERS.some((re) => re.test(tail))) {
      opts.onPoll?.({ waitedMs: Date.now() - start, state: "ready" });
      return { ready: true, reason: "marker", waitedMs: Date.now() - start, tail };
    }

    if (Date.now() - start >= opts.deadlineMs) {
      opts.onPoll?.({ waitedMs: Date.now() - start, state: "building" });
      return { ready: false, reason: "timeout", waitedMs: Date.now() - start, tail };
    }
    opts.onPoll?.({ waitedMs: Date.now() - start, state: "building" });
    await new Promise((r) => setTimeout(r, tick));
  }
}

// ---------------------------------------------------------------------------
// Inspect: browser automation helpers
// ---------------------------------------------------------------------------

const BROWSER_NAVIGATE_TOOLS = ["browser_navigate", "playwright_navigate", "mcp__playwright__browser_navigate"];
const BROWSER_SNAPSHOT_TOOLS = ["browser_snapshot", "playwright_snapshot", "mcp__playwright__browser_snapshot"];
const BROWSER_SCREENSHOT_TOOLS = [
  "browser_take_screenshot",
  "playwright_screenshot",
  "mcp__playwright__browser_take_screenshot",
];
const BROWSER_CONSOLE_TOOLS = ["browser_evaluate", "playwright_evaluate", "browser_console_messages"];

// Device automation. Kept as a SEPARATE axis from the browser lists above
// rather than folded into them, because the two drive different surfaces and
// take different arguments: a browser is addressed by URL + CSS selector, a
// device by deviceId + bundle id, and its "selector" equivalent is the
// on-screen element list, not a DOM query.
//
// There are no MCP tool-name lists here any more. The device backend is
// `mobilecli` (src/devices/mobilecli.ts), called directly, with simctl/adb
// (src/devices/local-devices.ts) as the zero-dependency capture fallback.
// The external device-MCP server was removed outright.
//
// WHY, in one paragraph, because it is the most expensive lesson in this file:
// taps "never landed" for a whole class of targets, and the diagnosis written
// into the old code was that the tap tool wanted PHYSICAL pixels — so it
// carried a runtime calibration that guessed between logical points and
// physical pixels and remembered the winner. That diagnosis was WRONG. Taps
// take LOGICAL POINTS, always; verified three-for-three (a tab bar item, a
// second tab item, and the top-right profile avatar) where the logical
// coordinate worked and the physical one was silently dropped. The real cause
// of the misses was the LOCALIZER, not the space: on a downsampled 375x812
// capture the avatar was estimated at y=59 when the truth was y=84 — a 25px
// error on a target ~37px tall, i.e. a guaranteed miss — while the x estimate
// (339 vs 341) was fine. So the fixes are: capture NATIVELY, prefer the
// element tree's exact rects, and never guess at the coordinate space.
//
// NOTE: mobile INSPECTION lists no elements on purpose — it is SCREENSHOT ONLY
// (see inspectMobile step 4). The TAP path is different: the element tree
// carries EXACT logical coordinates, so it is GROUND TRUTH, and vision
// estimation is only the fallback for what the tree does not expose
// (GestureDetectors, icon-only buttons — the profile avatar above is one).

function findTool(registry: Registry | undefined, candidates: string[]): { name: string; tool: AgentTool } | undefined {
  if (!registry) return undefined;
  for (const name of candidates) {
    const tool = registry.getTool(name);
    if (tool) return { name, tool };
  }
  // Suffix fallback: a host may register MCP tools under a server prefix
  // (`some-server__browser_take_screenshot`), which exact lookup misses. This
  // is how a capture tool went unfound in a real run while a sibling tool from
  // the SAME server resolved — different naming, same provider.
  const all = typeof registry.allTools === "function" ? registry.allTools() : [];
  for (const name of candidates) {
    const tool = all.find((t) => t.name === name || t.name.endsWith(`__${name}`));
    if (tool) return { name: tool.name, tool };
  }
  return undefined;
}

/**
 * Text a called tool produced, from either shape it may use.
 *
 * MCP-backed tools vary: some fill `output`, some return only `content` blocks.
 * Reading `output` alone silently saw "" for the latter — which is how a device
 * list came back "empty" while the tool had in fact answered.
 */
function resultText(res: ToolResult): string {
  if (res.output && res.output.trim()) return res.output;
  const blocks = res.content ?? [];
  return blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Image blocks a tool returned, so a screenshot reaches the MODEL rather than
 *  being flattened to the word "ok", which is all some capture tools put in
 *  `output` — the pixels live only in `content`. */
function imageBlocks(res: ToolResult) {
  return (res.content ?? []).filter((b) => b.type === "image");
}

/**
 * Did a browser navigation actually reach a real page, or land on an error?
 *
 * This exists because of a specific silent failure: `activity_inspect` returned
 * success on a 404 / connection-refused / "this site can't be reached" page, and
 * — worse — when `analyze` was set it handed that error page to the study model,
 * which happily fabricated a detailed UI review of a page that never existed.
 * Capturing an error page is not a pass; it must fail loudly, and on a mobile
 * project it must steer back to the device surface where the real app lives.
 *
 * The signal is deliberately fuzzy: navigation-tool text varies across MCPs, so
 * this matches the three shapes a failure actually takes — an explicit HTTP
 * status (4xx/5xx), a connection/network error string, or an error-page title.
 */
function navigationFailure(navigateResult: string): { failed: boolean; reason?: string } {
  const text = (navigateResult ?? "").trim();
  if (!text) return { failed: false };
  const lower = text.toLowerCase();

  // HTTP status, in the formats Playwright MCP and equivalents print it:
  // "HTTP status: 404 File not found", "status: 502", "responded with 500".
  const statusMatch = text.match(/\b(4\d{2}|5\d{2})\b/);
  if (statusMatch) {
    // Guard against a false positive: a status code mentioned as content
    // ("error 404 page", "the api returns 200") is rare in nav output and is
    // outweighed by the real failure it guards, so accept the match.
    return { failed: true, reason: `HTTP ${statusMatch[0]}` };
  }

  // Connection-level failures — the URL didn't resolve to a server at all.
  const NETWORK_ERRORS = [
    "econnrefused",
    "err_connection_refused",
    "err_connection_reset",
    "err_name_not_resolved",
    "err_internet_disconnected",
    "net::err_",
    "this site can't be reached",
    "this site can’t be reached",
    "unable to connect",
    "localhost didn’t send any data",
    "localhost didn't send any data",
    "refused to connect",
    "no such host",
    "navigate to url timed out",
    "neterr_",
  ];
  for (const needle of NETWORK_ERRORS) {
    if (lower.includes(needle)) return { failed: true, reason: `network: ${needle}` };
  }

  // Error-page titles — Playwright MCP returns "Page Title: <title>".
  const titleMatch = text.match(/page title:\s*(.+)/i);
  if (titleMatch) {
    const title = titleMatch[1].trim().toLowerCase();
    const ERROR_TITLES = [
      "error",
      "404",
      "404 not found",
      "not found",
      "500",
      "internal server error",
      "this site can't be reached",
      "this site can’t be reached",
      "unable to connect",
      "problem loading page",
    ];
    if (ERROR_TITLES.some((t) => title === t || title.startsWith(t))) {
      return { failed: true, reason: `error page title: ${titleMatch[1].trim()}` };
    }
  }

  return { failed: false };
}

/**
 * First usable device id from a device-list result.
 *
 * The local simctl/adb fallback answers
 * `{"devices":[{"id","name","platform","state",…}]}`, but the shape is not
 * contractual, so this parses what it can and falls back to a UUID-ish scan of
 * the raw text rather than failing the whole inspection on an unexpected key.
 */
function pickDevice(raw: string): { id: string; label?: string } | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    const list = (parsed as { devices?: unknown[] })?.devices ?? (Array.isArray(parsed) ? parsed : []);
    for (const entry of list as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.state === "string" && entry.state !== "online" && entry.state !== "booted") continue;
      const id = entry.id ?? entry.udid ?? entry.deviceId;
      if (typeof id === "string" && id) {
        const name = typeof entry.name === "string" ? entry.name : undefined;
        const version = typeof entry.version === "string" ? entry.version : undefined;
        return { id, label: name ? `${name}${version ? ` (${version})` : ""}` : undefined };
      }
    }
  } catch {
    /* not JSON — fall through to the text scan */
  }
  const match = raw.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
  return match ? { id: match[0] } : undefined;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Log-filter arguments shared by search / study. */
const LOG_FILTER_PROPS: Record<string, JSONSchema> = {
  tags: { type: "array", items: { type: "string" }, description: "Require ALL of these tags." },
  anyTags: { type: "array", items: { type: "string" }, description: "Match ANY of these tags." },
  text: { type: "string", description: "Substring (or regex) to match in messages." },
  regex: { type: "boolean", description: "Treat `text` as a regular expression." },
  level: { type: "string", enum: ["debug", "info", "warn", "error"] },
  limit: { type: "number", description: "Max lines to return (default 200)." },
};

/** Render log entries the way both search and study present them. */
function renderEntries(entries: ReadonlyArray<{ timestamp: number; level: string; tags: string[]; message: string }>) {
  return entries
    .map((e) => `${new Date(e.timestamp).toISOString()} [${e.level}] (${e.tags.join(",")}) ${e.message}`)
    .join("\n");
}

function searchLog(logStore: LogStore, args: Record<string, unknown>) {
  return logStore.search({
    tags: args.tags as string[] | undefined,
    anyTags: args.anyTags as string[] | undefined,
    text: args.text ? String(args.text) : undefined,
    regex: Boolean(args.regex),
    level: args.level as any,
    limit: args.limit ? Number(args.limit) : 200,
  });
}

/**
 * Every tool in this provider. Returned as a list so the registry can expose them
 * exactly like an MCP server's toolset (see `builtin:activity_monitor`).
 */
export function createActivityMonitorTools(config: ActivityMonitorConfig): AgentTool[] {
  const { logStore } = config;

  const search: AgentTool = {
    name: "activity_search",
    description:
      "Filter the harness activity log by tag, text or level. Use it to cut noise — start from " +
      "`activity_tags` to see which tags exist, then filter on them (e.g. anyTags:[\"mutation\"] for writes, " +
      "[\"verify:fail\"] for failed checks).",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: { type: "object", properties: { ...LOG_FILTER_PROPS }, required: [] },
    async execute(_id, args) {
      const entries = searchLog(logStore, args);
      return {
        output: renderEntries(entries) || "(no matching entries)",
        details: { count: entries.length, captured: entries.length },
      };
    },
  };

  const tags: AgentTool = {
    name: "activity_tags",
    description:
      "List every tag in the activity log with its entry count. Call this first to learn what can be " +
      "filtered on, then pass the interesting tags to `activity_search` or `activity_study`.",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const hist = logStore.tagHistogram();
      const sorted = Object.entries(hist).sort((a, b) => b[1] - a[1]);
      return { output: sorted.map(([t, n]) => `${t}: ${n}`).join("\n") || "(no tags yet)", details: hist };
    },
  };

  const tailFile: AgentTool = {
    name: "activity_tail_file",
    description:
      "Read the tail of a log file OUTSIDE the harness (an app log, a server log), optionally filtered by " +
      "text. Use this for logs the harness never wrote; use `activity_search` for the harness's own log.",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the log file (absolute, or relative to cwd)." },
        text: { type: "string", description: "Substring (or regex) to match." },
        regex: { type: "boolean", description: "Treat `text` as a regular expression." },
        limit: { type: "number", description: "Max lines to return (default 200)." },
      },
      required: ["file"],
    },
    async execute(_id, args, ctx) {
      const limit = args.limit ? Number(args.limit) : 200;
      const raw = String(args.file ?? "");
      if (!raw) return { output: "activity_tail_file: missing required argument 'file'.", isError: true };
      const file = path.isAbsolute(raw) ? raw : path.join(ctx.cwd, raw);
      try {
        const text = await fs.readFile(file, "utf8");
        let lines = text.split("\n");
        if (args.text) {
          const re = args.regex ? new RegExp(String(args.text), "i") : undefined;
          const needle = String(args.text).toLowerCase();
          lines = lines.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(needle)));
        }
        return {
          output: lines.slice(-limit).join("\n") || "(no matching lines)",
          details: { file, matched: lines.length, captured: lines.length },
        };
      } catch (err) {
        return { output: `Failed to read ${file}: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const study: AgentTool = {
    name: "activity_study",
    description:
      "Ask a model to summarize and find the root cause in a slice of activity. Pass `traceId` to study a " +
      "trace session's collected output, or log filters (tags/text/level) to study the harness log. " +
      "Returns prose analysis, not raw lines — use `activity_search`/`activity_collect` for those.",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        traceId: { type: "string", description: "Study this trace session's collected output." },
        ...LOG_FILTER_PROPS,
      },
      required: [],
    },
    async execute(_id, args, ctx) {
      // Trace mode: study the trace file rather than the harness log.
      if (args.traceId) {
        const traceId = String(args.traceId);
        const collected = await readTrace(traceId);
        if (!collected.exists) {
          return {
            output: `No trace file found at \`${collected.traceFile}\`. Run the flow first, or check the traceId.`,
            isError: true,
            details: { traceId, traceFile: collected.traceFile, exists: false, captured: 0 },
          };
        }
        if (collected.traceLines.length === 0) {
          return {
            output:
              `Trace \`${traceId}\` has no lines yet — the instrumented code may not have run. ` +
              `Run the flow, then call activity_collect/activity_study again.`,
            details: { traceId, traceLines: 0, captured: 0 },
          };
        }
        return await studyWithModel(collected.rendered, collected.traceLines.length, ctx, config);
      }

      const entries = searchLog(logStore, args);
      if (entries.length === 0) {
        return { output: "(no matching entries to study)", details: { count: 0, captured: 0 } };
      }
      return await studyWithModel(renderEntries(entries), entries.length, ctx, config);
    },
  };

  const traceStart: AgentTool = {
    name: "activity_trace_start",
    description:
      "Open a trace session for debugging data/control flow: returns a traceId and the logging convention for " +
      "the project's language — a normal `print`/`console.log` line that STARTS with THIS session's marker " +
      "`TURING_TRACE_<suffix>` (unique to the trace, printed in the snippet; no helper, no imports). YOU then add " +
      "those log lines at the flow points that matter using `read`/`edit`/`add_log` — function entries and exits, " +
      "if/else branches, loops, API calls, state changes, catch blocks — run the flow, and call " +
      "`activity_collect` with the traceId. Only lines carrying this session's marker are collected; a line with " +
      "any other marker — the bare family prefix, a legacy probe, or another session's — is a leftover from an " +
      "earlier run. Pass " +
      "`startCommand` to have the dev server started for you with its stdout piped into the trace file (the marker " +
      "lines are collected from there, so trace the code through a `startCommand` run).",
    // Mutating: with `startCommand` it kills a port and spawns a server.
    mutates: true,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Language for the snippet: typescript, javascript, python, go, rust. Detected when omitted.",
        },
        hint: { type: "string", description: "What is being traced — recorded on the session for context." },
        startCommand: {
          type: "string",
          description: "Dev server command to start, e.g. 'npm run dev'. Its stdout/stderr pipe into the trace file.",
        },
        port: { type: "number", description: "Port to free before starting `startCommand`, e.g. 3000." },
        force: {
          type: "boolean",
          description:
            "Open a NEW session instead of reusing an open one that has no logs yet. Only for a session that is " +
            "genuinely unusable — a second empty trace records no more than the first.",
        },
      },
      required: [],
    },
    execute: (_id, args, ctx) => traceStartAction(args, ctx),
  };

  const addLog: AgentTool = {
    name: "add_log",
    description:
      "Add logging to a file. Same shape as `edit` — `oldString` is the exact text to anchor on, `newString` is " +
      "that text with a log line added (the file's OWN `print`/`console.log`, starting with THIS session's " +
      "marker `TURING_TRACE_<suffix>` — the exact string from the `activity_trace_start` snippet — then a short " +
      "label and the values that decide the branch) — but it is NOT an edit: " +
      "nothing is re-authored, it never counts as a code change, and it CANNOT change code. Every line of the " +
      "anchor must survive verbatim in `newString`; a replacement that rewrites, reformats or deletes a line is " +
      "refused (that is a fix, and fixes go through `edit`). Write the message you would narrate to yourself at " +
      "that point and log the values that decide the branch. For a POSITIONING / LAYOUT bug, log the rendered " +
      "geometry the client measures — getBoundingClientRect() (x/y/width/height), offsetWidth/offsetHeight, the " +
      "viewport and scroll dims — at the element and its reference neighbour: a screenshot shows the gap, these " +
      "numbers tell you by how many pixels and on which element, which is what the edit needs. No helper is " +
      "injected — your line already carries the prefix and is collected as-is. Requires an open " +
      "`activity_trace_start` session; RUN the flow afterwards, then `activity_collect`. `activity_cleanup` " +
      "removes every line this added.",
    // Mutating: it writes a file. Deliberately not one of the loop's code-mutating
    // tools, so a log never owes verification evidence and never routes an
    // authoring model — see `add_log`'s doc comment.
    mutates: true,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to add logging to." },
        oldString: { type: "string", description: "Exact text to anchor on — must appear verbatim in the file." },
        newString: {
          type: "string",
          description:
            "The anchor text with your `TURING_TRACE …` log line(s) added. Every other line must be byte-identical " +
            "to `oldString`. To REMOVE logs, pass the anchor without them.",
        },
        replaceAll: { type: "boolean", description: "Log at every occurrence when the anchor is not unique." },
        traceId: {
          type: "string",
          description: "Trace session these logs belong to. Optional when only one session is open.",
        },
      },
      required: ["path", "oldString", "newString"],
    },
    execute: (_id, args, ctx) => addLogAction(args, ctx),
  };

  const removeLog: AgentTool = {
    name: "remove_log",
    description:
      "Remove logging that `add_log` added. Pass `logId` (the id `add_log` returned, e.g. \"log-2\") to take out " +
      "just that one — useful the moment a log turns out to be at the wrong point and is only noise in every later " +
      "collect — or `all: true` to remove every log this session added, optionally narrowed to one `path`. Matches " +
      "the exact `TURING_TRACE …` lines that were written, so the file returns to what it was; a log you wrote by " +
      "hand is reported, never guessed at. The trace session stays open — use `activity_cleanup` to end it as well.",
    mutates: true,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        logId: { type: "string", description: 'A single log group to remove, e.g. "log-2" (from add_log).' },
        all: { type: "boolean", description: "Remove every log this session added." },
        path: { type: "string", description: "With `all`, limit removal to this file." },
        traceId: { type: "string", description: "Session to act on. Optional — inferred from `logId`, or when one session is open." },
      },
      required: [],
    },
    execute: (_id, args, ctx) => removeLogAction(args, ctx),
  };

  const collect: AgentTool = {
    name: "activity_collect",
    description:
      "Read back what a trace session captured: the log lines carrying THIS session's marker " +
      "`TURING_TRACE_<suffix>` written since `activity_trace_start`. Call it after the flow has run. Pass " +
      "`waitMs` to wait for output to appear instead of returning empty. Lines with other markers (an earlier " +
      "session's leftover probes) are reported, not collected. Follow with `activity_study` to reason over the result.",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        traceId: { type: "string", description: "Trace session id from activity_trace_start." },
        waitMs: {
          type: "number",
          description:
            "Wait up to this many ms for trace output to appear (e.g. while the user exercises the app). " +
            "Omit to read whatever is there right now.",
        },
      },
      required: ["traceId"],
    },
    execute: (_id, args, ctx) => collectAction(args, ctx),
  };

  const cleanup: AgentTool = {
    name: "activity_cleanup",
    description:
      "End a trace session: delete its trace file, kill any server `activity_trace_start` started, and list " +
      "the files you instrumented so the `TURING_TRACE …` lines can be removed. Call it once the bug is understood.",
    mutates: true,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: { traceId: { type: "string", description: "Trace session id to tear down." } },
      required: ["traceId"],
    },
    execute: (_id, args, ctx) => cleanupAction(args, ctx),
  };

  const inspect: AgentTool = {
    name: "activity_inspect",
    description:
      "Verify a visual change on the RUNNING app — by SCREENSHOT. One call reaches the screen, captures a " +
      "screenshot AND judges it (VERDICT: PASS/FAIL) — do NOT also run `media_analysis` on the result. " +
      "Web: navigates to `url` via the connected browser MCP (console too). Mobile: uses the connected " +
      "device MCP, or a booted simulator/emulator DIRECTLY via simctl/adb (no MCP needed); launches " +
      "`bundleId` and/or opens a deep-link `url` (myapp://path), then screenshots — NO element list, NO " +
      "coordinate taps. If the target screen is not reachable by launch/deep link, do NOT tap around: use " +
      "`ask_user_question` (or have the user navigate), then inspect again. " +
      "PICK THE SURFACE BY WHAT THE APP IS: a Flutter/React-Native/native app has NO http URL — pass " +
      "`target:\"mobile\"` + `bundleId` (+ deep link if you have one). Never invent a localhost URL for a " +
      "mobile app: nothing answers it and the call fails. An http `url` is for a genuine web app whose dev " +
      "server is actually running. Pass `expected` — the verdict is judged against it.",
    mutates: false,
    categorizers: ["activity_inspect", "write_edit"],
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Web page URL, or a mobile deep link (e.g. myapp://cards). Optional on mobile when the app is " +
            "foregrounded or `bundleId` is given. Never an http localhost URL for a Flutter/RN/native app.",
        },
        target: {
          type: "string",
          enum: ["auto", "browser", "mobile"],
          description:
            "'auto' (default): mobile when `device`/`bundleId` is set or the url is not http(s); browser for " +
            "an http url when a browser MCP is connected. Set 'mobile' explicitly for a Flutter/RN/native app.",
        },
        device: {
          type: "string",
          description: "Device/simulator id (mobile). Omit to auto-select the first booted device.",
        },
        bundleId: {
          type: "string",
          description:
            "App bundle/package id to launch before capturing (mobile), e.g. com.example.app. Omit if the app " +
            "is already in the foreground.",
        },
        capture: {
          type: "string",
          enum: ["console", "screenshot", "full"],
          description: "console=logs only, screenshot=image, full=both (default: full).",
        },
        selector: {
          type: "string",
          description: "Web only: CSS selector to focus the capture. (Mobile verification is screenshot-only.)",
        },
        traceId: { type: "string", description: "Also fold this trace session's log lines into the result." },
        analyze: {
          type: "boolean",
          description:
            "Default true — the capture is judged with `media_analysis lens:\"qa\"` (VERDICT + located " +
            "defects). Pass false only for a raw capture.",
        },
        expected: {
          type: "string",
          description:
            "What the screen SHOULD show — the requirement, the acceptance criterion, the copy you changed. " +
            "State intended interactive states explicitly (e.g. \"Confirm disabled until the email is " +
            "typed\") — the analyst sees pixels, not code, and judges an unstated state as a defect. " +
            "The verdict is judged against this; without it the analysis can only describe.",
        },
        reference: {
          type: "string",
          description:
            "Reference image path to gap-compare the capture against — a design mockup or a known-good " +
            "screenshot (VERDICT + concrete differences). Falls back to a run-attached image when omitted. " +
            "Implies analysis.",
        },
      },
      required: [],
    },
    execute: (_id, args, ctx) => inspectAction(args, ctx, config),
  };

  // NOTE: `mobile_tap_visual` used to be registered here. It is now the `tap`
  // action of the single `mobile` tool (src/devices/mobile-tool.ts), which
  // calls the same `tapVisualAction` below. Registering it twice would put two
  // names in front of the model for one behaviour.


  return [search, tags, tailFile, study, traceStart, addLog, removeLog, collect, cleanup, inspect];
}

// ---------------------------------------------------------------------------
// Action: trace_start
// ---------------------------------------------------------------------------

/**
 * Open a trace session. Deliberately does NO code editing: it hands back the
 * traceId and the snippet, and the main loop's own `read`/`edit` calls do the
 * instrumenting where the user can see and review every one.
 *
 * (The previous version took a `files` argument and had a model rewrite those
 * files from inside the tool. Those edits bypassed the transcript AND the
 * permission gate, which is why that behavior is gone rather than ported.)
 */
async function traceStartAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
): Promise<ToolResult> {
  // Opening a second session while one is open with NO logs in it is the observed
  // failure, not a hypothetical: refused a premature fix and told that logging was
  // permitted, a run answered by opening ANOTHER trace and going back to reading
  // source. Two empty sessions, nothing logged, nothing observed.
  //
  // The answer is to REUSE that session, not to refuse the call. Refusing looked
  // right and was worse: `activeTraces` is module-global and the process outlives a
  // run, so a run that ended with an empty session would have refused the FIRST
  // step of every run after it, turning one wedged run into all of them. Handing
  // back the session that already exists cannot wedge anything — the caller always
  // gets a usable traceId — and it still stops the pile-up of dry traces.
  const now = Date.now();
  for (const [id, t] of activeTraces) {
    if (t.instrumentedFiles.size === 0 && now - t.startedAt > STALE_TRACE_MS) {
      t.collector?.close();
      activeTraces.delete(id);
    }
  }
  const startCommand = args.startCommand ? String(args.startCommand) : undefined;
  const runMode: "manual" | "auto" = startCommand ? "auto" : "manual";
  const language = (args.language as string)?.toLowerCase() || (await detectLanguage(ctx.cwd));
  // Reuse only when it would behave identically: same project, same language, and no
  // `startCommand` (which asks for a server this session never started). `force`
  // opts out for a session that is genuinely unusable.
  if (!args.force && !startCommand) {
    const reusable = [...activeTraces.values()].find(
      (t) => t.instrumentedFiles.size === 0 && t.cwd === ctx.cwd && t.language === language,
    );
    if (reusable) {
      ctxLog(ctx, "info", ["activity_monitor", "trace", "reuse"], `reusing empty trace ${reusable.traceId}`);
      return {
        output: [
          `**Reusing the open trace session** \`${reusable.traceId}\` — it has no logs in it yet, so a new session ` +
            `would record exactly as much.`,
          `- Trace file: \`${reusable.traceFile}\``,
          `- Language: ${reusable.language}`,
          "",
          `Add the logging now with \`add_log\`: anchor on the exact line (\`oldString\`) and pass it back with ` +
            `your \`${traceMarker(reusable.traceId)} ...\` added (\`newString\`). Then RUN the flow and call ` +
            `\`activity_collect\` with traceId \`${reusable.traceId}\`.`,
          "",
          `**Logging snippet** (already inserted for you by \`add_log\`; here for reference):`,
          "```" + reusable.language,
          loggingSnippet(reusable.language, reusable.traceId, reusable.traceFile, reusable.collectorUrl),
          "```",
        ].join("\n"),
        details: {
          traceId: reusable.traceId,
          traceFile: reusable.traceFile,
          language: reusable.language,
          runMode: reusable.runMode,
          reused: true,
          ...(reusable.collectorUrl ? { collectorUrl: reusable.collectorUrl } : {}),
        },
      };
    }
  }

  const traceId = generateTraceId();
  const traceFile = traceFilePath(traceId);
  const hint = args.hint ? String(args.hint) : undefined;

  const session: TraceSession = {
    traceId, traceFile, language, runMode, instrumentedFiles: new Set(), startedAt: Date.now(), cwd: ctx.cwd,
  };
  activeTraces.set(traceId, session);

  // Stand the collector up BEFORE handing out the snippet, so the URL baked into
  // it is real. Browser-side lines are the ones that used to disappear.
  const collector = await startTraceCollector(traceFile);
  if (collector) {
    session.collector = collector.server;
    session.collectorUrl = collector.url;
  }

  const snippet = loggingSnippet(language, traceId, traceFile, collector?.url);
  const details: Record<string, unknown> = {
    traceId,
    traceFile,
    language,
    runMode,
    ...(collector ? { collectorUrl: collector.url } : {}),
  };
  let output = [
    `**Trace session started**`,
    `- Trace ID: \`${traceId}\``,
    `- Language: ${language}`,
    `- Trace file: \`${traceFile}\``,
    hint ? `- Purpose: ${hint}` : "",
    collector
      ? `- Browser/localhost sink: \`${collector.url}\` — front-end \`TURING_TRACE ...\` calls POST here and land in the same trace file, so a browser flow is captured without asking the user to re-run it.`
      : `- NOTE: no local sink could be started, so \`TURING_TRACE ...\` in BROWSER code will only reach the devtools console. Instrument server-side code, or read the console with \`activity_inspect\`.`,
    "",
    `**Logging snippet** — paste this once per file you instrument:`,
    "```" + (language === "typescript" ? "typescript" : language),
    snippet,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  if (startCommand) {
    const port = args.port ? Number(args.port) : undefined;
    if (port) {
      const killed = await killPort(port);
      if (killed.length > 0) {
        output += `\n\n- Killed ${killed.length} process(es) on port ${port}: ${killed.join(", ")}`;
        details.killedPids = killed;
      }
    }

    try {
      await fs.writeFile(
        traceFile,
        `# Trace ${traceId} started at ${new Date().toISOString()}\n# Command: ${startCommand}\n\n`,
        "utf8",
      );

      // The dev/app server starts in the user's own shell environment, with the
      // project's pinned toolchain resolved — otherwise `startCommand` fails
      // with `command not found` for exactly the reasons `bash` used to.
      const { shellEnv, resolvedCommand } = await prepareStartCommand(startCommand, ctx.cwd);
      const child = spawn(resolvedCommand, [], {
        cwd: ctx.cwd,
        shell: shellEnv.shell,
        env: shellEnv.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      session.childPid = child.pid;
      session.childProcess = child;

      const appendToFile = async (data: Buffer) => {
        try {
          await fs.appendFile(traceFile, data.toString());
        } catch {
          /* best-effort */
        }
      };
      child.stdout?.on("data", (d: Buffer) => void appendToFile(d));
      child.stderr?.on("data", (d: Buffer) => void appendToFile(d));
      child.on("error", (err) => {
        void fs.appendFile(traceFile, `\n[ERROR] spawn failed: ${err.message}\n`);
      });
      child.on("exit", (code) => {
        void fs.appendFile(traceFile, `\n\n# Process exited with code ${code} at ${new Date().toISOString()}\n`);
      });

      // Wait for the app to actually be READY, not a fixed 2.5s. A cold first
      // build (Flutter/Expo/Next) takes minutes; returning "ready" while it is
      // still compiling caused runs to capture a stale / not-yet-running app.
      // Readiness is decided by the COMMAND SHAPE: a web/dev-server command is
      // ready when its port accepts connections; a mobile/device command (which
      // has no port) is ready when its output shows a launch marker. Either way,
      // an early exit or a fatal error means it failed, so we stop waiting
      // instead of blocking the whole deadline on a dead process. A `flutter run
      // -d <simulator>` was previously given a port it never opens and timed out
      // falsely; the command shape now prevents that.
      const isWeb = WEB_RUN_RE.test(startCommand);
      ctx.progress?.({
        stage: "start",
        message: `starting \`${startCommand}\` (waiting for ${isWeb ? "the port to accept connections" : "the app to launch on the device"})`,
      });
      const waited = await waitForAppReady({
        traceFile,
        port,
        isWeb,
        deadlineMs: 180_000,
        onPoll: (n) => {
          if (Math.floor(n.waitedMs / 15000) !== Math.floor((n.waitedMs - 1500) / 15000)) {
            ctx.progress?.({
              stage: "start",
              message:
                n.state === "ready"
                  ? `${isWeb ? "port" : "app"} ready after ${Math.round(n.waitedMs / 1000)}s`
                  : n.state === "failed"
                    ? `start failed after ${Math.round(n.waitedMs / 1000)}s — see the startup output`
                    : `still building/starting (${Math.round(n.waitedMs / 1000)}s)`,
            });
          }
        },
      });
      const ready = waited.ready;
      const readyWaitedMs = waited.waitedMs;
      const readyReason = waited.reason;

      let initialOutput = "";
      try {
        initialOutput = await fs.readFile(traceFile, "utf8");
      } catch {
        /* file not ready yet */
      }

      const readinessLine = ready
        ? readyReason === "port"
          ? `**Ready** — port ${port} is accepting connections (after ${Math.round(readyWaitedMs / 1000)}s). The build is up; you can inspect.`
          : `**Ready** — the app launched (after ${Math.round(readyWaitedMs / 1000)}s). You can inspect.`
        : readyReason === "failed" || readyReason === "exited"
          ? `**FAILED TO START** (after ${Math.round(readyWaitedMs / 1000)}s) — the process exited or printed an error. Do NOT inspect; read the startup output below, fix the command (wrong device / missing flavor / port conflict / missing dependency), and re-issue.`
          : `**NOT READY YET** (after ${Math.round(readyWaitedMs / 1000)}s) — still building/starting. Do NOT inspect yet — capturing now inspects a stale or not-yet-running app. Re-issue \`activity_trace_start\` or poll \`activity_collect\` until this shows Ready.`;

      output += [
        "",
        "",
        `**Started** \`${startCommand}\` (PID ${child.pid ?? "unknown"}); stdout/stderr pipe into the trace file.`,
        readinessLine,
        initialOutput.trim() ? `\n**Startup output:**\n\`\`\`\n${initialOutput.slice(-2000)}\n\`\`\`` : "",
      ]
        .filter(Boolean)
        .join("\n");
      details.autoStarted = true;
      details.childPid = child.pid;
      details.ready = ready;
      details.readyReason = readyReason;
      if (port) {
        details.port = port;
      }
    } catch (err) {
      output += `\n\n**Could not start \`${startCommand}\`:** ${(err as Error).message}`;
      details.autoError = (err as Error).message;
    }
  } else {
    // Make sure the file exists so `collect` reports "no lines yet" rather than
    // "no such trace".
    try {
      await fs.writeFile(traceFile, "", "utf8");
    } catch {
      /* collect will report it */
    }
  }

  output += [
    "",
    "",
    "**Next steps (yours, not this tool's):**",
    `1. \`read\` the files involved, then \`edit\` them to insert \`TURING_TRACE ...\` calls at the flow points that matter — `,
    `   function entries/exits (with args and return values), if/else branches, loop iterations, API calls,`,
    `   state mutations, catch blocks. Be selective; noise makes the trace unreadable.`,
    startCommand
      ? `2. Exercise the flow against the running server.`
      : `2. Run the flow — traces go to the console AND \`${traceFile}\`.`,
    `3. \`activity_collect\` with traceId \`${traceId}\` to read the output back (add \`waitMs\` to wait for it).`,
    `4. \`activity_study\` with the same traceId to reason over it, then \`activity_cleanup\` when done.`,
  ].join("\n");

  ctxLog(
    ctx,
    "info",
    ["activity_monitor", "trace_start"],
    `trace=${traceId} lang=${language} mode=${runMode}${hint ? ` hint=${hint}` : ""}`,
  );

  return { output, details };
}

// ---------------------------------------------------------------------------
// Action: collect
// ---------------------------------------------------------------------------

/**
 * Read a trace file and keep only the lines belonging to THIS session.
 *
 * Session-scoped on purpose: a stale probe an earlier run left in the source
 * emits into a NEW session's trace file the moment the app re-launches, and if
 * collection matched the bare family prefix those lines would be counted as
 * this run's evidence. Lines carrying the family prefix but a different
 * session's marker are returned as `foreign` so the caller can say so — they
 * are leftovers to clean up, not observations to reason over.
 */
async function readTrace(
  traceId: string,
): Promise<{
  exists: boolean;
  traceFile: string;
  totalLines: number;
  traceLines: string[];
  foreignLines: string[];
  foreignMarkers: string[];
  rendered: string;
}> {
  const traceFile = traceFilePath(traceId);
  let rawText: string;
  try {
    rawText = await fs.readFile(traceFile, "utf8");
  } catch {
    return { exists: false, traceFile, totalLines: 0, traceLines: [], foreignLines: [], foreignMarkers: [], rendered: "" };
  }
  const lines = rawText.split("\n");
  const marker = traceMarker(traceId);
  const traceLines: string[] = [];
  const foreignLines: string[] = [];
  const foreignMarkers = new Set<string>();
  for (const l of lines) {
    if (l.includes(marker)) {
      traceLines.push(l);
      continue;
    }
    if (PROBE_MARKER_RE.test(l)) {
      foreignLines.push(l);
      // Which other marker(s) these lines carry, for the report — the bare
      // prefix (a hand-written probe), another session's suffix, or a legacy
      // probe an old run left behind.
      const m = l.match(ANY_MARKER_RE);
      if (m) foreignMarkers.add(m[0]);
    }
  }
  return {
    exists: true,
    traceFile,
    totalLines: lines.length,
    traceLines,
    foreignLines,
    foreignMarkers: [...foreignMarkers],
    rendered: traceLines.join("\n"),
  };
}

/** The comment marker used for the language, for the inserted probe's own note. */
function lineComment(language: string): string {
  return language === "python" ? "#" : "//";
}

/**
 * Add logging to a file — and nothing else.
 *
 * The shape is `edit`'s on purpose (`oldString` → `newString`), because that is how
 * the model already thinks about placing something at a point in code, and because
 * writing the log line itself is the whole value: it chooses the message and the
 * expressions worth printing at that exact spot, the way it would narrate the step
 * in its own reasoning. What it is NOT is an `edit`: no authoring model rewrites it,
 * it never enters the write/verify accounting, and it cannot change code.
 *
 * That last part is enforced, not requested. {@link probeOnlyReplacement} — the same
 * predicate the reproduce gate judges instrumentation by — requires a log-marker
 * delta AND that every other line survives untouched. So this tool cannot become a
 * back door for the unobserved fix the gate exists to refuse, which is exactly what
 * a "just let it write files" tool would be.
 *
 * Two conveniences that stop the model having to think about plumbing: the language's
 * `TURING_TRACE ...` helper is inserted automatically the first time a file is logged (at a
 * position the language actually permits — Dart and Go reject a declaration before
 * their directives), and every inserted line is recorded so `activity_cleanup` takes
 * exactly those lines back out.
 */
async function addLogAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
): Promise<ToolResult> {
  // The traceId is optional when there is exactly one open session: the model has
  // just opened it, and making it re-state the id is friction with no upside.
  const asked = String(args.traceId ?? "").trim();
  const open = [...activeTraces.values()];
  const session = asked ? activeTraces.get(asked) : open.length === 1 ? open[0] : undefined;
  if (!session) {
    return {
      output: asked
        ? `add_log: no open trace session \`${asked}\`. Call \`activity_trace_start\` first.` +
          (open.length ? ` Open: ${open.map((t) => `\`${t.traceId}\``).join(", ")}.` : "")
        : open.length === 0
          ? `add_log: no trace session is open. Call \`activity_trace_start\` first — the logs write into its ` +
            `trace file, and \`activity_collect\` reads them back from there.`
          : `add_log: ${open.length} trace sessions are open, so pass \`traceId\` to say which one these logs ` +
            `belong to: ${open.map((t) => `\`${t.traceId}\``).join(", ")}.`,
      isError: true,
      details: { traceId: asked || undefined, open: open.map((t) => t.traceId) },
    };
  }

  const rel = String(args.path ?? "").trim();
  const oldString = typeof args.oldString === "string" ? args.oldString : "";
  const newString = typeof args.newString === "string" ? args.newString : undefined;
  if (!rel || !oldString || newString === undefined) {
    return {
      output:
        `add_log: needs 'path', 'oldString' (the exact text to anchor on) and 'newString' (that text with your ` +
        `\`TURING_TRACE ...\` line(s) added). Got path=${rel || "(missing)"} oldLen=${oldString.length} ` +
        `newString=${newString === undefined ? "(missing)" : String(newString.length)}.`,
      isError: true,
    };
  }
  const file = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);

  // Log-only, judged by the same rule the reproduce gate uses. A replacement that
  // rewrites or drops a line is a code change wearing a log, and it is refused here
  // so the tool cannot be used to sidestep the gate.
  const kind = probeOnlyReplacement(oldString, newString);
  if (!kind) {
    return {
      output:
        `add_log: this replacement is not log-only, so nothing was written to ${file}. It must ADD (or remove) ` +
        `\`TURING_TRACE ...\` lines and leave every other line exactly as it was — the anchor's own lines have to ` +
        `survive verbatim in \`newString\`. Rewriting, reformatting or deleting a line of code here is a FIX, ` +
        `and a fix goes through \`edit\` (where it is authored, recorded, and gated on having observed the bug).`,
      isError: true,
      details: { path: file, rejected: "not-log-only" },
    };
  }

  // Per-session marker (see `traceMarker`): a probe carrying the bare family
  // prefix or another session's marker emits lines this session's
  // `activity_collect` will never collect — a dead probe that looks like a
  // working one. Refused here with the exact line to paste, so the mistake
  // costs one round instead of an empty trace.
  const sessionMarker = traceMarker(session.traceId);
  if (kind === "insert" && !newString.includes(sessionMarker)) {
    const used = newString.match(ANY_MARKER_RE);
    const example = (printByExample(sessionMarker)[session.language] ?? printByExample(sessionMarker).default).example;
    return {
      output:
        `add_log: the log line must carry THIS session's marker \`${sessionMarker}\` — ` +
        `${used ? `you used \`${used[0]}\`` : "no probe marker found in the added lines"}. ` +
        `A probe with any other marker emits lines \`activity_collect\` refuses for trace \`${session.traceId}\`, ` +
        `so the flow would look dead. Rewrite the line(s) to START with \`${sessionMarker}\`, e.g.:\n  ${example}`,
      isError: true,
      details: { path: file, rejected: "wrong-marker", sessionMarker },
    };
  }

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    return { output: `add_log: cannot read ${file} — ${(err as Error).message}`, isError: true };
  }
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      output: `add_log: oldString not found in ${file}. Read the file and anchor on text that exists verbatim.`,
      isError: true,
      details: { path: file },
    };
  }
  if (occurrences > 1 && !args.replaceAll) {
    return {
      output:
        `add_log: oldString appears ${occurrences} times in ${file}. Extend the anchor so it is unique, or pass ` +
        `replaceAll to log at every one.`,
      isError: true,
      details: { path: file, occurrences },
    };
  }

  let updated = args.replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);

  // The helper, once per file. Its absence is the failure that looks like a dead
  // flow: probes that call an undefined `__t` either throw or never write, and the
  // trace comes back empty with no way to tell which.
  const inserted: string[] = [];
  const added = newString
    .split("\n")
    .filter((l) => !oldString.split("\n").some((o) => o.trimEnd() === l.trimEnd()));
  inserted.push(...added.filter((l) => l.trim().length > 0));

  // No injected helper anymore: the model's own log line(s) already carry the
  // prefix, so the only thing added to the file is the model's newString diff.
  // The first message in the added lines, for the removal report — so `remove_log`
  // can say WHAT it took out rather than only which id. Sliced after the session
  // marker (its suffix is not part of the message); falls back to the bare
  // prefix for lines recorded before markers were per-session.
  const firstMessage = inserted
    .map((l) => {
      let i = l.indexOf(sessionMarker);
      if (i >= 0) return l.slice(i + sessionMarker.length).replace(/["')`;]+/g, "").trim().slice(0, 80) || undefined;
      const any = l.match(ANY_MARKER_RE);
      if (!any || any.index === undefined) return undefined;
      return l.slice(any.index + any[0].length).replace(/["')`;]+/g, "").trim().slice(0, 80) || undefined;
    })
    .find((m): m is string => Boolean(m));

  try {
    await fs.writeFile(file, updated, "utf8");
  } catch (err) {
    return { output: `add_log: cannot write ${file} — ${(err as Error).message}`, isError: true };
  }

  session.instrumentedFiles.add(file);
  logSeq += 1;
  const logId = `log-${logSeq}`;
  if (!session.logs) session.logs = [];
  session.logs.push({
    logId,
    path: file,
    lines: inserted,
    ...(firstMessage ? { label: firstMessage } : {}),
  });

  ctxLog(ctx, "info", ["activity_monitor", "add_log"], `trace=${session.traceId} file=${file} kind=${kind}`);

  return {
    output: [
      kind === "insert"
        ? `**Logs added** to \`${path.relative(ctx.cwd, file) || file}\` as \`${logId}\`.`
        : `**Logs removed** from \`${path.relative(ctx.cwd, file) || file}\`.`,
      ...(kind === "insert"
        ? [
            "",
            `NOW RUN THE FLOW — a log records nothing until the code executes. Then \`activity_collect\` with ` +
              `traceId \`${session.traceId}\`.`,
            `To take it out again: \`remove_log\` with \`logId: "${logId}"\` for just this one, or ` +
              `\`all: true\` for every log this session added. \`activity_cleanup\` also removes them all.`,
          ]
        : []),
    ].join("\n"),
    details: {
      traceId: session.traceId,
      logId,
      path: file,
      kind,
      linesAdded: inserted.length,
      // The loop's contract for "this path now carries debug instrumentation", so
      // the pre-summary strip check sees logs a TOOL wrote rather than an `edit`.
      instrumented: true,
    },
  };
}

/**
 * Take a set of `add_log` groups back out of the files they went into.
 *
 * The helper is handled by counting, not by guessing: it is removed only once no
 * REMAINING group still logs in that file. Removing it while another `TURING_TRACE ...` call
 * survives would leave a call to an undefined function — a syntax-clean file that
 * throws the moment the logged path runs, which is a far worse failure than a
 * leftover helper.
 *
 * Returns what was actually taken out, so a caller can report it rather than assume.
 */
async function removeLogGroups(
  session: TraceSession,
  groups: TraceLogEntry[],
): Promise<{ removed: TraceLogEntry[]; files: string[]; failed: string[] }> {
  const removed: TraceLogEntry[] = [];
  const files: string[] = [];
  const failed: string[] = [];
  const byFile = new Map<string, TraceLogEntry[]>();
  for (const g of groups) byFile.set(g.path, [...(byFile.get(g.path) ?? []), g]);

  for (const [file, group] of byFile) {
    // What survives in this file once these groups go.
    const surviving = (session.logs ?? []).filter((l) => l.path === file && !group.includes(l));
    const lines = group.flatMap((g) => g.lines);
    // No helper to own/transfer anymore — each group's recorded lines ARE the
    // probe lines, and `removeInsertedLines` strips exactly those.

    try {
      const before = await fs.readFile(file, "utf8");
      const after = removeInsertedLines(before, lines);
      if (after !== before) {
        await fs.writeFile(file, after, "utf8");
        files.push(file);
      }
      removed.push(...group);
      // Forget the groups that are gone.
      session.logs = (session.logs ?? []).filter((l) => !group.includes(l));
      if (surviving.length === 0) session.instrumentedFiles.delete(file);
    } catch (err) {
      failed.push(`${path.basename(file)} (${(err as Error).message})`);
    }
  }
  return { removed, files, failed };
}

/**
 * Remove logging that `add_log` added — one group by id, or all of it.
 *
 * The id exists because "undo that one" is a real need mid-investigation: a log at
 * the wrong point is noise in every subsequent collect, and the alternative was
 * tearing the whole session down and re-adding everything else. `all` is the tidy-up
 * at the end, separated from `activity_cleanup` so the session can stay open — you
 * may want the trace file and the collector to survive while the source goes clean.
 */
async function removeLogAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
): Promise<ToolResult> {
  const asked = String(args.traceId ?? "").trim();
  const open = [...activeTraces.values()];
  const logId = typeof args.logId === "string" ? args.logId.trim() : "";
  const all = args.all === true;

  if (!logId && !all) {
    return {
      output:
        "remove_log: say what to remove — `logId` (the id `add_log` returned, e.g. \"log-2\") for one group, or " +
        "`all: true` for every log added in this session. Pass `path` alongside `all` to limit it to one file.",
      isError: true,
    };
  }

  // With a logId, find the session that owns it — the caller should not have to know.
  const session = logId
    ? (asked ? activeTraces.get(asked) : undefined) ?? open.find((t) => (t.logs ?? []).some((l) => l.logId === logId))
    : asked
      ? activeTraces.get(asked)
      : open.length === 1
        ? open[0]
        : undefined;

  if (!session) {
    const known = open.flatMap((t) => (t.logs ?? []).map((l) => l.logId));
    return {
      output: logId
        ? `remove_log: no open session has a log \`${logId}\`.` +
          (known.length ? ` Known ids: ${known.map((k) => `\`${k}\``).join(", ")}.` : " No logs have been added.")
        : open.length === 0
          ? "remove_log: no trace session is open, so there is nothing this tool added to remove."
          : `remove_log: ${open.length} sessions are open — pass \`traceId\` to say which.`,
      isError: true,
      details: { logId: logId || undefined, knownLogIds: known },
    };
  }

  const scopePath = typeof args.path === "string" && args.path.trim()
    ? (path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path))
    : undefined;

  const groups = logId
    ? (session.logs ?? []).filter((l) => l.logId === logId)
    : (session.logs ?? []).filter((l) => !scopePath || l.path === scopePath);

  if (groups.length === 0) {
    return {
      output: logId
        ? `remove_log: \`${logId}\` is not in session \`${session.traceId}\` — it may already be removed.`
        : `remove_log: this session has added no logs${scopePath ? ` to ${path.relative(ctx.cwd, scopePath)}` : ""}, so there is nothing to remove.`,
      isError: true,
      details: { traceId: session.traceId, logId: logId || undefined, knownLogIds: (session.logs ?? []).map((l) => l.logId) },
    };
  }

  const { removed, files, failed } = await removeLogGroups(session, groups);
  const remaining = (session.logs ?? []).map((l) => l.logId);

  ctxLog(
    ctx, "info", ["activity_monitor", "remove_log"],
    `trace=${session.traceId} removed=${removed.map((r) => r.logId).join(",") || "none"}`,
  );

  return {
    output: [
      removed.length === 1
        ? `**Removed \`${removed[0]!.logId}\`**${removed[0]!.label ? ` (\`TURING_TRACE ... ${removed[0]!.label}\`)` : ""} from ` +
          `\`${path.relative(ctx.cwd, removed[0]!.path) || removed[0]!.path}\`.`
        : `**Removed ${removed.length} log group(s)** from ${files.map((f) => `\`${path.relative(ctx.cwd, f) || f}\``).join(", ") || "no files"}.`,
      ...(failed.length ? [`Could NOT remove: ${failed.join(", ")}`] : []),
      remaining.length
        ? `Still in place: ${remaining.map((r) => `\`${r}\``).join(", ")}.`
        : `No logging from this session remains in the source.`,
    ].join("\n"),
    details: {
      traceId: session.traceId,
      removed: removed.map((r) => ({ logId: r.logId, path: r.path })),
      files,
      remainingLogIds: remaining,
      ...(failed.length ? { failed } : {}),
      // Files this touched may still hold logging from other groups, so the loop's
      // strip check must keep watching them.
      ...(files.length ? { instrumented: true, path: files[0] } : {}),
    },
  };
}

async function collectAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
): Promise<ToolResult> {
  const traceId = args.traceId ? String(args.traceId) : undefined;
  if (!traceId) {
    return {
      output: "activity_collect: missing required argument 'traceId' (returned by activity_trace_start).",
      isError: true,
    };
  }
  const session = activeTraces.get(traceId);

  let collected = await readTrace(traceId);
  if (!collected.exists) {
    return {
      output: `No trace file found at \`${collected.traceFile}\`. The flow may not have run yet, or the traceId may be wrong.`,
      isError: true,
      details: { traceId, traceFile: collected.traceFile, exists: false, captured: 0 },
    };
  }

  // Optional wait: the flow often runs AFTER the model asks for the trace (the
  // user has to click through the app). Polling here — with progress, so the wait
  // is visible rather than a dead spinner — beats returning empty and making the
  // model guess how long to stall.
  const waitMs = args.waitMs ? Math.max(0, Number(args.waitMs)) : 0;
  if (waitMs > 0 && collected.traceLines.length === 0) {
    const POLL_MS = 1500;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && collected.traceLines.length === 0) {
      if (ctx.signal?.aborted) break;
      ctx.progress?.({
        stage: "wait",
        message: `waiting for trace output — run the flow now (${Math.ceil((deadline - Date.now()) / 1000)}s left)`,
        waiting: true,
      });
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
      collected = await readTrace(traceId);
    }
  }

  const details: Record<string, unknown> = {
    traceId,
    traceFile: collected.traceFile,
    totalLines: collected.totalLines,
    traceLines: collected.traceLines.length,
    // `captured` — the reproduce gate's contract for "how much did this call
    // actually observe". It is the PROBE line count, deliberately not
    // `totalLines`: a trace file can hold output nobody instrumented (a dev
    // server's own logging, a stray line), and a run that captured none of its
    // own probe calls has observed nothing about the flow no matter how many
    // unrelated lines sit in the file. It counts ONLY this session's marker —
    // foreign-marker lines are another session's leftovers, not evidence.
    // Getting this wrong lifts the gate on a dry trace, which is the one thing
    // it must never do.
    captured: collected.traceLines.length,
    ...(collected.foreignLines.length
      ? { foreignLines: collected.foreignLines.length, foreignMarkers: collected.foreignMarkers }
      : {}),
  };
  if (session) details.runMode = session.runMode;

  ctxLog(ctx, "info", ["activity_monitor", "collect"], `trace=${traceId} lines=${collected.traceLines.length}`);

  // Leftovers from another session: reported, never consumed. This is the
  // attribution half of the per-session marker — without it a stale probe still
  // in the source silently speaks for whatever run happens to re-launch the app.
  const foreignNote = collected.foreignLines.length
    ? [
        "",
        `**${collected.foreignLines.length} line(s) carried OTHER probe markers** (${collected.foreignMarkers
          .map((m) => `\`${m}\``)
          .join(", ")}) — probes from an earlier session are still in the source. They are NOT this run's evidence ` +
          `and are not shown above; they still need removing: \`grep -rn ${TRACE_MARKER_PREFIX}\` finds them, ` +
          `\`activity_cleanup\` and \`remove_log\` only take THIS session's probes out.`,
      ]
    : [];

  if (collected.traceLines.length === 0) {
    return {
      output: [
        `**Trace:** \`${traceId}\` — no trace lines yet.`,
        `**File:** \`${collected.traceFile}\``,
        "",
        `Either the instrumented code has not run, or its stdout is not reaching the trace file — a line is collected only if it contains THIS session's marker \`${traceMarker(
          traceId,
        )}\`. If you wrote the log line with a different marker (the family prefix without the session suffix, or another session's), it will never be collected: fix the marker in the source to \`${traceMarker(
          traceId,
        )}\`.`,
        "Check that a log line was placed at the flow point and that the app's stdout is piped into the trace file (run it via `activity_trace_start`), then run the flow and collect again.",
        ...foreignNote,
      ].join("\n"),
      details,
    };
  }

  return {
    output: [
      `**Trace:** \`${traceId}\` (${collected.traceLines.length} trace lines of ${collected.totalLines} total)`,
      `**File:** \`${collected.traceFile}\``,
      "",
      "```",
      collected.rendered.slice(-5000),
      "```",
      ...foreignNote,
      "",
      `Call \`activity_study\` with traceId \`${traceId}\` to reason over this.`,
    ].join("\n"),
    details,
  };
}

// ---------------------------------------------------------------------------
// Action: cleanup
// ---------------------------------------------------------------------------

async function cleanupAction(
  args: Record<string, unknown>,
  ctx?: { cwd?: string },
): Promise<ToolResult> {
  const traceId = args.traceId ? String(args.traceId) : undefined;
  if (!traceId) {
    return { output: "cleanup: missing required argument 'traceId'.", isError: true };
  }

  const traceFile = traceFilePath(traceId);
  const session = activeTraces.get(traceId);
  const output: string[] = [];

  // Delete trace file
  try {
    await fs.unlink(traceFile);
    output.push(`- Deleted trace file: \`${traceFile}\``);
  } catch {
    output.push(`- Trace file already gone or not found: \`${traceFile}\``);
  }

  // Close the local sink. Left open it would hold a port (and a handle) for the
  // life of the process, which matters most in a long-lived Electron main.
  if (session?.collector) {
    try {
      session.collector.close();
      output.push(`- Closed the browser/localhost trace sink (\`${session.collectorUrl}\`)`);
    } catch {
      /* already closed */
    }
  }

  // Kill auto-started process
  if (session?.childPid) {
    try {
      process.kill(-session.childPid, "SIGTERM"); // kill process group
      output.push(`- Killed auto-started server (PID ${session.childPid})`);
    } catch {
      try {
        process.kill(session.childPid, "SIGKILL");
        output.push(`- Force-killed auto-started server (PID ${session.childPid})`);
      } catch {
        output.push(`- Server process ${session.childPid} already exited`);
      }
    }
  }

  // STRIP the probes, rather than listing them and hoping.
  //
  // `add_log` records every file it wrote into, so cleanup knows exactly
  // what went in and can take it out — whole inserted lines, identified by the
  // marker. That is only reliable for probes the HARNESS placed; a probe the model
  // hand-wrote into the middle of an expression is not a line we can safely
  // delete, so anything still carrying a marker afterwards is reported for the
  // model to finish by hand (which is all this tool used to do for everything).
  const sessionFiles = session ? [...session.instrumentedFiles] : [];
  const teardown = session
    ? await removeLogGroups(session, [...(session.logs ?? [])])
    : { removed: [], files: [], failed: [] };
  const stripped = teardown.files;
  const failed = teardown.failed;
  if (stripped.length) {
    output.push(`- Removed probes from: ${stripped.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (failed.length) {
    output.push(`- Could NOT strip: ${failed.join(", ")}`);
  }

  // Anything still carrying markers — hand-written probes, or files this session
  // never recorded — is named so nothing debug-shaped ships silently.
  let remaining: string[] = [];
  if (ctx?.cwd) {
    remaining = await findProbeMarkerFiles(ctx.cwd);
  }
  if (remaining.length) {
    output.push(`- Probe markers STILL present in: ${remaining.map((f) => `\`${f}\``).join(", ")}`);
  }

  // Remove from active sessions
  activeTraces.delete(traceId);

  return {
    output: [
      `**Cleanup complete for trace \`${traceId}\`**`,
      ...output,
      remaining.length > 0
        ? `\nThese were not placed by \`add_log\`, so they could not be removed automatically. ` +
          `Remove the \`TURING_TRACE ...\` lines from:\n${remaining.map((f) => `- \`${f}\``).join("\n")}`
        : "",
    ].filter(Boolean).join("\n"),
    details: {
      traceId,
      deletedFile: true,
      killedProcess: !!session?.childPid,
      instrumentedFiles: sessionFiles,
      stripped,
      remaining,
    },
  };
}

/**
 * Remove the exact lines an insertion recorded, each one once.
 *
 * Exact text, not a pattern. Classifying lines by shape is what makes automatic
 * cleanup unsafe: `if (x) __t("y");` carries a probe marker AND a guard, and any
 * rule broad enough to delete helper-block lines is broad enough to delete that
 * one too — silently changing behaviour during a step whose whole job is to leave
 * no trace. Matching what was written means the file returns to exactly what it
 * was, and anything unrecognised is left alone and reported instead.
 *
 * Trailing-whitespace-insensitive, because a formatter may have touched the line
 * between insertion and cleanup.
 */
export function removeInsertedLines(text: string, insertedLines: readonly string[]): string {
  if (insertedLines.length === 0) return text;
  const budget = new Map<string, number>();
  for (const line of insertedLines) {
    const key = line.trimEnd();
    // Never match on a blank line: it is indistinguishable from every other blank
    // in the file, so removing "one blank" takes an arbitrary one.
    if (key.trim().length === 0) continue;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const key = line.trimEnd();
    const left = budget.get(key) ?? 0;
    if (left > 0) {
      budget.set(key, left - 1);
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Action: inspect
// ---------------------------------------------------------------------------

/**
 * The device half of `activity_inspect`: boot-check → (launch | open url) →
 * screenshot → on-screen elements → trace lines → optional analysis.
 *
 * Mirrors the browser path step for step, with the substitutions the surface
 * forces: a device id replaces the page, `mobile_open_url` replaces navigation
 * (and handles custom deep-link schemes a browser cannot), and the on-screen
 * element list replaces the DOM snapshot as the structural view.
 *
 * The screenshot's IMAGE BLOCKS are forwarded on the result. Device MCPs put
 * only the string "ok" in `output` and the pixels in `content`, so returning
 * text alone handed the model a screenshot it could not see — which reads, from
 * the model's side, exactly like having no screenshot at all.
 */
async function inspectMobile(
  args: {
    url?: string;
    traceId?: string;
    capture: string;
    device?: string;
    bundleId?: string;
    analyze: boolean;
    /** The reference image the capture is graded against, and why it was chosen. */
    reference?: ResolvedReference;
    /** What the screen should show, forwarded to the QA verdict. */
    expected?: string;
    /** True when simctl/adb are standing in for an absent `mobilecli`. */
    localFallback?: boolean;
  },
  ctx: Parameters<AgentTool["execute"]>[2],
  config: ActivityMonitorConfig,
): Promise<ToolResult> {
  const { traceId } = args;
  const tag = traceId ?? "anon";
  const steps: string[] = [];
  const useCli = !args.localFallback && (await mobileCliAvailable());
  const local = localDeviceTools();

  // Step 1: resolve a device. An explicit id is trusted as-is; otherwise take
  // the first booted one.
  let device = args.device;
  let deviceLabel: string | undefined;
  if (!device) {
    try {
      if (useCli) {
        const devices = await mobileCliDevices();
        device = devices[0]?.id;
        const d = devices[0];
        deviceLabel = d?.name ? `${d.name}${d.version ? ` (${d.version})` : ""}` : undefined;
      } else {
        const res = await local.list.execute(`inspect-devices-${tag}`, {}, ctx);
        const picked = pickDevice(resultText(res));
        device = picked?.id;
        deviceLabel = picked?.label;
      }
    } catch (err) {
      return { output: `**Device lookup failed:** ${(err as Error).message}`, isError: true };
    }
    if (!device) {
      return {
        output: [
          "**No booted device or simulator**",
          "",
          "Boot a simulator/emulator (`xcrun simctl boot <id>` / `emulator -avd <name>`), or pass",
          "`device` explicitly, then call `activity_inspect` again.",
        ].join("\n"),
        isError: true,
      };
    }
    steps.push(
      `- Device: \`${device}\`${deviceLabel ? ` — ${deviceLabel}` : ""}` +
        (args.localFallback ? " (local simulator/emulator — mobilecli not installed)" : ""),
    );
  } else {
    steps.push(`- Device: \`${device}\` (given)`);
  }

  // Step 2: bring the app to the foreground, and/or open the url/deep link.
  if (args.bundleId) {
    try {
      const ok = useCli
        ? await mobileCliLaunch(device, args.bundleId)
        : !(await local.launch.execute(`inspect-launch-${tag}`, { device, bundleId: args.bundleId, packageName: args.bundleId }, ctx)).isError;
      if (!ok) {
        return {
          output: `**Launch failed** for \`${args.bundleId}\` on \`${device}\`. Check it is installed.`,
          isError: true,
          details: { device, bundleId: args.bundleId },
        };
      }
      steps.push(`- Launched: \`${args.bundleId}\``);
    } catch (err) {
      return { output: `**Launch error:** ${(err as Error).message}`, isError: true };
    }
  }

  if (args.url) {
    try {
      const ok = useCli
        ? await mobileCliOpenUrl(device, args.url)
        : !(await local.openUrl.execute(`inspect-open-${tag}`, { device, url: args.url }, ctx)).isError;
      if (!ok) {
        return {
          output: `**Opening \`${args.url}\` failed** on \`${device}\`.`,
          isError: true,
          details: { device, url: args.url },
        };
      }
      steps.push(`- Opened: \`${args.url}\``);
    } catch (err) {
      return { output: `**Open-url error:** ${(err as Error).message}`, isError: true };
    }
  }

  // Step 3: let the UI settle. Matches the browser path's post-navigation wait —
  // a screenshot taken mid-transition shows a spinner and reads as a defect.
  await new Promise((r) => setTimeout(r, 1500));

  // Step 4: capture — SCREENSHOT ONLY. The mobile inspection deliberately does
  // not list elements or tap coordinates: that is what sent real runs into
  // twenty-guess tap loops, and none of it is verification. The screen is
  // reached by launch/deep-link above; the check is the pixels.
  //
  // Both sources are NATIVE resolution, which is the whole point — a
  // downsampled capture is what made vision estimates miss by half a control.
  let screenshotText = "";
  let screenshotImages: ToolResultContent[] = [];
  let captureVia = "";
  if (useCli) {
    const shot = await mobileCliScreenshot(device);
    if (shot) {
      screenshotImages = [{ type: "image", data: shot.data, mimeType: shot.mimeType }];
      captureVia = "mobilecli";
    }
  }
  if (screenshotImages.length === 0) {
    try {
      const res = await local.screenshot.execute(`inspect-screen-local-${tag}`, { device }, ctx);
      const images = imageBlocks(res);
      if (images.length > 0) {
        screenshotText = resultText(res);
        screenshotImages = images;
        captureVia = "simctl/adb";
      } else {
        screenshotText = resultText(res);
      }
    } catch (err) {
      screenshotText = `Screenshot failed: ${(err as Error).message}`;
    }
  }
  if (captureVia) steps.push(`- Capture: ${captureVia} (native resolution)`);

  // Step 5: fold in trace lines, identically to the browser path. Session-scoped
  // (see `readTrace`): another session's leftover probes must not speak for this
  // inspection's evidence.
  let fileLogs = "";
  if (traceId) {
    try {
      const raw = await fs.readFile(traceFilePath(traceId), "utf8");
      const lines = raw.split("\n").filter((l) => l.includes(traceMarker(traceId)));
      if (lines.length > 0) fileLogs = lines.slice(-100).join("\n");
    } catch {
      /* file might not exist */
    }
  }

  let analysisOutput = "";
  if ((args.analyze || args.reference) && screenshotImages.length > 0) {
    analysisOutput = await analyzeCapture(
      screenshotImages,
      args.url ?? `device:${device}`,
      undefined,
      ctx,
      args.reference,
      args.expected,
    );
  }

  const parts: string[] = [];
  parts.push(`**Device inspection**`);
  parts.push(...steps);

  if (fileLogs) {
    parts.push(`\n**Trace logs (\`${traceId}\`):**`, "```", fileLogs.slice(-3000), "```");
  }
  if (screenshotImages.length > 0) {
    parts.push(`\n**Screenshot** (via ${captureVia}) — attached below.`);
  } else if (screenshotText) {
    parts.push(`\n**Screenshot** failed: ${screenshotText.slice(0, 500)}`);
  }
  if (analysisOutput) parts.push(`\n**UI Analysis:**`, analysisOutput);

  if (screenshotImages.length === 0) {
    parts.push(
      "\nNOTE: no screenshot image came back. This is NOT a pass — re-capture or report the missing " +
      "capability. Do NOT fall back to tapping coordinates or reading the element tree; this check is " +
      "the pixels.",
    );
  }

  ctxLog(ctx, "info", ["activity_monitor", "inspect", "mobile"], `device=${device}${traceId ? ` trace=${traceId}` : ""}`);

  return {
    output: parts.join("\n"),
    ...(screenshotImages.length > 0 ? { content: screenshotImages } : {}),
    details: {
      surface: "mobile",
      device,
      deviceLabel,
      url: args.url,
      bundleId: args.bundleId,
      traceId,
      screenshotCaptured: screenshotImages.length > 0,
      // `captured` — same contract as the browser path: a screenshot the model
      // can see, or trace lines off the device. The `steps` narration is not
      // an observation.
      captured: screenshotImages.length + (fileLogs ? 1 : 0),
      backend: useCli ? "mobilecli" : "simctl/adb",
      fileLogLines: fileLogs ? fileLogs.split("\n").length : 0,
    },
  };
}

async function inspectAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
  config: ActivityMonitorConfig,
): Promise<ToolResult> {
  const url = args.url ? String(args.url) : undefined;
  const traceId = args.traceId ? String(args.traceId) : undefined;
  const capture = (args.capture as string) || "full";
  const selector = args.selector ? String(args.selector) : undefined;

  // Resolve a reference image to gap-compare the live capture against. An
  // explicit `reference` arg wins; otherwise fall back to an image attached to
  // the run (ctx.images) — so a user who pinned a mockup gets the comparison
  // without the model having to name the path. A reference alone implies
  // analysis (the comparison IS the analysis).
  const reference = resolveReference(args.reference, ctx.images);

  // Analysis is ON unless the caller explicitly turns it off.
  //
  // It used to be off by default (`!!args.analyze`), which meant the tool the
  // prompts nominate as THE way to verify a screen returned, by default, a
  // screenshot with no verdict attached. Two failures came out of that, and both
  // were observed in real runs. A model that called `activity_inspect {url}` and
  // stopped had "verified" nothing, yet the verification gate accepted it. A model
  // that followed the prompt's four-step recipe called `media_analysis` on the
  // capture afterwards — so the careful path ran the QA pass TWICE, once inside
  // the tool when `analyze` happened to be set and once outside it.
  //
  // Defaulting on collapses both: one call captures and judges, and the prompt now
  // says not to re-analyse the result.
  const analyze = args.analyze === undefined ? true : !!args.analyze;
  const expected = typeof args.expected === "string" && args.expected.trim() ? args.expected.trim() : undefined;

  const registry = ctx.registry as Registry | undefined;

  // Resolve browser automation tools from registry
  const navigateFinder = findTool(registry, BROWSER_NAVIGATE_TOOLS);
  const snapshotFinder = findTool(registry, BROWSER_SNAPSHOT_TOOLS);
  const screenshotFinder = findTool(registry, BROWSER_SCREENSHOT_TOOLS);
  const consoleFinder = findTool(registry, BROWSER_CONSOLE_TOOLS);

  // ...and the device surface. Resolving BOTH before choosing is what makes
  // this tool surface-agnostic: the decision below is about which screen
  // actually exists, not about what kind of repo this is.
  //
  // The device backend is `mobilecli`, called directly — no MCP, no tool-name
  // resolution. When it is not installed, a booted simulator/emulator is still
  // drivable through `xcrun simctl` / `adb`, which covers launch, deep link
  // and capture (everything the inspection needs; only tapping is missing, and
  // the inspection deliberately does not tap).
  //
  // That fallback matters: a mobile repo with nothing configured used to get
  // "no device automation tools available" — a true statement about the
  // registry that the model then generalised into "this change cannot be
  // verified", while a booted simulator sat there capturable in one command.
  const cliOn = await mobileCliAvailable();
  const localDeviceFallback = !cliOn && (await hasLocalDevice());
  if (localDeviceFallback) {
    ctxLog(ctx, "info", ["activity_monitor", "inspect", "mobile"], "mobilecli absent; using local simctl/adb");
  }

  const hasBrowser = !!(navigateFinder || snapshotFinder || screenshotFinder);
  const hasMobile = cliOn || localDeviceFallback;

  // Which surface to drive. Explicit `target` always wins. Otherwise: a device
  // id or bundle id is unambiguous; an http(s) url is a browser's job when one
  // is connected; anything else falls to the device when one is connected.
  //
  // That last clause covers the two cases a device MCP is uniquely for, and both
  // were reachable only by accident before: a custom-scheme deep link
  // (`myapp://path`), which no browser can open, and a bare call with no url at
  // all — "capture whatever is on screen right now", which is the most natural
  // way to ask for a screenshot and previously routed to the browser path and
  // died there on a missing-`url` error.
  const requested = args.target ? String(args.target) : "auto";
  const isHttpUrl = !!url && /^https?:\/\//i.test(url);
  const useMobile =
    requested === "mobile" ||
    (requested === "auto" &&
      hasMobile &&
      (!!args.device || !!args.bundleId || !isHttpUrl || !hasBrowser));

  if (!hasBrowser && !hasMobile) {
    return {
      output: [
        "**No browser or device automation tools available**",
        "",
        "There are no browser tools (Playwright or equivalent), `mobilecli` is not installed, and no " +
        "simulator/emulator is booted on this machine, so there is no surface to render and capture.",
        "",
        "For a mobile app this is usually fixable in one step: boot a simulator and install the app " +
        "(`xcrun simctl list devices`, then `flutter run -d <id>` / `npx react-native run-ios`), then " +
        "call `activity_inspect` again — a booted simulator is captured directly, no extra setup required.",
        "",
        "Do NOT substitute bash for this: curl, `open`, and a build command cannot drive a screen, " +
        "and source inspection is not a visual check. Report the missing capability instead.",
        "",
        "You can still use `activity_collect` with a `traceId` to retrieve logs after the user exercises the flow.",
      ].join("\n"),
      isError: true,
      details: { availableTools: registry ? registry.allTools().map((t) => t.name) : [] },
    };
  }

  if (useMobile) {
    return inspectMobile(
      { url, traceId, capture, device: args.device ? String(args.device) : undefined, bundleId: args.bundleId ? String(args.bundleId) : undefined, analyze, localFallback: localDeviceFallback, ...(expected ? { expected } : {}), ...(reference ? { reference } : {}) },
      ctx,
      config,
    );
  }

  if (!url) {
    return {
      output: "inspect: browser inspection needs a `url`. Pass one, or pass `target:\"mobile\"` to capture a device screen.",
      isError: true,
    };
  }

  // Phase 1: Navigate to the page
  let navigateResult = "";
  if (navigateFinder) {
    try {
      const res = await navigateFinder.tool.execute(
        `inspect-nav-${traceId ?? "anon"}`,
        { url },
        ctx,
      );
      navigateResult = resultText(res);
      if (res.isError) {
        return {
          output: `**Navigation failed:** ${resultText(res)}`,
          isError: true,
          details: { url, tool: navigateFinder.name },
        };
      }
      // A 4xx/5xx or a connection-refused/error-page title is NOT a successful
      // navigation, even though the navigate tool returns isError:false — it
      // dutifully loaded the error page. Catching it here stops the run from
      // screenshotting "404 File not found" and, worse, feeding it to `analyze`
      // which fabricates a UI review of a page that never existed. This was the
      // exact failure on a mobile repo: the model invented a localhost URL that
      // no server answered, the browser served a 404, and `activity_inspect`
      // reported green. When a device MCP is connected, steer there instead of
      // leaving the model to guess again — the app it actually wants is there.
      const failure = navigationFailure(navigateResult);
      if (failure.failed) {
        const steer =
          hasMobile
            ? [
                "",
                "**This looks like a mobile/native app (Flutter, React Native, iOS, Android).**",
                `A device is reachable (${cliOn ? "mobilecli" : "booted simulator/emulator"}) — the app does not run at a web URL.`,
                "Call `activity_inspect` again with `target:\"mobile\"` and the app's `bundleId` (and a",
                "deep-link `url` like `myapp://contacts` if you have one) to drive the simulator instead.",
                "Do NOT invent another http URL. If the app is web-facing, start its dev server first",
                "(STEP 0 in PERFECT) and pass the URL it actually listens on.",
              ].join("\n")
            : [
                "",
                "If this is a web app, its dev server is not running at that URL — start it first",
                "(STEP 0 in PERFECT) and pass the URL it actually listens on. If this is a mobile/native",
                "app, it has no web URL at all: connect a device MCP and call `activity_inspect` with",
                "`target:\"mobile\"` and the app's `bundleId`.",
              ].join("\n");
        return {
          output: [
            `**Navigation did not reach a real page** for \`${url}\` (${failure.reason}).`,
            "",
            "```",
            navigateResult.slice(0, 800),
            "```",
            steer,
          ].join("\n"),
          isError: true,
          details: { url, tool: navigateFinder.name, reason: failure.reason, mobileAvailable: hasMobile },
        };
      }
    } catch (err) {
      return {
        output: `**Navigation error:** ${(err as Error).message}`,
        isError: true,
        details: { url, tool: navigateFinder.name },
      };
    }
  }

  // Phase 2: Wait briefly for the page to settle
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 3: Capture console logs (if requested AND browser_evaluate available)
  let consoleOutput = "";
  if ((capture === "console" || capture === "full") && consoleFinder && traceId) {
    try {
      const consoleRes = await consoleFinder.tool.execute(
        `inspect-console-${traceId}`,
        {
          function: `(() => {
            // Return all console entries that contain the traceId
            // This is a best-effort capture — browser contexts vary
            return "browser console capture requested for trace: ${traceId}";
          })()`,
        },
        ctx,
      );
      consoleOutput = consoleRes.output ?? "";
    } catch {
      /* console capture is best-effort */
    }
  }

  // Also try to read the trace file for any server-side logs — THIS session's
  // marker only, for the same attribution reason as `readTrace`.
  let fileLogs = "";
  if (traceId) {
    const traceFile = traceFilePath(traceId);
    try {
      const raw = await fs.readFile(traceFile, "utf8");
      const lines = raw.split("\n").filter((l) => l.includes(traceMarker(traceId)));
      if (lines.length > 0) {
        fileLogs = lines.slice(-100).join("\n");
      }
    } catch {
      /* file might not exist */
    }
  }

  // Phase 4: Take screenshot (if requested)
  let screenshotOutput = "";
  let screenshotToolName = "";
  let screenshotImages: ToolResultContent[] = [];
  if ((capture === "screenshot" || capture === "full") && screenshotFinder) {
    try {
      const screenshotArgs: Record<string, unknown> = {};
      if (selector) {
        // Some MCP screenshot tools support a selector arg
        screenshotArgs.selector = selector;
      }
      const screenRes = await screenshotFinder.tool.execute(
        `inspect-screen-${traceId ?? "anon"}`,
        screenshotArgs,
        ctx,
      );
      screenshotOutput = resultText(screenRes);
      // Same reason as the device path: the pixels arrive as content blocks, and
      // reading `output` alone silently discarded them — so "I took a screenshot"
      // was true and "the model saw it" was not.
      screenshotImages = imageBlocks(screenRes);
      screenshotToolName = screenshotFinder.name;
    } catch (err) {
      screenshotOutput = `Screenshot failed: ${(err as Error).message}`;
    }
  }

  // Phase 5: Optional AI analysis of the screenshot — delegated to media_analysis
  // lens:"qa" (see analyzeCapture), not a parallel inline describer. A reference
  // image (explicit arg or run attachment) triggers a two-image gap analysis
  // instead, comparing the capture against the reference.
  let analysisOutput = "";
  if ((analyze || reference) && screenshotImages.length > 0) {
    analysisOutput = await analyzeCapture(screenshotImages, url ?? "page", selector, ctx, reference, expected);
  }

  // Build result
  const parts: string[] = [];
  parts.push(`**UI Inspection:** \`${url}\``);
  if (selector) parts.push(`- Focus element: \`${selector}\``);

  if (navigateResult) {
    parts.push(`\n**Navigation:** ${navigateResult.slice(0, 500)}`);
  }

  if (fileLogs) {
    parts.push(`\n**Server-side trace logs (from \`${traceId}\`):**`);
    parts.push("```");
    parts.push(fileLogs.slice(-3000));
    parts.push("```");
  }

  if (consoleOutput) {
    parts.push(`\n**Browser console:**`);
    parts.push("```");
    parts.push(consoleOutput.slice(0, 2000));
    parts.push("```");
  }

  if (screenshotImages.length > 0) {
    parts.push(`\n**Screenshot** (via ${screenshotToolName}) — attached below.`);
  } else if (screenshotOutput) {
    parts.push(`\n**Screenshot** (via ${screenshotToolName}):`);
    parts.push(screenshotOutput.slice(0, 1000));
  }

  if (analysisOutput) {
    parts.push(`\n**UI Analysis:**`);
    parts.push(analysisOutput);
  }

  if (screenshotImages.length === 0 && (capture === "screenshot" || capture === "full")) {
    parts.push(
      "\nNOTE: no screenshot image came back. This is NOT a pass — do not conclude the UI is correct " +
      "from the page text alone; re-capture or report the missing capability.",
    );
  }

  ctxLog(ctx, "info", ["activity_monitor", "inspect"], `url=${url} capture=${capture}${traceId ? ` trace=${traceId}` : ""}`);

  return {
    output: parts.join("\n"),
    ...(screenshotImages.length > 0 ? { content: screenshotImages } : {}),
    details: {
      surface: "browser",
      url,
      capture,
      traceId,
      hasBrowser: true,
      screenshotCaptured: screenshotImages.length > 0,
      // `captured` — the reproduce gate's contract (see ReproductionGate.observe).
      // An observation is a screenshot the model can actually SEE, console output,
      // or server-side trace lines. Page text alone is not counted: the tool's own
      // NOTE above says a missing screenshot is not a pass, and the gate must not
      // read a navigation that rendered an error page as having observed the bug.
      captured:
        screenshotImages.length +
        (consoleOutput ? 1 : 0) +
        (fileLogs ? 1 : 0),
      toolsUsed: {
        navigate: navigateFinder?.name,
        snapshot: snapshotFinder?.name,
        screenshot: screenshotFinder?.name,
        console: consoleFinder?.name,
      },
      fileLogLines: fileLogs ? fileLogs.split("\n").length : 0,
    },
  };
}

// ---------------------------------------------------------------------------

async function studyWithModel(
  rendered: string,
  count: number,
  ctx: Parameters<AgentTool["execute"]>[2],
  config: ActivityMonitorConfig,
): Promise<ToolResult> {
  if (!ctx.llm) {
    return { output: rendered || "(no matching entries)", details: { count, studied: false, captured: count } };
  }
  const slug = config.studyModel ?? ctx.model?.openRouterSlug ?? DEFAULT_STUDY_MODEL;
  const model = ctx.llm.resolveModel(slug);
  const context: Context = {
    // The one-line version of this prompt ("summarize, surface errors, note root
    // causes") reliably produced a retelling of the log in prose — accurate and
    // useless, because the caller already has the lines. What a trace is FOR is the
    // two facts a reader cannot get by scrolling: where the flow stopped, and where
    // a value first went wrong. Naming those, and naming what the trace does not
    // cover, is what makes the next instrumentation pass better than the last.
    systemPrompt: [
      "You read execution traces and activity logs for a coding agent that is debugging. The caller already",
      "has the raw lines, so do NOT retell them. Report, in this order:",
      "1. THE FLOW that actually ran — the sequence of hops that appear, in order.",
      "2. WHERE IT STOPS — the LAST line that printed on the path of interest, and therefore what did NOT run.",
      "   This is usually the answer, so state it plainly even when it looks obvious.",
      "3. THE FIRST WRONG VALUE — the earliest logged value that is null, empty, malformed, of the wrong type,",
      "   or simply not what the surrounding code assumes. Quote it. The break lives between 2 and 3.",
      "4. ERRORS AND ANOMALIES — exceptions, unhandled rejections, repeated or out-of-order lines, timing gaps,",
      "   a loop that ran zero or far too many times.",
      "5. MOST LIKELY CAUSE, as a claim the evidence supports, plus what would confirm it.",
      "6. WHAT THIS TRACE CANNOT TELL YOU — the hop with no logging, the branch never exercised, the value never",
      "   printed. Name where one more `TURING_TRACE ...` call should go.",
      "Distinguish what the trace SHOWS from what you are inferring. If the lines do not support a conclusion,",
      "say the trace is insufficient and what is missing — do not invent a cause. Terse, concrete, no preamble.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: rendered
          ? `Study these ${count} log lines and report findings:\n\n${rendered}`
          : `No log entries matched the filter. Report that nothing was found.`,
        timestamp: Date.now(),
      },
    ],
  };
  const msg = await ctx.llm.complete(model, context, { temperature: 0, signal: ctx.signal });
  const study = msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
  return { output: study, details: { count, studied: true, captured: count } };
}

/**
 * The `analyze:true` path for `activity_inspect`.
 *
 * This USED to run its own inline model call (`analyzeUiWithModel`) with a generic
 * "find alignment / spacing / color issues" prompt. That had two defects, and both
 * were live on a real run: (1) a "find issues" prompt PRESUPPOSES issues exist, so
 * given any screenshot the model produced a confident list of defects — real or
 * invented — which is the same hallucination vector as analysing a 404 page; and
 * (2) it ran AROUND the verification workflow every phase prompt teaches, which is
 * `media_analysis` with `lens:"qa"` checked against an explicit `expected` spec.
 *
 * So `analyze:true` now DELEGATES to `media_analysis lens:"qa"`, reusing the one
 * verifier the prompts point at. The screenshot the inspect path already captured
 * (as image content blocks) is persisted to a temp file and handed over. When
 * `media_analysis` is not in the registry the capture is returned UNANALYSED with a
 * nudge to call it manually — the same "no substitute verification" rule that closes
 * the bash escape hatch. A weaker inline describer is not a fallback, because
 * "describes instead of verifies" is the failure mode this path exists to avoid.
 *
 * When a REFERENCE image is supplied (explicit `reference` arg or a run
 * attachment), the analysis becomes a two-image GAP ANALYSIS: the live capture
 * is compared against the reference and the differences are reported as defects.
 * This serves UI replication (reference = design mockup) and debugging
 * (reference = known-good screenshot) identically — both are "compare live vs
 * expected, list concrete gaps". The comparison still delegates to
 * `media_analysis lens:"qa"`, now with both images as `files`.
 */

/**
 * How a reference image was chosen, so the result can SAY which image the
 * screen was graded against. Reported in the output because an unstated
 * reference is indistinguishable from the wrong reference.
 */
export interface ResolvedReference {
  path: string;
  /** Why this image: the caller named it, or triage said it is the design. */
  why: "explicit" | "design-attachment" | "defect-attachment" | "only-attachment";
}

/** Triage roles, best reference first. `informational` is deliberately absent. */
const REFERENCE_ROLE_ORDER: ReadonlyArray<{ category: string; why: ResolvedReference["why"] }> = [
  // A mockup the run was asked to rebuild — the canonical "does it match" case.
  { category: "ui-replicate", why: "design-attachment" },
  // A screenshot of the defect. Comparing the live screen against it is how you
  // tell "the bug is gone" from "the screen always looked like this".
  { category: "ui-bug", why: "defect-attachment" },
];

/**
 * Resolve the reference image a live capture is compared against.
 *
 * An explicit `reference` argument always wins. Otherwise the run's attachments
 * are consulted BY ROLE, not by position — which is the whole point of this
 * function existing rather than `images[0]`.
 *
 * The bug it fixes: "compare against the image attached to the run" is only
 * well-defined when the run has exactly one image. Real runs carry several — a
 * mockup AND a screenshot of a stack trace, a design AND a photo of a whiteboard
 * — and grading a rendered screen against the stack trace produces a fluent,
 * completely wrong FAIL. So:
 *
 *   - `ui-replicate` (a design to rebuild) is preferred, then `ui-bug` (the
 *     broken state to have fixed);
 *   - `informational` is NEVER a reference. It is text/data the task should
 *     KNOW, not a picture of what the screen should look like;
 *   - with several candidates of the same role, one whose `targets` name a file
 *     the run touched wins over one that does not;
 *   - an UNTRIAGED set falls back to the single-image case only. Two
 *     un-roled images is genuinely ambiguous, and picking one at random is
 *     exactly the failure being fixed — better to run a one-image QA check
 *     against `expected` and say no reference was chosen.
 */
export function resolveReference(
  arg: unknown,
  images: LiveImage[] | undefined,
  /** Files the run wrote, used to break ties between same-role candidates. */
  touchedPaths?: readonly string[],
): ResolvedReference | undefined {
  if (typeof arg === "string" && arg.trim()) return { path: arg.trim(), why: "explicit" };
  const candidates = (images ?? []).filter((i) => i.mimeType.startsWith("image/"));
  if (!candidates.length) return undefined;

  const targetsTouched = (img: LiveImage): boolean =>
    !!img.targets?.length &&
    !!touchedPaths?.length &&
    img.targets.some((t) => touchedPaths.some((p) => p.endsWith(t) || t.endsWith(p)));

  for (const { category, why } of REFERENCE_ROLE_ORDER) {
    const matching = candidates.filter((i) => i.category === category);
    if (!matching.length) continue;
    return { path: (matching.find(targetsTouched) ?? matching[0]!).path, why };
  }

  // No roled candidate. If triage ran at all, an `informational`-only set means
  // there IS no reference — do not fall through to it.
  const triaged = candidates.some((i) => i.category);
  if (triaged) return undefined;
  if (candidates.length === 1) return { path: candidates[0]!.path, why: "only-attachment" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Action: mobile_tap_visual — the one-call visual tap
// ---------------------------------------------------------------------------

/** The strict localization contract the visual tap's vision call must meet. */
function localizePrompt(element: string, dims: { width: number; height: number }): string {
  return (
    `Locate one UI element in this mobile app screenshot (${dims.width}x${dims.height} px).\n` +
    `ELEMENT: ${element}\n` +
    `Reply with EXACTLY three lines and nothing else:\n` +
    `IMAGE: <width>x<height>\n` +
    `POS: <centerX>, <centerY>\n` +
    `FRAC: <fx>, <fy>\n` +
    `- POS is the element's TAP CENTER in IMAGE pixels of THIS image, within its bounds.\n` +
    `- FRAC is the SAME point as fractions of each axis INDEPENDENTLY, to 4 decimals:\n` +
    `  fx = centerX / ${dims.width} (image WIDTH), fy = centerY / ${dims.height} (image HEIGHT).\n` +
    `  Compute fy against the HEIGHT — this image is ${(dims.height / dims.width).toFixed(2)}x taller than it is wide.\n` +
    `- if the element is not visible on this screen, the second line is exactly: POS: none`
  );
}

/**
 * Parse the vision localizer's answer. Returns { x, y } in image pixels,
 * "none" when the element was declared not visible, or undefined when the
 * answer did not follow the contract.
 */
function parsePos(
  text: string,
  dims?: { width: number; height: number },
): { x: number; y: number; via?: string; note?: string } | "none" | undefined {
  if (/\bPOS\s*:\s*none\b/i.test(text)) return "none";
  const m = text.match(/\bPOS\s*:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
  if (!m) return undefined;
  const pixels = { x: Number(m[1]), y: Number(m[2]) };
  const frac = text.match(/\bFRAC\s*:\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)/i);
  if (!dims || !frac) return pixels;
  return reconcileLocalization(pixels, { fx: Number(frac[1]), fy: Number(frac[2]) }, dims);
}

/**
 * Reconcile the localizer's two channels — raw pixels and per-axis fractions.
 *
 * WHY two channels for one point: on a tall phone screenshot the pixel answer's
 * Y is reproducibly wrong while its X is near-exact. Three separate production
 * runs against the SAME screen asked for the profile avatar whose true centre
 * is image (1097, 271) of 1206x2622, and got y = 97, 124, 132 — all of them
 * close to 271 x (1206/2622) = 124.6. That is the value you get by computing a
 * correct fraction of the HEIGHT and then multiplying it by the WIDTH. The
 * model's sense of *where* the element is was right; its conversion back to
 * pixels collapsed the Y axis by the image's aspect ratio (here 2.17x).
 *
 * So the fraction is asked for separately and WINS. It is the channel that was
 * already correct; the pixel channel is kept only as the fallback and as the
 * detector below, which names the aspect-ratio collapse explicitly when it
 * sees it — every run then reports evidence for or against this, rather than
 * the failure being re-diagnosed from scratch.
 */
function reconcileLocalization(
  pixels: { x: number; y: number },
  frac: { fx: number; fy: number },
  dims: { width: number; height: number },
): { x: number; y: number; via: string; note?: string } {
  const inRange = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (!inRange(frac.fx) || !inRange(frac.fy)) {
    return { ...pixels, via: "pixels (no usable fraction)" };
  }
  const fromFrac = { x: Math.round(frac.fx * dims.width), y: Math.round(frac.fy * dims.height) };
  const dy = Math.abs(fromFrac.y - pixels.y);
  // The signature: the pixel Y equals the fraction scaled by WIDTH, not HEIGHT.
  const collapsed = Math.round(frac.fy * dims.width);
  const aspect = dims.height / dims.width;
  const note =
    aspect > 1.2 && Math.abs(pixels.y - collapsed) <= Math.max(12, dims.height * 0.01) && dy > dims.height * 0.02
      ? `the pixel answer's Y (${pixels.y}) is the fraction scaled by WIDTH, not HEIGHT — ` +
        `aspect-ratio collapse (x${aspect.toFixed(2)}); used the fraction instead (y=${fromFrac.y})`
      : dy > dims.height * 0.02
        ? `pixel Y (${pixels.y}) and fraction Y (${fromFrac.y}) disagree by ${dy}px; used the fraction`
        : undefined;
  return { ...fromFrac, via: "fraction", ...(note ? { note } : {}) };
}

/** The retry localization: a DIFFERENT question, not the same one twice. */
function boxPrompt(element: string, dims: { width: number; height: number }): string {
  return (
    `Estimate the BOUNDING BOX of one UI element in this mobile app screenshot (${dims.width}x${dims.height} px).\n` +
    `ELEMENT: ${element}\n` +
    `Reply with EXACTLY three lines and nothing else:\n` +
    `IMAGE: <width>x<height>\n` +
    `BOX: <x>, <y>, <w>, <h>\n` +
    `FRACBOX: <fx>, <fy>, <fw>, <fh>\n` +
    `- BOX tightly bounds the element, in IMAGE pixels of THIS image.\n` +
    `- FRACBOX is the SAME box as fractions of each axis INDEPENDENTLY, to 4 decimals:\n` +
    `  fx = x / ${dims.width} and fw = w / ${dims.width} (image WIDTH),\n` +
    `  fy = y / ${dims.height} and fh = h / ${dims.height} (image HEIGHT).\n` +
    `  Compute fy/fh against the HEIGHT — this image is ${(dims.height / dims.width).toFixed(2)}x taller than wide.\n` +
    `- if the element is not visible on this screen, the second line is exactly: BOX: none`
  );
}

/**
 * Parse the bounding-box answer into a tap center (image pixels).
 *
 * Same two-channel reconciliation as {@link parsePos} — the fractional box is
 * the trustworthy one on a tall screenshot. See {@link reconcileLocalization}.
 */
function parseBox(
  text: string,
  dims?: { width: number; height: number },
): { x: number; y: number; via?: string; note?: string } | "none" | undefined {
  if (/\bBOX\s*:\s*none\b/i.test(text)) return "none";
  const m = text.match(/\bBOX\s*:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
  if (!m) return undefined;
  const pixels = { x: Number(m[1]) + Number(m[3]) / 2, y: Number(m[2]) + Number(m[4]) / 2 };
  const fb = text.match(
    /\bFRACBOX\s*:\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)/i,
  );
  if (!dims || !fb) return pixels;
  return reconcileLocalization(
    pixels,
    { fx: Number(fb[1]) + Number(fb[3]) / 2, fy: Number(fb[2]) + Number(fb[4]) / 2 },
    dims,
  );
}

/**
 * One visual tap: capture -> locate -> convert -> tap -> prove it landed.
 *
 * The arithmetic lives here rather than in the model because every hand-rolled
 * conversion in the runs that failed got it wrong in the same direction. See
 * the coordinate contract in src/devices/mobilecli.ts: taps take LOGICAL
 * POINTS, element rects are already logical, and a screenshot coordinate must
 * be divided by the scale factor first.
 */
export async function tapVisualAction(
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
  // Unused: target resolution needs the device and the registry, nothing from
  // the monitor's own config. Optional so the `mobile` tool can call it
  // directly without inventing a config object to satisfy the signature.
  _config?: ActivityMonitorConfig,
): Promise<ToolResult> {
  const element = typeof args.element === "string" ? args.element.trim() : "";
  if (!element) {
    return { output: "mobile_tap_visual: missing required argument 'element'.", isError: true };
  }
  const retries = Math.max(0, Math.min(Number(args.retries ?? 1) || 0, 2));
  const registry = ctx.registry as Registry | undefined;
  const mediaAnalysis = registry?.getTool("media_analysis");

  // mobilecli is the only thing here that can DELIVER a tap: `xcrun simctl`
  // and `adb screencap` capture but cannot inject touch, so the local
  // fallback stands in for the camera, never for the finger.
  const cliOn = await mobileCliAvailable();
  const missing: string[] = [];
  if (!cliOn) {
    missing.push("`mobilecli` — the device driver (install: `brew install mobile-next/tap/mobilecli`)");
  }
  if (!mediaAnalysis) missing.push("`media_analysis` — the vision localizer");
  if (missing.length) {
    return {
      output:
        `mobile_tap_visual cannot run this run — missing: ${missing.join("; ")}.\n` +
        `Reach the screen another way (deep link via \`mobile_open_url\`, or exact coordinates from ` +
        `\`mobile_elements\`), or install the missing capability and retry.`,
      isError: true,
      details: { missing },
    };
  }

  // Resolve the device: an explicit id, else the only booted one.
  let device = args.device ? String(args.device) : undefined;
  if (!device) {
    const devices = await mobileCliDevices();
    if (!devices.length) {
      return {
        output: "mobile_tap_visual: no booted device/simulator found. Boot one and retry.",
        isError: true,
      };
    }
    device = devices[0]!.id;
  }

  const steps: string[] = [`- Device: \`${device}\``];

  if (args.bundleId) {
    const launched = await mobileCliLaunch(device, String(args.bundleId));
    if (!launched) {
      return {
        output: `**Launch failed** for \`${String(args.bundleId)}\`. \`mobile_list_apps\` shows what is installed.`,
        isError: true,
      };
    }
    steps.push(`- Launched: \`${String(args.bundleId)}\``);
  }

  // The coordinate space, read from the device rather than assumed. Without it
  // a vision estimate cannot be converted, so the vision path refuses instead
  // of guessing a scale factor — guessing is what this whole file is scar
  // tissue from. Element-tree taps need no conversion and still work.
  const info = await mobileCliDeviceInfo(device);
  const screen: MobileCliScreen | undefined = info?.screen;
  if (screen) {
    steps.push(`- Screen: ${screen.width}x${screen.height} pt, scale ${screen.scale}`);
  }

  /**
   * Did the screen actually change?
   *
   * The element tree is the primary signal and pixels are the fallback,
   * because a pixel comparison alone calls a no-op tap a success whenever the
   * status-bar clock ticks between the two captures. `screenSignature` drops
   * time-shaped labels for the same reason. The tree's verdict is only trusted
   * when it actually reported something — an app whose views never reach the
   * accessibility tree signs as "" on every screen, and "" === "" would call
   * every tap a miss.
   */
  const changedBy = (
    beforeSig: string | undefined,
    afterSig: string | undefined,
    beforePix: string | undefined,
    afterPix: string | undefined,
  ): { changed: boolean; via: string } => {
    const treeUsable =
      beforeSig !== undefined && afterSig !== undefined && (beforeSig !== "" || afterSig !== "");
    if (treeUsable) return { changed: beforeSig !== afterSig, via: "element tree" };
    return { changed: !!beforePix && !!afterPix && beforePix !== afterPix, via: "pixels" };
  };

  /**
   * The element tree for the CURRENT screen, fetched once and used for both
   * jobs it serves: matching the described element, and signing the screen so
   * the post-tap comparison has a semantic signal. Each call is a process
   * spawn plus a device round trip, so fetching it twice per attempt (once to
   * match, once to sign) doubled the cost of every tap for no new information.
   */
  const readTree = async (): Promise<{ elements: MobileCliTarget[]; signature: string } | undefined> => {
    try {
      // Labelled and unlabeled together: the fusion below tests the vision
      // point for containment against EVERYTHING on screen, and an unlabeled
      // node is exactly the case that has no other way in.
      const { elements: labelled, unlabeled } = await mobileCliScreen(device!);
      const all: MobileCliTarget[] = [
        ...labelled.map((e) => ({
          rect: e.rect,
          center: { x: Math.round(e.rect.x + e.rect.width / 2), y: Math.round(e.rect.y + e.rect.height / 2) },
          ...(e.label ? { label: e.label } : {}),
          unlabeled: false,
          type: e.type,
        })),
        ...unlabeled,
      ];
      return { elements: all, signature: screenSignature(labelled) };
    } catch {
      return undefined;
    }
  };

  /** Native capture: mobilecli first, simctl/adb second. */
  const capture = async (label: string): Promise<{ data: string; mime: string; source: string } | undefined> => {
    const shot = await mobileCliScreenshot(device!);
    if (shot) return { data: shot.data, mime: shot.mimeType, source: "mobilecli (native)" };
    try {
      const local = await localDeviceTools().screenshot.execute(label, { device }, ctx);
      const img = imageBlocks(local)[0];
      if (img && img.type === "image" && img.data) {
        return { data: img.data, mime: img.mimeType ?? "image/png", source: "simctl/adb (native)" };
      }
    } catch {
      /* no capture source */
    }
    return undefined;
  };

  const taps: Array<{ image?: { x: number; y: number }; logical: { x: number; y: number }; via: string }> = [];
  let lastAfter: { data: string; mime: string } | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const before = await capture(`tapvisual-before-${attempt}`);
    if (!before) {
      return { output: "mobile_tap_visual: could not capture the screen.", isError: true };
    }
    const dims = imagePixelDimensions(before.data, before.mime);
    if (!dims) {
      return {
        output: "mobile_tap_visual: could not read the screenshot's pixel dimensions from its header.",
        isError: true,
      };
    }
    if (attempt === 0) steps.push(`- Capture: ${dims.width}x${dims.height} px via ${before.source}`);

    const beforeTree = await readTree();
    const beforeSig = beforeTree?.signature;

    // ---- CHANNEL E: the element tree -------------------------------------
    // Cheap (one CLI call, no model, deterministic) and exact when it hits.
    const allElements = beforeTree?.elements ?? [];
    const matched = beforeTree ? matchElement(allElements, element) : undefined;

    // ---- CHANNEL V: vision ------------------------------------------------
    // Run it UNLESS the element channel already produced an exact label match:
    // there is nothing for a corroborating estimate to add to a measured
    // identity, and a model call per tap is real latency and real money. Every
    // other case gets both channels, including a partial label match — which is
    // exactly where the description can name the wrong row.
    const exactLabel =
      !!matched && (matched.label ?? "").trim().toLowerCase() === element.trim().toLowerCase();
    let vision: VisionChannel = { unavailable: "not run" };
    let tmpFile: string | undefined;

    if (exactLabel) {
      vision = { unavailable: "skipped — the element tree matched this label exactly" };
    } else if (!screen) {
      vision = {
        unavailable: "`mobilecli device info` reported no screen size, so an image estimate cannot be converted",
      };
    } else {
      const sniffed = sniffImageFormat(before.data, before.mime);
      const ext = sniffed === "jpeg" ? ".jpg" : sniffed === "webp" ? ".webp" : ".png";
      tmpFile = path.join(os.tmpdir(), `turing-tap-${randomBytes(6).toString("hex")}${ext}`);
      try {
        await fs.writeFile(tmpFile, Buffer.from(before.data, "base64"));
        // The retry asks a DIFFERENT question (bounding box -> centre): asking
        // the same question of the same screen returns the same wrong answer.
        const useBox = attempt > 0;
        const loc = await mediaAnalysis!.execute(
          `tapvisual-loc-${attempt}`,
          { file: tmpFile, prompt: useBox ? boxPrompt(element, dims) : localizePrompt(element, dims) },
          ctx,
        );
        const pos = useBox ? parseBox(resultText(loc), dims) : parsePos(resultText(loc), dims);
        if (pos === "none") {
          // "Not on this screen" is a real answer and must not be overridden by
          // a stray element match — but if the tree DID match a label, the
          // element is present and vision simply failed to see it.
          if (!matched) {
            return {
              output: [
                `**Element not visible on the current screen**: "${element}".`,
                "Do NOT tap around. Scroll (`mobile_swipe`) and retry, open the screen by its deep link",
                "(`mobile_open_url`), or use `ask_user_question` if reaching it needs something only the user knows.",
                ...(steps.length ? ["", ...steps] : []),
              ].join("\n"),
              details: { status: "not-visible", device, element, attempts: attempt + 1 },
            };
          }
          vision = { unavailable: "reported the element as not visible, but the tree matched it" };
        } else if (!pos) {
          vision = { unavailable: `did not follow the contract: ${resultText(loc).slice(0, 120)}` };
        } else {
          vision = {
            point: imageToLogical(pos, dims, screen),
            imagePoint: { x: Math.round(pos.x), y: Math.round(pos.y) },
          };
          if (pos.note) steps.push(`- Localizer: ${pos.note}`);
        }
      } catch (e) {
        vision = { unavailable: `errored: ${(e as Error).message}` };
      } finally {
        if (tmpFile) await fs.rm(tmpFile, { force: true }).catch(() => {});
      }
    }

    // ---- FUSE -------------------------------------------------------------
    const resolved = resolveTap(vision, {
      all: allElements,
      ...(matched ? { matched } : {}),
      ...(beforeTree ? {} : { unavailable: "the UI tree could not be read" }),
    });
    if (!resolved) {
      return {
        output: [
          `**Could not locate "${element}".** Neither channel produced a target:`,
          ...steps,
          `- Vision: ${vision.unavailable ?? "no estimate"}`,
          `- Elements: nothing on screen matched the description (${allElements.length} elements read).`,
          "",
          "Next: `mobile_elements` to see what IS on screen, scroll with `mobile_swipe`, open the screen by",
          "deep link (`mobile_open_url`), or `ask_user_question` if it needs something only the user knows.",
        ].join("\n"),
        details: { status: "not-located", device, element, attempts: attempt + 1 },
      };
    }
    steps.push(...resolved.steps);
    const target = resolved.point;
    const imagePoint = vision.imagePoint;
    const via = resolved.confidence;

    // 4. Tap.
    const tapped = await mobileCliTap(device, target.x, target.y);
    if (!tapped) {
      return { output: `**Tap failed** at logical (${target.x}, ${target.y}).`, isError: true };
    }
    taps.push({ ...(imagePoint ? { image: imagePoint } : {}), logical: target, via });
    steps.push(
      `- Tap ${taps.length}: ${imagePoint ? `image (${imagePoint.x}, ${imagePoint.y}) of ${dims.width}x${dims.height} px → ` : ""}` +
        `logical (${target.x}, ${target.y}) via ${via}`,
    );

    // 5. Prove it landed. A silent miss is not a tap.
    await new Promise((r) => setTimeout(r, 900));
    const after = await capture(`tapvisual-after-${attempt}`);
    const afterSig = (await readTree())?.signature;
    if (after) lastAfter = { data: after.data, mime: after.mime };

    const verdict = changedBy(beforeSig, afterSig, before.data, after?.data);
    if (verdict.changed) {
      steps.push(`- Confirmed by ${verdict.via}: the screen changed.`);
      return {
        output: [
          `**Tapped "${element}" — screen CHANGED.** Derivation (attempt ${attempt + 1}):`,
          ...steps,
          "The post-tap screenshot is attached — read it and continue from there.",
        ].join("\n"),
        ...(lastAfter ? { content: [{ type: "image", data: lastAfter.data, mimeType: lastAfter.mime }] } : {}),
        details: {
          status: "changed",
          device,
          element,
          taps,
          confirmedBy: verdict.via,
          ...(screen ? { screen: { width: screen.width, height: screen.height, scale: screen.scale } } : {}),
          captured: 1,
        },
      };
    }
    steps.push(`- No change (${verdict.via}) — re-deriving from a fresh capture.`);
  }

  return {
    output: [
      `**Tapped "${element}" ${taps.length}× — the screen did NOT change.**`,
      ...steps,
      "",
      "The coordinates were sent in LOGICAL POINTS, which is the space this driver takes (verified), so",
      "this is NOT a coordinate-space problem and re-tapping will not fix it. Either the localizer picked",
      "the wrong spot, or the element does not respond to a plain tap.",
      "Next: `mobile_elements` for exact rects, scroll with `mobile_swipe`, reach the screen by deep link",
      "(`mobile_open_url`), or `ask_user_question` if it needs a value only the user knows.",
    ].join("\n"),
    ...(lastAfter ? { content: [{ type: "image", data: lastAfter.data, mimeType: lastAfter.mime }] } : {}),
    details: {
      status: "no-change",
      device,
      element,
      taps,
      ...(screen ? { screen: { width: screen.width, height: screen.height, scale: screen.scale } } : {}),
      captured: 0,
    },
  };
}


/** One line naming the reference and why, prepended to a gap analysis. */
function describeReference(ref: ResolvedReference): string {
  const why =
    ref.why === "explicit"
      ? "you named it on this call"
      : ref.why === "design-attachment"
        ? "the run's attached design to replicate"
        : ref.why === "defect-attachment"
          ? "the run's attached screenshot of the defect"
          : "the only image attached to this run";
  return `Compared against \`${ref.path}\` — ${why}.`;
}

async function analyzeCapture(
  images: ToolResultContent[],
  surface: string,
  selector: string | undefined,
  ctx: Parameters<AgentTool["execute"]>[2],
  reference?: ResolvedReference,
  /** What the screen should show, from the caller's `expected` argument. */
  expected?: string,
): Promise<string> {
  const registry = ctx.registry as Registry | undefined;
  const mediaAnalysis = registry?.getTool("media_analysis");
  if (!mediaAnalysis) {
    return [
      "**Screenshot captured but not analysed** — `media_analysis` is not available this run.",
      "It is NOT a pass to conclude the UI is correct from having taken the screenshot. When `media_analysis`",
      `is connected, call it on this capture with \`lens:"qa"\`, a \`prompt\` stating what to check, and \`expected\``,
      "(what you built: the token values, exact copy, structure) for a PASS/FAIL verdict rather than a description.",
    ].join("\n");
  }

  // Persist the first image block to a temp file so media_analysis can read it by
  // path (its contract). Extra blocks are rare; the first is the screen. The file
  // is cleaned up in the `finally` below — it was leaking one PNG per analyze call.
  const image = images.find((b): b is Extract<ToolResultContent, { type: "image" }> => b.type === "image");
  if (!image) {
    return "(no screenshot image to analyse — capture returned no image block)";
  }
  const sniffed = sniffImageFormat(image.data, image.mimeType ?? "");
  const ext = sniffed === "jpeg" ? ".jpg" : sniffed === "webp" ? ".webp" : ".png";
  const file = path.join(os.tmpdir(), `turing-inspect-${randomBytes(6).toString("hex")}${ext}`);
  try {
    await fs.writeFile(file, Buffer.from(image.data, "base64"));
  } catch (err) {
    return `(could not persist the screenshot for analysis: ${(err as Error).message})`;
  }

  // Everything below hands `file` to media_analysis then returns. Wrap it so the
  // temp file is ALWAYS removed, including on the early returns and throws.
  try {
    // Two-image GAP ANALYSIS: compare the live capture against a reference. The
    // reference is authoritative — it is the design (replication) or the
    // known-good state (debugging). `files` carries both so media_analysis ships
    // both images to the analyst; the prompt names which is which. Reuses the
    // `qa` lens so the verdict format (VERDICT: PASS/FAIL + defects) is the one
    // the verification gate already recognises.
    if (reference) {
      const referencePath = reference.path;
      // Verify the reference exists BEFORE delegating. A missing/stale path would
      // otherwise make media_analysis partial-fail (reject just the reference,
      // proceed with the single screenshot), silently degrading the two-image gap
      // analysis into a one-image QA check the prompt framed as a comparison.
      try {
        await fs.stat(referencePath);
      } catch {
        return `Gap analysis could not run: the reference image "${referencePath}" does not exist or is not readable. The live capture is attached; pass an existing reference path (a design mockup or a known-good screenshot) and retry.`;
      }
      const gapPrompt = [
        `Gap analysis: compare the LIVE CAPTURE of the ${surface}${selector ? ` (focus: ${selector})` : ""} ` +
          `against the REFERENCE image. Two images are attached: the FIRST is the live capture (what the app ` +
          `actually renders now), the SECOND is the reference (the design to replicate, or the known-good state ` +
          `to match).`,
        `The REFERENCE is authoritative. Report every concrete difference as a defect: missing or extra elements, ` +
          `wrong copy (quote both), different colour/spacing/sizing/alignment, broken or overflowing layout, ` +
          `missing imagery or icons, visible errors. A difference too small to matter is still a difference — note ` +
          `it at minor severity rather than ignoring it. Do NOT invent defects that are not visible in both images.`,
        `First line exactly 'VERDICT: PASS' (the live capture matches the reference) or 'VERDICT: FAIL' (it does ` +
          `not), then each defect as a bullet with severity (blocker/major/minor), where it is, what you see, and ` +
          `what the reference shows instead.`,
      ].join("\n\n");
      try {
        const res = await mediaAnalysis.execute(
          `inspect-gap-${surface}`,
          { files: [file, referencePath], prompt: gapPrompt, lens: "qa" },
          ctx,
        );
        // State WHICH image the screen was graded against. An unstated reference
        // reads exactly like a correct one, so a mis-picked reference used to be
        // invisible in the transcript — the verdict looked authoritative either way.
        const body = resultText(res) || "(media_analysis returned no gap analysis)";
        return `${describeReference(reference)}\n\n${body}`;
      } catch (err) {
        return `(media_analysis gap analysis failed: ${(err as Error).message})`;
      }
    }

    // No "call me again with `expected`" invitation here. That sentence used to
    // end this prompt, and it was an instruction to verify the same capture
    // TWICE — the duplicate QA pass users noticed. `expected` is an argument of
    // `activity_inspect` now, so a stricter check is the SAME call with one more
    // field, not a follow-up round trip.
    const prompt =
      `QA-check the captured ${surface} screenshot${selector ? ` (focus: ${selector})` : ""}. ` +
      `Return VERDICT: PASS or FAIL and list concrete defects only.` +
      (expected?.trim()
        ? `\n\nEXPECTED (what the change was supposed to produce — judge the screen against THIS, and fail it if the ` +
          `screen does not show it): ${expected.trim()}`
        : ``) +
      `\n\nAn element STATE (disabled, empty, loading, selected) is a defect ONLY if the EXPECTED above says it ` +
      `should be otherwise — the screen state before a flow runs is often exactly what the code intends. Report ` +
      `unstated states as non-deciding observations, and do not let them fail the verdict.`;
    try {
      const res = await mediaAnalysis.execute(
        `inspect-analyze-${surface}`,
        { file, prompt, lens: "qa", ...(expected?.trim() ? { expected: expected.trim() } : {}) },
        ctx,
      );
      return resultText(res) || "(media_analysis returned no analysis)";
    } catch (err) {
      return `(media_analysis failed: ${(err as Error).message})`;
    }
  } finally {
    // Best-effort cleanup; the file is no longer needed once media_analysis has
    // read it. A failure here is not worth surfacing over the analysis result.
    try {
      await fs.unlink(file);
    } catch {
      /* already gone, or rm failed — nothing actionable */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctxLog(
  ctx: Parameters<AgentTool["execute"]>[2],
  level: "debug" | "info" | "warn" | "error",
  tags: string[],
  message: string,
): void {
  try {
    ctx.log({ timestamp: Date.now(), level, tags, message });
  } catch {
    /* best-effort logging */
  }
}
