/**
 * A string containing JSON, where the schema asked for structure.
 *
 * From a real run: `read` delivered nine correctly-described files and handed on
 * none of them, because `files` — declared in the deliver schema as an array of
 * objects — arrived as a STRING of JSON:
 *
 *     files: "[{\"path\": \"/lead_list_screen.dart\", \"role\": \"contacts list\", …}]"
 *
 * Every field the contract asked for was present and correct, one layer too deep.
 * Nothing threw. The deliverable simply carried a string where the next
 * categorizer's opening expects a list, so the structured file handoff the whole
 * read→write_edit contract is built on rendered as an opaque blob.
 *
 * The mirror direction (an array where a string was wanted) was already handled;
 * this is the other half.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  coerceFromJsonString,
  coerceStringArgs,
  coercionNote,
  deliverSchemaFor,
  recoverSpilledArgs,
} from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ_DELIVER = {
  name: "deliver",
  description: "",
  parameters: deliverSchemaFor({
    id: "read",
    children: ["write_edit", "activity_inspect"],
    returns: { kind: "code-summary" },
  }),
};

const tool = (properties) => ({ name: "t", description: "", parameters: { type: "object", properties } });

test("a JSON string is unwrapped where the schema wants an array", () => {
  const t = tool({ files: { type: "array", items: { type: "object" } } });
  const { args, coerced } = coerceStringArgs(t, {
    files: '[{"path": "/a.dart", "role": "list screen"}, {"path": "/b.dart"}]',
  });
  assert.ok(Array.isArray(args.files));
  assert.equal(args.files.length, 2);
  assert.equal(args.files[0].path, "/a.dart");
  assert.deepEqual(coerced, [{ key: "files", from: "JSON string", to: "array" }]);
});

test("a JSON string is unwrapped where the schema wants an object", () => {
  const t = tool({ meta: { type: "object" } });
  const { args, coerced } = coerceStringArgs(t, { meta: '{"verdict": "fail"}' });
  assert.deepEqual(args.meta, { verdict: "fail" });
  assert.equal(coerced[0].to, "object");
});

test("a doubly-encoded value is left for normal validation", () => {
  // It arrives wrapped in quotes, so it never passes the bracket check — one
  // unambiguous reading is the bar, and encoding twice is not one.
  const doubled = JSON.stringify(JSON.stringify([{ path: "/a.dart" }]));
  assert.equal(coerceFromJsonString(doubled, "array"), undefined);
  // Single encoding — the real case — is taken.
  assert.deepEqual(coerceFromJsonString(JSON.stringify([{ path: "/a.dart" }]), "array")?.value, [
    { path: "/a.dart" },
  ]);
});

test("it never guesses: only a successful parse OF THE RIGHT SHAPE is taken", () => {
  const t = tool({ files: { type: "array" }, meta: { type: "object" } });
  // Truncated JSON is repaired by the shared locator, which drops the incomplete
  // tail rather than the whole value — the records that arrived survive.
  const truncated = coerceStringArgs(t, { files: '[{"path": "/a.dart"' });
  assert.deepEqual(truncated.args.files, [{ path: "/a.dart" }]);
  assert.match(truncated.coerced[0].from, /closed a truncated value/);
  // Genuinely unrecoverable text is still left for normal validation to reject.
  assert.deepEqual(coerceStringArgs(t, { files: "[not json at all" }).coerced, []);
  // An object where an array was declared is NOT silently wrapped.
  assert.deepEqual(coerceStringArgs(t, { files: '{"path": "/a.dart"}' }).coerced, []);
  // Ordinary prose stays prose, even when it parses as JSON.
  assert.deepEqual(coerceStringArgs(t, { files: "the files I read" }).coerced, []);
  assert.deepEqual(coerceStringArgs(t, { meta: "42" }).coerced, []);
  assert.deepEqual(coerceStringArgs(t, { meta: '"just a string"' }).coerced, []);
});

test("a field that legitimately accepts a string is never touched", () => {
  // `["string","array"]` means both shapes are valid — the string is the answer,
  // not a serialisation mistake.
  const t = tool({ either: { type: ["string", "array"] }, note: { type: "string" } });
  const { args, coerced } = coerceStringArgs(t, { either: '["a","b"]', note: '{"a":1}' });
  assert.equal(args.either, '["a","b"]');
  assert.equal(args.note, '{"a":1}');
  assert.deepEqual(coerced, []);
});

test("the mirror direction still works, and both can happen in one call", () => {
  const t = tool({ content: { type: "string" }, files: { type: "array" } });
  const { args, coerced } = coerceStringArgs(t, {
    content: ["line one", "line two"],
    files: '[{"path":"/a.dart"}]',
  });
  assert.equal(args.content, "line one\nline two");
  assert.deepEqual(args.files, [{ path: "/a.dart" }]);
  assert.deepEqual(coerced.map((c) => c.to ?? "string"), ["string", "array"]);
});

test("the note tells the model the right thing for each direction", () => {
  const joined = coercionNote([{ key: "content", from: "array of 2 strings" }], "write");
  assert.match(joined, /joined into a plain string/);
  assert.ok(!/REAL JSON/.test(joined));

  const parsed = coercionNote([{ key: "files", from: "JSON string", to: "array" }], "deliver");
  assert.match(parsed, /'files' arrived as a JSON string \(expected an array\)/);
  assert.match(parsed, /REAL JSON values, not as a string containing JSON/);
  assert.ok(!/joined into a plain string/.test(parsed), "a parsed field was not joined");

  // Both directions in one call produce both notes, not a blended wrong one.
  const both = coercionNote(
    [{ key: "content", from: "array of 2 strings" }, { key: "files", from: "JSON string", to: "array" }],
    "deliver",
  );
  assert.match(both, /joined into a plain string/);
  assert.match(both, /REAL JSON values/);
});

test("the actual failing payload: read's deliver survives it", () => {
  // The shape from the run, verbatim in structure.
  const raw = JSON.stringify([
    {
      path: "/Users/x/lib/screens/lead_list/lead_list_screen.dart",
      role: "contacts list screen",
      lines: "113-118",
      snippet: "WidgetsBinding.instance.addPostFrameCallback((_) {",
      summary: "initState calls loadFirstPage but never triggers _recomputeVisibleLeads",
    },
    { path: "/Users/x/lib/services/enrichment_polling_service.dart", role: "polling", lines: "81-119" },
  ]);
  const readTool = {
    name: "deliver",
    description: "",
    parameters: deliverSchemaFor({ id: "read", children: ["write_edit"], returns: { kind: "code-summary" } }),
  };
  const { args, coerced } = coerceStringArgs(readTool, { files: raw, codeSummary: "## Bug Summary…" });

  assert.ok(Array.isArray(args.files), "files must reach the chain as a list");
  assert.equal(args.files.length, 2);
  assert.equal(args.files[0].lines, "113-118");
  assert.equal(args.codeSummary, "## Bug Summary…", "the prose field is untouched");
  assert.equal(coerced.length, 1);
});

// ---------------------------------------------------------------------------
// The worse shape: the whole argument object inside the first field
// ---------------------------------------------------------------------------

test("the argument list is recovered when one field swallowed it — the real payload", () => {
  // Captured verbatim from the run: `deliver` was called with ONE argument,
  // `files`, whose string ran past the array's `]` and carried codeSummary,
  // projectCategory and nextCategorizers along with it. The run saw "missing
  // required argument 'codeSummary'", re-sent the identical call, and died.
  const spilled = fs.readFileSync(path.join(HERE, "fixtures", "deliver-spilled-args.txt"), "utf8");
  assert.throws(() => JSON.parse(spilled), "the fixture must be the broken shape, not valid JSON");

  const { args, coerced } = coerceStringArgs(READ_DELIVER, { files: spilled });

  assert.ok(Array.isArray(args.files), "files must come back as a list");
  assert.equal(args.files.length, 2);
  assert.match(args.files[0].path, /lead_list_screen\.dart$/);
  assert.match(String(args.codeSummary), /^Two related bugs in the contacts\/enrichment polling system/);
  assert.equal(args.projectCategory, "frontend");
  // And the routing nomination survives — this run wanted write_edit all along.
  assert.deepEqual(args.nextCategorizers, ["write_edit"]);
  assert.deepEqual(coerced, [{ key: "files", from: "the whole argument object", to: "arguments" }]);
});

test("recovery is exact, not a guess", () => {
  const t = tool({ files: { type: "array" }, codeSummary: { type: "string" } });

  // Only keys the schema declares. A parse that succeeds but invents fields is a
  // different message than the one the contract asked for, so it is refused.
  assert.equal(
    recoverSpilledArgs(t, { files: '[1,2], "somethingElse": "x"' }),
    undefined,
    "an undeclared recovered key must reject the whole repair",
  );
  // Must recover MORE than it started with.
  assert.equal(recoverSpilledArgs(t, { files: "[1,2]" }), undefined, "a clean value did not spill");
  // Unparseable even with the prefix restored: left for normal validation.
  assert.equal(recoverSpilledArgs(t, { files: '[1,2], "codeSummary": ' }), undefined);
  // Prose is never touched.
  assert.equal(recoverSpilledArgs(t, { files: "the files I read" }), undefined);
  // The real shape works, and an argument sent correctly alongside it survives.
  const ok = recoverSpilledArgs(t, { files: '[{"path":"/a"}], "codeSummary": "the story"' });
  assert.deepEqual(ok.args.files, [{ path: "/a" }]);
  assert.equal(ok.args.codeSummary, "the story");
  assert.equal(ok.key, "files");
});

test("the spill note tells the model what it actually did wrong", () => {
  const note = coercionNote([{ key: "files", from: "the whole argument object", to: "arguments" }], "deliver");
  assert.match(note, /collapsed into 'files' as one string/);
  assert.match(note, /never closed it/);
  assert.match(note, /no field contains the others/);
  assert.ok(!/joined into a plain string/.test(note));
});
