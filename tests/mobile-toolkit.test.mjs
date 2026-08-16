/**
 * The built-in `mobile_*` device toolkit, over the `mobilecli` binary.
 *
 * This replaced the external device-MCP server. The tests drive a FAKE BINARY rather
 * than stubbing the module, because the argv the harness builds is half of what
 * can break — a wrong flag order or a coordinate in the wrong unit is invisible
 * to a module-level mock and fatal on a device.
 *
 * The coordinate contract these pin (verified on a real iPhone 17 Pro
 * simulator, 402x874 pt @3, screenshots 1206x2622 px): every coordinate the
 * toolkit accepts or returns is a LOGICAL POINT. Physical pixels are silently
 * dropped by the driver, which is exactly why they must be refused here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Registry, LogStore, registerBuiltins } from "../dist/index.js";
import { setMobileCliOverride, setMobileCliAvailableOverride } from "../dist/devices/mobilecli.js";
import { fakeMobileCli, el, cardsScreenRawTree, profileScreenRawTree } from "./fake-mobilecli.mjs";

const ctx = { cwd: os.tmpdir(), log: () => {} };

function toolkit() {
  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  return registry;
}

async function withFake(opts, fn) {
  const fake = fakeMobileCli(opts);
  setMobileCliOverride(fake.bin);
  try {
    return await fn(fake, toolkit());
  } finally {
    setMobileCliOverride(undefined);
    setMobileCliAvailableOverride(undefined);
    fake.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("the toolkit registers as a built-in provider, not a spawned MCP", () => {
  const registry = toolkit();
  const provider = registry.list().find((p) => p.id === "builtin:mobile");
  assert.ok(provider, "builtin:mobile must exist — the mobile preset names it by id");
  assert.equal(provider.source, "internal");
  // write_edit AND activity_inspect: you cannot tap in a categorizer that
  // cannot screenshot the result.
  assert.deepEqual([...provider.categorizers].sort(), ["activity_inspect", "write_edit"]);
  // ONE tool, not fifteen. Target resolution is deterministic code, so a single
  // call replaces a sequence rather than hiding an agent loop.
  assert.deepEqual(provider.tools.map((t) => t.name), ["mobile"]);
  for (const gone of ["mobile_tap", "mobile_elements", "mobile_screenshot", "mobile_tap_visual"]) {
    assert.equal(registry.getTool(gone), undefined, `${gone} must no longer be its own tool`);
  }
});

test("no tool advertises a coordinate space other than logical points", () => {
  const d = toolkit().getTool("mobile").description;
  assert.match(d, /LOGICAL POINTS/i, "the tool must state its coordinate space");
});

// ---------------------------------------------------------------------------
// Device resolution
// ---------------------------------------------------------------------------

test("every tool defaults to the only booted device — no UUID threading", async () => {
  await withFake({}, async (fake, registry) => {
    const res = await registry.getTool("mobile").execute("s", { action: "look" }, ctx);
    assert.notEqual(res.isError, true, res.output);
    assert.ok(fake.cmd("screenshot")[0].includes("SIM-1"), "resolved and passed the booted device");
  });
});

test("no device is an actionable error, not an empty success", async () => {
  await withFake({ devices: [] }, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("s", { action: "look" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.output, /No booted device/i);
    assert.match(res.output, /simctl boot|emulator -avd/, "says how to get one");
  });
});

// ---------------------------------------------------------------------------
// The coordinate contract
// ---------------------------------------------------------------------------

test("mobile_tap sends logical points through verbatim", async () => {
  await withFake({}, async (fake, registry) => {
    const res = await registry.getTool("mobile").execute("t", { action: "tap", target: "366,90" }, ctx);
    assert.notEqual(res.isError, true, res.output);
    assert.equal(fake.cmd("io", "tap")[0].at(-1), "366,90");
  });
});

test("mobile_tap REFUSES physical pixels and prints the conversion", async () => {
  // The exact failure this replaces: mobilecli answers `status: ok` for an
  // off-screen tap and delivers nothing, so a physical-pixel coordinate looks
  // like a broken tap tool rather than a unit mistake.
  await withFake({}, async (fake, registry) => {
    const res = await registry.getTool("mobile").execute("t", { action: "tap", target: "1098,271" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.output, /outside the 402x874 pt screen/);
    assert.match(res.output, /PHYSICAL PIXELS/);
    assert.match(res.output, /\(366, 90\)/, "hands back the logical equivalent");
    assert.equal(fake.cmd("io", "tap").length, 0, "nothing was sent to the device");
  });
});

test("a coordinate inside the screen is never second-guessed", async () => {
  // The guard must not fire on a legitimate bottom-edge tap.
  await withFake({}, async (fake, registry) => {
    const res = await registry.getTool("mobile").execute("t", { action: "tap", target: "401,873" }, ctx);
    assert.notEqual(res.isError, true, res.output);
    assert.equal(fake.cmd("io", "tap")[0].at(-1), "401,873");
  });
});

test("mobile_device_info reports the space and the conversion", async () => {
  await withFake({}, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("i", { action: "devices" }, ctx);
    assert.match(res.output, /LOGICAL POINTS: 402x874/);
    assert.match(res.output, /1206x2622 px/);
    assert.match(res.output, /scale 3/);
  });
});

// ---------------------------------------------------------------------------
// Element tree
// ---------------------------------------------------------------------------

test("mobile_elements returns tappable centres, already in the tap's space", async () => {
  await withFake(
    { elements: [el("Button", "Share Card", 77, 629, 246, 50)] },
    async (_fake, registry) => {
      const res = await registry.getTool("mobile").execute("e", { action: "look" }, ctx);
      const parsed = JSON.parse(res.output);
      assert.equal(parsed.space, "logical-points");
      assert.deepEqual(parsed.elements[0].center, { x: 200, y: 654 });
    },
  );
});

test("carousel slivers are dropped — they duplicate real labels and would win the match", async () => {
  // Verbatim from the real device: a width-0 "Edit" and a width-5 "Share Card"
  // at x=396 on a 402pt screen — the clipped next card in a carousel. They
  // share labels with the real buttons, and matchElement's smaller-rect
  // tiebreak would pick the sliver over the button it is meant to find.
  await withFake(
    {
      elements: [
        el("Button", "Share Card", 77, 629, 246, 50),
        el("Button", "Share Card", 396, 599, 5, 43),
        el("Button", "Edit", 401, 552, 0, 43),
      ],
    },
    async (_fake, registry) => {
      const parsed = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
      assert.equal(parsed.elements.length, 1);
      assert.deepEqual(parsed.elements[0].center, { x: 200, y: 654 });
    },
  );
});

test("a sliver never beats the real control it shares a label with", async () => {
  // The end-to-end consequence of the filter above, through the matcher that
  // mobile_tap_visual uses for ground truth.
  const { matchElement, elementCenter } = await import("../dist/devices/mobilecli.js");
  const real = { type: "Button", label: "Share Card", rect: { x: 77, y: 629, width: 246, height: 50 } };
  const sliver = { type: "Button", label: "Share Card", rect: { x: 396, y: 599, width: 5, height: 43 } };
  // Unfiltered, the sliver wins on area — which is precisely why it is filtered.
  assert.deepEqual(elementCenter(matchElement([real, sliver], "Share Card")), { x: 399, y: 621 });
  // Through the tool's own filtering, the real button is what remains.
  assert.deepEqual(elementCenter(matchElement([real], "Share Card")), { x: 200, y: 654 });
});

test("an empty tree says what it means, so it is not read as an empty screen", async () => {
  await withFake({ elements: [] }, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("e", { action: "look" }, ctx);
    assert.notEqual(res.isError, true);
    // `look` always carries the screenshot, so an empty tree is not a dead end:
    // the image is right there and `tap` can still resolve against it.
    const parsed = JSON.parse(res.output);
    assert.deepEqual(parsed.elements, []);
    assert.ok(Array.isArray(res.content) && res.content[0]?.type === "image", "the capture came back");
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test("mobile_screenshot returns the image inline", async () => {
  await withFake({ shotSize: [1206, 2622] }, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("s", { action: "look" }, ctx);
    assert.equal(res.content[0].type, "image");
    assert.equal(res.content[0].mimeType, "image/png");
  });
});

test("saveTo writes the capture to disk AND still returns it inline", async () => {
  // `media_analysis` reads by PATH, so a capture that only exists inline cannot
  // be analysed without re-capturing a (by then different) screen.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-shot-"));
  const target = path.join(dir, "nested", "shot.png");
  try {
    await withFake({ shotSize: [1206, 2622] }, async (_fake, registry) => {
      const res = await registry.getTool("mobile").execute("s", { action: "look", saveTo: target }, ctx);
      assert.notEqual(res.isError, true, res.output);
      assert.equal(res.details.path, target);
      assert.equal(res.content[0].type, "image", "still inline for the model to see");
      const buf = await fs.readFile(target);
      assert.ok(buf.length > 0);
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a real PNG");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failed capture is an error, not a silent empty pass", async () => {
  await withFake({ noScreenshot: true }, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("s", { action: "look" }, ctx);
    assert.equal(res.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Apps, input, navigation — argv shape
// ---------------------------------------------------------------------------

test("app and input commands build the argv mobilecli actually expects", async () => {
  await withFake({}, async (fake, registry) => {
    await registry.getTool("mobile").execute("a", { action: "launch", bundleId: "com.x.y" }, ctx);
    await registry.getTool("mobile").execute("b", { action: "terminate", bundleId: "com.x.y" }, ctx);
    await registry.getTool("mobile").execute("c", { action: "open", url: "myapp://deep/link" }, ctx);
    await registry.getTool("mobile").execute("d", { action: "swipe", target: "200,700", to: "200,200" }, ctx);
    await registry.getTool("mobile").execute("e", { action: "type", text: "hello world" }, ctx);
    await registry.getTool("mobile").execute("f", { action: "press", button: "HOME" }, ctx);
    await registry.getTool("mobile").execute("g", { action: "longpress", target: "10,20" }, ctx);

    // Bundle id / url are POSITIONAL; the device is a flag. Getting this
    // backwards is the single easiest way to break every app command at once.
    assert.deepEqual(fake.cmd("apps", "launch")[0], ["apps", "launch", "com.x.y", "--device", "SIM-1"]);
    assert.deepEqual(fake.cmd("apps", "terminate")[0], ["apps", "terminate", "com.x.y", "--device", "SIM-1"]);
    assert.deepEqual(fake.cmd("url")[0], ["url", "myapp://deep/link", "--device", "SIM-1"]);
    // Swipe takes ONE comma-joined string, not four args.
    assert.equal(fake.cmd("io", "swipe")[0].at(-1), "200,700,200,200");
    assert.equal(fake.cmd("io", "text")[0].at(-1), "hello world");
    assert.equal(fake.cmd("io", "button")[0].at(-1), "HOME");
    assert.equal(fake.cmd("io", "longpress")[0].at(-1), "10,20");
  });
});

test("mobile_list_apps parses the bare ARRAY the CLI answers with", async () => {
  // `apps list` puts an array in `data` while every other command puts an
  // object there. Parsing it as an object silently yields zero apps.
  await withFake(
    { apps: [{ packageName: "com.a", appName: "A" }, { packageName: "com.b", appName: "B" }] },
    async (_fake, registry) => {
      const res = await registry.getTool("mobile").execute("l", { action: "apps" }, ctx);
      const parsed = JSON.parse(res.output);
      assert.equal(parsed.apps.length, 2);
      assert.equal(parsed.apps[0].packageName, "com.a");
    },
  );
});

test("a failed launch names the tool that shows what IS installed", async () => {
  await withFake({ failLaunch: true }, async (_fake, registry) => {
    const res = await registry.getTool("mobile").execute("a", { action: "launch", bundleId: "com.missing" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.output, /action: "apps"/, "names how to see what IS installed");
  });
});

// ---------------------------------------------------------------------------
// The raw UI tree — reaching controls the labelled view cannot see
//
// The default `dump ui` JSON only reports nodes carrying an accessibility
// label, so a bare Flutter GestureDetector is invisible to it. That is why the
// profile avatar in cards_mobile_app was absent from all 13 reported elements,
// forcing a vision guess that put four production runs in the status bar.
// `--format raw` has it: an unlabeled 72x40 node at (330,70), centre (366,90) —
// verified on the device to be the coordinate that opens Profile.
// ---------------------------------------------------------------------------

test("the raw tree surfaces the unlabeled avatar the labelled view drops", async () => {
  const { mobileCliTapTargets } = await import("../dist/devices/mobilecli.js");
  await withFake({ rawTree: cardsScreenRawTree() }, async () => {
    const targets = await mobileCliTapTargets("SIM-1");
    const avatar = targets.find((t) => t.center.x === 366 && t.center.y === 90);
    assert.ok(avatar, `avatar missing from ${JSON.stringify(targets.map((t) => t.center))}`);
    assert.equal(avatar.unlabeled, true);
    assert.deepEqual(avatar.rect, { x: 330, y: 70, width: 72, height: 40 });
  });
});

test("the status bar is derived from the tree and excluded, not hardcoded", async () => {
  const { mobileCliTapTargets } = await import("../dist/devices/mobilecli.js");
  await withFake({ rawTree: cardsScreenRawTree() }, async () => {
    const targets = await mobileCliTapTargets("SIM-1");
    // Nothing from inside the 402x54 status bar, and no full-width containers:
    // both are what a naive nearest-node snap latches onto.
    assert.ok(!targets.some((t) => t.rect.y + t.rect.height <= 54), "status-bar chrome leaked in");
    assert.ok(!targets.some((t) => t.rect.width > 402 * 0.6), "a full-width bar leaked in");
    assert.ok(!targets.some((t) => (t.label ?? "").includes("battery")), "system chrome leaked in");
  });
});

test("both estimates that failed in production snap to the avatar", async () => {
  // Verbatim from the runs: logical (363,40) [08:20] and (306,31) [08:20
  // attempt 1]. The model placed both in the status bar; each is nearer to the
  // avatar than to any other real control.
  const { mobileCliTapTargets, snapToTarget } = await import("../dist/devices/mobilecli.js");
  await withFake({ rawTree: cardsScreenRawTree() }, async () => {
    const targets = await mobileCliTapTargets("SIM-1");
    for (const est of [{ x: 363, y: 40 }, { x: 306, y: 31 }]) {
      const snapped = snapToTarget(est, targets, 80);
      assert.ok(snapped, `no snap for ${JSON.stringify(est)}`);
      assert.deepEqual(snapped.center, { x: 366, y: 90 }, `wrong snap for ${JSON.stringify(est)}`);
    }
  });
});

test("a far-away estimate is NOT snapped — that would be a different element", async () => {
  const { mobileCliTapTargets, snapToTarget } = await import("../dist/devices/mobilecli.js");
  await withFake({ rawTree: cardsScreenRawTree() }, async () => {
    const targets = await mobileCliTapTargets("SIM-1");
    assert.equal(snapToTarget({ x: 200, y: 300 }, targets, 40), undefined);
  });
});

test("mobile_elements reports unlabeled targets alongside the labelled ones", async () => {
  await withFake(
    { rawTree: cardsScreenRawTree(), elements: [el("Button", "Share Card", 77, 629, 246, 50)] },
    async (_fake, registry) => {
      const out = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
      // Everything labelled in the RAW tree, which is now the source: the JSON
      // view's list is only consulted when the raw dump is unavailable.
      assert.deepEqual(
        out.elements.map((e) => e.label).sort(),
        // Labels are trimmed: the device reports " Hermoine Granger" with a
        // leading space, which would otherwise defeat an exact-match lookup.
        ["Hermoine Granger", "My Cards", "Share Card"],
      );
      assert.ok(out.unlabeledTargets.some((t) => t.center.x === 366 && t.center.y === 90));
      // A labelled node must never also appear as an unlabeled target.
      assert.ok(!out.unlabeledTargets.some((t) => t.rect.x === 77 && t.rect.y === 629));
      assert.match(out.unlabeledNote, /NO accessibility label/);
    },
  );
});

// ---------------------------------------------------------------------------
// The raw tree as the element SOURCE (not just a bonus)
//
// `dump ui`'s JSON view reports only a whitelist of element types and discards
// type 1, "Other" — which is where Flutter puts every labelled row. On the
// validation device's profile screen that hid six rows ("Manage Events",
// "Help & Support", "Invite Teammates", "Log Out", "Delete My Account",
// "Report Issue"), leaving "tap Delete My Account" with no ground truth at all.
// This is not one app's quirk; it is how the whitelist interacts with any
// framework that labels containers.
// ---------------------------------------------------------------------------

test("labelled rows the JSON view discards are recovered from the raw tree", async () => {
  await withFake({ rawTree: profileScreenRawTree() }, async (_fake, registry) => {
    const o = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
    const byLabel = new Map(o.elements.map((e) => [e.label, e.center]));
    assert.deepEqual(byLabel.get("Delete My Account"), { x: 201, y: 683 });
    assert.deepEqual(byLabel.get("Log Out"), { x: 201, y: 627 });
    for (const l of ["Manage Events", "Help & Support", "Invite Teammates", "Report Issue"]) {
      assert.ok(byLabel.has(l), `${l} missing`);
    }
  });
});

test("the screen comes from the Application node, not the largest frame", async () => {
  // The scroll container reports 402x1244 of CONTENT against a 402x874 screen.
  // Taking the largest frame would inflate the screen by 40% and let every
  // below-the-fold node through as if it were tappable.
  await withFake({ rawTree: profileScreenRawTree() }, async (_fake, registry) => {
    const o = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
    const all = [...o.elements, ...(o.unlabeledTargets ?? [])];
    assert.ok(all.length > 0);
    for (const e of all) {
      assert.ok(e.center.y <= 874 && e.center.x <= 402, `off-screen element leaked: ${JSON.stringify(e)}`);
    }
  });
});

test("content below the fold is excluded — it cannot be tapped", async () => {
  await withFake({ rawTree: profileScreenRawTree() }, async (_fake, registry) => {
    const o = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
    const labels = o.elements.map((e) => e.label);
    assert.ok(!labels.includes("Hidden Below Fold"), "a row below the fold was offered as a target");
    assert.ok(!labels.includes("z"), "an offscreen keyboard key was offered as a target");
    assert.ok(labels.includes("Report Issue"), "the last VISIBLE row must survive");
  });
});

test("status-bar chrome is still excluded when the tree types it", async () => {
  await withFake({ rawTree: profileScreenRawTree() }, async (_fake, registry) => {
    const o = JSON.parse((await registry.getTool("mobile").execute("e", { action: "look" }, ctx)).output);
    assert.ok(!o.elements.some((e) => (e.label ?? "").includes("battery")));
  });
});

// ---------------------------------------------------------------------------
// Matching a description that names SEVERAL on-screen labels
// ---------------------------------------------------------------------------

test("a description naming two rows picks the one it is ABOUT", async () => {
  // From the run: `the "Delete My Account" row with trash can icon, below
  // "Log Out"`. Both labels are on screen, both scored equal, and both rows
  // are identical 354x40 — so the old area tiebreak chose by sort order and
  // returned "Log Out", exactly one row off.
  const { matchElement } = await import("../dist/devices/mobilecli.js");
  const rows = [
    ["Manage Events", 358], ["Help & Support", 431], ["Invite Teammates", 487],
    ["Log Out", 627], ["Delete My Account", 683], ["Report Issue", 739],
  ].map(([label, cy]) => ({ type: "Other", label, name: label, rect: { x: 24, y: cy - 20, width: 354, height: 40 } }));

  const cases = [
    ['the "Delete My Account" row with trash can icon, below "Log Out"', "Delete My Account"],
    ["Delete My Account option with trash can icon", "Delete My Account"],
    ["the Log Out row above Delete My Account", "Log Out"],
    ["Log Out", "Log Out"],
    ["Report Issue", "Report Issue"],
  ];
  for (const [description, expected] of cases) {
    assert.equal(matchElement(rows, description)?.label, expected, description);
  }
});

// ---------------------------------------------------------------------------
// Snapping stays in its lane
// ---------------------------------------------------------------------------

test("snapping ignores LABELLED nodes — those belong to matchElement", async () => {
  // The regression: asked for "Delete My Account", a good estimate (201,633)
  // was snapped onto the labelled "Lock screen Widget" two rows up, turning a
  // near-miss into a confident wrong tap.
  const { snapToTarget } = await import("../dist/devices/mobilecli.js");
  const targets = [
    { rect: { x: 80, y: 543, width: 238, height: 23 }, center: { x: 199, y: 555 }, label: "Lock screen Widget", unlabeled: false, type: "StaticText" },
    { rect: { x: 24, y: 663, width: 40, height: 40 }, center: { x: 44, y: 683 }, unlabeled: true, type: "Button" },
  ];
  const snapped = snapToTarget({ x: 201, y: 633 }, targets, 60);
  assert.notEqual(snapped?.label, "Lock screen Widget", "a labelled node must never win a snap");
});

test("an ambiguous estimate is NOT snapped — two candidates equally close", async () => {
  const { snapToTarget } = await import("../dist/devices/mobilecli.js");
  const targets = [
    { rect: { x: 100, y: 100, width: 40, height: 40 }, center: { x: 120, y: 120 }, unlabeled: true, type: "Button" },
    { rect: { x: 200, y: 100, width: 40, height: 40 }, center: { x: 220, y: 120 }, unlabeled: true, type: "Button" },
  ];
  assert.equal(snapToTarget({ x: 170, y: 120 }, targets, 60), undefined, "equidistant: no evidence for either");
});

test("a clear winner still snaps — the avatar case", async () => {
  const { snapToTarget } = await import("../dist/devices/mobilecli.js");
  const targets = [
    { rect: { x: 330, y: 70, width: 72, height: 40 }, center: { x: 366, y: 90 }, unlabeled: true, type: "Other" },
    { rect: { x: 352, y: 118, width: 50, height: 601 }, center: { x: 377, y: 419 }, unlabeled: true, type: "Other" },
  ];
  assert.deepEqual(snapToTarget({ x: 303, y: 33 }, targets, 60)?.center, { x: 366, y: 90 });
});

// ---------------------------------------------------------------------------
// Dual-channel tap resolution
//
// The two channels fail in disjoint ways, which is the entire reason to run
// both. Measured across this project's runs: VISION produced 19 estimates and
// landed 0 unaided — horizontally excellent (0px error on all five attempts at
// one row), vertically short by 139-249px every time. ELEMENTS are exact when
// the target is in the tree and useless when it is not (canvas, WebView,
// custom-drawn, or scrolled off-screen).
//
// So vision decides WHICH thing is meant; the tree says exactly WHERE it is;
// and either one alone still produces a tap.
// ---------------------------------------------------------------------------

const T = (x, y, w, h, label) => ({
  rect: { x, y, width: w, height: h },
  center: { x: Math.round(x + w / 2), y: Math.round(y + h / 2) },
  ...(label ? { label } : {}),
  unlabeled: !label,
  type: label ? "StaticText" : "Other",
});

test("both channels agree → corroborated, and the EXACT centre is tapped", async () => {
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const row = T(24, 663, 354, 40, "Delete My Account");
  const r = resolveTap(
    { point: { x: 201, y: 670 }, imagePoint: { x: 603, y: 2010 } },
    { all: [row, T(24, 607, 354, 40, "Log Out")], matched: row },
  );
  assert.equal(r.confidence, "corroborated");
  assert.deepEqual(r.point, { x: 201, y: 683 }, "the rect's centre, not the estimate");
  assert.equal(r.conflicted, false);
});

test("channels disagree → the label match wins, and the conflict is REPORTED", async () => {
  // Silently picking one is how a wrong tap looks like a right one. The
  // disagreement is the most useful line in a failing transcript.
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const del = T(24, 663, 354, 40, "Delete My Account");
  const out = T(24, 607, 354, 40, "Log Out");
  const r = resolveTap({ point: { x: 201, y: 620 } }, { all: [del, out], matched: del });
  assert.equal(r.confidence, "conflict");
  assert.equal(r.conflicted, true);
  assert.deepEqual(r.point, del.center, "measured identity beats an estimate");
  assert.ok(r.steps.some((s) => s.includes("CONFLICT") && s.includes("Log Out")), "names what vision saw");
});

test("no label at all → the element is identified BY the visual coordinate", async () => {
  // The profile-avatar case, and the general answer for icon-only buttons and
  // bare GestureDetectors: nothing can match them by description, but a
  // coordinate landing inside one identifies it perfectly well.
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const avatar = T(330, 70, 72, 40, undefined);
  const r = resolveTap({ point: { x: 350, y: 85 } }, { all: [avatar] });
  assert.equal(r.confidence, "vision-in-element");
  assert.deepEqual(r.point, { x: 366, y: 90 }, "snapped to the unlabeled element's exact centre");
  assert.ok(r.steps.some((s) => /no label/i.test(s)), "says the identification was positional");
});

test("nothing in the tree → the visual estimate is tapped directly", async () => {
  // A game canvas, a WebView, a custom-drawn control. Elements contribute
  // nothing, and that must not be fatal.
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const r = resolveTap({ point: { x: 200, y: 400 } }, { all: [] });
  assert.equal(r.confidence, "vision-only");
  assert.deepEqual(r.point, { x: 200, y: 400 });
  assert.ok(r.steps.some((s) => /canvas|WebView/i.test(s)));
});

test("no vision → the element channel still produces a tap", async () => {
  // The scroll-view / no-model case: whichever channel works, works.
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const row = T(24, 663, 354, 40, "Delete My Account");
  const r = resolveTap({ unavailable: "skipped" }, { all: [row], matched: row });
  assert.equal(r.confidence, "element-only");
  assert.deepEqual(r.point, { x: 201, y: 683 });
});

test("neither channel → undefined, so the caller can explain instead of guessing", async () => {
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  assert.equal(resolveTap({ unavailable: "no model" }, { all: [] }), undefined);
});

test("the innermost element wins containment — a button over its row", async () => {
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const row = T(0, 600, 402, 80, undefined);
  const button = T(300, 620, 60, 40, undefined);
  const r = resolveTap({ point: { x: 320, y: 635 } }, { all: [row, button] });
  assert.deepEqual(r.point, button.center, "the smaller containing element is the target");
});

test("every channel state is narrated, so a failure is diagnosable in one read", async () => {
  const { resolveTap } = await import("../dist/devices/mobilecli.js");
  const r = resolveTap({ unavailable: "model timed out" }, { all: [T(0, 0, 50, 50, "X")], matched: T(0, 0, 50, 50, "X") });
  assert.ok(r.steps.some((s) => s.includes("model timed out")), "the vision failure reason survives");
  assert.ok(r.steps.some((s) => s.includes("Elements: matched")), "the element outcome is stated");
});
