/**
 * The edit anchor contract made efficient for a weak driver, while keeping
 * author-first (the driver never authors `newString`; the author model writes
 * the bytes).
 *
 *  1. An anchor whose only defect is whitespace/indentation is resolved against
 *     the file's real bytes — applied only when unambiguous, rewriting exactly
 *     the original span.
 *  2. A genuine miss returns a RESOLVING diagnostic: the file's exact numbered
 *     bytes around the likely region, and the reminder (when the run
 *     comprehended the file) that the whole-file expert analysis is already in
 *     the conversation — so the driver re-issues one correct `edit` instead of
 *     reaching for `sed -i`.
 *  3. Author-only edits flow unchanged: the anchor resolves, the author model
 *     writes the replacement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEditTool } from "../dist/index.js";
import { ComprehensionStore, hashContent } from "../dist/tools/builtin/comprehension.js";

const normalEdit = createEditTool(false);
const authorOnlyEdit = createEditTool(true);

async function tmpFile(name, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-anchor-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, contents, "utf8");
  return { dir, file };
}

const baseCtx = (dir, extra = {}) => ({
  cwd: dir,
  log: () => {},
  ...extra,
});

test("edit resolves an anchor whose only defect is indentation (byte-exact)", async () => {
  const source = [
    "export function render() {",
    "  const button = document.createElement('button');",
    "  button.textContent = 'Old label';",
    "  document.body.appendChild(button);",
    "}",
  ].join("\n");
  const { dir, file } = await tmpFile("ui.ts", source);

  // The driver's anchor has the right words but the wrong indentation.
  const res = await normalEdit.execute(
    "e1",
    { path: file, oldString: "const button = document.createElement('button');\n  button.textContent = 'Old label';", newString: "  const button = document.createElement('button');\n  button.textContent = 'New label';" },
    baseCtx(dir),
  );

  assert.equal(res.isError ?? false, false, res.output);
  assert.equal(res.details.anchorLenient, true, "resolved leniently");
  assert.match(res.output, /whitespace\/indentation normalization/);
  const updated = await fs.readFile(file, "utf8");
  assert.ok(updated.includes("'New label'"), "replacement landed");
  assert.ok(updated.includes("  const button"), "original indentation preserved");
  assert.ok(updated.includes("export function render() {"), "surrounding bytes untouched");
  await fs.rm(dir, { recursive: true, force: true });
});

test("edit: an anchor that genuinely misses returns a resolving diagnostic with exact bytes", async () => {
  const source = [
    "export function render() {",
    "  const button = document.createElement('button');",
    "  button.textContent = 'Old label';",
    "  document.body.appendChild(button);",
    "}",
  ].join("\n");
  const { dir, file } = await tmpFile("ui.ts", source);
  const store = new ComprehensionStore();
  store.put(file, {
    rating: "high",
    analysis: "INVARIANT: the label text lives on the button; reflows are cheap here.",
    model: "test/strong",
    fileHash: hashContent(source),
    coveredRange: "full",
    emitted: true,
    emittedInLoop: "categorizer:write_edit",
  });

  // A paraphrased anchor — the exact failure that used to send the driver to sed.
  const res = await normalEdit.execute(
    "e1",
    { path: file, oldString: "const btn = buildButton(); btn.label = 'Old label'", newString: "x" },
    baseCtx(dir, { comprehensionStore: store, loopLabel: "categorizer:write_edit" }),
  );

  assert.equal(res.isError, true);
  assert.match(res.output, /does not match any text in/);
  assert.match(res.output, /whole-file expert analysis of this file/);
  assert.match(res.output, /button\.textContent = 'Old label'/, "shows the file's exact bytes");
  assert.ok(res.output.includes("\t"), "bytes are line-numbered");
  const unchanged = await fs.readFile(file, "utf8");
  assert.equal(unchanged, source, "nothing changed on a miss");
  await fs.rm(dir, { recursive: true, force: true });
});

test("author-only edit: lenient anchor resolves, then the author model writes the replacement", async () => {
  const source = [
    "export function render() {",
    "  const button = document.createElement('button');",
    "  button.textContent = 'Old label';",
    "  document.body.appendChild(button);",
    "}",
  ].join("\n");
  const { dir, file } = await tmpFile("ui.ts", source);

  const llm = new (await import("../dist/index.js")).OpenRouterBridge();
  llm.resolveModel = (slug) => ({ id: slug, openRouterSlug: slug, input: ["text"] });
  llm.complete = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "  const button = document.createElement('button');\n  button.textContent = 'Authored label';" }],
    model: "test/strong", api: "openrouter", provider: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop", timestamp: 0,
  });

  // Author-only: driver supplies ONLY the anchor (path + oldString), no newString.
  const res = await authorOnlyEdit.execute(
    "e1",
    { path: file, oldString: "const button = document.createElement('button');\n    button.textContent = 'Old label';" },
    baseCtx(dir, {
      llm,
      authorModel: { id: "test/strong", openRouterSlug: "test/strong", input: ["text"] },
    }),
  );

  assert.equal(res.isError ?? false, false, JSON.stringify(res).slice(0, 300));
  assert.equal(res.details.anchorLenient, true, "anchor resolved leniently");
  const updated = await fs.readFile(file, "utf8");
  assert.ok(updated.includes("'Authored label'"), "the AUTHOR model's bytes landed");
  assert.ok(updated.includes("  const button"), "the resolved span kept the file's own indentation");
  await fs.rm(dir, { recursive: true, force: true });
});