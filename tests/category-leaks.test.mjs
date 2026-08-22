/**
 * Category leaks, from a field run: the write_edit hop called `activity_inspect`
 * and MCP `browser_navigate` ("Let me verify visually" → screenshot → browser),
 * burning turns driving a dead file:// screen while the real activity_inspect
 * pass re-did the QA afterwards. Two leak paths, both closed here:
 *
 *  1. every activity_monitor builtin declared `categorizers:
 *     ["activity_inspect","write_edit"]` — the whole QA toolset rode the work
 *     hop. Now inspect-only.
 *  2. the scoping heuristic dual-scoped QA-surface MCP tools: a real
 *     chrome-devtools `browser_navigate` description says it will "create a new
 *     tab" and "list console errors" — those incidental words hit the
 *     write/read hints and scoped it in. Inspect-hint tools are now
 *     inspect-EXCLUSIVE (explicit `categorizers` still wins).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  categorizeTool,
  categorizeProvider,
  isInspectSurface,
  Registry,
  LogStore,
  registerBuiltins,
  createCategorizerSetup,
  createDefaultCategorizers,
} from "../dist/index.js";

const tool = (name, description, extra = {}) => ({
  name, description, mutates: false, parameters: { type: "object", properties: {} }, ...extra,
});

test("a QA-surface tool with incidental write/read words scopes to activity_inspect ONLY", () => {
  // The real leak: chrome-devtools browser_navigate's description mentions
  // "create a new tab" (write hint) and "list console errors" (read hint).
  const nav = tool(
    "browser_navigate",
    "Open the specified URL in a tab, create a new tab if needed, and wait for the page to load. Lists console errors.",
  );
  assert.deepEqual(categorizeTool(nav), ["activity_inspect"]);
  // And the plain description too.
  assert.deepEqual(categorizeTool(tool("browser_navigate", "Navigate to a URL")), ["activity_inspect"]);
  // The whole QA surface family is exclusive.
  for (const name of ["browser_take_screenshot", "browser_snapshot", "browser_click", "mobile_screenshot", "run_tests"]) {
    assert.deepEqual(
      categorizeTool(tool(name, `${name} — drive the app and capture what happens, list results`)),
      ["activity_inspect"],
      `${name} must not leak into work categories`,
    );
  }
});

test("explicit categorizers still win over the inspect-exclusive default", () => {
  const pinned = tool("my_browser_tool", "browser screenshot thing", { categorizers: ["read"] });
  assert.deepEqual(categorizeTool(pinned), ["read"]);
});

test("non-QA tools keep their natural scoping", () => {
  assert.deepEqual(categorizeTool(tool("find_usages", "find where a symbol is used")), ["read", "write_edit"]);
  assert.deepEqual(categorizeTool(tool("apply_patch", "apply a diff", { mutates: true })), ["write_edit"]);
  assert.ok(categorizeProvider([tool("find_usages", "find usages")]).includes("read"));
});

test("the activity_monitor builtins no longer ride write_edit's registry scope", () => {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const writeTools = reg.getToolsForCategorizer("write_edit").map((t) => t.name);
  const inspectTools = reg.getToolsForCategorizer("activity_inspect").map((t) => t.name);

  for (const qa of ["activity_inspect", "activity_collect", "activity_study", "add_log", "remove_log", "mobile"]) {
    assert.ok(!writeTools.includes(qa), `${qa} leaked into write_edit`);
    assert.ok(inspectTools.includes(qa), `${qa} stays in activity_inspect`);
  }
  // The work tools stay where they belong.
  for (const work of ["write", "edit", "create_plan"]) {
    assert.ok(writeTools.includes(work), `${work} stays in write_edit`);
  }
});

test("a dual-hint MCP provider reaches ONLY the inspect hop through the chain's scope union", async () => {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  reg.add({
    id: "chrome-devtools",
    name: "Chrome DevTools",
    source: "external",
    tools: [
      tool(
        "browser_navigate",
        "Open the specified URL in a tab, create a new tab if needed. Lists console errors.",
        {
          execute: async () => ({ output: "ok" }),
        },
      ),
    ],
  });

  const setup = createCategorizerSetup({ categories: createDefaultCategorizers() });
  const namesFor = (id) => {
    const def = setup.categories.find((c) => c.id === id);
    const wanted = [...def.tools, ...setup.globalTools];
    const byName = new Map();
    for (const name of wanted) {
      const t = reg.getTool(name) ?? reg.allTools().find((x) => x.name.endsWith(`__${name}`));
      if (t) byName.set(t.name, t);
    }
    for (const t of reg.getToolsForCategorizer(id)) byName.set(t.name, t);
    return [...byName.keys()];
  };

  assert.ok(!namesFor("write_edit").includes("browser_navigate"), "MCP browser tool must not reach write_edit");
  assert.ok(!namesFor("read").includes("browser_navigate"), "MCP browser tool must not reach read");
  assert.ok(namesFor("activity_inspect").includes("browser_navigate"), "it reaches its own pass");
});

// ---------------------------------------------------------------------------
// The other direction: a QA tool that names no QA keyword
// ---------------------------------------------------------------------------

/**
 * From an app log: the activity_inspect hop started with 61 tools, which is
 * correct — but two of the chrome-devtools server's tools had also landed in
 * READ. `list_pages` and `get_network_request` contain no inspect keyword at all,
 * so the per-tool test found no hint and dropped them into the generic
 * non-mutating default. The per-tool guard catches false positives on incidental
 * words; it could not catch a false NEGATIVE on their absence.
 */
const QA_SERVER = [
  tool("browser_navigate", "Navigate the page to a URL, creating a new tab if needed"),
  tool("browser_click", "Click an element on the page"),
  tool("browser_take_screenshot", "Take a screenshot of the current page"),
  tool("browser_evaluate", "Evaluate JavaScript in the page and return the result"),
  tool("browser_snapshot", "Capture an accessibility snapshot of the page"),
  // The two that leaked: no "browser", no "screenshot", no "trace".
  tool("list_pages", "List open pages"),
  tool("get_network_request", "Get one network request by id"),
];

test("a keyword-free tool inside a QA server is scoped by the server it belongs to", () => {
  assert.equal(isInspectSurface(QA_SERVER), true);
  // On its own, with no cohort to belong to, the neutral tool still reads as read
  // — which is exactly why the cohort has to decide.
  assert.deepEqual(categorizeTool(tool("get_network_request", "Get one network request by id")), ["read"]);

  // auto mode (the legacy heuristic scoping): the cohort rule applies at add().
  const reg = new Registry({ externalMcpScoping: "auto" });
  reg.add({ id: "mcp:chrome", kind: "mcp", source: "external", name: "chrome-devtools", tools: QA_SERVER });
  const inspect = reg.getToolsForCategorizer("activity_inspect").map((t) => t.name).sort();
  assert.deepEqual(inspect, QA_SERVER.map((t) => t.name).sort(), "the whole server is one QA surface");
  assert.deepEqual(reg.getToolsForCategorizer("read").map((t) => t.name), []);
  assert.deepEqual(reg.getToolsForCategorizer("write_edit").map((t) => t.name), []);

  // selection mode (the default): connected is NOT selected — nothing reaches
  // any hop until the server is named. This is the leak these tests were
  // written about, closed from the other end: the server that put 61 tools
  // into a QA hop now puts in zero unless asked.
  const reg2 = new Registry();
  reg2.add({ id: "mcp:chrome", kind: "mcp", source: "external", name: "chrome-devtools", tools: QA_SERVER });
  assert.deepEqual(reg2.getToolsForCategorizer("activity_inspect").map((t) => t.name), [], "unselected reaches no hop");
  const applied = reg2.selectExternalMcps(["chrome-devtools"], ["conversation", "read", "write_edit", "activity_inspect"]);
  assert.deepEqual(applied.selected, ["mcp:chrome"], "suffix matching resolves the UI name");
  assert.deepEqual(
    reg2.getToolsForCategorizer("activity_inspect").map((t) => t.name).sort(),
    QA_SERVER.map((t) => t.name).sort(),
    "a selected server reaches every category",
  );
});

test("one QA tool does not drag a general-purpose server into QA", () => {
  const mixed = [
    tool("doc_find", "Find documents in the collection matching a filter"),
    tool("doc_get", "Fetch one document by id"),
    tool("doc_list", "List documents in a collection"),
    tool("doc_write", "Write a document", { mutates: true }),
    tool("render_screenshot", "Render the document to a screenshot"),
  ];
  assert.equal(isInspectSurface(mixed), false);
  const reg = new Registry({ externalMcpScoping: "auto" });
  reg.add({ id: "mcp:docs", kind: "mcp", source: "external", name: "docs", tools: mixed });
  // Each tool keeps the scope its own name and blurb earn it.
  assert.deepEqual(reg.getToolsForCategorizer("activity_inspect").map((t) => t.name), ["render_screenshot"]);
  assert.ok(reg.getToolsForCategorizer("read").some((t) => t.name === "doc_find"));
  assert.ok(reg.getToolsForCategorizer("read").some((t) => t.name === "doc_list"));
  assert.ok(reg.getToolsForCategorizer("write_edit").some((t) => t.name === "doc_write"));
});

test("a small server is not a cohort — too little to infer from", () => {
  assert.equal(isInspectSurface([tool("browser_click", "Click"), tool("get_thing", "Get a thing")]), false);
});

test("explicit scopes beat the cohort, per tool and per provider", () => {
  const reg = new Registry();
  reg.add({
    id: "mcp:chrome",
    kind: "mcp",
    source: "external",
    name: "chrome-devtools",
    tools: [...QA_SERVER, tool("list_pages_for_read", "List open pages", { categorizers: ["read"] })],
  });
  assert.ok(
    reg.getToolsForCategorizer("read").some((t) => t.name === "list_pages_for_read"),
    "a tool that declares its own scope keeps it",
  );

  const reg2 = new Registry();
  reg2.add({
    id: "mcp:chrome2",
    kind: "mcp",
    source: "external",
    name: "chrome-devtools",
    categorizers: ["read", "activity_inspect"],
    tools: QA_SERVER,
  });
  assert.ok(reg2.getToolsForCategorizer("read").length, "a provider-level scope is the host's call");
});

test("read's toolset stays read-only with a full browser server connected", () => {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  reg.add({ id: "mcp:chrome", kind: "mcp", source: "external", name: "chrome-devtools", tools: QA_SERVER });

  const setup = createCategorizerSetup({ categories: createDefaultCategorizers() });
  const read = setup.categories.find((c) => c.id === "read");
  const names = new Set([
    ...read.tools,
    ...setup.globalTools,
    ...reg.getToolsForCategorizer("read").map((t) => t.name),
  ]);
  for (const banned of QA_SERVER.map((t) => t.name)) {
    assert.ok(!names.has(banned), `${banned} must not reach the read hop`);
  }
});
