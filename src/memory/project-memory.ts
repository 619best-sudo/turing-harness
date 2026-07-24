/**
 * Project-level memory.
 *
 * The first time a project is opened, the harness detects its tech stack
 * (website / mobile / game / backend) and writes a persistent memory to
 * `<cwd>/.turing/` (a JSON source of truth + a human-readable MEMORY.md). On
 * subsequent opens the memory is loaded, so the project's category — which selects
 * the 4P preset — and any accumulated facts survive across runs and processes.
 *
 * This is distinct from the in-run {@link LogStore}: memory is durable, project-
 * scoped knowledge; the log store is ephemeral, session-scoped activity.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectCategory } from "../presets/project-presets.js";
import { detectProject, type ProjectDetection, type TechStack } from "./detect.js";

export const MEMORY_VERSION = 1;
const DEFAULT_DIR = ".turing";

/** One durable, project-scoped fact the agent (or app) learned. */
export interface MemoryFact {
  id: string;
  text: string;
  tags: string[];
  /** Which phase/source recorded it, if known. */
  source?: string;
  createdAt: number;
}

export interface ProjectMemoryData {
  version: number;
  createdAt: number;
  updatedAt: number;
  /** website(frontend) / mobile / games / backend. */
  category: ProjectCategory;
  stack: TechStack;
  detection: { evidence: string[]; confidence: number; auto: boolean };
  facts: MemoryFact[];
  metadata: Record<string, unknown>;
}

export interface ProjectMemoryOptions {
  /** Directory (relative to cwd) to store memory in. Default ".turing". */
  dir?: string;
  /** Re-run detection even if a memory already exists, updating category/stack. */
  forceDetect?: boolean;
}

export class ProjectMemory {
  readonly cwd: string;
  readonly dir: string;
  readonly file: string;
  readonly markdownFile: string;
  private _data!: ProjectMemoryData;
  private _created = false;

  private constructor(cwd: string, dir: string) {
    this.cwd = cwd;
    this.dir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    this.file = path.join(this.dir, "project.json");
    this.markdownFile = path.join(this.dir, "MEMORY.md");
  }

  /**
   * Open (load) or, on first use, initialize the memory for a project. On first
   * init the tech stack is detected and persisted.
   */
  static async open(cwd: string, opts: ProjectMemoryOptions = {}): Promise<ProjectMemory> {
    const mem = new ProjectMemory(cwd, opts.dir ?? DEFAULT_DIR);
    const existing = await mem.readData();
    if (existing) {
      mem._data = migrate(existing);
      if (opts.forceDetect) {
        const det = await detectProject(cwd);
        mem._data.category = det.category;
        mem._data.stack = det.stack;
        mem._data.detection = { evidence: det.evidence, confidence: det.confidence, auto: true };
        await mem.save();
      }
      return mem;
    }
    // First time: detect + create.
    const det: ProjectDetection = await detectProject(cwd);
    const now = Date.now();
    mem._data = {
      version: MEMORY_VERSION,
      createdAt: now,
      updatedAt: now,
      category: det.category,
      stack: det.stack,
      detection: { evidence: det.evidence, confidence: det.confidence, auto: true },
      facts: [],
      metadata: {},
    };
    mem._created = true;
    await mem.save();
    return mem;
  }

  /** Whether this open() created the memory (first initialization). */
  get wasCreated(): boolean {
    return this._created;
  }
  get data(): ProjectMemoryData {
    return this._data;
  }
  get category(): ProjectCategory {
    return this._data.category;
  }
  get stack(): TechStack {
    return this._data.stack;
  }

  /** Override the detected category (e.g. the caller passed an explicit one). */
  async setCategory(category: ProjectCategory, opts: { auto?: boolean } = {}): Promise<void> {
    if (this._data.category === category && !opts.auto) return;
    this._data.category = category;
    this._data.detection.auto = opts.auto ?? false;
    await this.save();
  }

  /** Record a durable project fact. */
  async remember(text: string, opts: { tags?: string[]; source?: string } = {}): Promise<MemoryFact> {
    const fact: MemoryFact = {
      id: randomUUID().slice(0, 8),
      text,
      tags: opts.tags ?? [],
      source: opts.source,
      createdAt: Date.now(),
    };
    this._data.facts.push(fact);
    await this.save();
    return fact;
  }

  /** Recall facts, optionally filtered by tag or substring. */
  recall(query?: { tag?: string; text?: string }): MemoryFact[] {
    let facts = this._data.facts;
    if (query?.tag) facts = facts.filter((f) => f.tags.includes(query.tag!));
    if (query?.text) {
      const q = query.text.toLowerCase();
      facts = facts.filter((f) => f.text.toLowerCase().includes(q));
    }
    return facts;
  }

  /** Set an arbitrary metadata key. */
  async set(key: string, value: unknown): Promise<void> {
    this._data.metadata[key] = value;
    await this.save();
  }

  /** Persist to disk (JSON + MEMORY.md). */
  async save(): Promise<void> {
    this._data.updatedAt = Date.now();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this._data, null, 2), "utf8");
    await fs.writeFile(this.markdownFile, this.render(), "utf8");
  }

  /** Human/LLM-readable summary written to MEMORY.md. */
  render(): string {
    const d = this._data;
    const lines: string[] = [
      "# Project memory",
      "",
      `- **Category:** ${d.category}${d.detection.auto ? " (auto-detected)" : " (set)"}`,
      `- **Languages:** ${d.stack.languages.join(", ") || "—"}`,
      `- **Frameworks:** ${d.stack.frameworks.join(", ") || "—"}`,
      ...(d.stack.engine ? [`- **Engine:** ${d.stack.engine}`] : []),
      ...(d.stack.packageManager ? [`- **Package manager:** ${d.stack.packageManager}`] : []),
      `- **Detection confidence:** ${(d.detection.confidence * 100).toFixed(0)}%`,
      `- **Evidence:** ${d.detection.evidence.join("; ")}`,
      "",
    ];
    if (d.facts.length) {
      lines.push("## Learned facts", "");
      for (const f of d.facts) {
        const tags = f.tags.length ? ` _(${f.tags.join(", ")})_` : "";
        lines.push(`- ${f.text}${tags}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private async readData(): Promise<ProjectMemoryData | undefined> {
    try {
      const t = await fs.readFile(this.file, "utf8");
      return JSON.parse(t) as ProjectMemoryData;
    } catch {
      return undefined;
    }
  }
}

/** Bring older on-disk memory shapes up to the current version. */
function migrate(data: ProjectMemoryData): ProjectMemoryData {
  return {
    version: MEMORY_VERSION,
    createdAt: data.createdAt ?? Date.now(),
    updatedAt: data.updatedAt ?? Date.now(),
    category: data.category ?? "backend",
    stack: data.stack ?? { languages: [], frameworks: [] },
    detection: data.detection ?? { evidence: [], confidence: 0, auto: true },
    facts: data.facts ?? [],
    metadata: data.metadata ?? {},
  };
}
