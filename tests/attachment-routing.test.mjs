/**
 * Per-target attachment routing.
 *
 * The property under test is the one the union behaviour violated: a run holding
 * several designs must author each file from the design that depicts THAT file,
 * and must never fall back to "pass them all and let the model sort it out".
 *
 * Run via: npm test (builds first, then `node --test tests/*.test.mjs`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scopeImagesForTarget,
  targetMatches,
  tokenize,
  ambiguityNote,
} from "../dist/multimodal/attachment-routing.js";

const img = (path, extra = {}) => ({ path, mimeType: "image/png", ...extra });

test("a call that names its images gets exactly those, with nothing added", () => {
  const live = [img("/m/login.png"), img("/m/checkout.png"), img("/m/settings.png")];
  const scope = scopeImagesForTarget("src/Login.tsx", live, [img("/m/checkout.png")]);
  assert.equal(scope.reason, "call-named");
  assert.deepEqual(scope.images.map((i) => i.path), ["/m/checkout.png"]);
});

test("an explicit target routes the attachment to that file only", () => {
  const live = [
    img("/m/a.png", { targets: ["src/screens/Login.tsx"] }),
    img("/m/b.png", { targets: ["src/screens/Checkout.tsx"] }),
  ];
  const login = scopeImagesForTarget("src/screens/Login.tsx", live);
  assert.equal(login.reason, "routed");
  assert.deepEqual(login.images.map((i) => i.path), ["/m/a.png"]);

  const checkout = scopeImagesForTarget("src/screens/Checkout.tsx", live);
  assert.deepEqual(checkout.images.map((i) => i.path), ["/m/b.png"]);
});

test("an image routed elsewhere never leaks into an unrelated file", () => {
  const live = [
    img("/m/a.png", { targets: ["src/screens/Login.tsx"] }),
    img("/m/b.png", { targets: ["src/screens/Checkout.tsx"] }),
  ];
  const other = scopeImagesForTarget("src/lib/api.ts", live);
  assert.equal(other.images.length, 0, "a design bound to another file is not a candidate");
  assert.equal(other.reason, "none");
});

test("targets match across ./, absolute and relative spellings of the same file", () => {
  assert.ok(targetMatches("src/screens/Login.tsx", "./src/screens/Login.tsx"));
  assert.ok(targetMatches("src/screens/Login.tsx", "/Users/x/proj/src/screens/Login.tsx"));
  assert.ok(!targetMatches("src/screens/Login.tsx", "src/screens/Signup.tsx"));
  // A suffix that is not on a segment boundary is a different file.
  assert.ok(!targetMatches("Login.tsx", "src/screens/MyLogin.tsx"));
});

test("filename affinity picks the matching design when it is a strict winner", () => {
  const live = [img("/m/login-screen.png"), img("/m/checkout-screen.png")];
  const scope = scopeImagesForTarget("src/screens/LoginScreen.tsx", live);
  assert.equal(scope.reason, "affinity");
  assert.deepEqual(scope.images.map((i) => i.path), ["/m/login-screen.png"]);
});

test("a label carries affinity when the filename is opaque", () => {
  const live = [
    img("/m/IMG_4821.png", { label: "the checkout screen" }),
    img("/m/IMG_4822.png", { label: "the profile screen" }),
  ];
  const scope = scopeImagesForTarget("src/screens/Checkout.tsx", live);
  assert.equal(scope.reason, "affinity");
  assert.deepEqual(scope.images.map((i) => i.path), ["/m/IMG_4821.png"]);
});

test("a single attachment always reaches the write — the ordinary one-mockup run", () => {
  const live = [img("/m/whatever.png")];
  const scope = scopeImagesForTarget("src/components/Totally/Unrelated.tsx", live);
  assert.equal(scope.reason, "sole");
  assert.deepEqual(scope.images.map((i) => i.path), ["/m/whatever.png"]);
});

test("indistinguishable candidates pass NO image and report the contention", () => {
  const live = [img("/m/IMG_001.png"), img("/m/IMG_002.png"), img("/m/IMG_003.png")];
  const scope = scopeImagesForTarget("src/screens/Login.tsx", live);
  assert.equal(scope.reason, "ambiguous");
  assert.equal(scope.images.length, 0, "authoring from the wrong design is worse than from prose");
  assert.deepEqual(scope.candidates, ["/m/IMG_001.png", "/m/IMG_002.png", "/m/IMG_003.png"]);

  // The note has to name the fix, not just the problem.
  const note = ambiguityNote("src/screens/Login.tsx", scope.candidates);
  assert.match(note, /images: \["<the one>"\]/);
  assert.match(note, /IMG_002\.png/);
});

test("a tie on affinity is treated as no evidence, not as a coin toss", () => {
  const live = [img("/m/login-a.png"), img("/m/login-b.png")];
  const scope = scopeImagesForTarget("src/Login.tsx", live);
  assert.equal(scope.reason, "ambiguous");
  assert.equal(scope.images.length, 0);
});

test("an empty live set stays plain-text", () => {
  const scope = scopeImagesForTarget("src/Login.tsx", []);
  assert.equal(scope.reason, "none");
  assert.equal(scope.images.length, 0);
});

test("tokenize drops boilerplate that describes every export ever made", () => {
  const t = tokenize("final-login-screen-mockup-v2.png");
  assert.deepEqual([...t], ["login"]);
  assert.equal(tokenize("src/components/index.tsx").size, 0);
});
