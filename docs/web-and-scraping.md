# The web: research, scraping, automation, UI capture

Two tools do all of this — `web_search` (find the page) and `web_fetch` (read it),
both driving the Playwright MCP so pages actually render. What varies is the *job*,
and the guidance for each job lives in one shared prompt block,
`WEB_AND_SCRAPING` in [`src/phases/prompts.ts`](../src/phases/prompts.ts),
interpolated into the loop prompt and PERFORM so the two paths cannot drift.

Like [the file-search ladder](./file-search.md), it is written as a **default with
reasons**, not a rule list: it says why each ordering is usually cheaper and
leaves the model free to depart from it with a stated reason.

## Job 1 — the code is not working

A stuck build is usually a *version fact*, not a thinking problem. The model's
training data has a cutoff; the project's lockfile does not.

1. **Establish the real version first** — `package.json` + lockfile, `go.mod`,
   `requirements.txt`/`uv.lock`, `Gemfile.lock`, `pubspec.lock`. Searching the
   wrong major version is the most common way this goes wrong.
2. **Search the exact error string**, quoted, plus library and version. Verbatim
   error text beats a paraphrase.
3. **Read the primary source**, in descending trustworthiness: official docs for
   *that* version → release notes / CHANGELOG / MIGRATION guide → the library's
   GitHub (issues, then the actual source of the function being called — reading
   the implementation settles arguments docs cannot) → Stack Overflow and blogs
   last, and only to find the primary source they quote.
4. **Suspect a breaking change** whenever something worked before or works
   elsewhere: diff the installed version against the one the example assumes and
   read the changelog entries between them. Renamed exports, moved entry points,
   peer-dependency bumps, ESM/CJS changes, config-schema changes.
5. **The web wins over memory** when they disagree — and the URL gets cited, so
   the next reader can check the claim.

## Job 2 — scraping, extraction, automation

When the user asks for scraped data, a social/web extraction, or an automated
repetitive web task, **that is the job**. The prompt says so explicitly, because
the failure mode otherwise is an agent that hedges or asks permission for work it
was just handed. The guidance is about doing it *well*:

| Concern | The default |
|---|---|
| One-off vs repeated | A handful of pages once → `web_fetch`. Many pages, pagination, a schedule, anything you'd repeat by hand → **write a script** into `scripts/` with one documented command. The script is the deliverable; 40 hand-driven calls can't be re-run tomorrow. |
| Which layer | Cheapest that works: official API/feed (RSS, sitemap, JSON-LD, GraphQL) → **the JSON endpoint the page itself calls** (`__NEXT_DATA__`, `__NUXT__`, embedded JSON — cleaner, paginated, far more stable than the DOM) → HTML parsing (cheerio/BeautifulSoup/lxml) → headless browser only when JS execution, a login, or real interaction is needed. Reaching for the browser first is the usual mistake. |
| Resilience | Stable hooks (`data-*`, ARIA roles, visible text) over `nth-child` chains; exponential backoff; checkpointed progress; **save raw responses before parsing** so a parser bug costs a re-parse, not a re-crawl; incremental and idempotent re-runs. |
| Being a good client | Rate-limit with jitter, cap concurrency, honour `robots.txt` and the site's terms, honest User-Agent, cache locally. A 429 or sudden 403 means slow down, not retry harder. |
| Verification | Report record counts, spot-check two or three against the live page, fail **loudly** on zero rows or schema drift. Silently writing an empty CSV is the worst outcome — it looks like success. |
| Shipping it | The format asked for (CSV/JSONL/SQLite), raw and parsed kept separate, data directory `.gitignore`d, tokens/cookies in env vars. The summary says what was collected, from where, and the re-run command. |

**Where it stops and asks.** A login wall, paywall, or CAPTCHA is a cue to involve
the user — request API access, a token they set in the environment themselves, or
a data export. The agent does not try to defeat bot checks and never types
someone's credentials. It collects the fields the task needs rather than hoovering
every piece of personal data on the page. These are the boundaries of *this*
guidance, not a general refusal to scrape.

## Job 3 — capturing a UI to recreate it

For "make it look like `<site>`":

- **Look properly first**: `web_fetch` for structure and copy, then browser
  screenshots at mobile and desktop widths, handed to `media_analysis` when it is
  available. Where exact values matter, read the **computed styles** in the page
  rather than eyeballing a screenshot.
- **Extract the system, not the markup**: palette, type scale, spacing rhythm,
  radii, shadows, borders, breakpoints, and the interactive states
  (hover/focus/disabled/loading/empty). Capture those as tokens, then rebuild in
  *this* project's stack. Pasting a competitor's DOM yields something
  unmaintainable that matches at exactly one viewport width.
- **Don't lift protected assets** — logos, brand marks, licensed fonts, stock
  photography. Placeholders of the right dimensions, plus a note in the summary
  saying which assets the user must supply or license. Match the layout and the
  feel; own the content.

## No browser MCP, no web tools

Both tools drive Playwright and own no HTTP client. With no browser MCP attached
they fail with a clear message, and `ToolFallbackAdvisor` escalates that to the
user rather than inventing a shell substitute — `curl` returns unrendered markup,
which for most modern sites means no content at all. That omission is
[deliberate](./loop.md#when-a-tool-keeps-failing-bash--the-user--honest-stop).
