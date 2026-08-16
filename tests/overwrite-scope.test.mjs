/**
 * Scope discipline when an escalated `write` OVERWRITES an existing file.
 *
 * The bug these lock down, reported from a real run: a user asked to redesign only
 * the header and got an entirely new website. `write` replaces a file wholesale,
 * and the authoring model was handed the task text, the path, the plan and some
 * style snippets — but NOT the file it was about to overwrite. `previousContent`
 * was read by the tool and used only to compute a diff for the result. So a
 * full-file author with no file authored from imagination, and everything it did
 * not think to reproduce was deleted.
 *
 * `edit` never had this problem: its `oldString` anchor bounds the change
 * structurally, and it already passed `currentContent`. For `write` the only bound
 * is the instruction, so these tests assert the file is actually supplied and that
 * the prompt says what to do with it.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CODING_TOOLS, LogStore, OpenRouterBridge, PermissionGate, runToolLoop } from "../dist/index.js";

const AUTHOR = "test/author-model";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(content, stopReason = "stop") {
  return {
    role: "assistant", content, model: "x", api: "openrouter",
    provider: "x", usage: zeroUsage(), stopReason, timestamp: 0,
  };
}

const EXISTING_SITE = `<!doctype html>
<html>
  <head><title>Acme</title></head>
  <body>
    <header class="site-header"><h1>Acme</h1></header>
    <main>
      <section id="pricing">Pricing table nobody asked to change</section>
      <section id="testimonials">Testimonials nobody asked to change</section>
    </main>
    <footer>© Acme</footer>
  </body>
</html>
`;

/**
 * Run one escalated write against an EXISTING file and capture what the authoring
 * model was actually given.
 */
async function escalatedWrite({
  existing = EXISTING_SITE,
  task = "redesign only the header",
  draft = "<html>draft</html>",
  mode = "write",
  oldString,
} = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "overwrite-scope-"));
  const target = path.join(tmp, "index.html");
  if (existing !== null) await fs.writeFile(target, existing, "utf8");

  let systemPrompt = "";
  let userText = "";
  const llm = new OpenRouterBridge();
  llm.complete = async (_model, ctx) => {
    systemPrompt = ctx.systemPrompt ?? "";
    const c = ctx.messages[0]?.content;
    userText = typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return msg([{ type: "text", text: "AUTHORED\n" }]);
  };
  let done = false;
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    if (!done) {
      done = true;
      const call =
        mode === "edit"
          ? { type: "toolCall", id: "t1", name: "edit", arguments: { path: target, oldString, newString: draft } }
          : { type: "toolCall", id: "w1", name: "write", arguments: { path: target, content: draft } };
      yield { type: "done", message: msg([call], "tool_use") };
      return;
    }
    yield { type: "done", message: msg([{ type: "text", text: "ok" }]) };
  };

  const tool = mode === "edit" ? CODING_TOOLS.find((t) => t.name === "edit") : CODING_TOOLS.find((t) => t.name === "write");
  await runToolLoop({
    task,
    userMessage: "go",
    tools: [tool],
    model: { id: "test/driver", openRouterSlug: "test/driver" },
    llm,
    permission: new PermissionGate("ask-all", async () => ({ allowed: true, authorModel: AUTHOR })),
    logStore: new LogStore(),
    emit: () => {},
    cwd: tmp,
  });

  return { systemPrompt, userText, onDisk: await fs.readFile(target, "utf8") };
}

test("the authoring model is given the file it is about to overwrite", async () => {
  // The whole bug in one assertion. Without the current contents in the prompt, a
  // full-file author cannot preserve what it was not asked to change.
  const { userText } = await escalatedWrite();
  assert.match(userText, /CURRENT FILE CONTENTS/, "the existing file must be in the prompt");
  assert.match(userText, /section id="pricing"/, "the untouched sections must be visible to the author");
  assert.match(userText, /section id="testimonials"/);
  assert.match(userText, /footer/);
});

test("the prompt frames the call as modifying, not authoring from scratch", async () => {
  const { userText } = await escalatedWrite();
  assert.match(userText, /MODIFY THE EXISTING FILE/);
  assert.doesNotMatch(userText, /^AUTHOR THE FILE/m, "creating and modifying must not read the same");
  assert.match(userText, /COMPLETE updated file/, "it must be told to output the whole file back");
});

test("a modify write carries the current file and a preserve-unchanged rule", async () => {
  // The OLD OVERWRITE_SCOPE clause ("anything you omit is DELETED", change-zone/
  // keep-zone) was removed because it suppressed creative work (see the SVG
  // regression notes below). But the format contract ALONE turned out
  // insufficient for modify writes: a whole-file rewrite with no preserve
  // instruction re-derived the file from the task and silently regressed
  // already-correct content (an applied title edit reverted to the run task's
  // wording). So a modify write now carries a narrow preserve-unchanged RULE —
  // NOT the old change-zone/keep-zone zoning or the "be boring" closer, which
  // stay gone. What must hold: the file reaches the author, the format contract
  // is present, the new preserve rule is present, and the removed phrasings stay
  // absent.
  const { systemPrompt, userText } = await escalatedWrite();
  assert.match(userText, /CURRENT FILE CONTENTS/, "the existing file still reaches the author");
  assert.match(userText, /section id="pricing"/, "untouched sections are visible");
  assert.match(systemPrompt, /written to disk verbatim/, "format contract present");
  assert.match(systemPrompt, /KEEP UNCHANGED everything the task does not explicitly ask to change/, "preserve-unchanged rule present for modify writes");
  assert.match(systemPrompt, /VERBATIM/, "the rule says to copy unchanged bytes verbatim");
  assert.doesNotMatch(systemPrompt, /anything you omit is DELETED/i, "the old destructive clause stays gone");
  assert.doesNotMatch(systemPrompt, /CHANGE ZONE|KEEP ZONE/, "no zoning framing");
  assert.doesNotMatch(systemPrompt, /prefer the boring/i, "no 'be boring' closer");
});

test("a NEW file does not get the preserve-unchanged rule (nothing to preserve)", async () => {
  // The rule exists to stop a re-derivation regressing existing content; a
  // greenfield write has no existing content, so the rule would be noise (and
  // noise on creative writes is exactly what the old removal was about).
  const { systemPrompt } = await escalatedWrite({ existing: null });
  assert.doesNotMatch(systemPrompt, /KEEP UNCHANGED/);
  assert.doesNotMatch(systemPrompt, /OVERWRITES an existing file/);
});

test("the task's scope reaches the author alongside the file", async () => {
  // "redesign only the header" is the bound on the change; if the task is missing,
  // the scope rules have nothing to scope to.
  const { userText } = await escalatedWrite({ task: "redesign only the header" });
  assert.match(userText, /redesign only the header/);
});

test("creating a NEW file does not get the modify-in-place instructions", async () => {
  // `readExistingFile` returns "" for a missing file, so a naive null check would
  // put "reproduce the existing file in full" on a brand-new file and tell it to
  // preserve contents that do not exist.
  const { systemPrompt, userText } = await escalatedWrite({ existing: null });
  assert.doesNotMatch(systemPrompt, /ALREADY EXISTS/);
  assert.doesNotMatch(userText, /CURRENT FILE CONTENTS/);
  assert.match(userText, /AUTHOR THE FILE/);
});

test("an existing but EMPTY file is treated as a creation", async () => {
  // Nothing to preserve, so the preservation rules would be noise at best and
  // contradictory at worst. Truthiness (not null-check) gates both the
  // CURRENT FILE CONTENTS block and the preserve-unchanged system rule.
  const { systemPrompt, userText } = await escalatedWrite({ existing: "" });
  assert.doesNotMatch(systemPrompt, /ALREADY EXISTS/);
  assert.doesNotMatch(systemPrompt, /KEEP UNCHANGED/, "empty file gets no preserve rule");
  assert.doesNotMatch(userText, /CURRENT FILE CONTENTS/);
});

test("the authored bytes still reach disk", async () => {
  // Guard against fixing the prompt and breaking the write.
  const { onDisk } = await escalatedWrite();
  assert.equal(onDisk, "AUTHORED\n");
});

test("a GREENFIELD escalated write does NOT forward the weak model's draft to the author", async () => {
  // The regression this locks down, observed against SVG generation: the same
  // prompt + same strong model produced great art in a chat UI and mediocre art
  // through the harness. The cause was that the harness forwarded Model A's full
  // draft (weak geometry, for SVG) to the authoring model, and "keep its scope
  // and purpose" anchored the strong model to the weak draft's geometry instead
  // of letting it draw from scratch.
  //
  // The draft is no longer forwarded on ANY write — greenfield OR modify — because
  // the task + current contents already specify the change and the draft is pure
  // anchor weight. This test covers the greenfield path; the modify path is the
  // same code branch.
  const driverDraft = "<circle r='5' fill='weak-model-geometry'/>UNIQUE_DRAFT_MARKER";
  const { userText, systemPrompt } = await escalatedWrite({
    existing: null,
    task: "draw a realistic planet from scratch",
    draft: driverDraft,
  });

  // The authoring model must NOT see Model A's draft, and must NOT be told to
  // treat anything as a sketch to preserve. It authors from the task alone.
  assert.doesNotMatch(userText, /UNIQUE_DRAFT_MARKER/, "greenfield must not forward the weak draft");
  assert.doesNotMatch(userText, /SKETCH FROM THE WEAKER MODEL/, "no draft-intent clause without a draft");
  assert.doesNotMatch(systemPrompt, /BOUNDS SCOPE ONLY/);
  // Sanity: the task itself still reaches the author, so it has something to draw.
  assert.match(userText, /draw a realistic planet from scratch/);
  // And it is framed as creation, not modification.
  assert.match(userText, /AUTHOR THE FILE/);
});

test("an escalated EDIT does NOT forward the weak model's draft replacement to the author", async () => {
  // The edit path mirrors the write path: the strong model authors the
  // replacement from the ANCHOR (where) + the WHOLE FILE (context) + the TASK
  // (intent), not from Model A's `newString` draft. The draft was originally
  // forwarded to stop B "inventing a different change", but B now receives the
  // whole file, so the change is specified rather than guessed — and forwarding
  // the draft anchors B to A's take on it. Symptom if this regresses and the
  // whole-file context turns out insufficient: the driver editing the same region
  // repeatedly; restoring `draftReplacement` at the call site is the revert.
  const driverDraft = "<header class='weak-model-take'>UNIQUE_EDIT_DRAFT_MARKER</header>";
  const { userText, systemPrompt } = await escalatedWrite({
    mode: "edit",
    task: "redesign the header",
    draft: driverDraft,
    oldString: '<header class="site-header"><h1>Acme</h1></header>',
  });

  assert.doesNotMatch(userText, /UNIQUE_EDIT_DRAFT_MARKER/, "edit must not forward the weak draft replacement");
  assert.doesNotMatch(userText, /SKETCH FROM THE WEAKER MODEL/, "no draft-intent clause without a draft");
  assert.doesNotMatch(systemPrompt, /BOUNDS SCOPE ONLY/);
  // The anchor (where to edit) and the whole file (context) still reach the author.
  assert.match(userText, /TEXT TO REPLACE \(the anchor/);
  assert.match(userText, /CURRENT FILE CONTENTS/);
  assert.match(userText, /redesign the header/);
});

test("NO authoring call carries the backend-correctness risk checklist or 'be boring' framing", async () => {
  // The risk checklist ("walk these six places: conditionals, async, loops..."),
  // its "prefer the boring version" closer, the change-zone/keep-zone framing,
  // and the draft-intent clause have ALL been removed from every authoring
  // prompt. They accreted to fix real failures but together carried ~3.6KB of
  // steering the model never sees in a chat turn — and that steering suppressed
  // the work it was meant to improve (a model told to "prefer the boring
  // version" draws conservative SVG). What remains is the format contract.
  // This test pins that for a visual write; the same holds for code writes.
  const { systemPrompt } = await escalatedWrite({
    existing: null,
    task: "create a realistic solar system animation as SVG",
  });

  assert.doesNotMatch(systemPrompt, /CONDITIONALS AND BRANCHES/, "no backend risk checklist");
  assert.doesNotMatch(systemPrompt, /SYNC VS ASYNC/);
  assert.doesNotMatch(systemPrompt, /prefer the boring/i, "must not tell any write to be boring");
  assert.doesNotMatch(systemPrompt, /CHANGE ZONE|KEEP ZONE/, "no zoning framing");
  assert.match(systemPrompt, /written to disk verbatim/, "format contract present");
});
