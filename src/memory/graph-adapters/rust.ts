import { resolveRelativeLike } from "./regex-utils.js";
import { createStructuredSyntaxAdapter, parseBraceLanguage } from "./structured-syntax.js";

export function createRustGraphAdapter() {
  return createStructuredSyntaxAdapter({
    name: "rust",
    languages: ["rust"],
    extensions: [".rs"],
    capabilityLevel: "partial",
    parseFile({ text }) {
      return parseBraceLanguage({
        text,
        language: "rust",
        importPatterns: [
          /^\s*use\s+([A-Za-z0-9_:]+)\s*;/gm,
          /^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm,
        ],
        declarations: [
          { regex: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: "class" },
          { regex: /^\s*impl(?:<[^>]+>)?(?:\s+[A-Za-z0-9_:<>, ]+\s+for\s+)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{?/, kind: "module", opensScope: true },
          { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
        ],
      });
    },
    resolveSpecifier(filePath, specifier, context) {
      const cleaned = specifier.replace(/::/g, "/");
      return resolveRelativeLike(filePath, cleaned, context, [".rs"]);
    },
  });
}
