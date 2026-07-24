import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseBraceLanguage } from "./structured-syntax.js";

function detectJvmLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "kt" || ext === "kts") return "kotlin";
  if (ext === "scala") return "scala";
  return "java";
}

export function createJvmGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "jvm",
    languages: ["java", "kotlin", "scala"],
    extensions: [".java", ".kt", ".kts", ".scala"],
    capabilityLevel: "partial",
    languageForFile(filePath) {
      return detectJvmLanguage(filePath);
    },
    parseFile({ filePath, text }) {
      return parseBraceLanguage({
        text,
        language: detectJvmLanguage(filePath),
        importPatterns: [/^\s*import\s+([A-Za-z0-9_.*]+)\s*;?$/gm],
        declarations: [
          { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:package\s+)?(?:class|interface|object|enum|record|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: "class" },
          { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:fun|def|void|suspend fun|[A-Za-z0-9_<>, ?\[\]]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "method" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      const cleaned = specifier.replace(/\.\*$/, "").replace(/\./g, "/");
      return resolveRelativeLike(filePath, cleaned, context, [".java", ".kt", ".kts", ".scala"]);
    },
  });
}
