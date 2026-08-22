/**
 * The `mobilecli` backend — https://github.com/mobile-next/mobilecli
 *
 * This is the harness's ONLY device-automation backend. It replaced
 * the external device-MCP server outright (same org, same underlying drivers, but a
 * process boundary and a JSON contract instead of a long-lived MCP server that
 * silently mis-delivered input).
 *
 * ── THE COORDINATE CONTRACT ────────────────────────────────────────────────
 * EVERY coordinate this module accepts or returns is a LOGICAL POINT — the
 * same space `mobilecli device info` reports as `screenSize`, and the same
 * space `mobilecli dump ui` reports element rects in.
 *
 * This was established empirically against a booted iPhone 17 Pro simulator
 * (402x874 pt, scale 3, screenshots 1206x2622 px), tapping three targets in
 * both spaces:
 *
 *   target          logical pt      physical px      result
 *   Contacts tab    (123, 799)  ->  (369, 2397)      logical WORKED, physical no-op
 *   Cards tab       ( 43, 799)  ->  (129, 2397)      logical WORKED, physical no-op
 *   Profile avatar  (366,  90)  ->  (1098, 271)      logical WORKED, physical no-op
 *
 * An earlier revision of this file asserted the opposite (physical pixels) and
 * the tap path carried a runtime "calibration" that guessed between the two.
 * Both were wrong: taps sent in physical pixels land off-screen and are
 * silently dropped, and `mobilecli io tap` reports `status: ok` either way —
 * which is precisely the "the tap never landed" signature that made the MCP
 * look flaky. There is no calibration here by design; the space is known.
 *
 * The one conversion that IS needed: a screenshot is in PHYSICAL pixels, so a
 * coordinate derived from a screenshot (a vision estimate) must be divided by
 * the scale factor before it can be tapped. Use `imageToLogical()` — never do
 * that arithmetic at a call site.
 *
 * `dump ui` rects need NO conversion: they are already logical, so an
 * element-list coordinate is tappable as-is.
 *
 * All commands speak JSON on stdout with `{ status, data }` envelopes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

import type { AgentTool, ToolResult, JSONSchema } from "../types.js";
import { resolveShellEnvironment } from "../exec/shell-env.js";

const run = promisify(execFile);

/** Disabling seam for tests (the binary is real I/O). */
let cliOverride: string | undefined;
export function setMobileCliOverride(binary: string | undefined): void {
  cliOverride = binary;
  // A test swapping the binary must not inherit the previous probe's verdict.
  available = null;
  probedAt = 0;
}

/**
 * Test seam: pin the availability verdict without touching PATH.
 *
 * Needed because the "mobilecli is not installed" branches are otherwise
 * untestable on a developer machine that HAS it installed — and those are
 * exactly the branches that tell a user how to get a device surface.
 */
let availableOverride: boolean | undefined;
export function setMobileCliAvailableOverride(value: boolean | undefined): void {
  availableOverride = value;
  available = null;
  probedAt = 0;
}

async function cli(bin: string, args: string[], timeoutMs = 60_000) {
  const shellEnv = await resolveShellEnvironment();
  const { stdout } = await run(bin, args, {
    timeout: timeoutMs,
    env: shellEnv.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Best-effort availability probe with a short cache. */
let available: boolean | null = null;
let probedAt = 0;

export async function mobileCliAvailable(): Promise<boolean> {
  if (availableOverride !== undefined) return availableOverride;
  if (cliOverride) return true;
  if (available !== null && Date.now() - probedAt < 30_000) return available;
  try {
    const bin = await mobileCliBinary();
    await cli(bin, ["--version"], 10_000);
    available = true;
  } catch {
    available = false;
  }
  probedAt = Date.now();
  return available;
}

async function mobileCliBinary(): Promise<string> {
  if (cliOverride) return cliOverride;
  const shellEnv = await resolveShellEnvironment();
  // The user's shell PATH (where brew/npm -g install), not the parent
  // process's — a GUI-launched host has a minimal PATH and would never find it.
  const { stdout } = await run(
    "/bin/sh",
    ["-c", "command -v mobilecli || command -v mobile-cli || true"],
    { env: shellEnv.env, timeout: 10_000 },
  );
  const bin = stdout.trim().split("\n")[0];
  if (!bin) throw new Error("mobilecli not found on PATH");
  return bin;
}

/**
 * Parse a `{ status, data }` JSON envelope.
 *
 * Returns `unknown` rather than a record because `data` is not always an
 * object: `apps list` answers with a bare ARRAY. Callers narrow.
 */
function envelope(stdout: string): unknown {
  const parsed = JSON.parse(stdout.trim()) as { status?: string; data?: unknown };
  if (parsed.status && parsed.status !== "ok") {
    throw new Error(`mobilecli error: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed.data ?? {};
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface MobileCliDevice {
  id: string;
  name?: string;
  platform: string;
  /** "simulator" | "emulator" | "real" — as reported. */
  type?: string;
  version?: string;
  state?: string;
}

export async function mobileCliDevices(opts?: {
  includeOffline?: boolean;
  platform?: "ios" | "android";
}): Promise<MobileCliDevice[]> {
  const bin = await mobileCliBinary();
  const args = ["devices"];
  if (opts?.includeOffline) args.push("--include-offline");
  if (opts?.platform) args.push("--platform", opts.platform);
  const data = asRecord(envelope(await cli(bin, args, 30_000)));
  const list = (data.devices as Array<Record<string, unknown>>) ?? [];
  return list
    .filter((d) => d && typeof d.id === "string")
    .map((d) => ({
      id: String(d.id),
      name: typeof d.name === "string" ? d.name : undefined,
      platform: String(d.platform ?? "unknown"),
      type: typeof d.type === "string" ? d.type : undefined,
      version: typeof d.version === "string" ? d.version : undefined,
      state: typeof d.state === "string" ? d.state : "online",
    }));
}

/** Screen geometry — the source of truth for every coordinate conversion. */
export interface MobileCliScreen {
  /** Logical points — the space taps and element rects use. */
  width: number;
  height: number;
  /** Physical pixels per logical point (3 on a modern iPhone). */
  scale: number;
}

export interface MobileCliDeviceInfo extends MobileCliDevice {
  screen?: MobileCliScreen;
}

/**
 * Device info INCLUDING `screenSize` — needed to turn a screenshot pixel into
 * a tappable logical point. Nothing else reports the scale factor, and
 * assuming x3 is wrong on iPads, older devices, and most Android hardware.
 */
export async function mobileCliDeviceInfo(device: string): Promise<MobileCliDeviceInfo | undefined> {
  try {
    const bin = await mobileCliBinary();
    const data = asRecord(envelope(await cli(bin, ["device", "info", "--device", device], 30_000)));
    const d = asRecord(data.device);
    if (!d.id) return undefined;
    const size = asRecord(d.screenSize);
    const width = Number(size.width);
    const height = Number(size.height);
    const scale = Number(size.scale);
    return {
      id: String(d.id),
      name: typeof d.name === "string" ? d.name : undefined,
      platform: String(d.platform ?? "unknown"),
      type: typeof d.type === "string" ? d.type : undefined,
      version: typeof d.version === "string" ? d.version : undefined,
      state: typeof d.state === "string" ? d.state : undefined,
      ...(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? { screen: { width, height, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 } }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Convert a coordinate read off a SCREENSHOT (physical pixels) into the
 * LOGICAL point space taps use.
 *
 * Derives the ratio from the image's own dimensions rather than trusting the
 * reported `scale`, because a capture may be resized in transit; the two agree
 * when nothing resized it. Clamps into the screen, since an estimate outside
 * the display is a bad estimate, not a coordinate.
 */
export function imageToLogical(
  point: { x: number; y: number },
  image: { width: number; height: number },
  screen: MobileCliScreen,
): { x: number; y: number } {
  const rx = image.width > 0 ? screen.width / image.width : 1;
  const ry = image.height > 0 ? screen.height / image.height : 1;
  const x = Math.round(point.x * rx);
  const y = Math.round(point.y * ry);
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, screen.width - 1)),
    y: Math.min(Math.max(y, 0), Math.max(0, screen.height - 1)),
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * NATIVE-resolution screenshot (validated: 1206x2622 of a 402pt screen).
 * Returns image bytes as base64 + mime.
 */
export async function mobileCliScreenshot(
  device: string,
): Promise<{ data: string; mimeType: string } | undefined> {
  const bin = await mobileCliBinary();
  const file = path.join(os.tmpdir(), `mobilecli-${randomBytes(6).toString("hex")}.png`);
  try {
    await cli(bin, ["screenshot", "--device", device, "--format", "png", "--output", file], 60_000);
    const buf = await fs.readFile(file);
    if (!buf.length) return undefined;
    return { data: buf.toString("base64"), mimeType: "image/png" };
  } catch {
    return undefined;
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Element tree
// ---------------------------------------------------------------------------

/**
 * A tappable node, whether or not it carries an accessibility label.
 *
 * `unlabeled` nodes cannot be matched by description, but they are exactly the
 * ones a vision estimate needs to be snapped onto — an avatar, an icon-only
 * button, a bare GestureDetector.
 */
export interface MobileCliTarget {
  rect: { x: number; y: number; width: number; height: number };
  /** Logical-point centre — directly tappable. */
  center: { x: number; y: number };
  label?: string;
  unlabeled: boolean;
  /** Element kind, resolved from the raw tree's numeric type. */
  type: string;
}

interface RawNode {
  frame?: { X?: number; Y?: number; Width?: number; Height?: number };
  label?: string;
  elementType?: number;
  children?: RawNode[];
}

/**
 * XCUIElementType numbers worth naming. The rest fall back to "Other".
 *
 * Type 1 ("Other") is the important one: it is what the JSON view discards and
 * what Flutter puts every labelled row into. See {@link parseRawUi}.
 */
const ELEMENT_TYPES: Record<number, string> = {
  2: "Application",
  4: "Window",
  9: "Button",
  25: "StatusBar",
  40: "Switch",
  42: "TextField",
  44: "SecureTextField",
  46: "ScrollView",
  47: "Table",
  48: "StaticText",
  49: "Image",
  50: "Cell",
};

/** System chrome that is never an app tap target, matched by its label. */
const SYSTEM_CHROME = /battery|wi-?fi|cellular|signal|bars\b|charging|sos|airplane/i;

interface ParsedUi {
  nodes: MobileCliTarget[];
  screen: { width: number; height: number };
}

/**
 * Parse `dump ui --format raw` — the FULL hierarchy — into flat, deduped nodes.
 *
 * WHY the raw tree and not the default JSON view: `dump ui` without `--format
 * raw` only reports a whitelist of element types (Button, StaticText, Switch,
 * …) and silently drops type 1, "Other". On the validation device's profile
 * screen that meant SIX labelled rows — "Manage Events", "Help & Support",
 * "Invite Teammates", "Log Out", "Delete My Account", "Report Issue", each a
 * 354x40 node carrying its own label — never reached the harness at all. The
 * JSON view showed only their 40x40 icons (unlabeled) plus one StaticText, so
 * "tap Delete My Account" had no ground truth and fell to a vision guess that
 * landed two rows away.
 *
 * This is not one app's quirk: Flutter's semantics, React Native's Pressables
 * and plain native containers all commonly surface as "Other". Reading the raw
 * tree is what makes the toolkit work on an arbitrary repo rather than on the
 * subset of apps whose widgets happen to land on the whitelist.
 *
 * The raw tree is a strict superset — every node the JSON view returned on the
 * validation screens appears here with the same rect — so nothing is lost by
 * preferring it. `mobileCliElements` still falls back to the JSON view if the
 * raw dump is unavailable (older binary, a platform that does not implement it).
 */
async function parseRawUi(device: string): Promise<ParsedUi | undefined> {
  let root: RawNode | undefined;
  try {
    const bin = await mobileCliBinary();
    const data = asRecord(envelope(await cli(bin, ["dump", "ui", "--device", device, "--format", "raw"], 45_000)));
    root = data.rawData as RawNode | undefined;
  } catch {
    return undefined;
  }
  if (!root || typeof root !== "object") return undefined;

  const flat: RawNode[] = [];
  const walk = (n: RawNode | undefined) => {
    if (!n || typeof n !== "object") return;
    flat.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);

  const rectOf = (n: RawNode) => {
    const f = n.frame;
    if (!f) return undefined;
    const x = Number(f.X);
    const y = Number(f.Y);
    const width = Number(f.Width);
    const height = Number(f.Height);
    if (![x, y, width, height].every(Number.isFinite)) return undefined;
    return { x, y, width, height };
  };

  // The screen, taken from the Application / Window node.
  //
  // NOT the largest frame, which is the obvious heuristic and is wrong: a
  // scroll container reports its full CONTENT size. On the delete-account
  // dialog the largest frame was 402x1244 against a real 402x874 screen, so
  // that heuristic would inflate the screen by 40% and defeat every
  // visibility test below.
  let screen = { width: 0, height: 0 };
  for (const n of flat) {
    const r = rectOf(n);
    if (!r || r.x !== 0 || r.y !== 0) continue;
    if ((n.elementType === 2 || n.elementType === 4) && r.width * r.height > screen.width * screen.height) {
      screen = { width: r.width, height: r.height };
    }
  }
  if (screen.width <= 0) {
    // No Application/Window node (a platform that types nodes differently):
    // the most REPEATED frame anchored at the origin is the window, since the
    // tree nests many wrappers that exactly match it.
    const counts = new Map<string, { r: { width: number; height: number }; n: number }>();
    for (const n of flat) {
      const r = rectOf(n);
      if (!r || r.x !== 0 || r.y !== 0) continue;
      const k = `${r.width}x${r.height}`;
      const prev = counts.get(k);
      counts.set(k, { r, n: (prev?.n ?? 0) + 1 });
    }
    let best: { r: { width: number; height: number }; n: number } | undefined;
    for (const c of counts.values()) {
      if (!best || c.n > best.n || (c.n === best.n && c.r.width * c.r.height > best.r.width * best.r.height)) best = c;
    }
    if (best) screen = { width: best.r.width, height: best.r.height };
  }
  if (screen.width <= 0 || screen.height <= 0) return undefined;
  const screenArea = screen.width * screen.height;

  // The status bar, DERIVED rather than hardcoded: it is ~54pt on this iPhone,
  // differs across iOS devices, and is ~24dp on Android. Anything living
  // entirely inside it is system chrome (clock, battery, wifi) — never an app
  // target, and the clock in particular makes screen-change detection lie.
  let statusBar = 0;
  for (const n of flat) {
    const r = rectOf(n);
    if (!r || r.x !== 0 || r.y !== 0) continue;
    const isStatusBarType = n.elementType === 25;
    if (r.width >= screen.width * 0.9 && r.height > 0 && (isStatusBarType || r.height <= screen.height * 0.12)) {
      statusBar = Math.max(statusBar, r.height);
    }
  }

  const byRect = new Map<string, MobileCliTarget>();
  for (const n of flat) {
    const r = rectOf(n);
    if (!r) continue;
    // Slivers and hairlines: the validation device reported a width-0 and a
    // width-5 node, both clipped carousel edges carrying REAL button labels.
    if (r.width < 8 || r.height < 8) continue;
    // CLIP to what is actually on screen. The tree happily reports content
    // that cannot be tapped: rows below the fold of a scroll view, and — on
    // the delete-account dialog — 43 nodes below y=874 including a whole
    // keyboard that was not even displayed. Handing one of those to the model
    // yields a tap the driver silently drops, which reads as "the tap tool is
    // broken". A partly-scrolled row stays, addressed by its VISIBLE centre.
    const vx = Math.max(r.x, 0);
    const vy = Math.max(r.y, 0);
    const vw = Math.min(r.x + r.width, screen.width) - vx;
    const vh = Math.min(r.y + r.height, screen.height) - vy;
    if (vw < 8 || vh < 8) continue;
    const visible = { x: vx, y: vy, width: vw, height: vh };
    // Entirely inside the status bar.
    if (statusBar > 0 && r.y + r.height <= statusBar) continue;
    // Full-screen wrappers. The tree nests ~15 identical (0,0,402x874) nodes;
    // none is a tap target and one of them carries the app NAME as its label,
    // which would otherwise match a description like "the cards screen".
    if (r.width * r.height >= screenArea * 0.9) continue;

    const label = typeof n.label === "string" && n.label.trim() ? n.label.trim() : undefined;
    if (label && SYSTEM_CHROME.test(label)) continue;

    const key = `${visible.x},${visible.y},${visible.width},${visible.height}`;
    const existing = byRect.get(key);
    // Same rect appearing twice (a wrapper and its content): keep the labelled
    // one, since the label is the only thing that makes it addressable.
    if (existing && (existing.label || !label)) continue;
    byRect.set(key, {
      rect: visible,
      center: { x: Math.round(visible.x + visible.width / 2), y: Math.round(visible.y + visible.height / 2) },
      ...(label ? { label } : {}),
      unlabeled: !label,
      type: ELEMENT_TYPES[Number(n.elementType)] ?? "Other",
    });
  }

  return { nodes: [...byRect.values()], screen };
}

/**
 * Is this node a plausible CONTROL, as opposed to a row, section or container?
 *
 * Used only for the unlabeled set. An unlabeled node is addressable purely by
 * position, so offering a big one is actively harmful: on the validation
 * screen the app-bar row (402x56, unlabeled) sits directly above the profile
 * avatar (72x40, unlabeled), and a vision estimate landing between them is
 * nearer to the row. Snapping to a full-width row taps its centre — the middle
 * of the screen — instead of the control the model asked for.
 *
 * (The implementation is the exported {@link isControlSized} next to the tap
 * fusion; this comment is the field record that motivated it.)
 */

export interface MobileCliElement {
  type: string;
  label?: string;
  name?: string;
  /** LOGICAL points — directly tappable, no conversion. */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Everything on screen: labelled elements plus unlabeled control-sized nodes.
 *
 * Sourced from the RAW tree (see {@link parseRawUi}) because the default JSON
 * view drops the element type Flutter labels its rows with. Falls back to that
 * JSON view when the raw dump is unavailable, so an older binary still works.
 */
export async function mobileCliScreen(
  device: string,
): Promise<{ elements: MobileCliElement[]; unlabeled: MobileCliTarget[] }> {
  const parsed = await parseRawUi(device);
  if (parsed) {
    const elements: MobileCliElement[] = [];
    const unlabeled: MobileCliTarget[] = [];
    for (const n of parsed.nodes) {
      if (n.label) {
        elements.push({ type: n.type, label: n.label, name: n.label, rect: n.rect });
      } else if (isControlSized(n, parsed.screen)) {
        unlabeled.push(n);
      }
    }
    return { elements, unlabeled };
  }
  return { elements: await legacyJsonElements(device), unlabeled: [] };
}

/** The pre-raw-tree element source, kept as the fallback path. */
async function legacyJsonElements(device: string): Promise<MobileCliElement[]> {
  const bin = await mobileCliBinary();
  const data = asRecord(envelope(await cli(bin, ["dump", "ui", "--device", device], 45_000)));
  const list = (data.elements as Array<Record<string, unknown>>) ?? [];
  return list
    .filter((e) => e && typeof e === "object" && e.rect)
    .map((e) => {
      const r = asRecord(e.rect);
      return {
        type: String(e.type ?? "Unknown"),
        label: typeof e.label === "string" ? e.label : undefined,
        name: typeof e.name === "string" ? e.name : undefined,
        rect: {
          x: Number(r.x) || 0,
          y: Number(r.y) || 0,
          width: Number(r.width) || 0,
          height: Number(r.height) || 0,
        },
      };
    })
    .filter((e) => e.rect.width >= 8 && e.rect.height >= 8);
}

/**
 * The labelled element tree — GROUND TRUTH for tapping, always tried before a
 * vision estimate.
 */
export async function mobileCliElements(device: string): Promise<MobileCliElement[]> {
  return (await mobileCliScreen(device)).elements;
}

/** Unlabeled control-sized nodes — the snap set for a vision estimate. */
export async function mobileCliTapTargets(device: string): Promise<MobileCliTarget[]> {
  return (await mobileCliScreen(device)).unlabeled;
}

/** Distance from a point to a rect (0 when inside). */
function rectDistance(p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * Snap a vision estimate onto the unlabeled control nearest to it.
 *
 * Scope is deliberately narrow. Anything with a label is reachable through
 * {@link matchElement}, so snapping only ever runs for targets that have none,
 * and only considers unlabeled candidates. The first version of this ignored
 * that and snapped to the nearest node of ANY kind: asked for "Delete My
 * Account" it moved a good estimate (201, 633) onto a labelled "Lock screen
 * Widget" two rows away, turning a near-miss into a confident wrong tap.
 *
 * It also refuses to guess. When the runner-up is comparably close the
 * estimate sits between two controls and there is no evidence for either, so
 * the raw estimate is used instead of inventing certainty. Validated on the
 * profile avatar: estimate (303, 33) is 45.8pt from the avatar and 97.7pt from
 * the next candidate — a clear winner — so it snaps to (366, 90) and lands.
 */
export function snapToTarget(
  point: { x: number; y: number },
  targets: readonly MobileCliTarget[],
  maxDistance = 60,
): MobileCliTarget | undefined {
  const ranked = targets
    .filter((t) => t.unlabeled)
    .map((t) => ({ t, d: rectDistance(point, t.rect) }))
    .filter((c) => c.d <= maxDistance)
    .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.t.rect.width * a.t.rect.height - b.t.rect.width * b.t.rect.height));
  if (!ranked.length) return undefined;
  const [best, next] = ranked;
  // A tie means ambiguity, not a correction. `next.d` of 0 alongside `best.d`
  // of 0 means the estimate is inside two nested controls; the smaller one
  // already won the sort, so only near-equal NONZERO distances are refused.
  if (next && best.d > 0 && next.d < best.d * 1.5) return undefined;
  return best.t;
}

/** Centre of an element's rect, in the logical space taps use. */
export function elementCenter(el: MobileCliElement): { x: number; y: number } {
  return {
    x: Math.round(el.rect.x + el.rect.width / 2),
    y: Math.round(el.rect.y + el.rect.height / 2),
  };
}

/**
 * Best element whose label/name matches a human description.
 *
 * Exact (case-insensitive) beats prefix beats substring, and a smaller rect
 * beats a larger one at equal quality — a description matching both a button
 * and the container holding it should tap the button.
 */
/**
 * Words that introduce a LANDMARK rather than the target ("below the X"), and
 * words that introduce the target itself ("tap the X"). Matched against the
 * text immediately preceding a label, so only the nearest few words count.
 */
const RELATIONAL_LEAD =
  /\b(?:below|above|under|underneath|beneath|over|beside|next\s+to|near|adjacent\s+to|after|before|left\s+of|right\s+of)\s+(?:the\s+|a\s+)?["'\u201c\u201d]?$/i;
const ACTION_LEAD =
  /\b(?:tap|click|press|select|choose|open|hit|toggle|activate)\s+(?:on\s+)?(?:the\s+|a\s+)?["'\u201c\u201d]?$/i;

export function matchElement<T extends { label?: string; name?: string; rect: { x: number; y: number; width: number; height: number } }>(
  elements: readonly T[],
  description: string,
): T | undefined {
  const want = description.trim().toLowerCase();
  if (!want) return undefined;
  const scored: Array<{ el: T; score: number; len: number; at: number }> = [];
  for (const el of elements) {
    for (const raw of [el.label, el.name]) {
      const text = (raw ?? "").trim().toLowerCase();
      if (!text) continue;
      let score = 0;
      if (text === want) score = 3;
      else if (text.startsWith(want) || want.startsWith(text)) score = 2;
      else if (text.includes(want) || want.includes(text)) score = 1;
      if (score > 0) {
        const at = want.indexOf(text);
        const before = at > 0 ? want.slice(0, at) : "";
        // A description that names two on-screen labels almost always names
        // the TARGET and a LANDMARK, and English marks which is which:
        //   "the X row, below Y"      -> Y is the landmark
        //   "In Settings, tap Log Out" -> Log Out is the target
        // So demote a label introduced by a relational preposition, and
        // promote one introduced by an action verb. Position and length alone
        // both get one of those two sentences wrong.
        const bias = RELATIONAL_LEAD.test(before) ? -2 : ACTION_LEAD.test(before) ? 2 : 0;
        scored.push({ el, score: score + bias, len: text.length, at: at < 0 ? want.length : at });
      }
    }
  }
  if (!scored.length) return undefined;
  scored.sort((a, b) => {
    // Score already carries the relational/action bias computed above, which
    // is what separates the target from the landmark it is described against.
    if (b.score !== a.score) return b.score - a.score;
    // Then the more SPECIFIC label — it covers more of the description.
    if (b.len !== a.len) return b.len - a.len;
    // Then the one mentioned first.
    if (a.at !== b.at) return a.at - b.at;
    // Finally the smaller rect: a button over the container holding it.
    return a.el.rect.width * a.el.rect.height - b.el.rect.width * b.el.rect.height;
  });
  return scored[0]!.el;
}

/**
 * A normalized signature of the element tree, for "did the screen change?".
 *
 * Pixel comparison cannot answer that question on its own: the status-bar
 * CLOCK repaints every minute, so two identical screens straddling a minute
 * boundary compare as "changed" and a tap that did nothing reads as a success.
 * The tree has the same hazard (it reports the clock as StaticText), so
 * time-shaped labels are dropped here.
 */
export function screenSignature(elements: readonly MobileCliElement[]): string {
  const TIME = /^\s*\d{1,2}[:.]\d{2}(\s*[   ]?[APap][Mm])?\s*$/;
  return elements
    .filter((e) => !TIME.test(e.label ?? "") && !TIME.test(e.name ?? ""))
    .map((e) => `${e.type}:${e.label ?? e.name ?? ""}@${e.rect.x},${e.rect.y}`)
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// Dual-channel tap resolution
// ---------------------------------------------------------------------------

/**
 * Where a tap coordinate came from, and how much to trust it.
 *
 * `corroborated` is the good case: two INDEPENDENT channels agreed. The whole
 * design exists because each channel fails in a way the other does not.
 */
export type TapConfidence =
  | "corroborated" // vision landed inside the element the description matched
  | "box-overlap" // the vision BOX overlaps this element the most — measured centre
  | "box-in-wrapper" // the box overlaps only a big wrapper; the estimate point is tapped, clamped inside it
  | "vision-in-element" // vision landed inside SOME element; its rect gives the exact centre
  | "element-only" // no usable vision; the element tree answered
  | "vision-only" // nothing in the tree here (canvas, WebView, custom-drawn)
  | "conflict"; // both answered and pointed at different things

export interface TapResolution {
  point: { x: number; y: number };
  confidence: TapConfidence;
  /** One line per channel, for a transcript that can be diagnosed in one read. */
  steps: string[];
  /** True when the two channels disagreed — the caller should say so loudly. */
  conflicted: boolean;
}

/** What the visual channel produced, if it ran at all. */
export interface VisionChannel {
  /** Logical-point estimate, already converted from image pixels. */
  point?: { x: number; y: number };
  /**
   * Logical-rect estimate when the localizer answered with a BOUNDING BOX.
   * Boxes are the preferred currency: they survive the localizer's measured
   * vertical bias (a box 90pt low still overlaps the true control heavily,
   * while a point 90pt low misses it), and they carry the SIZE that separates
   * "the control" from "the wrapper around it" in the overlap fusion.
   */
  box?: { x: number; y: number; width: number; height: number };
  /** The raw image-pixel estimate, for the transcript. */
  imagePoint?: { x: number; y: number };
  /** Why it is unavailable, when `point`/`box` are absent. */
  unavailable?: string;
}

/** What the element channel produced, if the tree had anything. */
export interface ElementChannel {
  /** The element whose label matched the description, if any. */
  matched?: MobileCliTarget;
  /** Every on-screen element, for containment and overlap testing. */
  all: readonly MobileCliTarget[];
  /** Why it is unavailable, when the tree could not be read. */
  unavailable?: string;
  /** The screen, for bias-scaled tolerances and wrapper clamping. */
  screen?: { width: number; height: number };
}

/** The innermost element containing a point — the smallest wins. */
function elementContaining(
  point: { x: number; y: number },
  all: readonly MobileCliTarget[],
): MobileCliTarget | undefined {
  let best: MobileCliTarget | undefined;
  for (const t of all) {
    const r = t.rect;
    if (point.x < r.x || point.x > r.x + r.width || point.y < r.y || point.y > r.y + r.height) continue;
    if (!best || r.width * r.height < best.rect.width * best.rect.height) best = t;
  }
  return best;
}

/** Intersection area of two rects (0 when disjoint). */
function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Rank elements by how much of the SMALLER rect the vision box covers.
 *
 * The asymmetric normalizer is the whole trick. Raw intersection area favors
 * big elements (a full-width row overlaps everything); dividing by the SMALLER
 * area asks "is one of these essentially inside the other?", which is exactly
 * the question when a box estimate must identify an unlabeled control. The
 * measured vertical bias (resolveTap's header) shifts a box down by up to
 * ~10% of the screen — overlap survives that; point containment does not.
 */
export function rankByOverlap(
  box: { x: number; y: number; width: number; height: number },
  elements: readonly MobileCliTarget[],
): Array<{ el: MobileCliTarget; score: number }> {
  const boxArea = Math.max(1, box.width * box.height);
  return elements
    .map((el) => {
      const inter = overlapArea(box, el.rect);
      const score = inter / Math.min(boxArea, Math.max(1, el.rect.width * el.rect.height));
      return { el, score };
    })
    // Score desc; ties go to the SMALLER element — a wrapper that fully
    // contains the box scores 1.0, and so does the control the box actually
    // names; the control is the more specific answer to "what did vision mean".
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.el.rect.width * a.el.rect.height - b.el.rect.width * b.el.rect.height));
}

/**
 * Is this node a plausible CONTROL rather than a row/section/container?
 * Exported for the fusion, which must never move a tap to a wrapper's centre.
 */
export function isControlSized(
  t: { rect: { width: number; height: number } },
  screen: { width: number; height: number },
): boolean {
  return (
    t.rect.width <= screen.width * 0.6 && t.rect.width * t.rect.height <= screen.width * screen.height * 0.15
  );
}

/** Clamp a point into a rect with a small inset, so it stays tappable. */
function clampInto(
  p: { x: number; y: number },
  r: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const inset = Math.min(6, r.width / 4, r.height / 4);
  return {
    x: Math.round(Math.min(Math.max(p.x, r.x + inset), r.x + r.width - inset)),
    y: Math.round(Math.min(Math.max(p.y, r.y + inset), r.y + r.height - inset)),
  };
}

/**
 * Bias-tolerant containment: the point itself, then the point walked UP in
 * measured-bias steps.
 *
 * Why UP, in steps, and only into control-sized elements: the localizer's
 * vertical error is one-directional in every measurement this codebase has
 * (short by 47-90 logical pt on a phone screen — see resolveTap's header), so
 * the true control sits ABOVE a missing estimate, not below it. The steps are
 * small and ordered, so the closest recovery wins. Rows and wrappers are
 * excluded as recovery targets because landing in one relocates the tap to its
 * centre — the exact wrong-tap shape the wrapper guard exists to prevent.
 */
function containingWithBias(
  point: { x: number; y: number },
  all: readonly MobileCliTarget[],
  screen: { width: number; height: number } | undefined,
): { el: MobileCliTarget; shiftedBy: number } | undefined {
  const direct = elementContaining(point, all);
  if (direct) return { el: direct, shiftedBy: 0 };
  if (!screen) return undefined;
  const controlSized = all.filter((t) => isControlSized(t, screen));
  for (const frac of [0.03, 0.06, 0.1]) {
    const dy = Math.round(screen.height * frac);
    const shifted = elementContaining({ x: point.x, y: point.y - dy }, controlSized);
    if (shifted) return { el: shifted, shiftedBy: dy };
  }
  return undefined;
}

function describe(t: MobileCliTarget): string {
  const what = t.label ? `"${t.label}"` : `unlabeled ${t.type}`;
  return `${what} ${Math.round(t.rect.width)}x${Math.round(t.rect.height)} at (${Math.round(t.rect.x)}, ${Math.round(t.rect.y)})`;
}

/**
 * Fuse the visual and element channels into one tap coordinate.
 *
 * WHY BOTH, rather than an order of preference. Measured across every run in
 * this project's history, the two channels fail in disjoint ways:
 *
 *   VISION  — 19 estimates, 0 landed unaided. Horizontal accuracy was
 *             excellent (exactly 0px error on all five attempts at one row);
 *             vertical was short by 139-249px every single time. It knows WHAT
 *             it is looking at and roughly where; it cannot be trusted for a
 *             precise coordinate on a tall screenshot.
 *   ELEMENTS — exact when the target is in the tree, and useless when it is
 *             not: a canvas, a WebView, a custom-drawn control, or anything
 *             scrolled off-screen.
 *
 * So neither can lead alone. Used together, vision does the part it is good at
 * (deciding WHICH thing on screen is meant) and the tree does the part it is
 * good at (saying exactly WHERE that thing is). When only one channel is
 * available the other's absence is not fatal — that is the scroll-view case,
 * where content is visible but unlisted, or listed but off-screen.
 *
 * A disagreement is never silently resolved. It is surfaced, because a
 * disagreement is evidence about the screen and the single most useful thing a
 * failing run can report.
 */
export function resolveTap(vision: VisionChannel, elements: ElementChannel): TapResolution | undefined {
  const steps: string[] = [];
  const matched = elements.matched;
  const visionPoint = vision.point ?? (vision.box ? { x: vision.box.x + vision.box.width / 2, y: vision.box.y + vision.box.height / 2 } : undefined);
  const screen = elements.screen;

  steps.push(
    vision.box
      ? `- Vision box (logical): ${Math.round(vision.box.width)}x${Math.round(vision.box.height)} at (${Math.round(vision.box.x)}, ${Math.round(vision.box.y)})`
      : visionPoint
        ? `- Vision: ${vision.imagePoint ? `image (${vision.imagePoint.x}, ${vision.imagePoint.y}) → ` : ""}logical (${visionPoint.x}, ${visionPoint.y})`
        : `- Vision: unavailable — ${vision.unavailable ?? "no estimate"}`,
  );
  steps.push(
    matched
      ? `- Elements: matched ${describe(matched)}`
      : elements.unavailable
        ? `- Elements: unavailable — ${elements.unavailable}`
        : `- Elements: ${elements.all.length} on screen, none matched the description`,
  );

  // Both channels answered by identity. This is where the corroboration happens.
  if (visionPoint && matched) {
    const r = matched.rect;
    const inside =
      (vision.box ? overlapArea(vision.box, r) > 0 : false) ||
      (visionPoint.x >= r.x && visionPoint.x <= r.x + r.width && visionPoint.y >= r.y && visionPoint.y <= r.y + r.height);
    if (inside) {
      steps.push(`- Agreed: the vision estimate falls inside the matched element — tapping its exact centre.`);
      return { point: matched.center, confidence: "corroborated", steps, conflicted: false };
    }
    // They disagree. The label match is a MEASURED identity while the vision
    // estimate is an estimate with a known vertical bias, so the element wins —
    // but the conflict is reported rather than hidden, because the other
    // possibility is that the description matched the wrong label.
    const alt = elementContaining(visionPoint, elements.all);
    steps.push(
      `- CONFLICT: vision points at ${alt ? describe(alt) : "empty space"}, the description matched ${describe(matched)}. ` +
        `Using the label match (measured identity beats an estimate), but if the screen did not change, the ` +
        `description probably named the wrong element.`,
    );
    return { point: matched.center, confidence: "conflict", steps, conflicted: true };
  }

  // ---- BOX fusion: overlap identifies the element, no label needed ----------
  // The box is the preferred currency (see VisionChannel.box). Overlap ranks
  // every element — labelled or not — by how much of the smaller rect the box
  // covers. The box is also tried LIFTED by the localizer's measured vertical
  // bias steps (3%/6%/10% of the screen, one-directional, always short): an
  // 80pt-low box has ZERO overlap with a 44pt icon no matter the normaliser,
  // while the lifted box sits on it exactly — same recovery the point path
  // gets, applied before ranking instead of after it fails.
  if (vision.box) {
    const shifts = screen ? [0, 0.03, 0.06, 0.1].map((f) => Math.round(screen.height * f)) : [0];
    let best: { el: MobileCliTarget; score: number } | undefined;
    let next: { el: MobileCliTarget; score: number } | undefined;
    let effectiveBox = vision.box;
    for (const dy of shifts) {
      const shifted = { ...vision.box, y: vision.box.y - dy };
      const ranked = rankByOverlap(shifted, elements.all);
      const [b, n] = ranked;
      if (b && (!best || b.score > best.score)) {
        best = b;
        next = n;
        effectiveBox = shifted;
      }
    }
    const boxCenter = { x: effectiveBox.x + effectiveBox.width / 2, y: effectiveBox.y + effectiveBox.height / 2 };
    // "Clear" means an unambiguous CONTROL. A wrapper scoring as high as the
    // control does not make it ambiguous — any box inside a row's x-span
    // overlaps the row completely, so wrapper containment is geometrically
    // inevitable and carries no identity signal at all. Only a comparable
    // CONTROL-class rival makes the answer genuinely ambiguous.
    const clear =
      !!best && best.score >= 0.35 && isControlSized(best.el, screen ?? { width: Infinity, height: Infinity }) &&
      (!next || next.score < best.score * 0.75 || !isControlSized(next.el, screen ?? { width: Infinity, height: Infinity }));
    if (best && best.score > 0 && screen) {
      if (clear && isControlSized(best.el, screen)) {
        steps.push(
          `- Identified by overlap: the box${effectiveBox.y < vision.box.y ? ` (raised ${Math.round(vision.box.y - effectiveBox.y)}pt — the localizer's measured vertical bias)` : ""} ` +
            `covers ${Math.round(best.score * 100)}% of ${describe(best.el)}${best.el.label ? "" : " (no label — identified by geometry alone)"} — tapping its exact centre.`,
        );
        return { point: best.el.center, confidence: "box-overlap", steps, conflicted: false };
      }
      if (best.score >= 0.35 && next && !isControlSized(best.el, screen) && isControlSized(next.el, screen) && next.score >= best.score * 0.5) {
        // The top hit is a wrapper and a control-sized element sits just behind
        // it: the wrapper's overlap is inflated by its size, not by identity.
        // Prefer the control — the wrapper guard below explains why its own
        // centre must never be tapped.
        steps.push(
          `- Identified by overlap: the box sits inside ${describe(best.el)} but covers ${Math.round(next.score * 100)}% of ` +
            `${describe(next.el)} — the control wins over its container. Tapping the control's centre.`,
        );
        return { point: next.el.center, confidence: "box-overlap", steps, conflicted: false };
      }
      // Only a WRAPPER-class element overlaps (the control itself has no tree
      // node). The wrapper's centre is meaningless — tapping it would move the
      // point away from where the estimate pointed (a trailing icon in a row
      // would become a tap on the row's middle). Clamp the estimate inside the
      // wrapper instead: same tappable bounds, no relocation.
      if (best.score >= 0.35 && !isControlSized(best.el, screen)) {
        const p = clampInto(boxCenter, best.el.rect);
        steps.push(
          `- Overlap is a wrapper (${describe(best.el)}), not a control — tapping the estimate itself ` +
            `(clamped inside the wrapper to (${p.x}, ${p.y})); the wrapper's centre is NOT the target.`,
        );
        return { point: p, confidence: "box-in-wrapper", steps, conflicted: false };
      }
    }
    // No usable overlap: fall through to the point path.
  }

  // Vision only (point currency). Either the tree is empty here, or nothing
  // matched by label. Snap onto whatever element the estimate identifies —
  // directly, or through the measured vertical bias — which is how an
  // unlabeled avatar or a bare GestureDetector becomes reachable.
  if (visionPoint) {
    const biased = containingWithBias(visionPoint, elements.all, screen);
    if (biased) {
      const { el, shiftedBy } = biased;
      if (screen && !isControlSized(el, screen)) {
        // The smallest containing element is a wrapper: its centre is not the
        // target (a trailing icon in a full-width row would become a tap on
        // the row's middle). The estimate pointed somewhere real — keep it,
        // clamped into the wrapper's tappable bounds.
        const p = clampInto(visionPoint, el.rect);
        steps.push(
          `- Estimate lands in ${describe(el)} — a wrapper, not a control — so the estimate is tapped ` +
            `(clamped to (${p.x}, ${p.y})); the wrapper's centre is NOT the target.`,
        );
        return { point: p, confidence: "box-in-wrapper", steps, conflicted: false };
      }
      // IDENTIFICATION BY POSITION. The element has no usable label, so it
      // could never be found by description — but the estimate landed inside
      // it (possibly after the measured-bias correction), which identifies it
      // just as well. Vision says WHICH, the rect says WHERE, and the exact
      // centre beats the estimate that found it.
      steps.push(
        `- Identified by position: the estimate${shiftedBy ? ` (raised ${shiftedBy}pt — the localizer's measured vertical bias)` : ""} ` +
          `lands inside ${describe(el)}${el.label ? "" : " (no label — identified only because the estimate is inside it)"} — tapping its exact centre.`,
      );
      return { point: el.center, confidence: "vision-in-element", steps, conflicted: false };
    }
    const snapMax = screen ? Math.max(60, Math.round(screen.height * 0.1)) : 60;
    const snapped = snapToTarget(visionPoint, elements.all, snapMax);
    if (snapped) {
      if (screen && !isControlSized(snapped, screen)) {
        // Same wrapper guard as the containment path: a proximity snap onto a
        // row would tap the row's CENTRE — the middle of the screen — when the
        // estimate pointed somewhere specific inside it. Clamp instead.
        const p = clampInto(visionPoint, snapped.rect);
        steps.push(
          `- Nearest unlabeled node is a wrapper (${describe(snapped)}) — tapping the estimate itself ` +
            `(clamped to (${p.x}, ${p.y})); the wrapper's centre is NOT the target.`,
        );
        return { point: p, confidence: "box-in-wrapper", steps, conflicted: false };
      }
      steps.push(
        `- Identified by proximity: nearest unlabeled control is ${describe(snapped)} — tapping its exact centre.`,
      );
      return { point: snapped.center, confidence: "vision-in-element", steps, conflicted: false };
    }
    steps.push(`- No element here — tapping the visual estimate directly (canvas, WebView or custom-drawn UI).`);
    return { point: visionPoint, confidence: "vision-only", steps, conflicted: false };
  }

  // Element only — vision did not run or could not answer.
  if (matched) {
    steps.push(`- Vision unavailable, so the element tree decides — tapping its exact centre.`);
    return { point: matched.center, confidence: "element-only", steps, conflicted: false };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Input — every coordinate is a LOGICAL point (see the contract at the top)
// ---------------------------------------------------------------------------

/** Run a command that only reports success/failure. */
async function ok(args: string[], timeoutMs = 30_000): Promise<boolean> {
  try {
    const bin = await mobileCliBinary();
    await cli(bin, args, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function mobileCliTap(device: string, x: number, y: number): Promise<boolean> {
  return ok(["io", "tap", "--device", device, `${Math.round(x)},${Math.round(y)}`]);
}

export async function mobileCliLongPress(device: string, x: number, y: number): Promise<boolean> {
  return ok(["io", "longpress", "--device", device, `${Math.round(x)},${Math.round(y)}`]);
}

export async function mobileCliSwipe(
  device: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<boolean> {
  const coords = [from.x, from.y, to.x, to.y].map((n) => Math.round(n)).join(",");
  return ok(["io", "swipe", "--device", device, coords]);
}

export async function mobileCliTypeText(device: string, text: string): Promise<boolean> {
  return ok(["io", "text", "--device", device, text], 45_000);
}

export async function mobileCliKeys(device: string, combos: readonly string[]): Promise<boolean> {
  if (!combos.length) return false;
  return ok(["io", "keys", "--device", device, ...combos]);
}

export async function mobileCliButton(device: string, button: string): Promise<boolean> {
  return ok(["io", "button", "--device", device, button]);
}

// ---------------------------------------------------------------------------
// Apps & navigation
// ---------------------------------------------------------------------------

export async function mobileCliLaunch(device: string, bundleId: string): Promise<boolean> {
  return ok(["apps", "launch", bundleId, "--device", device], 60_000);
}

export async function mobileCliTerminate(device: string, bundleId: string): Promise<boolean> {
  return ok(["apps", "terminate", bundleId, "--device", device], 60_000);
}

export async function mobileCliInstall(device: string, appPath: string): Promise<boolean> {
  return ok(["apps", "install", appPath, "--device", device], 300_000);
}

export interface MobileCliApp {
  packageName: string;
  appName?: string;
  version?: string;
}

/** `apps list` answers with a bare ARRAY in `data` (not `data.apps`). */
export async function mobileCliListApps(device: string): Promise<MobileCliApp[]> {
  const bin = await mobileCliBinary();
  const data = envelope(await cli(bin, ["apps", "list", "--device", device], 60_000));
  const list = Array.isArray(data) ? data : ((asRecord(data).apps as unknown[]) ?? []);
  return (list as Array<Record<string, unknown>>)
    .filter((a) => a && typeof a.packageName === "string")
    .map((a) => ({
      packageName: String(a.packageName),
      appName: typeof a.appName === "string" ? a.appName : undefined,
      version: typeof a.version === "string" ? a.version : undefined,
    }));
}

export async function mobileCliForegroundApp(device: string): Promise<MobileCliApp | undefined> {
  try {
    const bin = await mobileCliBinary();
    const d = asRecord(envelope(await cli(bin, ["apps", "foreground", "--device", device], 30_000)));
    if (typeof d.packageName !== "string") return undefined;
    return {
      packageName: d.packageName,
      appName: typeof d.appName === "string" ? d.appName : undefined,
      version: typeof d.version === "string" ? d.version : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Open a URL or custom-scheme deep link (`myapp://path`). */
export async function mobileCliOpenUrl(device: string, url: string): Promise<boolean> {
  return ok(["url", url, "--device", device], 60_000);
}

// ---------------------------------------------------------------------------
// The harness-facing tools
// ---------------------------------------------------------------------------

/**
 * Resolve the device to act on: the id given, else the first booted one.
 *
 * Every tool below takes `device` as OPTIONAL for this reason — in the
 * overwhelmingly common one-simulator case, making the model thread a UUID
 * through every call is pure failure surface.
 */
async function resolveDevice(given: unknown): Promise<{ id?: string; error?: string }> {
  const explicit = given ? String(given).trim() : "";
  if (explicit) return { id: explicit };
  const devices = await mobileCliDevices();
  if (!devices.length) {
    return {
      error:
        "No booted device or simulator. Boot one (`xcrun simctl boot <id>` / `emulator -avd <name>`), " +
        "or pass `device` explicitly. `mobile_devices` with `includeOffline` lists what exists.",
    };
  }
  return { id: devices[0]!.id };
}

const DEVICE_PROP: Record<string, JSONSchema> = {
  device: {
    type: "string",
    description: "Device id (from `mobile_devices`). Omit to use the only booted device.",
  },
};

function err(output: string): ToolResult {
  return { output, isError: true };
}

/**
 * The full device toolkit, backed by `mobilecli`.
 *
 * Names are backend-neutral (`mobile_*`) rather than `mobilecli_*`: they
 * describe the capability, and the harness has exactly one device backend.
 */
export function mobileCliTools(): AgentTool[] {
  const devices: AgentTool = {
    name: "mobile_devices",
    description:
      "List iOS/Android devices, simulators and emulators. Returns ids to pass as `device`, " +
      "plus platform/type/version.",
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        includeOffline: { type: "boolean", description: "Include shut-down simulators/emulators." },
        platform: { type: "string", enum: ["ios", "android"] },
      },
    },
    async execute(_id, args) {
      const list = await mobileCliDevices({
        includeOffline: args?.includeOffline === true,
        ...(args?.platform ? { platform: String(args.platform) as "ios" | "android" } : {}),
      });
      if (!list.length) {
        return {
          output:
            "No devices found. Boot a simulator/emulator, or retry with `includeOffline: true` to see " +
            "what exists on this machine.",
        };
      }
      return { output: JSON.stringify({ devices: list }, null, 2) };
    },
  };

  const info: AgentTool = {
    name: "mobile_device_info",
    description:
      "Device details INCLUDING screen size in logical points and the scale factor. Screen size is " +
      "the coordinate space every tap/swipe uses.",
    mutates: false,
    parameters: { type: "object", properties: { ...DEVICE_PROP } },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const detail = await mobileCliDeviceInfo(id);
      if (!detail) return err(`mobile_device_info: could not read info for \`${id}\`.`);
      const s = detail.screen;
      return {
        output:
          JSON.stringify(detail, null, 2) +
          (s
            ? `\n\nTaps and element rects use LOGICAL POINTS: ${s.width}x${s.height}. ` +
              `Screenshots come back at ${s.width * s.scale}x${s.height * s.scale} px (scale ${s.scale}) — ` +
              `divide a screenshot coordinate by ${s.scale} before tapping it.`
            : ""),
      };
    },
  };

  const screenshot: AgentTool = {
    name: "mobile_screenshot",
    description:
      "Capture a NATIVE-resolution PNG of the device screen. Returns the image inline; pass `saveTo` to " +
      "also write it to disk (needed when another tool reads it by path, e.g. `media_analysis`).",
    mutates: false,
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_PROP,
        saveTo: { type: "string", description: "Absolute .png path to also write the capture to." },
      },
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const shot = await mobileCliScreenshot(id);
      if (!shot) return err(`mobile_screenshot: capture failed for \`${id}\`.`);
      // `saveTo` exists because `media_analysis` reads by PATH. Without it the
      // only way to hand a capture to the analyzer was to re-capture through a
      // different tool, which is how a run ended up comparing two different
      // screens and calling the difference a regression.
      let saved = "";
      const target = args?.saveTo ? String(args.saveTo) : "";
      if (target) {
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, Buffer.from(shot.data, "base64"));
          saved = target;
        } catch (e) {
          return err(`mobile_screenshot: captured, but could not write \`${target}\`: ${(e as Error).message}`);
        }
      }
      return {
        output: saved ? `saved ${saved}` : "ok",
        content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }],
        ...(saved ? { details: { path: saved } } : {}),
      };
    },
  };

  const elements: AgentTool = {
    name: "mobile_elements",
    description:
      "List on-screen elements with their LOGICAL-POINT rects and centres — exact tap coordinates, " +
      "no estimation. Try this before any vision-based tap. Note it omits views that never reach the " +
      "accessibility tree (Flutter GestureDetectors, some icon-only buttons).",
    mutates: false,
    parameters: { type: "object", properties: { ...DEVICE_PROP } },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      try {
        // ONE device round trip for both halves. Unlabeled nodes are the
        // controls no label can name — an avatar, an icon-only button, a bare
        // GestureDetector — and without them the only way to reach one is a
        // vision guess, which is how four production runs ended up tapping the
        // status bar instead of the profile avatar.
        const { elements: list, unlabeled } = await mobileCliScreen(id);
        if (!list.length && !unlabeled.length) {
          return {
            output:
              "The element tree is empty for this screen. That does NOT mean the screen is blank — it " +
              "means nothing on it reaches the accessibility tree. Screenshot it and tap by vision " +
              "(`mobile_tap` accepts logical points; divide screenshot pixels by the scale factor).",
          };
        }
        return {
          output: JSON.stringify(
            {
              space: "logical-points",
              elements: list.map((e) => ({ ...e, center: elementCenter(e) })),
              ...(unlabeled.length
                ? {
                    unlabeledTargets: unlabeled.map((t) => ({ rect: t.rect, center: t.center })),
                    unlabeledNote:
                      "Tappable nodes with NO accessibility label — icon-only buttons, avatars, " +
                      "GestureDetectors. Identify one by its position and size, then tap its `center`.",
                  }
                : {}),
            },
            null,
            2,
          ),
        };
      } catch (e) {
        return err(`mobile_elements failed: ${(e as Error).message}`);
      }
    },
  };

  const tap: AgentTool = {
    name: "mobile_tap",
    description:
      "Tap at LOGICAL POINT coordinates (the space `mobile_device_info` reports and `mobile_elements` " +
      "returns). A screenshot pixel must be divided by the scale factor first.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const x = Number(args?.x);
      const y = Number(args?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return err("mobile_tap: x and y must be numbers.");
      const detail = await mobileCliDeviceInfo(id);
      const screen = detail?.screen;
      // Out-of-bounds is the physical-pixel mistake: a 1098,271 tap on a 402pt
      // screen reports ok and silently does nothing. Catch it here rather than
      // letting the caller conclude "the tap tool is broken".
      if (screen && (x > screen.width || y > screen.height)) {
        return err(
          `mobile_tap: (${x}, ${y}) is outside the ${screen.width}x${screen.height} pt screen, so it would ` +
            `be dropped silently. These look like PHYSICAL PIXELS — divide by the scale factor ` +
            `(${screen.scale}) to get logical points: (${Math.round(x / screen.scale)}, ${Math.round(y / screen.scale)}).`,
        );
      }
      const done = await mobileCliTap(id, x, y);
      return done ? { output: `tapped (${Math.round(x)}, ${Math.round(y)})` } : err("mobile_tap failed.");
    },
  };

  const longPress: AgentTool = {
    name: "mobile_long_press",
    description: "Long-press at LOGICAL POINT coordinates.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const done = await mobileCliLongPress(id, Number(args?.x), Number(args?.y));
      return done ? { output: "long-pressed" } : err("mobile_long_press failed.");
    },
  };

  const swipe: AgentTool = {
    name: "mobile_swipe",
    description:
      "Swipe between two LOGICAL POINT coordinates — scrolling, carousels, sheet dismissal.",
    mutates: true,
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_PROP,
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const done = await mobileCliSwipe(
        id,
        { x: Number(args?.x1), y: Number(args?.y1) },
        { x: Number(args?.x2), y: Number(args?.y2) },
      );
      return done ? { output: "swiped" } : err("mobile_swipe failed.");
    },
  };

  const typeText: AgentTool = {
    name: "mobile_type_text",
    description: "Type text into the focused field. Tap the field first.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, text: { type: "string" } },
      required: ["text"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const done = await mobileCliTypeText(id, String(args?.text ?? ""));
      return done ? { output: "typed" } : err("mobile_type_text failed.");
    },
  };

  const pressButton: AgentTool = {
    name: "mobile_press_button",
    description: "Press a hardware button: HOME, VOLUME_UP, VOLUME_DOWN, POWER.",
    mutates: true,
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_PROP,
        button: { type: "string", enum: ["HOME", "VOLUME_UP", "VOLUME_DOWN", "POWER"] },
      },
      required: ["button"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const done = await mobileCliButton(id, String(args?.button ?? "HOME"));
      return done ? { output: "pressed" } : err("mobile_press_button failed.");
    },
  };

  const launch: AgentTool = {
    name: "mobile_launch_app",
    description: "Launch or foreground an app by bundle id / package name.",
    mutates: true,
    parameters: {
      type: "object",
      properties: {
        ...DEVICE_PROP,
        bundleId: { type: "string", description: "iOS bundle id or Android package name." },
      },
      required: ["bundleId"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const bundleId = String(args?.bundleId ?? "");
      const done = await mobileCliLaunch(id, bundleId);
      return done
        ? { output: `launched ${bundleId}` }
        : err(
            `mobile_launch_app: could not launch \`${bundleId}\`. Check it is installed — ` +
              `\`mobile_list_apps\` shows what is.`,
          );
    },
  };

  const terminate: AgentTool = {
    name: "mobile_terminate_app",
    description: "Terminate a running app — the reliable way to force a cold start.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, bundleId: { type: "string" } },
      required: ["bundleId"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const done = await mobileCliTerminate(id, String(args?.bundleId ?? ""));
      return done ? { output: "terminated" } : err("mobile_terminate_app failed.");
    },
  };

  const listApps: AgentTool = {
    name: "mobile_list_apps",
    description: "List installed apps with bundle ids — use it to find the id to launch.",
    mutates: false,
    parameters: { type: "object", properties: { ...DEVICE_PROP } },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      try {
        return { output: JSON.stringify({ apps: await mobileCliListApps(id) }, null, 2) };
      } catch (e) {
        return err(`mobile_list_apps failed: ${(e as Error).message}`);
      }
    },
  };

  const foreground: AgentTool = {
    name: "mobile_foreground_app",
    description: "Which app is in the foreground — confirms a launch actually took effect.",
    mutates: false,
    parameters: { type: "object", properties: { ...DEVICE_PROP } },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const app = await mobileCliForegroundApp(id);
      return app ? { output: JSON.stringify(app) } : err("mobile_foreground_app: nothing reported.");
    },
  };

  const openUrl: AgentTool = {
    name: "mobile_open_url",
    description:
      "Open a URL or custom-scheme deep link (`myapp://path`) — the fastest way to reach a specific " +
      "screen without tapping through the UI.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, url: { type: "string" } },
      required: ["url"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const url = String(args?.url ?? "");
      const done = await mobileCliOpenUrl(id, url);
      return done ? { output: `opened ${url}` } : err(`mobile_open_url: could not open \`${url}\`.`);
    },
  };

  const install: AgentTool = {
    name: "mobile_install_app",
    description: "Install a built app (.app/.ipa/.zip for iOS, .apk for Android).",
    mutates: true,
    parameters: {
      type: "object",
      properties: { ...DEVICE_PROP, path: { type: "string", description: "Path to the built app." } },
      required: ["path"],
    },
    async execute(_id, args) {
      const { id, error } = await resolveDevice(args?.device);
      if (!id) return err(error!);
      const appPath = String(args?.path ?? "");
      const done = await mobileCliInstall(id, appPath);
      return done ? { output: `installed ${appPath}` } : err(`mobile_install_app: install failed for \`${appPath}\`.`);
    },
  };

  return [
    devices,
    info,
    screenshot,
    elements,
    tap,
    longPress,
    swipe,
    typeText,
    pressButton,
    launch,
    terminate,
    listApps,
    foreground,
    openUrl,
    install,
  ];
}
