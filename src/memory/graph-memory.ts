/**
 * Durable graph memory for file dependencies, symbol dependencies, and blast-radius queries.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { detectProject, type TechStack } from "./detect.js";
import { createClojureGraphAdapter } from "./graph-adapters/clojure.js";
import { createDartGraphAdapter } from "./graph-adapters/dart.js";
import { createDotnetGraphAdapter } from "./graph-adapters/dotnet.js";
import { createElixirGraphAdapter } from "./graph-adapters/elixir.js";
import { createGoGraphAdapter } from "./graph-adapters/go.js";
import { createJvmGraphAdapter } from "./graph-adapters/jvm.js";
import { createMiscFileGraphAdapter } from "./graph-adapters/misc-file-graph.js";
import { createPhpGraphAdapter } from "./graph-adapters/php.js";
import { createPythonGraphAdapter } from "./graph-adapters/python.js";
import { createRubyGraphAdapter } from "./graph-adapters/ruby.js";
import { createRustGraphAdapter } from "./graph-adapters/rust.js";
import { createSwiftGraphAdapter } from "./graph-adapters/swift.js";
import { createTypeScriptGraphAdapter } from "./graph-adapters/typescript.js";
import type {
  FileGraphIndex,
  FileGraphNode,
  FrameworkGraphOverlay,
  GraphAdapter,
  GraphCapabilityLevel,
  GraphEdge,
  GraphEdgeKind,
  GraphMemoryData,
  GraphNode,
  GraphProjectContext,
  SymbolGraphNode,
} from "./graph-adapters/base.js";
import { createFrameworkOverlays } from "./graph-overlays/conventions.js";

export const GRAPH_MEMORY_VERSION = 1;
const DEFAULT_DIR = ".turing";
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;
const MAX_RENDER_ITEMS = 120;
const IGNORED_DIRS = new Set([
  ".astro",
  ".build",
  ".dart_tool",
  ".expo",
  ".git",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".svelte-kit",
  ".turing",
  ".tox",
  ".venv",
  ".zig-cache",
  "bin",
  "coverage",
  "DerivedData",
  "dist",
  "node_modules",
  "obj",
  "out",
  "target",
  "vendor",
  "venv",
]);
const MOBILE_ARTIFACT_DIRS_BY_ROOT = new Map<string, Set<string>>([
  ["android", new Set([".cxx", ".gradle", "build"])],
  ["ios", new Set([".symlinks", "Flutter", "Pods", "build", "xcuserdata"])],
]);

export interface GraphMemoryOptions {
  dir?: string;
  forceReindex?: boolean;
  maxFileSize?: number;
  stack?: TechStack;
  category?: string;
}

export interface GraphMemoryStats {
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  staleFiles: number;
  languages: string[];
  frameworks: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GraphTraversalResult<TNode extends GraphNode = GraphNode> {
  target: TNode | null;
  direct: TNode[];
  transitive: TNode[];
  edges: GraphEdge[];
  stale: "fresh" | "stale" | "partially_stale";
  capabilityLevel?: GraphCapabilityLevel;
  notes?: string[];
}

export interface BlastRadiusResult {
  targetType: "file" | "symbol";
  target: FileGraphNode | SymbolGraphNode | null;
  directFiles: FileGraphNode[];
  directSymbols: SymbolGraphNode[];
  transitiveFiles: FileGraphNode[];
  transitiveSymbols: SymbolGraphNode[];
  edges: GraphEdge[];
  stale: "fresh" | "stale" | "partially_stale";
  capabilityLevel?: GraphCapabilityLevel;
  notes?: string[];
}

export class GraphMemory {
  readonly cwd: string;
  readonly dir: string;
  readonly file: string;
  readonly markdownFile: string;
  readonly maxFileSize: number;
  private readonly adapters: GraphAdapter[];
  private readonly overlays: FrameworkGraphOverlay[];
  private readonly stack?: TechStack;
  private readonly category?: string;
  private _data!: GraphMemoryData;
  private _created = false;

  private constructor(cwd: string, dir: string, maxFileSize: number, stack?: TechStack, category?: string) {
    this.cwd = cwd;
    this.dir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    this.file = path.join(this.dir, "graph.json");
    this.markdownFile = path.join(this.dir, "GRAPH_MEMORY.md");
    this.maxFileSize = maxFileSize;
    this.stack = stack;
    this.category = category;
    this.adapters = [
      createTypeScriptGraphAdapter(),
      createPythonGraphAdapter(),
      createPhpGraphAdapter(),
      createRubyGraphAdapter(),
      createGoGraphAdapter(),
      createRustGraphAdapter(),
      createJvmGraphAdapter(),
      createDotnetGraphAdapter(),
      createDartGraphAdapter(),
      createSwiftGraphAdapter(),
      createElixirGraphAdapter(),
      createClojureGraphAdapter(),
      createMiscFileGraphAdapter(),
    ];
    this.overlays = createFrameworkOverlays();
  }

  static async open(cwd: string, opts: GraphMemoryOptions = {}): Promise<GraphMemory> {
    const mem = new GraphMemory(cwd, opts.dir ?? DEFAULT_DIR, opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE, opts.stack, opts.category);
    const existing = await mem.readData();
    if (existing) {
      mem._data = migrate(existing);
      if (opts.forceReindex) {
        await mem.indexProject();
      } else {
        await mem.removeMissingEntries();
        await mem.markChangedEntriesStale();
      }
      await mem.save();
      return mem;
    }
    const now = Date.now();
    mem._data = {
      version: GRAPH_MEMORY_VERSION,
      createdAt: now,
      updatedAt: now,
      nodes: {},
      edges: [],
      byFile: {},
    };
    mem._created = true;
    await mem.indexProject();
    await mem.save();
    return mem;
  }

  get wasCreated(): boolean {
    return this._created;
  }

  get data(): GraphMemoryData {
    return this._data;
  }

  stats(): GraphMemoryStats {
    const nodes = Object.values(this._data.nodes);
    const files = nodes.filter(isFileNode);
    const symbols = nodes.filter(isSymbolNode);
    return {
      totalFiles: files.length,
      totalSymbols: symbols.length,
      totalEdges: this._data.edges.length,
      staleFiles: files.filter((node) => node.stale).length,
      languages: [...new Set(files.map((node) => node.language).filter(Boolean) as string[])].sort(),
      frameworks: [...new Set(files.map((node) => node.framework).filter(Boolean) as string[])].sort(),
      createdAt: this._data.createdAt,
      updatedAt: this._data.updatedAt,
    };
  }

  getFileNode(pathOrRelative: string): FileGraphNode | undefined {
    const absPath = this.resolvePath(pathOrRelative);
    const index = this._data.byFile[absPath];
    if (!index) return undefined;
    const node = this._data.nodes[index.fileNodeId];
    return isFileNode(node) ? node : undefined;
  }

  symbolsInFile(pathOrRelative: string): SymbolGraphNode[] {
    const absPath = this.resolvePath(pathOrRelative);
    const index = this._data.byFile[absPath];
    if (!index) return [];
    return index.symbolNodeIds
      .map((id) => this._data.nodes[id])
      .filter(isSymbolNode)
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  }

  findSymbol(query: { symbol?: string; qualifiedName?: string; filePath?: string }): SymbolGraphNode[] {
    const symbol = query.symbol?.toLowerCase().trim();
    const qualified = query.qualifiedName?.toLowerCase().trim();
    const filePath = query.filePath ? this.resolvePath(query.filePath) : undefined;
    return Object.values(this._data.nodes)
      .filter(isSymbolNode)
      .filter((node) => {
        if (filePath && node.filePath !== filePath) return false;
        if (qualified && !node.qualifiedName.toLowerCase().includes(qualified)) return false;
        if (symbol && !node.symbol.toLowerCase().includes(symbol)) return false;
        return Boolean(symbol || qualified || filePath);
      })
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  }

  async indexProject(): Promise<number> {
    const projectFiles = await this.walkProject(this.cwd);
    const context = await this.buildProjectContext(projectFiles);

    const results = [];
    for (const adapter of this.adapters) {
      const files = projectFiles.filter((filePath) => adapter.canHandle(filePath, context));
      if (!files.length) continue;
      const extracted = await adapter.extractProject({
        cwd: this.cwd,
        filePaths: files,
        projectContext: context,
      });
      results.push(...extracted);
    }

    const nodes: Record<string, GraphNode> = {};
    const byFile: Record<string, FileGraphIndex> = {};
    const edgeMap = new Map<string, GraphEdge>();
    for (const result of results) {
      const stat = await safeStat(result.fileNode.path);
      const text = await safeReadText(result.fileNode.path);
      const framework = pickFrameworkForFile(result.fileNode.path, context);
      nodes[result.fileNode.id] = {
        ...result.fileNode,
        framework: result.fileNode.framework ?? framework,
        contentHash: text ? hashContent(text) : result.fileNode.contentHash,
        lastModifiedMs: stat?.mtimeMs ?? result.fileNode.lastModifiedMs,
      };
      byFile[result.fileNode.path] = {
        fileNodeId: result.fileNode.id,
        symbolNodeIds: result.symbolNodes.map((node) => node.id),
      };
      for (const symbolNode of result.symbolNodes) {
        nodes[symbolNode.id] = {
          ...symbolNode,
          framework: symbolNode.framework ?? framework,
        };
      }
      for (const edge of result.edges) edgeMap.set(edge.id, edge);
    }
    for (const overlay of this.overlays) {
      if (!overlay.applies(context)) continue;
      const edges = await overlay.apply({
        projectContext: context,
        nodes,
        edges: [...edgeMap.values()],
        byFile,
      });
      for (const edge of edges) {
        edge.framework ??= overlay.frameworks.find((framework) => context.frameworks.includes(framework));
        edge.adapter ??= overlay.name;
        edge.capabilityLevel ??= "file_only";
        edge.sourceKind ??= "convention";
        edgeMap.set(edge.id, edge);
      }
    }
    this._data.nodes = nodes;
    this._data.edges = [...edgeMap.values()];
    this._data.byFile = byFile;
    return Object.keys(byFile).length;
  }

  async refreshMany(_paths: string[]): Promise<number> {
    return this.indexProject();
  }

  async refreshPath(_pathOrRelative: string): Promise<number> {
    return this.indexProject();
  }

  markStale(pathOrRelative: string, reason: string): void {
    const absPath = this.resolvePath(pathOrRelative);
    const index = this._data.byFile[absPath];
    if (!index) return;
    const fileNode = this._data.nodes[index.fileNodeId];
    if (isFileNode(fileNode)) {
      fileNode.stale = true;
      fileNode.staleReason = reason;
    }
    for (const symbolId of index.symbolNodeIds) {
      const symbolNode = this._data.nodes[symbolId];
      if (isSymbolNode(symbolNode)) {
        symbolNode.stale = true;
        symbolNode.staleReason = reason;
      }
    }
  }

  fileDeps(
    pathOrRelative: string,
    direction: "inbound" | "outbound" | "both" = "both",
    opts: { depth?: number; includeTransitive?: boolean } = {},
  ): GraphTraversalResult<FileGraphNode> {
    const target = this.getFileNode(pathOrRelative) ?? null;
    if (!target) {
      return { target: null, direct: [], transitive: [], edges: [], stale: "fresh", notes: ["No matching file graph node."] };
    }
    const relevantKinds: GraphEdgeKind[] = ["imports", "exports", "references"];
    const graph = this.traverseGraph(target.id, direction, relevantKinds, opts.depth ?? 3, opts.includeTransitive ?? true);
    return {
      target,
      direct: graph.direct.filter(isFileNode),
      transitive: graph.transitive.filter(isFileNode),
      edges: graph.edges,
      stale: graph.stale,
      capabilityLevel: target.capabilityLevel,
      notes: target.capabilityLevel === "file_only" ? ["File graph available; symbol graph may be limited for this ecosystem."] : undefined,
    };
  }

  symbolDeps(
    query: { filePath?: string; symbol?: string; qualifiedName?: string },
    direction: "inbound" | "outbound" | "both" = "both",
    opts: { depth?: number; includeTransitive?: boolean } = {},
  ): GraphTraversalResult<SymbolGraphNode> {
    const target = this.resolveSymbol(query) ?? null;
    if (!target) {
      const fileNode = query.filePath ? this.getFileNode(query.filePath) : undefined;
      return {
        target: null,
        direct: [],
        transitive: [],
        edges: [],
        stale: "fresh",
        capabilityLevel: fileNode?.capabilityLevel,
        notes: fileNode ? [`Symbol graph unavailable or partial for ${fileNode.language ?? "this"} file.`] : ["No matching symbol graph node."],
      };
    }
    const graph = this.traverseGraph(target.id, direction, ["calls", "references", "extends", "implements"], opts.depth ?? 3, opts.includeTransitive ?? true);
    return {
      target,
      direct: graph.direct.filter(isSymbolNode),
      transitive: graph.transitive.filter(isSymbolNode),
      edges: graph.edges,
      stale: graph.stale,
      capabilityLevel: target.capabilityLevel,
      notes: target.capabilityLevel === "partial" ? ["Symbol graph is partial for this ecosystem."] : undefined,
    };
  }

  blastRadius(
    args:
      | { targetType: "file"; path: string; depth?: number; includeTransitive?: boolean; directions?: "inbound" | "outbound" | "both" }
      | { targetType: "symbol"; path?: string; symbol?: string; qualifiedName?: string; depth?: number; includeTransitive?: boolean; directions?: "inbound" | "outbound" | "both" },
  ): BlastRadiusResult {
    if (args.targetType === "file") {
      const deps = this.fileDeps(args.path, args.directions ?? "both", {
        depth: args.depth,
        includeTransitive: args.includeTransitive ?? true,
      });
      const target = deps.target;
      const directFiles = deps.direct;
      const transitiveFiles = deps.transitive;
      const directSymbols = target ? this.symbolsInFile(target.path) : [];
      const transitiveSymbols = dedupeById(
        transitiveFiles.flatMap((node) => this.symbolsInFile(node.path)),
      );
      return {
        targetType: "file",
        target,
        directFiles,
        directSymbols,
        transitiveFiles,
        transitiveSymbols,
        edges: deps.edges,
        stale: deps.stale,
        capabilityLevel: deps.capabilityLevel,
        notes: deps.notes,
      };
    }

    const deps = this.symbolDeps(
      {
        filePath: args.path,
        symbol: args.symbol,
        qualifiedName: args.qualifiedName,
      },
      args.directions ?? "both",
      { depth: args.depth, includeTransitive: args.includeTransitive ?? true },
    );
    const directFiles = dedupeById(
      deps.direct.map((node) => this.getFileNode(node.filePath)).filter(isFileNode),
    );
    const transitiveFiles = dedupeById(
      deps.transitive.map((node) => this.getFileNode(node.filePath)).filter(isFileNode),
    );
    return {
      targetType: "symbol",
      target: deps.target,
      directFiles,
      directSymbols: deps.direct,
      transitiveFiles,
      transitiveSymbols: deps.transitive,
      edges: deps.edges,
      stale: deps.stale,
      capabilityLevel: deps.capabilityLevel,
      notes: deps.notes,
    };
  }

  async removeMissingEntries(): Promise<number> {
    let removed = 0;
    for (const filePath of Object.keys(this._data.byFile)) {
      const stat = await safeStat(filePath);
      if (!stat || !stat.isFile()) {
        this.deleteFile(filePath);
        removed += 1;
      }
    }
    return removed;
  }

  async markChangedEntriesStale(): Promise<number> {
    let changed = 0;
    for (const filePath of Object.keys(this._data.byFile)) {
      const stat = await safeStat(filePath);
      if (!stat || !stat.isFile()) continue;
      const fileNode = this.getFileNode(filePath);
      if (!fileNode) continue;
      if (stat.mtimeMs !== fileNode.lastModifiedMs) {
        this.markStale(filePath, "filesystem changed");
        changed += 1;
      }
    }
    return changed;
  }

  async save(): Promise<void> {
    this._data.updatedAt = Date.now();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this._data, null, 2), "utf8");
    await fs.writeFile(this.markdownFile, this.render(), "utf8");
  }

  render(): string {
    const stats = this.stats();
    const lines = [
      "# Graph memory",
      "",
      `- **Indexed files:** ${stats.totalFiles}`,
      `- **Indexed symbols:** ${stats.totalSymbols}`,
      `- **Edges:** ${stats.totalEdges}`,
      `- **Stale files:** ${stats.staleFiles}`,
      `- **Languages:** ${stats.languages.join(", ") || "—"}`,
      `- **Frameworks:** ${stats.frameworks.join(", ") || "—"}`,
      "",
      "## Files",
      "",
    ];
    const fileNodes = Object.values(this._data.nodes).filter(isFileNode).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const fileNode of fileNodes.slice(0, MAX_RENDER_ITEMS)) {
      const symbolCount = this.symbolsInFile(fileNode.path).length;
      const meta = [fileNode.language, fileNode.framework, fileNode.capabilityLevel].filter(Boolean).join(", ");
      lines.push(`- \`${fileNode.relativePath}\` — ${symbolCount} symbols${meta ? ` (${meta})` : ""}${fileNode.stale ? ` [stale: ${fileNode.staleReason ?? "unknown"}]` : ""}`);
    }
    if (fileNodes.length > MAX_RENDER_ITEMS) {
      lines.push("", `- ... ${fileNodes.length - MAX_RENDER_ITEMS} more files omitted`);
    }
    lines.push("");
    return lines.join("\n");
  }

  private traverseGraph(
    targetId: string,
    direction: "inbound" | "outbound" | "both",
    kinds: GraphEdgeKind[],
    depth: number,
    includeTransitive: boolean,
  ): { direct: GraphNode[]; transitive: GraphNode[]; edges: GraphEdge[]; stale: "fresh" | "stale" | "partially_stale" } {
    const relevantEdges = this._data.edges.filter((edge) => kinds.includes(edge.kind));
    const target = this._data.nodes[targetId];
    const directIds = new Set<string>();
    const directEdges: GraphEdge[] = [];

    const directionMatches = (edge: GraphEdge, currentId: string): string[] => {
      const hits: string[] = [];
      if ((direction === "outbound" || direction === "both") && edge.from === currentId) hits.push(edge.to);
      if ((direction === "inbound" || direction === "both") && edge.to === currentId) hits.push(edge.from);
      return hits;
    };

    for (const edge of relevantEdges) {
      for (const nextId of directionMatches(edge, targetId)) {
        directIds.add(nextId);
        directEdges.push(edge);
      }
    }

    const transitiveIds = new Set<string>();
    const allEdges = new Map<string, GraphEdge>(directEdges.map((edge) => [edge.id, edge]));
    if (includeTransitive) {
      const queue = [...directIds].map((id) => ({ id, level: 1 }));
      const seen = new Set<string>([targetId, ...directIds]);
      while (queue.length) {
        const item = queue.shift()!;
        if (item.level >= depth) continue;
        for (const edge of relevantEdges) {
          for (const nextId of directionMatches(edge, item.id)) {
            if (seen.has(nextId)) continue;
            seen.add(nextId);
            transitiveIds.add(nextId);
            allEdges.set(edge.id, edge);
            queue.push({ id: nextId, level: item.level + 1 });
          }
        }
      }
    }

    const direct = [...directIds].map((id) => this._data.nodes[id]).filter(Boolean);
    const transitive = [...transitiveIds].map((id) => this._data.nodes[id]).filter(Boolean);
    const staleNodes = [target, ...direct, ...transitive].filter(Boolean).filter((node) => node.stale);
    return {
      direct,
      transitive,
      edges: [...allEdges.values()],
      stale:
        staleNodes.length === 0
          ? "fresh"
          : staleNodes.length === direct.length + transitive.length + (target ? 1 : 0)
            ? "stale"
            : "partially_stale",
    };
  }

  private resolveSymbol(query: { filePath?: string; symbol?: string; qualifiedName?: string }): SymbolGraphNode | undefined {
    const matched = this.findSymbol(query);
    return matched[0];
  }

  private resolvePath(pathOrRelative: string): string {
    return path.isAbsolute(pathOrRelative) ? pathOrRelative : path.join(this.cwd, pathOrRelative);
  }

  private async buildProjectContext(projectFiles: string[]): Promise<GraphProjectContext> {
    const detection = this.stack ? { stack: this.stack, category: this.category } : await detectProject(this.cwd);
    const relativePaths = Object.fromEntries(projectFiles.map((filePath) => [filePath, path.relative(this.cwd, filePath)]));
    const filesByExtension: Record<string, string[]> = {};
    for (const filePath of projectFiles) {
      const ext = path.extname(filePath);
      if (!filesByExtension[ext]) filesByExtension[ext] = [];
      filesByExtension[ext].push(filePath);
    }
    const manifests = await readProjectManifests(this.cwd);
    return {
      cwd: this.cwd,
      filePaths: projectFiles,
      relativePaths,
      category: "category" in detection ? detection.category : this.category,
      languages: detection.stack.languages ?? [],
      frameworks: detection.stack.frameworks ?? [],
      packageManager: detection.stack.packageManager,
      runtime: detection.stack.runtime,
      filesByExtension,
      manifests,
    };
  }

  private async readData(): Promise<GraphMemoryData | undefined> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      return JSON.parse(text) as GraphMemoryData;
    } catch {
      return undefined;
    }
  }

  private async walkProject(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.shouldIgnoreDirectory(absPath, entry.name)) continue;
        files.push(...(await this.walkProject(absPath)));
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await safeStat(absPath);
      if (!stat || stat.size > this.maxFileSize) continue;
      files.push(absPath);
    }
    return files;
  }

  private shouldIgnoreDirectory(absPath: string, entryName: string): boolean {
    if (IGNORED_DIRS.has(entryName)) return true;
    const relative = path.relative(this.cwd, absPath);
    if (!relative || relative.startsWith("..")) return false;
    const parts = relative.split(path.sep).filter(Boolean);
    for (const [root, ignoredNames] of MOBILE_ARTIFACT_DIRS_BY_ROOT) {
      if (parts.includes(root) && ignoredNames.has(entryName)) return true;
    }
    return false;
  }

  private deleteFile(filePath: string): void {
    const index = this._data.byFile[filePath];
    if (!index) return;
    delete this._data.nodes[index.fileNodeId];
    for (const symbolId of index.symbolNodeIds) delete this._data.nodes[symbolId];
    this._data.edges = this._data.edges.filter((edge) => edge.filePath !== filePath && edge.from !== index.fileNodeId && edge.to !== index.fileNodeId && !index.symbolNodeIds.includes(edge.from) && !index.symbolNodeIds.includes(edge.to));
    delete this._data.byFile[filePath];
  }
}

function migrate(data: GraphMemoryData): GraphMemoryData {
  return {
    version: GRAPH_MEMORY_VERSION,
    createdAt: data.createdAt ?? Date.now(),
    updatedAt: data.updatedAt ?? Date.now(),
    nodes: data.nodes ?? {},
    edges: data.edges ?? [],
    byFile: data.byFile ?? {},
  };
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

async function safeReadText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function hashContent(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function isFileNode(node: GraphNode | undefined): node is FileGraphNode {
  return Boolean(node && node.kind === "file");
}

function isSymbolNode(node: GraphNode | undefined): node is SymbolGraphNode {
  return Boolean(node && node.kind === "symbol");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

async function readProjectManifests(cwd: string): Promise<Record<string, string>> {
  const manifestNames = [
    "package.json",
    "composer.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "mix.exs",
    "pubspec.yaml",
    "build.sbt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Package.swift",
    "deps.edn",
    "project.clj",
    "build.zig",
    "DESCRIPTION",
    "cpanfile",
  ];
  const entries = await Promise.all(
    manifestNames.map(async (name) => {
      try {
        return [name, await fs.readFile(path.join(cwd, name), "utf8")] as const;
      } catch {
        return undefined;
      }
    }),
  );
  return Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>);
}

function pickFrameworkForFile(filePath: string, context: GraphProjectContext): string | undefined {
  const lower = filePath.toLowerCase();
  const frameworks = context.frameworks;
  if (frameworks.some((fw) => ["next", "remix", "gatsby", "nuxt", "astro"].includes(fw)) && /(pages|app|routes)/.test(lower)) {
    return frameworks.find((fw) => ["next", "remix", "gatsby", "nuxt", "astro"].includes(fw));
  }
  if (frameworks.some((fw) => ["express", "fastify", "nestjs", "koa", "django", "flask", "fastapi", "laravel", "symfony", "rails", "sinatra", "phoenix", "spring", "micronaut", "quarkus", "ktor", "aspnet"].includes(fw)) && /(controller|service|route|router|model|entity|repository|view|urls)/.test(lower)) {
    return frameworks.find((fw) => ["express", "fastify", "nestjs", "koa", "django", "flask", "fastapi", "laravel", "symfony", "rails", "sinatra", "phoenix", "spring", "micronaut", "quarkus", "ktor", "aspnet"].includes(fw));
  }
  if (frameworks.some((fw) => ["flutter", "expo", "react-native", "ionic/capacitor"].includes(fw)) && /(screen|screens|navigation|widget|widgets|page|pages)/.test(lower)) {
    return frameworks.find((fw) => ["flutter", "expo", "react-native", "ionic/capacitor"].includes(fw));
  }
  if (frameworks.some((fw) => ["godot", "unity", "unreal", "phaser", "bevy"].includes(fw)) && /(scene|script|system|godot|unity|uproject|asset)/.test(lower)) {
    return frameworks.find((fw) => ["godot", "unity", "unreal", "phaser", "bevy"].includes(fw));
  }
  return frameworks[0];
}
