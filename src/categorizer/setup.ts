/**
 * Categorizer setup: build + validate a {@link CategorizerSetup}, and the four
 * default categories (conversation, read, write_edit, activity_inspect) wired
 * into the standard transition graph:
 *
 *   conversation → (summarise)
 *   read         → write_edit | activity_inspect
 *   write_edit   → activity_inspect
 *   activity_inspect → write_edit
 *   …looping write_edit ↔ activity_inspect until done, then summarise.
 *
 * Apps extend or replace this via the `categorizer-setup` entry point — more
 * categories need nothing but a new definition with ids in `children`.
 */
import type {
  CategorizerDefinition,
  CategorizerId,
  CategorizerSetup,
} from "./types.js";
export type { CategorizerSetup } from "./types.js";
import { DEFAULT_CATEGORIZER_PROMPTS, DEFAULT_DELIVER_SCHEMAS } from "./prompts.js";

/** Tools every categorizer receives (setup `globalTools` default). */
export const DEFAULT_GLOBAL_TOOLS: string[] = [
  "bash",
  "ask_user_question",
  "clearing_doubt",
  "web_search",
  "web_fetch",
  "web_scrape",
];

/**
 * Normalize + sanity-check one categorizer definition. Pure: no registry access,
 * so an app can validate its config file at startup before any run.
 */
export function defineCategorizer(def: CategorizerDefinition): CategorizerDefinition {
  if (!def.id || typeof def.id !== "string") throw new Error("categorizer: `id` is required");
  if (!/^[a-z0-9_][a-z0-9_-]*$/.test(def.id)) {
    throw new Error(`categorizer "${def.id}": ids must be kebab/snake-case tokens (router choices)`);
  }
  if (!def.name) throw new Error(`categorizer "${def.id}": \`name\` is required`);
  if (!def.description) throw new Error(`categorizer "${def.id}": \`description\` (router-facing) is required`);
  if (!def.systemPrompt) throw new Error(`categorizer "${def.id}": \`systemPrompt\` is required`);
  if (!def.returns?.kind) throw new Error(`categorizer "${def.id}": \`returns.kind\` is required`);
  if (!def.returns.description) {
    throw new Error(`categorizer "${def.id}": \`returns.description\` is required`);
  }
  if (def.returns.deliverSchema == null && DEFAULT_DELIVER_SCHEMAS[def.returns.kind] == null) {
    throw new Error(
      `categorizer "${def.id}": returns.kind "${def.returns.kind}" has no built-in deliver schema — provide returns.deliverSchema`,
    );
  }
  return {
    ...def,
    tools: [...new Set(def.tools ?? [])],
    children: [...new Set(def.children ?? [])],
    entry: def.entry ?? true,
  };
}

/**
 * Build a validated setup. Checks every `children` / `accepts.from` reference
 * resolves to a declared id, that at least one categorizer is an entry, and that
 * the `deliver` tool name is not shadowed by a category's own tools.
 */
export function createCategorizerSetup(input: {
  categories: CategorizerDefinition[];
  globalTools?: string[];
  routerModel?: string;
  doubtModel?: string;
  maxHops?: number;
  routerPrompt?: string;
}): CategorizerSetup {
  const categories = input.categories.map(defineCategorizer);
  const ids = new Set(categories.map((c) => c.id));
  if (categories.length === 0) throw new Error("categorizer setup: at least one category is required");
  const dupes = categories.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) throw new Error(`categorizer setup: duplicate ids ${[...new Set(dupes)].join(", ")}`);
  for (const c of categories) {
    for (const child of c.children) {
      if (!ids.has(child)) {
        throw new Error(`categorizer "${c.id}": child "${child}" is not a declared category id`);
      }
    }
    for (const from of c.accepts?.from ?? []) {
      if (!ids.has(from)) {
        throw new Error(`categorizer "${c.id}": accepts.from "${from}" is not a declared category id`);
      }
    }
    if (c.tools.includes("deliver")) {
      throw new Error(
        `categorizer "${c.id}": "deliver" is the harness-injected terminal tool and cannot be assigned`,
      );
    }
  }
  if (!categories.some((c) => c.entry !== false)) {
    throw new Error("categorizer setup: at least one category must be an entry (entry !== false)");
  }
  return {
    categories,
    globalTools: input.globalTools ?? [...DEFAULT_GLOBAL_TOOLS],
    ...(input.routerModel ? { routerModel: input.routerModel } : {}),
    ...(input.doubtModel ? { doubtModel: input.doubtModel } : {}),
    ...(input.maxHops != null ? { maxHops: input.maxHops } : {}),
    ...(input.routerPrompt ? { routerPrompt: input.routerPrompt } : {}),
  };
}

/** Look up a definition by id (throws with the available ids when unknown). */
export function getCategory(setup: CategorizerSetup, id: CategorizerId): CategorizerDefinition {
  const def = setup.categories.find((c) => c.id === id);
  if (!def) {
    throw new Error(`unknown categorizer "${id}" (available: ${setup.categories.map((c) => c.id).join(", ")})`);
  }
  return def;
}

/** Entry-capable categories (the router's first-choice set). */
export function entryCategories(setup: CategorizerSetup): CategorizerDefinition[] {
  return setup.categories.filter((c) => c.entry !== false);
}

// ---------------------------------------------------------------------------
// The four default categories
// ---------------------------------------------------------------------------

/** The default categorizer definitions. Extend by adding ids to `children`. */
export function createDefaultCategorizers(): CategorizerDefinition[] {
  return [
    {
      id: "conversation",
      name: "Conversation",
      description:
        "Normal conversation, questions answerable in prose, internet lookups and quick bash " +
        "scripts. No project inspection or change.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.conversation,
      tools: [],
      children: [],
      accepts: {},
      returns: {
        kind: "summary",
        description: "A direct answer to the user",
      },
      // Role-slot default: conversation drives on the cheap router-tier model.
      // entry: true (default)
    },
    {
      id: "read",
      name: "Read",
      description:
        "Find and understand the files relevant to the task (memory-first, then read). Delivers " +
        "the relevant files with line numbers/snippets and a combined summary of how they link.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.read,
      tools: [
        "read",
        "ls",
        "grep",
        "bash_readonly",
        "mark_concern_lines",
        "project_memory",
        "file_memory",
        "graph_memory",
      ],
      children: ["write_edit", "activity_inspect"],
      accepts: {},
      returns: {
        kind: "code-summary",
        description: "The relevant files (paths, lines, snippets) + how they link, for a follow-up model",
      },
    },
    {
      id: "write_edit",
      name: "Write / Edit",
      description:
        "Write or edit code and generate assets. Always plans first (create_plan); authors from " +
        "attachments/inspiration when building UI. Delivers the writes that landed.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit,
      tools: [
        "read",
        "ls",
        "grep",
        "write",
        "edit",
        "create_plan",
        "assets_generator",
        "inspiration_generator",
        "design_skill",
      ],
      children: ["activity_inspect"],
      accepts: { from: ["read", "activity_inspect"], tools: [] },
      returns: {
        kind: "write-report",
        description: "The writes/edits that landed (tool, path, what changed) + notes",
      },
    },
    {
      id: "activity_inspect",
      name: "Activity Inspect",
      description:
        "QA and debugging: run the app, capture screens, compare against media, read/instrument " +
        "logs and traces. Accepts the write calls a work pass made; localises bugs and reports a verdict.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_inspect,
      tools: [
        "read",
        "grep",
        "ls",
        "media_analysis",
        "mobile",
        "activity_search",
        "activity_tags",
        "activity_tail_file",
        "activity_study",
        "activity_trace_start",
        "activity_collect",
        "activity_cleanup",
        "activity_inspect",
        "add_log",
        "remove_log",
      ],
      children: ["write_edit"],
      accepts: { from: ["write_edit", "read"], tools: ["write", "edit"] },
      returns: {
        kind: "inspect-report",
        description: "Findings + where logs are written + where the bug is (+ pass/fail verdict)",
      },
    },
  ];
}

/** The built-in default setup (the four categories, standard transitions). */
export const DEFAULT_CATEGORIZER_SETUP: CategorizerSetup = createCategorizerSetup({
  categories: createDefaultCategorizers(),
});
