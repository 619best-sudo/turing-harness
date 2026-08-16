/**
 * mobile_tap_visual — the one-call visual tap, on the `mobilecli` backend.
 *
 * THE RUN THIS CLOSES, and what it actually taught:
 *
 * A model screenshotted (375x812 px of a 402x874 pt screen), asked
 * media_analysis for the profile avatar's position, got (339, 59) image px,
 * hand-computed 339x402/375 = 363 and 59x874/812 = 64, tapped (363, 64)… and
 * the screen did not change. It then burned its remaining turns reading routes.
 *
 * The conclusion drawn at the time was that the tap tool wanted PHYSICAL
 * pixels, and the code grew a runtime "calibration" that guessed between the
 * two spaces and remembered the winner. That conclusion was WRONG, and the
 * calibration is gone.
 *
 * Measured against the real device: the avatar's true centre is logical
 * (366, 90) — which in that 375x812 capture is image (341, 84). The localizer
 * answered y=59 when the truth was y=84: a 25px error on a target ~37px tall,
 * i.e. a guaranteed miss. The x estimate (339 vs 341) was fine. The space was
 * right all along; the CAPTURE RESOLUTION was the problem.
 *
 * So these tests pin the three things that actually fix it: capture natively,
 * prefer the element tree's exact rects, and convert in code — never guess at
 * the coordinate space.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Registry, LogStore, registerBuiltins } from "../dist/index.js";
import { setMobileCliOverride, setMobileCliAvailableOverride } from "../dist/devices/mobilecli.js";
import { fakeMobileCli, el } from "./fake-mobilecli.mjs";

/**
 * The `tap` action of the single `mobile` tool — where the fused resolver lives
 * now that `mobile_tap_visual` is no longer its own registered tool.
 */
function tapTool() {
  const registry = new Registry();
  registerBuiltins(registry, { logStore: new LogStore() });
  const mobile = registry.getTool("mobile");
  return {
    execute: (id, args, ctx) =>
      mobile.execute(
        id,
        {
          action: "tap",
          target: args.element,
          ...(args.device ? { device: args.device } : {}),
          ...(args.bundleId ? { bundleId: args.bundleId } : {}),
        },
        ctx,
      ),
  };
}

/** A registry carrying only `media_analysis` — the device side is the fake binary. */
function visionRegistry(answer) {
  const calls = [];
  const media = {
    name: "media_analysis",
    async execute(_id, args) {
      calls.push(args);
      const wantsBox = /BOUNDING BOX|BOX:/i.test(args?.prompt ?? "");
      return { output: typeof answer === "function" ? answer(wantsBox, calls.length) : answer };
    },
  };
  const tools = new Map([["media_analysis", media]]);
  return { calls, registry: { getTool: (n) => tools.get(n), allTools: () => [...tools.values()] } };
}

const ctx = (registry) => ({ cwd: "/tmp", log: () => {}, registry });

/** Coordinates from the `io tap` argv the fake recorded. */
function tapsFrom(fake) {
  return fake.cmd("io", "tap").map((a) => {
    const [x, y] = a[a.length - 1].split(",").map(Number);
    return { x, y };
  });
}

function withFake(opts, fn) {
  const fake = fakeMobileCli(opts);
  setMobileCliOverride(fake.bin);
  return Promise.resolve(fn(fake)).finally(() => {
    setMobileCliOverride(undefined);
    setMobileCliAvailableOverride(undefined);
    fake.cleanup();
  });
}

// ---------------------------------------------------------------------------
// Ground truth: the element tree
// ---------------------------------------------------------------------------

test("an element-tree match is tapped at its EXACT logical coordinates — no vision call", async () => {
  await withFake(
    {
      // Share Card's real rect from the device: logical (77,629) 246x50.
      elements: [
        [el("Button", "Share Card", 77, 629, 246, 50)],
        [el("StaticText", "Sharing…", 40, 300, 300, 40)],
      ],
    },
    async (fake) => {
      const { calls, registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 1, 1");
      const res = await tapTool().execute("t1", { element: "Share Card" }, ctx(registry));

      assert.notEqual(res.isError, true, res.output);
      assert.equal(res.details.status, "changed");
      assert.deepEqual(tapsFrom(fake), [{ x: 200, y: 654 }], "77+246/2, 629+50/2 — the element's own centre");
      assert.equal(calls.length, 0, "an exact label match needs no corroborating model call");
      assert.equal(res.details.taps[0].via, "element-only");
      assert.match(res.output, /matched "Share Card"/);
    },
  );
});

test("element rects are used AS-IS — they are already in the tap's coordinate space", async () => {
  // The bug class this forbids: multiplying a `dump ui` rect by the scale
  // factor "to get pixels". Both are logical; any conversion here is a miss.
  await withFake(
    {
      screen: { width: 402, height: 874, scale: 3 },
      elements: [[el("Button", "Contacts", 81, 767, 85, 65)], [el("StaticText", "Contacts (664)", 20, 100, 200, 30)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 1, 1");
      await tapTool().execute("t2", { element: "Contacts" }, ctx(registry));
      const [tap] = tapsFrom(fake);
      // 81+85/2 = 123.5, 767+65/2 = 799.5 — rounded. The real device tap that
      // switched tabs was (123, 799); both are well inside the 85x65 rect.
      assert.deepEqual(tap, { x: 124, y: 800 });
      assert.ok(tap.x < 402 && tap.y < 874, "inside the logical screen, NOT multiplied by scale 3");
    },
  );
});

// ---------------------------------------------------------------------------
// Vision: for what the tree does not expose (the profile avatar)
// ---------------------------------------------------------------------------

test("the profile-avatar regression: absent from the tree, localized on the NATIVE capture", async () => {
  // The exact target that cost a run. It is genuinely NOT in the element tree
  // (verified on the device: 13 elements, no avatar), so vision is required —
  // but on the native 1206x2622 frame, where its centre is image (1098, 271).
  await withFake(
    {
      shotSize: [1206, 2622],
      elements: [
        [el("StaticText", "My Cards", 16, 60, 100, 30)],
        [el("StaticText", "Profile", 40, 44, 100, 30)], // the profile screen opened
      ],
    },
    async (fake) => {
      const { calls, registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 1098, 271");
      const res = await tapTool()
        .execute("t3", { element: "the circular profile avatar at the top right" }, ctx(registry));

      assert.notEqual(res.isError, true, res.output);
      assert.equal(res.details.status, "changed");
      assert.equal(calls.length, 1, "the tree could not answer, so vision did");
      // 1098 x 402/1206 = 366, 271 x 874/2622 = 90 — the measured truth.
      assert.deepEqual(tapsFrom(fake), [{ x: 366, y: 90 }]);
      assert.match(res.output, /1206x2622 px/);
      assert.match(res.output, /logical \(366, 90\)/);
    },
  );
});

test("the conversion is image-dimension driven, so a downsampled capture still lands", async () => {
  // Same target, but the capture came back at 375x812. The estimate is scaled
  // by the IMAGE's own dimensions, never by an assumed x3.
  await withFake(
    {
      shotSize: [375, 812],
      elements: [[el("StaticText", "My Cards", 16, 60, 100, 30)], [el("StaticText", "Profile", 40, 44, 100, 30)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 375x812\nPOS: 341, 84");
      await tapTool().execute("t4", { element: "the avatar" }, ctx(registry));
      // 341 x 402/375 = 366, 84 x 874/812 = 90 — the same logical point.
      assert.deepEqual(tapsFrom(fake), [{ x: 366, y: 90 }]);
    },
  );
});

test("an estimate outside the image is clamped into the screen, not sent as-is", async () => {
  await withFake(
    {
      elements: [[el("StaticText", "A", 1, 1, 10, 10)], [el("StaticText", "B", 1, 1, 10, 10)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 9999, 9999");
      await tapTool().execute("t5", { element: "x" }, ctx(registry));
      const [tap] = tapsFrom(fake);
      assert.ok(tap.x <= 401 && tap.y <= 873, `clamped into 402x874, got ${JSON.stringify(tap)}`);
    },
  );
});

// ---------------------------------------------------------------------------
// Proving the tap landed
// ---------------------------------------------------------------------------

test("a ticking clock is NOT a screen change", async () => {
  // The false positive that a raw pixel comparison cannot avoid: the status bar
  // repaints every minute, so a no-op tap straddling a minute boundary reads as
  // a success. The element signature drops time-shaped labels, and the pixels
  // (different markers) must not override it.
  await withFake(
    {
      shots: ["A", "B", "C", "D"], // every capture differs
      elements: [
        [el("Button", "Share Card", 77, 629, 246, 50), el("StaticText", "6:58 AM", 55, 22, 38, 20)],
        [el("Button", "Share Card", 77, 629, 246, 50), el("StaticText", "6:59 AM", 55, 22, 38, 20)],
        [el("Button", "Share Card", 77, 629, 246, 50), el("StaticText", "6:59 AM", 55, 22, 38, 20)],
        [el("Button", "Share Card", 77, 629, 246, 50), el("StaticText", "7:00 AM", 55, 22, 38, 20)],
      ],
    },
    async (fake) => {
      const { registry } = visionRegistry((wantsBox) =>
        wantsBox ? "IMAGE: 1206x2622\nBOX: 580, 1940, 40, 40" : "IMAGE: 1206x2622\nPOS: 600, 1962",
      );
      const res = await tapTool()
        .execute("t6", { element: "Share Card", retries: 1 }, ctx(registry));

      assert.equal(res.details.status, "no-change", "identical screens, only the clock moved");
      assert.match(res.output, /did NOT change/);
    },
  );
});

test("with no accessibility tree at all, the pixel comparison still decides", async () => {
  // A Flutter app whose views never reach the tree signs as "" on every screen.
  // "" === "" must NOT be read as "nothing changed" — fall back to pixels.
  await withFake({ elements: [], shots: ["A", "B"] }, async (fake) => {
    const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 600, 1962");
    const res = await tapTool().execute("t7", { element: "the button" }, ctx(registry));
    assert.equal(res.details.status, "changed");
    assert.equal(res.details.confirmedBy, "pixels");
  });
});

test("a silent miss retries with a BOUNDING BOX derivation, then reports no-change", async () => {
  await withFake(
    {
      shots: ["A", "A", "A", "A"], // nothing ever changes
      elements: [],
    },
    async (fake) => {
      const { calls, registry } = visionRegistry((wantsBox) =>
        wantsBox ? "IMAGE: 1206x2622\nBOX: 500, 1900, 40, 40" : "IMAGE: 1206x2622\nPOS: 600, 1962",
      );
      const res = await tapTool()
        .execute("t8", { element: "the button", retries: 1 }, ctx(registry));

      assert.equal(res.details.status, "no-change");
      assert.equal(res.details.taps.length, 2, "two independent derivations");
      const taps = tapsFrom(fake);
      assert.notDeepEqual(taps[0], taps[1], "the retry asked a different question and got a different point");
      assert.ok(calls.some((c) => /BOUNDING BOX|BOX:/i.test(c.prompt)), "the retry asked for a box");
      // The advice must NOT send the model back to guess the coordinate space.
      assert.match(res.output, /LOGICAL POINTS/);
      assert.match(res.output, /NOT a coordinate-space problem/);
      assert.match(res.output, /mobile_elements|mobile_swipe|mobile_open_url|ask_user_question/);
    },
  );
});

test("not visible is reported as such — no tap is fired", async () => {
  await withFake({ elements: [] }, async (fake) => {
    const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: none");
    const res = await tapTool().execute("t9", { element: "a settings gear" }, ctx(registry));

    assert.equal(res.details.status, "not-visible");
    assert.equal(tapsFrom(fake).length, 0);
    assert.match(res.output, /not visible/i);
    assert.match(res.output, /Do NOT tap around/);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test("a missing mobilecli is named, with the install hint", async () => {
  setMobileCliAvailableOverride(false);
  try {
    const { registry } = visionRegistry("IMAGE: 1x1\nPOS: 1, 1");
    const res = await tapTool().execute("t10", { element: "x" }, ctx(registry));
    assert.equal(res.isError, true);
    assert.match(res.output, /mobilecli/);
    assert.match(res.output, /brew install/);
  } finally {
    setMobileCliAvailableOverride(undefined);
  }
});

test("a missing media_analysis is named too", async () => {
  await withFake({}, async () => {
    const res = await tapTool()
      .execute("t11", { element: "x" }, ctx({ getTool: () => undefined, allTools: () => [] }));
    assert.equal(res.isError, true);
    assert.match(res.output, /media_analysis/);
  });
});

test("no booted device is an error, not an empty pass", async () => {
  await withFake({ devices: [] }, async () => {
    const { registry } = visionRegistry("IMAGE: 1x1\nPOS: 1, 1");
    const res = await tapTool().execute("t12", { element: "x" }, ctx(registry));
    assert.equal(res.isError, true);
    assert.match(res.output, /no booted device/i);
  });
});

test("without a screen size, the vision path refuses rather than guessing a scale", async () => {
  // `device info` reporting no screenSize means the image->logical ratio is
  // unknown. Guessing x3 is precisely the class of assumption this file exists
  // to eliminate, so the tool says so instead.
  await withFake({ screen: null, elements: [] }, async (fake) => {
    const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 1098, 271");
    const res = await tapTool().execute("t13", { element: "the avatar" }, ctx(registry));
    // Not a hard error any more: the visual channel simply reports itself
    // unavailable and the element channel gets its turn. With nothing in the
    // tree either, BOTH channels are out and the tool says exactly that.
    assert.equal(res.details.status, "not-located");
    assert.match(res.output, /no screen size/);
    assert.equal(tapsFrom(fake).length, 0, "no tap was fired on an unconvertible estimate");
  });
});

test("an element-tree tap still works without a screen size — no conversion is involved", async () => {
  await withFake(
    {
      screen: null,
      elements: [[el("Button", "Share Card", 77, 629, 246, 50)], [el("StaticText", "Sharing…", 40, 300, 300, 40)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 1x1\nPOS: 1, 1");
      const res = await tapTool().execute("t14", { element: "Share Card" }, ctx(registry));
      assert.equal(res.details.status, "changed");
      assert.deepEqual(tapsFrom(fake), [{ x: 200, y: 654 }]);
    },
  );
});

test("bundleId launches the app first, and a failed launch stops the tap", async () => {
  await withFake({ failLaunch: true, elements: [] }, async (fake) => {
    const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 600, 1962");
    const res = await tapTool()
      .execute("t15", { element: "x", bundleId: "com.uniqode.cards" }, ctx(registry));
    assert.equal(res.isError, true);
    assert.match(res.output, /Launch failed/);
    assert.equal(tapsFrom(fake).length, 0);
  });
});

// ---------------------------------------------------------------------------
// The localizer's aspect-ratio collapse
//
// Diagnosed from three OpenWaggle production runs against the SAME screen
// (cards_mobile_app, "change title of delete account popup", 2026-08-15
// 06:21 / 06:44 / 08:00). Each asked for the top-right profile avatar, whose
// true centre is image (1097, 271) of 1206x2622. The pixel answers were
// y = 97, 124, 132 — all near 271 x (1206/2622) = 124.6, i.e. a correct
// fraction of the HEIGHT scaled back by the WIDTH. X was near-exact every
// time (1084, 1086 vs 1097). The fix asks for the fraction separately and
// prefers it.
// ---------------------------------------------------------------------------

test("the fraction channel wins, and the aspect-ratio collapse is named", async () => {
  await withFake(
    {
      shotSize: [1206, 2622],
      elements: [[el("StaticText", "My Cards", 16, 60, 100, 30)], [el("StaticText", "Profile", 40, 44, 100, 30)]],
    },
    async (fake) => {
      // Verbatim from the 08:00 run, plus the fraction the model computes
      // correctly (271/2622 = 0.1034) and then mis-scales.
      const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 1086, 132\nFRAC: 0.9096, 0.1034");
      const res = await tapTool()
        .execute("loc1", { element: "the circular profile avatar at the top right" }, ctx(registry));

      // 0.1034 x 2622 = 271 image px -> 90 logical. The pixel answer's 132
      // would have converted to logical 44 and missed the 40pt avatar entirely.
      assert.deepEqual(tapsFrom(fake), [{ x: 366, y: 90 }]);
      assert.match(res.output, /aspect-ratio collapse/);
    },
  );
});

test("agreeing channels produce no noise", async () => {
  await withFake(
    {
      shotSize: [1206, 2622],
      elements: [[el("StaticText", "A", 10, 10, 50, 50)], [el("StaticText", "B", 10, 10, 50, 50)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 603, 1311\nFRAC: 0.5, 0.5");
      const res = await tapTool().execute("loc2", { element: "centre thing" }, ctx(registry));
      assert.deepEqual(tapsFrom(fake), [{ x: 201, y: 437 }]);
      assert.doesNotMatch(res.output, /collapse|disagree/);
    },
  );
});

test("a missing or nonsense fraction falls back to the pixel answer", async () => {
  await withFake(
    {
      shotSize: [1206, 2622],
      elements: [[el("StaticText", "A", 10, 10, 50, 50)], [el("StaticText", "B", 10, 10, 50, 50)]],
    },
    async (fake) => {
      const { registry } = visionRegistry("IMAGE: 1206x2622\nPOS: 603, 1311\nFRAC: 12, -4");
      await tapTool().execute("loc3", { element: "x" }, ctx(registry));
      assert.deepEqual(tapsFrom(fake), [{ x: 201, y: 437 }], "still tappable from pixels alone");
    },
  );
});

test("a square-ish image never triggers the collapse heuristic", async () => {
  // The detector must not fire where width ~ height, since there the two
  // scalings coincide and a disagreement means something else.
  await withFake(
    {
      shotSize: [1000, 1000],
      screen: { width: 500, height: 500, scale: 2 },
      elements: [[el("StaticText", "A", 10, 10, 50, 50)], [el("StaticText", "B", 10, 10, 50, 50)]],
    },
    async (_fake) => {
      const { registry } = visionRegistry("IMAGE: 1000x1000\nPOS: 500, 100\nFRAC: 0.5, 0.5");
      const res = await tapTool().execute("loc4", { element: "x" }, ctx(registry));
      assert.doesNotMatch(res.output, /aspect-ratio collapse/);
      assert.match(res.output, /disagree/, "still reported, just not as the collapse");
    },
  );
});
