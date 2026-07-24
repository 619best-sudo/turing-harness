import { watch, type FSWatcher } from "node:fs";
import { availableParallelism } from "node:os";
import * as path from "node:path";

import type { LLMBridge } from "../types.js";
import { FILE_MEMORY_IGNORED_DIRS, type FileMemory, type FileMemoryEntry } from "./file-memory.js";
import { DEFAULT_FILE_SUMMARIZER_MODEL, summarizeFileWithLlm } from "./file-summary-llm.js";

const MOBILE_ARTIFACT_DIRS_BY_ROOT = new Map<string, Set<string>>([
  ["android", new Set([".cxx", ".gradle", "build"])],
  ["ios", new Set([".symlinks", "Flutter", "Pods", "build", "xcuserdata"])],
]);

export interface FileMemoryRuntimeOptions {
  cwd: string;
  llm: LLMBridge;
  memory: FileMemory;
  modelSlug?: string;
  concurrency?: number;
  watch?: boolean;
  autoStartHydration?: boolean;
  llmSyncEnabled?: boolean;
}

export interface FileMemoryRuntimeStatus {
  llmSyncEnabled: boolean;
  isRefreshing: boolean;
  queuedCount: number;
  runningCount: number;
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

  private watcher?: FSWatcher;
  private readonly queue = new Set<string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = 0;
  private started = false;
  private disposed = false;
  private llmSyncEnabled: boolean;
  private refreshAllPromise?: Promise<void>;
  private idleResolvers: Array<() => void> = [];

  constructor(opts: FileMemoryRuntimeOptions) {
    this.cwd = opts.cwd;
    this.memory = opts.memory;
    this.llm = opts.llm;
    this.modelSlug = opts.modelSlug ?? DEFAULT_FILE_SUMMARIZER_MODEL;
    this.concurrency = Math.max(1, Math.min(4, opts.concurrency ?? defaultConcurrency()));
    this.autoStartHydration = opts.autoStartHydration ?? true;
    this.llmSyncEnabled =
      opts.llmSyncEnabled ?? (this.autoStartHydration ? true : opts.memory.summarySync.llmSyncEnabled);
    if (opts.watch !== false) this.startWatcher();
  }

  startInitialHydration(): void {
    if (this.started || this.disposed) return;
    this.started = true;
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

  async drain(): Promise<void> {
    if (!this.queue.size && this.running === 0) return;
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
    await this.drain().catch(() => undefined);
  }

  getStatus(): FileMemoryRuntimeStatus {
    const summarySync = this.memory.getSummarySyncData();
    return {
      llmSyncEnabled: this.llmSyncEnabled,
      isRefreshing: !!this.refreshAllPromise,
      queuedCount: this.queue.size,
      runningCount: this.running,
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
        await this.drain();
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
    if (this.memory.setSummaryPending(filePath, true)) {
      void this.memory.scheduleSave().catch(() => undefined);
    }
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
    const entry = this.memory.get(filePath);
    if (!entry && !(await this.memory.refreshPathMetadata(filePath, { source: "refresh" }))) {
      return;
    }
    const freshEntry = this.memory.get(filePath);
    if (!freshEntry || !this.memory.needsSummaryHydration(filePath)) {
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
    for (const [root, ignoredNames] of MOBILE_ARTIFACT_DIRS_BY_ROOT) {
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
