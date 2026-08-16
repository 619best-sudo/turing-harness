/**
 * The fused `drive` tool: one call per automation step.
 *
 * A stub registry exposes fake Playwright-MCP tools that record every call, so
 * each test asserts BOTH the collapsed call count (what the model spends) and
 * the resolution correctness (what actually got clicked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDriveTool } from "../dist/tools/builtin/drive.js";

function fakeRegistry(page = {}) {
  const calls = [];
  const mk = (name, impl) => ({
    name,
    description: name,
    parameters: { type: "object" },
    async execute(_id, args) {
      calls.push({ name, args });
      return impl(args);
    },
  });
  const tools = [
    mk("browser_navigate", async (a) => ({ output: `navigated to ${a.url}` })),
    mk("browser_snapshot", async () => ({
      output:
        (page.snapshot ?? "")
        + '- button "Sign in" [ref=e12]\n'
        + '- textbox "Email" [ref=e21]\n'
        + '- heading "Welcome" [ref=e5]\n'
        + (page.extra ?? ""),
    })),
    mk("browser_click", async (a) => ({ output: `clicked [${a.ref}] ${a.element}` })),
    mk("browser_type", async (a) => ({ output: `typed into [${a.ref}]` })),
    mk("browser_select_option", async (a) => ({ output: `selected ${JSON.stringify(a.values)} in [${a.ref}]` })),
    mk("browser_press_key", async (a) => ({ output: `pressed ${a.key}` })),
    mk("browser_take_screenshot", async () => ({
      output: "screenshot ok",
      content: [{ type: "image", data: "c3NyZWVu", mimeType: "image/png" }],
    })),
    mk("browser_close", async () => ({ output: "closed" })),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    calls,
    getTool: (n) => byName.get(n),
    allTools: () => tools,
  };
}

const drive = () => createDriveTool();
const ctxOf = (registry) => ({ cwd: process.cwd(), registry, log: () => {} });
const called = (calls, name) => calls.filter((c) => c.name === name);

test("look: screenshot + elements in ONE call (2 internal, 1 model call)", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t1", { action: "look" }, ctxOf(reg));
  assert.ok(!res.isError);
  assert.match(res.output, /Sign in/);
  assert.match(res.output, /\[ref=e12\]/);
  assert.equal(res.content.length, 1, "the screenshot is attached");
  // The MODEL made one call; the tool made two internal ones. What the model
  // would otherwise have spent: snapshot + screenshot + parse = 2+ turns.
  assert.equal(called(reg.calls, "browser_snapshot").length, 1);
  assert.equal(called(reg.calls, "browser_take_screenshot").length, 1);
});

test("click by description: resolve → act → post-shot, one model call", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t2", { action: "click", target: "Sign in" }, ctxOf(reg));
  assert.ok(!res.isError, res.output);
  const clicks = called(reg.calls, "browser_click");
  assert.equal(clicks.length, 1, "exactly one click");
  assert.equal(clicks[0].args.ref, "e12");
  assert.equal(clicks[0].args.element, "Sign in");
  // The result carries the post-action screenshot — no follow-up look needed.
  assert.equal(res.content.length, 1);
  assert.match(res.output, /Clicked/);
  // Internal calls: snapshot(before) + click + snapshot(after) + screenshot = 4,
  // but the MODEL spent exactly one. That is the collapse.
  assert.deepEqual(
    reg.calls.map((c) => c.name),
    ["browser_snapshot", "browser_click", "browser_snapshot", "browser_take_screenshot"],
  );
});

test("click by verbatim ref from a previous look", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t3", { action: "click", target: "ref=e21" }, ctxOf(reg));
  assert.ok(!res.isError);
  assert.equal(called(reg.calls, "browser_type").length, 0);
  assert.equal(called(reg.calls, "browser_click")[0].args.ref, "e21");
});

test("fill and select route to the right tool with the right args", async () => {
  const reg = fakeRegistry();
  await drive().execute("t4", { action: "fill", target: "Email", text: "a@b.c" }, ctxOf(reg));
  const typed = called(reg.calls, "browser_type");
  assert.equal(typed.length, 1);
  assert.equal(typed[0].args.text, "a@b.c");
  assert.equal(typed[0].args.ref, "e21");

  const reg2 = fakeRegistry();
  const res = await drive().execute("t5", { action: "select", target: "Email", value: "work" }, ctxOf(reg2));
  assert.ok(!res.isError, res.output);
  const sel = called(reg2.calls, "browser_select_option");
  assert.equal(sel.length, 1);
  assert.deepEqual(sel[0].args.values, ["work"]);
});

test("an ambiguous target lists candidates instead of guessing", async () => {
  const reg = fakeRegistry({ extra: '- button "Sign in (dark)" [ref=e99]\n' });
  // "Sign in" alone is an EXACT match for one button and clicks it; "Sign"
  // substring-matches both and must stop and list them.
  const exact = await drive().execute("t6a", { action: "click", target: "Sign in" }, ctxOf(reg));
  assert.ok(!exact.isError, "an exact name match wins without ambiguity");
  const reg2 = fakeRegistry({ extra: '- button "Sign in (dark)" [ref=e99]\n' });
  const res = await drive().execute("t6", { action: "click", target: "Sign" }, ctxOf(reg2));
  assert.equal(res.isError, true);
  assert.match(res.output, /matches 2 elements/);
  assert.match(res.output, /Sign in \(dark\)/);
  assert.equal(called(reg2.calls, "browser_click").length, 0, "nothing was clicked");
});

test("a missed target lists the page's interactive elements", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t7", { action: "click", target: "Checkout" }, ctxOf(reg));
  assert.equal(res.isError, true);
  assert.match(res.output, /no element matching "Checkout"/);
  assert.match(res.output, /button "Sign in"/);
});

test("shot: the final capture for media_analysis", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t8", { action: "shot" }, ctxOf(reg));
  assert.ok(!res.isError);
  assert.equal(res.content.length, 1);
  assert.match(res.output, /media_analysis/);
  assert.deepEqual(reg.calls.map((c) => c.name), ["browser_take_screenshot"], "one internal call only");
});

test("open navigates, settles, and summarizes the page", async () => {
  const reg = fakeRegistry();
  const res = await drive().execute("t9", { action: "open", url: "http://localhost:5173" }, ctxOf(reg));
  assert.ok(!res.isError);
  assert.match(res.output, /Opened\*\* http:\/\/localhost:5173/);
  assert.match(res.output, /Sign in/);
  assert.equal(called(reg.calls, "browser_navigate")[0].args.url, "http://localhost:5173");
});

test("no browser MCP → one actionable error, not a stack trace", async () => {
  const res = await drive().execute("t10", { action: "look" }, ctxOf(undefined));
  assert.equal(res.isError, true);
  assert.match(res.output, /no browser MCP is connected/);
  assert.match(res.output, /@playwright\/mcp/);
});

test("tool metadata: mutating, inspection-scoped, one-call framing", async () => {
  const t = drive();
  assert.equal(t.name, "drive");
  assert.equal(t.mutates, true);
  assert.deepEqual(t.categorizers, ["activity_inspect"]);
});
