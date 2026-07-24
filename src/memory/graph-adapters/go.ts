import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseBraceLanguage } from "./structured-syntax.js";

export function createGoGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "go",
    languages: ["go"],
    extensions: [".go"],
    capabilityLevel: "partial",
    parseFile({ text }) {
      return parseBraceLanguage({
        text,
        language: "go",
        importPatterns: [
          /^\s*import\s+"([^"]+)"/gm,
          /^\s*"([^"]+)"\s*$/gm,
        ],
        declarations: [
          { regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/, kind: "class" },
          { regex: /^\s*func\s+\([^)]+\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "method" },
          { regex: /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      const moduleName = (context.manifests["go.mod"]?.match(/^module\s+([^\s]+)/m) ?? [])[1];
      if (moduleName && specifier.startsWith(`${moduleName}/`)) {
        return resolveRelativeLike(filePath, specifier.slice(moduleName.length + 1), context, [".go"]);
      }
      return resolveRelativeLike(filePath, specifier, context, [".go"]);
    },
  });
}
