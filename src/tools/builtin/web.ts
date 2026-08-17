/**
 * Internal tool provider: web.
 *
 * Registered like an MCP server — a PROVIDER exposing two tools, because looking
 * something up on the internet is two distinct acts:
 *
 *   web_search   find pages: "what changed in X 4.2", "is this a known bug"
 *   web_fetch    read one page: the changelog, the migration guide, the issue
 *
 * The pair matters. A model's training data goes stale, so for current docs, a
 * release note, or a GitHub issue about a bug, search locates the page and fetch
 * reads it. Search alone returns links; the answer is usually IN the page.
 *
 * BOTH TOOLS DRIVE THE PLAYWRIGHT MCP — they own no HTTP client and no search API
 * key. `web_search` navigates a real browser to a search engine and scrapes the
 * results; `web_fetch` navigates to a URL and extracts the rendered text. That has
 * three consequences worth knowing:
 *
 *   - There is nothing to pay for and no key to configure beyond the browser MCP.
 *   - Client-rendered pages work, unlike a raw HTTP GET: the page has executed by
 *     the time the text is read.
 *   - With no browser MCP connected these tools cannot work at all, and say so
 *     plainly rather than degrading into something that looks like a result.
 *
 * The Playwright tools are resolved from the registry at call time (the same way
 * `activity_inspect` does), so a browser MCP that connects mid-run is picked up
 * without restarting anything.
 */
import type { AgentTool, ToolContext } from "../../types.js";
import type { Registry } from "../../registry/registry.js";

/** One search hit. */
export interface WebSearchHit {
  url: string;
  title?: string;
  /** Result snippet from the search page, when there is one. */
  snippet?: string;
}

export interface WebSearchResult {
  query: string;
  /** The URL actually searched, so a failed scrape can be reproduced by hand. */
  searchUrl: string;
  hits: WebSearchHit[];
}

export interface WebFetchResult {
  url: string;
  /** The URL actually read, after redirects. */
  finalUrl: string;
  title?: string;
  /** Rendered page text, truncated to `maxChars`. */
  text: string;
  truncated: boolean;
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 30_000;

/**
 * Playwright MCP tool names, in preference order. Both the bare names and the
 * `mcp__<server>__` prefixed forms appear depending on how the host registers the
 * server, and a loose suffix match below catches any other prefixing scheme.
 */
const NAVIGATE_TOOLS = ["browser_navigate", "mcp__playwright__browser_navigate", "playwright_navigate"];
const EVALUATE_TOOLS = ["browser_evaluate", "mcp__playwright__browser_evaluate", "playwright_evaluate"];
const SNAPSHOT_TOOLS = ["browser_snapshot", "mcp__playwright__browser_snapshot", "playwright_snapshot"];

/** Find a browser tool by exact name, then by suffix (any MCP prefixing scheme). */
export function findBrowserTool(registry: Registry | undefined, candidates: string[]): AgentTool | undefined {
  if (!registry) return undefined;
  for (const name of candidates) {
    const tool = registry.getTool(name);
    if (tool) return tool;
  }
  const bare = candidates[0]!;
  return registry.allTools().find((t) => t.name.toLowerCase().endsWith(bare));
}

export interface WebConfig {
  /** Default number of results per search. */
  maxResults?: number;
  /** Cap on characters returned by `web_fetch` (default 30k). */
  maxFetchChars?: number;
  /**
   * Search URL template; `{query}` is replaced with the URL-encoded query.
   * Defaults to DuckDuckGo's HTML endpoint, which renders results server-side and
   * is the least hostile to automation. Point it at an internal search if you have
   * one — the result scraper falls back to link extraction for unknown layouts.
   */
  searchUrlTemplate?: string;
}

const DEFAULT_SEARCH_URL = "https://duckduckgo.com/html/?q={query}";

/**
 * Scrape result links out of the page, in the browser.
 *
 * Runs DuckDuckGo's markup first, then falls back to "every off-site link with
 * visible text" so an unfamiliar engine still yields something usable. Kept as a
 * string because it is shipped to `browser_evaluate` as a function source.
 */
const EXTRACT_RESULTS_FN = `() => {
  const clean = (u) => {
    try {
      const parsed = new URL(u, location.href);
      // DuckDuckGo wraps results in a redirect: /l/?uddg=<encoded target>.
      const wrapped = parsed.searchParams.get("uddg");
      return wrapped ? decodeURIComponent(wrapped) : parsed.href;
    } catch { return null; }
  };
  const out = [];
  const seen = new Set();
  const push = (url, title, snippet) => {
    const href = clean(url);
    if (!href || !/^https?:/.test(href)) return;
    if (/duckduckgo\\.com|google\\.[a-z.]+\\/(search|url)|bing\\.com\\/search/.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ url: href, title: (title || "").trim(), snippet: (snippet || "").trim().slice(0, 400) });
  };
  for (const el of document.querySelectorAll(".result, .web-result, [data-testid='result']")) {
    const a = el.querySelector("a.result__a, a[data-testid='result-title-a'], h2 a, a");
    const s = el.querySelector(".result__snippet, [data-testid='result-snippet'], p");
    if (a && a.href) push(a.href, a.textContent, s ? s.textContent : "");
  }
  if (out.length === 0) {
    for (const a of document.querySelectorAll("a[href]")) {
      const text = (a.textContent || "").trim();
      if (text.length > 15) push(a.href, text, "");
      if (out.length >= 30) break;
    }
  }
  return JSON.stringify(out);
}`;

/** Extract the page's rendered text and title, in the browser. */
const EXTRACT_TEXT_FN = `() => JSON.stringify({
  title: document.title || "",
  url: location.href,
  text: (document.body && document.body.innerText) || "",
})`;

/**
 * Pull the JSON payload out of an MCP tool result.
 *
 * `browser_evaluate` wraps the return value in prose that varies by server
 * version ("### Result", code fences, bare value), so the payload is located
 * rather than assumed to be the whole output.
 */
export function extractJsonPayload(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], output];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    // The value may itself be a JSON *string* containing JSON (evaluate returns a
    // string; some servers re-encode it), so unwrap one level when that happens.
    for (const attempt of [trimmed, sliceOutermost(trimmed, "[", "]"), sliceOutermost(trimmed, "{", "}")]) {
      if (!attempt) continue;
      try {
        const parsed = JSON.parse(attempt);
        return typeof parsed === "string" ? safeParse(parsed) ?? parsed : parsed;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sliceOutermost(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

/** The message shown when no browser MCP is connected — the only hard dependency. */
function noBrowserResult(tool: string, registry: Registry | undefined) {
  return {
    output: [
      `**${tool} needs a browser MCP and none is connected.**`,
      "",
      "These tools drive Playwright rather than making HTTP requests themselves, so a browser MCP",
      "(e.g. `npx @playwright/mcp@latest`) has to be attached to this session.",
      "",
      "Do NOT substitute bash/curl for it: what comes back is unrendered markup, and for most docs",
      "sites that means no content at all.",
    ].join("\n"),
    isError: true as const,
    registry,
  };
}

/** Navigate the browser, returning an error string on failure. */
async function navigate(
  navTool: AgentTool,
  url: string,
  ctx: ToolContext,
): Promise<string | undefined> {
  const res = await navTool.execute(`web-nav-${Date.now()}`, { url }, ctx);
  return res.isError ? (res.output ?? `navigation to ${url} failed`) : undefined;
}

export function createWebTools(config: WebConfig = {}): AgentTool[] {
  const maxFetchChars = config.maxFetchChars ?? DEFAULT_MAX_CHARS;
  const searchTemplate = config.searchUrlTemplate ?? DEFAULT_SEARCH_URL;

  const search: AgentTool<any, WebSearchResult> = {
    name: "web_search",
    title: "Search the web",
    description:
      "Search the internet in a real browser and return the result links. Use it whenever the answer " +
      "depends on something current rather than remembered: how a library's API works in the version " +
      "this project pins, what changed in a release, whether an error message is a known bug, migration " +
      "guides, CVEs, or a library's GitHub issues when the docs are silent. Also the way to FIND the pages " +
      "or feeds a scraping/automation task should target. Returns titles, URLs and snippets — follow up " +
      "with `web_fetch` to read the best one. Requires a browser MCP (Playwright).",
    mutates: false,
    // Every phase: checking how a current API actually behaves belongs in
    // Prepare/Plan, not only once something has broken.
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    complexityHint: 0.3,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, as you would type it into a search engine. Include version numbers, " +
            "library names and exact error strings — they sharpen the results a lot.",
        },
        maxResults: { type: "number", description: `How many hits to return (default ${DEFAULT_MAX_RESULTS}).` },
        site: {
          type: "string",
          description: "Restrict to one domain, e.g. \"github.com\" or \"react.dev\" (adds a site: filter).",
        },
      },
      required: ["query"],
    },
    async execute(_id, args, ctx) {
      const registry = ctx.registry as Registry | undefined;
      const navTool = findBrowserTool(registry, NAVIGATE_TOOLS);
      const evalTool = findBrowserTool(registry, EVALUATE_TOOLS);
      if (!navTool || !evalTool) {
        const { output, isError } = noBrowserResult("web_search", registry);
        return { output, isError, details: { query: "", searchUrl: "", hits: [] } };
      }

      const query = String(args.query ?? "").trim();
      if (!query) {
        return {
          output: "web_search: missing required argument 'query'. Say what to search for and retry.",
          isError: true,
          details: { query: "", searchUrl: "", hits: [] },
        };
      }
      const site = args.site ? String(args.site).trim() : "";
      const maxResults = Math.max(1, Math.min(20, Number(args.maxResults) || config.maxResults || DEFAULT_MAX_RESULTS));
      const full = site ? `${query} site:${site}` : query;
      const searchUrl = searchTemplate.replace("{query}", encodeURIComponent(full));

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:web_search"],
        message: `search ${JSON.stringify(full)} (max ${maxResults})`,
      });

      const navError = await navigate(navTool, searchUrl, ctx);
      if (navError) {
        return {
          output: `web_search: could not open the search page (${searchUrl}).\n${navError}`,
          isError: true,
          details: { query: full, searchUrl, hits: [] },
        };
      }

      const evaluated = await evalTool.execute(`web-search-${Date.now()}`, { function: EXTRACT_RESULTS_FN }, ctx);
      if (evaluated.isError) {
        return {
          output: `web_search: the browser could not read the results page.\n${evaluated.output ?? ""}`,
          isError: true,
          details: { query: full, searchUrl, hits: [] },
        };
      }

      const parsed = extractJsonPayload(evaluated.output ?? "");
      const hits: WebSearchHit[] = (Array.isArray(parsed) ? parsed : [])
        .filter((h: any) => h && typeof h.url === "string")
        .slice(0, maxResults)
        .map((h: any) => ({
          url: h.url,
          ...(h.title ? { title: String(h.title) } : {}),
          ...(h.snippet ? { snippet: String(h.snippet) } : {}),
        }));

      if (!hits.length) {
        return {
          output:
            `web_search: no results scraped from ${searchUrl}. The engine may have served a consent page or ` +
            "a bot check. Try different wording, or `web_fetch` a documentation URL directly.",
          details: { query: full, searchUrl, hits: [] },
        };
      }

      return {
        output: [
          `${hits.length} result(s) for ${JSON.stringify(full)}:`,
          "",
          ...hits.map((h, i) =>
            [`${i + 1}. ${h.title || h.url}`, `   ${h.url}`, ...(h.snippet ? [`   ${h.snippet}`] : [])].join("\n"),
          ),
          "",
          "Use `web_fetch` on the most promising URL to read it in full.",
        ].join("\n"),
        details: { query: full, searchUrl, hits },
      };
    },
  };

  const fetchTool: AgentTool<any, WebFetchResult> = {
    name: "web_fetch",
    title: "Read a web page",
    description:
      "Open one URL in the browser and return its rendered text. Use it to actually READ a page a search " +
      "turned up — a changelog, a migration guide, an API reference, a GitHub issue — or to pull content " +
      "off a page you are scraping or a UI you are recreating. Because it renders the page, client-side " +
      "apps and docs sites work. For a handful of pages this is enough; for many pages, pagination or " +
      "anything repeatable, write a scraping script instead of calling this in a loop. Requires a browser " +
      "MCP (Playwright).",
    mutates: false,
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    complexityHint: 0.2,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to read (http/https)." },
        maxChars: {
          type: "number",
          description: `Truncate the text at this many characters (default ${maxFetchChars}).`,
        },
      },
      required: ["url"],
    },
    async execute(_id, args, ctx) {
      const registry = ctx.registry as Registry | undefined;
      const navTool = findBrowserTool(registry, NAVIGATE_TOOLS);
      const evalTool = findBrowserTool(registry, EVALUATE_TOOLS);
      const snapshotTool = findBrowserTool(registry, SNAPSHOT_TOOLS);
      if (!navTool || !(evalTool || snapshotTool)) {
        const { output, isError } = noBrowserResult("web_fetch", registry);
        return { output, isError, details: { url: "", finalUrl: "", text: "", truncated: false } };
      }

      const raw = String(args.url ?? "").trim();
      if (!raw) {
        return {
          output: "web_fetch: missing required argument 'url'.",
          isError: true,
          details: { url: "", finalUrl: "", text: "", truncated: false },
        };
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(raw);
      } catch {
        return {
          output: `web_fetch: '${raw}' is not a valid URL. Pass an absolute http(s) URL.`,
          isError: true,
          details: { url: raw, finalUrl: "", text: "", truncated: false },
        };
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          output: `web_fetch: unsupported protocol '${parsedUrl.protocol}'. Only http and https are opened; use \`read\` for local files.`,
          isError: true,
          details: { url: raw, finalUrl: "", text: "", truncated: false },
        };
      }

      const limit = Math.max(500, Number(args.maxChars) || maxFetchChars);
      const target = parsedUrl.toString();

      ctx.log({
        timestamp: Date.now(),
        level: "info",
        tags: ["tool:web_fetch"],
        message: `fetch ${target}`,
      });

      const navError = await navigate(navTool, target, ctx);
      if (navError) {
        return {
          output: `web_fetch: could not open ${target}.\n${navError}`,
          isError: true,
          details: { url: raw, finalUrl: target, text: "", truncated: false },
        };
      }

      let title: string | undefined;
      let finalUrl = target;
      let text = "";

      if (evalTool) {
        const evaluated = await evalTool.execute(`web-fetch-${Date.now()}`, { function: EXTRACT_TEXT_FN }, ctx);
        const payload = evaluated.isError ? undefined : (extractJsonPayload(evaluated.output ?? "") as any);
        if (payload && typeof payload.text === "string") {
          text = payload.text;
          if (payload.title) title = String(payload.title);
          if (payload.url) finalUrl = String(payload.url);
        }
      }
      // Snapshot is the fallback: it returns the accessibility tree, which is
      // wordier than innerText but still readable, and it is all a server without
      // browser_evaluate can offer.
      if (!text.trim() && snapshotTool) {
        const snap = await snapshotTool.execute(`web-fetch-snap-${Date.now()}`, {}, ctx);
        if (!snap.isError) text = snap.output ?? "";
      }

      if (!text.trim()) {
        return {
          output:
            `web_fetch: ${target} opened but produced no readable text. The page may still be loading, ` +
            "behind a consent dialog, or blocked. Try again, or read the project's repository instead.",
          details: { url: raw, finalUrl, text: "", truncated: false },
        };
      }

      const truncated = text.length > limit;
      if (truncated) text = text.slice(0, limit);

      return {
        output: [
          `${title ? `${title}\n` : ""}${finalUrl}${truncated ? ` (truncated at ${limit} chars)` : ""}`,
          "",
          text,
        ].join("\n"),
        details: { url: raw, finalUrl, ...(title ? { title } : {}), text, truncated },
      };
    },
  };

  // `web_scrape` is an alias of `web_fetch`: the spec names a "web_scrap"
  // capability and some hosts/models reach for that name. It shares `web_fetch`'s
  // engine and result verbatim, so either name resolves and there is nothing to
  // keep in sync. Kept as a thin delegate rather than a second implementation.
  const scrapeTool: AgentTool<any, WebFetchResult> = {
    name: "web_scrape",
    title: "Extract data from a page",
    description:
      "Open one URL in the browser and return its rendered text — an alias of `web_fetch` for the scraping/" +
      "content-extraction case (recreating a UI, pulling a table, reading a docs page). Same engine and result " +
      "as `web_fetch`; the two names exist so whichever the model or host uses resolves. Requires a browser MCP (Playwright).",
    mutates: false,
    categorizers: ["conversation", "read", "write_edit", "activity_inspect"],
    complexityHint: 0.2,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to scrape (http/https)." },
        maxChars: {
          type: "number",
          description: `Truncate the text at this many characters (default ${maxFetchChars}).`,
        },
      },
      required: ["url"],
    },
    async execute(_id, args, ctx) {
      return fetchTool.execute(_id, args, ctx);
    },
  };

  return [search, fetchTool, scrapeTool];
}
