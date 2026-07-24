import type { AssistantMessage, Context, LLMBridge } from "../types.js";
import { FILE_MEMORY_SUMMARY_VERSION, cleanSummary, dedupeStrings } from "./file-memory.js";

export const DEFAULT_FILE_SUMMARIZER_MODEL = "poolside/laguna-xs-2.1";

export interface FileSummaryLlmInput {
  llm: LLMBridge;
  modelSlug?: string;
  cwd: string;
  filePath: string;
  relativePath: string;
  role: string;
  tags: string[];
  language?: string;
  frameworkHints?: string[];
  keySymbols?: string[];
  dependencies?: string[];
  routes?: string[];
  interfaces?: string[];
  responsibilities?: string[];
  text: string;
  signal?: AbortSignal;
}

export interface FileSummaryLlmResult {
  summary: string;
  keywords: string[];
  keySymbols: string[];
  dependencies: string[];
  routes: string[];
  interfaces: string[];
  responsibilities: string[];
  frameworkHints: string[];
  language?: string;
  model: string;
  version: number;
}

export async function summarizeFileWithLlm(input: FileSummaryLlmInput): Promise<FileSummaryLlmResult> {
  const slug = input.modelSlug ?? DEFAULT_FILE_SUMMARIZER_MODEL;
  const model = input.llm.resolveModel(slug);
  const context: Context = {
    systemPrompt: [
      "You summarize code files for a durable file-memory index.",
      "Return valid JSON only with keys: summary, keywords, keySymbols, dependencies, routes, interfaces, responsibilities, frameworkHints, language.",
      "summary rules:",
      "- target 100-200 words",
      "- cover both business purpose and technical responsibility",
      "- explain what the file is for, the important symbols it defines, the interfaces it exposes, the dependencies it relies on, and where it fits in the framework/runtime",
      "- use only evidence from file path, tags, role, parser/semantic hints, and file content",
      "- do not hallucinate APIs, behavior, or frameworks",
      "- write one dense paragraph, not bullets",
      "keywords rules:",
      "- return an array of 4-12 short lowercase keywords",
      "- include business nouns and technical nouns when grounded in the file",
      "- no sentences",
      "keySymbols rules:",
      "- return the most important exported or named symbols, classes, handlers, services, modules, or functions",
      "- prefer public entrypoints over helper internals",
      "dependencies rules:",
      "- return imported modules, framework packages, or directly referenced internal dependencies grounded in the file",
      "routes rules:",
      "- return concrete endpoints or route groups only when explicitly present",
      "interfaces rules:",
      "- return the observable surface of the file such as exported APIs, config entrypoints, scripts, commands, or route names",
      "responsibilities rules:",
      "- return 2-6 short phrases describing what this file is responsible for",
      "frameworkHints rules:",
      "- return grounded frameworks/platforms only when clearly evidenced by imports, config, or file patterns",
      "language rules:",
      "- return one lowercase language when clearly identifiable, otherwise null",
    ].join("\n"),
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          `cwd: ${input.cwd}`,
          `path: ${input.relativePath}`,
          `role: ${input.role}`,
          `tags: ${input.tags.join(", ") || "none"}`,
          `language: ${input.language ?? "unknown"}`,
          `framework hints: ${input.frameworkHints?.join(", ") || "none"}`,
          `key symbols: ${input.keySymbols?.join(", ") || "none"}`,
          `dependencies: ${input.dependencies?.join(", ") || "none"}`,
          `routes: ${input.routes?.join(", ") || "none"}`,
          `interfaces: ${input.interfaces?.join(", ") || "none"}`,
          `responsibilities: ${input.responsibilities?.join(", ") || "none"}`,
          "",
          "File content:",
          input.text.slice(0, 32_000),
        ].join("\n"),
      },
    ],
  };
  const message = await input.llm.complete(model, context, {
    temperature: 0,
    signal: input.signal,
    maxTokens: Math.min(model.maxTokens ?? 2048, 800),
  });
  const text = assistantText(message);
  const parsed = parseJsonObject(text);
  const summary = cleanSummary(String(parsed.summary ?? ""), { maxWords: 180 });
  if (!summary || summary === ".") throw new Error("LLM summarizer returned an empty summary.");
  const keywords = normalizeKeywords(parsed.keywords);
  return {
    summary,
    keywords,
    keySymbols: normalizeKeywords(parsed.keySymbols),
    dependencies: normalizeKeywords(parsed.dependencies),
    routes: normalizeKeywords(parsed.routes),
    interfaces: normalizeKeywords(parsed.interfaces),
    responsibilities: normalizeKeywords(parsed.responsibilities),
    frameworkHints: normalizeKeywords(parsed.frameworkHints),
    language: typeof parsed.language === "string" ? parsed.language.trim().toLowerCase() || undefined : undefined,
    model: model.openRouterSlug ?? model.id,
    version: FILE_MEMORY_SUMMARY_VERSION,
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? text).trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

function normalizeKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(value.map((item) => String(item)));
  }
  if (typeof value === "string") {
    return dedupeStrings(value.split(","));
  }
  return [];
}
