/**
 * `/` and `#` mention parsing + resolution against the registry and filesystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractMentionTokens, resolveMentions, renderMentionNote } from "../dist/index.js";
import { Registry, defineSkill } from "../dist/index.js";

test("tokens are extracted from running text, deduped", () => {
  const tokens = extractMentionTokens("use /playwright for the run and #src/app.ts as context, not /playwright again");
  assert.deepEqual(tokens, ["/playwright", "#src/app.ts"]);
});

test("URLs and plain paths are not mentions", () => {
  assert.deepEqual(extractMentionTokens("see https://example.com/docs and ./local/path"), []);
});

test("resolution: skills and MCP servers by id and name", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mentions-"));
  const registry = new Registry();
  registry.add(defineSkill({
    id: "skill:deploy",
    name: "deploy",
    description: "deploys",
    tools: [{ name: "deploy_tool", description: "d", parameters: { type: "object" }, async execute() { return { output: "ok" }; } }],
  }));
  registry.add({
    id: "mcp:playwright",
    kind: "mcp",
    source: "external",
    name: "Playwright",
    tools: [{ name: "browser_snapshot", description: "s", parameters: { type: "object" }, async execute() { return { output: "ok" }; } }],
  });

  const res = await resolveMentions(["/deploy", "/playwright"], registry, dir);
  assert.deepEqual(res.providers.sort(), ["mcp:playwright", "skill:deploy"]);
  assert.deepEqual(res.tools.map((t) => t.name).sort(), ["browser_snapshot", "deploy_tool"]);
  assert.deepEqual(res.files, []);
  assert.deepEqual(res.unknown, []);
});

test("resolution: #file falls back to a real path; unknown tokens surface", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mentions-f-"));
  const real = path.join(dir, "notes.md");
  await fs.writeFile(real, "x");
  const registry = new Registry();

  const res = await resolveMentions([`#${path.basename(real)}`, "#ghost-thing"], registry, dir);
  assert.deepEqual(res.files, [real]);
  assert.deepEqual(res.unknown, ["#ghost-thing"]);
  assert.deepEqual(res.providers, []);
});

test("renderMentionNote names providers, files, and unknowns for the model", async () => {
  const note = renderMentionNote({
    providers: ["skill:deploy"],
    tools: [],
    files: ["/tmp/notes.md"],
    unknown: ["/ghost"],
  });
  assert.match(note, /USER-MENTIONED CAPABILITIES.*skill:deploy/);
  assert.match(note, /USER-MENTIONED FILES.*\/tmp\/notes\.md/);
  assert.match(note, /UNRECOGNIZED MENTIONS.*\/ghost/);
  assert.equal(renderMentionNote({ providers: [], tools: [], files: [], unknown: [] }), undefined);
});
