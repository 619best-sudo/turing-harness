/**
 * Categorizer setup validation + the default setup's shape.
 *
 * `createCategorizerSetup` is the config-file contract: a bad setup must fail
 * at STARTUP with a nameable error, never mid-run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defineCategorizer,
  createCategorizerSetup,
  createDefaultCategorizers,
  getCategory,
  entryCategories,
  DEFAULT_CATEGORIZER_SETUP,
  DEFAULT_GLOBAL_TOOLS,
} from "../dist/categorizer-setup.js";

const base = (over = {}) => ({
  id: "deploy",
  name: "Deploy",
  description: "Ship the verified build.",
  systemPrompt: "You are the DEPLOY categorizer. %%GUIDANCE%% %%ESCALATION%%",
  tools: ["bash"],
  children: [],
  returns: { kind: "summary", description: "the deploy result" },
  ...over,
});

test("defineCategorizer normalizes and validates one definition", () => {
  const def = defineCategorizer(base({ tools: ["bash", "bash"], children: [] }));
  assert.deepEqual(def.tools, ["bash"]);
  assert.equal(def.entry, true, "entry defaults to true");
  for (const bad of [
    { id: "" },
    { id: "Bad Id" },
    { id: "ok", name: "" },
    { id: "ok", name: "n", description: "" },
    { id: "ok", name: "n", description: "d", systemPrompt: "" },
    { id: "ok", name: "n", description: "d", systemPrompt: "s", returns: { kind: "custom-kind" } },
  ]) {
    assert.throws(() => defineCategorizer(base(bad)), undefined, JSON.stringify(bad));
  }
  // A custom kind WITH a deliver schema is fine.
  assert.doesNotThrow(() =>
    defineCategorizer(base({ returns: { kind: "custom", description: "d", deliverSchema: { type: "object" } } })),
  );
});

test("createCategorizerSetup rejects dangling children / accepts / duplicate ids", () => {
  assert.throws(() => createCategorizerSetup({ categories: [base({ children: ["nonexistent"] })] }), /child "nonexistent"/);
  assert.throws(
    () => createCategorizerSetup({ categories: [base({ accepts: { from: ["ghost"] } })] }),
    /accepts.from "ghost"/,
  );
  assert.throws(() => createCategorizerSetup({ categories: [base(), base()] }), /duplicate ids/);
  assert.throws(() => createCategorizerSetup({ categories: [] }), /at least one category/);
  assert.throws(
    () => createCategorizerSetup({ categories: [base({ tools: ["deliver"] })] }),
    /deliver.*terminal/,
  );
});

test("at least one entry categorizer is required", () => {
  assert.throws(
    () => createCategorizerSetup({ categories: [base({ entry: false })] }),
    /at least one category must be an entry/,
  );
});

test("the default setup is the five categories with the standard graph", () => {
  const ids = DEFAULT_CATEGORIZER_SETUP.categories.map((c) => c.id);
  assert.deepEqual(ids, ["conversation", "read", "write_edit", "activity_reproduce", "activity_inspect"]);

  const byId = Object.fromEntries(DEFAULT_CATEGORIZER_SETUP.categories.map((c) => [c.id, c]));
  assert.deepEqual(byId.conversation.children, []);
  // A bug report reproduces before it is fixed; a feature goes straight to work.
  assert.deepEqual(byId.read.children, ["activity_reproduce", "write_edit"]);
  assert.deepEqual(byId.write_edit.children, ["activity_inspect"]);
  assert.deepEqual(byId.activity_reproduce.children, ["write_edit"]);
  assert.deepEqual(byId.activity_inspect.children, ["write_edit"]);

  // The two QA hops are never entry points: reproducing needs read's files, and
  // verifying needs a change to measure.
  assert.equal(byId.activity_reproduce.entry, false);
  assert.equal(byId.activity_inspect.entry, false);
  assert.equal(byId.read.entry, true);

  // One QA tool surface, two jobs.
  assert.equal(byId.activity_reproduce.toolScope, "activity_inspect");
  assert.equal(byId.activity_reproduce.returns.kind, "repro-report");
  assert.equal(byId.activity_inspect.returns.kind, "inspect-report");

  // Context passing contract:
  assert.deepEqual(byId.activity_reproduce.accepts, { from: ["read"], tools: [] });
  assert.deepEqual(byId.activity_inspect.accepts, {
    from: ["write_edit", "read", "activity_reproduce"],
    tools: ["write", "edit"],
  });
  assert.deepEqual(byId.write_edit.accepts, {
    from: ["read", "activity_reproduce", "activity_inspect"],
    tools: [],
  });

  // Globals reach every categorizer.
  for (const g of ["bash", "ask_user_question", "clearing_doubt", "web_search", "web_fetch", "web_scrape"]) {
    assert.ok(DEFAULT_GLOBAL_TOOLS.includes(g), `${g} is global`);
  }

  // create_plan is pinned in write_edit (always), inspiration too.
  assert.ok(byId.write_edit.tools.includes("create_plan"));
  assert.ok(byId.write_edit.tools.includes("inspiration_generator"));

  // Per-categorizer model slots are open (unset ⇒ role-slot default).
  for (const c of DEFAULT_CATEGORIZER_SETUP.categories) {
    assert.equal(c.model, undefined);
  }
});

test("getCategory / entryCategories helpers", () => {
  assert.equal(getCategory(DEFAULT_CATEGORIZER_SETUP, "read").name, "Read");
  assert.throws(() => getCategory(DEFAULT_CATEGORIZER_SETUP, "nope"), /unknown categorizer/);
  assert.deepEqual(
    entryCategories(DEFAULT_CATEGORIZER_SETUP).map((c) => c.id),
    ids(DEFAULT_CATEGORIZER_SETUP),
  );
  function ids(setup) {
    return setup.categories.filter((c) => c.entry !== false).map((c) => c.id);
  }
});

test("an app can extend the default setup with a new category (config-file flow)", () => {
  const deploy = base({ children: [], accepts: { from: ["activity_inspect"] } });
  const setup = createCategorizerSetup({
    categories: [...createDefaultCategorizers(), deploy],
    doubtModel: "test/senior",
    maxHops: 9,
  });
  assert.equal(setup.categories.length, 6);
  assert.equal(setup.doubtModel, "test/senior");
  assert.equal(setup.maxHops, 9);
  // And the graph accepts wiring the new node in.
  const setup2 = createCategorizerSetup({
    categories: [...createDefaultCategorizers(), base({ id: "deploy", children: [], accepts: { from: ["write_edit"] } })],
  });
  assert.ok(setup2.categories.some((c) => c.id === "deploy"));
});
