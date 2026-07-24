/**
 * Project tech-stack detection.
 *
 * Inspects a project directory's manifests and engine files to infer its category
 * (frontend / mobile / games / backend) and tech stack. Used by {@link ProjectMemory}
 * to seed a project's memory on first initialization, which in turn selects the 4P
 * preset.
 *
 * Pure Node fs; no network. Best-effort with a confidence score — the result can be
 * overridden by the caller.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectCategory } from "../presets/project-presets.js";

const FRONTEND_NODE_FRAMEWORKS = [
  "next",
  "nuxt",
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@sveltejs/kit",
  "@angular/core",
  "solid-js",
  "astro",
  "vite",
  "gatsby",
  "remix",
  "@builder.io/qwik",
];
const NODE_BACKEND_FRAMEWORKS = [
  "express",
  "fastify",
  "@nestjs/core",
  "koa",
  "@hapi/hapi",
  "hapi",
  "@trpc/server",
  "adonisjs",
];
const PYTHON_BACKEND_FRAMEWORKS = ["django", "flask", "fastapi", "starlette", "aiohttp", "sanic", "falcon", "tornado"];
const JVM_BACKEND_FRAMEWORKS = ["spring", "micronaut", "quarkus", "ktor"];
const PHP_FRAMEWORKS = ["laravel", "symfony"];
const RUBY_FRAMEWORKS = ["rails", "sinatra"];

export interface TechStack {
  /** Programming languages, e.g. ["typescript", "javascript"]. */
  languages: string[];
  /** Frameworks/libraries, e.g. ["next", "react"] or ["express"]. */
  frameworks: string[];
  /** Package/dependency manager, e.g. "npm" | "pnpm" | "pip" | "cargo" | "gradle". */
  packageManager?: string;
  /** Game engine when category is "games". */
  engine?: "godot" | "unity" | "unreal";
  /** Language runtimes, e.g. ["node"], ["python"]. */
  runtime?: string[];
}

export interface ProjectDetection {
  category: ProjectCategory;
  stack: TechStack;
  /** Human-readable signals that drove the decision. */
  evidence: string[];
  /** 0..1 confidence in the category. */
  confidence: number;
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson(p: string): Promise<Record<string, any> | undefined> {
  const t = await readText(p);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return undefined;
  }
}

/** Detect a project's category + stack from its files. */
export async function detectProject(cwd: string): Promise<ProjectDetection> {
  const entries = await fs.readdir(cwd).catch(() => [] as string[]);
  const lowerEntries = entries.map((entry) => entry.toLowerCase());
  const set = new Set(entries);
  const lowerSet = new Set(lowerEntries);
  const has = (f: string) => set.has(f);
  const hasLower = (f: string) => lowerSet.has(f.toLowerCase());
  const endsWithAny = (suffix: string) => lowerEntries.some((entry) => entry.endsWith(suffix.toLowerCase()));

  const pkg = await readJson(path.join(cwd, "package.json"));
  const composer = await readJson(path.join(cwd, "composer.json"));
  const pkgDeps: Record<string, string> = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const composerDeps: Record<string, string> = {
    ...composer?.require,
    ...composer?.["require-dev"],
  };
  const pkgDep = (name: string) => name in pkgDeps;
  const composerDep = (name: string) =>
    name in composerDeps || Object.keys(composerDeps).some((dep) => dep === name || dep.startsWith(`${name}/`) || dep.startsWith(`${name}:`));
  const anyPkgDep = (...names: string[]) => names.some(pkgDep);

  const pyproject = await readText(path.join(cwd, "pyproject.toml"));
  const requirements = await readText(path.join(cwd, "requirements.txt"));
  const cargo = await readText(path.join(cwd, "Cargo.toml"));
  const pubspec = await readText(path.join(cwd, "pubspec.yaml"));
  const mix = await readText(path.join(cwd, "mix.exs"));
  const sbt = await readText(path.join(cwd, "build.sbt"));
  const cljDeps = await readText(path.join(cwd, "deps.edn"));
  const projectClj = await readText(path.join(cwd, "project.clj"));
  const cabal = await firstMatchingText(cwd, entries, (entry) => entry.toLowerCase().endsWith(".cabal"));
  const rockspec = await firstMatchingText(cwd, entries, (entry) => entry.toLowerCase().endsWith(".rockspec"));
  const packageSwift = await readText(path.join(cwd, "Package.swift"));
  const pom = await readText(path.join(cwd, "pom.xml"));
  const gradle = await readText(path.join(cwd, "build.gradle"));
  const gradleKts = await readText(path.join(cwd, "build.gradle.kts"));
  const gemfile = await readText(path.join(cwd, "Gemfile"));
  const description = await readText(path.join(cwd, "DESCRIPTION"));
  const cpanfile = await readText(path.join(cwd, "cpanfile"));
  const makefilePl = await readText(path.join(cwd, "Makefile.PL"));
  const buildZig = await readText(path.join(cwd, "build.zig"));

  const py = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  const mixLower = (mix ?? "").toLowerCase();
  const gradleLower = `${gradle ?? ""}\n${gradleKts ?? ""}`.toLowerCase();
  const pomLower = (pom ?? "").toLowerCase();
  const gemLower = (gemfile ?? "").toLowerCase();
  const composerLower = JSON.stringify(composer ?? {}).toLowerCase();

  const evidence: string[] = [];
  const stack: TechStack = { languages: [], frameworks: [], runtime: [] };
  const addLanguage = (language: string) => pushUnique(stack.languages, language);
  const addFramework = (framework: string) => pushUnique(stack.frameworks, framework);
  const addRuntime = (runtime: string) => pushUnique(stack.runtime!, runtime);
  const addEvidence = (line: string) => pushUnique(evidence, line);
  const addFrameworks = (items: string[]) => items.forEach(addFramework);

  // --- languages / runtimes / package manager ---
  if (pkg) {
    addRuntime("node");
    addLanguage(has("tsconfig.json") || endsWithAny(".ts") || endsWithAny(".tsx") ? "typescript" : "javascript");
    stack.packageManager = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
  }
  if (pyproject || requirements || has("Pipfile")) {
    addLanguage("python");
    addRuntime("python");
    stack.packageManager ??= pyproject?.includes("[tool.poetry]") ? "poetry" : "pip";
  }
  if (has("go.mod")) {
    addLanguage("go");
    stack.packageManager ??= "go";
  }
  if (cargo) {
    addLanguage("rust");
    stack.packageManager ??= "cargo";
  }
  if (pom || gradle || gradleKts) {
    addLanguage(gradleKts ? "kotlin" : "java");
    stack.packageManager ??= pom ? "maven" : "gradle";
  }
  if (gemfile) {
    addLanguage("ruby");
    stack.packageManager ??= "bundler";
  }
  if (pubspec) {
    addLanguage("dart");
    stack.packageManager ??= "pub";
  }
  if (composer) {
    addLanguage("php");
    stack.packageManager ??= "composer";
  }
  if (endsWithAny(".csproj") || endsWithAny(".sln") || has("global.json")) {
    addLanguage("csharp");
    stack.packageManager ??= "dotnet";
  }
  if (packageSwift || endsWithAny(".xcodeproj") || endsWithAny(".xcworkspace")) {
    addLanguage("swift");
    stack.packageManager ??= packageSwift ? "swiftpm" : stack.packageManager;
  }
  if (sbt) {
    addLanguage("scala");
    stack.packageManager ??= "sbt";
  }
  if (mix) {
    addLanguage("elixir");
    stack.packageManager ??= "mix";
  }
  if (cljDeps || projectClj) {
    addLanguage("clojure");
    stack.packageManager ??= cljDeps ? "clojure-cli" : "leiningen";
  }
  if (has("stack.yaml") || cabal) {
    addLanguage("haskell");
    stack.packageManager ??= has("stack.yaml") ? "stack" : "cabal";
  }
  if (rockspec || hasLower("main.lua")) {
    addLanguage("lua");
    stack.packageManager ??= rockspec ? "luarocks" : stack.packageManager;
  }
  if (cpanfile || makefilePl) {
    addLanguage("perl");
    stack.packageManager ??= "cpan";
  }
  if (description || has("renv.lock")) {
    addLanguage("r");
    stack.packageManager ??= has("renv.lock") ? "renv" : "r";
  }
  if (buildZig) {
    addLanguage("zig");
    stack.packageManager ??= "zig";
  }

  // --- strong framework / engine signals independent of category ---
  if (pkg) {
    addFrameworks(FRONTEND_NODE_FRAMEWORKS.filter(pkgDep));
    addFrameworks(NODE_BACKEND_FRAMEWORKS.filter(pkgDep).map((name) => name === "@nestjs/core" ? "nestjs" : name));
    if (pkgDep("expo")) addFramework("expo");
    if (pkgDep("react-native")) addFramework("react-native");
    if (anyPkgDep("@ionic/angular", "@ionic/react", "@ionic/vue", "@capacitor/core")) addFramework("ionic/capacitor");
  }
  const pyFw = matchAny(py, PYTHON_BACKEND_FRAMEWORKS);
  addFrameworks(pyFw);
  const jvmFw = matchAny(`${pomLower}\n${gradleLower}`, JVM_BACKEND_FRAMEWORKS);
  addFrameworks(jvmFw);
  if (composerDep("laravel/framework") || composerLower.includes("laravel/framework")) addFramework("laravel");
  if (composerDep("symfony") || composerLower.includes('"symfony/')) addFramework("symfony");
  if (gemLower.includes("gem \"rails\"") || gemLower.includes("gem 'rails'")) addFramework("rails");
  if (gemLower.includes("gem \"sinatra\"") || gemLower.includes("gem 'sinatra'")) addFramework("sinatra");
  if (mixLower.includes("phoenix")) addFramework("phoenix");
  if (cargo?.toLowerCase().includes("bevy")) addFramework("bevy");
  if (pkgDep("phaser")) addFramework("phaser");
  if (pubspec && (pubspec.includes("flutter") || has("android") || has("ios"))) addFramework("flutter");
  if (has("project.godot")) addFramework("godot");
  if (endsWithAny(".uproject")) addFramework("unreal");
  if (has("Assets") && has("ProjectSettings")) addFramework("unity");
  if (endsWithAny(".csproj") && /microsoft\.aspnetcore|microsoft\.net\.sdk\.web|websdk/i.test(await combinedProjectFiles(cwd, entries, ".csproj"))) {
    addFramework("aspnet");
  }

  // --- category decision (highest-signal first) ---
  if (has("project.godot")) {
    stack.engine = "godot";
    addEvidence("project.godot present");
    return finalize("games", stack, evidence, 0.95);
  }
  if (endsWithAny(".uproject")) {
    stack.engine = "unreal";
    addEvidence("*.uproject present");
    return finalize("games", stack, evidence, 0.95);
  }
  if (has("Assets") && has("ProjectSettings")) {
    stack.engine = "unity";
    addEvidence("Unity Assets/ + ProjectSettings/");
    return finalize("games", stack, evidence, 0.9);
  }
  if (stack.frameworks.includes("phaser")) {
    addEvidence("phaser dependency");
    return finalize("games", stack, evidence, 0.8);
  }
  if (stack.frameworks.includes("bevy")) {
    addEvidence("bevy in Cargo.toml");
    return finalize("games", stack, evidence, 0.85);
  }

  if (stack.frameworks.includes("flutter")) {
    addEvidence("Flutter pubspec.yaml");
    return finalize("mobile", stack, evidence, 0.9);
  }
  if (stack.frameworks.includes("expo") || stack.frameworks.includes("react-native")) {
    addEvidence(stack.frameworks.includes("expo") ? "expo dependency" : "react-native dependency");
    return finalize("mobile", stack, evidence, 0.9);
  }
  if (stack.frameworks.includes("ionic/capacitor")) {
    addEvidence("Ionic/Capacitor dependency");
    return finalize("mobile", stack, evidence, 0.85);
  }
  if (has("android") && has("ios")) {
    addEvidence("native android/ + ios/ directories");
    return finalize("mobile", stack, evidence, 0.75);
  }
  if ((has("AndroidManifest.xml") || endsWithAny(".xcodeproj")) && !pkg) {
    addEvidence("native mobile project files");
    return finalize("mobile", stack, evidence, 0.7);
  }

  const frontendHits = stack.frameworks.filter((fw) => FRONTEND_NODE_FRAMEWORKS.includes(fw));
  if (frontendHits.length) {
    addEvidence(`frontend framework: ${frontendHits.join(", ")}`);
    return finalize("frontend", stack, evidence, 0.85);
  }
  if (has("index.html") && !hasBackendSignals(stack, py, composerLower, pomLower, gradleLower, mixLower)) {
    addEvidence("index.html without backend signals");
    return finalize("frontend", stack, evidence, 0.6);
  }

  const nodeBackendHits = stack.frameworks.filter((fw) =>
    ["express", "fastify", "nestjs", "koa", "@hapi/hapi", "hapi", "@trpc/server", "adonisjs"].includes(fw),
  );
  if (nodeBackendHits.length) {
    addEvidence(`node backend framework: ${nodeBackendHits.join(", ")}`);
    return finalize("backend", stack, evidence, 0.85);
  }
  if (pyFw.length) {
    addEvidence(`python backend framework: ${pyFw.join(", ")}`);
    return finalize("backend", stack, evidence, 0.85);
  }
  if (stack.frameworks.includes("laravel") || stack.frameworks.includes("symfony")) {
    addEvidence(`php framework: ${stack.frameworks.filter((fw) => PHP_FRAMEWORKS.includes(fw)).join(", ")}`);
    return finalize("backend", stack, evidence, 0.82);
  }
  if (stack.frameworks.includes("rails") || stack.frameworks.includes("sinatra")) {
    addEvidence(`ruby framework: ${stack.frameworks.filter((fw) => RUBY_FRAMEWORKS.includes(fw)).join(", ")}`);
    return finalize("backend", stack, evidence, 0.82);
  }
  if (stack.frameworks.includes("phoenix")) {
    addEvidence("phoenix in mix.exs");
    return finalize("backend", stack, evidence, 0.82);
  }
  if (jvmFw.length) {
    addEvidence(`jvm backend framework: ${jvmFw.join(", ")}`);
    return finalize("backend", stack, evidence, 0.78);
  }
  if (stack.frameworks.includes("aspnet")) {
    addEvidence("ASP.NET project file markers");
    return finalize("backend", stack, evidence, 0.78);
  }
  if (has("go.mod")) {
    addEvidence("go.mod (Go service/CLI)");
    return finalize("backend", stack, evidence, 0.6);
  }
  if (composer) {
    addEvidence("composer.json (PHP project)");
    return finalize("backend", stack, evidence, 0.58);
  }
  if (mix) {
    addEvidence("mix.exs (Elixir project)");
    return finalize("backend", stack, evidence, 0.58);
  }
  if (pom || gradle || gradleKts || sbt) {
    addEvidence("JVM project files");
    return finalize("backend", stack, evidence, 0.55);
  }
  if (gemfile) {
    addEvidence("Gemfile (Ruby project)");
    return finalize("backend", stack, evidence, 0.55);
  }
  if (cargo) {
    addEvidence("Rust project");
    return finalize("backend", stack, evidence, 0.45);
  }
  if (cljDeps || projectClj) {
    addEvidence("Clojure project files");
    return finalize("backend", stack, evidence, 0.45);
  }
  if (packageSwift) {
    addEvidence("Package.swift");
    return finalize("backend", stack, evidence, 0.45);
  }
  if (description || cpanfile || buildZig || rockspec || hasLower("main.lua")) {
    addEvidence("language-specific project files");
    return finalize("backend", stack, evidence, 0.4);
  }
  if (has("Dockerfile") || pkg) {
    addEvidence(pkg ? "package.json without frontend/mobile/game signals" : "Dockerfile");
    return finalize("backend", stack, evidence, 0.4);
  }

  addEvidence("no strong signals; defaulting to backend");
  return finalize("backend", stack, evidence, 0.2);
}

function finalize(category: ProjectCategory, stack: TechStack, evidence: string[], confidence: number): ProjectDetection {
  return {
    category,
    stack: {
      languages: [...new Set(stack.languages)],
      frameworks: [...new Set(stack.frameworks)],
      packageManager: stack.packageManager,
      engine: stack.engine,
      runtime: stack.runtime?.length ? [...new Set(stack.runtime)] : undefined,
    },
    evidence,
    confidence,
  };
}

function pushUnique(list: string[], value: string): void {
  if (!value || list.includes(value)) return;
  list.push(value);
}

function matchAny(text: string, values: string[]): string[] {
  const lower = text.toLowerCase();
  return values.filter((value) => lower.includes(value.toLowerCase()));
}

function hasBackendSignals(
  stack: TechStack,
  py: string,
  composerLower: string,
  pomLower: string,
  gradleLower: string,
  mixLower: string,
): boolean {
  return (
    stack.frameworks.some((fw) =>
      [
        "express",
        "fastify",
        "nestjs",
        "koa",
        "@hapi/hapi",
        "hapi",
        "@trpc/server",
        "adonisjs",
        "django",
        "flask",
        "fastapi",
        "starlette",
        "aiohttp",
        "sanic",
        "falcon",
        "tornado",
        "spring",
        "micronaut",
        "quarkus",
        "ktor",
        "laravel",
        "symfony",
        "rails",
        "sinatra",
        "phoenix",
        "aspnet",
      ].includes(fw),
    ) ||
    /\b(django|flask|fastapi|starlette|aiohttp|sanic|falcon|tornado)\b/.test(py) ||
    composerLower.includes("laravel") ||
    composerLower.includes("symfony") ||
    pomLower.includes("spring") ||
    gradleLower.includes("spring") ||
    mixLower.includes("phoenix")
  );
}

async function firstMatchingText(
  cwd: string,
  entries: string[],
  predicate: (entry: string) => boolean,
): Promise<string | undefined> {
  const match = entries.find(predicate);
  return match ? readText(path.join(cwd, match)) : undefined;
}

async function combinedProjectFiles(cwd: string, entries: string[], suffix: string): Promise<string> {
  const matches = entries.filter((entry) => entry.toLowerCase().endsWith(suffix.toLowerCase()));
  const contents = await Promise.all(matches.map((entry) => readText(path.join(cwd, entry))));
  return contents.filter(Boolean).join("\n");
}
