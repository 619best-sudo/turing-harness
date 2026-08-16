/**
 * Does a bug-fix run REPRODUCE before it edits? Audit it against any repo.
 *
 * The reproduce gate is a claim about behaviour, and behaviour is only checkable
 * by running it. This drives the real loop, the real gate and the real activity
 * tools over a real project and reports what happened at each step — no API key
 * needed, because the driver is scripted to replay the pattern the gate exists to
 * refuse: read the source, then go straight to the fix.
 *
 * Nothing about a particular project is baked in. The repo, the task text and the
 * file to instrument are inputs; the anchors come from the file's own content and
 * the traceId comes from the tool's `details`, so pointing it at a different
 * codebase needs no edits here.
 *
 * Usage:
 *   node examples/reproduce-first-audit.mjs --repo ~/Projects/yourapp \
 *     [--task "the bug report, in the user's words"] \
 *     [--file src/thing.ts] \
 *     [--run "node src/thing.js"] [--rating low|medium|high]
 *
 * `--file` defaults to the largest source file the harness's own assessor would
 * keep the gate ARMED for — i.e. one with real runtime flow, since a single
 * synchronous file is correctly waved through. Pass it when you know where the bug
 * lives. `--run` is the
 * command that exercises the instrumented flow — without it the trace cannot
 * capture anything, and the audit will say so rather than pretending otherwise.
 *
 * `--rating` is the complexity a live run's staged read would MEASURE for the
 * target file. It is an input rather than something computed here because that
 * rating comes from a model reading the bytes, and this audit makes no network
 * calls — there is no offline equivalent, and inventing one would report a
 * judgement the harness never made. Omit it to see the run without that signal;
 * supply it to see what a live read changes. It matters because it is the only
 * assessor input that does not get safer the less the run has looked at.
 *
 * `--mirror` builds a RUNNABLE working tree instead of copying single files: the
 * project's own source and config are copied and `node_modules` is symlinked, so
 * `--run` can execute the real flow (a test, a script, an entry point) with imports
 * and path aliases resolving exactly as they do in the project. Without it a copied
 * file usually cannot run at all, and only the refusal half of the cycle is
 * exercised.
 *
 * SAFETY: no source in the repo is ever written to — everything the run edits is a
 * copy in scratch. Under `--mirror` the one shared path is the `node_modules`
 * symlink, which a test runner may write its own cache into; the audit checks
 * afterwards and reports if the repo changed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LogStore,
  OpenRouterBridge,
  PermissionGate,
  createCodingTools,
  runToolLoop,
} from "../dist/index.js";
import { createActivityMonitorTools } from "../dist/tools/builtin/activity-monitor.js";
import { ReproductionGate } from "../dist/orchestrator/reproduction-gate.js";
import { VerificationGate } from "../dist/orchestrator/verification-gate.js";
// The harness's OWN judgement of what needs reproducing, reused rather than
// reimplemented: picking the target with the same predicate the gate lifts on
// means the audit cannot drift from the thing it is auditing.
import { scanForConcurrencyRisk } from "../dist/orchestrator/straightforward-assessor.js";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.repo || args.repo === true) {
  console.error("usage: node examples/reproduce-first-audit.mjs --repo <path> [--task <text>] [--file <relpath>] [--run <cmd>]");
  process.exit(2);
}
const REPO = path.resolve(String(args.repo).replace(/^~/, os.homedir()));
const TASK =
  typeof args.task === "string"
    ? args.task
    : "Something in this project is behaving incorrectly at runtime and needs fixing.";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".dart", ".py", ".go", ".rs", ".swift", ".kt", ".rb", ".java"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor", "target", "coverage", ".dbg"]);

/**
 * Source files worth auditing on, ranked by whether the ARMED gate would actually
 * hold for them.
 *
 * Size alone picks badly: the largest file in a repo is often a config or preset
 * table, and a single synchronous low-complexity file is exactly what the
 * straightforwardness assessor is designed to wave through — so the audit lands
 * on a lifted gate and looks like a failure when the harness was right. Ranking by
 * `scanForConcurrencyRisk`, the assessor's own signal, puts the files where
 * reproduction is genuinely required first.
 */
async function findSourceFiles(root, limit = 3) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".dbg") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) await walk(full, depth + 1);
      } else if (SOURCE_EXT.has(path.extname(e.name))) {
        const { size } = await fs.stat(full).catch(() => ({ size: 0 }));
        // Only files big enough to hold a real flow, and small enough to read.
        if (size < 600 || size > 120_000) continue;
        const content = await fs.readFile(full, "utf8").catch(() => "");
        found.push({ rel: path.relative(root, full), size, async: scanForConcurrencyRisk(content) });
      }
    }
  }
  await walk(root, 0);
  return found
    .sort((a, b) => (a.async === b.async ? b.size - a.size : a.async ? -1 : 1))
    .slice(0, limit);
}

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const msg = (content, stopReason = "stop") => ({
  role: "assistant", content, model: "scripted/driver",
  api: "openrouter", provider: "scripted", usage, stopReason, timestamp: Date.now(),
});

const resultText = (r) =>
  typeof r === "string"
    ? r
    : (Array.isArray(r) ? r : (r?.content ?? [])).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
const resultDetails = (r) => (Array.isArray(r) || typeof r === "string" ? undefined : r?.details);

/**
 * Top-level entries never brought into the mirror: history, build output, caches
 * and app state. Copying them is pointless and slow, and a stale `dist` can shadow
 * the source the run is trying to instrument.
 */
const MIRROR_SKIP = new Set([
  ".git", "dist", "out", "build", ".next", "target", "coverage", ".turbo",
  ".pnpm-store", ".electron-cache", ".home", ".dbg", ".claude", ".zcode",
]);
/** Dependency trees symlinked rather than copied — gigabytes, and read-only in practice. */
const MIRROR_LINK = new Set(["node_modules", ".yarn", ".venv", "vendor", "Pods"]);

/**
 * Build a working tree the project can actually RUN from: source and config copied
 * (so every edit lands on a copy), dependencies symlinked (so imports and path
 * aliases resolve as they do in the project). App-state directories are skipped by
 * size, not by name-matching a particular project.
 */
async function buildMirror(root, work) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const linked = [];
  for (const e of entries) {
    if (MIRROR_SKIP.has(e.name)) continue;
    const from = path.join(root, e.name);
    const to = path.join(work, e.name);
    if (MIRROR_LINK.has(e.name)) {
      await fs.symlink(from, to, "dir").catch(() => {});
      linked.push(e.name);
      continue;
    }
    if (e.isDirectory()) {
      // Skip anything that is obviously runtime state rather than project input.
      const size = await dirSize(from, 200 * 1024 * 1024);
      if (size > 200 * 1024 * 1024) continue;
      await fs.cp(from, to, { recursive: true, dereference: false }).catch(() => {});
    } else if (e.isFile()) {
      await fs.copyFile(from, to).catch(() => {});
    }
  }
  return linked;
}

/** Directory size, abandoning the walk once `cap` is exceeded. */
async function dirSize(dir, cap, seen = { n: 0 }) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return seen.n; }
  for (const e of entries) {
    if (seen.n > cap) return seen.n;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await dirSize(full, cap, seen);
    else if (e.isFile()) seen.n += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return seen.n;
}

async function main() {
  // --- scratch working copy: no source in the repo is ever written to ---
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "repro-audit-"));
  const picked = typeof args.file === "string"
    ? [{ rel: args.file }]
    : await findSourceFiles(REPO);
  if (!picked.length) {
    console.error(`no source files found under ${REPO}`);
    process.exit(1);
  }
  let linked = [];
  if (args.mirror) {
    linked = await buildMirror(REPO, work);
  } else {
    for (const { rel } of picked) {
      const src = path.join(REPO, rel);
      const dst = path.join(work, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst).catch((e) => {
        console.error(`could not copy ${rel}: ${e.message}`);
        process.exit(1);
      });
    }
  }
  const target = picked[0].rel;
  if (args.mirror) {
    // The mirror must actually contain the target, or the run instruments nothing.
    await fs.access(path.join(work, target)).catch(() => {
      console.error(`--mirror did not bring ${target} across (skipped as build output or state?)`);
      process.exit(1);
    });
  }

  const logStore = new LogStore();
  const reproductionGate = new ReproductionGate({ enabled: true });
  const verificationGate = new VerificationGate({});

  let sourceText = "";
  let traceId;
  let snippet;

  /**
   * An anchor from the file the run actually read: the longest indented line that
   * is code rather than a comment or a brace. Derived, never hardcoded — the point
   * is that this works on a file nobody wrote this script for.
   */
  /** The file's first real line — a module-scope insertion point. */
  function firstLineOf(text) {
    return text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\t/, ""))
      .find((l) => l.trim().length > 0);
  }

  function anchorFrom(text) {
    return text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\t/, ""))
      .filter((l) => /^\s+\S/.test(l) && !/^\s*(\/\/|\/\*|\*|#)/.test(l) && !/^\s*[})\];]+\s*$/.test(l))
      .sort((a, b) => b.length - a.length)[0];
  }

  const plan = [
    { what: "read the source", call: () => ({ name: "read", arguments: { path: target } }) },
    {
      what: "EDIT THE FIX, unobserved — the call under audit",
      call: () => {
        const a = anchorFrom(sourceText);
        return { name: "edit", arguments: { path: target, oldString: a, newString: `${a} // audit: speculative fix` } };
      },
    },
    { what: "open a trace session", call: () => ({ name: "activity_trace_start", arguments: {} }) },
    {
      // TWO probes in two edits, and the pair is what makes a zero capture
      // diagnostic rather than ambiguous. This one goes at MODULE SCOPE, so merely
      // importing the file records a line: if it is missing, the helper could not
      // write (a bundler transform, a sandbox, the ESM path) and the toolkit is at
      // fault. They have to be separate edits — putting both at the anchor puts
      // both inside whatever function the anchor sits in, and then "module scope"
      // is a lie that hides the very distinction it was added to draw.
      what: "place the trace helper + a module-scope probe",
      call: () => {
        const first = firstLineOf(sourceText);
        return {
          name: "edit",
          arguments: {
            path: target,
            oldString: first,
            newString: `${snippet}\n__t("audit: module scope reached");\n${first}`,
          },
        };
      },
    },
    {
      // ...and this one at a real decision line. If ONLY this is missing, the probe
      // sits on a line the run never executed — a placement problem that says
      // nothing about the harness.
      what: "place a probe at a decision line",
      call: () => {
        const a = anchorFrom(sourceText);
        return {
          name: "edit",
          arguments: { path: target, oldString: a, newString: `${a}\n__t("audit: anchor line reached");` },
        };
      },
    },
    ...(typeof args.run === "string"
      ? [{ what: "run the instrumented flow", call: () => ({ name: "bash", arguments: { command: args.run } }) }]
      : []),
    { what: "collect the trace", call: () => ({ name: "activity_collect", arguments: { traceId, waitMs: 1500 } }) },
    {
      what: "EDIT THE FIX again, after the capture",
      call: () => {
        const a = anchorFrom(sourceText);
        return { name: "edit", arguments: { path: target, oldString: a, newString: `${a} // audit: informed fix` } };
      },
    },
  ];

  const steps = [];
  const results = [];
  let i = 0;
  const llm = new OpenRouterBridge();
  llm.complete = async () => { throw new Error("this audit makes no network calls"); };
  llm.stream = async function* () {
    yield { type: "start", partial: msg([]) };
    const step = plan[i++];
    if (!step) { yield { type: "done", message: msg([{ type: "text", text: "done" }]) }; return; }
    let call;
    try { call = step.call(); } catch (e) {
      steps.push({ what: step.what, tool: "(skipped)", note: e.message });
      yield { type: "done", message: msg([{ type: "text", text: "skip" }]) };
      return;
    }
    steps.push({ what: step.what, tool: call.name });
    yield { type: "done", message: msg([{ type: "toolCall", id: `c${i}`, ...call }], "tool_use") };
  };

  const loop = await runToolLoop({
    task: TASK,
    userMessage: TASK,
    tools: [...createCodingTools(), ...createActivityMonitorTools({ logStore })],
    model: { id: "scripted/driver" },
    llm,
    permission: new PermissionGate("bypass", async () => ({ allowed: true })),
    logStore,
    emit: (e) => {
      if (e.type !== "tool_execution_end") return;
      const text = resultText(e.result);
      const details = resultDetails(e.result);
      results.push({ tool: e.toolName, isError: Boolean(e.isError), text, details });
      if (e.toolName === "read" && !e.isError) sourceText = text;
      if (e.toolName === "activity_trace_start" && !e.isError) {
        traceId = details?.traceId;
        snippet = text.match(/```[a-z]*\n([\s\S]*?)```/)?.[1]?.trimEnd();
      }
    },
    cwd: work,
    isBugFix: true,
    reproductionGate,
    verificationGate,
    // Stand in for what a live staged read would measure. Seeded, never guessed:
    // with no `--rating` the run proceeds without the signal, exactly as it does
    // today for a file nothing has rated.
    ...(typeof args.rating === "string"
      ? { complexityByPath: { [path.join(work, target)]: args.rating }, complexitySource: "prepare-file" }
      : {}),
  });

  // ---------------------------------------------------------------------------
  // report
  // ---------------------------------------------------------------------------
  const rule = "─".repeat(78);
  console.log(`\n${rule}\nREPRODUCE-FIRST AUDIT\n${rule}`);
  console.log(`repo:    ${REPO}`);
  console.log(`file:    ${target}`);
  console.log(`run cmd: ${typeof args.run === "string" ? args.run : "(none given — the trace cannot capture anything)"}`);
  console.log(`task:    ${TASK.slice(0, 68)}${TASK.length > 68 ? "…" : ""}`);
  console.log(`rating:  ${typeof args.rating === "string" ? `${args.rating} (supplied; a live run measures this on read)` : "(none supplied)"}`);
  console.log(`scratch: ${work}${args.mirror ? ` (mirror; symlinked: ${linked.join(", ") || "none"})` : ""}`);
  console.log(`         no repo source was written to — every edit landed on a copy\n`);

  steps.forEach((s, n) => {
    const r = results[n];
    const verdict = s.note ? `skipped — ${s.note}` : !r ? "(no result)" : r.isError ? "REFUSED" : "ran";
    console.log(`${String(n + 1).padStart(2)}. ${s.what}\n    ${s.tool} → ${verdict}`);
    if (r?.isError) console.log(`    ↳ ${r.text.split("\n")[0].slice(0, 140)}`);
  });

  const report = reproductionGate.toReport();
  console.log(`\n${rule}\nGATE REPORT\n${rule}\n${JSON.stringify(report, null, 2)}`);

  const collect = results.find((r) => r.tool === "activity_collect");
  const captured = collect?.details?.captured ?? 0;
  const sawModuleProbe = /audit: module scope reached/.test(collect?.text ?? "");
  const sawAnchorProbe = /audit: anchor line reached/.test(collect?.text ?? "");
  console.log(`\ncaptured by the trace: ${collect?.details?.captured ?? "(no capture)"}` +
    (typeof args.run === "string"
      ? `  [module-scope probe: ${sawModuleProbe ? "recorded" : "MISSING"}; anchor probe: ${sawAnchorProbe ? "recorded" : "not reached"}]`
      : ""));
  if (typeof args.run === "string" && !sawModuleProbe) {
    const ran = results.find((r) => r.tool === "bash");
    console.log(`\nthe run command produced:\n${(ran?.text ?? "(nothing)").split("\n").slice(-12).join("\n")}`);
  }
  const owed = verificationGate.toReport();
  console.log(`verify gate owes evidence for: ${JSON.stringify(
    [...owed.unverified, ...owed.checked, ...owed.certified].map((e) => path.relative(work, e.path)),
  )}`);
  console.log(`instrumented (tracked for stripping): ${JSON.stringify(loop.instrumentedPaths.map((p) => path.relative(work, p)))}`);

  // The findings, stated as pass/fail rather than left for the reader to infer.
  const blind = results[1];
  // Indices follow `plan` above: read, blind fix, trace start, helper+module probe,
  // anchor probe, [run], collect, informed fix.
  const probe = results[3];
  const anchorProbe = results[4];
  const informed = results[results.length - 1];
  const ranFlow = typeof args.run === "string";
  // Which behaviour is CORRECT here depends on what the harness decided about this
  // fix, so the audit has to read that before grading. A gate the assessor lifted
  // is supposed to let the edit through — grading it against the armed path would
  // report the harness being right as a failure, which is worse than no audit.
  const lifted = report.assessedStraightforward === true || report.declaredStraightforward !== undefined;
  console.log(`\n${rule}\nVERDICT — the gate was ${lifted ? "LIFTED (assessed straightforward)" : "ARMED"}\n${rule}`);

  const checks = lifted
    ? [
        ["the lift is recorded with a reason, not silent", Boolean(report.declaredStraightforward?.reason)],
        ["a lifted gate does not block the fix", blind?.isError === false],
        ["nothing was claimed to be reproduced", report.reproduced === false],
      ]
    : [
        ["the unobserved fix was refused", blind?.isError === true],
        ["the refusal named a way to observe the bug", /activity_(inspect|trace_start|tail_file)/.test(blind?.text ?? "")],
        ["instrumenting was allowed while the gate stayed armed", probe?.isError === false && anchorProbe?.isError === false],
        ...(ranFlow
          ? sawModuleProbe
            ? [
                ["the probe wrote to the trace when the code ran", captured > 0],
                ["the fix was allowed once the bug was observed", informed?.isError === false],
                ["the report says the bug was reproduced", report.reproduced === true],
              ]
            : // The write path never proved itself, so the capture→fix half is
              // untested here rather than failed. Grade what IS decidable and say
              // the rest is inconclusive — a FAIL would read as a harness defect.
              [["a trace with nothing in it did NOT count as reproduction", report.reproduced === false]]
          : [["a dry trace did NOT count as reproduction", report.reproduced === false]]),
      ];
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);

  if (lifted) {
    console.log("\n  This file is a straightforward target, so reproduction was correctly skipped.");
    console.log("  To audit the ARMED path, pass --file pointing at code with real runtime flow");
    console.log("  (the assessor keeps the gate armed for anything async or multi-file).");
  } else if (!ranFlow) {
    console.log("\n  note: pass --run '<command that exercises the flow>' to audit the full");
    console.log("        capture→fix half. Without it only the refusal half is exercised.");
  } else if (!sawModuleProbe) {
    console.log("\n  INCONCLUSIVE on the capture half: the module-scope probe never recorded, so");
    console.log("  --run did not import the instrumented file (or a transform dropped the probe).");
    console.log("  Point --run at something that actually loads --file. What IS shown above: a");
    console.log("  trace with nothing in it did not count as reproduction.");
  }
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}

main().catch((e) => {
  console.error("AUDIT ERROR:", e);
  process.exitCode = 1;
});
