/**
 * Durable file-level memory and one-shot file search.
 *
 * File memory lives beside project memory in `<cwd>/.turing/`. It stores a
 * compact per-file summary, freshness metadata, and lightweight search signals
 * so the agent can ask "which file likely contains X?" in one call.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IGNORED_PROJECT_DIRS } from "../project-tree.js";
import {
  FILE_MEMORY_FRAMEWORK_HINTS,
  SUPPORTED_FILE_MEMORY_FRAMEWORKS,
  SUPPORTED_FILE_MEMORY_LANGUAGES,
  analyzeFileSemantics,
  composeSemanticSummary,
} from "./file-semantics.js";

export const FILE_MEMORY_VERSION = 1;
const DEFAULT_DIR = ".turing";
const DEFAULT_MAX_FILE_SIZE = 256 * 1024;
const MAX_RENDER_ENTRIES = 200;
export const TEXT_SAMPLE_BYTES = 16 * 1024;
export const FILE_MEMORY_SUMMARY_VERSION = 3;
export const FILE_MEMORY_IGNORED_DIRS = new Set(IGNORED_PROJECT_DIRS);
/**
 * The remaining path-DEPENDENT cases: names that are generated only beneath a
 * specific root and are legitimate source anywhere else. `ios/Flutter` holds
 * generated xcconfigs, while a `Flutter` directory elsewhere may not.
 */
export const FILE_MEMORY_IGNORED_DIRS_BY_ROOT = new Map<string, Set<string>>([
  ["android", new Set(["generated"])],
  ["ios", new Set(["Flutter"])],
]);

export const FILE_MEMORY_SUPPORTED_FRAMEWORKS = [...SUPPORTED_FILE_MEMORY_FRAMEWORKS];
export const FILE_MEMORY_SUPPORTED_LANGUAGES = [...SUPPORTED_FILE_MEMORY_LANGUAGES];

type FileRole =
  | "entrypoint"
  | "config"
  | "manifest"
  | "build"
  | "route"
  | "controller"
  | "service"
  | "model"
  | "view"
  | "component"
  | "schema"
  | "migration"
  | "engine"
  | "test"
  | "script"
  | "doc"
  | "unknown";
type FileMemorySource = "bootstrap" | "prepare" | "plan" | "perform" | "perfect" | "refresh";
export type FileSummarySource = "heuristic" | "llm";

export interface FileMemorySummarySyncData {
  llmSyncEnabled: boolean;
  lastFullSummarySyncStartedAt?: number;
  lastFullSummarySyncCompletedAt?: number;
  lastFullSummarySyncModel?: string;
  lastFullSummarySyncError?: string;
}

export interface FileMemoryEntry {
  path: string;
  relativePath: string;
  extension: string;
  language?: string;
  role: FileRole;
  tags: string[];
  frameworkHints: string[];
  summary: string;
  keywords: string[];
  keySymbols: string[];
  dependencies: string[];
  routes: string[];
  interfaces: string[];
  responsibilities: string[];
  summarySource: FileSummarySource;
  summaryModel?: string;
  summaryUpdatedAt?: number;
  summaryVersion?: number;
  summaryPending?: boolean;
  summaryError?: string;
  /**
   * The `contentHash` the LLM summary was written FROM.
   *
   * This is what makes "summarize only when the file changed" exact rather than
   * inferred. Without it the question is answered by a chain of proxies — a
   * metadata refresh notices new content and resets `summarySource` to
   * "heuristic", which the hydration check then reads as "needs an LLM pass" —
   * and every link in that chain has to fire, in order, for the answer to be
   * right. When a write arrives through a path that skips the refresh, the file
   * gets re-summarized on identical bytes; when the refresh runs twice, the
   * signal is consumed and a real change can be missed.
   *
   * Comparing two hashes needs no ordering and cannot be consumed. Absent on
   * entries written before this field existed: those fall back to the proxy
   * chain rather than being re-summarized wholesale.
   */
  summaryContentHash?: string;
  lastSeenAt: number;
  lastModifiedMs: number;
  size: number;
  contentHash: string;
  stale: boolean;
  staleReason?: string;
  source: FileMemorySource;
}

export interface FileMemoryData {
  version: number;
  createdAt: number;
  updatedAt: number;
  summarySync: FileMemorySummarySyncData;
  files: Record<string, FileMemoryEntry>;
}

export interface FileMemoryOptions {
  dir?: string;
  forceReindex?: boolean;
  maxFileSize?: number;
}

export interface FileSearchResult {
  path: string;
  relativePath: string;
  summary: string;
  keywords: string[];
  keySymbols: string[];
  dependencies: string[];
  routes: string[];
  role: FileRole;
  tags: string[];
  language?: string;
  frameworkHints: string[];
  score: number;
  fresh: boolean;
  reasons: string[];
}

export interface FileMemoryStats {
  totalFiles: number;
  staleFiles: number;
  createdAt: number;
  updatedAt: number;
}

interface FileSearchScore extends FileSearchResult {
  exactScore: number;
  fuzzyScore: number;
}

interface FileSearchIndexEntry {
  entry: FileMemoryEntry;
  basename: string;
  lowerPath: string;
  lowerSummary: string;
  lowerKeywords: string;
  basenameTokens: string[];
  pathTokens: string[];
  summaryTokens: string[];
  metadataTokens: string[];
}

interface ScheduledSave {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const STRONG_EXACT_MATCH_SCORE = 30;

export class FileMemory {
  readonly cwd: string;
  readonly dir: string;
  readonly file: string;
  readonly markdownFile: string;
  readonly maxFileSize: number;
  private _data!: FileMemoryData;
  private _created = false;
  private _dirty = false;
  private _dataVersion = 0;
  private _searchIndexVersion = -1;
  private _searchIndex: FileSearchIndexEntry[] = [];
  private readonly _searchCache = new Map<string, { version: number; results: FileSearchResult[] }>();
  private _saveInFlight: Promise<void> = Promise.resolve();
  private _saveTimer?: ReturnType<typeof setTimeout>;
  private _scheduledSave?: ScheduledSave;

  private constructor(cwd: string, dir: string, maxFileSize: number) {
    this.cwd = cwd;
    this.dir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    this.file = path.join(this.dir, "files.json");
    this.markdownFile = path.join(this.dir, "FILES_MEMORY.md");
    this.maxFileSize = maxFileSize;
  }

  static async open(cwd: string, opts: FileMemoryOptions = {}): Promise<FileMemory> {
    const mem = new FileMemory(cwd, opts.dir ?? DEFAULT_DIR, opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
    const existing = await mem.readData();
    if (existing) {
      mem._data = migrate(existing);
      if (opts.forceReindex) {
        await mem.indexProject({ source: "refresh", full: true });
      } else {
        await mem.removeMissingEntries();
        await mem.markChangedEntriesStale();
      }
      await mem.save();
      return mem;
    }
    const now = Date.now();
    mem._data = {
      version: FILE_MEMORY_VERSION,
      createdAt: now,
      updatedAt: now,
      summarySync: defaultSummarySyncData(),
      files: {},
    };
    mem._created = true;
    mem.markDirty();
    await mem.indexProject({ source: "bootstrap", full: true });
    await mem.save();
    return mem;
  }

  get wasCreated(): boolean {
    return this._created;
  }

  get data(): FileMemoryData {
    return this._data;
  }

  get summarySync(): FileMemorySummarySyncData {
    return this._data.summarySync;
  }

  get(pathOrRelative: string): FileMemoryEntry | undefined {
    const absPath = this.resolvePath(pathOrRelative);
    return this._data.files[absPath];
  }

  list(query?: { stale?: boolean; role?: FileRole; tag?: string }): FileMemoryEntry[] {
    let entries = Object.values(this._data.files);
    if (query?.stale != null) entries = entries.filter((entry) => entry.stale === query.stale);
    if (query?.role) entries = entries.filter((entry) => entry.role === query.role);
    if (query?.tag) entries = entries.filter((entry) => entry.tags.includes(query.tag!));
    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  stats(): FileMemoryStats {
    const entries = Object.values(this._data.files);
    return {
      totalFiles: entries.length,
      staleFiles: entries.filter((entry) => entry.stale).length,
      createdAt: this._data.createdAt,
      updatedAt: this._data.updatedAt,
    };
  }

  getSummarySyncData(): FileMemorySummarySyncData {
    return { ...this._data.summarySync };
  }

  async setSummarySyncEnabled(enabled: boolean, opts: { save?: boolean } = {}): Promise<void> {
    this._data.summarySync.llmSyncEnabled = enabled;
    this._data.summarySync.lastFullSummarySyncError = undefined;
    this.markDirty();
    if (opts.save !== false) await this.save();
  }

  async markFullSummarySyncStarted(model?: string, opts: { save?: boolean } = {}): Promise<void> {
    this._data.summarySync.llmSyncEnabled = true;
    this._data.summarySync.lastFullSummarySyncStartedAt = Date.now();
    this._data.summarySync.lastFullSummarySyncError = undefined;
    if (model) this._data.summarySync.lastFullSummarySyncModel = model;
    this.markDirty();
    if (opts.save !== false) await this.save();
  }

  async markFullSummarySyncCompleted(model?: string, opts: { save?: boolean } = {}): Promise<void> {
    this._data.summarySync.llmSyncEnabled = true;
    this._data.summarySync.lastFullSummarySyncCompletedAt = Date.now();
    this._data.summarySync.lastFullSummarySyncError = undefined;
    if (model) this._data.summarySync.lastFullSummarySyncModel = model;
    this.markDirty();
    if (opts.save !== false) await this.save();
  }

  async markFullSummarySyncFailed(error: string, model?: string, opts: { save?: boolean } = {}): Promise<void> {
    this._data.summarySync.llmSyncEnabled = true;
    this._data.summarySync.lastFullSummarySyncError = error.trim().slice(0, 500);
    if (model) this._data.summarySync.lastFullSummarySyncModel = model;
    this.markDirty();
    if (opts.save !== false) await this.save();
  }

  async indexProject(opts: { source?: FileMemorySource; full?: boolean } = {}): Promise<number> {
    const files = await this.walkProject(this.cwd);
    const seen = new Set<string>();
    let indexed = 0;
    for (const filePath of files) {
      seen.add(filePath);
      const changed = await this.refreshPath(filePath, { source: opts.source ?? "bootstrap", skipUnchanged: !opts.full });
      if (changed) indexed += 1;
    }
    for (const existingPath of Object.keys(this._data.files)) {
      if (!seen.has(existingPath)) {
        delete this._data.files[existingPath];
        this.markDirty();
      }
    }
    return indexed;
  }

  async refreshMany(paths: string[], opts: { source?: FileMemorySource } = {}): Promise<number> {
    let changed = 0;
    for (const p of paths) {
      if (await this.refreshPath(p, { source: opts.source ?? "refresh" })) changed += 1;
    }
    return changed;
  }

  async refreshPath(
    pathOrRelative: string,
    opts: { source?: FileMemorySource; skipUnchanged?: boolean } = {},
  ): Promise<boolean> {
    return this.refreshPathMetadata(pathOrRelative, opts);
  }

  async refreshPathMetadata(
    pathOrRelative: string,
    opts: { source?: FileMemorySource; skipUnchanged?: boolean } = {},
  ): Promise<boolean> {
    const absPath = this.resolvePath(pathOrRelative);
    const stat = await safeStat(absPath);
    if (!stat || !stat.isFile()) {
      if (this._data.files[absPath]) {
        delete this._data.files[absPath];
        this.markDirty();
        return true;
      }
      return false;
    }
    if (stat.size > this.maxFileSize) {
      if (this._data.files[absPath]) {
        delete this._data.files[absPath];
        this.markDirty();
        return true;
      }
      return false;
    }
    const prior = this._data.files[absPath];
    if (
      opts.skipUnchanged &&
      prior &&
      !prior.stale &&
      prior.lastModifiedMs === stat.mtimeMs &&
      prior.size === stat.size
    ) {
      prior.lastSeenAt = Date.now();
      return false;
    }
    const buf = await fs.readFile(absPath);
    if (!looksTextLike(buf)) return false;
    const hash = hashContent(buf);
    if (
      opts.skipUnchanged &&
      prior &&
      !prior.stale &&
      prior.lastModifiedMs !== stat.mtimeMs &&
      prior.size === stat.size &&
      prior.contentHash === hash
    ) {
      prior.lastSeenAt = Date.now();
      prior.lastModifiedMs = stat.mtimeMs;
      return false;
    }
    const relativePath = path.relative(this.cwd, absPath) || path.basename(absPath);
    const text = buf.toString("utf8", 0, Math.min(buf.length, TEXT_SAMPLE_BYTES));
    const role = inferRole(relativePath);
    const baseTags = inferTags(relativePath, role, text);
    const semantic = analyzeFileSemantics(relativePath, text, role, baseTags);
    const tags = dedupeStrings([
      ...baseTags,
      ...(semantic.language ? [semantic.language] : []),
      ...semantic.frameworks,
    ]);
    const summary = composeSemanticSummary(relativePath, summarizeFile(relativePath, role, text), semantic);
    const keywords = dedupeStrings([
      ...inferKeywords(relativePath, role, tags, text),
      ...semantic.keywords,
    ]).slice(0, 24);
    const changedContent = !prior || prior.contentHash !== hash;
    const now = Date.now();
    this._data.files[absPath] = {
      path: absPath,
      relativePath,
      extension: normalizeExt(path.extname(absPath)),
      language: semantic.language ?? prior?.language,
      role,
      tags,
      frameworkHints: semantic.frameworks,
      summary,
      keywords: changedContent ? keywords : prior?.keywords ?? keywords,
      keySymbols: semantic.keySymbols,
      dependencies: semantic.dependencies,
      routes: semantic.routes,
      interfaces: semantic.interfaces,
      responsibilities: semantic.responsibilities,
      summarySource: changedContent ? "heuristic" : prior?.summarySource ?? "heuristic",
      summaryModel: changedContent ? undefined : prior?.summaryModel,
      summaryUpdatedAt: changedContent ? now : prior?.summaryUpdatedAt,
      summaryVersion: FILE_MEMORY_SUMMARY_VERSION,
      summaryPending: changedContent ? prior?.summarySource === "llm" || !!prior?.summaryPending : prior?.summaryPending ?? false,
      summaryError: changedContent ? undefined : prior?.summaryError,
      // Carried across a refresh either way: on unchanged content it still
      // describes the live bytes, and on changed content keeping it is how the
      // skip check can see that the summary predates the edit.
      summaryContentHash: prior?.summaryContentHash,
      lastSeenAt: now,
      lastModifiedMs: stat.mtimeMs,
      size: stat.size,
      contentHash: hash,
      stale: false,
      staleReason: undefined,
      source: opts.source ?? "refresh",
    };
    this.markDirty();
    return true;
  }

  /**
   * Does this file need an LLM summary written for it?
   *
   * The three answers, in order: no summary yet ⇒ yes; a summary for THESE bytes
   * ⇒ no; a summary for older bytes ⇒ yes. Everything else here is bookkeeping —
   * a queued/in-flight marker, a stale flag, a failed attempt, a schema version
   * bump — and each of those means the stored summary cannot be trusted as it
   * stands.
   */
  needsSummaryHydration(pathOrRelative: string): boolean {
    const entry = this.get(pathOrRelative);
    if (!entry) return false;
    if (entry.summarySource !== "llm") return true;
    if (entry.summaryVersion !== FILE_MEMORY_SUMMARY_VERSION) return true;
    if (entry.summaryPending === true || !!entry.summaryError || entry.stale === true) return true;
    // The exact test, when the entry is new enough to carry it: same bytes, same
    // summary, nothing to do — no matter how the file arrived here.
    if (entry.summaryContentHash) return entry.summaryContentHash !== entry.contentHash;
    return false;
  }

  listSummaryHydrationCandidates(query?: { includeFresh?: boolean }): FileMemoryEntry[] {
    return this.list().filter((entry) => query?.includeFresh || this.needsSummaryHydration(entry.path));
  }

  setSummaryPending(pathOrRelative: string, pending = true, error?: string): boolean {
    const entry = this.get(pathOrRelative);
    if (!entry) return false;
    if (entry.summaryPending === pending && entry.summaryError === error) return false;
    entry.summaryPending = pending;
    if (pending) {
      entry.summaryError = error;
    } else if (error !== undefined) {
      entry.summaryError = error;
    }
    entry.lastSeenAt = Date.now();
    this.markDirty();
    return true;
  }

  async applyLlmSummary(
    pathOrRelative: string,
    result: {
      summary: string;
      keywords: string[];
      model: string;
      keySymbols?: string[];
      dependencies?: string[];
      routes?: string[];
      interfaces?: string[];
      responsibilities?: string[];
      frameworkHints?: string[];
      language?: string;
    },
    opts: { source?: FileMemorySource; save?: "immediate" | "defer" | false } = {},
  ): Promise<FileMemoryEntry | undefined> {
    const entry = this.get(pathOrRelative);
    if (!entry) return undefined;
    entry.summary = cleanSummary(result.summary, { maxWords: 180 });
    entry.keywords = dedupeStrings(result.keywords);
    entry.keySymbols = dedupeStrings(result.keySymbols ?? entry.keySymbols ?? []);
    entry.dependencies = dedupeStrings(result.dependencies ?? entry.dependencies ?? []);
    entry.routes = dedupeStrings(result.routes ?? entry.routes ?? []);
    entry.interfaces = dedupeStrings(result.interfaces ?? entry.interfaces ?? []);
    entry.responsibilities = dedupeStrings(result.responsibilities ?? entry.responsibilities ?? []);
    entry.frameworkHints = dedupeStrings(result.frameworkHints ?? entry.frameworkHints ?? []);
    entry.language = result.language ?? entry.language;
    entry.tags = dedupeStrings([
      ...entry.tags,
      ...(entry.language ? [entry.language] : []),
      ...entry.frameworkHints,
    ]);
    entry.summarySource = "llm";
    entry.summaryContentHash = entry.contentHash;
    entry.summaryModel = result.model;
    entry.summaryUpdatedAt = Date.now();
    entry.summaryVersion = FILE_MEMORY_SUMMARY_VERSION;
    entry.summaryPending = false;
    entry.summaryError = undefined;
    entry.source = opts.source ?? entry.source;
    entry.stale = false;
    entry.staleReason = undefined;
    entry.lastSeenAt = Date.now();
    this.markDirty();
    if (opts.save === "defer") void this.scheduleSave().catch(() => undefined);
    else if (opts.save !== false) await this.save();
    return entry;
  }

  async recordSummaryFailure(
    pathOrRelative: string,
    error: string,
    opts: { save?: "immediate" | "defer" | false } = {},
  ): Promise<void> {
    const entry = this.get(pathOrRelative);
    if (!entry) return;
    entry.summaryPending = false;
    entry.summaryError = error.trim();
    entry.lastSeenAt = Date.now();
    this.markDirty();
    if (opts.save === "defer") void this.scheduleSave().catch(() => undefined);
    else if (opts.save !== false) await this.save();
  }

  async readSummaryInput(pathOrRelative: string): Promise<{ entry: FileMemoryEntry; text: string } | undefined> {
    const absPath = this.resolvePath(pathOrRelative);
    const entry = this.get(absPath);
    const stat = await safeStat(absPath);
    if (!entry || !stat?.isFile() || stat.size > this.maxFileSize) return undefined;
    const buf = await fs.readFile(absPath).catch(() => undefined);
    if (!buf || !looksTextLike(buf)) return undefined;
    return { entry, text: buf.toString("utf8", 0, Math.min(buf.length, this.maxFileSize)) };
  }

  markStale(pathOrRelative: string, reason: string): void {
    const absPath = this.resolvePath(pathOrRelative);
    const existing = this._data.files[absPath];
    if (!existing) return;
    existing.stale = true;
    existing.staleReason = reason;
    existing.lastSeenAt = Date.now();
    this.markDirty();
  }

  async remember(
    pathOrRelative: string,
    summary: string,
    opts: { tags?: string[]; role?: FileRole; source?: FileMemorySource } = {},
  ): Promise<FileMemoryEntry> {
    const absPath = this.resolvePath(pathOrRelative);
    const current = this._data.files[absPath];
    if (current) {
      current.summary = summary.trim();
      current.tags = dedupeStrings([...(opts.tags ?? []), ...current.tags]);
      current.role = opts.role ?? current.role;
      current.source = opts.source ?? current.source;
      current.keywords = dedupeStrings([...current.keywords, ...keywordize(summary), ...(opts.tags ?? [])]);
      current.frameworkHints = dedupeStrings([...(current.frameworkHints ?? []), ...(opts.tags ?? [])]);
      current.interfaces = dedupeStrings([...(current.interfaces ?? []), summary]);
      current.responsibilities = dedupeStrings([...(current.responsibilities ?? []), "manual summary"]);
      current.summarySource = "heuristic";
      current.summaryVersion = FILE_MEMORY_SUMMARY_VERSION;
      current.summaryUpdatedAt = Date.now();
      current.summaryPending = false;
      current.summaryError = undefined;
      current.stale = false;
      current.staleReason = undefined;
      current.lastSeenAt = Date.now();
      this.markDirty();
      await this.save();
      return current;
    }
    await this.refreshPath(absPath, { source: opts.source ?? "refresh" });
    const created = this._data.files[absPath];
    if (!created) {
      const now = Date.now();
      const relativePath = path.relative(this.cwd, absPath) || path.basename(absPath);
      this._data.files[absPath] = {
        path: absPath,
        relativePath,
        extension: normalizeExt(path.extname(absPath)),
        language: undefined,
        role: opts.role ?? inferRole(relativePath),
        tags: dedupeStrings(opts.tags ?? []),
        frameworkHints: dedupeStrings(opts.tags ?? []),
        summary: summary.trim(),
        keywords: dedupeStrings([...keywordize(summary), ...(opts.tags ?? [])]),
        keySymbols: [],
        dependencies: [],
        routes: [],
        interfaces: [summary.trim()],
        responsibilities: ["manual summary"],
        summarySource: "heuristic",
        summaryModel: undefined,
        summaryUpdatedAt: now,
        summaryVersion: FILE_MEMORY_SUMMARY_VERSION,
        summaryPending: false,
        summaryError: undefined,
        lastSeenAt: now,
        lastModifiedMs: 0,
        size: 0,
        contentHash: "",
        stale: false,
        staleReason: undefined,
        source: opts.source ?? "refresh",
      };
    } else {
      created.summary = summary.trim();
      created.tags = dedupeStrings([...(opts.tags ?? []), ...created.tags]);
      created.role = opts.role ?? created.role;
      created.source = opts.source ?? created.source;
      created.keywords = dedupeStrings([...created.keywords, ...keywordize(summary), ...(opts.tags ?? [])]);
      created.frameworkHints = dedupeStrings([...(created.frameworkHints ?? []), ...(opts.tags ?? [])]);
      created.interfaces = dedupeStrings([...(created.interfaces ?? []), summary]);
      created.responsibilities = dedupeStrings([...(created.responsibilities ?? []), "manual summary"]);
      created.summarySource = "heuristic";
      created.summaryVersion = FILE_MEMORY_SUMMARY_VERSION;
      created.summaryUpdatedAt = Date.now();
      created.summaryPending = false;
      created.summaryError = undefined;
      created.stale = false;
      created.staleReason = undefined;
      created.lastSeenAt = Date.now();
    }
    this.markDirty();
    await this.save();
    return this._data.files[absPath];
  }

  search(
    query: string,
    opts: { limit?: number; extensions?: string[]; tags?: string[] } = {},
  ): FileSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    const terms = tokenize(normalizedQuery);
    if (!normalizedQuery) return [];
    const limit = Math.max(1, opts.limit ?? 10);
    const allowedExts = new Set((opts.extensions ?? []).map((ext) => normalizeExt(ext)));
    const allowedTags = new Set((opts.tags ?? []).map((tag) => tag.toLowerCase()));
    const cacheKey = JSON.stringify({
      query: normalizedQuery,
      limit,
      extensions: [...allowedExts].sort(),
      tags: [...allowedTags].sort(),
    });
    const cached = this._searchCache.get(cacheKey);
    if (cached?.version === this._dataVersion) return cached.results;
    const scoredEntries: FileSearchScore[] = [];
    let topExactScore = 0;
    for (const indexed of this.buildSearchIndex()) {
      const entry = indexed.entry;
      if (allowedExts.size && !allowedExts.has(entry.extension)) continue;
      if (allowedTags.size && !entry.tags.some((tag) => allowedTags.has(tag))) continue;
      const scored = scoreEntry(indexed, normalizedQuery, terms);
      if (scored.exactScore <= 0 && scored.fuzzyScore <= 0) continue;
      topExactScore = Math.max(topExactScore, scored.exactScore);
      scoredEntries.push(scored);
    }
    const allowFuzzyFallback = topExactScore < STRONG_EXACT_MATCH_SCORE;
    const results = scoredEntries
      .map((entry) => ({
        path: entry.path,
        relativePath: entry.relativePath,
        summary: entry.summary,
        keywords: entry.keywords,
        keySymbols: entry.keySymbols,
        dependencies: entry.dependencies,
        routes: entry.routes,
        role: entry.role,
        tags: entry.tags,
        language: entry.language,
        frameworkHints: entry.frameworkHints,
        fresh: entry.fresh,
        reasons: allowFuzzyFallback ? entry.reasons : entry.reasons.filter((reason) => !reason.startsWith("fuzzy ")),
        score: entry.exactScore + (allowFuzzyFallback ? entry.fuzzyScore : 0),
      }))
      .filter((entry) => entry.score > 0);
    const finalResults = results
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, limit);
    if (this._searchCache.size >= 64) {
      const firstKey = this._searchCache.keys().next().value;
      if (firstKey) this._searchCache.delete(firstKey);
    }
    this._searchCache.set(cacheKey, { version: this._dataVersion, results: finalResults });
    return finalResults;
  }

  async removeMissingEntries(): Promise<number> {
    let removed = 0;
    for (const existingPath of Object.keys(this._data.files)) {
      const stat = await safeStat(existingPath);
      if (!stat || !stat.isFile()) {
        delete this._data.files[existingPath];
        this.markDirty();
        removed += 1;
      }
    }
    return removed;
  }

  async markChangedEntriesStale(): Promise<number> {
    let changed = 0;
    for (const entry of Object.values(this._data.files)) {
      const stat = await safeStat(entry.path);
      if (!stat || !stat.isFile()) continue;
      if (stat.mtimeMs !== entry.lastModifiedMs || stat.size !== entry.size) {
        entry.stale = true;
        entry.staleReason = "filesystem changed";
        entry.summaryPending = true;
        entry.lastSeenAt = Date.now();
        this.markDirty();
        changed += 1;
      }
    }
    return changed;
  }

  async save(): Promise<void> {
    const scheduled = this.cancelScheduledSave();
    const savePromise = this.runSave(async () => {
      if (!this._dirty) return;
      this._dirty = false;
      await fs.mkdir(this.dir, { recursive: true });
      const payload = JSON.stringify(this._data, null, 2);
      const rendered = this.render();
      await Promise.all([
        fs.writeFile(this.file, payload, "utf8"),
        fs.writeFile(this.markdownFile, rendered, "utf8"),
      ]);
    });
    if (scheduled) savePromise.then(scheduled.resolve, scheduled.reject);
    await savePromise;
  }

  async scheduleSave(delayMs = 75): Promise<void> {
    if (!this._dirty) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    const scheduled = this.ensureScheduledSave();
    this._saveTimer = setTimeout(() => {
      const current = this._scheduledSave;
      this._saveTimer = undefined;
      this._scheduledSave = undefined;
      const savePromise = this.runSave(async () => {
        if (!this._dirty) return;
        this._dirty = false;
        await fs.mkdir(this.dir, { recursive: true });
        const payload = JSON.stringify(this._data, null, 2);
        const rendered = this.render();
        await Promise.all([
          fs.writeFile(this.file, payload, "utf8"),
          fs.writeFile(this.markdownFile, rendered, "utf8"),
        ]);
      });
      savePromise.then(current?.resolve, current?.reject);
    }, delayMs);
    await scheduled.promise;
  }

  render(): string {
    const entries = Object.values(this._data.files).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const lines: string[] = [
      "# File memory",
      "",
      `- **Indexed files:** ${entries.length}`,
      `- **Stale files:** ${entries.filter((entry) => entry.stale).length}`,
      `- **LLM sync enabled:** ${this._data.summarySync.llmSyncEnabled ? "yes" : "no"}`,
      `- **Last full LLM sync:** ${formatSummarySyncTime(this._data.summarySync.lastFullSummarySyncCompletedAt)}`,
      "",
      "## Files",
      "",
    ];
    for (const entry of entries.slice(0, MAX_RENDER_ENTRIES)) {
      const freshness = entry.stale ? ` [stale${entry.staleReason ? `: ${entry.staleReason}` : ""}]` : "";
      const status = entry.summaryPending
        ? "pending"
        : entry.summaryError
          ? `error: ${entry.summaryError}`
          : entry.summarySource;
      const meta = [entry.role, ...entry.tags, ...entry.keywords.slice(0, 8)].filter(Boolean).join(", ");
      lines.push(`- \`${entry.relativePath}\` — ${entry.summary}${meta ? ` _(${meta})_` : ""} [${status}]${freshness}`);
    }
    if (entries.length > MAX_RENDER_ENTRIES) {
      lines.push("", `- ... ${entries.length - MAX_RENDER_ENTRIES} more files omitted`);
    }
    lines.push("");
    return lines.join("\n");
  }

  private resolvePath(pathOrRelative: string): string {
    return path.isAbsolute(pathOrRelative) ? pathOrRelative : path.join(this.cwd, pathOrRelative);
  }

  private markDirty(): void {
    this._dirty = true;
    this._data.updatedAt = Date.now();
    this._dataVersion += 1;
    this._searchCache.clear();
  }

  private buildSearchIndex(): FileSearchIndexEntry[] {
    if (this._searchIndexVersion === this._dataVersion) return this._searchIndex;
    this._searchIndex = Object.values(this._data.files).map((entry) => {
      const lowerPath = entry.relativePath.toLowerCase();
      const lowerSummary = entry.summary.toLowerCase();
      return {
        entry,
        basename: path.basename(lowerPath),
        lowerPath,
        lowerSummary,
        lowerKeywords: [
          ...entry.keywords,
          ...entry.keySymbols,
          ...entry.dependencies,
          ...entry.routes,
          ...entry.interfaces,
          ...entry.responsibilities,
          ...(entry.language ? [entry.language] : []),
          ...entry.frameworkHints,
        ].join(" "),
        basenameTokens: dedupeStrings(keywordize(path.basename(lowerPath))),
        pathTokens: dedupeStrings(keywordize(lowerPath)),
        summaryTokens: dedupeStrings(keywordize(lowerSummary)).slice(0, 24),
        metadataTokens: dedupeStrings([
          ...entry.keywords,
          ...entry.keySymbols,
          ...entry.dependencies,
          ...entry.routes,
          ...entry.interfaces,
          ...entry.responsibilities,
          ...entry.tags,
          ...entry.frameworkHints,
          entry.role,
          entry.language ?? "",
        ]),
      };
    });
    this._searchIndexVersion = this._dataVersion;
    return this._searchIndex;
  }

  private ensureScheduledSave(): ScheduledSave {
    if (this._scheduledSave) return this._scheduledSave;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this._scheduledSave = { promise, resolve, reject };
    return this._scheduledSave;
  }

  private cancelScheduledSave(): ScheduledSave | undefined {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = undefined;
    const scheduled = this._scheduledSave;
    this._scheduledSave = undefined;
    return scheduled;
  }

  private runSave(work: () => Promise<void>): Promise<void> {
    const next = this._saveInFlight.then(work);
    this._saveInFlight = next.catch(() => undefined);
    return next;
  }

  private async readData(): Promise<FileMemoryData | undefined> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      return JSON.parse(text) as FileMemoryData;
    } catch {
      return undefined;
    }
  }

  private async walkProject(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".DS_Store")) continue;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.shouldIgnoreDirectory(absPath, entry.name)) continue;
        files.push(...(await this.walkProject(absPath)));
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(absPath);
    }
    return files;
  }

  private shouldIgnoreDirectory(absPath: string, entryName: string): boolean {
    if (FILE_MEMORY_IGNORED_DIRS.has(entryName)) return true;
    const relative = path.relative(this.cwd, absPath);
    if (!relative || relative.startsWith("..")) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    for (const [root, ignoredNames] of FILE_MEMORY_IGNORED_DIRS_BY_ROOT) {
      if (parts.includes(root) && ignoredNames.has(entryName)) return true;
    }
    return false;
  }
}

function migrate(data: FileMemoryData): FileMemoryData {
  const files = Object.fromEntries(
    Object.entries(data.files ?? {}).map(([filePath, entry]) => [
      filePath,
      {
        ...entry,
        language: entry.language,
        keywords: dedupeStrings(entry.keywords ?? keywordize(entry.summary ?? "")),
        frameworkHints: dedupeStrings(entry.frameworkHints ?? []),
        keySymbols: dedupeStrings(entry.keySymbols ?? []),
        dependencies: dedupeStrings(entry.dependencies ?? []),
        routes: dedupeStrings(entry.routes ?? []),
        interfaces: dedupeStrings(entry.interfaces ?? []),
        responsibilities: dedupeStrings(entry.responsibilities ?? []),
        summarySource: entry.summarySource ?? "heuristic",
        summaryModel: entry.summaryModel,
        summaryUpdatedAt: entry.summaryUpdatedAt ?? entry.lastSeenAt ?? Date.now(),
        summaryVersion: entry.summaryVersion ?? FILE_MEMORY_SUMMARY_VERSION,
        summaryPending: entry.summaryPending ?? false,
        summaryError: entry.summaryError,
      } satisfies FileMemoryEntry,
    ]),
  );
  return {
    version: FILE_MEMORY_VERSION,
    createdAt: data.createdAt ?? Date.now(),
    updatedAt: data.updatedAt ?? Date.now(),
    summarySync: migrateSummarySync(data.summarySync),
    files,
  };
}

function defaultSummarySyncData(): FileMemorySummarySyncData {
  return {
    llmSyncEnabled: false,
    lastFullSummarySyncStartedAt: undefined,
    lastFullSummarySyncCompletedAt: undefined,
    lastFullSummarySyncModel: undefined,
    lastFullSummarySyncError: undefined,
  };
}

function migrateSummarySync(data?: Partial<FileMemorySummarySyncData>): FileMemorySummarySyncData {
  return {
    ...defaultSummarySyncData(),
    ...(data ?? {}),
    llmSyncEnabled: data?.llmSyncEnabled ?? false,
    lastFullSummarySyncStartedAt: data?.lastFullSummarySyncStartedAt,
    lastFullSummarySyncCompletedAt: data?.lastFullSummarySyncCompletedAt,
    lastFullSummarySyncModel: data?.lastFullSummarySyncModel,
    lastFullSummarySyncError: data?.lastFullSummarySyncError,
  };
}

function formatSummarySyncTime(timestamp?: number): string {
  if (!timestamp) return "never";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "never" : date.toISOString();
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function normalizeExt(ext: string): string {
  const value = ext.toLowerCase().trim();
  return value.startsWith(".") ? value : value ? `.${value}` : "";
}

function hashContent(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function looksTextLike(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 2048));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function inferRole(relativePath: string): FileRole {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  if (base === "readme.md" || lower.startsWith("docs/") || lower.endsWith(".md")) return "doc";
  if (/\b(migrations?)\b/.test(lower) || /migration/i.test(base)) return "migration";
  if (/\b(routes?|router|urls)\b/.test(lower) || lower.includes("app/routes/")) return "route";
  if (/\b(controller|controllers)\b/.test(lower)) return "controller";
  if (/\b(service|services|provider|providers)\b/.test(lower)) return "service";
  if (/\b(model|models|entity|entities|repository|repositories|store|stores)\b/.test(lower)) return "model";
  if (/\b(view|views|template|templates|screen|screens|page|pages|widget|widgets|layout|layouts)\b/.test(lower)) return "view";
  if (/\b(project\.godot|\.uproject|assets\/|projectsettings\/)\b/.test(lower)) return "engine";
  if (
    [
      "package.json",
      "tsconfig.json",
      "composer.json",
      "package.swift",
      "mix.exs",
      "build.sbt",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "deps.edn",
      "project.clj",
      "cargo.toml",
      "go.mod",
      "gemfile",
      "pubspec.yaml",
      "pyproject.toml",
      "requirements.txt",
      "stack.yaml",
      "renv.lock",
      "appsettings.json",
      "build.zig",
      "description",
      "cpanfile",
      "makefile.pl",
      "gatsby-config.js",
      "gatsby-config.ts",
    ].includes(base) ||
    base.endsWith(".csproj") ||
    base.endsWith(".sln") ||
    base.endsWith(".cabal") ||
    base.endsWith(".rockspec") ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js") ||
    base.endsWith(".config.php") ||
    base.endsWith(".toml")
  ) {
    if (/(package|composer|cargo|gem|pubspec|pyproject|requirements|go\.mod|mix\.exs|deps\.edn|project\.clj|cpanfile|description|rockspec|cabal)/.test(base)) {
      return "manifest";
    }
    if (/(build|gradle|pom|package\.swift|build\.zig|\.sln$|\.csproj$)/.test(base)) {
      return "build";
    }
    return "config";
  }
  if (/\b(test|spec)\b/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)) return "test";
  if (
    [
      "index.ts",
      "index.js",
      "main.ts",
      "main.js",
      "app.ts",
      "app.js",
      "program.cs",
      "startup.cs",
      "manage.py",
      "artisan",
      "main.go",
      "main.rs",
      "main.swift",
      "application.kt",
    ].includes(base)
  ) {
    return "entrypoint";
  }
  if (lower.includes("/scripts/") || lower.startsWith("scripts/")) return "script";
  if (/\b(schema|migration|migrations|prisma|models?|entities?|database|sql)\b/.test(lower)) return "schema";
  if (/\b(component|components)\b/.test(lower) || /\.(tsx|jsx|vue|svelte)$/.test(lower)) return "component";
  return "unknown";
}

function inferTags(relativePath: string, role: FileRole, text: string): string[] {
  const lowerPath = relativePath.toLowerCase();
  const lowerText = text.toLowerCase();
  const tags = new Set<string>([role]);
  const ext = normalizeExt(path.extname(lowerPath));
  if (ext) tags.add(ext.slice(1));
  if (lowerPath.includes("test")) tags.add("test");
  if (lowerPath.includes("config") || lowerPath.endsWith("package.json")) tags.add("config");
  if (lowerPath.includes("docs") || ext === ".md") tags.add("docs");
  const haystacks = `${lowerPath}\n${lowerText}`;
  for (const hint of FILE_MEMORY_FRAMEWORK_HINTS) {
    if (hint.patterns.some((pattern) => haystacks.includes(pattern.toLowerCase()))) tags.add(hint.framework);
  }
  const languageHints: Array<{ tag: string; patterns: string[] }> = [
    { tag: "javascript", patterns: [".js", ".jsx", "module.exports", "require("] },
    { tag: "typescript", patterns: [".ts", ".tsx", "interface ", "type "] },
    { tag: "python", patterns: [".py", "def ", "from ", "import "] },
    { tag: "go", patterns: [".go", "package ", "func "] },
    { tag: "rust", patterns: [".rs", "fn ", "impl ", "pub "] },
    { tag: "java", patterns: [".java", "package ", "public class"] },
    { tag: "kotlin", patterns: [".kt", "fun ", "data class"] },
    { tag: "ruby", patterns: [".rb", "def ", "class ", "rails"] },
    { tag: "dart", patterns: [".dart", "import 'package:", "widget"] },
    { tag: "php", patterns: ["composer.json", "<?php", "namespace "] },
    { tag: "csharp", patterns: [".csproj", "namespace ", "using system", "webapplication.createbuilder"] },
    { tag: "swift", patterns: ["package.swift", "swift-tools-version", "import swift"] },
    { tag: "scala", patterns: ["build.sbt", "object ", "scala"] },
    { tag: "elixir", patterns: ["mix.exs", "defmodule "] },
    { tag: "clojure", patterns: ["deps.edn", "project.clj", "(ns "] },
    { tag: "haskell", patterns: [".cabal", "stack.yaml", "module "] },
    { tag: "lua", patterns: [".rockspec", "local ", "require("] },
    { tag: "perl", patterns: ["cpanfile", "makefile.pl", "use strict"] },
    { tag: "r", patterns: ["renv.lock", "library(", "<-"] },
    { tag: "zig", patterns: ["build.zig", "@import"] },
  ];
  for (const hint of languageHints) {
    if (hint.patterns.some((pattern) => haystacks.includes(pattern.toLowerCase()))) tags.add(hint.tag);
  }
  if (lowerPath.includes("openrouter")) tags.add("openrouter");
  if (lowerPath.includes("mcp") || lowerText.includes("mcp")) tags.add("mcp");
  return [...tags];
}

function summarizeFile(relativePath: string, role: FileRole, text: string): string {
  const base = path.basename(relativePath);
  const comment = firstComment(text);
  const known = summarizeKnownFile(relativePath, text);
  if (known) return known;
  if (base === "package.json") {
    const summary = summarizePackageJson(text);
    if (summary) return summary;
  }
  if (base === "tsconfig.json") return "TypeScript compiler configuration.";
  if (base === "README.md") return comment || "Top-level project documentation.";
  if (role === "test") return comment || `${base} contains automated test coverage.`;
  if (role === "config") return comment || `${base} defines project/tooling configuration.`;
  if (role === "manifest") return comment || `${base} declares package metadata, dependencies, and package-level entrypoints.`;
  if (role === "build") return comment || `${base} defines build, packaging, or target-assembly behavior.`;
  if (comment) return comment;
  const domain = summarizeDomainFile(relativePath, role, text);
  if (domain) return domain;
  const exports = extractExports(text);
  if (exports.length) return `${base} defines ${exports.slice(0, 4).join(", ")}.`;
  switch (role) {
    case "entrypoint":
      return `${base} is a project entrypoint or top-level bootstrap file.`;
    case "route":
      return `${base} declares route mappings, loaders, handlers, or endpoint registration.`;
    case "controller":
      return `${base} coordinates request handling and controller behavior.`;
    case "service":
      return `${base} encapsulates shared business logic, orchestration, or integrations.`;
    case "model":
      return `${base} defines domain models, repositories, or persistence-facing structures.`;
    case "view":
      return `${base} renders screens, templates, layouts, or user-facing views.`;
    case "component":
      return `${base} defines a UI component or rendering module.`;
    case "schema":
      return `${base} defines schema, migration, or persistence structure.`;
    case "migration":
      return `${base} contains a database or storage migration step.`;
    case "engine":
      return `${base} configures or boots a game/runtime engine surface.`;
    case "script":
      return `${base} contains an executable project script.`;
    case "doc":
      return `${base} contains project documentation.`;
    default:
      return `${base} is a source file in ${path.dirname(relativePath) === "." ? "the project root" : path.dirname(relativePath)}.`;
  }
}

function summarizeDomainFile(relativePath: string, role: FileRole, text: string): string | undefined {
  const lower = relativePath.toLowerCase();
  const base = path.basename(relativePath);
  const routes = extractRouteHints(text);
  const exports = extractExports(text);
  const domainTerms = extractDomainTerms(relativePath, exports);
  if (/\b(routes?|router|urls)\b/.test(lower) || routes.length) {
    const items = routes.length ? routes : domainTerms;
    if (items.length) return `${base} defines HTTP routes for ${items.slice(0, 4).join(", ")}.`;
    return `${base} defines HTTP routes and request mappings.`;
  }
  if (/\b(controller|controllers|views)\b/.test(lower)) {
    const items = exports.length ? exports : domainTerms;
    if (items.length) return `${base} handles controller actions for ${items.slice(0, 4).join(", ")}.`;
    return `${base} handles controller actions and request/response flow.`;
  }
  if (/\b(service|services|provider|providers)\b/.test(lower)) {
    const items = exports.length ? exports : domainTerms;
    if (items.length) return `${base} provides business logic for ${items.slice(0, 4).join(", ")}.`;
    return `${base} provides shared business logic and integrations.`;
  }
  if (role === "schema" || /\b(repository|repositories|model|models|entity|entities)\b/.test(lower)) {
    if (domainTerms.length) return `${base} defines persistence structure for ${domainTerms.slice(0, 4).join(", ")}.`;
    return `${base} defines data models, schema, or persistence behavior.`;
  }
  return undefined;
}

function summarizeKnownFile(relativePath: string, text: string): string | undefined {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  if (base === "composer.json") return "Composer manifest for a PHP project; defines package metadata, scripts, and dependencies.";
  if (base === "package.swift") return "Swift Package Manager manifest describing Swift targets and dependencies.";
  if (base === "mix.exs") return "Elixir Mix project manifest; configures dependencies and build settings.";
  if (base === "build.sbt") return "sbt build definition for a Scala project.";
  if (base === "pom.xml") return "Maven build definition describing JVM modules, plugins, and dependencies.";
  if (base === "build.gradle" || base === "build.gradle.kts") return "Gradle build definition for JVM or Android targets.";
  if (base === "deps.edn" || base === "project.clj") return "Clojure project dependency and build configuration.";
  if (base === "go.mod") return "Go module manifest describing module path and dependencies.";
  if (base === "cargo.toml") return "Cargo manifest for a Rust crate or workspace.";
  if (base === "gemfile") return "Bundler manifest for a Ruby project and its gems.";
  if (base === "pubspec.yaml") return "Dart or Flutter package manifest with dependencies and app metadata.";
  if (base === "pyproject.toml") return "Python project manifest with package metadata, tooling, and dependency configuration.";
  if (base === "requirements.txt") return "Python dependency manifest listing install-time packages.";
  if (base === "stack.yaml") return "Haskell Stack project configuration and resolver definition.";
  if (base === "renv.lock") return "R environment lockfile describing pinned package versions.";
  if (base === "appsettings.json") return "ASP.NET runtime configuration and environment settings.";
  if (base === "build.zig") return "Zig build script defining targets and build steps.";
  if (base === "description" || base === "renv.lock") return "R project/package metadata and environment lock information.";
  if (base === "cpanfile" || base === "makefile.pl") return "Perl project dependency and build configuration.";
  if (base.endsWith(".csproj") || base.endsWith(".sln")) return ".NET project or solution definition.";
  if (base.endsWith(".cabal")) return "Haskell Cabal package definition.";
  if (base.endsWith(".rockspec")) return "LuaRocks package specification for a Lua project.";
  if (base === "gatsby-config.js" || base === "gatsby-config.ts") return "Gatsby site configuration and plugin wiring.";
  if (lower.includes("app/routes/")) return "Remix route module that handles loader/action and UI composition for a route segment.";
  if (lower.includes("src/routes/")) return "File-based route module for a framework using route-directory conventions.";
  if (base === "artisan") return "Laravel CLI entrypoint used for framework tasks and app commands.";
  if (base === "manage.py") return "Django management entrypoint for administrative and server commands.";
  if (base === "program.cs") return "C# application bootstrap file, commonly the .NET entrypoint.";
  if (base === "startup.cs") return "ASP.NET startup configuration for service and middleware wiring.";
  if (lower.includes("routes/web.php")) return "Laravel route definitions for web-facing HTTP endpoints.";
  if (lower.includes("config/routes.rb")) return "Ruby on Rails route definitions for controller endpoints.";
  if (lower.includes("settings.py")) return "Python project settings/configuration file, often used by Django.";
  if (lower.includes("application.properties") || lower.includes("application.yml")) return "Framework/application runtime configuration file.";
  if (text.toLowerCase().includes("laravel")) return "PHP source/config file related to a Laravel application.";
  if (text.toLowerCase().includes("symfony")) return "PHP source/config file related to a Symfony application.";
  if (text.toLowerCase().includes("phoenix")) return "Elixir source/config file related to a Phoenix application.";
  if (text.toLowerCase().includes("spring")) return "JVM source/config file related to a Spring application.";
  if (text.toLowerCase().includes("flutter")) return "Dart source/config file related to a Flutter application.";
  if (text.toLowerCase().includes("react-native")) return "JavaScript/TypeScript source file related to a React Native application.";
  return undefined;
}

function summarizePackageJson(text: string): string | undefined {
  try {
    const pkg = JSON.parse(text) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 4);
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 4);
    const bits = [
      pkg.name ? `Package manifest for ${pkg.name}` : "Package manifest",
      scripts.length ? `scripts: ${scripts.join(", ")}` : undefined,
      deps.length ? `deps: ${deps.join(", ")}` : undefined,
    ].filter(Boolean);
    return `${bits.join("; ")}.`;
  } catch {
    return undefined;
  }
}

function firstComment(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lineComment = lines.find((line) => line.startsWith("//") || line.startsWith("# "));
  if (lineComment) return cleanSummary(lineComment.replace(/^\/\/\s?/, "").replace(/^#\s?/, ""));
  const blockMatch = text.match(/\/\*\*?([\s\S]{0,400}?)\*\//);
  if (blockMatch?.[1]) {
    const cleaned = blockMatch[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
    return cleanSummary(cleaned);
  }
  return undefined;
}

function extractExports(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /export\s+class\s+([A-Za-z0-9_]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
    /export\s+interface\s+([A-Za-z0-9_]+)/g,
    /export\s+type\s+([A-Za-z0-9_]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
      if (names.size >= 6) return [...names];
    }
  }
  return [...names];
}

function inferKeywords(relativePath: string, role: FileRole, tags: string[], text: string): string[] {
  return dedupeStrings([
    ...tags,
    role,
    ...extractDomainTerms(relativePath, extractExports(text)),
    ...extractRouteHints(text),
    ...keywordize(path.basename(relativePath)),
    ...keywordize(path.dirname(relativePath)),
  ]).slice(0, 16);
}

function extractRouteHints(text: string): string[] {
  const hints = new Set<string>();
  const patterns = [
    /(?:router|app)\.(get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)["'`]/g,
    /Route::(?:get|post|put|patch|delete|resource)\(\s*["'`]([^"'`]+)["'`]/g,
    /path\(\s*["'`]([^"'`]+)["'`]/g,
    /resources?\s+:([a-zA-Z0-9_]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[2] ?? match[1];
      if (!raw) continue;
      hints.add(raw.replace(/^\/+/, "").replace(/[:{}].*$/, "").replace(/[^a-zA-Z0-9/_-]+/g, "").split("/")[0] || raw);
      if (hints.size >= 6) return [...hints];
    }
  }
  return [...hints].filter(Boolean);
}

function extractDomainTerms(relativePath: string, exports: string[]): string[] {
  const raw = [relativePath, ...exports].flatMap(keywordize);
  const stopWords = new Set([
    "src",
    "app",
    "index",
    "main",
    "routes",
    "route",
    "router",
    "controller",
    "controllers",
    "service",
    "services",
    "provider",
    "providers",
    "model",
    "models",
    "entity",
    "entities",
    "file",
    "config",
    "api",
    "http",
    "module",
    "utils",
  ]);
  return dedupeStrings(raw.filter((value) => value.length >= 3 && !stopWords.has(value))).slice(0, 8);
}

function keywordize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2);
}

export function cleanSummary(text: string, opts: { maxWords?: number } = {}): string {
  const cleaned = text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const words = cleaned.split(" ").filter(Boolean);
  const limited = opts.maxWords && words.length > opts.maxWords ? `${words.slice(0, opts.maxWords).join(" ")}` : cleaned;
  return `${limited}.`;
}

function tokenize(text: string): string[] {
  return dedupeStrings(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function scoreEntry(indexed: FileSearchIndexEntry, normalizedQuery: string, terms: string[]): FileSearchScore {
  const { entry } = indexed;
  let exactScore = 0;
  let fuzzyScore = 0;
  const reasons: string[] = [];
  if (indexed.basename === normalizedQuery || indexed.lowerPath === normalizedQuery) {
    exactScore += 120;
    reasons.push("exact filename/path match");
  }
  if (indexed.basename.includes(normalizedQuery)) {
    exactScore += 70;
    reasons.push("basename contains query");
  }
  if (indexed.lowerPath.includes(normalizedQuery)) {
    exactScore += 50;
    reasons.push("path contains query");
  }
  for (const term of terms) {
    let matchedDirectly = false;
    if (indexed.basename === term) {
      exactScore += 35;
      reasons.push(`basename matches "${term}"`);
      matchedDirectly = true;
    }
    if (indexed.basename.includes(term)) {
      exactScore += 22;
      reasons.push(`basename contains "${term}"`);
      matchedDirectly = true;
    }
    if (indexed.lowerPath.includes(term)) {
      exactScore += 15;
      reasons.push(`path contains "${term}"`);
      matchedDirectly = true;
    }
    if (indexed.lowerSummary.includes(term)) {
      exactScore += 12;
      reasons.push(`summary contains "${term}"`);
      matchedDirectly = true;
    }
    if (entry.keywords.includes(term) || indexed.lowerKeywords.includes(term)) {
      exactScore += entry.keywords.includes(term) ? 18 : 9;
      reasons.push(`keyword matches "${term}"`);
      matchedDirectly = true;
    }
    if (entry.tags.includes(term)) {
      exactScore += 10;
      reasons.push(`tag matches "${term}"`);
      matchedDirectly = true;
    }
    if (entry.role === term) {
      exactScore += 10;
      reasons.push(`role matches "${term}"`);
      matchedDirectly = true;
    }
    if (!matchedDirectly) {
      const fuzzy = bestFuzzyTokenMatch(term, [
        { tokens: indexed.basenameTokens, score: 14, reason: "fuzzy basename match" },
        { tokens: indexed.metadataTokens, score: 11, reason: "fuzzy keyword/tag match" },
        { tokens: indexed.pathTokens, score: 9, reason: "fuzzy path match" },
        { tokens: indexed.summaryTokens, score: 6, reason: "fuzzy summary match" },
      ]);
      if (fuzzy) {
        fuzzyScore += fuzzy.score;
        reasons.push(`${fuzzy.reason} "${term}"~"${fuzzy.token}"`);
      }
    }
  }
  if (!entry.stale) exactScore += 4;
  else exactScore -= 8;
  return {
    path: entry.path,
    relativePath: entry.relativePath,
    summary: entry.summary,
    keywords: entry.keywords,
    keySymbols: entry.keySymbols,
    dependencies: entry.dependencies,
    routes: entry.routes,
    role: entry.role,
    tags: entry.tags,
    language: entry.language,
    frameworkHints: entry.frameworkHints,
    score: exactScore + fuzzyScore,
    fresh: !entry.stale,
    reasons: dedupeStrings(reasons).slice(0, 5),
    exactScore,
    fuzzyScore,
  };
}

function bestFuzzyTokenMatch(
  term: string,
  groups: Array<{ tokens: string[]; score: number; reason: string }>,
): { token: string; score: number; reason: string } | undefined {
  if (term.length < 4) return undefined;
  let best: { token: string; score: number; reason: string; distance: number } | undefined;
  for (const group of groups) {
    for (const token of group.tokens) {
      if (token === term) continue;
      const distance = boundedLevenshtein(term, token, maxFuzzyDistance(term, token));
      if (distance === undefined) continue;
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && group.score > best.score)
      ) {
        best = { token, score: group.score, reason: group.reason, distance };
      }
    }
  }
  if (!best) return undefined;
  return { token: best.token, score: best.score, reason: best.reason };
}

function maxFuzzyDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return -1;
  const minLength = Math.min(a.length, b.length);
  if (minLength <= 4) return 1;
  return 2;
}

function boundedLevenshtein(a: string, b: string, maxDistance: number): number | undefined {
  if (maxDistance < 0) return undefined;
  if (a === b) return 0;
  if (!a || !b) return undefined;
  if (a[0] !== b[0]) return undefined;
  if (Math.abs(a.length - b.length) > maxDistance) return undefined;

  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > maxDistance) return undefined;
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length] <= maxDistance ? previous[b.length] : undefined;
}
