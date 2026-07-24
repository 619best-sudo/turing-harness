import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseBraceLanguage } from "./structured-syntax.js";

export function createSwiftGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "swift",
    languages: ["swift"],
    extensions: [".swift"],
    capabilityLevel: "partial",
    parseFile({ text }) {
      return parseBraceLanguage({
        text,
        language: "swift",
        importPatterns: [/^\s*import\s+([A-Za-z0-9_]+)\s*$/gm],
        declarations: [
          { regex: /^\s*(?:public\s+|internal\s+|private\s+)?(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: "class" },
          { regex: /^\s*(?:public\s+|internal\s+|private\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "method" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      return resolveRelativeLike(filePath, specifier, context, [".swift"]);
    },
  });
}
