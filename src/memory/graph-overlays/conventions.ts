import * as path from "node:path";
import type { FileGraphIndex, GraphEdge, GraphNode, GraphProjectContext, FrameworkGraphOverlay } from "../graph-adapters/base.js";

export function createFrameworkOverlays(): FrameworkGraphOverlay[] {
  return [
    createOverlay("node-web", ["react", "next", "vue", "nuxt", "svelte", "angular", "astro", "vite", "solid-js", "gatsby", "remix", "qwik"], applyNodeWebOverlay),
    createOverlay("node-backend", ["express", "fastify", "nestjs", "koa"], applyNodeBackendOverlay),
    createOverlay("python-web", ["django", "flask", "fastapi"], applyPythonWebOverlay),
    createOverlay("php-web", ["laravel", "symfony"], applyPhpWebOverlay),
    createOverlay("ruby-web", ["rails", "sinatra"], applyRubyWebOverlay),
    createOverlay("jvm-backend", ["spring", "micronaut", "quarkus", "ktor", "aspnet"], applyJvmBackendOverlay),
    createOverlay("elixir-web", ["phoenix"], applyElixirOverlay),
    createOverlay("mobile", ["flutter", "expo", "react-native", "ionic/capacitor"], applyMobileOverlay),
    createOverlay("games", ["godot", "unity", "unreal", "phaser", "bevy"], applyGamesOverlay),
  ];
}

function createOverlay(
  name: string,
  frameworks: string[],
  applyFn: FrameworkGraphOverlay["apply"],
): FrameworkGraphOverlay {
  return {
    name,
    frameworks,
    applies(projectContext) {
      return frameworks.some((framework) => projectContext.frameworks.includes(framework));
    },
    apply: applyFn,
  };
}

async function applyNodeWebOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const pages = findFiles(args.projectContext, /(pages|app|routes|src\/pages|src\/app)\//);
  const layouts = findFiles(args.projectContext, /(layout|_layout|app\.tsx|app\.jsx|app\.vue|app\.svelte)/);
  const components = findFiles(args.projectContext, /(components|ui)\//);
  for (const page of pages) {
    for (const layout of closestByDir(page, layouts)) edges.push(edge(args, page, layout, "convention", "page uses layout"));
    for (const component of closestByDir(page, components, 2)) edges.push(edge(args, page, component, "convention", "page uses component"));
  }
  return dedupeEdges(edges);
}

async function applyNodeBackendOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const routes = findFiles(args.projectContext, /(routes|router)/);
  const controllers = findFiles(args.projectContext, /(controller|controllers)/);
  const services = findFiles(args.projectContext, /(service|services|provider|providers)/);
  const models = findFiles(args.projectContext, /(model|models|entity|entities|repository|repositories)/);
  for (const route of routes) {
    for (const controller of closestByDir(route, controllers)) edges.push(edge(args, route, controller, "convention", "route dispatches controller"));
  }
  for (const controller of controllers) {
    for (const service of closestByDir(controller, services)) edges.push(edge(args, controller, service, "convention", "controller uses service"));
    for (const model of closestByDir(controller, models, 2)) edges.push(edge(args, controller, model, "convention", "controller reaches model"));
  }
  return dedupeEdges(edges);
}

async function applyPythonWebOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const urls = findFiles(args.projectContext, /(urls\.py|router\.py|routers\.py|main\.py)/);
  const views = findFiles(args.projectContext, /(views\.py|api\.py|controller|controllers)/);
  const models = findFiles(args.projectContext, /(models\.py|schemas\.py|serializers\.py)/);
  for (const file of urls) {
    for (const view of closestByDir(file, views)) edges.push(edge(args, file, view, "convention", "routes point to views"));
  }
  for (const view of views) {
    for (const model of closestByDir(view, models)) edges.push(edge(args, view, model, "convention", "views use models"));
  }
  return dedupeEdges(edges);
}

async function applyPhpWebOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const routes = findFiles(args.projectContext, /(routes\/web\.php|routes\/api\.php|config\/routes)/);
  const controllers = findFiles(args.projectContext, /(controller|controllers)/);
  const models = findFiles(args.projectContext, /(model|models|entity|entities)/);
  for (const route of routes) {
    for (const controller of closestByDir(route, controllers, 4)) edges.push(edge(args, route, controller, "convention", "routes dispatch controllers"));
  }
  for (const controller of controllers) {
    for (const model of closestByDir(controller, models, 3)) edges.push(edge(args, controller, model, "convention", "controllers use models"));
  }
  return dedupeEdges(edges);
}

async function applyRubyWebOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const routes = findFiles(args.projectContext, /(config\/routes\.rb)/);
  const controllers = findFiles(args.projectContext, /(controllers)/);
  const models = findFiles(args.projectContext, /(models)/);
  for (const route of routes) {
    for (const controller of closestByDir(route, controllers, 4)) edges.push(edge(args, route, controller, "convention", "routes dispatch controllers"));
  }
  for (const controller of controllers) {
    for (const model of closestByDir(controller, models, 4)) edges.push(edge(args, controller, model, "convention", "controllers use models"));
  }
  return dedupeEdges(edges);
}

async function applyJvmBackendOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const configs = findFiles(args.projectContext, /(application\.(properties|ya?ml)|appsettings\.json|program\.cs|startup\.cs)/);
  const controllers = findFiles(args.projectContext, /(controller|controllers)/);
  const services = findFiles(args.projectContext, /(service|services)/);
  const repositories = findFiles(args.projectContext, /(repository|repositories|dao)/);
  for (const config of configs) {
    for (const controller of closestByDir(config, controllers, 6)) edges.push(edge(args, config, controller, "convention", "runtime config loads controllers"));
  }
  for (const controller of controllers) {
    for (const service of closestByDir(controller, services, 4)) edges.push(edge(args, controller, service, "convention", "controller uses service"));
  }
  for (const service of services) {
    for (const repo of closestByDir(service, repositories, 4)) edges.push(edge(args, service, repo, "convention", "service uses repository"));
  }
  return dedupeEdges(edges);
}

async function applyElixirOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const router = findFiles(args.projectContext, /(router\.ex)/);
  const controllers = findFiles(args.projectContext, /(controller|controllers|live)/);
  for (const file of router) {
    for (const controller of closestByDir(file, controllers, 5)) edges.push(edge(args, file, controller, "convention", "router dispatches phoenix controller/live view"));
  }
  return dedupeEdges(edges);
}

async function applyMobileOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const entries = findFiles(args.projectContext, /(main\.dart|app\.(tsx|jsx|js|ts)|main\.(tsx|jsx|js|ts))/);
  const screens = findFiles(args.projectContext, /(screen|screens|page|pages|view|views|widget|widgets)/);
  const navigation = findFiles(args.projectContext, /(nav|navigation|router|routes)/);
  for (const entryFile of entries) {
    for (const nav of closestByDir(entryFile, navigation, 4)) edges.push(edge(args, entryFile, nav, "convention", "entry wires navigation"));
    for (const screen of closestByDir(entryFile, screens, 3)) edges.push(edge(args, entryFile, screen, "convention", "entry reaches screens"));
  }
  for (const nav of navigation) {
    for (const screen of closestByDir(nav, screens, 4)) edges.push(edge(args, nav, screen, "convention", "navigation reaches screens"));
  }
  return dedupeEdges(edges);
}

async function applyGamesOverlay(args: OverlayArgs): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  const scenes = findFiles(args.projectContext, /(\.tscn$|scene|scenes|project\.godot|\.unity$|\.uproject$)/);
  const scripts = findFiles(args.projectContext, /(\.gd$|script|scripts|system|systems|main\.rs|main\.ts|main\.js)/);
  for (const scene of scenes) {
    for (const script of closestByDir(scene, scripts, 6)) edges.push(edge(args, scene, script, "convention", "scene/config references script/system"));
  }
  return dedupeEdges(edges);
}

interface OverlayArgs {
  projectContext: GraphProjectContext;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  byFile: Record<string, FileGraphIndex>;
}

function edge(args: OverlayArgs, fromPath: string, toPath: string, sourceKind: "convention", reason: string): GraphEdge {
  const from = args.byFile[fromPath]?.fileNodeId ?? `file:${fromPath}`;
  const to = args.byFile[toPath]?.fileNodeId ?? `file:${toPath}`;
  return {
    id: `edge:overlay:${hashish(`${from}|${to}|${reason}`)}`,
    from,
    to,
    kind: "references",
    filePath: fromPath,
    reason,
    sourceKind,
    capabilityLevel: "file_only",
    confidence: 0.5,
  };
}

function findFiles(projectContext: GraphProjectContext, pattern: RegExp): string[] {
  return projectContext.filePaths.filter((filePath) => pattern.test(filePath.replace(/\\/g, "/")));
}

function closestByDir(filePath: string, candidates: string[], maxDepth = 3): string[] {
  const baseDir = path.dirname(filePath);
  return candidates.filter((candidate) => {
    const rel = path.relative(baseDir, candidate).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return rel.split("/").length - 1 <= maxDepth;
    return rel.split("/").length - 1 <= maxDepth;
  }).slice(0, 4);
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hashish(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}
