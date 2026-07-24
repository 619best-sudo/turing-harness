import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createMiscFileGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "misc-file-graph",
    languages: ["haskell", "lua", "perl", "r", "zig"],
    extensions: [".hs", ".lhs", ".lua", ".pl", ".pm", ".r", ".R", ".zig"],
    capabilityLevel: "file_only",
    languageForFile(filePath) {
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".hs") || lower.endsWith(".lhs")) return "haskell";
      if (lower.endsWith(".lua")) return "lua";
      if (lower.endsWith(".pl") || lower.endsWith(".pm")) return "perl";
      if (lower.endsWith(".r")) return "r";
      return "zig";
    },
    importPatterns: [
      /^\s*import\s+([A-Za-z0-9_.]+)/gm,
      /^\s*require\s*\(?['"]([^'"]+)['"]\)?/gm,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
      /^\s*use\s+([A-Za-z0-9_:]+)/gm,
      /^\s*library\(\s*([A-Za-z0-9_.]+)\s*\)/gm,
      /^\s*source\(\s*['"]([^'"]+)['"]\s*\)/gm,
      /^\s*const\s+[A-Za-z0-9_]+\s*=\s*@import\(\s*"([^"]+)"\s*\)/gm,
    ],
    symbolPatterns: [
      { regex: /^\s*([A-Za-z_][A-Za-z0-9_']*)\s*::/gm, kind: "function" },
      { regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm, kind: "function" },
      { regex: /^\s*sub\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm, kind: "function" },
      { regex: /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*<-\s*function\s*\(/gm, kind: "function" },
      { regex: /^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm, kind: "function" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".hs") || lower.endsWith(".lhs")) {
        return resolveRelativeLike(filePath, specifier.replace(/\./g, "/"), context, [".hs", ".lhs"]);
      }
      if (lower.endsWith(".lua")) {
        return resolveRelativeLike(filePath, specifier, context, [".lua"]);
      }
      if (lower.endsWith(".pl") || lower.endsWith(".pm")) {
        return resolveRelativeLike(filePath, specifier.replace(/::/g, "/"), context, [".pl", ".pm"]);
      }
      if (lower.endsWith(".r")) {
        return resolveRelativeLike(filePath, specifier, context, [".r", ".R"]);
      }
      return resolveRelativeLike(filePath, specifier, context, [".zig"]);
    },
  });
}
