import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseBraceLanguage } from "./structured-syntax.js";

export function createDotnetGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "dotnet",
    languages: ["csharp"],
    extensions: [".cs"],
    capabilityLevel: "partial",
    parseFile({ text }) {
      return parseBraceLanguage({
        text,
        language: "csharp",
        importPatterns: [/^\s*using\s+([A-Za-z0-9_.]+)\s*;/gm],
        declarations: [
          { regex: /^\s*(?:public|private|protected|internal)?\s*(?:sealed\s+|abstract\s+)?(?:class|interface|record|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: "class" },
          { regex: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?[A-Za-z0-9_<>, ?\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "method" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      const cleaned = specifier.replace(/\./g, "/");
      return resolveRelativeLike(filePath, cleaned, context, [".cs"]);
    },
  });
}
