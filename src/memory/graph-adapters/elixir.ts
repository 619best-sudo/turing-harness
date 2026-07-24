import { createRegexFamilyAdapter, resolveRelativeLike } from "./regex-utils.js";

export function createElixirGraphAdapter() {
  return createRegexFamilyAdapter({
    name: "elixir",
    languages: ["elixir"],
    extensions: [".ex", ".exs"],
    capabilityLevel: "partial",
    importPatterns: [
      /^\s*(?:alias|use|import)\s+([A-Za-z0-9_.]+)/gm,
    ],
    symbolPatterns: [
      { regex: /^\s*defmodule\s+([A-Za-z0-9_.]+)\s+do/gm, kind: "module" },
      { regex: /^\s*defp?\s+([A-Za-z_][A-Za-z0-9_!?]*)\s*\(/gm, kind: "function" },
    ],
    resolveSpecifier(filePath, specifier, context) {
      const cleaned = specifier.replace(/\./g, "/");
      return resolveRelativeLike(filePath, cleaned, context, [".ex", ".exs"]);
    },
  });
}
