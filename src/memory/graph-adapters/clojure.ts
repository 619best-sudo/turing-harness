import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createClojureGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "clojure",
    languages: ["clojure"],
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    capabilityLevel: "partial",
    importPatterns: [
      /^\s*\(ns\s+[^\n]*?:require\s+\[([^\]]+)\]/gm,
      /^\s*\(require\s+\[([^\]]+)\]/gm,
    ],
    symbolPatterns: [
      { regex: /^\s*\(defn-?\s+([A-Za-z_][A-Za-z0-9_\-!?]*)/gm, kind: "function" },
      { regex: /^\s*\(def\s+([A-Za-z_][A-Za-z0-9_\-!?]*)/gm, kind: "variable" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      const cleaned = specifier.split(/\s+/)[0]?.replace(/\./g, "/");
      if (!cleaned) return undefined;
      return resolveRelativeLike(filePath, cleaned, context, [".clj", ".cljs", ".cljc", ".edn"]);
    },
  });
}
