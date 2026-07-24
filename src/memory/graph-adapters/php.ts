import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createPhpGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "php",
    languages: ["php"],
    extensions: [".php"],
    capabilityLevel: "partial",
    importPatterns: [
      /^\s*use\s+([A-Za-z0-9_\\]+)\s*;/gm,
      /^\s*(?:require|require_once|include|include_once)\s*\(?['"]([^'"]+)['"]\)?/gm,
    ],
    symbolPatterns: [
      { regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm, kind: "function" },
      { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm, kind: "class" },
      { regex: /^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm, kind: "type" },
      { regex: /^\s*trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm, kind: "type" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      const relative = specifier.replace(/\\/g, "/");
      return resolveRelativeLike(filePath, relative, context, [".php"]);
    },
  });
}
