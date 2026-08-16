// Which image a live capture is graded against.
//
// `activity_inspect` compares the screen it captured against "the run's
// reference image". That phrase is only well-defined when the run carries
// exactly one image, and real runs carry several — a mockup AND a screenshot of
// a stack trace, a design AND a photo of a whiteboard. Picking positionally
// meant a rendered screen could be graded against the stack trace, producing a
// fluent, confident, meaningless FAIL. These pin the role-based choice.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveReference } from "../dist/tools/index.js";

const png = (path, category, extra = {}) => ({ path, mimeType: "image/png", ...(category ? { category } : {}), ...extra });

test("an explicit reference argument always wins", () => {
  const r = resolveReference("/designs/hero.png", [png("/attached/other.png", "ui-replicate")]);
  assert.deepEqual(r, { path: "/designs/hero.png", why: "explicit" });
});

test("the design to replicate is preferred over anything else attached", () => {
  // Order deliberately puts the WRONG image first: this is the positional bug.
  const r = resolveReference(undefined, [
    png("/attached/stack-trace.png", "informational"),
    png("/attached/mockup.png", "ui-replicate"),
  ]);
  assert.equal(r.path, "/attached/mockup.png");
  assert.equal(r.why, "design-attachment");
});

test("a screenshot of the defect is the reference when there is no design", () => {
  const r = resolveReference(undefined, [
    png("/attached/spec.png", "informational"),
    png("/attached/broken.png", "ui-bug"),
  ]);
  assert.equal(r.path, "/attached/broken.png");
  assert.equal(r.why, "defect-attachment");
});

test("an informational attachment is NEVER a reference", () => {
  // Text/data the task should KNOW is not a picture of what the screen should
  // look like. With nothing else attached the honest answer is "no reference" —
  // the capture is then QA'd against `expected` instead of gap-analysed.
  const r = resolveReference(undefined, [png("/attached/logs.png", "informational")]);
  assert.equal(r, undefined);
});

test("between two designs, one that names a changed file wins", () => {
  const r = resolveReference(
    undefined,
    [
      png("/attached/settings.png", "ui-replicate", { targets: ["lib/settings.dart"] }),
      png("/attached/profile.png", "ui-replicate", { targets: ["lib/profile.dart"] }),
    ],
    ["/repo/lib/profile.dart"],
  );
  assert.equal(r.path, "/attached/profile.png");
});

test("a single untriaged image is still usable; two are ambiguous", () => {
  // Triage may be off, or may have failed. One image is unambiguous. Two
  // un-roled images are genuinely ambiguous, and picking one at random is the
  // exact failure being fixed — so nothing is chosen.
  assert.equal(resolveReference(undefined, [png("/a.png")]).why, "only-attachment");
  assert.equal(resolveReference(undefined, [png("/a.png"), png("/b.png")]), undefined);
});

test("non-images and empty sets resolve to nothing", () => {
  assert.equal(resolveReference(undefined, undefined), undefined);
  assert.equal(resolveReference(undefined, []), undefined);
  assert.equal(resolveReference(undefined, [{ path: "/spec.pdf", mimeType: "application/pdf" }]), undefined);
  assert.equal(resolveReference("   ", [png("/a.png")]).why, "only-attachment", "a blank arg is not a path");
});
