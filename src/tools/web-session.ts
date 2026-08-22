/**
 * The harness's own browser session — `drive` without an MCP in sight.
 *
 * `drive` used to be a façade over the Playwright MCP server's `browser_*`
 * tools, which chained three problems together: the MCP had to be *enabled in
 * settings* to exist at all, the registry's name heuristics then scoped its
 * ~24 tools into the QA hops of EVERY project (a Flutter/iOS run opening with
 * 62 tools, two-thirds of them unable to touch the target), and the model read
 * the inventory as "my automation is browser-based" and nearly declined to
 * verify. The `mobile` tool never had any of this because it talks to
 * simctl/adb directly. This module gives the web side the same independence:
 * `playwright-core` (lazy, optional — no browsers bundled, launches the system
 * Chrome) driven straight from the tool.
 *
 * Zero-hard-dependency contract preserved: `playwright-core` is imported
 * lazily and its absence only means `drive` falls back to the legacy MCP
 * façade. A CDP endpoint (a debugger already running) can be pinned with
 * `TURING_BROWSER_CDP` to reuse the user's own browser instead of launching
 * one.
 */

/** The page-level surface `drive` needs. `playwright-core` types are structural
 * enough that this interface accepts a real `Page` without importing the
 * library's types at compile time — the same seam mobilecli uses for its CLI. */
export interface WebPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void>;
  getByRole(role: string, opts?: { name?: string; exact?: boolean }): {
    first(): { click(opts?: { timeout?: number }): Promise<void>; fill(text: string, opts?: { timeout?: number }): Promise<void>; selectOption(v: { label: string } | { value: string }, opts?: { timeout?: number }): Promise<string[]> };
  };
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
  accessibility: {
    snapshot(): Promise<WebAxNode | null>;
  };
  content(): Promise<string>;
  url(): string;
  /** In-page evaluation — the geometry channel for unlabeled controls. */
  evaluate?<T = unknown>(fn: () => T, ...args: unknown[]): Promise<T>;
  /** Raw coordinate input — clicks on elements the AX tree cannot name. */
  mouse?: { click(x: number, y: number): Promise<void> };
}

/** One node of the accessibility tree (the subset `drive` consumes). */
export interface WebAxNode {
  role: string;
  name?: string;
  value?: unknown;
  checked?: string | boolean;
  children?: WebAxNode[];
}

export interface WebSession {
  page: WebPage;
  close(): Promise<void>;
}

/** Test seam + host override: replace the session factory entirely. */
let sessionOverride: (() => Promise<WebSession | undefined>) | undefined;

export function setWebSessionOverride(impl: (() => Promise<WebSession | undefined>) | undefined): void {
  sessionOverride = impl;
  cached = undefined;
}

let cached: WebSession | undefined;

/** Launch/reuse the singleton browser session; undefined when impossible. */
export async function webSession(): Promise<WebSession | undefined> {
  if (sessionOverride) {
    cached = (await sessionOverride()) ?? undefined;
    return cached;
  }
  if (cached) return cached;
  try {
    const { chromium } = await import("playwright-core");
    const cdp = process.env.TURING_BROWSER_CDP?.trim();
    const browser = cdp
      ? await chromium.connectOverCDP(cdp)
      : await launchSystemChrome(chromium);
    if (!browser) return undefined;
    const context = await (browser as { newContext: (o?: unknown) => Promise<{ newPage: () => Promise<WebPage> }> }).newContext({
      viewport: { width: 1280, height: 800 },
    });
    cached = {
      page: await context.newPage(),
      close: async () => {
        try {
          await (browser as { close: () => Promise<void> }).close();
        } catch {
          // best-effort
        }
        cached = undefined;
      },
    };
    return cached;
  } catch {
    return undefined;
  }
}

/**
 * System Chrome first (present on most dev machines, zero download), bundled
 * chromium second. `playwright-core` ships no browsers, so the bundled path
 * only works where `playwright install` has run.
 */
async function launchSystemChrome(chromium: {
  launch(o: Record<string, unknown>): Promise<unknown>;
}): Promise<unknown | undefined> {
  const headless = { headless: true };
  try {
    return await chromium.launch({ ...headless, channel: "chrome" });
  } catch {
    // fall through
  }
  try {
    return await chromium.launch(headless);
  } catch {
    return undefined;
  }
}

/** Can `drive` run self-contained right now? (library importable or override set) */
export async function webSessionAvailable(): Promise<boolean> {
  if (sessionOverride) return true;
  try {
    await import("playwright-core");
    return true;
  } catch {
    return false;
  }
}

/** Close the singleton, if any. Run-end cleanup calls this. */
export async function closeWebSession(): Promise<void> {
  const s = cached;
  cached = undefined;
  await s?.close();
}

// ---------------------------------------------------------------------------
// Accessibility tree → SnapElement-shaped records
// ---------------------------------------------------------------------------

export interface WebElement {
  /** Our own stable-per-snapshot handle, `e1`, `e2`, … (the `ref=eN` form). */
  ref: string;
  role: string;
  name: string;
}

/** Flatten the AX tree into a numbered element list (depth-first). */
export function flattenAxTree(root: WebAxNode | null): WebElement[] {
  const out: WebElement[] = [];
  let n = 0;
  const walk = (node: WebAxNode | undefined) => {
    if (!node) return;
    const name = typeof node.name === "string" ? node.name : "";
    if (name && node.role && node.role !== "StaticText" && node.role !== "generic") {
      out.push({ ref: `e${++n}`, role: node.role, name });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root ?? undefined);
  return out;
}
