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
