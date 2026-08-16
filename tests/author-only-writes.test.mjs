/**
 * Content-less ("author-only") write/edit mode.
 *
 * The performance problem this mode solves: in the default `write`/`edit` tools
 * the calling model is FORCED by the schema to emit a full `content`/`newString`
 * draft, which is then discarded once an authoring model is in play (the
 * authoring model re-authors from the task + current file). That draft is pure
 * waste — a full extra generation that never reaches disk.
 *
 * With `createCodingTools({ authorOnlyWrites: true })` the `write`/`edit`
 * schemas drop `content`/`newString` entirely, so Model A emits only the path
 * (+ the `oldString` anchor for edit) and the authoring model is the SOLE author
 * of the bytes. One generation instead of two.
 *
 * The tool NAMES are unchanged, so plan machinery (`fileMutations: "write"|
 * "edit"`) and the loop's authoring trigger keep working without edits.
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCodingTools, OpenRouterBridge } from "../dist/index.js";

const codingTools = createCodingTools({ authorOnlyWrites: true });
const writeTool = codingTools.find((t) => t.name === "write");
const editTool = codingTools.find((t) => t.name === "edit");

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A recording LLMBridge stub: captures every `complete` call, returns a fixed
 * authored text. Mirrors the stub in authoring-multimodal.test.mjs so the two
 * suites stay consistent.
 */
function recordingLlm(text) {
  const calls = [];
  return {
    calls,
    complete: async (model, ctx) => {
      calls.push({ model, ctx });
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        model: model.openRouterSlug ?? model.id,
        api: "openrouter",
        provider: "test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 0,
      };
    },
    stream: async function* () {},
    resolveModel: (slug) => ({
      id: slug,
      openRouterSlug: slug,
      api: "openrouter",
      provider: "test",
      input: ["text"],
      output: ["text"],
      reasoning: false,
    }),
  };
}

const AUTHOR = { id: "test/author", openRouterSlug: "test/author", input: ["text"] };

// ---------------------------------------------------------------------------
// Schema: content-less means the calling model is not even offered the
// `content`/`newString` properties, and they are removed from `required`.
// ---------------------------------------------------------------------------

test("author-only write schema drops `content` from properties AND required", () => {
  const props = writeTool.parameters.properties;
  assert.ok(!("content" in props), "no `content` property → Model A cannot emit a draft");
  assert.ok("path" in props, "path still required");
  assert.deepEqual(writeTool.parameters.required, ["path"]);
  // The self-assessment + images params survive — the authoring model still
  // benefits from a complexity/category hint, and image-from-mockup still works.
  assert.ok("complexity" in props, "self-assessment retained for routing");
  assert.ok("images" in props, "image authoring path retained");
});

test("author-only edit schema drops `newString` but keeps the `oldString` anchor", () => {
  const props = editTool.parameters.properties;
  assert.ok(!("newString" in props), "no `newString` → Model A cannot emit a replacement draft");
  assert.ok("oldString" in props, "the anchor survives — an edit still says WHERE");
  assert.deepEqual(editTool.parameters.required, ["path", "oldString"]);
});

test("the tool names are unchanged so plan machinery keeps working", () => {
  // The loop's authoring trigger (`call.name === "write" || "edit"`) and PLAN's
  // `fileMutations: "write"|"edit"` both depend on these exact names.
  assert.equal(writeTool.name, "write");
  assert.equal(editTool.name, "edit");
});

test("the description tells the model NOT to pass content/newString", () => {
  assert.match(writeTool.description, /do NOT pass content/i);
  assert.match(editTool.description, /NOT newString/i);
});

// ---------------------------------------------------------------------------
// Execute: a resolved authoring model authors the bytes; Model A's (absent)
// draft is never missed.
// ---------------------------------------------------------------------------

test("author-only write: an authoring model authors the bytes onto disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-w-"));
  const target = path.join(dir, "a.ts");
  const llm = recordingLlm("export const authored = true;\n");

  const res = await writeTool.execute("c1", { path: target }, {
    cwd: dir, llm, log: () => {},
    authorModel: AUTHOR,
    authoringContext: { task: "create the entry module" },
  });

  assert.equal(llm.calls.length, 1, "the authoring model authored exactly once");
  assert.equal(await fs.readFile(target, "utf8"), "export const authored = true;\n");
  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.authoredBy, "test/author");
  await fs.rm(dir, { recursive: true, force: true });
});

test("author-only edit: the anchor is preserved and the replacement is authored", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-e-"));
  const target = path.join(dir, "a.ts");
  await fs.writeFile(target, "const OLD = 1;\n");
  const llm = recordingLlm("const NEW = 2;\n");

  const res = await editTool.execute("c1", { path: target, oldString: "const OLD = 1;" }, {
    cwd: dir, llm, log: () => {},
    authorModel: AUTHOR,
    authoringContext: { task: "rename OLD to NEW" },
  });

  assert.equal(llm.calls.length, 1, "the authoring model authored the replacement");
  // The authored replacement ("const NEW = 2;\n") replaced the anchor
  // ("const OLD = 1;"); the file's original trailing newline survived, so the
  // result is the authored text plus that retained newline.
  assert.equal(await fs.readFile(target, "utf8"), "const NEW = 2;\n\n");
  assert.equal(res.isError ?? false, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a pinned authoring model wins over the driver fallback even when ctx.model is set", async () => {
  // The invariant the fallback must not break: a medium/high write that DOES
  // escalate must reach the strong model, NOT silently fall back to the weak
  // driver. `resolveAuthorModel` returning a model short-circuits the fallback.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-esc-"));
  const target = path.join(dir, "a.ts");
  const llm = recordingLlm("export const strong = true;\n");

  const res = await writeTool.execute("c1", { path: target }, {
    cwd: dir, llm, log: () => {},
    authorModel: AUTHOR, // the strong author
    model: { id: "test/driver", openRouterSlug: "test/driver", input: ["text"] }, // weak driver
  });

  assert.equal(llm.calls[0].model.openRouterSlug, "test/author", "escalated to the strong model");
  assert.equal(res.details.authoredBy, "test/author");
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Low / unrouted fallback: a host's routing policy deliberately does NOT route
// `low` writes (and the permission callback only pins authorModel for `high`).
// In content-less mode there is no `content` draft to fall back to, so an
// unrated/low write must STILL author — on the loop's own driver model. The
// work is cheap, and it costs the same single generation the write would have
// spent emitting `content` anyway, just without the wasted Model-A draft.
// ---------------------------------------------------------------------------

test("author-only write with no escalation: authors on the driver (weak) model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-low-"));
  const target = path.join(dir, "a.ts");
  const llm = recordingLlm("export const low = true;\n");

  const res = await writeTool.execute("c1", { path: target }, {
    cwd: dir, llm, log: () => {},
    // No authorModel, no routeModel, no candidates, no images → nothing
    // escalates. The loop's own driver model is the fallback author.
    model: { id: "test/driver", openRouterSlug: "test/driver", input: ["text"] },
  });

  assert.equal(llm.calls.length, 1, "the driver model authored the bytes");
  assert.equal(llm.calls[0].model.openRouterSlug, "test/driver");
  assert.equal(await fs.readFile(target, "utf8"), "export const low = true;\n");
  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.authoredBy, "test/driver");
  await fs.rm(dir, { recursive: true, force: true });
});

test("author-only edit with no escalation: authors the replacement on the driver model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-edit-low-"));
  const target = path.join(dir, "a.ts");
  await fs.writeFile(target, "const OLD = 1;\n");
  const llm = recordingLlm("const NEW = 2;\n");

  const res = await editTool.execute("c1", { path: target, oldString: "const OLD = 1;" }, {
    cwd: dir, llm, log: () => {},
    model: { id: "test/driver", openRouterSlug: "test/driver", input: ["text"] },
  });

  assert.equal(llm.calls.length, 1, "the driver model authored the replacement");
  assert.equal(llm.calls[0].model.openRouterSlug, "test/driver");
  assert.equal(await fs.readFile(target, "utf8"), "const NEW = 2;\n\n");
  assert.equal(res.isError ?? false, false);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hard guard: the only unreachable-in-practice case is a host with no LLM
// bridge at all. That names the misconfiguration rather than silently no-op'ing.
// ---------------------------------------------------------------------------

test("author-only write with no bridge at all: clear error, nothing written", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-only-nobridge-"));
  const target = path.join(dir, "a.ts");

  const res = await writeTool.execute("c1", { path: target }, {
    cwd: dir, log: () => {},
    // No llm, no authorModel, no model → nothing can author.
    model: { id: "test/driver", openRouterSlug: "test/driver", input: ["text"] },
  });

  assert.equal(res.isError, true);
  assert.match(res.output, /no LLM bridge is available/);
  await assert.rejects(fs.readFile(target, "utf8"), "nothing was written");
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default mode is unchanged: createCodingTools() (no flag) keeps the
// content-required schema, so existing hosts and tests are unaffected.
// ---------------------------------------------------------------------------

test("createCodingTools() without the flag keeps the content-required default", () => {
  const defaults = createCodingTools();
  const w = defaults.find((t) => t.name === "write");
  const e = defaults.find((t) => t.name === "edit");
  assert.ok("content" in w.parameters.properties, "default write still requires content");
  assert.deepEqual(w.parameters.required, ["path", "content"]);
  assert.ok("newString" in e.parameters.properties);
  assert.deepEqual(e.parameters.required, ["path", "oldString", "newString"]);
});
