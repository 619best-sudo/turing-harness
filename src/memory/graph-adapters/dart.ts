import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createDartGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "dart",
    languages: ["dart"],
    extensions: [".dart"],
    capabilityLevel: "partial",
    importPatterns: [/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm],
    symbolPatterns: [
      { regex: /^\s*(?:class|enum|mixin|extension)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm, kind: "class" },
      { regex: /^\s*(?:[A-Za-z0-9_<>, ?\[\]]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gm, kind: "function" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      if (specifier.startsWith("package:")) {
        const cleaned = specifier.replace(/^package:[^/]+\//, "");
        return resolveRelativeLike(filePath, cleaned, context, [".dart"]);
      }
      return resolveRelativeLike(filePath, specifier, context, [".dart"]);
    },
  });
}
