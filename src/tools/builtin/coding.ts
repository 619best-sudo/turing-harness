/**
 * Built-in coding tools: bash, bash_readonly, read, write, edit, ls, grep.
 * These mirror pi's default toolset plus a strict read-only shell for Prepare/Plan,
 * and are pre-tagged with 4P phases.
 */
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "../../types.js";

const pexec = promisify(exec);
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_BACKGROUND_POLL_MS = 8_000;
const DEFAULT_BACKGROUND_POLL_INTERVAL_MS = 500;
const DEFAULT_READY_PATTERNS = [
  /ready in/i,
  /local:\s+http/i,
  /serving!/i,
  /metro waiting/i,
  /started server on/i,
  /serving http on/i,
  /compiled successfully/i,
  /listening on/i,
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
];
const START_COMMAND_PATTERNS = [
  /\bnpm\s+run\s+(dev|start|preview)\b/i,
  /\bpnpm\s+(dev|start|preview)\b/i,
  /\byarn\s+(dev|start|preview)\b/i,
  /\bnpx\s+(vite|next|expo|serve)\b/i,
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\b(?:vite|next|expo)\s+(?:dev|start|preview)\b/i,
];
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

export const bashTool: AgentTool = {
  name: "bash",
  description:
    "Run a shell command to understand the project, inspect files/folders, or execute build/test/lint commands. Returns stdout+stderr.",
  mutates: true,
  // Mutating shell is only available once the chain reaches execution /
  // verification phases. Prepare/Plan must stay read-only.
  phases: ["perform", "perfect"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeoutMs: { type: "number", description: "Timeout in ms for blocking commands (default 120000)." },
      background: {
        type: "boolean",
        description:
          "Start the command as a background process and poll briefly for readiness instead of waiting for exit. Useful for dev servers/watchers.",
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
    const command = String(args.command ?? "");
    const timeout = Number(args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
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
  phases: ["prepare", "plan"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "A read-only shell command to inspect the workspace." },
      timeoutMs: { type: "number", description: "Timeout in ms for read-only inspection commands (default 120000)." },
    },
    required: ["command"],
  },
  async execute(_id, args, ctx) {
    const command = String(args.command ?? "");
    const timeout = Number(args.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
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

async function startBackgroundCommand(
  command: string,
  args: Record<string, unknown>,
  ctx: Parameters<AgentTool["execute"]>[2],
) {
  const pollMs = Math.max(250, Number(args.pollMs ?? DEFAULT_BACKGROUND_POLL_MS));
  const readyPattern = compileReadyPattern(args.readyPattern);
  const failurePattern = compileReadyPattern(args.failurePattern);
  const { logFile } = await createBackgroundLogFile();
  const fd = syncFs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
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
    message: `${command} [pid=${child.pid ?? "unknown"} log=${logFile}]`,
  });

  const poll = await pollBackgroundCommand({
    pid: child.pid,
    logFile,
    pollMs,
    readyPattern,
    failurePattern,
    signal: ctx.signal,
  });

  if (poll.status === "failed") {
    const out = [
      poll.failureMatch
        ? `Background command reported a startup failure${poll.failureMatch ? ` via ${JSON.stringify(poll.failureMatch)}` : ""}.`
        : `Background command exited before it became ready.`,
      `Log file: ${logFile}`,
      poll.snippet ? `Log output:\n${poll.snippet}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    ctx.log({ timestamp: Date.now(), level: "error", tags: ["tool:bash", "background", "error"], message: out });
    return {
      output: out,
      isError: true,
      details: {
        command,
        background: true,
        pid: child.pid,
        logFile,
        status: poll.status,
        failurePattern: failurePattern?.source,
        failureMatch: poll.failureMatch,
      },
    };
  }

  const lines = [
    `Started background command${child.pid ? ` (pid ${child.pid})` : ""}.`,
    `Log file: ${logFile}`,
    poll.status === "ready"
      ? `Startup confirmed${poll.match ? ` via ${JSON.stringify(poll.match)}` : ""}.`
      : `Process is still running, but readiness is not confirmed yet after ${pollMs}ms.`,
    poll.snippet ? `Recent log output:\n${poll.snippet}` : "Recent log output:\n(no output yet)",
  ];

  return {
    output: lines.join("\n"),
    details: {
      command,
      background: true,
      pid: child.pid,
      logFile,
      status: poll.status,
      readyPattern: readyPattern?.source,
      failurePattern: failurePattern?.source,
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

async function pollBackgroundCommand(input: {
  pid?: number;
  logFile: string;
  pollMs: number;
  readyPattern?: RegExp;
  failurePattern?: RegExp;
  signal?: AbortSignal;
}): Promise<{ status: "ready" | "pending" | "failed"; match?: string; failureMatch?: string; snippet?: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.pollMs) {
    if (input.signal?.aborted) {
      return { status: "pending", snippet: await readLogSnippet(input.logFile) };
    }
    const snippet = await readLogSnippet(input.logFile);
    const failed = matchFailure(snippet, input.failurePattern);
    if (failed) {
      return { status: "failed", failureMatch: failed, snippet };
    }
    const ready = matchReady(snippet, input.readyPattern);
    if (ready) {
      return { status: "ready", match: ready, snippet };
    }
    if (input.pid && !isProcessAlive(input.pid)) {
      return { status: "failed", snippet };
    }
    await delay(DEFAULT_BACKGROUND_POLL_INTERVAL_MS);
  }

  const snippet = await readLogSnippet(input.logFile);
  return {
    status:
      matchFailure(snippet, input.failurePattern) || (input.pid && !isProcessAlive(input.pid))
        ? "failed"
        : "pending",
    failureMatch: matchFailure(snippet, input.failurePattern),
    snippet,
  };
}

async function readLogSnippet(file: string): Promise<string> {
  try {
    const text = await fs.readFile(file, "utf8");
    const trimmed = text.trim();
    if (!trimmed) return "";
    return trimmed.length > 1500 ? `…${trimmed.slice(-1500)}` : trimmed;
  } catch {
    return "";
  }
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
  for (const rule of READONLY_SHELL_BLOCKS) {
    if (rule.pattern.test(trimmed)) return rule.reason;
  }
  return undefined;
}

async function runBlockingShellCommand(
  command: string,
  timeout: number,
  ctx: Parameters<AgentTool["execute"]>[2],
  toolName: "bash" | "bash_readonly",
) {
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd: ctx.cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      signal: ctx.signal,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { output: out || "(no output)", details: { command } };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    ctx.log({ timestamp: Date.now(), level: "error", tags: [`tool:${toolName}`, "error"], message: out });
    return { output: out || "command failed", isError: true, details: { command } };
  }
}

export const readTool: AgentTool = {
  name: "read",
  description: "Read a UTF-8 text file. Supports optional line offset/limit for large files.",
  mutates: false,
  phases: ["prepare", "plan", "perform", "perfect"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)." },
      offset: { type: "number", description: "1-based start line." },
      limit: { type: "number", description: "Max number of lines." },
    },
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
      return { output: numbered, details: { path: file, lineCount: lines.length } };
    } catch (err) {
      return { output: `Failed to read ${file}: ${(err as Error).message}`, isError: true };
    }
  },
};

export const writeTool: AgentTool = {
  name: "write",
  description: "Create or overwrite a file with the given contents.",
  mutates: true,
  phases: ["perform"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  async execute(_id, args, ctx) {
    if (!args.path || !args.content) {
      return {
        output: `write: missing required argument(s). Need 'path' and 'content'. Got path=${String(args.path ?? "")} contentLen=${String(args.content ?? "").length}.`,
        isError: true,
      };
    }
    const file = resolveInCwd(ctx.cwd, String(args.path));
    ctx.log({ timestamp: Date.now(), level: "info", tags: ["tool:write", "mutation"], message: file });
    try {
      const nextContent = String(args.content ?? "");
      const previousContent = await readExistingFile(file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, nextContent, "utf8");
      return {
        output: `Wrote ${file}`,
        details: {
          path: file,
          ...buildUnifiedDiff(file, previousContent, nextContent),
        },
      };
    } catch (err) {
      return { output: `Failed to write ${file}: ${(err as Error).message}`, isError: true };
    }
  },
};

export const editTool: AgentTool = {
  name: "edit",
  description:
    "Replace an exact string in a file with a new string. `oldString` must appear exactly once unless `replaceAll` is set.",
  mutates: true,
  phases: ["perform"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldString: { type: "string", description: "Exact text to replace." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean" },
    },
    required: ["path", "oldString", "newString"],
  },
  async execute(_id, args, ctx) {
    if (!args.path || args.oldString == null || args.newString == null) {
      return {
        output: `edit: missing required argument(s). Need 'path', 'oldString', 'newString'. Got path=${String(args.path ?? "")} oldLen=${String(args.oldString ?? "").length} newLen=${String(args.newString ?? "").length}.`,
        isError: true,
      };
    }
    const file = resolveInCwd(ctx.cwd, String(args.path));
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
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
      const updated = args.replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      await fs.writeFile(file, updated, "utf8");
      return {
        output: `Edited ${file} (${args.replaceAll ? count : 1} replacement(s))`,
        details: {
          path: file,
          ...buildUnifiedDiff(file, text, updated),
        },
      };
    } catch (err) {
      return { output: `Failed to edit ${file}: ${(err as Error).message}`, isError: true };
    }
  },
};

export const lsTool: AgentTool = {
  name: "ls",
  description: "List directory entries (non-recursive) to understand project structure.",
  mutates: false,
  phases: ["prepare", "plan"],
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

export const grepTool: AgentTool = {
  name: "grep",
  description: "Search files for a regex pattern (uses ripgrep if available, else grep -r).",
  mutates: false,
  phases: ["prepare", "plan"],
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory/file to search (default cwd)." },
      glob: { type: "string", description: "Optional file glob filter." },
    },
    required: ["pattern"],
  },
  async execute(_id, args, ctx) {
    const target = resolveInCwd(ctx.cwd, String(args.path ?? "."));
    const pattern = String(args.pattern);
    const globArg = args.glob ? ` -g ${JSON.stringify(String(args.glob))}` : "";
    // Prefer ripgrep; fall back to grep.
    const cmd = `command -v rg >/dev/null 2>&1 && rg -n --no-heading${globArg} ${JSON.stringify(pattern)} ${JSON.stringify(target)} || grep -rn ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    try {
      const { stdout } = await pexec(cmd, { cwd: ctx.cwd, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal });
      return { output: stdout.trim() || "(no matches)", details: { pattern } };
    } catch (err) {
      const e = err as { stdout?: string };
      // grep exits 1 on no match.
      return { output: (e.stdout ?? "").trim() || "(no matches)" };
    }
  },
};

export const CODING_TOOLS: AgentTool[] = [bashTool, bashReadonlyTool, readTool, writeTool, editTool, lsTool, grepTool];
