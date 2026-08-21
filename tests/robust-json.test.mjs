/**
 * The shared JSON locator: getting the payload out of whatever a model sent.
 *
 * Replaces four hand-rolled parsers that each knew a different subset of the
 * tricks — the plan extractor's balanced-brace scanner, the design skill's
 * first-`[`-to-last-`]` slice, `web`'s three-candidate loop, and the file
 * summarizer's fence-or-nothing regex. Each of the shapes below broke at least
 * one of them in a real run.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonArrayLoose, parseJsonLoose, parseJsonObjectLoose } from "../dist/index.js";

test("clean JSON passes through untouched and reports no repairs", () => {
  const r = parseJsonLoose('{"a":1,"b":[1,2]}');
  assert.deepEqual(r.value, { a: 1, b: [1, 2] });
  assert.deepEqual(r.repairs, []);
});

test("prose before and after", () => {
  const r = parseJsonLoose('Sure! Here is the summary:\n{"a":1}\nLet me know if you need anything else.');
  assert.deepEqual(r.value, { a: 1 });
  assert.deepEqual(r.repairs, ["extracted the JSON from surrounding text"]);
});

test("code fences, closed and unclosed", () => {
  assert.deepEqual(parseJsonLoose('Here:\n```json\n{"a":1}\n```\nDone.').value, { a: 1 });
  // Cut off mid-fence — the response ran out of tokens before the closing ```.
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}').value, { a: 1 });
});

test("a brace inside a string is text, not structure", () => {
  // The shape that mangles every naive first-brace/last-brace slicer: a snippet
  // field carrying code.
  const r = parseJsonLoose('{"snippet":"void f() { g(); }","path":"/a.dart"}');
  assert.equal(r.value.snippet, "void f() { g(); }");
  assert.equal(r.value.path, "/a.dart");
  assert.deepEqual(r.repairs, []);
});

test("the real payload wins over an incidental brace in the preamble", () => {
  const r = parseJsonLoose('I checked {} first, then produced {"files":[1,2,3],"codeSummary":"the story"}');
  assert.deepEqual(r.value.files, [1, 2, 3]);
});

test("trailing text after a complete value", () => {
  // "Extra data" — what a spilled `deliver` argument looks like.
  assert.deepEqual(parseJsonArrayLoose('[{"a":1}], "codeSummary": "hi"'), [{ a: 1 }]);
});

test("sloppy-but-unambiguous syntax", () => {
  assert.deepEqual(parseJsonLoose('{"a":1,}').value, { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a": True, "b": False, "c": None}').value, { a: true, b: false, c: null });
  assert.deepEqual(parseJsonLoose("{'a': 1}").value, { a: 1 });
  assert.deepEqual(parseJsonLoose('{“a”: 1}').value, { a: 1 });
});

test("an apostrophe inside a real string is never rewritten", () => {
  // The single-quote repair only runs when the text has NO double quotes at all,
  // precisely so "don't" survives.
  const r = parseJsonLoose('{"note":"don\'t touch this","a":1}');
  assert.equal(r.value.note, "don't touch this");
  assert.deepEqual(r.repairs, []);
});

test("truncation: the tail is dropped, never invented", () => {
  // Cut cleanly between records.
  assert.deepEqual(parseJsonArrayLoose('[{"a":1},{"b":2}'), [{ a: 1 }, { b: 2 }]);

  // Cut mid-record: the field it was part-way through is gone, the ones that
  // fully arrived are kept, and nothing is fabricated.
  const partial = parseJsonArrayLoose('[{"path":"/a","role":"x"},{"path":"/b","role":');
  assert.equal(partial.length, 2);
  assert.deepEqual(partial[0], { path: "/a", role: "x" });
  assert.deepEqual(partial[1], { path: "/b" }, "the incomplete field is dropped, not guessed");

  // Cut inside a string value.
  const str = parseJsonObjectLoose('{"a":1,"summary":"the polling never sta');
  assert.equal(str.a, 1);
  assert.equal(str.summary, "the polling never sta");

  // Says what it did.
  assert.match(
    parseJsonLoose('[{"a":1},{"b":', "array").repairs.join(" "),
    /closed a truncated value.*dropping 1 incomplete trailing item/,
  );
});

test("a nested value never beats the value containing it", () => {
  // `{"a":1}` parses cleanly and the array does not — answering with the inner
  // record would silently discard the rest of the list.
  const r = parseJsonLoose('[{"a":1},{"b":2},{"c":3}');
  assert.ok(Array.isArray(r.value), `expected the array, got ${JSON.stringify(r.value)}`);
  assert.equal(r.value.length, 3);
});

test("the wanted shape is respected", () => {
  assert.equal(parseJsonObjectLoose("[1,2,3]"), undefined, "an array is not an object");
  assert.equal(parseJsonArrayLoose('{"a":1}'), undefined, "an object is not an array");
  // With both present, the caller's want decides which is returned.
  assert.deepEqual(parseJsonObjectLoose('prose [1,2] more {"a":1} tail'), { a: 1 });
  assert.deepEqual(parseJsonArrayLoose('prose [1,2] more {"a":1} tail'), [1, 2]);
});

test("it gives up rather than guessing", () => {
  for (const input of [
    "there is no json here at all",
    "",
    "   ",
    "{",
    "[",
    "{ this is not json at all, just prose in braces",
    undefined,
    null,
    42,
    { already: "an object" },
  ]) {
    assert.equal(parseJsonLoose(input), undefined, `should not have parsed: ${String(input)}`);
  }
});

test("a scalar is not a payload — objects and arrays only", () => {
  // Callers want a structure; a bare number found in prose is a false positive.
  assert.equal(parseJsonLoose("42"), undefined);
  assert.equal(parseJsonLoose('"just a string"'), undefined);
  assert.equal(parseJsonLoose("true"), undefined);
});

test("pathological input terminates", () => {
  // Deeply nested and brace-heavy text must not hang or blow the stack.
  const deep = "[".repeat(500) + "]".repeat(500);
  parseJsonLoose(deep);
  const braces = "{ ".repeat(2000);
  parseJsonLoose(braces);
  const long = `{"a":"${"x".repeat(50_000)}`;
  assert.equal(parseJsonObjectLoose(long).a.length, 50_000);
});
