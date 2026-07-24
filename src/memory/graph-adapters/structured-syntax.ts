import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  FileGraphNode,
  GraphAdapter,
  GraphCapabilityLevel,
  GraphExtractionResult,
  GraphProjectContext,
  GraphSourceKind,
  SymbolGraphNode,
  SymbolKind,
} from "./base.js";

export interface ParsedSymbolDefinition {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  exported: boolean;
  start: number;
  end: number;
  containerQualifiedName?: string;
}

export interface ParsedFileDefinition {
  language: string;
  imports: string[];
  symbols: ParsedSymbolDefinition[];
}

export interface StructuredAdapterConfig {
  name: string;
  languages: string[];
  extensions: string[];
  capabilityLevel?: GraphCapabilityLevel;
  sourceKind?: GraphSourceKind;
  canHandlePath?: (filePath: string, context: GraphProjectContext) => boolean;
  languageForFile?: (filePath: string, context: GraphProjectContext) => string;
  parseFile: (args: { filePath: string; text: string; projectContext: GraphProjectContext }) => ParsedFileDefinition;
  resolveSpecifier: (filePath: string, specifier: string, context: GraphProjectContext) => string | undefined;
}

interface SymbolIndexEntry {
  node: SymbolGraphNode;
  body: string;
}

export function createStructuredSyntaxAdapter(config: StructuredAdapterConfig): GraphAdapter {
  const capabilityLevel = config.capabilityLevel ?? "partial";
  const sourceKind = config.sourceKind ?? "parser";
  return {
    name: config.name,
    languages: config.languages,
    extensions: config.extensions,
    supportsFileGraph: true,
    supportsSymbolGraph: true,
    capabilityLevel,
    canHandle(filePath, context) {
      const ext = path.extname(filePath).toLowerCase();
      if (!config.extensions.includes(ext)) return false;
      return config.canHandlePath ? config.canHandlePath(filePath, context) : true;
    },
    async extractProject({ cwd, filePaths, projectContext }) {
      const parsedByFile = new Map<string, ParsedFileDefinition>();
      const textByFile = new Map<string, string>();
      const fileNodes = new Map<string, FileGraphNode>();
      const symbolNodes = new Map<string, SymbolGraphNode[]>();

      for (const filePath of filePaths) {
        const text = await fs.readFile(filePath, "utf8").catch(() => "");
        textByFile.set(filePath, text);
        const parsed = config.parseFile({ filePath, text, projectContext });
        parsedByFile.set(filePath, parsed);
        fileNodes.set(
          filePath,
          createFileNode({
            cwd,
            filePath,
            language: config.languageForFile?.(filePath, projectContext) ?? parsed.language,
            adapter: config.name,
            capabilityLevel,
            sourceKind,
          }),
        );
        symbolNodes.set(
          filePath,
          parsed.symbols.map((symbol, index) =>
            createSymbolNode({
              filePath,
              language: config.languageForFile?.(filePath, projectContext) ?? parsed.language,
              adapter: config.name,
              capabilityLevel,
              sourceKind,
              symbol,
              ordinal: index,
            }),
          ),
        );
      }

      const symbolLookup = new Map<string, SymbolIndexEntry[]>();
      for (const filePath of filePaths) {
        const nodes = symbolNodes.get(filePath) ?? [];
        const parsed = parsedByFile.get(filePath);
        const text = textByFile.get(filePath) ?? "";
        nodes.forEach((node, index) => {
          const symbol = parsed?.symbols[index];
          if (!symbol) return;
          const body = text.slice(symbol.start, Math.max(symbol.end, symbol.start));
          const names = dedupeStrings([
            node.symbol,
            node.qualifiedName,
            node.qualifiedName.split(".").at(-1) ?? "",
          ]);
          for (const name of names) {
            const existing = symbolLookup.get(name) ?? [];
            existing.push({ node, body });
            symbolLookup.set(name, existing);
          }
        });
      }

      const results: GraphExtractionResult[] = [];
      for (const filePath of filePaths) {
        const fileNode = fileNodes.get(filePath);
        const parsed = parsedByFile.get(filePath);
        const nodes = symbolNodes.get(filePath) ?? [];
        if (!fileNode || !parsed) continue;
        const edges = buildEdgesForFile({
          fileNode,
          parsed,
          symbolNodes: nodes,
          symbolLookup,
          resolveSpecifier: (specifier) => config.resolveSpecifier(filePath, specifier, projectContext),
        });
        results.push({ fileNode, symbolNodes: nodes, edges });
      }
      return results;
    },
  };
}

export function parseIndentationLanguage(args: {
  text: string;
  importPatterns: RegExp[];
  declarations: Array<{
    regex: RegExp;
    kind: SymbolKind;
    exported?: (line: string, match: RegExpMatchArray) => boolean;
    qualify?: (name: string, stack: string[], line: string, match: RegExpMatchArray) => string;
  }>;
  language: string;
}): ParsedFileDefinition {
  const imports: string[] = [];
  for (const pattern of args.importPatterns) {
    for (const match of args.text.matchAll(pattern)) {
      if (match[1]) imports.push(...splitSpecifierValues(match[1]));
    }
  }

  const lineStarts = computeLineStarts(args.text);
  const lines = args.text.split(/\r?\n/);
  const stack: Array<{ indent: number; qualifiedName: string }> = [];
  const symbols: ParsedSymbolDefinition[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = stripInlineComment(rawLine, "#");
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const parentStack = stack.map((entry) => entry.qualifiedName);
    for (const matcher of args.declarations) {
      const match = matcher.regex.exec(line);
      matcher.regex.lastIndex = 0;
      if (!match?.[1]) continue;
      const name = match[1].trim();
      const qualifiedName = matcher.qualify
        ? matcher.qualify(name, parentStack, rawLine, match)
        : [...parentStack.slice(-1), name].filter(Boolean).join(".");
      const start = lineStarts[index] + (match.index ?? 0);
      const nextBoundary = findNextIndentBoundary(lines, lineStarts, index + 1, indent);
      symbols.push({
        name,
        qualifiedName: qualifiedName || name,
        kind: matcher.kind,
        exported: matcher.exported ? matcher.exported(rawLine, match) : !name.startsWith("_"),
        start,
        end: nextBoundary,
        containerQualifiedName: parentStack.at(-1),
      });
      if (matcher.kind === "class" || matcher.kind === "module") {
        stack.push({ indent, qualifiedName: qualifiedName || name });
      }
      break;
    }
  }

  return { language: args.language, imports: dedupeStrings(imports), symbols };
}

export function parseBraceLanguage(args: {
  text: string;
  importPatterns: RegExp[];
  declarations: Array<{
    regex: RegExp;
    kind: SymbolKind;
    exported?: (line: string, match: RegExpMatchArray) => boolean;
    qualify?: (name: string, stack: string[], line: string, match: RegExpMatchArray) => string;
    opensScope?: boolean;
  }>;
  language: string;
}): ParsedFileDefinition {
  const imports: string[] = [];
  for (const pattern of args.importPatterns) {
    for (const match of args.text.matchAll(pattern)) {
      if (match[1]) imports.push(...splitSpecifierValues(match[1]));
    }
  }

  const lineStarts = computeLineStarts(args.text);
  const lines = args.text.split(/\r?\n/);
  const stack: Array<{ targetDepth: number; qualifiedName: string }> = [];
  const pendingScopes: Array<{ qualifiedName: string }> = [];
  const symbols: ParsedSymbolDefinition[] = [];
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = stripBraceComments(rawLine);
    const trimmed = line.trim();
    while (stack.length && braceDepth < stack[stack.length - 1].targetDepth) stack.pop();
    const parentStack = stack.map((entry) => entry.qualifiedName);
    let createdScope = false;

    if (trimmed) {
      for (const matcher of args.declarations) {
        const match = matcher.regex.exec(line);
        matcher.regex.lastIndex = 0;
        if (!match?.[1]) continue;
        const name = match[1].trim();
        const qualifiedName = matcher.qualify
          ? matcher.qualify(name, parentStack, rawLine, match)
          : [...parentStack.slice(-1), name].filter(Boolean).join(".");
        const start = lineStarts[index] + (match.index ?? 0);
        const end = findBraceBoundary(lines, lineStarts, index, braceDepth);
        const opensScope =
          matcher.opensScope ?? (matcher.kind === "class" || matcher.kind === "module" || matcher.kind === "method");
        symbols.push({
          name,
          qualifiedName: qualifiedName || name,
          kind: matcher.kind,
          exported: matcher.exported ? matcher.exported(rawLine, match) : !name.startsWith("_"),
          start,
          end,
          containerQualifiedName: parentStack.at(-1),
        });
        if (opensScope) {
          if (line.includes("{")) {
            const openCount = countChar(line, "{");
            const closeCount = countChar(line, "}");
            const targetDepth = braceDepth + Math.max(1, openCount - closeCount);
            stack.push({ targetDepth, qualifiedName: qualifiedName || name });
            createdScope = true;
          } else {
            pendingScopes.push({ qualifiedName: qualifiedName || name });
          }
        }
        break;
      }
    }

    const openCount = countChar(line, "{");
    const closeCount = countChar(line, "}");
    if (openCount > 0 && !createdScope && pendingScopes.length) {
      const scope = pendingScopes.shift();
      if (scope) stack.push({ targetDepth: braceDepth + Math.max(1, openCount - closeCount), qualifiedName: scope.qualifiedName });
    }
    braceDepth += openCount - closeCount;
    while (stack.length && braceDepth < stack[stack.length - 1].targetDepth) stack.pop();
  }

  return { language: args.language, imports: dedupeStrings(imports), symbols };
}

function buildEdgesForFile(args: {
  fileNode: FileGraphNode;
  parsed: ParsedFileDefinition;
  symbolNodes: SymbolGraphNode[];
  symbolLookup: Map<string, SymbolIndexEntry[]>;
  resolveSpecifier: (specifier: string) => string | undefined;
}) {
  const edges: GraphExtractionResult["edges"] = [];
  const seen = new Set<string>();
  const addEdge = (edge: Omit<GraphExtractionResult["edges"][number], "id">) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.reason ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `edge:${hashish(key)}`,
      language: args.fileNode.language,
      adapter: args.fileNode.adapter,
      capabilityLevel: args.fileNode.capabilityLevel,
      sourceKind: args.fileNode.sourceKind,
      confidence: args.fileNode.capabilityLevel === "exact" ? 0.95 : 0.82,
      ...edge,
    });
  };

  for (const specifier of args.parsed.imports) {
    const resolved = args.resolveSpecifier(specifier);
    if (!resolved) continue;
    addEdge({
      from: args.fileNode.id,
      to: `file:${resolved}`,
      kind: "imports",
      filePath: args.fileNode.path,
      reason: specifier,
    });
  }

  const byQualifiedName = new Map(args.symbolNodes.map((node) => [node.qualifiedName, node] as const));
  for (const node of args.symbolNodes) {
    addEdge({
      from: args.fileNode.id,
      to: node.id,
      kind: "defines",
      filePath: args.fileNode.path,
      symbolName: node.qualifiedName,
      reason: "file defines symbol",
    });
    const container = args.parsed.symbols.find((symbol) => symbol.qualifiedName === node.qualifiedName)?.containerQualifiedName;
    if (container) {
      const parent = byQualifiedName.get(container);
      if (parent) {
        addEdge({
          from: parent.id,
          to: node.id,
          kind: "contains",
          filePath: args.fileNode.path,
          symbolName: node.qualifiedName,
          reason: "parent contains symbol",
        });
      }
    }
  }

  for (const node of args.symbolNodes) {
    const bodies = args.symbolLookup.get(node.qualifiedName) ?? args.symbolLookup.get(node.symbol) ?? [];
    const currentBody = bodies.find((entry) => entry.node.id === node.id)?.body ?? "";
    for (const [lookupName, targets] of args.symbolLookup.entries()) {
      if (!lookupName || lookupName.includes(".")) continue;
      if (!new RegExp(`\\b${escapeRegex(lookupName)}\\s*\\(`).test(currentBody)) continue;
      for (const target of targets) {
        if (target.node.id === node.id) continue;
        addEdge({
          from: node.id,
          to: target.node.id,
          kind: "calls",
          filePath: args.fileNode.path,
          symbolName: target.node.qualifiedName,
          reason: lookupName,
        });
      }
    }
  }

  return edges;
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
    confidence: args.capabilityLevel === "exact" ? 0.95 : 0.85,
    contentHash: "",
    lastModifiedMs: 0,
    stale: false,
  };
}

function createSymbolNode(args: {
  filePath: string;
  language: string;
  adapter: string;
  capabilityLevel: GraphCapabilityLevel;
  sourceKind: GraphSourceKind;
  symbol: ParsedSymbolDefinition;
  ordinal: number;
}): SymbolGraphNode {
  return {
    id: `symbol:${args.filePath}:${args.symbol.qualifiedName}:${args.ordinal}`,
    kind: "symbol",
    filePath: args.filePath,
    symbol: args.symbol.name,
    qualifiedName: args.symbol.qualifiedName,
    symbolKind: args.symbol.kind,
    exported: args.symbol.exported,
    language: args.language,
    adapter: args.adapter,
    capabilityLevel: args.capabilityLevel,
    sourceKind: args.sourceKind,
    confidence: args.capabilityLevel === "exact" ? 0.95 : 0.84,
    range: { start: args.symbol.start, end: args.symbol.end },
    stale: false,
  };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function findNextIndentBoundary(lines: string[], lineStarts: number[], startLine: number, parentIndent: number): number {
  for (let index = startLine; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= parentIndent) return lineStarts[index];
  }
  return lineStarts.at(-1) ?? 0;
}

function findBraceBoundary(lines: string[], lineStarts: number[], startLine: number, startingDepth: number): number {
  let depth = startingDepth;
  let opened = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = stripBraceComments(lines[index] ?? "");
    depth += countChar(line, "{");
    if (countChar(line, "{") > 0) opened = true;
    depth -= countChar(line, "}");
    if (opened && depth <= startingDepth) {
      return (lineStarts[index + 1] ?? lineStarts[index] ?? 0);
    }
  }
  return lineStarts.at(-1) ?? 0;
}

function stripInlineComment(line: string, marker: string): string {
  const index = line.indexOf(marker);
  return index >= 0 ? line.slice(0, index) : line;
}

function stripBraceComments(line: string): string {
  const slash = line.indexOf("//");
  return slash >= 0 ? line.slice(0, slash) : line;
}

function countChar(text: string, token: string): number {
  return [...text].filter((value) => value === token).length;
}

function splitSpecifierValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashish(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}
