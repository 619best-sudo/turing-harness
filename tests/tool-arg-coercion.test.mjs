/**
 * A tool call whose argument TYPES are almost right.
 *
 * Tool schemas say `newString` is a string. Models routinely send an array of
 * lines, an array of content blocks, or a one-field wrapper object — and which
 * one depends on the model family, not on anything the harness controls. That is
 * a serialisation difference, not a misunderstanding: the model has said exactly
 * what it wants written.
 *
 * The old behaviour was worse than rejecting it. `edit` read the argument
 * through `String(args.newString ?? "")`, and `String(["a","b"])` is `"a,b"`, so
 * a two-line replacement went into the user's file comma-joined with no error
 * anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { coerceStringArgs, coerceToString, coercionNote } from "../dist/index.js";

const editTool = {
  name: "edit",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
    required: ["path", "oldString", "newString"],
  },
};

const newStringOf = (value) =>
  coerceStringArgs(editTool, { path: "/x", oldString: "a", newString: value }).args.newString;

test("the old silent corruption is gone", () => {
  // `String(["  const a = 1;", "  const b = 2;"])` was "  const a = 1;,  const b = 2;"
  const joined = newStringOf(["  const a = 1;", "  const b = 2;"]);
  assert.equal(joined, "  const a = 1;\n  const b = 2;");
  assert.ok(!joined.includes(";,"), "never comma-joined");
});

test("lines join with newlines; chunks that carry their own do not gain more", () => {
  assert.equal(newStringOf(["a();", "b();"]), "a();\nb();");
  assert.equal(newStringOf(["a();\n", "b();\n"]), "a();\nb();\n");
});

test("content blocks and wrapper objects are unwrapped", () => {
  assert.equal(newStringOf([{ type: "text", text: "foo();" }]), "foo();");
  assert.equal(newStringOf({ text: "foo();" }), "foo();");
  assert.equal(newStringOf({ content: "foo();" }), "foo();");
});

test("a number in a string field is not a puzzle", () => {
  assert.equal(newStringOf(42), "42");
  assert.equal(newStringOf(true), "true");
});

test("an empty array is an empty string, not a crash", () => {
  assert.equal(newStringOf([]), "");
});

test("a string is left exactly alone", () => {
  const args = { path: "/x", oldString: "a", newString: "unchanged" };
  const r = coerceStringArgs(editTool, args);
  assert.equal(r.coerced.length, 0);
  assert.equal(r.args, args, "the same object is returned when nothing changed");
});

test("anything ambiguous is left for normal validation to reject", () => {
  // The bar is "there is exactly one thing this could have meant".
  assert.equal(coerceToString([{ a: 1 }]), undefined);
  assert.equal(coerceToString([1, "a"]), undefined, "mixed array");
  assert.equal(coerceToString({ text: "a", extra: 1 }), undefined, "two fields is a structure, not a wrapper");
  assert.equal(coerceToString(null), undefined);
});

test("a schema that ACCEPTS the shape sent is not coerced", () => {
  // `["string","array"]` means both are valid; rewriting one into the other
  // would change what the tool was asked to do.
  const tool = {
    name: "t",
    parameters: { type: "object", properties: { v: { type: ["string", "array"] } }, required: [] },
  };
  const r = coerceStringArgs(tool, { v: ["a", "b"] });
  assert.equal(r.coerced.length, 0);
  assert.deepEqual(r.args.v, ["a", "b"]);
});

test("only fields the schema calls strings are touched", () => {
  const tool = {
    name: "t",
    parameters: { type: "object", properties: { s: { type: "string" }, n: { type: "number" } }, required: [] },
  };
  const r = coerceStringArgs(tool, { s: ["x"], n: 5 });
  assert.equal(r.args.s, "x");
  assert.equal(r.args.n, 5, "a number field keeps its number");
});

test("a tool with no schema properties is passed through", () => {
  const r = coerceStringArgs({ name: "t", parameters: { type: "object" } }, { a: ["x"] });
  assert.deepEqual(r.args.a, ["x"]);
  assert.equal(r.coerced.length, 0);
});

test("the repair is reported, so a model can stop doing it", () => {
  const r = coerceStringArgs(editTool, { path: "/x", oldString: "a", newString: ["a", "b"] });
  assert.deepEqual(r.coerced, [{ key: "newString", from: "array of 2 strings" }]);
  const note = coercionNote(r.coerced, "edit");
  assert.match(note, /'newString' arrived as array of 2 strings/);
  assert.match(note, /ran normally/, "the call succeeded — this is a note, not an error");
  assert.match(note, /ONE string/, "and it says what to send instead");
});
