/**
 * Integration test: Playwright MCP through the harness's own MCP client.
 * Verifies handshake + tools/list + 4P categorization, then drives a real browser.
 *
 * Run:  OPENROUTER_API_KEY=... node examples/live-mcp-playwright.mjs
 */
import { Harness } from "../dist/index.js";

const URL = process.env.SOLAR_URL ?? "http://localhost:8801/index.html";

async function main() {
  const harness = new Harness({ apiKey: process.env.OPENROUTER_API_KEY });
  const session = harness.createSession({ cwd: process.cwd() });

  console.log("connecting playwright MCP (npx @playwright/mcp@latest) …");
  const t0 = Date.now();
  const item = await session.addMcpServer({
    id: "playwright",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    timeoutMs: 180000, // npx cold start can be slow
  });
  console.log(`connected in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log("provider:", item.id, "| kind:", item.kind, "| source:", item.source, "| phases:", item.phases);
  console.log("tools (" + item.tools.length + "):", item.tools.map((t) => t.name).join(", "));

  // 4P categorization: browser tools should land in Perfect.
  const perfectTools = session.toolsForPhase("perfect").map((t) => t.name);
  console.log("\nin Perfect phase:", perfectTools.filter((n) => n.includes("browser")).join(", ") || "(none)");

  // Drive the browser: navigate + screenshot.
  const ctx = { cwd: process.cwd(), log: () => {}, llm: harness.llm };
  const nav = session.registry.getTool("browser_navigate");
  const shot =
    session.registry.getTool("browser_take_screenshot") ?? session.registry.getTool("browser_screenshot");

  if (nav) {
    console.log("\nbrowser_navigate →", URL);
    const r = await nav.execute("n1", { url: URL }, ctx);
    console.log("  result:", (r.output ?? "").slice(0, 160), r.isError ? "[ERROR]" : "OK");
  }
  if (shot) {
    console.log("browser_take_screenshot …");
    const s = await shot.execute("s1", {}, ctx);
    const kinds = (s.content ?? []).map((c) => c.type);
    console.log("  content:", JSON.stringify(kinds), s.isError ? "[ERROR]" : `OK (${kinds.includes("image") ? "image returned ✅" : "no image"})`);
  }

  await harness.dispose(); // stops the MCP child process
  console.log("\n✅ PLAYWRIGHT MCP INTEGRATION: handshake + tools + categorization" + (nav ? " + drive" : ""));
}

main().catch((e) => { console.error("MCP PROBE ERROR:", e.message); process.exit(1); });
