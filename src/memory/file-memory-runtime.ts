import { watch, type FSWatcher } from "node:fs";
import { availableParallelism } from "node:os";
import * as path from "node:path";

import type { LLMBridge } from "../types.js";
import {
  FILE_MEMORY_IGNORED_DIRS,
  FILE_MEMORY_IGNORED_DIRS_BY_ROOT,
  type FileMemory,
  type FileMemoryEntry,
} from "./file-memory.js";
import { DEFAULT_FILE_SUMMARIZER_MODEL, summarizeFileWithLlm } from "./file-summary-llm.js";


export interface FileMemoryRuntimeOptions {
  cwd: string;
  llm: LLMBridge;
  memory: FileMemory;
  modelSlug?: string;
  concurrency?: number;
  watch?: boolean;
  autoStartHydration?: boolean;
  llmSyncEnabled?: boolean;
  /**
   * WHICH files get an LLM summary.
   *
   * `"edited"` (default) — only files the run actually wrote, reported by
   * `noteFilesWritten`, plus anything a watcher observed changing. Files nobody
   * touched keep their parser-derived summary, which is what `file_memory`
   * search already ranks on.
   *
   * `"all"` — the old behavior: sweep the whole index on session start. One
   * summary per file in the project, every project, whether or not the run had
   * anything to do with it. On a Flutter app that was 11k files.
   */
  summarizeOn?: "edited" | "all";
  /**
   * Hold summaries until `flush()` instead of firing as paths arrive.
   *
   * Default true, and the reason the calls were invisible: hydration ran on its
   * own clock, so LLM traffic appeared mid-conversation with no tool call
   * attached to it. Deferred, the work lands at run end where it belongs — after
   * the agent is done editing, and against final file contents rather than an
   * intermediate save the next edit invalidates anyway.
   */
  deferUntilFlush?: boolean;
}

export interface FileMemoryRuntimeStatus {
  llmSyncEnabled: boolean;
  isRefreshing: boolean;
  queuedCount: number;
  runningCount: number;
  /** True while queued paths are parked waiting for `flush()`. */
  held: boolean;
  /**
   * How many queued paths turned out to need no summary — already summarized at
   * the file's current content hash. The measure of what the change-check saves.
   */
  skippedCount: number;
  summarizeOn: "edited" | "all";
  watching: boolean;
  lastFullSummarySyncStartedAt?: number;
  lastFullSummarySyncCompletedAt?: number;
  lastFullSummarySyncModel?: string;
  lastFullSummarySyncError?: string;
}

export class FileMemoryRuntime {
  readonly cwd: string;
  readonly memory: FileMemory;
  readonly llm: LLMBridge;
  readonly modelSlug: string;
  readonly concurrency: number;
  readonly autoStartHydration: boolean;
  readonly summarizeOn: "edited" | "all";
  readonly deferUntilFlush: boolean;

  private watcher?: FSWatcher;
  private readonly queue = new Set<string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = 0;
  /** Paths that reached the front of the queue and needed no summary. */
  private skipped = 0;
  private started = false;
  private disposed = false;
  private llmSyncEnabled: boolean;
  private refreshAllPromise?: Promise<void>;
  private idleResolvers: Array<() => void> = [];
  /** True while the queue may only accumulate — see `deferUntilFlush`. */
  private held: boolean;
  private flushPromise?: Promise<void>;

  constructor(opts: FileMemoryRuntimeOptions) {
    this.cwd = opts.cwd;
    this.memory = opts.memory;
    this.llm = opts.llm;
    this.modelSlug = opts.modelSlug ?? DEFAULT_FILE_SUMMARIZER_MODEL;
    this.concurrency = Math.max(1, Math.min(4, opts.concurrency ?? defaultConcurrency()));
    this.autoStartHydration = opts.autoStartHydration ?? true;
    this.summarizeOn = opts.summarizeOn ?? "edited";
    this.deferUntilFlush = opts.deferUntilFlush ?? true;
    this.held = this.deferUntilFlush;
    this.llmSyncEnabled =
      opts.llmSyncEnabled ?? (this.autoStartHydration ? true : opts.memory.summarySync.llmSyncEnabled);
    if (opts.watch !== false) this.startWatcher();
  }

  startInitialHydration(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // In "edited" mode there is nothing to hydrate at startup: a session that
    // opens a project owes it no summaries, only the files it goes on to change.
    // `refreshAllSummaries()` remains the way to ask for a full pass explicitly.
    if (this.summarizeOn === "edited") return;
    const candidates = this.autoStartHydration
      ? this.memory.listSummaryHydrationCandidates({ includeFresh: this.memory.wasCreated }).map((entry) => entry.path)
      : this.llmSyncEnabled
        ? this.memory
            .list()
            .filter((entry) => entry.stale || entry.summaryPending || !!entry.summaryError)
            .map((entry) => entry.path)
        : [];
    this.enqueuePaths(candidates);
  }

  enqueuePaths(paths: string[]): void {
    if (this.disposed) return;
    for (const value of paths) {
      const absPath = path.isAbsolute(value) ? value : path.join(this.cwd, value);
      if (this.shouldIgnore(absPath)) continue;
      this.queue.add(absPath);
    }
    this.pump();
  }

  /**
   * The files a run actually wrote — the one signal that means "summarize this".
   *
   * Called at run end with the chain's `writtenPaths`, so the summary is written
   * against the file's FINAL content. The filesystem watcher reports the same
   * edits, but debounced by 350ms and suspended for the duration of a run: a
   * write in the last moments of a run can be missed entirely. This is the
   * authoritative path; the watcher is the backstop for edits made outside a run.
   */
  noteFilesWritten(paths: string[] | undefined): void {
    if (!paths?.length || this.disposed || !this.llmSyncEnabled) return;
    // Queued, NOT marked pending. Marking it here would pre-commit the answer:
    // `needsSummaryHydration` treats a pending entry as needing an LLM pass, so
    // forcing the flag meant every written path bought a summary even when the
    // write left the bytes identical — a formatter pass, a revert, or an `edit`
    // that replaced a string with itself. Whether it is needed is decided in
    // `processPath`, against the file's actual hash.
    this.enqueuePaths(paths);
  }

  /**
   * Stop starting new summaries. Idempotent; safe to call per run.
   *
   * Awaits any flush already in flight rather than racing it, so two runs in
   * quick succession never have summary work overlapping the second run's turns.
   */
  async hold(): Promise<void> {
    this.held = true;
    await this.flushPromise?.catch(() => undefined);
  }

  /**
   * Run everything the queue accumulated, then hold again.
   *
   * Returns when the queue is empty. Callers that must not block a run's return
   * (the run-end hook) fire this without awaiting — `hold()` at the next run
   * start still waits for it.
   */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.flushPromise) return this.flushPromise;
    const run = (async () => {
      this.held = false;
      this.pump();
      await this.drain();
    })().finally(() => {
      this.held = this.deferUntilFlush;
      this.flushPromise = undefined;
    });
    this.flushPromise = run;
    return run;
  }

  /** Wait for in-flight summaries to settle. While held, queued-but-unstarted
   *  paths are not waited on — use `flush()` to actually run them. */
  async drain(): Promise<void> {
    if (this.running === 0 && (this.held || !this.queue.size)) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.queue.clear();
    await this.flushPromise?.catch(() => undefined);
    await this.drain().catch(() => undefined);
  }

  getStatus(): FileMemoryRuntimeStatus {
    const summarySync = this.memory.getSummarySyncData();
    return {
      llmSyncEnabled: this.llmSyncEnabled,
      isRefreshing: !!this.refreshAllPromise,
      queuedCount: this.queue.size,
      runningCount: this.running,
      held: this.held,
      summarizeOn: this.summarizeOn,
      skippedCount: this.skipped,
      watching: !!this.watcher,
      lastFullSummarySyncStartedAt: summarySync.lastFullSummarySyncStartedAt,
      lastFullSummarySyncCompletedAt: summarySync.lastFullSummarySyncCompletedAt,
      lastFullSummarySyncModel: summarySync.lastFullSummarySyncModel,
      lastFullSummarySyncError: summarySync.lastFullSummarySyncError,
    };
  }

  async setLlmSyncEnabled(enabled: boolean): Promise<void> {
    this.llmSyncEnabled = enabled;
    await this.memory.setSummarySyncEnabled(enabled);
  }

  async refreshAllSummaries(): Promise<void> {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    const run = (async () => {
      this.llmSyncEnabled = true;
      await this.memory.markFullSummarySyncStarted(this.modelSlug);
      try {
        const candidates = this.memory.list().map((entry) => entry.path);
        this.enqueuePaths(candidates);
        // An explicit full refresh is a direct request, so it runs now rather
        // than waiting for a run to end.
        await this.flush();
        await this.memory.markFullSummarySyncCompleted(this.modelSlug);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.memory.markFullSummarySyncFailed(text, this.modelSlug);
        throw error;
      }
    })().finally(() => {
      if (this.refreshAllPromise === run) this.refreshAllPromise = undefined;
    });
    this.refreshAllPromise = run;
    return run;
  }

  async onExternalFileChange(filePath: string): Promise<void> {
    if (this.disposed || this.shouldIgnore(filePath)) return;
    const changed = await this.memory.refreshPathMetadata(filePath, { source: "refresh" });
    if (changed) void this.memory.scheduleSave().catch(() => undefined);
    if (!this.llmSyncEnabled) return;
    // Same as `noteFilesWritten`: queue it, do not pre-declare that it needs a
    // summary. A watcher fires on touches that change nothing — a save with no
    // edit, a formatter that produced identical bytes, an mtime bump from a
    // checkout — and `processPath` compares hashes rather than trusting the event.
    this.enqueuePaths([filePath]);
  }

  private startWatcher(): void {
    if (this.watcher || this.disposed) return;
    try {
      this.watcher = watch(
        this.cwd,
        { recursive: process.platform === "darwin" || process.platform === "win32" },
        (_eventType, filename) => {
          if (!filename) return;
          const rel = String(filename);
          const absPath = path.join(this.cwd, rel);
          if (this.shouldIgnore(absPath)) return;
          const prior = this.debounceTimers.get(absPath);
          if (prior) clearTimeout(prior);
          const timer = setTimeout(async () => {
            this.debounceTimers.delete(absPath);
            await this.onExternalFileChange(absPath);
          }, 400);
          this.debounceTimers.set(absPath, timer);
        },
      );
    } catch {
      this.watcher = undefined;
    }
  }

  private pump(): void {
    // Held: paths stay in the queue and nothing reaches the network. `drain()`
    // must still settle, or a `flush()` that finds nothing to do never resolves.
    if (this.held) {
      // Settle waiters as soon as nothing is IN FLIGHT, even with paths still
      // queued: while held those paths are not going to run, so a `drain()` that
      // waited for an empty queue would wait forever.
      if (this.running === 0) {
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
      return;
    }
    while (!this.disposed && this.running < this.concurrency && this.queue.size > 0) {
      const [next] = this.queue;
      if (!next) break;
      this.queue.delete(next);
      this.running += 1;
      void this.processPath(next).finally(() => {
        this.running -= 1;
        this.pump();
        if (!this.queue.size && this.running === 0) {
          for (const resolve of this.idleResolvers.splice(0)) resolve();
        }
      });
    }
  }

  private async processPath(filePath: string): Promise<void> {
    if (!this.llmSyncEnabled) return;
    // ALWAYS re-read the metadata first, existing entry or not. This is a stat, a
    // hash and the parser pass — no model, no network — and it is what makes the
    // decision below about the file as it is NOW rather than as it was when
    // something last happened to notice it. Skipping it for known entries meant
    // the stored hash could be older than the write that queued this path, so
    // "has it changed?" was being asked of stale metadata.
    const changed = await this.memory.refreshPathMetadata(filePath, { source: "refresh" });
    const entry = this.memory.get(filePath);
    if (!entry) return;
    if (changed) void this.memory.scheduleSave().catch(() => undefined);
    // The whole point: a file with a current summary is not summarized again.
    if (!this.memory.needsSummaryHydration(filePath)) {
      this.skipped += 1;
      return;
    }
    if (this.memory.setSummaryPending(filePath, true)) {
      void this.memory.scheduleSave().catch(() => undefined);
    }
    const input = await this.memory.readSummaryInput(filePath);
    if (!input) {
      if (this.memory.setSummaryPending(filePath, false, "summary input unavailable")) {
        void this.memory.scheduleSave().catch(() => undefined);
      }
      return;
    }
    try {
      const result = await summarizeFileWithLlm({
        llm: this.llm,
        modelSlug: this.modelSlug,
        cwd: this.cwd,
        filePath: input.entry.path,
        relativePath: input.entry.relativePath,
        role: input.entry.role,
        tags: input.entry.tags,
        language: input.entry.language,
        frameworkHints: input.entry.frameworkHints,
        keySymbols: input.entry.keySymbols,
        dependencies: input.entry.dependencies,
        routes: input.entry.routes,
        interfaces: input.entry.interfaces,
        responsibilities: input.entry.responsibilities,
        text: input.text,
      });
      await this.memory.applyLlmSummary(
        filePath,
        {
          summary: result.summary,
          keywords: result.keywords,
          keySymbols: result.keySymbols,
          dependencies: result.dependencies,
          routes: result.routes,
          interfaces: result.interfaces,
          responsibilities: result.responsibilities,
          frameworkHints: result.frameworkHints,
          language: result.language,
          model: result.model,
        },
        { source: "refresh", save: "defer" },
      );
    } catch (error) {
      await this.memory.recordSummaryFailure(filePath, summarizeError(error, input.entry), { save: "defer" });
    }
  }

  private shouldIgnore(filePath: string): boolean {
    const relative = path.relative(this.cwd, filePath);
    if (!relative || relative.startsWith("..")) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((part) => FILE_MEMORY_IGNORED_DIRS.has(part))) return true;
    for (const [root, ignoredNames] of FILE_MEMORY_IGNORED_DIRS_BY_ROOT) {
      if (parts.includes(root) && [...ignoredNames].some((name) => parts.includes(name))) return true;
    }
    return false;
  }
}

function summarizeError(error: unknown, entry: FileMemoryEntry): string {
  const text = error instanceof Error ? error.message : String(error);
  return `${entry.relativePath}: ${text}`.slice(0, 300);
}

function defaultConcurrency(): number {
  const cpuCount = availableParallelism();
  return Math.max(1, Math.min(4, Math.floor(cpuCount / 4) || 1));
}
