/**
 * Internal tool: `drive` — fused WEB automation (the `mobile` tool's twin).
 *
 * Why this exists: driving a browser through raw Playwright-MCP tools is a
 * multi-call ceremony per step — snapshot, find the ref, click, snapshot again
 * to see what changed, screenshot for evidence. A small model burns turns on
 * the ceremony and the user watches five tool cards for one tap. This tool
 * collapses each STEP into ONE call:
 *
 *   drive { action: "look" }                    → screenshot + every element (refs/names) in ONE result
 *   drive { action: "click", target: "Sign in" }→ resolves the target against the LIVE page, clicks,
 *                                                 returns the post-action screenshot + what changed
 *   drive { action: "fill", target, text }      → same, for inputs
 *   drive { action: "select", target, value }   → same, for dropdowns
 *   drive { action: "open", url }               → navigate + settle
 *   drive { action: "press", key }              → key press
 *   drive { action: "shot" }                    → the FINAL capture, for media_analysis
 *   drive { action: "close" }
 *
 * The intended inspect flow is therefore short and visible:
 *   add_log → build (bash) → drive open → drive look → drive click/fill/… →
 *   drive shot (or activity_inspect) → media_analysis / activity_study → verdict.
 *
 * Resolution is text-first, exactly like a person: `target` is a DESCRIPTION
 * matched against the live accessibility snapshot (exact name → substring), or
 * a verbatim `ref=eN` from a previous look. Ambiguous matches list the
 * candidates instead of guessing; a miss lists the page's interactive elements.
 *
 * TWO BACKENDS, one tool. The primary is the harness's own browser session
 * (see ../web-session.ts — `playwright-core` lazily, system Chrome, no MCP
 * involved, `TURING_BROWSER_CDP` to reuse a running debugger). The legacy
 * fallback is the Playwright-MCP façade this tool originally was, kept so a
 * host with the MCP connected but without `playwright-core` installed keeps
 * working. The action flow below is shared; only the primitives differ.
 */
import type { AgentTool, ToolResult, ToolResultContent } from "../../types.js";
import type { Registry } from "../../registry/registry.js";
import { webSession, webSessionAvailable, type WebPage, type WebElement } from "../web-session.js";

type DriveAction = "open" | "look" | "click" | "fill" | "select" | "press" | "shot" | "close";

const DRIVE_ACTIONS: DriveAction[] = ["open", "look", "click", "fill", "select", "press", "shot", "close"];

const PARAMS = {
  action: { type: "string", enum: DRIVE_ACTIONS, description: "One automation step. `look`/`shot` capture; click/fill/select/press act; open/close manage the session." },
  url: { type: "string", description: "open: the URL to navigate to." },
  target: {
    type: "string",
    description:
      'click/fill/select: WHAT to act on, as a description ("Sign in", "the email input") or a verbatim ref from `look` ("ref=e12"). Resolved against the live page — never guess a selector.',
  },
  text: { type: "string", description: "fill: the text to type into the target." },
  value: { type: "string", description: "select: the option value/label to choose." },
  key: { type: "string", description: "press: the key (Enter, Tab, Escape…)." },
};

/** The snapshot element shape both backends produce (`ref=eN` when known). */
export interface SnapElement {
  ref: string;
  role: string;
  name: string;
  /**
   * Viewport CSS-pixel bounds, present for elements enumerated by GEOMETRY
   * (the in-page scan of name-less controls) and for synthetic coordinate
   * targets. Absent for AX-tree elements, which act by role+name.
   */
  rect?: { x: number; y: number; width: number; height: number };
}

/** A "x,y" viewport-pixel coordinate, the web form of `mobile tap`'s raw input. */
const POINT_TARGET_RE = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/;

/** The in-page scan that finds controls the accessibility tree cannot name.
 * Runs in the page; returns plain JSON. */
const UNLABELED_SCAN = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const unlabeled: Array<{ role: string; x: number; y: number; width: number; height: number }> = [];
  const nodes = document.querySelectorAll<HTMLElement>(
    'button, a, input, select, textarea, [role], svg, img, [onclick], [tabindex]',
  );
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.width >= vw * 0.95 && r.height >= vh * 0.9) continue; // page wrappers
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const name = (
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.getAttribute("alt") ??
      el.innerText ??
      ""
    ).trim();
    if (name) continue; // named controls come from the AX tree with better identity
    const role =
      el.getAttribute("role") ??
      (el instanceof HTMLAnchorElement
        ? "link"
        : el instanceof HTMLButtonElement || el instanceof HTMLInputElement
          ? "button"
          : el instanceof HTMLSelectElement
            ? "combobox"
            : el instanceof HTMLTextAreaElement
              ? "textbox"
              : el instanceof SVGElement || el instanceof HTMLImageElement
                ? "graphic"
                : el.tagName.toLowerCase());
    unlabeled.push({ role, x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return { viewport: { width: vw, height: vh }, unlabeled };
};

// ---------------------------------------------------------------------------
// Backend contract — the primitives the shared action flow is written against
// ---------------------------------------------------------------------------

interface DriveBackend {
  readonly kind: "own" | "mcp";
  open(url: string): Promise<{ ok: true } | { ok: false; message: string }>;
  snapshot(): Promise<{ elements: SnapElement[]; text: string }>;
  /** The viewport, when known — bounds-checks coordinate clicks. */
  viewport(): { width: number; height: number } | undefined;
  click(el: SnapElement): Promise<{ ok: true } | { ok: false; message: string }>;
  fill(el: SnapElement, text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  select(el: SnapElement, value: string): Promise<{ ok: true } | { ok: false; message: string }>;
  press(key: string): Promise<{ ok: true } | { ok: false; message: string }>;
  screenshot(): Promise<{ images: ToolResultContent[]; text: string }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Primary backend: the harness's own browser (playwright-core, no MCP)
// ---------------------------------------------------------------------------

function ownBackend(page: WebPage, closeSession: () => Promise<void>): DriveBackend {
  const settle = async () => {
    try {
      await page.waitForLoadState("networkidle", { timeout: 3000 });
    } catch {
      // networkidle is best-effort; some pages never go idle
    }
    await new Promise((r) => setTimeout(r, 300));
  };
  type Locator = ReturnType<ReturnType<WebPage["getByRole"]>["first"]>;
  const act = async (el: SnapElement, fn: (locator: Locator) => Promise<void>) => {
    try {
      await fn(page.getByRole(el.role, { name: el.name, exact: true }).first());
      await settle();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message?.slice(0, 400) || "action failed" };
    }
  };
  let lastElements: SnapElement[] = [];
  let lastViewport: { width: number; height: number } | undefined;
  return {
    kind: "own",
    viewport: () => lastViewport,
    async open(url) {
      try {
        await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message?.slice(0, 400) || "navigation failed" };
      }
    },
    async snapshot() {
      try {
        const tree = await page.accessibility.snapshot();
        const named = flattenToWebElements(tree);
        // THE GEOMETRY CHANNEL: name-less interactive controls the AX tree
        // either drops or reports without an addressable name — icon buttons,
        // bare SVG/anchor taps. The in-page scan enumerates them WITH viewport
        // rects, so they become clickable by ref (exact centre) exactly like
        // the mobile toolkit's unlabeled set. Without this they are invisible
        // to every resolution path.
        const scan: { viewport?: { width: number; height: number }; unlabeled?: Array<{ role: string; x: number; y: number; width: number; height: number }> } =
          typeof page.evaluate === "function" ? ((await page.evaluate(UNLABELED_SCAN)) ?? {}) : {};
        const scanned = scan.unlabeled ?? [];
        const merged: SnapElement[] = named.map((e) => ({ ...e }));
        for (const u of scanned) {
          merged.push({
            ref: `e${merged.length + 1}`,
            role: u.role,
            name: "(unlabeled)",
            rect: { x: u.x, y: u.y, width: u.width, height: u.height },
          });
        }
        lastElements = merged;
        lastViewport = scan.viewport;
        const text = merged.map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]${e.rect ? ` @ ${Math.round(e.rect.x)},${Math.round(e.rect.y)} ${Math.round(e.rect.width)}x${Math.round(e.rect.height)}` : ""}`).join("\n");
        return { elements: merged.map((e) => ({ ...e })), text };
      } catch (e) {
        return { elements: [], text: (e as Error).message ?? "" };
      }
    },
    async click(el) {
      // Geometry-enumerated and coordinate targets act by position — the AX
      // tree cannot name them, so getByRole has nothing to hold.
      if (el.rect) {
        if (!page.mouse) {
          return { ok: false, message: "coordinate clicks need the harness's own browser (playwright-core)" };
        }
        try {
          await page.mouse.click(
            Math.round(el.rect.x + el.rect.width / 2),
            Math.round(el.rect.y + el.rect.height / 2),
          );
          await settle();
          return { ok: true };
        } catch (e) {
          return { ok: false, message: (e as Error).message ?? "click failed" };
        }
      }
      return act(el, (loc) => loc.click({ timeout: 5000 }));
    },
    fill: (el, text) => act(el, (loc) => loc.fill(text, { timeout: 5000 })),
    select: (el, value) =>
      act(el, async (loc) => {
        try {
          await loc.selectOption({ label: value }, { timeout: 5000 });
        } catch {
          await loc.selectOption({ value }, { timeout: 5000 });
        }
      }),
    async press(key) {
      try {
        await page.keyboard.press(key);
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message ?? "press failed" };
      }
    },
    async screenshot() {
      try {
        const buf = await page.screenshot({ type: "png" });
        return {
          images: [{ type: "image", mimeType: "image/png", data: buf.toString("base64") } as ToolResultContent],
          text: "",
        };
      } catch (e) {
        return { images: [], text: (e as Error).message ?? "" };
      }
    },
    async close() {
      await closeSession();
    },
  };
}

/** AX tree → our numbered `eN` elements, in the shared SnapElement shape. */
function flattenToWebElements(root: unknown): WebElement[] {
  let n = 0;
  const out: WebElement[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { role, name, children } = node as { role?: string; name?: string; children?: unknown[] };
    if (typeof role === "string" && role && typeof name === "string" && name && role !== "StaticText" && role !== "generic") {
      out.push({ ref: `e${++n}`, role, name });
    }
    if (Array.isArray(children)) for (const child of children) walk(child);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Legacy fallback backend: the Playwright-MCP façade this tool used to be
// ---------------------------------------------------------------------------

// Playwright-MCP tool resolution (same tolerance as activity_inspect: bare,
// `mcp__server__`-prefixed, or any other prefixing scheme via suffix match).
const NAVIGATE_TOOLS = ["browser_navigate", "mcp__playwright__browser_navigate"];
const SNAPSHOT_TOOLS = ["browser_snapshot", "mcp__playwright__browser_snapshot"];
const CLICK_TOOLS = ["browser_click", "mcp__playwright__browser_click"];
const TYPE_TOOLS = ["browser_type", "mcp__playwright__browser_type"];
const SELECT_TOOLS = ["browser_select_option", "mcp__playwright__browser_select_option"];
const PRESS_TOOLS = ["browser_press_key", "mcp__playwright__browser_press_key"];
const SCREENSHOT_TOOLS = ["browser_take_screenshot", "mcp__playwright__browser_take_screenshot"];
const CLOSE_TOOLS = ["browser_close", "mcp__playwright__browser_close"];

function findTool(registry: Registry | undefined, candidates: string[]): { name: string; tool: AgentTool } | undefined {
  if (!registry) return undefined;
  for (const name of candidates) {
    const tool = registry.getTool(name);
    if (tool) return { name, tool };
  }
  const all = typeof registry.allTools === "function" ? registry.allTools() : [];
  for (const name of candidates) {
    const tool = all.find((t) => t.name === name || t.name.endsWith(`__${name}`));
    if (tool) return { name: tool.name, tool };
  }
  return undefined;
}

function textOf(res: ToolResult): string {
  if (res.output && res.output.trim()) return res.output;
  return (res.content ?? [])
    .filter((b): b is Extract<ToolResultContent, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function imagesOf(res: ToolResult): ToolResultContent[] {
  return (res.content ?? []).filter((b) => b.type === "image");
}

function mcpBackend(registry: Registry | undefined, toolCallId: string, ctx: Parameters<AgentTool["execute"]>[2]): DriveBackend | undefined {
  const navigate = findTool(registry, NAVIGATE_TOOLS);
  const snapshot = findTool(registry, SNAPSHOT_TOOLS);
  const click = findTool(registry, CLICK_TOOLS);
  const type = findTool(registry, TYPE_TOOLS);
  const select = findTool(registry, SELECT_TOOLS);
  const press = findTool(registry, PRESS_TOOLS);
  const screenshot = findTool(registry, SCREENSHOT_TOOLS);
  const close = findTool(registry, CLOSE_TOOLS);
  if (!navigate && !snapshot && !screenshot) return undefined;
  const run = async (finder: { name: string; tool: AgentTool } | undefined, suffix: string, args: Record<string, unknown>) => {
    if (!finder) throw new Error(`no ${suffix} browser tool available`);
    return finder.tool.execute(`${toolCallId}-${suffix}-${Date.now()}`, args, ctx);
  };
  return {
    kind: "mcp",
    viewport: () => undefined,
    async open(url) {
      try {
        const res = await run(navigate, "nav", { url });
        if (res.isError) return { ok: false, message: textOf(res).slice(0, 400) };
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async snapshot() {
      if (!snapshot) return { elements: [], text: "" };
      try {
        const res = await snapshot.tool.execute(`${toolCallId}-snap-${Date.now()}`, {}, ctx);
        const text = textOf(res);
        return { elements: parseSnapshot(text), text };
      } catch {
        return { elements: [], text: "" };
      }
    },
    async click(el) {
      if (el.rect) {
        return {
          ok: false as const,
          message:
            "coordinate and unlabeled-geometry clicks need the harness's own browser (`playwright-core`); " +
            "the Playwright-MCP façade can only click elements it can name",
        };
      }
      try {
        const res = await run(click, "click", { element: el.name, ref: el.ref });
        if (res.isError) return { ok: false, message: textOf(res).slice(0, 400) };
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async fill(el, text) {
      try {
        const res = await run(type, "type", { element: el.name, ref: el.ref, text });
        if (res.isError) return { ok: false, message: textOf(res).slice(0, 400) };
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async select(el, value) {
      try {
        const res = await run(select, "select", { element: el.name, ref: el.ref, values: [value] });
        if (res.isError) return { ok: false, message: textOf(res).slice(0, 400) };
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async press(key) {
      try {
        const res = await run(press, "press", { key });
        if (res.isError) return { ok: false, message: textOf(res).slice(0, 300) };
        await settle();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async screenshot() {
      if (!screenshot) return { images: [], text: "" };
      try {
        const res = await screenshot.tool.execute(`${toolCallId}-shot-${Date.now()}`, {}, ctx);
        return { images: imagesOf(res), text: textOf(res) };
      } catch (e) {
        return { images: [], text: (e as Error).message };
      }
    },
    async close() {
      if (close) await close.tool.execute(`${toolCallId}-close`, {}, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot parsing + target resolution (shared by both backends)
// ---------------------------------------------------------------------------

/**
 * Parse Playwright-MCP snapshot lines (the legacy backend). The format is YAML-ish:
 *   - button "Sign in" [ref=e12]
 *   - textbox "Email" [ref=e21]
 *   - heading "Welcome" [level=1] [ref=e5]
 *   - link "Docs": https://example.com [ref=e3]
 */
export function parseSnapshot(text: string): SnapElement[] {
  const out: SnapElement[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s+(?:(\w[\w-]*)\s+)?"([^"]{1,200})"(?:[^[\]]*(\[ref=([^\]]+)\]))?/);
    if (!m) continue;
    const role = m[1] ?? "element";
    const name = m[2];
    const ref = m[4];
    if (ref) out.push({ ref, role, name });
    else out.push({ ref: "", role, name });
  }
  return out;
}

const INTERACTIVE = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem",
  "tab", "option", "switch", "searchbox", "slider", "spinbutton", "listitem",
]);

/** Short rendering of an element for listings (geometry appended when known). */
const show = (e: SnapElement) =>
  `${e.role} "${e.name}"${e.ref ? ` [ref=${e.ref}]` : ""}` +
  (e.rect ? ` @ ${Math.round(e.rect.x)},${Math.round(e.rect.y)} ${Math.round(e.rect.width)}x${Math.round(e.rect.height)}` : "");

/**
 * Resolve a `target` description against the parsed snapshot.
 *   1. a verbatim `ref=eN` wins immediately;
 *   2. exact (case-insensitive) name match;
 *   3. unique substring match;
 * Ambiguity and misses return a message that lists the page's interactive
 * elements — the caller can re-issue with a better description, never a guess.
 */
export function resolveTarget(target: string, elements: SnapElement[]): { ok: true; element: SnapElement } | { ok: false; message: string } {
  const t = target.trim();
  if (!t) return { ok: false, message: "drive: `target` is required for this action." };

  // An explicit "x,y" viewport point — the web form of `mobile tap`'s raw
  // coordinate input, for canvas and custom-drawn surfaces the tree cannot
  // enumerate. Acts through the geometry path (centre of a zero-size rect).
  const pt = t.match(POINT_TARGET_RE);
  if (pt) {
    return {
      ok: true,
      element: { ref: "", role: "point", name: t, rect: { x: Number(pt[1]), y: Number(pt[2]), width: 0, height: 0 } },
    };
  }

  const refMatch = t.match(/^ref=(.+)$/);
  if (refMatch) {
    const hit = elements.find((e) => e.ref === refMatch[1]);
    if (hit && hit.ref) return { ok: true, element: hit };
    const withRefs = elements.filter((e) => e.ref);
    return {
      ok: false,
      message:
        `drive: no element with ${t} on the page. Current interactive elements:\n` +
        listInteractive(withRefs),
    };
  }

  const lower = t.toLowerCase();
  const exact = elements.filter((e) => e.name.toLowerCase() === lower && e.ref);
  if (exact.length === 1) return { ok: true, element: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      message: `drive: "${t}" matches ${exact.length} elements. Be more specific:\n` + exact.map(show).join("\n"),
    };
  }

  const substr = elements.filter((e) => e.ref && e.name.toLowerCase().includes(lower));
  if (substr.length === 1) return { ok: true, element: substr[0] };
  if (substr.length > 1) {
    return {
      ok: false,
      message: `drive: "${t}" matches ${substr.length} elements. Be more specific:\n` + substr.map(show).join("\n"),
    };
  }

  return {
    ok: false,
    message:
      `drive: no element matching "${t}". Current interactive elements:\n` + listInteractive(elements),
  };
}

function listInteractive(elements: SnapElement[]): string {
  const interesting = elements.filter((e) => INTERACTIVE.has(e.role) || e.ref);
  const shown = interesting.slice(0, 25).map((e) => `- ${show(e)}`);
  return shown.length ? shown.join("\n") : "(none found — the page may still be loading; try `drive {action:\"look\"}`)";
}

/** Names present in `after` but not `before` (and vice versa) — what changed. */
function diffNames(before: SnapElement[], after: SnapElement[]): { added: string[]; gone: string[] } {
  const key = (e: SnapElement) => `${e.role}::${e.name.toLowerCase()}`;
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  const added = after.filter((e) => !b.has(key(e))).map((e) => e.name).slice(0, 8);
  const gone = before.filter((e) => !a.has(key(e))).map((e) => e.name).slice(0, 8);
  return { added, gone };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export function createDriveTool(): AgentTool {
  return {
    name: "drive",
    title: "Drive the browser",
    actionParam: "action",
    actionTitles: {
      open: "Open the page",
      look: "Look at the page",
      click: "Click on the page",
      fill: "Type into a field",
      select: "Pick from a dropdown",
      press: "Press a key",
      shot: "Capture the page",
      close: "Close the browser",
    },
    description:
      "Drive a web page in ONE call per step. `look` returns the screenshot AND every element " +
      "(refs + names); `click`/`fill`/`select` take a plain DESCRIPTION, resolve it against the live " +
      "page, act, and return the post-action screenshot plus what changed; `open` navigates; `shot` " +
      "is the final capture to hand to media_analysis. Runs on the harness's own browser — no MCP " +
      "required (set TURING_BROWSER_CDP to reuse a running one).",
    mutates: true,
    categorizers: ["activity_inspect"],
    parameters: { type: "object", properties: PARAMS, required: ["action"] },
    async execute(toolCallId, args, ctx) {
      const action = String(args?.action ?? "").trim() as DriveAction;
      if (!DRIVE_ACTIONS.includes(action)) {
        return err(`drive: unknown action "${action}". Expected one of: ${DRIVE_ACTIONS.join(", ")}.`);
      }

      // Primary: our own session. Fallback: the legacy MCP façade.
      let backend: DriveBackend | undefined;
      if (await webSessionAvailable()) {
        const session = await webSession();
        if (session) backend = ownBackend(session.page, session.close);
      }
      if (!backend) {
        const registry = ctx.registry as Registry | undefined;
        backend = mcpBackend(registry, toolCallId, ctx);
      }
      if (!backend) {
        return err(
          "drive: no browser available. The harness's own session needs `playwright-core` installed and " +
            "a Chrome to launch (or TURING_BROWSER_CDP pointing at a running debugger). Alternatively attach " +
            "the Playwright MCP (`session.addMcpServer({ id: \"playwright\", command: \"npx\", args: [\"-y\", " +
            "\"@playwright/mcp@latest\"] })`). For a device/simulator use the `mobile` tool instead; for a " +
            "one-shot page capture use `activity_inspect`.",
        );
      }

      switch (action) {
        // ---- session ------------------------------------------------------
        case "open": {
          const url = String(args?.url ?? "").trim();
          if (!url) return err("drive open: `url` is required.");
          const res = await backend.open(url);
          if (!res.ok) return err(`drive open: navigation failed — ${res.message}`);
          const snap = await backend.snapshot();
          return {
            output: [
              `**Opened** ${url}`,
              "",
              summaryLines(snap.elements),
              "Next: `drive {action:\"look\"}` to SEE the page, or act directly (`click`/`fill`).",
            ].join("\n"),
          };
        }

        case "close": {
          await backend.close();
          return { output: "Browser session closed." };
        }

        // ---- capture ------------------------------------------------------
        case "shot": {
          const img = await backend.screenshot();
          if (!img.images.length) {
            return err(`drive shot: no screenshot came back — ${img.text.slice(0, 300) || "empty result"}`);
          }
          return {
            output:
              "**Screenshot captured** (attached). This is the final-capture shape: hand it to " +
              "`media_analysis` (lens:\"qa\" with `expected`, or lens:\"compare\" against a reference).",
            content: img.images,
            details: { captured: 1, screenshotCaptured: true },
          };
        }

        case "look": {
          const snap = await backend.snapshot();
          const img = await backend.screenshot();
          const lines: string[] = ["**Page** (screenshot attached + elements below):"];
          const interactive = snap.elements.filter((e) => INTERACTIVE.has(e.role) || e.ref);
          for (const e of interactive.slice(0, 40)) lines.push(`- ${show(e)}`);
          if (!interactive.length) lines.push("(no interactive elements parsed — the page may be blank or still loading)");
          lines.push("", "Act by DESCRIPTION or ref: `drive {action:\"click\", target:\"Sign in\"}`.");
          return {
            output: lines.join("\n"),
            ...(img.images.length ? { content: img.images } : {}),
            details: { elements: snap.elements.length, captured: img.images.length ? 1 : 0, snapshotText: snap.text.slice(0, 2000) },
          };
        }

        // ---- act (resolve → act → verify, ONE call) ------------------------
        case "click":
        case "fill":
        case "select": {
          const target = String(args?.target ?? "");

          // CLICK gets the mobile-tap treatment: a click that changed nothing
          // is re-derived ONCE against a fresh snapshot (the same description,
          // a NEW tree — the page may have settled late or the first resolve
          // hit a stale node). fill/select stay single-shot; typing twice is
          // worse than reporting.
          const maxAttempts = action === "click" ? 2 : 1;
          let lastMsg: string | undefined;

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const before = await backend.snapshot();
            const resolved = resolveTarget(target, before.elements);
            if (!resolved.ok) return err(resolved.message);

            // Coordinate targets: bounds-check against the viewport so an
            // out-of-range click fails loudly instead of silently.
            if (resolved.element.role === "point") {
              const vp = backend.viewport();
              if (vp && (resolved.element.rect!.x > vp.width || resolved.element.rect!.y > vp.height)) {
                return err(
                  `drive click: (${resolved.element.rect!.x}, ${resolved.element.rect!.y}) is outside the ` +
                    `${vp.width}x${vp.height} viewport — the click would be dropped silently.`,
                );
              }
            }

            let act: { run: () => Promise<{ ok: true } | { ok: false; message: string }>; label: string };
            if (action === "click") {
              act = { run: () => backend!.click(resolved.element), label: "clicked" };
            } else if (action === "fill") {
              const text = String(args?.text ?? "");
              if (!text) return err("drive fill: `text` is required.");
              act = { run: () => backend!.fill(resolved.element, text), label: "typed into" };
            } else {
              const value = String(args?.value ?? "");
              if (!value) return err("drive select: `value` is required.");
              act = { run: () => backend!.select(resolved.element, value), label: "selected in" };
            }

            const actRes = await act.run();
            if (!actRes.ok) {
              return err(`drive ${action} on ${show(resolved.element)} failed — ${actRes.message}`);
            }

            // Post-action state: what changed + the new pixels, in the SAME call.
            const after = await backend.snapshot();
            const img = await backend.screenshot();
            const diff = diffNames(before.elements, after.elements);
            const changed = diff.added.length > 0 || diff.gone.length > 0;
            if (!changed && attempt + 1 < maxAttempts) {
              lastMsg = `(no change after click 1 — re-deriving \"${target}\" against a fresh snapshot)`;
              continue;
            }
            const lines: string[] = [`**${act.label[0].toUpperCase()}${act.label.slice(1)}** ${show(resolved.element)} — screenshot attached.`];
            if (lastMsg) lines.push(lastMsg);
            if (diff.added.length) lines.push(`Now on screen: ${diff.added.join(", ")}`);
            if (diff.gone.length) lines.push(`Gone: ${diff.gone.join(", ")}`);
            if (!diff.added.length && !diff.gone.length) {
              lines.push("(no element changes detected — if this is unexpected, `drive {action:\"look\"}` and check).");
            }
            lines.push("", "Continue with the next step, or `drive {action:\"shot\"}` when ready to analyse.");
            return {
              output: lines.join("\n"),
              ...(img.images.length ? { content: img.images } : {}),
              details: {
                action,
                target: show(resolved.element),
                added: diff.added,
                gone: diff.gone,
                captured: img.images.length ? 1 : 0,
                attempts: attempt + 1,
              },
            };
          }
          return err(`drive ${action}: exhausted attempts.`);
        }

        case "press": {
          const key = String(args?.key ?? "").trim();
          if (!key) return err("drive press: `key` is required.");
          const res = await backend.press(key);
          if (!res.ok) return err(`drive press ${key} failed — ${res.message}`);
          const after = await backend.snapshot();
          const img = await backend.screenshot();
          return {
            output: [`**Pressed** ${key} — screenshot attached.`, "", summaryLines(after.elements)].join("\n"),
            ...(img.images.length ? { content: img.images } : {}),
          };
        }
      }
    },
  };
}

/** A beat for the page to settle after navigation/action. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 800));
}

function summaryLines(elements: SnapElement[]): string {
  const interactive = elements.filter((e) => INTERACTIVE.has(e.role) || e.ref).slice(0, 15);
  if (!interactive.length) return "Page elements: (none parsed yet)";
  return "Page elements:\n" + interactive.map((e) => `- ${show(e)}`).join("\n");
}

function err(message: string): ToolResult {
  return { output: message, isError: true };
}
