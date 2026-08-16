/**
 * Live run: "create a small Expo (React Native) mobile app and run it on
 * the iOS simulator for verification".
 *
 * Uses the `mobile` project preset. Device automation is the harness's
 * built-in `mobile_*` toolkit (backed by the `mobilecli` binary), so nothing
 * is spawned per run: it boots/drives the iOS simulator, loads the Expo dev
 * build, and captures a screenshot we audit with `media_analysis`.
 *
 * Run:
 *   OPENROUTER_API_KEY=... node examples/live-expo-mobile.mjs
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const MODEL = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";
const OUT = process.env.EXPO_DIR ?? "/Users/shashankv/Projects/turing-harness/.scratch-expo-mobile";
const TRANSCRIPT = process.env.TRANSCRIPT_PATH ?? path.join(OUT, "transcript.jsonl");

// Normalize the session event payload: project-session events wrap fields
// under `data`; harness-level events don't. The summarizer below handles
// both shapes.
function summarizeEvent(event) {
  const payload = (event && typeof event === "object" && event.data && typeof event.data === "object" && !Array.isArray(event.data) && event.type !== "message")
    ? event.data
    : event;
  switch (event.type) {
    case "chain_start":       return { task: payload.task };
    case "chain_iteration":   return { iteration: payload.iteration };
    case "chain_end":         return { success: payload.success, iterations: payload.iterations };
    case "phase_start":       return { phase: payload.phase, model: payload.model };
    case "phase_end":         return { phase: payload.phase, verified: payload.result?.verified, error: payload.result?.error, summary: payload.result?.summary };
    case "tool_execution_start": return { toolCallId: payload.toolCallId, toolName: payload.toolName, args: payload.args };
    case "tool_execution_end":   return { toolCallId: payload.toolCallId, toolName: payload.toolName, isError: payload.isError };
    default:                  return {};
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

  console.log("app dir:", OUT, "| model:", MODEL);
  console.log("transcript:", TRANSCRIPT, "\n");

  const harness = new Harness({
    apiKey: process.env.OPENROUTER_API_KEY,
    permissionMode: "bypass",
    models: { orchestrator: MODEL, prepare: MODEL, plan: MODEL, perform: MODEL, perfect: MODEL },
    toolModelCandidates: [MODEL],
    studyModel: MODEL,
    maxSteps: {
      prepare: Number(process.env.PREPARE_STEPS ?? 5),
      plan:    Number(process.env.PLAN_STEPS ?? 5),
      perform: Number(process.env.PERFORM_STEPS ?? 24),
      perfect: Number(process.env.PERFECT_STEPS ?? 14),
    },
    maxChainIterations: Number(process.env.MAX_ITER ?? 2),
  });

  // Mobile preset → Mobile MCP for Perfect (drives iOS / Android simulator).
  const { session, report } = await harness.createProjectSession("mobile", {
    cwd: OUT,
    connectMcp: true,
    include: ["mobile"],
  });

  console.log("preset MCP → connected:", report.connected, "| skipped:", report.skipped.map((s) => s.id), "| failed:", report.failed.map((f) => f.id));
  const perfectTools = session.toolsForPhase("perfect").map((t) => t.name);
  console.log("perfect has mobile tools:", perfectTools.filter((n) => /^(mobile_|simulator_)/.test(n) || /ios|android|simulator/i.test(n)).join(", ") || "(none yet)");
  console.log("");

  // Metro is owned by the MODEL, not the harness. An earlier version of this
  // example pre-started Metro here, but that was broken and counterproductive:
  //  - it spawned `expo start` against an EMPTY directory (the app files and
  //    node_modules don't exist until the Perform/Perfect phases create them),
  //    so the harness Metro had nothing valid to bundle;
  //  - it occupied port 8081, so when the prompt told the model to start Metro
  //    on 8081 the model hit a port conflict and burned the entire Perfect
  //    phase in a pkill/restart spiral, never reaching the screenshot + audit.
  // The model is perfectly capable of installing deps and starting Metro
  // itself, so we let it own the full dev-server lifecycle and only de-conflict
  // the instructions below.
  const metro = null;

  const appendTranscript = createTranscriptLogger(TRANSCRIPT);
  const unsubTranscript = session.subscribe((e) => {
    void appendTranscript(e).catch((err) => console.error("transcript write failed:", err.message));
  });
  const unsubTrace = session.subscribe((e) => {
    if (e.type === "phase_start") console.log(`\n▶ ${e.data?.phase?.toUpperCase?.() ?? e.phase?.toUpperCase?.()}`);
    else if (e.type === "tool_execution_start") {
      const name = e.data?.toolName ?? e.toolName;
      const args = e.data?.args ?? e.args;
      console.log(`   → ${name}(${JSON.stringify(args).slice(0, 110)})`);
    }
    else if (e.type === "tool_execution_end") {
      const name = e.data?.toolName ?? e.toolName;
      const isErr = e.data?.isError ?? e.isError;
      console.log(`   ✓ ${name}${isErr ? " [ERROR]" : ""}`);
    }
    else if (e.type === "chain_iteration") console.log(`\n— iteration ${e.data?.iteration ?? e.iteration} —`);
    else if (e.type === "phase_end") {
      const verified = e.data?.result?.verified ?? e.result?.verified;
      const phase = e.data?.phase ?? e.phase;
      console.log(`   ${phase} done${verified != null ? ` verified=${verified}` : ""}`);
    }
    else if (e.type === "chain_end") {
      const ok = e.data?.success ?? e.success;
      const it = e.data?.iterations ?? e.iterations;
      console.log(`\n■ success=${ok} iterations=${it}`);
    }
  });

  // Real Expo prompt. The Perfect phase is told explicitly to boot the iOS
  // simulator via Mobile MCP and verify with a screenshot.
  const task =
    `Create a small Expo (React Native) mobile app called "CounterPlus" DIRECTLY in the project root (${OUT}).\n` +
    `\n` +
    `App requirements:\n` +
    `- Write the project files (App.tsx, app.json, package.json, tsconfig.json, ...) directly into the project root. Do NOT run "create-expo-app" and do NOT create a nested subfolder like ./CounterPlus — every file must sit at the top level of ${OUT}. Author the files yourself with the write tool.\n` +
    `- Use the Expo SDK (managed workflow). Do NOT use bare React Native CLI; Expo handles native code.\n` +
    `- Use TypeScript (App.tsx + tsconfig.json + expo/tsconfig.base).\n` +
    `- The home screen shows:\n` +
    `    * A <Text> title "CounterPlus" at the top.\n` +
    `    * A large <Text> showing the current count number, with testID "count-label".\n` +
    `    * Two <Pressable> buttons side by side: "Decrement" (testID "dec-btn") and "Increment" (testID "inc-btn").\n` +
    `    * A "Reset" <Pressable> button below (testID "reset-btn") that sets the count to 0.\n` +
    `    * Tapping Increment adds 1, Decrement subtracts 1, Reset sets to 0.\n` +
    `- Use React state (useState) for the counter. Style it cleanly with a centered layout, system font, and good spacing.\n` +
    `- Include the standard Expo entry files: app.json (with a top-level "name": "CounterPlus", "slug": "counterplus", and an iOS bundleIdentifier like "com.example.counterplus") and a package.json with a "start" script (` + '"expo start"' + `).\n` +
    `- Use Expo SDK 52. Pin the core dependencies to the versions Expo 52 ships so ` + "`npm install`" + ` resolves cleanly (an Expo app MUST declare react and react-native, not just expo):\n` +
    `      "dependencies": { "expo": "~52.0.0", "react": "18.3.1", "react-native": "0.76.9" }\n` +
    `      "devDependencies": { "@babel/core": "^7.25.2", "@types/react": "~18.3.12", "typescript": "^5.3.3" }\n` +
    `  Do NOT add "@types/react-native" (React Native ships its own types) and do NOT bump react-native to 0.8x — that pulls @types/react 19 and breaks peer resolution.\n` +
    `- Keep the project minimal but runnable: do not add extra screens, navigation, or unrequested dependencies.\n` +
    `\n` +
    `VERIFY (Perfect phase) — bash starts the project, MCP drives the simulator.\n` +
    `The project root is: ${OUT}\n` +
    `  bash (install deps, then start the bundler ONCE):\n` +
    `    a. If ` + "`node_modules`" + ` is missing, install deps in the project root with ` + "`npm install --legacy-peer-deps --no-audit --no-fund`" + ` and wait for it to finish. (Expo peer deps require --legacy-peer-deps; do NOT retry plain ` + "`npm install`" + ` in a loop — if it fails once with an ERESOLVE peer-dependency error, add --legacy-peer-deps.)\n` +
    `    b. Start Metro ONCE, non-blocking, from the project root:\n` +
    `         nohup npx expo start --port 8081 --offline > metro.log 2>&1 &\n` +
    `       Then ` + "`sleep 8`" + ` and read metro.log; confirm Metro is up (look for "Waiting on" or "Metro waiting" or "Bundling").\n` +
    `    c. IMPORTANT: start Metro at most ONCE. If port 8081 is already serving Metro, REUSE it — do not restart. Never run ` + "`pkill node`" + ` or ` + "`pkill -f expo`" + `; that kills the test harness itself. Do not pass a ` + "`--dev`" + ` flag (it does not exist); the valid flags are ` + "`--no-dev`" + ` and ` + "`--offline`" + `.\n` +
    `  Device toolkit (drive the simulator):\n` +
    `    1. mobile_devices — pick the booted iOS simulator. Capture its ` + "`deviceId`" + `.\n` +
    `    2. Load the app via the Expo dev URL: mobile_open_url device=<id> url=exp://127.0.0.1:8081 (this opens the app in Expo Go on the simulator). If that errors, fall back to mobile_open_url with url=http://127.0.0.1:8081.\n` +
    `    3. Wait for the JS bundle to load (bash: ` + "`sleep 8`" + `).\n` +
    `    4. mobile_screenshot device=<id> saveTo=${path.join(OUT, "counterplus-simulator.png")} — pass saveTo so the capture is written to disk (without it the image only comes back inline and media_analysis, which reads by path, cannot see it). The saveTo path MUST be this absolute .png path so the screenshot persists in the project.\n` +
    `    5. media_analysis on ${path.join(OUT, "counterplus-simulator.png")} — ask it to confirm a "CounterPlus" title, the count label, and three buttons (Increment, Decrement, Reset) are visible.\n` +
    `Preconditions for "VERDICT: PASS": (a) Metro is up, (b) ${path.join(OUT, "counterplus-simulator.png")} exists and is non-empty, (c) the auditor confirms all required UI elements. End with "VERDICT: PASS" only if all three are true. If any precondition fails, end with "VERDICT: FAIL" and a "FIX:" section explaining what to try.`;

  const result = await session.runChain(task);

  console.log("\n===== RESULT =====");
  console.log("success:", result.success, "| iterations:", result.iterations, "| cost $", result.usage.cost.total.toFixed(4));

  // Independent post-run checks: did we actually create the Expo project on disk?
  const files = await fs.readdir(OUT).catch(() => []);
  const pkg = JSON.parse(await fs.readFile(path.join(OUT, "package.json"), "utf8").catch(() => "{}"));
  const appJson = JSON.parse(await fs.readFile(path.join(OUT, "app.json"), "utf8").catch(() => "{}"));
  const appTsx = await fs.readFile(path.join(OUT, "App.tsx"), "utf8").catch(() => "");
  const screenshotPath = path.join(OUT, "counterplus-simulator.png");
  const screenshotExists = await fs.stat(screenshotPath).then(() => true).catch(() => false);

  console.log("\nfiles:", files.filter((f) => !f.startsWith(".")).join(", "));
  console.log("checks:", JSON.stringify({
    hasAppTsx: !!appTsx,
    hasAppJson: !!appJson.name,
    hasPackageJson: !!pkg.name,
    usesExpo: !!pkg.dependencies?.expo,
    appName: appJson.name ?? null,
    appSlug: appJson.slug ?? null,
    hasIncBtn: /inc-btn/.test(appTsx),
    hasDecBtn: /dec-btn/.test(appTsx),
    hasResetBtn: /reset-btn/.test(appTsx),
    hasCountLabel: /count-label/.test(appTsx),
    hasCounterState: /useState/.test(appTsx),
    screenshotExists,
  }, null, 2));

  if (screenshotExists) {
    const stat = await fs.stat(screenshotPath);
    console.log(`\nscreenshot: ${screenshotPath} (${stat.size} bytes)`);
  }

  unsubTrace();
  unsubTranscript();
  if (metro && metro.pid) {
    try { process.kill(-metro.pid, "SIGTERM"); } catch {}
    try { metro.kill("SIGTERM"); } catch {}
    console.log("metro stopped.");
  }
  // The model owns Metro now (started via nohup in a bash tool), so it would
  // otherwise leak past this script. Free port 8081 on the way out.
  try {
    const { execSync } = await import("node:child_process");
    execSync("lsof -ti tcp:8081 | xargs kill -9", { stdio: "ignore" });
    console.log("freed port 8081 (model-owned metro).");
  } catch {}
  await harness.dispose();
  console.log("\ntranscript saved:", TRANSCRIPT);
  console.log("done.");
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  process.exit(1);
});
