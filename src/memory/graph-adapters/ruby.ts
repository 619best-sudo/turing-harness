import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createRubyGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "ruby",
    languages: ["ruby"],
    extensions: [".rb"],
    capabilityLevel: "partial",
    importPatterns: [
      /^\s*require_relative\s+['"]([^'"]+)['"]/gm,
      /^\s*require\s+['"]([^'"]+)['"]/gm,
    ],
    symbolPatterns: [
      { regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/gm, kind: "function" },
      { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)/gm, kind: "class" },
      { regex: /^\s*module\s+([A-Za-z_][A-Za-z0-9_:]*)/gm, kind: "module" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      return resolveRelativeLike(filePath, specifier, context, [".rb"]);
    },
  });
}
