/**
 * Tool display titles.
 *
 * Hosts render a header above each tool call. With no title they uppercase the
 * name, so the user saw "MEDIA ANALYSIS / media_analysis" — a header that
 * repeats the identifier under it and says nothing. Every builtin now carries a
 * `title` that says what the call DOES, and the registry DROPS any title that
 * merely restates the name: absent means render nothing, never the raw name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Registry, builtinProviders, titleField, callTitle } from "../dist/index.js";

const providers = builtinProviders({ logStore: { search: () => [], tags: () => [] } });

const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");

test("no builtin tool ships a title that restates its name", () => {
  for (const p of providers) {
    for (const t of p.tools) {
      if (!t.title) continue;
      assert.notEqual(norm(t.title), norm(t.name), `${t.name} has a title that repeats its name`);
    }
  }
});

test("every builtin tool and provider group has a meaningful title", () => {
  for (const p of providers) {
    assert.ok(p.title, `provider ${p.id} has no display title`);
    for (const t of p.tools) assert.ok(t.title, `tool ${t.name} has no display title`);
  }
});

test("the registry drops a duplicate title rather than passing it to the host", () => {
  const registry = new Registry();
  registry.add({
    id: "test:dup",
    kind: "tool",
    source: "external",
    name: "media_analysis",
    title: "Media Analysis",
    tools: [
      { name: "media_analysis", title: "media analysis", description: "d", parameters: { type: "object" } },
    ],
  });
  const [item] = registry.list();
  assert.equal(item.title, undefined);
  assert.equal(item.tools[0].title, undefined);
});

test("a title that adds information survives", () => {
  assert.deepEqual(titleField("media_analysis", "Analyze an image or video"), {
    title: "Analyze an image or video",
  });
  assert.deepEqual(titleField("media_analysis", "Media Analysis"), {});
  assert.deepEqual(titleField("deliver", undefined), {});
});

/**
 * Action-dispatch tools (one tool, many verbs) leaked the raw enum token as the
 * subtitle: "Graph Memory / stats", "File Memory / search". `callTitle` labels
 * the CALL, including the very common case where the model omits `action` and
 * the tool infers it.
 */
test("an action-dispatch call is labelled by what the verb does", async () => {
  const { createGraphMemoryTool, createFileMemoryTool } = await import("../dist/index.js");
  const graph = createGraphMemoryTool({ stats: () => ({}) });
  const files = createFileMemoryTool({ search: () => [] });

  assert.equal(callTitle(graph, { action: "stats" }), "Summarize the code graph");
  assert.equal(callTitle(graph, { action: "blast_radius", path: "a.ts" }), "Find everything this change touches");
  assert.equal(callTitle(files, { action: "search", query: "x" }), "Find the files that matter here");
});

test("an omitted action is labelled by the verb the tool infers, not the generic title", async () => {
  const { createFileMemoryTool } = await import("../dist/index.js");
  const files = createFileMemoryTool({ search: () => [] });
  // No `action`: the tool infers search from `query` and get from `path`.
  assert.equal(callTitle(files, { query: "router" }), "Find the files that matter here");
  assert.equal(callTitle(files, { path: "src/a.ts" }), "Look up what this file does");
});

test("a tool with no action falls back to its tool title, and to nothing when it has none", () => {
  assert.equal(callTitle({ name: "read", title: "Read a file", description: "", parameters: {} }), "Read a file");
  assert.equal(callTitle({ name: "read", description: "", parameters: {} }), undefined);
  assert.equal(callTitle({ name: "read", title: "Read", description: "", parameters: {} }), undefined);
});

test("every action-dispatch tool labels every action in its enum", () => {
  for (const p of providers) {
    for (const t of p.tools) {
      if (!t.actionParam || !t.actionTitles) continue;
      const values = t.parameters?.properties?.[t.actionParam]?.enum ?? [];
      for (const v of values) {
        assert.ok(t.actionTitles[v], `${t.name}: action "${v}" has no display title`);
        assert.notEqual(norm(t.actionTitles[v]), norm(v), `${t.name}: action "${v}" title repeats the token`);
      }
    }
  }
});

/**
 * The renderer-safe table (`turing-harness/tool-titles`) is a SECOND copy of
 * the same labels — a UI process cannot import the registry. Two copies drift,
 * so this test is the thing that stops them.
 */
test("the renderer-safe table matches the real tool definitions", async () => {
  const { TOOL_TITLES, TOOL_ACTION_TITLES } = await import("../dist/tool-titles.js");
  for (const p of providers) {
    for (const t of p.tools) {
      if (t.title) assert.equal(TOOL_TITLES[t.name], t.title, `${t.name}: title differs from the tool definition`);
      if (!t.actionTitles) continue;
      const entry = TOOL_ACTION_TITLES[t.name];
      assert.ok(entry, `${t.name}: action titles missing from the renderer table`);
      assert.equal(entry.param, t.actionParam, `${t.name}: action param differs`);
      assert.deepEqual(entry.titles, t.actionTitles, `${t.name}: action titles differ`);
    }
  }
});

test("toolCallTitle labels calls the same way callTitle does, including MCP-namespaced names", async () => {
  const { toolCallTitle } = await import("../dist/tool-titles.js");
  assert.equal(toolCallTitle("graph_memory", { action: "stats" }), "Summarize the code graph");
  assert.equal(toolCallTitle("file_memory", { query: "router" }), "Find the files that matter here");
  assert.equal(toolCallTitle("deliver"), "Finish and hand off the result");
  assert.equal(toolCallTitle("media_analysis", { lens: "qa" }), "Check this against what was asked");
  assert.equal(toolCallTitle("server__web_search", { query: "x" }), "Search the web");
  assert.equal(toolCallTitle("some_unknown_mcp_tool"), undefined);
});
