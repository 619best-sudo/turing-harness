export type GraphNodeKind = "file" | "symbol";
export type SymbolKind = "function" | "class" | "method" | "type" | "variable" | "module" | "unknown";
export type GraphCapabilityLevel = "exact" | "partial" | "file_only";
export type GraphSourceKind = "parser" | "manifest" | "convention";
export type GraphEdgeKind =
  | "imports"
  | "exports"
  | "defines"
  | "references"
  | "calls"
  | "extends"
  | "implements"
  | "contains";

export interface FileGraphNode {
  id: string;
  kind: "file";
  path: string;
  relativePath: string;
  language?: string;
  framework?: string;
  adapter?: string;
  capabilityLevel?: GraphCapabilityLevel;
  sourceKind?: GraphSourceKind;
  confidence?: number;
  contentHash: string;
  lastModifiedMs: number;
  stale: boolean;
  staleReason?: string;
}

export interface SymbolGraphNode {
  id: string;
  kind: "symbol";
  filePath: string;
  symbol: string;
  qualifiedName: string;
  symbolKind: SymbolKind;
  exported: boolean;
  language?: string;
  framework?: string;
  adapter?: string;
  capabilityLevel?: GraphCapabilityLevel;
  sourceKind?: GraphSourceKind;
  confidence?: number;
  range?: { start: number; end: number };
  stale: boolean;
  staleReason?: string;
}

export type GraphNode = FileGraphNode | SymbolGraphNode;

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  filePath?: string;
  symbolName?: string;
  reason?: string;
  language?: string;
  framework?: string;
  adapter?: string;
  capabilityLevel?: GraphCapabilityLevel;
  sourceKind?: GraphSourceKind;
  confidence?: number;
}

export interface FileGraphIndex {
  fileNodeId: string;
  symbolNodeIds: string[];
}

export interface GraphMemoryData {
  version: number;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  byFile: Record<string, FileGraphIndex>;
}

export interface GraphProjectContext {
  cwd: string;
  filePaths: string[];
  relativePaths: Record<string, string>;
  category?: string;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  runtime?: string[];
  filesByExtension: Record<string, string[]>;
  manifests: Record<string, string>;
}

export interface GraphExtractionResult {
  fileNode: FileGraphNode;
  symbolNodes: SymbolGraphNode[];
  edges: GraphEdge[];
}

export interface GraphAdapter {
  name: string;
  languages: string[];
  extensions: string[];
  supportsFileGraph: boolean;
  supportsSymbolGraph: boolean;
  capabilityLevel: GraphCapabilityLevel;
  canHandle(filePath: string, projectContext: GraphProjectContext): boolean;
  extractProject(args: {
    cwd: string;
    filePaths: string[];
    projectContext: GraphProjectContext;
  }): Promise<GraphExtractionResult[]>;
}

export interface FrameworkGraphOverlay {
  name: string;
  frameworks: string[];
  applies(projectContext: GraphProjectContext): boolean;
  apply(args: {
    projectContext: GraphProjectContext;
    nodes: Record<string, GraphNode>;
    edges: GraphEdge[];
    byFile: Record<string, FileGraphIndex>;
  }): Promise<GraphEdge[]>;
}
