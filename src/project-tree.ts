/**
 * What is not the project.
 *
 * Directories that exist on disk but are not source: dependencies, VCS internals,
 * build output, tool caches, and this harness's own index directory. Anything that
 * WALKS or SEARCHES a project tree should skip them — a graph index, a file search,
 * a summary pass.
 *
 * This lives at the root, with no imports, for the same reason `code-risk.ts` does:
 * it is shared by modules that must not depend on each other. The list was being
 * re-typed per call site — graph indexing had one, the activity monitor's file walk
 * had a shorter one, `grep` had a third — so a directory learned in one place
 * stayed unknown in the others.
 *
 * The first attempt at fixing that exported the list from `graph-memory.ts` and
 * imported it into the coding tools, which was worse than the duplication: it made
 * `coding.ts` — the module every tool call loads — pull in the graph subsystem and
 * all sixteen of its language adapters to read one array of strings. A constant
 * shared by two subsystems belongs to neither.
 */

/**
 * Skipped by every tree walk and search.
 *
 * The harness's own memory directory is in here, and it earns its place by
 * observation: it holds a generated symbol index that mentions every symbol in the
 * project, so before it was excluded a search for any symbol returned its index
 * entries and nothing else. A model reads "the only hits are inside a JSON blob" as
 * "there are no real call sites". An artifact we generate must never come back as a
 * search result.
 */
export const IGNORED_PROJECT_DIRS: readonly string[] = [
  // Dependencies and VCS.
  "node_modules", "vendor", "bin", "obj",
  ".git", ".hg", ".svn",
  // Build and output trees.
  "dist", "build", "out", "target", "coverage",
  ".astro", ".build", ".next", ".nuxt", ".output", ".svelte-kit",
  "DerivedData", ".gradle", ".dart_tool", ".expo", ".turbo", ".parcel-cache",
  // Language and tool caches.
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".tox", ".zig-cache",
  // Editor state, and generated indexes — including this harness's own.
  ".idea", ".turing",
];

/**
 * Directories only a TEXT SEARCH encounters, on top of the shared list.
 *
 * A tree walk that indexes source never opens these; `grep -r` happily does, and
 * one of them is usually the largest thing in the repo.
 */
export const GREP_ONLY_EXCLUDED_DIRS: readonly string[] = ["Pods", "Carthage"];
