/**
 * End-to-end: frontend preset + Playwright MCP, multi-file build THEN edit, with
 * Perfect verifying via Playwright's DOM snapshot (browser_snapshot) — vision-free,
 * suitable for a non-vision model.
 *
 * Run:  OPENROUTER_API_KEY=... node examples/live-frontend-e2e.mjs
 */
// v2 note: this example now drives the categorizer chain via run().
import http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Harness } from "../dist/index.js";

const MODEL = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";
const OUT = process.env.APP_DIR ?? "/Users/shashankv/Projects/turing-harness/.scratch-app";
const PORT = 8811;
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
      res.writeHead(200, { "content-type": ct }); res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

function trace(harness, label) {
  return harness.subscribe((e) => {
    if (e.type === "phase_start") console.log(`  ▶ ${label}:${e.phase}`);
    else if (e.type === "tool_execution_start") console.log(`     → ${e.toolName}(${JSON.stringify(e.args).slice(0, 70)})`);
    else if (e.type === "tool_execution_end") console.log(`     ✓ ${e.toolName}${e.isError ? " [ERR]" : ""}`);
    else if (e.type === "phase_end" && e.result.verified != null) console.log(`     ${e.phase} verified=${e.result.verified}`);
    else if (e.type === "chain_end") console.log(`  ■ ${label} success=${e.success} iters=${e.iterations}`);
  });
}

function summarizeEvent(event) {
  // Project-session events wrap their payload under `data`; harness-level
  // events expose fields at the top level. Normalize both shapes.
  const payload = (event && typeof event === "object" && event.data && typeof event.data === "object" && !Array.isArray(event.data) && event.type !== "message")
    ? event.data
    : event;
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
        usage: event.result.usage,
      };
    case "tool_execution_start":
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_end":
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: event.result,
      };
    case "permission_request":
      return {
        phase: event.request.phase,
        name: event.request.name,
        args: event.request.args,
        mutates: event.request.mutates,
      };
    case "permission_decision":
      return {
        phase: event.request.phase,
        name: event.request.name,
        allowed: event.decision.allowed,
        reason: event.decision.reason,
        model: event.decision.model,
      };
    case "message_end":
      return {
        role: event.message.role,
        contentTypes: (event.message.content ?? []).map((c) => c.type),
      };
    case "turn_end":
      return {
        role: event.message.role,
        toolResults: event.toolResults.length,
      };
    default:
      return {};
  }
}

function createTranscriptLogger(filePath) {
  return async (label, event) => {
    const record = {
      ts: new Date().toISOString(),
      label,
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
        toolModelCandidates: [MODEL],
    studyModel: MODEL,
        maxChainIterations: 3,
  });

  // Frontend preset + connect ONLY Playwright (Perfect gets browser tools).
  const { session, report } = await harness.createProjectSession("frontend", {
    cwd: OUT, connectMcp: true, include: ["playwright"],
  });
  console.log("preset MCP → connected:", report.connected, "| skipped:", report.skipped.map((s) => s.id), "| failed:", report.failed.map((f) => f.id));
  console.log("activity_inspect has browser tools:", session.toolsForCategorizer("activity_inspect").some((t) => t.name === "browser_snapshot"), "\n");

  const appendTranscript = createTranscriptLogger(TRANSCRIPT);
  // Project sessions have their own event stream; subscribe on the session
  // (not the harness) so we capture phase/tool activity for this run.
  const transcriptUnsub = session.subscribe((e) => {
    void appendTranscript("run", e).catch((err) => {
      console.error("transcript write failed:", err.message);
    });
  });

  const unsub = trace(session, "build");

  // ---- 1) Multi-file build ----
  console.log("=== BUILD (multi-file portfolio site) ===");
  const buildTask =
    `Build a small, realistic personal PORTFOLIO WEBSITE as a multi-file static site. Use these files in the project root:\n` +
    `\n` +
    `- index.html: a real landing page with semantic structure. REQUIRED structure:\n` +
    `    * <header> containing the site title "Ada Lovelace" (h1) and a top nav (<nav>) with anchor links to #about, #projects, and #contact.\n` +
    `    * <section id="about"> with an <h2>About</h2> and a short 2–3 sentence bio paragraph.\n` +
    `    * <section id="projects"> with an <h2>Projects</h2> and at least 3 project cards. Each card is an <article class="project"> containing an <h3 class="project-title">, a <p class="project-desc"> description, and a <span class="project-tag"> with a single tag (e.g. "Web", "ML", "Systems").\n` +
    `    * <section id="contact"> with an <h2>Contact</h2>, an <a id="email-link" href="mailto:ada@example.com"> email link, and a <a id="github-link" href="https://github.com/ada"> GitHub link.\n` +
    `    * <footer> with "© 2026 Ada Lovelace".\n` +
    `    * <button id="filter-btn">Show only Web</button> right after the <h2>Projects</h2>.\n` +
    `    * Link styles.css in <head> and app.js at the end of <body>.\n` +
    `- styles.css: real, modern styling — set a system font stack on body, give the page a max-width container around 960px centered, add card-like styling for .project (rounded corners, subtle shadow, padding), make nav links inline with spacing, and ensure the page is readable on a 1280px viewport. Do not use any external CSS/JS — everything is self-contained.\n` +
    `- app.js: clicking #filter-btn toggles a class on the projects container (e.g. #projects) that hides any <article class="project"> whose .project-tag text is NOT exactly "Web". Toggling again restores all projects. Wire this using DOM APIs (querySelector / classList), not innerHTML rewriting.\n` +
    `\n` +
    `Constraints:\n` +
    `- Three separate files. Do not inline all of this in index.html.\n` +
    `- Do not create extra files beyond index.html, styles.css, app.js.\n` +
    `- Keep code clean, semantic, and well-structured.\n` +
    `\n` +
    `VERIFY (Perfect phase): call browser_navigate with url "${URL}", then browser_snapshot, and confirm the accessibility tree contains:\n` +
    `  - the "Ada Lovelace" heading\n` +
    `  - "About", "Projects", and "Contact" section headings\n` +
    `  - at least 3 project articles\n` +
    `  - the email and GitHub links\n` +
    `  - the "Show only Web" filter button\n` +
    `End with "VERDICT: PASS" only if all are present.`;
  const r1 = await session.run(buildTask);
  unsub();

  console.log("\nfiles after build:", (await fs.readdir(OUT)).filter((f) => !f.startsWith(".")).join(", "));

  // ---- 2) Edit pass ----
  console.log("\n=== EDIT (add dark mode + project modal) ===");
  const unsub2 = trace(session, "edit");
  const editTask =
    `EDIT the existing portfolio site (use read + edit, do not rewrite the files from scratch). Two changes:\n` +
    `\n` +
    `1) Add a DARK MODE toggle:\n` +
    `   - In index.html, add <button id="theme-toggle">Toggle Theme</button> inside the <header>, before the <nav>.\n` +
    `   - In styles.css, add a body.dark-mode rule that flips the background to #111 and the main text color to #f5f5f5, plus a .dark-mode .project rule that swaps the card background and border so cards stay readable on dark.\n` +
    `   - In app.js, wire the toggle: clicking #theme-toggle adds/removes the "dark-mode" class on <body>, and persists the choice in localStorage under the key "theme" (value "dark" or "light") so the chosen theme survives a page reload.\n` +
    `\n` +
    `2) Add a PROJECT DETAILS modal:\n` +
    `   - In index.html, after #contact, add <div id="modal" class="modal hidden"> with an inner <div class="modal-content"> containing <span id="modal-close">×</span>, an <h3 id="modal-title"> placeholder, and a <p id="modal-desc"> placeholder.\n` +
    `   - In styles.css, add a .modal rule that centers the modal over the page with a translucent backdrop, and a .modal.hidden rule that sets display:none.\n` +
    `   - In app.js, when a user clicks any <article class="project">, populate #modal-title with that article's .project-title text, populate #modal-desc with that article's .project-desc text, and remove the "hidden" class from #modal. Clicking #modal-close or clicking the backdrop (the #modal element itself) should re-add "hidden".\n` +
    `\n` +
    `Constraints:\n` +
    `- Use the read and edit tools to make targeted changes — do NOT rewrite entire files.\n` +
    `- Keep index.html, styles.css, app.js as the only files.\n` +
    `\n` +
    `VERIFY (Perfect phase): browser_navigate to "${URL}", then browser_snapshot, and confirm:\n` +
    `  - the "Toggle Theme" button is present in the header\n` +
    `  - the modal element with id "modal" exists in the DOM (it may be hidden)\n` +
    `  - the "Contact" section heading is still present\n` +
    `End with "VERDICT: PASS" only if all are present.`;
  const r2 = await session.run(editTask);
  unsub2();

  // ---- report ----
  console.log("\n===== SUMMARY =====");
  console.log("BUILD: success=", r1.success, "iters=", r1.iterations, "cost $", r1.usage.cost.total.toFixed(4));
  console.log("EDIT : success=", r2.success, "iters=", r2.iterations, "cost $", r2.usage.cost.total.toFixed(4));

  for (const f of ["index.html", "styles.css", "app.js"]) {
    try {
      const c = await fs.readFile(path.join(OUT, f), "utf8");
      console.log(`\n// ${f} (${c.length} bytes)`);
      console.log(c.length > 700 ? c.slice(0, 700) + "\n…(truncated)" : c);
    } catch { console.log(`\n// ${f} MISSING`); }
  }
  // independent checks
  const html = await fs.readFile(path.join(OUT, "index.html"), "utf8").catch(() => "");
  const css = await fs.readFile(path.join(OUT, "styles.css"), "utf8").catch(() => "");
  const js = await fs.readFile(path.join(OUT, "app.js"), "utf8").catch(() => "");
  const projectCount = (html.match(/class=["']project["']/g) || []).length;
  console.log("\nindependent checks:", JSON.stringify({
    threeFiles: (await fs.readdir(OUT)).filter((f) => /\.(html|css|js)$/.test(f)).length >= 3,
    linksCss: /<link[^>]+styles\.css/.test(html),
    linksJs: /<script[^>]+app\.js/.test(html),
    hasHeaderName: /Ada Lovelace/.test(html),
    hasAbout: /id=["']about["']/.test(html),
    hasProjects: /id=["']projects["']/.test(html),
    hasContact: /id=["']contact["']/.test(html),
    hasFilterBtn: /id=["']filter-btn/.test(html),
    projectCount,
    hasEmailLink: /id=["']email-link/.test(html),
    hasGithubLink: /id=["']github-link/.test(html),
    hasThemeToggle: /id=["']theme-toggle/.test(html),
    hasDarkModeCss: /\.dark-mode/.test(css),
    hasModal: /id=["']modal["']/.test(html) && /class=["'][^"']*modal[^"']*["']/.test(html),
    themeToggleJs: /theme-toggle/.test(js) && /localStorage/.test(js) && /dark-mode/.test(js),
    modalJs: /modal/.test(js) && /project-title/.test(js) && /classList/.test(js),
  }, null, 2));

  transcriptUnsub();
  await harness.dispose();
  server.close();
  console.log("\ntranscript saved:", TRANSCRIPT);
  console.log("server stopped. done.");
}

main().catch((e) => { console.error("E2E ERROR:", e); process.exit(1); });
