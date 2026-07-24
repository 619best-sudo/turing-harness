/**
 * Live end-to-end 4P chain against a real OpenRouter model.
 * Scaffolds a tiny real project, then runs Prepare→Plan→Perform→Perfect on a
 * concrete coding task and reports what happened.
 *
 * Run:  OPENROUTER_API_KEY=... node examples/live-chain.mjs
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const MODEL = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";

async function scaffold() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acme-math-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mathkit", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2),
  );
  await fs.writeFile(path.join(dir, "README.md"), "# mathkit\nA tiny math utility library. `npm test` runs test.js.\n");
  return dir;
}

async function main() {
  const cwd = await scaffold();
  console.log("project:", cwd, "\nmodel:", MODEL, "\n");

  const harness = new Harness({
    apiKey: process.env.OPENROUTER_API_KEY,
    cwd,
    permissionMode: "bypass",
    models: { orchestrator: MODEL, prepare: MODEL, plan: MODEL, perform: MODEL, perfect: MODEL },
    toolModelCandidates: [MODEL],
    studyModel: MODEL,
    maxSteps: { prepare: 6, plan: 6, perform: 12, perfect: 6 },
    maxChainIterations: 2,
  });

  const t0 = Date.now();
  harness.subscribe((e) => {
    if (e.type === "phase_start") console.log(`\n▶ ${e.phase.toUpperCase()} (${e.model})`);
    else if (e.type === "tool_execution_start") console.log(`   → ${e.toolName}(${JSON.stringify(e.args).slice(0, 80)})`);
    else if (e.type === "tool_execution_end") console.log(`   ✓ ${e.toolName}${e.isError ? " [ERROR]" : ""}`);
    else if (e.type === "chain_iteration") console.log(`\n— iteration ${e.iteration} —`);
    else if (e.type === "phase_end") console.log(`   ${e.phase} done${e.result.verified != null ? ` verified=${e.result.verified}` : ""}`);
    else if (e.type === "chain_end") console.log(`\n■ chain_end success=${e.success} iterations=${e.iterations}`);
  });

  const task =
    "Add `src/math.js` exporting a CommonJS function `add(a, b)` that returns their sum. " +
    "Create `test.js` that requires it, asserts add(2,3) === 5 (throw on failure), and prints 'ok'. " +
    "Make `npm test` pass.";

  const result = await harness.runChain(task);

  console.log(`\n===== RESULT (${((Date.now() - t0) / 1000).toFixed(0)}s) =====`);
  console.log("success:", result.success, "| iterations:", result.iterations, "| cost $", result.usage.cost.total.toFixed(4));
  console.log("\nPERFORM:\n", (result.phases.perform?.summary ?? "-").slice(0, 500));
  console.log("\nPERFECT:\n", (result.phases.perfect?.summary ?? "-").slice(0, 500));

  console.log("\n----- files on disk -----");
  for (const f of ["src/math.js", "test.js"]) {
    try {
      console.log(`\n// ${f}\n${await fs.readFile(path.join(cwd, f), "utf8")}`);
    } catch {
      console.log(`\n// ${f}  (missing)`);
    }
  }
}

main().catch((e) => { console.error("CHAIN ERROR:", e); process.exit(1); });
