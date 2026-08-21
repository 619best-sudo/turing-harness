import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";

import type { FileMemoryRuntime } from "./file-memory-runtime.js";
import { FILE_MEMORY_IGNORED_DIRS, FILE_MEMORY_IGNORED_DIRS_BY_ROOT } from "./file-memory.js";
import { type GraphMemory } from "./graph-memory.js";


export interface ProjectWatcherRuntimeOptions {
  cwd: string;
}

interface ProjectWatcherSubscriber {
  fileMemoryRuntime?: FileMemoryRuntime;
  graphMemory?: GraphMemory;
  graphDebounceTimer?: ReturnType<typeof setTimeout>;
  graphPendingPaths: Set<string>;
  graphRefreshPromise?: Promise<void>;
  suspendedDepth: number;
  suspendedPaths: Set<string>;
}

export class ProjectWatcherRuntime {
  readonly cwd: string;

  private watcher?: FSWatcher;
  private disposed = false;
  private readonly subscribers = new Map<string, ProjectWatcherSubscriber>();
  private readonly fileDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ProjectWatcherRuntimeOptions) {
    this.cwd = opts.cwd;
    this.startWatcher();
  }

  subscribe(
    id: string,
    input: {
      fileMemoryRuntime?: FileMemoryRuntime;
      graphMemory?: GraphMemory;
    },
  ): void {
    if (this.disposed) return;
    this.subscribers.set(id, {
      fileMemoryRuntime: input.fileMemoryRuntime,
      graphMemory: input.graphMemory,
      graphPendingPaths: new Set<string>(),
      suspendedDepth: 0,
      suspendedPaths: new Set<string>(),
    });
  }

  suspend(id: string): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber || this.disposed) return;
    subscriber.suspendedDepth += 1;
  }

  async resume(id: string): Promise<void> {
    const subscriber = this.subscribers.get(id);
    if (!subscriber || this.disposed) return;
    if (subscriber.suspendedDepth > 0) subscriber.suspendedDepth -= 1;
    if (subscriber.suspendedDepth > 0 || subscriber.suspendedPaths.size === 0) return;
    const pendingPaths = [...subscriber.suspendedPaths];
    subscriber.suspendedPaths.clear();
    await this.flushSubscriberChanges(subscriber, pendingPaths);
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    if (subscriber.graphDebounceTimer) clearTimeout(subscriber.graphDebounceTimer);
    subscriber.graphPendingPaths.clear();
    subscriber.suspendedPaths.clear();
    this.subscribers.delete(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const timer of this.fileDebounceTimers.values()) clearTimeout(timer);
    this.fileDebounceTimers.clear();
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.graphDebounceTimer) clearTimeout(subscriber.graphDebounceTimer);
      subscriber.graphPendingPaths.clear();
      subscriber.suspendedPaths.clear();
      await subscriber.graphRefreshPromise?.catch(() => undefined);
    }
    this.subscribers.clear();
  }

  private startWatcher(): void {
    if (this.watcher || this.disposed) return;
    try {
      this.watcher = watch(
        this.cwd,
        { recursive: process.platform === "darwin" || process.platform === "win32" },
        (_eventType, filename) => {
          if (!filename) return;
          const absPath = path.join(this.cwd, String(filename));
          const prior = this.fileDebounceTimers.get(absPath);
          if (prior) clearTimeout(prior);
          const timer = setTimeout(() => {
            this.fileDebounceTimers.delete(absPath);
            void this.handleFileChange(absPath);
          }, 350);
          this.fileDebounceTimers.set(absPath, timer);
        },
      );
    } catch {
      this.watcher = undefined;
    }
  }

  private async handleFileChange(absPath: string): Promise<void> {
    if (this.disposed || this.shouldIgnore(absPath)) return;
    const subscribers = [...this.subscribers.values()];
    await Promise.all(
      subscribers.map(async (subscriber) => {
        if (subscriber.suspendedDepth > 0) {
          subscriber.suspendedPaths.add(absPath);
          return;
        }
        await this.flushSubscriberChanges(subscriber, [absPath]);
      }),
    );
  }

  private async flushSubscriberChanges(subscriber: ProjectWatcherSubscriber, paths: string[]): Promise<void> {
    const uniquePaths = [...new Set(paths)].filter((entry) => !this.shouldIgnore(entry));
    if (uniquePaths.length === 0 || this.disposed) return;
    await Promise.all(uniquePaths.map(async (absPath) => subscriber.fileMemoryRuntime?.onExternalFileChange(absPath)));
    for (const absPath of uniquePaths) this.scheduleGraphRefresh(subscriber, absPath);
  }

  private scheduleGraphRefresh(subscriber: ProjectWatcherSubscriber, absPath: string): void {
    if (!subscriber.graphMemory) return;
    if (subscriber.graphMemory.getFileNode(absPath)) {
      subscriber.graphMemory.markStale(absPath, "filesystem changed");
    }
    subscriber.graphPendingPaths.add(absPath);
    if (subscriber.graphDebounceTimer) clearTimeout(subscriber.graphDebounceTimer);
    subscriber.graphDebounceTimer = setTimeout(() => {
      const pendingPaths = [...subscriber.graphPendingPaths];
      subscriber.graphPendingPaths.clear();
      subscriber.graphDebounceTimer = undefined;
      const run = async () => {
        if (!subscriber.graphMemory || this.disposed || pendingPaths.length === 0) return;
        await subscriber.graphMemory.refreshMany(pendingPaths);
        await subscriber.graphMemory.save();
      };
      const prior = subscriber.graphRefreshPromise ?? Promise.resolve();
      subscriber.graphRefreshPromise = prior.catch(() => undefined).then(run);
    }, 250);
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
