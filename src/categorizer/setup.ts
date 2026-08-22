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
  summaryModel?: string;
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
    ...(input.summaryModel ? { summaryModel: input.summaryModel } : {}),
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
        "Anything with nothing to do with the user's code: chat, prose questions, internet " +
        "lookups (web_search/web_fetch), and terminal work on the data at hand. No project " +
        "inspection or change.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.conversation,
      // Stated EXPLICITLY (not only via globalTools) so this category keeps its
      // purpose even when an app customizes the global set: the internet for
      // current/checkable answers, and bash for processing data the tool chain
      // produces (files, JSON, calculations, quick scripts).
      tools: ["web_search", "web_fetch", "web_scrape", "bash"],
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
        "Find and understand the files relevant to the task (memory-first, then read, then " +
        "media_analysis on attachments). Delivers the relevant files with line numbers/snippets, " +
        "a combined summary of how they link, and per-attachment notes for the write pass.",
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
        "media_analysis",
      ],
      // A bug report goes to `activity_reproduce` (see it happen), a feature to
      // `write_edit`. `activity_inspect` is deliberately NOT here: verifying is
      // done AFTER a change exists, and offering it straight out of read is how a
      // run ends up doing QA on code nobody has touched.
      children: ["activity_reproduce", "write_edit"],
      accepts: {},
      returns: {
        kind: "code-summary",
        description:
          "The relevant files (paths, lines, snippets) + how they link + what the attachments " +
          "contain, for a follow-up model",
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
        "media_analysis",
        "assets_generator",
        "inspiration_generator",
        "design_skill",
      ],
      children: ["activity_inspect"],
      accepts: { from: ["read", "activity_reproduce", "activity_inspect"], tools: [] },
      returns: {
        kind: "write-report",
        description: "The writes/edits that landed (tool, path, what changed) + notes",
      },
    },
    {
      id: "activity_reproduce",
      name: "Activity Reproduce",
      description:
        "Make a REPORTED defect happen, before any fix exists: run the app, drive it to the broken " +
        "screen, instrument and read the logs. Accepts the read pass's code summary; delivers the " +
        "symptom as observed, where the evidence is, and the lines a fix should target. Pick this " +
        "for a bug report — never to check a change that was just made (that is activity_inspect).",
      // The reproduce hop drives real software (device/web automation, trace
      // probes, launch/relaunch decisions) — pinned rather than left on the
      // perform slot's default. MiMo-v2.5: omnimodal input (verified against
      // OpenRouter), so captures and probe-laden traces are read natively, and
      // a 1.05M window that swallows long build/run logs without compaction.
      model: "xiaomi/mimo-v2.5",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_reproduce,
      // Same QA surface as activity_inspect — browsers, devices, activity
      // builtins, and any MCP server scoped there — without every one of those
      // tools having to name a second categorizer. See `toolScope`.
      toolScope: "activity_inspect",
      tools: [
        "read",
        "grep",
        "ls",
        "media_analysis",
        "mobile",
        "drive",
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
      accepts: { from: ["read"], tools: [] },
      // Not an entry: reproducing needs to know where to look, and that is the
      // read pass's output. Entered cold, this hop has no files, no suspects and
      // nothing to instrument — the run that motivated the split spent eight
      // minutes reading source in a hop built for driving.
      entry: false,
      returns: {
        kind: "repro-report",
        description:
          "The symptom as OBSERVED (or an honest could-not-reproduce) + where the evidence is + " +
          "the lines a fix should target, for the write pass",
      },
    },
    {
      id: "activity_inspect",
      name: "Activity Inspect",
      // Why a non-default driver, and why THIS one: the hop's currency is
      // screenshots and captures. On the extra-small driver a correctly-routed
      // verify hop answered with prose, called NOTHING, and ended five seconds
      // later without delivering — every gate in the QA pass keys off a tool
      // call, so a driver that makes none is a driver none of them can reach.
      // laguna-s followed: TEXT-ONLY, and its first `mobile look` screenshot
      // got the whole request rejected ("No endpoints found that support image
      // input") — the run died with the app launched and nobody at the wheel.
      // MiMo-v2.5 sees images NATIVELY (verified against OpenRouter:
      // input_modalities ["text","image","audio","video"], 1.05M context) —
      // captures pass through untouched, and it is an order of magnitude
      // cheaper than the vision models it replaces.
      model: "xiaomi/mimo-v2.5",
      description:
        "VERIFY a change that was just made: run it, capture screens, compare against media, " +
        "read/instrument logs and traces. Accepts the write calls a work pass made; reports a " +
        "pass/fail verdict. Not for a bug report with no fix yet — that is activity_reproduce.",
      systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_inspect,
      // Verification measures a change, so there has to be one first.
      entry: false,
      tools: [
        "read",
        "grep",
        "ls",
        "media_analysis",
        "mobile",
        "drive",
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
      accepts: { from: ["write_edit", "read", "activity_reproduce"], tools: ["write", "edit"] },
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
