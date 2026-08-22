/**
 * The fused `drive` tool: one call per automation step.
 *
 * TWO backends, both covered here:
 *  - the harness's OWN browser session (playwright-core) — tested against a
 *    fake page via `setWebSessionOverride`, so a test run never launches Chrome;
 *  - the legacy Playwright-MCP façade this tool used to be — a stub registry
 *    exposes fake `browser_*` tools that record every call.
 *
 * Each test asserts BOTH the collapsed call count (what the model spends) and
 * the resolution correctness (what actually got clicked).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createDriveTool } from "../dist/tools/builtin/drive.js";
import { setWebSessionOverride, closeWebSession } from "../dist/index.js";

// The façade tests below must NOT be stolen by the own-session backend:
// `drive` prefers playwright-core when it is importable (it is, as a dependency
// of this checkout) and would try to launch a real browser inside the test.
before(() => setWebSessionOverride(async () => undefined));
after(async () => {
  setWebSessionOverride(undefined);
  await closeWebSession();
});

function fakeRegistry(page = {}) {
  const calls = [];
  // A click LANDS: the next snapshot reports a new element, so a successful
  // click verifies on the first attempt (the no-change retry is exercised by
  // its own test with a page that never changes).
  let clicked = null;
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
        + (clicked ? `- button "${clicked} done" [ref=e99]\n` : "")
        + (page.extra ?? ""),
    })),
    mk("browser_click", async (a) => {
      clicked = a.element;
      return { output: `clicked [${a.ref}] ${a.element}` };
    }),
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

test("no browser and no MCP → one actionable error, not a stack trace", async () => {
  const res = await drive().execute("t10", { action: "look" }, ctxOf(undefined));
  assert.equal(res.isError, true);
  assert.match(res.output, /no browser available/);
  assert.match(res.output, /playwright-core/);
  assert.match(res.output, /@playwright\/mcp/);
});

test("tool metadata: mutating, inspection-scoped, one-call framing", async () => {
  const t = drive();
  assert.equal(t.name, "drive");
  assert.equal(t.mutates, true);
  assert.deepEqual(t.categorizers, ["activity_inspect"]);
});

// ---------------------------------------------------------------------------
// The OWN backend: the harness's browser session, no MCP anywhere near it.
// ---------------------------------------------------------------------------

function fakeOwnSession(over = {}) {
  const actions = [];
  const axTree = {
    role: "WebArea",
    name: "",
    children: [
      { role: "button", name: "Sign in" },
      { role: "textbox", name: "Email" },
      { role: "combobox", name: "Plan" },
    ],
  };
  // Geometry-scan results the in-page evaluate would return.
  const scan = over.scan ?? { viewport: { width: 1280, height: 800 }, unlabeled: [] };
  // A click LANDS when the test stages a change: the AX tree grows an element.
  const clickChanges = over.clickChanges ?? false;
  const page = {
    async goto(url, opts) { actions.push({ k: "goto", url }); },
    async waitForLoadState() {},
    getByRole(role, opts = {}) {
      return {
        first: () => ({
          async click() { actions.push({ k: "click", role, name: opts.name }); },
          async fill(text) { actions.push({ k: "fill", role, name: opts.name, text }); },
          async selectOption(v) { actions.push({ k: "select", role, name: opts.name, v }); },
        }),
      };
    },
    keyboard: { async press(key) { actions.push({ k: "press", key }); } },
    async screenshot() { return Buffer.from("png-bytes"); },
    async content() { return ""; },
    url: () => "about:blank",
    accessibility: { async snapshot() { return axTree; } },
    // The geometry channel: name-less controls enumerated with viewport rects,
    // plus the viewport — exactly what the in-page scan returns.
    async evaluate() {
      return scan;
    },
    mouse: {
      async click(x, y) {
        actions.push({ k: "mouse", x, y });
        if (clickChanges) axTree.children.push({ role: "button", name: "menu opened" });
      },
    },
  };
  return { page, actions, close: async () => { actions.push({ k: "close" }); } };
}

test("own backend: look renders the AX tree with generated refs and the screenshot — no MCP tools", async () => {
  const session = fakeOwnSession();
  setWebSessionOverride(async () => session);
  try {
    const reg = fakeRegistry(); // MCP present, but must NOT be used
    const res = await drive().execute("w1", { action: "look" }, ctxOf(reg));
    assert.ok(!res.isError, res.output);
    assert.match(res.output, /button "Sign in" \[ref=e\d+\]/, "elements carry generated refs");
    assert.equal(res.content.length, 1, "screenshot attached");
    assert.equal(res.content[0].mimeType, "image/png");
    assert.equal(reg.calls.length, 0, "the own backend never touches MCP tools");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});

test("own backend: click/fill/select act by role+name and attach the post-action shot", async () => {
  const session = fakeOwnSession();
  setWebSessionOverride(async () => session);
  try {
    const clickRes = await drive().execute("w2a", { action: "click", target: "Sign in" }, ctxOf(undefined));
    assert.ok(!clickRes.isError, clickRes.output);
    assert.match(clickRes.output, /Clicked\*\* button "Sign in"/);
    assert.equal(clickRes.content.length, 1);
    assert.deepEqual(session.actions.find((a) => a.k === "click"), { k: "click", role: "button", name: "Sign in" });

    const fillRes = await drive().execute("w2b", { action: "fill", target: "Email", text: "a@b.c" }, ctxOf(undefined));
    assert.ok(!fillRes.isError, fillRes.output);
    assert.match(fillRes.output, /Typed into/);
    assert.deepEqual(session.actions.find((a) => a.k === "fill"), { k: "fill", role: "textbox", name: "Email", text: "a@b.c" });

    const selRes = await drive().execute("w2c", { action: "select", target: "Plan", value: "pro" }, ctxOf(undefined));
    assert.ok(!selRes.isError, selRes.output);
    assert.ok(session.actions.some((a) => a.k === "select" && a.v?.label === "pro"), "select tries the label first");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});

test("own backend: open navigates, press keys, close closes the session", async () => {
  const session = fakeOwnSession();
  setWebSessionOverride(async () => session);
  try {
    const open = await drive().execute("w3a", { action: "open", url: "http://localhost:5173" }, ctxOf(undefined));
    assert.ok(!open.isError, open.output);
    assert.match(open.output, /Opened\*\* http:\/\/localhost:5173/);
    assert.equal(session.actions.find((a) => a.k === "goto")?.url, "http://localhost:5173");

    const press = await drive().execute("w3b", { action: "press", key: "Enter" }, ctxOf(undefined));
    assert.ok(!press.isError, press.output);
    assert.deepEqual(session.actions.find((a) => a.k === "press"), { k: "press", key: "Enter" });

    const close = await drive().execute("w3c", { action: "close" }, ctxOf(undefined));
    assert.ok(!close.isError);
    assert.ok(session.actions.some((a) => a.k === "close"), "close reached the session");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});


// ---------------------------------------------------------------------------
// Geometry parity with the mobile toolkit: unlabeled controls, coordinate
// clicks, click verification with re-derive.
// ---------------------------------------------------------------------------

test("look lists UNLABELED controls with refs and positions — the geometry channel", async () => {
  const session = fakeOwnSession({
    scan: {
      viewport: { width: 1280, height: 800 },
      unlabeled: [{ role: "graphic", x: 1200, y: 20, width: 32, height: 32 }],
    },
  });
  setWebSessionOverride(async () => session);
  try {
    const res = await drive().execute("g1", { action: "look" }, ctxOf(undefined));
    assert.ok(!res.isError, res.output);
    assert.match(res.output, /graphic "\(unlabeled\)" \[ref=e\d+\] @ 1200,20 32x32/, "enumerated with position");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});

test("clicking an unlabeled ref drives the mouse at its exact centre", async () => {
  const session = fakeOwnSession({
    scan: {
      viewport: { width: 1280, height: 800 },
      unlabeled: [{ role: "button", x: 1200, y: 20, width: 32, height: 32 }],
    },
    clickChanges: true, // the icon opens a menu — the click must verify on attempt 1
  });
  setWebSessionOverride(async () => session);
  try {
    const look = await drive().execute("g2a", { action: "look" }, ctxOf(undefined));
    const ref = look.output.match(/button "\(unlabeled\)" \[ref=(e\d+)\]/)[1];
    const res = await drive().execute("g2b", { action: "click", target: `ref=${ref}` }, ctxOf(undefined));
    assert.ok(!res.isError, res.output);
    const mouse = session.actions.filter((a) => a.k === "mouse");
    assert.equal(mouse.length, 1, "one coordinate click");
    assert.deepEqual({ x: mouse[0].x, y: mouse[0].y }, { x: 1216, y: 36 }, "the enumerated rect's centre");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});

test("a coordinate target clicks the exact point, and out-of-viewport fails loudly", async () => {
  const session = fakeOwnSession();
  setWebSessionOverride(async () => session);
  try {
    const inside = await drive().execute("g3a", { action: "click", target: "640, 400" }, ctxOf(undefined));
    assert.ok(!inside.isError, inside.output);
    assert.ok(session.actions.some((a) => a.k === "mouse" && a.x === 640 && a.y === 400), "clicked the point");

    session.actions.length = 0;
    const out = await drive().execute("g3b", { action: "click", target: "2000, 400" }, ctxOf(undefined));
    assert.equal(out.isError, true, "out of the 1280x800 viewport");
    assert.match(out.output, /outside the 1280x800 viewport/);
    assert.equal(session.actions.filter((a) => a.k === "mouse").length, 0, "nothing was clicked");
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});

test("a click that changes nothing is re-derived once against a fresh snapshot", async () => {
  // The page never changes: click 1 changes nothing, the re-derive clicks
  // again, and the result reports both attempts instead of a fake success.
  const session = fakeOwnSession();
  setWebSessionOverride(async () => session);
  try {
    const res = await drive().execute("g4", { action: "click", target: "Sign in" }, ctxOf(undefined));
    assert.ok(!res.isError, res.output);
    assert.match(res.output, /no change after click 1 — re-deriving/, "the retry is narrated");
    assert.match(res.output, /no element changes detected/, "and the honest no-change verdict stands");
    assert.equal(res.details.attempts, 2);
  } finally {
    setWebSessionOverride(async () => undefined);
  }
});
