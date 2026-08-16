/**
 * Tests for the `web` provider: `web_search` (find current pages) and
 * `web_fetch` (read one).
 *
 * Both drive the Playwright MCP — they own no HTTP client and no search API key.
 * So these tests stub the browser tools in a registry and assert on what gets
 * driven: the URL navigated to, the function evaluated, and how the returned
 * payload is parsed back into hits/text.
 *
 * All offline — nothing here opens a browser or touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOOP_SYSTEM_PROMPT,
  LogStore,
  Registry,
  createWebTools,
  extractJsonPayload,
  findBrowserTool,
  registerBuiltins,
} from "../dist/index.js";

/**
 * A registry holding fake Playwright MCP tools. `evaluate` is handed the page
 * function and returns whatever the test wants the browser to have produced.
 */
function browserRegistry({ evaluate, navigate, snapshot, names = {} } = {}) {
  const calls = { navigate: [], evaluate: [], snapshot: [] };
  const reg = new Registry();
  const tools = [];
  tools.push({
    name: names.navigate ?? "browser_navigate",
    description: "Navigate to a URL",
    mutates: false,
    phases: ["prepare", "plan", "perform", "perfect"],
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(_id, args) {
      calls.navigate.push(args.url);
      return navigate ? navigate(args) : { output: `Navigated to ${args.url}` };
    },
  });
  if (evaluate !== null) {
    tools.push({
      name: names.evaluate ?? "browser_evaluate",
      description: "Evaluate JS on the page",
      mutates: false,
      phases: ["prepare", "plan", "perform", "perfect"],
      parameters: { type: "object", properties: { function: { type: "string" } }, required: ["function"] },
      async execute(_id, args) {
        calls.evaluate.push(args.function);
        return evaluate ? evaluate(args) : { output: "### Result\n[]" };
      },
    });
  }
  if (snapshot) {
    tools.push({
      name: names.snapshot ?? "browser_snapshot",
      description: "Accessibility snapshot",
      mutates: false,
      phases: ["prepare", "plan", "perform", "perfect"],
      parameters: { type: "object", properties: {} },
      async execute(_id, args) {
        calls.snapshot.push(args);
        return snapshot(args);
      },
    });
  }
  reg.add({ id: "mcp:playwright", kind: "mcp", source: "external", name: "playwright", tools });
  return { reg, calls };
}

const tools = (config) => new Map(createWebTools(config).map((t) => [t.name, t]));
const ctxFor = (reg) => ({ cwd: process.cwd(), registry: reg, log: () => {} });

/** What the in-page scraper would return for a normal results page. */
function resultsPayload(hits) {
  return { output: "### Result\n```json\n" + JSON.stringify(JSON.stringify(hits)) + "\n```" };
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

test("web_search navigates a browser to the search engine and returns scraped hits", async () => {
  const { reg, calls } = browserRegistry({
    evaluate: () =>
      resultsPayload([
        { url: "https://vite.dev/changelog", title: "Vite 7 changelog", snippet: "Dropped Node 18" },
        { url: "https://github.com/vitejs/vite/issues/42", title: "Bug: build hangs", snippet: "" },
      ]),
  });

  const res = await tools().get("web_search").execute("c1", { query: "vite 7 changelog" }, ctxFor(reg));

  assert.equal(res.isError ?? false, false);
  // It drives the browser rather than making its own request.
  assert.equal(calls.navigate.length, 1);
  assert.match(calls.navigate[0], /^https:\/\/duckduckgo\.com\/html\/\?q=vite%207%20changelog$/);
  assert.match(calls.evaluate[0], /querySelectorAll/, "results are scraped in the page");

  assert.equal(res.details.hits.length, 2);
  assert.equal(res.details.hits[0].url, "https://vite.dev/changelog");
  assert.match(res.output, /Vite 7 changelog/);
  assert.match(res.output, /Dropped Node 18/);
  assert.match(res.output, /web_fetch/, "the output points at the follow-up step");
});

test("web_search adds a site: filter and clamps maxResults", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.dev/${i}`, title: `t${i}` }));
  const { reg, calls } = browserRegistry({ evaluate: () => resultsPayload(many) });

  const res = await tools().get("web_search").execute(
    "c1",
    { query: "build hangs", site: "github.com", maxResults: 999 },
    ctxFor(reg),
  );

  assert.match(decodeURIComponent(calls.navigate[0]), /build hangs site:github\.com/);
  assert.equal(res.details.hits.length, 20, "maxResults is clamped to 20");
});

test("web_search says the engine returned nothing rather than inventing hits", async () => {
  const { reg } = browserRegistry({ evaluate: () => resultsPayload([]) });
  const res = await tools().get("web_search").execute("c1", { query: "asdkjhasd" }, ctxFor(reg));
  assert.equal(res.isError ?? false, false);
  assert.match(res.output, /no results scraped/);
  assert.match(res.output, /consent page or a bot check/);
  assert.deepEqual(res.details.hits, []);
});

test("web_search reports a navigation failure instead of returning empty", async () => {
  const { reg } = browserRegistry({ navigate: () => ({ output: "net::ERR_NAME_NOT_RESOLVED", isError: true }) });
  const res = await tools().get("web_search").execute("c1", { query: "x" }, ctxFor(reg));
  assert.equal(res.isError, true);
  assert.match(res.output, /could not open the search page/);
  assert.match(res.output, /ERR_NAME_NOT_RESOLVED/);
});

test("web_search refuses clearly when no browser MCP is connected", async () => {
  const empty = new Registry();
  const res = await tools().get("web_search").execute("c1", { query: "x" }, ctxFor(empty));
  assert.equal(res.isError, true);
  assert.match(res.output, /needs a browser MCP and none is connected/);
  assert.match(res.output, /@playwright\/mcp/);
  // The wrong turn a model would otherwise take.
  assert.match(res.output, /Do NOT substitute bash\/curl/);
});

test("web_search validates its query", async () => {
  const { reg } = browserRegistry();
  const res = await tools().get("web_search").execute("c1", {}, ctxFor(reg));
  assert.equal(res.isError, true);
  assert.match(res.output, /missing required argument 'query'/);
});

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

test("web_fetch opens the URL and returns the rendered text", async () => {
  const page = { title: "Vite 7 Changelog", url: "https://vite.dev/changelog#v7", text: "7.0.0\nDropped Node 18." };
  const { reg, calls } = browserRegistry({ evaluate: () => ({ output: JSON.stringify(JSON.stringify(page)) }) });

  const res = await tools().get("web_fetch").execute("c1", { url: "https://vite.dev/changelog" }, ctxFor(reg));

  assert.equal(res.isError ?? false, false);
  assert.equal(calls.navigate[0], "https://vite.dev/changelog");
  assert.match(calls.evaluate[0], /innerText/, "the rendered text is what gets read");
  assert.equal(res.details.title, "Vite 7 Changelog");
  assert.equal(res.details.finalUrl, "https://vite.dev/changelog#v7", "redirects/anchors are reported");
  assert.match(res.details.text, /Dropped Node 18/);
  assert.equal(res.details.truncated, false);
});

test("web_fetch truncates long pages and says so", async () => {
  const page = { title: "T", url: "https://example.com/long", text: "word ".repeat(5000) };
  const { reg } = browserRegistry({ evaluate: () => ({ output: JSON.stringify(JSON.stringify(page)) }) });

  const res = await tools().get("web_fetch").execute(
    "c1", { url: "https://example.com/long", maxChars: 500 }, ctxFor(reg),
  );
  assert.equal(res.details.truncated, true);
  assert.equal(res.details.text.length, 500);
  assert.match(res.output, /truncated at 500 chars/);
});

test("web_fetch falls back to the accessibility snapshot when evaluate is unavailable", async () => {
  // Some browser MCP servers expose no evaluate; the snapshot is all there is.
  const { reg, calls } = browserRegistry({
    evaluate: null,
    snapshot: () => ({ output: "heading 'Release notes'\ntext '7.0.0 dropped Node 18'" }),
  });

  const res = await tools().get("web_fetch").execute("c1", { url: "https://vite.dev/changelog" }, ctxFor(reg));

  assert.equal(res.isError ?? false, false);
  assert.equal(calls.snapshot.length, 1);
  assert.match(res.details.text, /dropped Node 18/);
});

test("web_fetch explains an empty page rather than returning blank", async () => {
  const { reg } = browserRegistry({
    evaluate: () => ({ output: JSON.stringify(JSON.stringify({ title: "", url: "https://x/", text: "   " })) }),
  });
  const res = await tools().get("web_fetch").execute("c1", { url: "https://x/" }, ctxFor(reg));
  assert.equal(res.isError ?? false, false, "an empty render is not an error to abort on");
  assert.match(res.output, /no readable text/);
  assert.match(res.output, /still be loading, behind a consent dialog, or blocked/);
});

test("web_fetch rejects non-http URLs and points at the right tool", async () => {
  const { reg } = browserRegistry();
  const bad = await tools().get("web_fetch").execute("c1", { url: "file:///etc/passwd" }, ctxFor(reg));
  assert.equal(bad.isError, true);
  assert.match(bad.output, /Only http and https/);
  assert.match(bad.output, /`read`/, "local files belong to the read tool");

  const notUrl = await tools().get("web_fetch").execute("c1", { url: "not a url" }, ctxFor(reg));
  assert.equal(notUrl.isError, true);
  assert.match(notUrl.output, /not a valid URL/);
});

test("web_fetch reports a navigation failure", async () => {
  const { reg } = browserRegistry({ navigate: () => ({ output: "HTTP 403 Forbidden", isError: true }) });
  const res = await tools().get("web_fetch").execute("c1", { url: "https://example.com/x" }, ctxFor(reg));
  assert.equal(res.isError, true);
  assert.match(res.output, /could not open/);
  assert.match(res.output, /403/);
});

// ---------------------------------------------------------------------------
// Browser-tool discovery & payload parsing
// ---------------------------------------------------------------------------

test("browser tools are found under any MCP prefixing scheme", async () => {
  const { reg, calls } = browserRegistry({
    names: { navigate: "mcp__playwright__browser_navigate", evaluate: "mcp__playwright__browser_evaluate" },
    evaluate: () => resultsPayload([{ url: "https://x.dev/a", title: "a" }]),
  });
  assert.ok(findBrowserTool(reg, ["browser_navigate"]), "prefixed names still resolve");

  const res = await tools().get("web_search").execute("c1", { query: "x" }, ctxFor(reg));
  assert.equal(res.details.hits.length, 1);
  assert.equal(calls.navigate.length, 1);
});

test("extractJsonPayload survives the shapes browser_evaluate returns", () => {
  const value = [{ url: "https://a" }];
  // Bare JSON, fenced, prose-wrapped, and double-encoded (a JSON string of JSON).
  assert.deepEqual(extractJsonPayload(JSON.stringify(value)), value);
  assert.deepEqual(extractJsonPayload("```json\n" + JSON.stringify(value) + "\n```"), value);
  assert.deepEqual(extractJsonPayload("### Result\n" + JSON.stringify(value)), value);
  assert.deepEqual(extractJsonPayload(JSON.stringify(JSON.stringify(value))), value);
  assert.equal(extractJsonPayload("not json at all"), undefined);
});

// ---------------------------------------------------------------------------
// Registration & discoverability
// ---------------------------------------------------------------------------

test("the web tools are registered read-only and available in every phase", () => {
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  for (const phase of ["prepare", "plan", "perform", "perfect"]) {
    const names = reg.selectPhaseTools(phase, undefined).map((t) => t.name);
    assert.ok(names.includes("web_search"), `${phase} should expose web_search`);
    assert.ok(names.includes("web_fetch"), `${phase} should expose web_fetch`);
  }
  assert.equal(reg.getTool("web_search").mutates, false);
  assert.equal(reg.getTool("web_fetch").mutates, false);
});

test("the work loop's system prompt teaches when to go to the internet", () => {
  // A tool the model cannot discover may as well not exist — the same failure the
  // activity tools hit, where the model narrated the intent and then ran bash.
  assert.ok(LOOP_SYSTEM_PROMPT.includes("web_search"));
  assert.ok(LOOP_SYSTEM_PROMPT.includes("web_fetch"));
  assert.match(LOOP_SYSTEM_PROMPT, /a stuck build is usually a version fact/);
  assert.match(LOOP_SYSTEM_PROMPT, /NOT a cue to try bash\+curl/);
  // Version first, primary sources over blogs, changelog on a breaking change.
  assert.match(LOOP_SYSTEM_PROMPT, /lockfile/);
  assert.match(LOOP_SYSTEM_PROMPT, /CHANGELOG/);
  assert.match(LOOP_SYSTEM_PROMPT, /the WEB WINS/);
});

test("the work loop's system prompt treats scraping and automation as the job", () => {
  // Scraping/automation is work the user asks for outright; a prompt that hedges
  // here produces an agent that asks permission for its own task.
  assert.match(LOOP_SYSTEM_PROMPT, /it is the JOB, so do it/);
  assert.match(LOOP_SYSTEM_PROMPT, /WRITE A SCRIPT/, "repetitive work becomes a re-runnable script");
  assert.match(LOOP_SYSTEM_PROMPT, /CHEAPEST LAYER THAT WORKS/, "API before DOM before headless browser");
  assert.match(LOOP_SYSTEM_PROMPT, /rate-limit with jitter/);
  assert.match(LOOP_SYSTEM_PROMPT, /fail LOUDLY on zero rows/, "an empty CSV must not read as success");
  // The boundaries: get the user involved rather than defeating a gate, and never
  // handle their credentials.
  assert.match(LOOP_SYSTEM_PROMPT, /Do not try to\n?\s*defeat a bot check/);
  assert.match(LOOP_SYSTEM_PROMPT, /never type someone's credentials yourself/);
});

test("the work loop's system prompt explains capturing a UI to rebuild it", () => {
  assert.match(LOOP_SYSTEM_PROMPT, /CAPTURING A UI TO RECREATE IT/);
  // The analysis half lives in media_analysis; the web block must POINT there
  // rather than teach a second, drifting version of it.
  assert.match(LOOP_SYSTEM_PROMPT, /the analysis belongs to "media_analysis"/);
  assert.match(LOOP_SYSTEM_PROMPT, /lens:"ui" turns it into a rebuild/);
  // What the web tools uniquely contribute: real copy, and exact computed values.
  assert.match(LOOP_SYSTEM_PROMPT, /the STRUCTURE and the COPY/);
  assert.match(LOOP_SYSTEM_PROMPT, /computed styles|COMPUTED styles/);
  assert.match(LOOP_SYSTEM_PROMPT, /trademarked or copyrighted assets/);
  // And the rebuild-from-the-system rule is stated exactly once, in the media block.
  assert.equal(
    LOOP_SYSTEM_PROMPT.split("Extract the SYSTEM, not the markup").length - 1 +
      LOOP_SYSTEM_PROMPT.split("build from the SYSTEM it reports").length - 1,
    1,
    "the replication rule is not duplicated across blocks",
  );
});
