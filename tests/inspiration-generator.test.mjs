/**
 * Tests for `inspiration_generator`.
 *
 * All offline — no real backend. The behaviours worth pinning:
 *  - No backend configured  → silent "no match" result, isError absent.
 *  - Backend returns null   → silent "no match" (the "ignore when nothing is
 *    returned" requirement), NOT an error.
 *  - Backend returns sections → blueprints surface in `details.sections`.
 *  - Backend throws          → still silent "no-match", run not broken.
 *  - Empty keywords / no sections requested → handled gracefully.
 *  - Multiple sections returned (possibly cross-design), only requested ones.
 *  - Parallax is a keyword tag (not a kind); kind is web-ui|mobile-ui|poster.
 *  - Theme-adaptation note appears in output.
 *  - Caller-abort + hard timeout propagate to the backend's ctx.signal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createInspirationGeneratorTool } from "../dist/index.js";

function ctxFor() {
  return { cwd: "/tmp", log: () => {} };
}

const HERO = {
  kind: "web-ui",
  category: "hero",
  name: "Gradient hero with dual CTA",
  description: "SaaS landing hero",
  keywords: ["hero", "gradient", "cta", "saas"],
  layout: { type: "flex", direction: "column" },
  elements: [{ role: "heading", text: "Ship faster" }],
  styles: { background: "linear-gradient(...)" },
};
const NAV = {
  kind: "web-ui",
  category: "navigation",
  name: "Sticky top nav",
  keywords: ["nav", "sticky", "logo"],
  elements: [{ role: "logo" }, { role: "nav-link" }],
};
const PARALLAX_HERO = {
  kind: "web-ui",
  category: "hero",
  name: "Parallax mountain hero",
  keywords: ["hero", "parallax", "scroll", "landscape"],
  animation: { type: "scroll-parallax", layers: [{ id: "sky", depth: 0.1 }] },
};

test("no backend configured → silent no-match, not an error", async () => {
  const tool = createInspirationGeneratorTool();
  const res = await tool.execute("c1", { keywords: ["hero"] }, ctxFor());
  assert.equal(res.details.matched, false);
  assert.equal(res.details.sections, undefined);
  assert.equal(res.isError, undefined);
  assert.match(res.output, /No inspiration backend configured/);
});

test("backend returns null → silent no-match (the 'ignore' requirement)", async () => {
  const tool = createInspirationGeneratorTool({ backend: async () => null });
  const res = await tool.execute("c1", { keywords: ["hero", "gradient"] }, ctxFor());
  assert.equal(res.details.matched, false);
  assert.equal(res.details.sections, undefined);
  assert.equal(res.isError, undefined);
  assert.match(res.output, /No stored inspiration matched/);
  assert.deepEqual(res.details.keywords, ["hero", "gradient"]);
});

test("backend returns sections → blueprints surface in details.sections", async () => {
  const tool = createInspirationGeneratorTool({
    backend: async (input) => {
      assert.deepEqual(input.keywords, ["saas", "dark"]);
      assert.equal(input.kind, "web-ui");
      assert.deepEqual(input.sections, ["hero", "navigation"]);
      return { sections: [HERO, NAV] };
    },
  });
  const res = await tool.execute(
    "c1",
    { keywords: ["SAAS", "Dark"], kind: "web-ui", sections: ["hero", "navigation"] },
    ctxFor(),
  );
  assert.equal(res.details.matched, true);
  assert.equal(res.details.sections.length, 2);
  assert.equal(res.details.sections[0].category, "hero");
  assert.equal(res.details.sections[1].category, "navigation");
  assert.match(res.output, /2 sections/);
});

test("multiple sections returned may come from different designs", async () => {
  // The backend is free to return hero from one stored design + footer from
  // another; the tool surfaces them all as-is.
  const FOOTER = { kind: "mobile-ui", category: "footer", name: "Tab bar", keywords: ["footer"] };
  const tool = createInspirationGeneratorTool({
    backend: async () => ({ sections: [HERO, FOOTER] }),
  });
  const res = await tool.execute(
    "c1",
    { keywords: ["mix"], sections: ["hero", "footer"] },
    ctxFor(),
  );
  assert.equal(res.details.matched, true);
  assert.equal(res.details.sections.length, 2);
  assert.notEqual(res.details.sections[0].kind, res.details.sections[1].kind);
});

test("parallax is a keyword tag, not a kind", async () => {
  const tool = createInspirationGeneratorTool({
    backend: async () => ({ sections: [PARALLAX_HERO] }),
  });
  const res = await tool.execute(
    "c1",
    { keywords: ["parallax", "scroll"], kind: "web-ui", sections: ["hero"] },
    ctxFor(),
  );
  assert.equal(res.details.matched, true);
  assert.equal(res.details.sections[0].kind, "web-ui"); // NOT "parallax"
  assert.ok(res.details.sections[0].keywords.includes("parallax")); // it's a tag
  assert.ok(res.details.sections[0].animation); // animation block present
});

const VIDEO_PARALLAX = {
  kind: "web-ui",
  category: "hero",
  name: "Multi-layer parallax hero",
  keywords: ["hero", "parallax", "scroll", "mountains"],
  animation: {
    type: "scroll-parallax",
    scrollTrigger: "window",
    scrollStart: "start end",
    scrollEnd: "end start",
    perspective: "1000px",
    fromVideo: true,
    notes: "hero pins for 300px then releases",
    layers: [
      {
        id: "sky",
        trigger: "scroll",
        property: "transform",
        depth: 0.1,
        keyframes: [
          { at: 0, styles: { transform: "translateY(0px)" } },
          { at: 1, styles: { transform: "translateY(-40px)" }, easing: "ease-out" },
        ],
      },
      {
        id: "mountains",
        trigger: "scroll",
        depth: 0.5,
        translateZ: "-200px",
        keyframes: [
          { at: 0, styles: { transform: "translateY(0px)" } },
          { at: 1, styles: { transform: "translateY(-160px)" } },
        ],
      },
    ],
  },
};

test("animation from a video is surfaced so the agent can reproduce it", async () => {
  const tool = createInspirationGeneratorTool({
    backend: async () => ({ sections: [VIDEO_PARALLAX] }),
  });
  const res = await tool.execute(
    "c1",
    { keywords: ["parallax"], kind: "web-ui", sections: ["hero"] },
    ctxFor(),
  );
  const out = res.output;
  // The motion description is rendered for the agent to act on:
  assert.match(out, /animation: scroll-parallax/);
  assert.match(out, /\[from video\]/); // provenance surfaced
  assert.match(out, /layer "sky"/);
  assert.match(out, /depth=0\.1/);
  assert.match(out, /keyframes:/);
  assert.match(out, /at 0 \{ transform:translateY\(0px\) \}/);
  assert.match(out, /hero pins for 300px/); // notes surfaced
  // Reproduce-guidance is present for animated sections:
  assert.match(out, /Reproduce it faithfully/i);
  assert.match(out, /scroll-timeline|IntersectionObserver|Framer Motion|GSAP/);
});

test("theme-adaptation note is in the output", async () => {
  const tool = createInspirationGeneratorTool({
    backend: async () => ({ sections: [HERO] }),
  });
  const res = await tool.execute("c1", { keywords: ["hero"] }, ctxFor());
  // Must coach substituting the project's content/theme — never paste the source verbatim.
  assert.match(res.output, /STRUCTURE ONLY/i);
  assert.match(res.output, /palette/i);
  // Must explicitly cover text/content substitution, not just colors.
  assert.match(res.output, /CONTENT/i);
  assert.match(res.output, /never.*logo|never reuse the source's logo/i);
});

test("backend throws → still silent no-match, run is not broken", async () => {
  const tool = createInspirationGeneratorTool({
    backend: async () => { throw new Error("backend down"); },
  });
  const res = await tool.execute("c1", { keywords: ["footer"] }, ctxFor());
  assert.equal(res.details.matched, false);
  assert.equal(res.isError, undefined);
  assert.match(res.output, /No stored inspiration matched/);
});

test("empty keywords → no backend call, guidance message", async () => {
  let called = 0;
  const tool = createInspirationGeneratorTool({
    backend: async () => { called++; return null; },
  });
  const res = await tool.execute("c1", { keywords: [] }, ctxFor());
  assert.equal(called, 0);
  assert.equal(res.details.matched, false);
  assert.match(res.output, /at least one keyword/);
});

test("invalid kind/sections are dropped, not rejected", async () => {
  let seen;
  const tool = createInspirationGeneratorTool({
    backend: async (input) => {
      seen = input;
      return { sections: [] };
    },
  });
  await tool.execute(
    "c1",
    { keywords: ["x"], kind: "bogus", sections: ["hero", "nope", "footer"] },
    ctxFor(),
  );
  assert.equal(seen.kind, undefined); // bogus kind dropped
  assert.deepEqual(seen.sections, ["hero", "footer"]); // unknown section dropped
});

test("backend receives a child ctx whose signal aborts on timeout", async () => {
  let observedAborted = null;
  const tool = createInspirationGeneratorTool({
    backend: async (input) => {
      await new Promise((r) => setTimeout(r, 120));
      observedAborted = input.ctx.signal?.aborted;
      return null;
    },
    timeoutMs: 50,
  });
  await tool.execute("c1", { keywords: ["x"] }, ctxFor());
  assert.equal(observedAborted, true);
});

test("tool meta: internal source, write_edit+activity_inspect phases, non-mutating", () => {
  const tool = createInspirationGeneratorTool({ backend: async () => null });
  assert.equal(tool.name, "inspiration_generator");
  assert.equal(tool.mutates, false);
  assert.deepEqual([...tool.categorizers].sort(), ["activity_inspect", "write_edit"]);
  assert.ok(tool.parameters.required.includes("keywords"));
  // kind enum is web-ui|mobile-ui|poster (no "parallax", no old "ui"/"poster"-only)
  const kindEnum = tool.parameters.properties.kind.enum;
  assert.deepEqual([...kindEnum].sort(), ["mobile-ui", "poster", "web-ui"]);
});
