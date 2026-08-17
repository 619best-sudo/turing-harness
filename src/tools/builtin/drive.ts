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
 */
import type { AgentTool, ToolResult, ToolResultContent } from "../../types.js";
import type { Registry } from "../../registry/registry.js";

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

// ---------------------------------------------------------------------------
// Playwright-MCP tool resolution (same tolerance as activity_inspect: bare,
// `mcp__server__`-prefixed, or any other prefixing scheme via suffix match).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Snapshot parsing + target resolution
// ---------------------------------------------------------------------------

interface SnapElement {
  ref: string;
  role: string;
  name: string;
}

/**
 * Parse Playwright-MCP snapshot lines. The format is YAML-ish:
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

/** Short rendering of an element for listings. */
const show = (e: SnapElement) => `${e.role} "${e.name}"${e.ref ? ` [ref=${e.ref}]` : ""}`;

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
      "is the final capture to hand to media_analysis. Prefer this over raw browser_* tools.",
    mutates: true,
    categorizers: ["activity_inspect"],
    parameters: { type: "object", properties: PARAMS, required: ["action"] },
    async execute(toolCallId, args, ctx) {
      const action = String(args?.action ?? "").trim() as DriveAction;
      if (!DRIVE_ACTIONS.includes(action)) {
        return err(`drive: unknown action "${action}". Expected one of: ${DRIVE_ACTIONS.join(", ")}.`);
      }
      const registry = ctx.registry as Registry | undefined;

      const navigate = findTool(registry, NAVIGATE_TOOLS);
      const snapshot = findTool(registry, SNAPSHOT_TOOLS);
      const click = findTool(registry, CLICK_TOOLS);
      const type = findTool(registry, TYPE_TOOLS);
      const select = findTool(registry, SELECT_TOOLS);
      const press = findTool(registry, PRESS_TOOLS);
      const screenshot = findTool(registry, SCREENSHOT_TOOLS);
      const close = findTool(registry, CLOSE_TOOLS);

      const anyBrowser = !!(navigate || snapshot || screenshot);
      if (!anyBrowser) {
        return err(
          "drive: no browser MCP is connected. Attach Playwright (e.g. `session.addMcpServer({ id: " +
            "\"playwright\", command: \"npx\", args: [\"-y\", \"@playwright/mcp@latest\"] })`) and retry. " +
            "For a device/simulator use the `mobile` tool instead; for a one-shot page capture use " +
            "`activity_inspect`.",
        );
      }

      switch (action) {
        // ---- session ------------------------------------------------------
        case "open": {
          const url = String(args?.url ?? "").trim();
          if (!url) return err("drive open: `url` is required.");
          if (!navigate) return err("drive open: no browser_navigate tool available.");
          const res = await navigate.tool.execute(`${toolCallId}-nav`, { url }, ctx);
          if (res.isError) return err(`drive open: navigation failed — ${textOf(res).slice(0, 400)}`);
          await settle();
          const snap = await takeSnapshot();
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
          if (!close) return err("drive close: no browser_close tool available.");
          await close.tool.execute(`${toolCallId}-close`, {}, ctx);
          return { output: "Browser session closed." };
        }

        // ---- capture ------------------------------------------------------
        case "shot": {
          const img = await takeScreenshot();
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
          const snap = await takeSnapshot();
          const img = await takeScreenshot();
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
          const before = await takeSnapshot();
          const resolved = resolveTarget(target, before.elements);
          if (!resolved.ok) return err(resolved.message);

          let act: { finder?: { name: string; tool: AgentTool }; call: string; actArgs: Record<string, unknown> };
          if (action === "click") {
            act = { finder: click, call: "click", actArgs: { element: resolved.element.name, ref: resolved.element.ref } };
          } else if (action === "fill") {
            const text = String(args?.text ?? "");
            if (!text) return err("drive fill: `text` is required.");
            act = { finder: type, call: "type", actArgs: { element: resolved.element.name, ref: resolved.element.ref, text } };
          } else {
            const value = String(args?.value ?? "");
            if (!value) return err("drive select: `value` is required.");
            act = { finder: select, call: "select", actArgs: { element: resolved.element.name, ref: resolved.element.ref, values: [value] } };
          }
          if (!act.finder) return err(`drive ${action}: no browser_${act.call === "select" ? "select_option" : act.call} tool available.`);

          const actRes = await act.finder.tool.execute(`${toolCallId}-${act.call}`, act.actArgs, ctx);
          if (actRes.isError) {
            return err(`drive ${action} on ${show(resolved.element)} failed — ${textOf(actRes).slice(0, 400)}`);
          }
          await settle();

          // Post-action state: what changed + the new pixels, in the SAME call.
          const after = await takeSnapshot();
          const img = await takeScreenshot();
          const diff = diffNames(before.elements, after.elements);
          const lines: string[] = [`**${action === "fill" ? "Typed into" : action === "select" ? "Selected in" : "Clicked"}** ${show(resolved.element)} — screenshot attached.`];
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
            },
          };
        }

        case "press": {
          const key = String(args?.key ?? "").trim();
          if (!key) return err("drive press: `key` is required.");
          if (!press) return err("drive press: no browser_press_key tool available.");
          const res = await press.tool.execute(`${toolCallId}-press`, { key }, ctx);
          if (res.isError) return err(`drive press ${key} failed — ${textOf(res).slice(0, 300)}`);
          await settle();
          const after = await takeSnapshot();
          const img = await takeScreenshot();
          return {
            output: [`**Pressed** ${key} — screenshot attached.`, "", summaryLines(after.elements)].join("\n"),
            ...(img.images.length ? { content: img.images } : {}),
          };
        }
      }

      // helpers over the resolved finders (closures need the switch-scoped ones)
      async function takeSnapshot(): Promise<{ elements: SnapElement[]; text: string }> {
        if (!snapshot) return { elements: [], text: "" };
        try {
          const res = await snapshot.tool.execute(`${toolCallId}-snap-${Date.now()}`, {}, ctx);
          const text = textOf(res);
          return { elements: parseSnapshot(text), text };
        } catch {
          return { elements: [], text: "" };
        }
      }
      async function takeScreenshot(): Promise<{ images: ToolResultContent[]; text: string }> {
        if (!screenshot) return { images: [], text: "" };
        try {
          const res = await screenshot.tool.execute(`${toolCallId}-shot-${Date.now()}`, {}, ctx);
          return { images: imagesOf(res), text: textOf(res) };
        } catch (err) {
          return { images: [], text: (err as Error).message };
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
