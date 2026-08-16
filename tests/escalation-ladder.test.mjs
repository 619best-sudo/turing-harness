/**
 * The escalation ladder must not send the model somewhere the runtime refuses.
 *
 * Rung 2 tells a stuck model to fall back to the shell, and for `write` that
 * meant `mkdir -p` + `cat > path <<'EOF'`. Correct when write/edit are ordinary
 * tools. Under `authorOnlyWrites` it is a trap: file bytes come from a dedicated
 * authoring model, and the guarded `bash` REFUSES heredocs and redirects onto
 * source paths. A model following that advice walks a blocked `write` straight
 * into a blocked `bash`, spends a turn on the second refusal, and only then
 * reaches rung 3 (ask a human).
 *
 * The toolset cannot reveal which mode is active — the guarded tool is still
 * named `bash` — so the flag is passed explicitly. These pin both variants, and
 * that the fallbacks which do NOT author bytes survive in both.
 *
 * Run via: npm test. All offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLoopSystemPrompt, buildPhaseSystemPrompt } from "../dist/index.js";

const PHASES = ["prepare", "plan", "perform", "perfect"];

const shellWritePatterns = [
  /cat > path <<'EOF'/,
  /python3` heredoc/,
];

test("by default the ladder still offers the shell as a write fallback", () => {
  const loop = buildLoopSystemPrompt();
  for (const re of shellWritePatterns) {
    assert.match(loop, re, "default mode keeps the shell write fallback");
  }
});

test("under authorOnlyWrites the shell write fallback is gone", () => {
  const loop = buildLoopSystemPrompt(undefined, { authorOnlyWrites: true });
  for (const re of shellWritePatterns) {
    assert.doesNotMatch(loop, re, "no advice to author through the shell");
  }
  assert.match(loop, /shell REFUSES to author source/, "and it says why");
  assert.match(loop, /fix the CALL/, "it redirects to the thing that actually helps");
});

test("the non-authoring shell fallbacks survive in author-only mode", () => {
  // Reading, anchor-hunting, liveness and screenshots write no source, so
  // removing them would cost real capability for no safety gain.
  const loop = buildLoopSystemPrompt(undefined, { authorOnlyWrites: true });
  assert.match(loop, /sed -n '1,200p'/, "read fallback kept");
  assert.match(loop, /grep -n/, "anchor hunting kept");
  assert.match(loop, /curl/, "liveness check kept");
  assert.match(loop, /playwright screenshot/, "visual fallback kept");
});

test("every phase prompt honours the flag, both ways", () => {
  for (const phase of PHASES) {
    const on = buildPhaseSystemPrompt(phase, undefined, { authorOnlyWrites: true });
    const off = buildPhaseSystemPrompt(phase, undefined);
    assert.doesNotMatch(on, /cat > path <<'EOF'/, `${phase}: author-only drops the shell write`);
    assert.match(off, /cat > path <<'EOF'/, `${phase}: default keeps it`);
  }
});

test("no prompt ever ships with an unfilled slot", () => {
  const built = [
    buildLoopSystemPrompt(),
    buildLoopSystemPrompt(undefined, { authorOnlyWrites: true }),
    ...PHASES.flatMap((p) => [
      buildPhaseSystemPrompt(p),
      buildPhaseSystemPrompt(p, undefined, { authorOnlyWrites: true }),
    ]),
  ];
  for (const prompt of built) {
    assert.doesNotMatch(prompt, /%%ESCALATION%%/, "escalation slot filled");
    assert.doesNotMatch(prompt, /%%GUIDANCE%%/, "guidance slot filled");
    assert.match(prompt, /WHEN A TOOL KEEPS FAILING/, "the ladder is present at all");
  }
});

test("the ladder keeps all four rungs in both modes", () => {
  for (const opts of [{}, { authorOnlyWrites: true }]) {
    const p = buildLoopSystemPrompt(undefined, opts);
    assert.match(p, /ask_user_question/, "rung 3 intact");
    assert.match(p, /Never silently skip work/, "rung 4 intact");
  }
});

// ---------------------------------------------------------------------------
// The prompt makes a factual claim about the runtime. Hold them together.
// ---------------------------------------------------------------------------

test("every form the author-only ladder names as rejected is actually rejected", async () => {
  const { createCodingTools } = await import("../dist/index.js");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const bash = createCodingTools({ authorOnlyWrites: true }).find((t) => t.name === "bash");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ladder-claim-"));

  // Named verbatim in SHELL_FALLBACK_AUTHOR_ONLY: heredoc, `>`, sed -i, tee.
  const claimed = [
    "cat > src/a.ts <<'EOF'\nx\nEOF",
    "echo x > src/b.ts",
    "sed -i 's/a/b/' src/c.ts",
    "echo x | tee src/d.ts",
  ];
  for (const command of claimed) {
    const res = await bash.execute("b1", { command }, { cwd: dir, log: () => {} });
    assert.ok(res.isError, `the prompt claims this is rejected: ${command}`);
  }

  // And the converse: what the ladder still recommends must still run.
  for (const command of ["sed -n '1,200p' src/a.ts", "grep -n 'foo' src/a.ts", "curl -s localhost:1"]) {
    const res = await bash.execute("b1", { command }, { cwd: dir, log: () => {} });
    assert.doesNotMatch(res.output ?? "", /refusing to author file contents/, `still allowed: ${command}`);
  }
});
