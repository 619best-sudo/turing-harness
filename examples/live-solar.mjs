/**
 * Live run: "create an animated solar system in single file index.html".
 * Greenfield frontend task. Writes the project to a stable dir so it can be
 * opened in a browser afterwards.
 *
 * Run:  OPENROUTER_API_KEY=... node examples/live-solar.mjs
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const MODEL = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";
const OUT = process.env.SOLAR_DIR ?? path.join(os.tmpdir(), "acme-solar");

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  console.log("project:", OUT, "\nmodel:", MODEL, "\n");

  const harness = new Harness({
    apiKey: process.env.OPENROUTER_API_KEY,
    cwd: OUT,
    permissionMode: "bypass",
    models: { orchestrator: MODEL, prepare: MODEL, plan: MODEL, perform: MODEL, perfect: MODEL },
    toolModelCandidates: [MODEL],
    studyModel: MODEL,
    maxSteps: { prepare: 4, plan: 4, perform: Number(process.env.PERFORM_STEPS ?? 16), perfect: Number(process.env.PERFECT_STEPS ?? 10) },
    maxChainIterations: Number(process.env.MAX_ITER ?? 4),
  });

  const t0 = Date.now();
  harness.subscribe((e) => {
    if (e.type === "phase_start") console.log(`\n▶ ${e.phase.toUpperCase()}`);
    else if (e.type === "tool_execution_start") console.log(`   → ${e.toolName}(${JSON.stringify(e.args).slice(0, 90)})`);
    else if (e.type === "tool_execution_end") console.log(`   ✓ ${e.toolName}${e.isError ? " [ERROR]" : ""}`);
    else if (e.type === "chain_iteration") console.log(`\n— iteration ${e.iteration} —`);
    else if (e.type === "phase_end") console.log(`   ${e.phase} done${e.result.verified != null ? ` verified=${e.result.verified}` : ""}`);
    else if (e.type === "chain_end") console.log(`\n■ success=${e.success} iterations=${e.iterations}`);
  });

  const result = await harness.runChain("create an animated solar system in single file index.html");

  console.log(`\n===== RESULT (${((Date.now() - t0) / 1000).toFixed(0)}s) =====`);
  console.log("success:", result.success, "| iterations:", result.iterations, "| cost $", result.usage.cost.total.toFixed(4));

  const file = path.join(OUT, "index.html");
  try {
    const html = await fs.readFile(file, "utf8");
    console.log(`\nindex.html: ${html.length} bytes`);
    const checks = {
      hasDoctype: /<!doctype html>/i.test(html),
      hasCanvasOrSvg: /<canvas|<svg/i.test(html),
      hasAnimation: /requestAnimationFrame|@keyframes|animation:/i.test(html),
      mentionsSun: /\bsun\b/i.test(html),
      mentionsPlanet: /planet|earth|mars|venus|mercury|jupiter/i.test(html),
      selfContained: !/<script[^>]+src=|<link[^>]+href=["']http/i.test(html),
    };
    console.log("checks:", JSON.stringify(checks, null, 2));
    console.log("\n--- head (first 1200 chars) ---\n" + html.slice(0, 1200));
  } catch {
    console.log("\nindex.html MISSING. files present:", (await fs.readdir(OUT)).join(", "));
  }
}

main().catch((e) => { console.error("CHAIN ERROR:", e); process.exit(1); });
