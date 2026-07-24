/**
 * Structured log store. Everything the harness does emits {@link LogEntry}s here;
 * the `activity_monitor` tool (req #6) reads and searches this store to study
 * activity while cutting noise via tag filters.
 */
import type { LogEntry } from "../types.js";

export interface LogQuery {
  /** Require ALL of these tags (AND). */
  tags?: string[];
  /** Match any of these tags (OR); combined with `tags` as an additional filter. */
  anyTags?: string[];
  /** Substring/regex to match in the message (case-insensitive). */
  text?: string;
  /** Treat `text` as a regular expression. */
  regex?: boolean;
  level?: LogEntry["level"] | Array<LogEntry["level"]>;
  /** Only entries at/after this epoch ms. */
  since?: number;
  /** Max entries returned (most recent). */
  limit?: number;
}

const LEVEL_ORDER: Record<LogEntry["level"], number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class LogStore {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(private readonly maxEntries = 10_000) {}

  append(entry: Partial<LogEntry> & { message: string }): LogEntry {
    const full: LogEntry = {
      timestamp: entry.timestamp ?? Date.now(),
      level: entry.level ?? "info",
      tags: entry.tags ?? [],
      message: entry.message,
      data: entry.data,
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    for (const l of this.listeners) l(full);
    return full;
  }

  /** The logger function shape used across the harness (ToolContext.log). */
  logger(): (entry: LogEntry) => void {
    return (entry) => this.append(entry);
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Search the store. This is what activity_monitor uses to remove noise. */
  search(query: LogQuery = {}): LogEntry[] {
    const levels = query.level
      ? new Set(Array.isArray(query.level) ? query.level : [query.level])
      : undefined;
    const re = query.text && query.regex ? new RegExp(query.text, "i") : undefined;
    const text = query.text && !query.regex ? query.text.toLowerCase() : undefined;

    let out = this.entries.filter((e) => {
      if (query.since && e.timestamp < query.since) return false;
      if (levels && !levels.has(e.level)) return false;
      if (query.tags && !query.tags.every((t) => e.tags.includes(t))) return false;
      if (query.anyTags && !query.anyTags.some((t) => e.tags.includes(t))) return false;
      if (re && !re.test(e.message)) return false;
      if (text && !e.message.toLowerCase().includes(text)) return false;
      return true;
    });

    if (query.limit && out.length > query.limit) out = out.slice(-query.limit);
    return out;
  }

  /** Distinct tags seen, with counts — useful to discover what to filter on. */
  tagHistogram(): Record<string, number> {
    const hist: Record<string, number> = {};
    for (const e of this.entries) for (const t of e.tags) hist[t] = (hist[t] ?? 0) + 1;
    return hist;
  }

  clear(): void {
    this.entries = [];
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }
}
