import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createProjectMemoryTool,
  resolveProjectMemoryAction,
} from "../dist/index.js";

test("resolveProjectMemoryAction infers a safe action when the model omits it", () => {
  // Explicit action always wins.
  assert.equal(resolveProjectMemoryAction({ action: "remember", text: "x" }), "remember");
  // `category` is only used by set_category, so it's an unambiguous signal.
  assert.equal(resolveProjectMemoryAction({ category: "backend" }), "set_category");
  // text alone → recall (read-only); a write is never inferred.
  assert.equal(resolveProjectMemoryAction({ text: "api base path" }), "recall");
  // Blank action is treated as omitted, then inferred.
  assert.equal(resolveProjectMemoryAction({ action: "  ", category: "frontend" }), "set_category");
  // Nothing to go on → full read.
  assert.equal(resolveProjectMemoryAction({}), "get");
});

test("project_memory tool no longer requires 'action' (so valid calls aren't rejected up front)", () => {
  const tool = createProjectMemoryTool(/** @type {any} */ ({}));
  assert.ok(Array.isArray(tool.parameters.required));
  assert.ok(
    !tool.parameters.required.includes("action"),
    "action must be optional so the phase-runner arg guard doesn't reject read-only calls",
  );
});
