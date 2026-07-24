import * as path from "node:path";

export const SUPPORTED_FILE_MEMORY_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "ruby",
  "dart",
  "php",
  "csharp",
  "swift",
  "scala",
  "elixir",
  "clojure",
  "haskell",
  "lua",
  "perl",
  "r",
  "zig",
] as const;

export const FILE_MEMORY_FRAMEWORK_HINTS: Array<{ framework: string; patterns: string[] }> = [
  { framework: "react", patterns: ["react"] },
  { framework: "react-dom", patterns: ["react-dom"] },
  { framework: "next", patterns: ["next"] },
  { framework: "vue", patterns: ["vue"] },
  { framework: "nuxt", patterns: ["nuxt"] },
  { framework: "svelte", patterns: ["svelte"] },
  { framework: "angular", patterns: ["@angular", "angular"] },
  { framework: "astro", patterns: ["astro"] },
  { framework: "vite", patterns: ["vite"] },
  { framework: "solid-js", patterns: ["solid-js"] },
  { framework: "gatsby", patterns: ["gatsby"] },
  { framework: "remix", patterns: ["@remix-run", "remix"] },
  { framework: "qwik", patterns: ["@builder.io/qwik", "qwik"] },
  { framework: "express", patterns: ["express"] },
  { framework: "fastify", patterns: ["fastify"] },
  { framework: "nestjs", patterns: ["@nestjs", "nestjs"] },
  { framework: "koa", patterns: ["koa"] },
  { framework: "hapi", patterns: ["@hapi/hapi", "hapi"] },
  { framework: "trpc", patterns: ["@trpc/server", "@trpc"] },
  { framework: "adonisjs", patterns: ["adonisjs", "@adonisjs"] },
  { framework: "django", patterns: ["django"] },
  { framework: "flask", patterns: ["flask"] },
  { framework: "fastapi", patterns: ["fastapi"] },
  { framework: "starlette", patterns: ["starlette"] },
  { framework: "aiohttp", patterns: ["aiohttp"] },
  { framework: "sanic", patterns: ["sanic"] },
  { framework: "falcon", patterns: ["falcon"] },
  { framework: "tornado", patterns: ["tornado"] },
  { framework: "spring", patterns: ["spring"] },
  { framework: "micronaut", patterns: ["micronaut"] },
  { framework: "quarkus", patterns: ["quarkus"] },
  { framework: "ktor", patterns: ["ktor", "io.ktor"] },
  { framework: "laravel", patterns: ["laravel"] },
  { framework: "symfony", patterns: ["symfony"] },
  { framework: "rails", patterns: ["rails"] },
  { framework: "sinatra", patterns: ["sinatra"] },
  { framework: "phoenix", patterns: ["phoenix"] },
  { framework: "aspnet", patterns: ["aspnet", "microsoft.aspnetcore", "webapplication.createbuilder", "microsoft.net.sdk.web"] },
  { framework: "flutter", patterns: ["flutter"] },
  { framework: "expo", patterns: ["expo"] },
  { framework: "react-native", patterns: ["react-native"] },
  { framework: "ionic/capacitor", patterns: ["@ionic", "@capacitor", "capacitor", "ionic"] },
  { framework: "godot", patterns: ["godot", "project.godot"] },
  { framework: "unity", patterns: ["unity", "projectsettings", "assets/"] },
  { framework: "unreal", patterns: ["unreal", ".uproject"] },
  { framework: "phaser", patterns: ["phaser"] },
  { framework: "bevy", patterns: ["bevy"] },
];

export const SUPPORTED_FILE_MEMORY_FRAMEWORKS = FILE_MEMORY_FRAMEWORK_HINTS.map((hint) => hint.framework);

export interface FileSemanticSignals {
  language?: string;
  frameworks: string[];
  keySymbols: string[];
  dependencies: string[];
  routes: string[];
  interfaces: string[];
  responsibilities: string[];
  domainTerms: string[];
  keywords: string[];
}

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".rb", "ruby"],
  [".dart", "dart"],
  [".php", "php"],
  [".cs", "csharp"],
  [".swift", "swift"],
  [".scala", "scala"],
  [".ex", "elixir"],
  [".exs", "elixir"],
  [".clj", "clojure"],
  [".cljs", "clojure"],
  [".cljc", "clojure"],
  [".edn", "clojure"],
  [".hs", "haskell"],
  [".lhs", "haskell"],
  [".lua", "lua"],
  [".pl", "perl"],
  [".pm", "perl"],
  [".r", "r"],
  [".R", "r"],
  [".zig", "zig"],
  [".json", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "toml"],
  [".xml", "xml"],
]);

const KEY_SYMBOL_PATTERNS: RegExp[] = [
  /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/gm,
  /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*(?:public|private|protected|internal)?\s*(?:class|interface|record|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
  /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?[A-Za-z0-9_<>, ?[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/gm,
  /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
  /^\s*(?:module|class)\s+([A-Za-z_][A-Za-z0-9_:]*)\b/gm,
  /^\s*sub\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm,
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*<-\s*function\s*\(/gm,
  /^\s*(?:class|enum|mixin|extension|protocol|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm,
  /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
  /^\s*defmodule\s+([A-Za-z_][A-Za-z0-9_.]*)\s+do/gm,
  /^\s*def(?:p)?\s+([a-z_][A-Za-z0-9_!?]*)/gm,
  /^\s*\(defn\s+([A-Za-z_][A-Za-z0-9_-]*)/gm,
  /^\s*\(defrecord\s+([A-Za-z_][A-Za-z0-9_-]*)/gm,
  /^\s*data\s+([A-Za-z_][A-Za-z0-9_']*)/gm,
  /^\s*newtype\s+([A-Za-z_][A-Za-z0-9_']*)/gm,
  /^\s*function\s+([A-Za-z_][A-Za-z0-9_.:]*)/gm,
  /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_.:]*)/gm,
  /^\s*pub\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*import\s+.+?\s+from\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*export\s+.+?\s+from\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*const\s+[A-Za-z0-9_]+\s*=\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/gm,
  /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm,
  /^\s*import\s+([A-Za-z0-9_.,\s]+)/gm,
  /^\s*use\s+([A-Za-z0-9_:\\]+)/gm,
  /^\s*require\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*include(?:_once)?\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*using\s+([A-Za-z0-9_.]+)/gm,
  /^\s*import\s+([A-Za-z0-9_.*]+)/gm,
  /^\s*part\s+["'`]([^"'`]+)["'`]/gm,
  /^\s*library\(\s*([A-Za-z0-9_.]+)\s*\)/gm,
  /^\s*const\s+[A-Za-z0-9_]+\s*=\s*@import\(\s*"([^"]+)"\s*\)/gm,
];

const ROUTE_PATTERNS: RegExp[] = [
  /(?:router|app)\.(?:get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)["'`]/g,
  /Route::(?:get|post|put|patch|delete|resource)\(\s*["'`]([^"'`]+)["'`]/g,
  /path\(\s*["'`]([^"'`]+)["'`]/g,
  /@(Get|Post|Put|Patch|Delete|RequestMapping)\(\s*["'`]([^"'`]+)["'`]/g,
  /(?:get|post|put|patch|delete)\s+["'`]([^"'`]+)["'`]/gi,
];

export function analyzeFileSemantics(
  relativePath: string,
  text: string,
  role: string,
  tags: string[],
): FileSemanticSignals {
  const language = inferLanguageFromPath(relativePath);
  const frameworks = inferFrameworkHints(relativePath, text);
  const keySymbols = extractKeySymbols(text);
  const dependencies = extractDependencies(relativePath, text);
  const routes = extractRoutes(text);
  const domainTerms = extractDomainTerms(relativePath, keySymbols);
  const responsibilities = inferResponsibilities(relativePath, role, text, frameworks, routes, keySymbols);
  const interfaces = extractInterfaces(relativePath, text, keySymbols, routes);
  const keywords = dedupeStrings([
    ...tags,
    language ?? "",
    ...frameworks,
    ...keySymbols,
    ...dependencies.map(lastSegment),
    ...routes.map((route) => route.replace(/^\/+/, "").split("/")[0] || route),
    ...interfaces.map(lastSegment),
    ...responsibilities,
    ...domainTerms,
  ]).slice(0, 24);
  return {
    language,
    frameworks,
    keySymbols: keySymbols.slice(0, 12),
    dependencies: dependencies.slice(0, 12),
    routes: routes.slice(0, 8),
    interfaces: interfaces.slice(0, 12),
    responsibilities: responsibilities.slice(0, 6),
    domainTerms: domainTerms.slice(0, 10),
    keywords,
  };
}

export function composeSemanticSummary(
  relativePath: string,
  baseSummary: string,
  signals: FileSemanticSignals,
): string {
  const base = path.basename(relativePath);
  const phrases = [normalizeSentence(baseSummary)];
  if (signals.frameworks.length || signals.language) {
    const tech = [signals.language, ...signals.frameworks].filter(Boolean).slice(0, 4).join(", ");
    if (tech) phrases.push(`${base} is implemented in ${tech}`);
  }
  if (signals.responsibilities.length) {
    phrases.push(`Primary responsibilities include ${signals.responsibilities.slice(0, 5).join(", ")}`);
  }
  if (signals.keySymbols.length) {
    phrases.push(`Key symbols and entrypoints include ${signals.keySymbols.slice(0, 8).join(", ")}`);
  }
  if (signals.dependencies.length) {
    phrases.push(`Key dependencies or imported modules include ${signals.dependencies.slice(0, 8).join(", ")}`);
  }
  if (signals.routes.length) {
    phrases.push(`Route or interface surface includes ${signals.routes.slice(0, 6).join(", ")}`);
  } else if (signals.interfaces.length) {
    phrases.push(`Public surface includes ${signals.interfaces.slice(0, 8).join(", ")}`);
  }
  if (signals.domainTerms.length) {
    phrases.push(`Domain concepts referenced here include ${signals.domainTerms.slice(0, 8).join(", ")}`);
  }
  return cleanSummary(phrases.filter(Boolean).join(". "), 180);
}

export function inferLanguageFromPath(relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();
  const base = path.basename(lower);
  const ext = path.extname(relativePath);
  if (LANGUAGE_BY_EXTENSION.has(ext)) return LANGUAGE_BY_EXTENSION.get(ext);
  if (base === "package.swift") return "swift";
  if (base === "cargo.toml") return "rust";
  if (base === "go.mod") return "go";
  if (base === "gemfile") return "ruby";
  if (base === "composer.json") return "php";
  if (base === "mix.exs") return "elixir";
  if (base === "build.sbt") return "scala";
  if (base === "deps.edn" || base === "project.clj") return "clojure";
  if (base === "build.zig") return "zig";
  if (base === "cpanfile" || base === "makefile.pl") return "perl";
  if (base === "description" || base === "renv.lock") return "r";
  if (base === "stack.yaml" || base.endsWith(".cabal")) return "haskell";
  if (base.endsWith(".rockspec")) return "lua";
  if (base.endsWith(".csproj") || base.endsWith(".sln")) return "csharp";
  if (base === "pyproject.toml" || base === "requirements.txt") return "python";
  if (base === "pom.xml" || base === "build.gradle" || base === "build.gradle.kts") return "java";
  if (base === "pubspec.yaml") return "dart";
  return undefined;
}

export function inferFrameworkHints(relativePath: string, text: string): string[] {
  const haystacks = `${relativePath.toLowerCase()}\n${text.toLowerCase()}`;
  return FILE_MEMORY_FRAMEWORK_HINTS
    .filter((hint) => hint.patterns.some((pattern) => haystacks.includes(pattern.toLowerCase())))
    .map((hint) => hint.framework);
}

function extractKeySymbols(text: string): string[] {
  const found: string[] = [];
  for (const pattern of KEY_SYMBOL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) found.push(value);
    }
  }
  return dedupeStrings(found);
}

function extractDependencies(relativePath: string, text: string): string[] {
  const base = path.basename(relativePath).toLowerCase();
  const collected: string[] = [];
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      collected.push(...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {}));
    } catch {
      // Ignore malformed manifests and continue with regex extraction.
    }
  }
  if (base === "composer.json") {
    try {
      const parsed = JSON.parse(text) as { require?: Record<string, string> };
      collected.push(...Object.keys(parsed.require ?? {}));
    } catch {
      // Ignore malformed manifests and continue with regex extraction.
    }
  }
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      collected.push(...raw.split(",").map((value) => value.trim()));
    }
  }
  return dedupeStrings(
    collected
      .map((value) => value.replace(/^['"`]+|['"`]+$/g, ""))
      .map((value) => value.replace(/^package:[^/]+\//, ""))
      .map((value) => value.replace(/\.\*$/, ""))
      .filter(Boolean),
  );
}

function extractRoutes(text: string): string[] {
  const routes: string[] = [];
  for (const pattern of ROUTE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[2] ?? match[1] ?? "").trim();
      if (raw) routes.push(raw);
    }
  }
  return dedupeStrings(routes);
}

function extractInterfaces(
  relativePath: string,
  text: string,
  keySymbols: string[],
  routes: string[],
): string[] {
  const interfaces = [...routes.map((route) => `route:${route}`)];
  const base = path.basename(relativePath).toLowerCase();
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
      interfaces.push(...Object.keys(parsed.scripts ?? {}).map((name) => `script:${name}`));
    } catch {
      // Ignore malformed package manifests.
    }
  }
  if (/(config|settings|appsettings|\.env|tsconfig|package\.swift|cargo\.toml|go\.mod|pubspec\.yaml|mix\.exs|build\.sbt|pom\.xml|build\.gradle)/i.test(relativePath)) {
    interfaces.push("configuration");
  }
  interfaces.push(...keySymbols.slice(0, 6).map((symbol) => `symbol:${symbol}`));
  return dedupeStrings(interfaces);
}

function inferResponsibilities(
  relativePath: string,
  role: string,
  text: string,
  frameworks: string[],
  routes: string[],
  keySymbols: string[],
): string[] {
  const lowerPath = relativePath.toLowerCase();
  const lowerText = text.toLowerCase();
  const out = new Set<string>();
  if (role) out.add(role);
  if (routes.length) out.add("route handling");
  if (/(controller|controllers|views)/.test(lowerPath)) out.add("request handling");
  if (/(service|services|provider|providers)/.test(lowerPath)) out.add("business logic");
  if (/(model|models|entity|entities|schema|migration|repository|repositories|dao|prisma|database|sql)/.test(lowerPath)) out.add("data modeling");
  if (/(component|components|page|pages|screen|screens|widget|widgets|layout|layouts)/.test(lowerPath)) out.add("ui rendering");
  if (/(router|routes|urls)/.test(lowerPath) || /router\.|route::|requestmapping|urlpatterns/.test(lowerText)) out.add("routing");
  if (/(test|spec)/.test(lowerPath)) out.add("test coverage");
  if (/(config|settings|appsettings|tsconfig|package\.json|pom\.xml|build\.gradle|cargo\.toml|go\.mod|pubspec\.yaml|mix\.exs)/.test(lowerPath)) out.add("configuration");
  if (/(scene|system|godot|unity|uproject|bevy|phaser)/.test(lowerPath) || frameworks.some((value) => ["godot", "unity", "unreal", "phaser", "bevy"].includes(value))) out.add("game runtime");
  if (/(navigation|router|routes)/.test(lowerPath) && frameworks.some((value) => ["flutter", "expo", "react-native", "ionic/capacitor"].includes(value))) out.add("navigation");
  if (!out.size && keySymbols.length) out.add("module api");
  return [...out];
}

function extractDomainTerms(relativePath: string, keySymbols: string[]): string[] {
  const stopWords = new Set([
    "src",
    "app",
    "main",
    "index",
    "config",
    "components",
    "component",
    "service",
    "services",
    "controller",
    "controllers",
    "model",
    "models",
    "routes",
    "route",
    "router",
    "page",
    "pages",
    "screen",
    "screens",
    "widget",
    "widgets",
    "file",
    "test",
    "spec",
  ]);
  return dedupeStrings([...tokenize(relativePath), ...keySymbols.flatMap(tokenize)]).filter(
    (value) => value.length >= 3 && !stopWords.has(value),
  );
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function lastSegment(value: string): string {
  return value.split(/[/:.]/).filter(Boolean).at(-1) ?? value;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
}

function cleanSummary(value: string, maxWords = 180): string {
  const trimmed = normalizeSentence(value);
  const words = trimmed.split(" ").filter(Boolean);
  const limited = words.length > maxWords ? words.slice(0, maxWords).join(" ") : trimmed;
  return limited ? `${limited}.` : "";
}
