import * as path from "node:path";
import ts from "typescript";
import type {
  FileGraphNode,
  GraphAdapter,
  GraphEdge,
  GraphExtractionResult,
  SymbolGraphNode,
  SymbolKind,
} from "./base.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

export function createTypeScriptGraphAdapter(): GraphAdapter {
  return {
    name: "typescript",
    languages: ["typescript", "javascript"],
    extensions: [...SUPPORTED_EXTENSIONS],
    supportsFileGraph: true,
    supportsSymbolGraph: true,
    capabilityLevel: "exact",
    canHandle(filePath) {
      return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    },
    async extractProject({ cwd, filePaths, projectContext }) {
      const rootNames = filePaths.filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
      if (!rootNames.length) return [];

      const compilerOptions = resolveCompilerOptions(cwd);
      const program = ts.createProgram({
        rootNames,
        options: compilerOptions,
      });
      const checker = program.getTypeChecker();

      const results: GraphExtractionResult[] = [];
      const fileNodeByPath = new Map<string, FileGraphNode>();
      const symbolByDeclKey = new Map<string, SymbolGraphNode>();
      const edges: GraphEdge[] = [];
      const edgeKeys = new Set<string>();

      const addEdge = (edge: Omit<GraphEdge, "id">) => {
        const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.reason ?? ""}`;
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        edges.push({
          id: `edge:${edge.kind}:${hashish(key)}`,
          ...edge,
        });
      };

      for (const sourceFile of program.getSourceFiles()) {
        const filePath = path.resolve(sourceFile.fileName);
        if (!rootNames.includes(filePath) || sourceFile.isDeclarationFile) continue;
        const fileNode: FileGraphNode = {
          id: fileNodeId(filePath),
          kind: "file",
          path: filePath,
          relativePath: projectContext.relativePaths[filePath] ?? path.relative(cwd, filePath),
          language: path.extname(filePath).toLowerCase().includes("ts") ? "typescript" : "javascript",
          framework: projectContext.frameworks[0],
          adapter: "typescript",
          capabilityLevel: "exact",
          sourceKind: "parser",
          confidence: 0.95,
          contentHash: "",
          lastModifiedMs: 0,
          stale: false,
        };
        fileNodeByPath.set(filePath, fileNode);

        const symbolNodes: SymbolGraphNode[] = [];
        for (const statement of sourceFile.statements) {
          collectDeclarations({
            node: statement,
            filePath,
            checker,
            symbolNodes,
            symbolByDeclKey,
            addEdge,
            fileNodeId: fileNode.id,
          });
        }
        results.push({ fileNode, symbolNodes, edges: [] });
      }

      for (const sourceFile of program.getSourceFiles()) {
        const filePath = path.resolve(sourceFile.fileName);
        const fileNode = fileNodeByPath.get(filePath);
        if (!fileNode || sourceFile.isDeclarationFile) continue;
        collectFileEdges(sourceFile, filePath, fileNodeByPath, compilerOptions, addEdge);
        collectSymbolEdges(sourceFile, checker, symbolByDeclKey, addEdge);
      }

      const edgesByFile = new Map<string, GraphEdge[]>();
      for (const edge of edges) {
        if (!edge.filePath) continue;
        const list = edgesByFile.get(edge.filePath) ?? [];
        list.push(edge);
        edgesByFile.set(edge.filePath, list);
      }
      return results.map((result) => ({
        ...result,
        edges: edgesByFile.get(result.fileNode.path) ?? [],
      }));
    },
  };
}

function collectDeclarations(args: {
  node: ts.Node;
  filePath: string;
  checker: ts.TypeChecker;
  symbolNodes: SymbolGraphNode[];
  symbolByDeclKey: Map<string, SymbolGraphNode>;
  addEdge: (edge: Omit<GraphEdge, "id">) => void;
  fileNodeId: string;
  parentSymbol?: SymbolGraphNode;
}) {
  const { node, filePath, checker, symbolNodes, symbolByDeclKey, addEdge, fileNodeId, parentSymbol } = args;

  const created = createSymbolNode(node, filePath, checker, parentSymbol);
  let currentParent = parentSymbol;
  if (created) {
    symbolNodes.push(created);
    symbolByDeclKey.set(declKey(node), created);
    addEdge({
      from: fileNodeId,
      to: created.id,
      kind: "defines",
      filePath,
      symbolName: created.qualifiedName,
      reason: "file defines symbol",
    });
    if (parentSymbol) {
      addEdge({
        from: parentSymbol.id,
        to: created.id,
        kind: "contains",
        filePath,
        symbolName: created.qualifiedName,
        reason: "parent contains symbol",
      });
    }
    currentParent = created.symbolKind === "class" ? created : parentSymbol;
  }

  if (ts.isClassDeclaration(node) && node.members.length) {
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        collectDeclarations({
          node: member,
          filePath,
          checker,
          symbolNodes,
          symbolByDeclKey,
          addEdge,
          fileNodeId,
          parentSymbol: currentParent,
        });
      }
    }
  }
}

function createSymbolNode(
  node: ts.Node,
  filePath: string,
  checker: ts.TypeChecker,
  parentSymbol?: SymbolGraphNode,
): SymbolGraphNode | undefined {
  const info = describeDeclaration(node, checker, parentSymbol);
  if (!info) return undefined;
  return {
    id: symbolNodeId(filePath, info.qualifiedName, node),
    kind: "symbol",
    filePath,
    symbol: info.symbol,
    qualifiedName: info.qualifiedName,
    symbolKind: info.kind,
    exported: info.exported,
    language: filePath.toLowerCase().includes(".ts") ? "typescript" : "javascript",
    adapter: "typescript",
    capabilityLevel: "exact",
    sourceKind: "parser",
    confidence: 0.95,
    range: { start: node.getStart(), end: node.getEnd() },
    stale: false,
  };
}

function describeDeclaration(
  node: ts.Node,
  checker: ts.TypeChecker,
  parentSymbol?: SymbolGraphNode,
): { symbol: string; qualifiedName: string; kind: SymbolKind; exported: boolean } | undefined {
  const exported = hasExportModifier(node);
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { symbol: node.name.text, qualifiedName: node.name.text, kind: "function", exported };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { symbol: node.name.text, qualifiedName: node.name.text, kind: "class", exported };
  }
  if (ts.isMethodDeclaration(node) && isNamedDeclaration(node)) {
    const methodName = declarationName(node);
    if (!methodName) return undefined;
    const parentName = parentSymbol?.qualifiedName ?? "anonymous";
    return {
      symbol: methodName,
      qualifiedName: `${parentName}.${methodName}`,
      kind: "method",
      exported: false,
    };
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations.find((item) => ts.isIdentifier(item.name));
    if (!decl || !ts.isIdentifier(decl.name)) return undefined;
    const isTypeLike =
      decl.initializer != null &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
    return {
      symbol: decl.name.text,
      qualifiedName: decl.name.text,
      kind: isTypeLike ? "function" : "variable",
      exported,
    };
  }
  if (ts.isInterfaceDeclaration(node) && node.name) {
    return { symbol: node.name.text, qualifiedName: node.name.text, kind: "type", exported };
  }
  if (ts.isTypeAliasDeclaration(node) && node.name) {
    return { symbol: node.name.text, qualifiedName: node.name.text, kind: "type", exported };
  }
  if (ts.isEnumDeclaration(node) && node.name) {
    return { symbol: node.name.text, qualifiedName: node.name.text, kind: "type", exported };
  }
  if (ts.isPropertyDeclaration(node) && isNamedDeclaration(node)) {
    const prop = declarationName(node);
    if (!prop) return undefined;
    const parentName = parentSymbol?.qualifiedName ?? "anonymous";
    return {
      symbol: prop,
      qualifiedName: `${parentName}.${prop}`,
      kind: "variable",
      exported: false,
    };
  }
  // Allow exported const foo = () => {} to be resolved via the variable statement.
  void checker;
  return undefined;
}

function collectFileEdges(
  sourceFile: ts.SourceFile,
  filePath: string,
  fileNodeByPath: Map<string, FileGraphNode>,
  compilerOptions: ts.CompilerOptions,
  addEdge: (edge: Omit<GraphEdge, "id">) => void,
) {
  const fileNode = fileNodeByPath.get(filePath);
  if (!fileNode) return;
  for (const statement of sourceFile.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
      const specifier = statement.moduleSpecifier.getText(sourceFile).slice(1, -1);
      const resolved = resolveModule(filePath, specifier, compilerOptions);
      const targetNode = resolved ? fileNodeByPath.get(resolved) : undefined;
      if (!targetNode) continue;
      addEdge({
        from: fileNode.id,
        to: targetNode.id,
        kind: ts.isImportDeclaration(statement) ? "imports" : "exports",
        filePath,
        reason: specifier,
        language: fileNode.language,
        adapter: "typescript",
        capabilityLevel: "exact",
        sourceKind: "parser",
        confidence: 0.95,
      });
    }
  }
}

function collectSymbolEdges(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  symbolByDeclKey: Map<string, SymbolGraphNode>,
  addEdge: (edge: Omit<GraphEdge, "id">) => void,
) {
  const sourceFilePath = path.resolve(sourceFile.fileName);
  const currentStack: SymbolGraphNode[] = [];

  const visit = (node: ts.Node) => {
    const maybeDeclared = symbolByDeclKey.get(declKey(node));
    if (maybeDeclared) currentStack.push(maybeDeclared);

    const current = currentStack[currentStack.length - 1];
    if (current && ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      let targetNode: SymbolGraphNode | undefined;
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        const signatureDecl = checker.getResolvedSignature(parent)?.declaration;
        if (signatureDecl) targetNode = symbolByDeclKey.get(declKey(signatureDecl));
        if (targetNode && targetNode.id !== current.id) {
          addEdge({
            from: current.id,
            to: targetNode.id,
            kind: "calls",
            filePath: sourceFilePath,
            symbolName: targetNode.qualifiedName,
            reason: node.text,
            language: current.language,
            adapter: "typescript",
            capabilityLevel: "exact",
            sourceKind: "parser",
            confidence: 0.95,
          });
        }
      } else {
        targetNode = resolveTrackedSymbol(node, checker, symbolByDeclKey);
        if (targetNode && targetNode.id !== current.id) {
          addEdge({
            from: current.id,
            to: targetNode.id,
            kind: "references",
            filePath: sourceFilePath,
            symbolName: targetNode.qualifiedName,
            reason: node.text,
            language: current.language,
            adapter: "typescript",
            capabilityLevel: "exact",
            sourceKind: "parser",
            confidence: 0.9,
          });
        }
      }
    }

    if (ts.isClassLike(node) && node.heritageClauses && currentStack[currentStack.length - 1]) {
      for (const clause of node.heritageClauses) {
        for (const item of clause.types) {
          const targetNode = resolveTrackedSymbol(item.expression, checker, symbolByDeclKey);
          if (!targetNode) continue;
          addEdge({
            from: currentStack[currentStack.length - 1].id,
            to: targetNode.id,
            kind: clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements",
            filePath: sourceFilePath,
            symbolName: targetNode.qualifiedName,
            reason: item.getText(sourceFile),
            language: currentStack[currentStack.length - 1].language,
            adapter: "typescript",
            capabilityLevel: "exact",
            sourceKind: "parser",
            confidence: 0.95,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
    if (maybeDeclared) currentStack.pop();
  };

  visit(sourceFile);
}

function resolveTrackedSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
  symbolByDeclKey: Map<string, SymbolGraphNode>,
): SymbolGraphNode | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const declaration of symbol.declarations ?? []) {
    const found = symbolByDeclKey.get(declKey(declaration));
    if (found) return found;
  }
  return undefined;
}

function resolveCompilerOptions(cwd: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
      return {
        ...parsed.options,
        allowJs: true,
        checkJs: false,
        noEmit: true,
      };
    }
  }
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  };
}

function resolveModule(filePath: string, specifier: string, options: ts.CompilerOptions): string | undefined {
  const resolved = ts.resolveModuleName(specifier, filePath, options, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  const normalized = path.resolve(resolved);
  return normalized.endsWith(".d.ts") ? undefined : normalized;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function isNamedDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return "name" in node;
}

function declarationName(node: ts.NamedDeclaration): string | undefined {
  const name = node.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if ("name" in parent && (parent as ts.NamedDeclaration).name === node) return true;
  return false;
}

function declKey(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  return `${path.resolve(sourceFile.fileName)}:${node.getStart(sourceFile)}:${node.getEnd()}:${ts.SyntaxKind[node.kind]}`;
}

function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

function symbolNodeId(filePath: string, qualifiedName: string, node: ts.Node): string {
  return `symbol:${filePath}:${qualifiedName}:${node.getStart()}`;
}

function hashish(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
