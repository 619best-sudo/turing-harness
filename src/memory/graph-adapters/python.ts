import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseIndentationLanguage } from "./structured-syntax.js";

export function createPythonGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "python",
    languages: ["python"],
    extensions: [".py"],
    capabilityLevel: "partial",
    parseFile({ text }) {
      return parseIndentationLanguage({
        text,
        language: "python",
        importPatterns: [
          /^\s*import\s+([A-Za-z0-9_.,\s]+)/gm,
          /^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+/gm,
        ],
        declarations: [
          { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/, kind: "class" },
          { regex: /^\s*async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
          { regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      const first = specifier.split(",")[0]?.trim();
      if (!first) return undefined;
      return resolveRelativeLike(filePath, first, context, [".py"]);
    },
  });
}
