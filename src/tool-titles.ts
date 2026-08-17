/**
 * Human labels for tool calls — the RENDERER-SAFE copy.
 *
 * The authoritative titles live on the tool definitions themselves
 * (`AgentTool.title` / `actionTitles`), but those only exist where the registry
 * does: in a Node process. A UI renderer (Electron renderer, browser) cannot
 * import the harness root — it pulls `node:fs`, `node:path` and a process
 * spawner with it. So this module is deliberately DEPENDENCY-FREE and exported
 * on its own subpath (`turing-harness/tool-titles`): pure data plus one pure
 * function, safe to bundle anywhere.
 *
 * A test asserts this table stays in sync with the real tool definitions, so
 * the two copies cannot drift.
 */

/** Tool name → what the call does, in the user's terms. */
export const TOOL_TITLES: Record<string, string> = {
  // coding
  bash: "Run a shell command",
  bash_readonly: "Run a read-only shell command",
  read: "Read a file",
  write: "Write a file",
  edit: "Edit a file",
  ls: "List a directory",
  grep: "Search the codebase",
  mark_concern_lines: "Flag the lines that matter",
  // planning / asking / finishing
  create_plan: "Write the implementation plan",
  ask_user_question: "Ask the user a question",
  deliver: "Finish and hand off the result",
  clearing_doubt: "Ask a stronger model how to proceed",
  // media & generation
  media_analysis: "Analyze an image or video",
  assets_generator: "Generate images, video or icons",
  inspiration_generator: "Look up a design blueprint",
  // memory
  file_memory: "Recall what a file is for",
  project_memory: "Recall project conventions",
  graph_memory: "Recall linked project knowledge",
  // automation
  drive: "Drive the browser",
  mobile: "Drive the phone or simulator",
  // internet
  web_search: "Search the web",
  web_fetch: "Read a web page",
  web_scrape: "Extract data from a page",
  // logs & QA
  activity_search: "Search the activity log",
  activity_tags: "List activity log tags",
  activity_tail_file: "Tail a log file",
  activity_study: "Study the logs for a cause",
  activity_trace_start: "Start a debug trace",
  add_log: "Insert a trace log line",
  remove_log: "Remove a trace log line",
  activity_collect: "Collect the trace output",
  activity_cleanup: "Remove the trace probes",
  activity_inspect: "Check the change on screen",
};

/**
 * Action-dispatch tools: which argument carries the verb, and the label per
 * verb. Without these a host shows the raw enum token ("stats", "search") as
 * the call's subtitle — the identifier, not what happened.
 */
export const TOOL_ACTION_TITLES: Record<
  string,
  { param: string; titles: Record<string, string> }
> = {
  graph_memory: {
    param: "action",
    titles: {
      stats: "Summarize the code graph",
      refresh: "Re-index files in the graph",
      file_deps: "Trace what this file depends on",
      symbol_deps: "Trace what this symbol depends on",
      blast_radius: "Find everything this change touches",
      get_file_node: "Look up a file in the graph",
      get_symbol_node: "Look up a symbol in the graph",
      find_symbol: "Find where a symbol is defined",
    },
  },
  file_memory: {
    param: "action",
    titles: {
      search: "Find the files that matter here",
      get: "Look up what this file does",
      refresh: "Re-index these files",
      stats: "Summarize what is indexed",
    },
  },
  project_memory: {
    param: "action",
    titles: {
      get: "Read what we know about this project",
      remember: "Remember this for future runs",
      recall: "Recall a past decision",
      set_category: "Correct the project type",
    },
  },
  drive: {
    param: "action",
    titles: {
      open: "Open the page",
      look: "Look at the page",
      click: "Click on the page",
      fill: "Type into a field",
      select: "Pick from a dropdown",
      press: "Press a key",
      shot: "Capture the page",
      close: "Close the browser",
    },
  },
  mobile: {
    param: "action",
    titles: {
      look: "Look at the screen",
      tap: "Tap on the screen",
      longpress: "Press and hold",
      swipe: "Swipe the screen",
      type: "Type on the device",
      press: "Press a hardware button",
      open: "Open a link on the device",
      launch: "Launch the app",
      terminate: "Close the app",
      install: "Install the app",
      apps: "List installed apps",
      devices: "List available devices",
    },
  },
  media_analysis: {
    param: "lens",
    titles: {
      describe: "Describe what is in this",
      ocr: "Read the text in this",
      ui: "Read this design's layout",
      component: "Break this UI into components",
      qa: "Check this against what was asked",
      compare: "Compare this against the reference",
    },
  },
  assets_generator: {
    param: "kind",
    titles: {
      image: "Generate an image",
      video: "Generate a video",
      audio: "Generate audio",
      "3d": "Generate a 3D asset",
    },
  },
};

/**
 * How each action-dispatch tool infers its verb when the model omits it — these
 * tools all accept a bare call and read the intent off the other arguments, and
 * that inferred call is the common one, so it must be labelled too. Mirrors the
 * `resolve*Action` functions the tools use internally.
 */
const INFERRED_ACTION: Record<string, (args: Record<string, unknown>) => string> = {
  graph_memory: (a) => {
    if (Array.isArray(a.paths) && a.paths.length > 0) return "refresh";
    if (str(a.symbol) || str(a.qualifiedName)) return "find_symbol";
    if (str(a.path)) return "file_deps";
    return "stats";
  },
  file_memory: (a) => {
    if (str(a.query)) return "search";
    if (Array.isArray(a.paths) && a.paths.length > 0) return "refresh";
    if (str(a.path)) return "get";
    return "stats";
  },
  project_memory: (a) => {
    if (str(a.category)) return "set_category";
    if (str(a.text)) return "recall";
    return "get";
  },
};

const str = (v: unknown) => String(v ?? "").trim();

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * The label for ONE tool call. Returns undefined when there is nothing
 * meaningful to say — render nothing then, NOT the raw tool name and NOT the
 * raw action token, which is the duplicate-header case this exists to remove.
 */
export function toolCallTitle(
  toolName: string,
  args: Record<string, unknown> = {},
): string | undefined {
  // MCP tools arrive namespaced (`server__web_search`); the capability is what
  // the label is about, not the spelling.
  const name = toolName.includes("__") ? (toolName.split("__").pop() ?? toolName) : toolName;

  const dispatch = TOOL_ACTION_TITLES[name];
  if (dispatch) {
    const explicit = str(args[dispatch.param]);
    const action = explicit || INFERRED_ACTION[name]?.(args) || "";
    const label = action ? dispatch.titles[action] : undefined;
    if (label) return label;
  }

  const title = TOOL_TITLES[name];
  return title && norm(title) !== norm(name) ? title : undefined;
}
