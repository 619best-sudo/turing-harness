import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  FileGraphNode,
  GraphAdapter,
  GraphCapabilityLevel,
  GraphEdge,
  GraphExtractionResult,
  GraphProjectContext,
  GraphSourceKind,
  SymbolGraphNode,
  SymbolKind,
} from "./base.js";

interface SymbolPattern {
  regex: RegExp;
  kind: SymbolKind;
}

interface RegexFamilyAdapterConfig {
  name: string;
  languages: string[];
  extensions: string[];
  capabilityLevel: GraphCapabilityLevel;
  sourceKind?: GraphSourceKind;
  importPatterns: RegExp[];
  symbolPatterns?: SymbolPattern[];
  canHandlePath?: (filePath: string, context: GraphProjectContext) => boolean;
  languageForFile?: (filePath: string, context: GraphProjectContext) => string;
  resolveSpecifier: (filePath: string, specifier: string, context: GraphProjectContext) => string | undefined;
}

export function createRegexFamilyAdapter(config: RegexFamilyAdapterConfig): GraphAdapter {
  return {
    name: config.name,
    languages: config.languages,
    extensions: config.extensions,
    supportsFileGraph: true,
    supportsSymbolGraph: Boolean(config.symbolPatterns?.length),
    capabilityLevel: config.capabilityLevel,
    canHandle(filePath, context) {
      const ext = path.extname(filePath).toLowerCase();
      if (!config.extensions.includes(ext)) return false;
      return config.canHandlePath ? config.canHandlePath(filePath, context) : true;
    },
    async extractProject({ cwd, filePaths, projectContext }) {
      const results: GraphExtractionResult[] = [];
      const symbolIndex = new Map<string, SymbolGraphNode[]>();

      for (const filePath of filePaths) {
        const text = await fs.readFile(filePath, "utf8").catch(() => "");
        const fileNode = createFileNode({
          cwd,
          filePath,
          language: config.languageForFile?.(filePath, projectContext) ?? config.languages[0],
          adapter: config.name,
          capabilityLevel: config.capabilityLevel,
          sourceKind: config.sourceKind ?? "parser",
        });
        const symbolNodes = collectSymbols(filePath, text, config);
        symbolIndex.set(filePath, symbolNodes);
        results.push({ fileNode, symbolNodes, edges: [] });
      }

      const symbolLookup = buildSymbolLookup(symbolIndex);
      for (const result of results) {
        const text = await fs.readFile(result.fileNode.path, "utf8").catch(() => "");
        const edges = collectEdges(result.fileNode, text, config, projectContext, symbolLookup);
        result.edges = edges;
      }
      return results;
    },
  };
}

function createFileNode(args: {
  cwd: string;
  filePath: string;
  language: string;
  adapter: string;
  capabilityLevel: GraphCapabilityLevel;
  sourceKind: GraphSourceKind;
}): FileGraphNode {
  return {
    id: `file:${args.filePath}`,
    kind: "file",
    path: args.filePath,
    relativePath: path.relative(args.cwd, args.filePath),
    language: args.language,
    adapter: args.adapter,
    capabilityLevel: args.capabilityLevel,
    sourceKind: args.sourceKind,
    confidence: args.capabilityLevel === "partial" ? 0.7 : 0.55,
    contentHash: "",
    lastModifiedMs: 0,
    stale: false,
  };
}

function collectSymbols(filePath: string, text: string, config: RegexFamilyAdapterConfig): SymbolGraphNode[] {
  const patterns = config.symbolPatterns ?? [];
  const nodes: SymbolGraphNode[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const name = match[1]?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const start = match.index ?? 0;
      nodes.push({
        id: `symbol:${filePath}:${name}:${start}`,
        kind: "symbol",
        filePath,
        symbol: name,
        qualifiedName: name,
        symbolKind: pattern.kind,
        exported: true,
        language: config.languages[0],
        adapter: config.name,
        capabilityLevel: config.capabilityLevel,
        sourceKind: config.sourceKind ?? "parser",
        confidence: config.capabilityLevel === "partial" ? 0.65 : 0.5,
        range: { start, end: start + name.length },
        stale: false,
      });
    }
  }
  return nodes;
}

function buildSymbolLookup(index: Map<string, SymbolGraphNode[]>): Map<string, SymbolGraphNode[]> {
  const map = new Map<string, SymbolGraphNode[]>();
  for (const nodes of index.values()) {
    for (const node of nodes) {
      const list = map.get(node.symbol) ?? [];
      list.push(node);
      map.set(node.symbol, list);
    }
  }
  return map;
}

function collectEdges(
  fileNode: FileGraphNode,
  text: string,
  config: RegexFamilyAdapterConfig,
  context: GraphProjectContext,
  symbolLookup: Map<string, SymbolGraphNode[]>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (edge: Omit<GraphEdge, "id">) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.reason ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `edge:${hashish(key)}`,
      language: fileNode.language,
      adapter: config.name,
      capabilityLevel: config.capabilityLevel,
      sourceKind: config.sourceKind ?? "parser",
      confidence: config.capabilityLevel === "partial" ? 0.65 : 0.5,
      ...edge,
    });
  };

  for (const pattern of config.importPatterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (!specifier) continue;
      const resolved = config.resolveSpecifier(fileNode.path, specifier, context);
      if (!resolved) continue;
      addEdge({
        from: fileNode.id,
        to: `file:${resolved}`,
        kind: "imports",
        filePath: fileNode.path,
        reason: specifier,
      });
    }
  }

  const fileSymbols = [...symbolLookup.values()].flat().filter((node) => node.filePath === fileNode.path);
  for (const symbol of fileSymbols) {
    addEdge({
      from: fileNode.id,
      to: symbol.id,
      kind: "defines",
      filePath: fileNode.path,
      symbolName: symbol.qualifiedName,
      reason: "file defines symbol",
    });
  }

  for (const sourceSymbol of fileSymbols) {
    const body = text.slice(sourceSymbol.range?.start ?? 0);
    for (const [name, targets] of symbolLookup.entries()) {
      if (!new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(body)) continue;
      for (const target of targets) {
        if (target.id === sourceSymbol.id) continue;
        addEdge({
          from: sourceSymbol.id,
          to: target.id,
          kind: "calls",
          filePath: fileNode.path,
          symbolName: target.qualifiedName,
          reason: name,
        });
      }
    }
  }

  return edges;
}

export function resolveRelativeLike(
  filePath: string,
  specifier: string,
  context: GraphProjectContext,
  extensions: string[],
): string | undefined {
  const normalized = specifier.replace(/\\/g, "/");
  if (normalized.startsWith(".")) {
    const base = path.resolve(path.dirname(filePath), normalized);
    const match = matchPath(base, context, extensions);
    if (match) return match;
  }
  const rawRootCandidate = path.resolve(context.cwd, normalized);
  const rawRootMatch = matchPath(rawRootCandidate, context, extensions) ?? matchPathBySuffix(normalized, context, extensions);
  if (rawRootMatch) return rawRootMatch;
  const dotted = normalized.replace(/\./g, "/");
  const rootCandidate = path.resolve(context.cwd, dotted);
  return matchPath(rootCandidate, context, extensions) ?? matchPathBySuffix(dotted, context, extensions);
}

function matchPath(basePath: string, context: GraphProjectContext, extensions: string[]): string | undefined {
  const baseName = path.basename(basePath);
  const candidates = [
    basePath,
    ...extensions.map((ext) => `${basePath}${ext}`),
    ...extensions.map((ext) => path.join(basePath, `index${ext}`)),
    ...extensions.map((ext) => path.join(basePath, `__init__${ext}`)),
    ...extensions.map((ext) => path.join(basePath, `${baseName}${ext}`)),
  ].map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => context.filePaths.includes(candidate));
}

function matchPathBySuffix(specifier: string, context: GraphProjectContext, extensions: string[]): string | undefined {
  const normalized = specifier.replace(/^\/+/, "").replace(/\/+/g, "/");
  const basename = path.basename(normalized);
  const suffixes = new Set<string>([
    `/${normalized}`,
    `/${basename}`,
    ...extensions.map((ext) => `/${normalized}${ext}`),
    ...extensions.map((ext) => `/${basename}${ext}`),
    ...extensions.map((ext) => `/${normalized}/index${ext}`),
    ...extensions.map((ext) => `/${basename}/index${ext}`),
    ...extensions.map((ext) => `/src/${normalized}${ext}`),
    ...extensions.map((ext) => `/src/main/${normalized}${ext}`),
    ...extensions.map((ext) => `/src/main/java/${normalized}${ext}`),
    ...extensions.map((ext) => `/src/main/kotlin/${normalized}${ext}`),
    ...extensions.map((ext) => `/src/main/scala/${normalized}${ext}`),
    ...extensions.map((ext) => `/sources/${normalized}${ext}`),
    ...extensions.map((ext) => `/sources/${basename}/${basename}${ext}`),
    ...extensions.map((ext) => `/lib/${normalized}${ext}`),
    ...extensions.map((ext) => `/app/${normalized}${ext}`),
    ...extensions.map((ext) => `/${normalized}/${basename}${ext}`),
  ]);
  const normalizedPaths = context.filePaths.map((candidate) => ({
    absolute: candidate,
    normalized: candidate.replace(/\\/g, "/").toLowerCase(),
  }));
  return normalizedPaths.find(({ normalized: candidate }) =>
    [...suffixes].some((suffix) => candidate.endsWith(suffix.toLowerCase())),
  )?.absolute;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashish(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}
