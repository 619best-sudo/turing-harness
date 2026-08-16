/**
 * Live run: "create an animated solar system in single file index.html"
 * with Playwright MCP connected for Perfect-phase browser verification.
 *
 * Run: OPENROUTER_API_KEY=... node examples/live-solar-playwright.mjs
 */
// v2 note: this example now drives the categorizer chain via run().
import http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const MODEL = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";
const OUT = process.env.SOLAR_DIR ?? "/Users/shashankv/Projects/turing-harness/.scratch-solar-playwright";
const PORT = Number(process.env.SOLAR_PORT ?? 8823);
const URL = `http://localhost:${PORT}/index.html`;
const TRANSCRIPT = process.env.TRANSCRIPT_PATH ?? path.join(OUT, "transcript.jsonl");

function serve(dir, port) {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p === "/") p = "/index.html";
      const data = await fs.readFile(path.join(dir, p));
      const ext = path.extname(p);
      const ct = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/plain";
      res.writeHead(200, { "content-type": ct });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

function summarizeEvent(event) {
  switch (event.type) {
    case "chain_start":
      return { task: event.task };
    case "chain_iteration":
      return { iteration: event.iteration };
    case "chain_end":
      return { success: event.success, iterations: event.iterations };
    case "phase_start":
      return { phase: event.phase, model: event.model };
    case "phase_end":
      return {
        phase: event.phase,
        verified: event.result.verified,
        error: event.result.error,
        summary: event.result.summary,
      };
    case "tool_execution_start":
      return { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_end":
      return { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError };
    default:
      return {};
  }
}

function createTranscriptLogger(filePath) {
  return async (event) => {
    const record = {
      ts: new Date().toISOString(),
      type: event.type,
      data: summarizeEvent(event),
    };
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  };
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(TRANSCRIPT, "", "utf8");
  const server = await serve(OUT, PORT);

  console.log("app dir:", OUT, "| serving", URL, "| model:", MODEL);
  console.log("transcript:", TRANSCRIPT, "\n");

  const harness = new Harness({
    apiKey: process.env.OPENROUTER_API_KEY,
    permissionMode: "bypass",
    models: { orchestrator: MODEL, prepare: MODEL, plan: MODEL, perform: MODEL, perfect: MODEL },
    toolModelCandidates: [MODEL],
    studyModel: MODEL,
    maxSteps: {
      prepare: Number(process.env.PREPARE_STEPS ?? 5),
      plan: Number(process.env.PLAN_STEPS ?? 5),
      perform: Number(process.env.PERFORM_STEPS ?? 16),
      perfect: Number(process.env.PERFECT_STEPS ?? 10),
    },
    maxChainIterations: Number(process.env.MAX_ITER ?? 2),
  });

  const { session, report } = await harness.createProjectSession("frontend", {
    cwd: OUT,
    connectMcp: true,
    include: ["playwright"],
  });

  console.log("preset MCP → connected:", report.connected, "| skipped:", report.skipped.map((s) => s.id), "| failed:", report.failed.map((f) => f.id));
  console.log("perfect has browser tools:", session.toolsForPhase("perfect").some((t) => t.name === "browser_snapshot"), "\n");

  const appendTranscript = createTranscriptLogger(TRANSCRIPT);
  const unsubTranscript = session.subscribe((e) => {
    void appendTranscript(e).catch((err) => {
      console.error("transcript write failed:", err.message);
    });
  });
  const unsubTrace = session.subscribe((e) => {
    if (e.type === "phase_start") console.log(`\n▶ ${e.phase.toUpperCase()}`);
    else if (e.type === "tool_execution_start") console.log(`   → ${e.toolName}(${JSON.stringify(e.args).slice(0, 90)})`);
    else if (e.type === "tool_execution_end") console.log(`   ✓ ${e.toolName}${e.isError ? " [ERROR]" : ""}`);
    else if (e.type === "chain_iteration") console.log(`\n— iteration ${e.iteration} —`);
    else if (e.type === "phase_end") console.log(`   ${e.phase} done${e.result.verified != null ? ` verified=${e.result.verified}` : ""}`);
    else if (e.type === "chain_end") console.log(`\n■ success=${e.success} iterations=${e.iterations}`);
  });

  const task =
    `Create an animated solar system in single file index.html.\n` +
    `Requirements:\n` +
    `- Put all HTML, CSS, and JS in index.html only.\n` +
    `- Include a visible sun and multiple orbiting planets.\n` +
    `- Use real animation so planets orbit continuously.\n` +
    `- Do not create any other files.\n\n` +
    `VERIFY (Perfect phase): call browser_navigate with url "${URL}", then browser_snapshot, ` +
    `and confirm the page has an "Animated Solar System" title or heading and the app loads successfully. ` +
    `End with "VERDICT: PASS" only if browser verification succeeds.`;

  const result = await session.run(task);

  console.log("\n===== RESULT =====");
  console.log("success:", result.success, "| iterations:", result.iterations, "| cost $", result.usage.cost.total.toFixed(4));

  const file = path.join(OUT, "index.html");
  try {
    const html = await fs.readFile(file, "utf8");
    console.log(`\nindex.html: ${html.length} bytes`);
    console.log("checks:", JSON.stringify({
      singleFile: (await fs.readdir(OUT)).filter((f) => !f.startsWith(".")).length === 1,
      hasDoctype: /<!doctype html>/i.test(html),
      hasAnimation: /requestAnimationFrame|@keyframes|animation:/i.test(html),
      mentionsSun: /\bsun\b/i.test(html),
      mentionsPlanet: /planet|earth|mars|venus|mercury|jupiter/i.test(html),
    }, null, 2));
  } catch {
    console.log("\nindex.html MISSING. files present:", (await fs.readdir(OUT)).join(", "));
  }

  unsubTrace();
  unsubTranscript();
  await harness.dispose();
  server.close();
  console.log("\ntranscript saved:", TRANSCRIPT);
  console.log("server stopped. done.");
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  process.exit(1);
});
