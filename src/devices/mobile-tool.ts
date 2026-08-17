/**
 * `mobile` — ONE tool for driving a device.
 *
 * WHY one tool, when this codebase deliberately exposes one tool per step
 * elsewhere: that rule exists to stop a tool from hiding an LLM SUB-LOOP, where
 * minutes pass with no visible reasoning and nothing reaches the transcript or
 * the permission gate (see the activity-monitor provider). Nothing of the sort
 * happens here. Target resolution is deterministic code — a screenshot, a UI
 * tree, and the fusion in `resolveTap` — so a single call replaces a sequence
 * the model used to have to orchestrate by hand:
 *
 *   before: mobile_screenshot -> media_analysis -> mobile_device_info ->
 *           arithmetic -> mobile_tap -> mobile_screenshot (to confirm)
 *   after:  mobile { action: "tap", target: "the Delete My Account row" }
 *
 * Every step it took is still narrated in the RESULT, which is what actually
 * made runs debuggable — the visibility was never in the call count.
 *
 * The fifteen primitives this replaces are still exported from mobilecli.ts and
 * used internally; they are simply no longer fifteen entries in the model's
 * tool list and fifteen rows in the UI.
 */
import type { AgentTool, ToolResult, JSONSchema } from "../types.js";
import { tapVisualAction } from "../tools/builtin/activity-monitor.js";
import {
  elementCenter,
  mobileCliAvailable,
  matchElement,
  mobileCliButton,
  mobileCliDeviceInfo,
  mobileCliDevices,
  mobileCliForegroundApp,
  mobileCliInstall,
  mobileCliLaunch,
  mobileCliListApps,
  mobileCliLongPress,
  mobileCliOpenUrl,
  mobileCliScreen,
  mobileCliScreenshot,
  mobileCliSwipe,
  mobileCliTap,
  mobileCliTerminate,
  mobileCliTypeText,
  type MobileCliTarget,
} from "./mobilecli.js";

/** The actions `mobile` accepts. Kept small on purpose. */
export const MOBILE_ACTIONS = [
  "look",
  "tap",
  "longpress",
  "swipe",
  "type",
  "press",
  "open",
  "launch",
  "terminate",
  "install",
  "apps",
  "devices",
] as const;
export type MobileAction = (typeof MOBILE_ACTIONS)[number];

/**
 * Canonical per-action tool name, for anything that classifies by tool name.
 *
 * The QA gate decides what counts as a capture, a drive, a coordinate tap or a
 * position analysis from the tool NAME. Collapsing fifteen names into one would
 * have made every one of those rules unable to tell a screenshot from a tap, so
 * `mobile { action }` maps back onto the names those rules already know. The
 * gate keeps its existing lists; only the lookup changes.
 */
export function mobileActionToolName(action: string | undefined): string | undefined {
  switch (action) {
    // `look` both photographs the screen AND returns exact element rects, so it
    // is a capture and a position analysis at once.
    case "look":
      return "mobile_elements";
    case "tap":
      return "mobile_tap";
    case "longpress":
      return "mobile_long_press";
    case "swipe":
      return "mobile_swipe";
    case "type":
      return "mobile_type_text";
    case "press":
      return "mobile_press_button";
    case "open":
      return "mobile_open_url";
    case "launch":
      return "mobile_launch_app";
    case "terminate":
      return "mobile_terminate_app";
    case "install":
      return "mobile_install_app";
    case "apps":
      return "mobile_list_apps";
    case "devices":
      return "mobile_devices";
    default:
      return undefined;
  }
}

const PARAMS: Record<string, JSONSchema> = {
  action: {
    type: "string",
    enum: [...MOBILE_ACTIONS],
    description:
      "look = screenshot + every on-screen element; tap/longpress/swipe/type/press/open = drive the UI; " +
      "launch/terminate/install/apps = manage the app; devices = what is connected.",
  },
  target: {
    type: "string",
    description:
      "What to act on, DESCRIBED as you would to a person (\"the Delete My Account row\", \"the profile " +
      "avatar top right\"). Exact `x,y` LOGICAL POINTS are accepted too, but a description is safer — it " +
      "is resolved against the live screen, coordinates are not.",
  },
  to: { type: "string", description: "swipe: destination, as `x,y` logical points or up/down/left/right." },
  text: { type: "string", description: "type: the text to enter. Tap the field first." },
  button: { type: "string", enum: ["HOME", "VOLUME_UP", "VOLUME_DOWN", "POWER"] },
  url: { type: "string", description: "open: a URL or custom-scheme deep link (`myapp://path`)." },
  bundleId: {
    type: "string",
    description:
      "launch/terminate: iOS bundle id or Android package name. On `tap` it foregrounds the app first.",
  },
  path: { type: "string", description: "install: path to the built .app/.ipa/.apk." },
  saveTo: { type: "string", description: "look: also write the screenshot to this absolute .png path." },
  device: { type: "string", description: "Device id. Omit to use the only booted device." },
};

function err(output: string): ToolResult {
  return { output, isError: true };
}

/** Parse an `x,y` pair, if the target is coordinates rather than a description. */
function asPoint(target: string | undefined): { x: number; y: number } | undefined {
  const m = (target ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function resolveDevice(given: unknown): Promise<{ id?: string; error?: string }> {
  const explicit = given ? String(given).trim() : "";
  if (explicit) return { id: explicit };
  const devices = await mobileCliDevices();
  if (!devices.length) {
    return {
      error:
        "No booted device or simulator. Boot one (`xcrun simctl boot <id>` / `emulator -avd <name>`), or pass " +
        "`device`. `mobile { action: \"devices\" }` lists what exists.",
    };
  }
  return { id: devices[0]!.id };
}

/** Render the element list the way `look` reports it. */
interface LabelledElement {
  type: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

function renderScreen(labelled: readonly LabelledElement[], unlabeled: readonly MobileCliTarget[]) {
  return {
    space: "logical-points",
    elements: labelled.map((e) => ({
      type: e.type,
      ...(e.label ? { label: e.label } : {}),
      rect: e.rect,
      center: { x: Math.round(e.rect.x + e.rect.width / 2), y: Math.round(e.rect.y + e.rect.height / 2) },
    })),
    ...(unlabeled.length
      ? {
          unlabeledTargets: unlabeled.map((t) => ({ rect: t.rect, center: t.center })),
          unlabeledNote:
            "Tappable nodes with NO accessibility label — icon-only buttons, avatars, GestureDetectors. " +
            "Describe one to `tap` and it is identified by position, or tap its `center` directly.",
        }
      : {}),
  };
}

/**
 * Resolve a swipe destination: explicit `x,y`, or a direction from the origin.
 * Directions are expressed against the screen so "up" scrolls content up.
 */
function swipeTo(
  from: { x: number; y: number },
  to: string | undefined,
  screen: { width: number; height: number } | undefined,
): { x: number; y: number } | undefined {
  const point = asPoint(to);
  if (point) return point;
  const w = screen?.width ?? 0;
  const h = screen?.height ?? 0;
  if (!w || !h) return undefined;
  const dy = Math.round(h * 0.35);
  const dx = Math.round(w * 0.35);
  switch ((to ?? "").trim().toLowerCase()) {
    case "up":
      return { x: from.x, y: Math.max(1, from.y - dy) };
    case "down":
      return { x: from.x, y: Math.min(h - 1, from.y + dy) };
    case "left":
      return { x: Math.max(1, from.x - dx), y: from.y };
    case "right":
      return { x: Math.min(w - 1, from.x + dx), y: from.y };
    default:
      return undefined;
  }
}

export function createMobileTool(): AgentTool {
  return {
    name: "mobile",
    description:
      "Drive an iOS/Android device or simulator. `look` returns a screenshot AND every on-screen element " +
      "with exact coordinates. `tap` takes a DESCRIPTION and resolves it against the live screen by fusing " +
      "the visual estimate with the UI tree — so it works on labelled controls, on icon-only ones with no " +
      "label, and on custom-drawn UI with no tree at all. All coordinates are LOGICAL POINTS.",
    mutates: true,
    // Inspect-ONLY in v2: device automation is the QA pass's surface. The work
    // pass "just checking on a device" is doing the next hop's job with none of
    // its instrumentation (see the category-leaks test).
    categorizers: ["activity_inspect"],
    parameters: { type: "object", properties: PARAMS, required: ["action"] },
    async execute(id, args, ctx) {
      const action = String(args?.action ?? "").trim() as MobileAction;
      if (!MOBILE_ACTIONS.includes(action)) {
        return err(`mobile: unknown action "${action}". Expected one of: ${MOBILE_ACTIONS.join(", ")}.`);
      }

      // Availability first: every branch below shells out, and without this a
      // missing binary surfaces as a raw spawn error instead of the one thing
      // the caller can act on.
      if (!(await mobileCliAvailable())) {
        return err(
          "mobile: the `mobilecli` binary is not installed — it is what drives the device. " +
            "Install it with `brew install mobile-next/tap/mobilecli`, then retry. " +
            "A booted simulator can still be captured by `activity_inspect` without it.",
        );
      }

      if (action === "devices") {
        const list = await mobileCliDevices({ includeOffline: true });
        if (!list.length) return { output: "No devices found. Boot a simulator or connect a device." };
        const booted = list.filter((d) => d.state === "online" || d.state === "booted");
        const info = booted[0] ? await mobileCliDeviceInfo(booted[0].id) : undefined;
        return {
          output: JSON.stringify(
            {
              devices: list,
              ...(info?.screen
                ? {
                    screen: info.screen,
                    note:
                      `Taps and element rects use LOGICAL POINTS: ${info.screen.width}x${info.screen.height}. ` +
                      `Screenshots are ${info.screen.width * info.screen.scale}x${info.screen.height * info.screen.scale} px ` +
                      `(scale ${info.screen.scale}).`,
                  }
                : {}),
            },
            null,
            2,
          ),
        };
      }

      const { id: device, error } = await resolveDevice(args?.device);
      if (!device) return err(error!);

      switch (action) {
        case "look": {
          const shot = await mobileCliScreenshot(device);
          const { elements, unlabeled } = await mobileCliScreen(device);
          if (!shot && !elements.length && !unlabeled.length) {
            return err("mobile look: could not capture the screen or read its elements.");
          }
          if (args?.saveTo && shot) {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const target = String(args.saveTo);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, Buffer.from(shot.data, "base64"));
          }
          return {
            output: JSON.stringify(renderScreen(elements, unlabeled), null, 2),
            ...(shot ? { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] } : {}),
            ...(args?.saveTo && shot ? { details: { path: String(args.saveTo) } } : {}),
          };
        }

        case "tap": {
          const target = args?.target ? String(args.target) : "";
          if (!target) return err('mobile tap: `target` is required — describe what to tap, or give "x,y".');
          const point = asPoint(target);
          if (point) {
            // Explicit coordinates: the caller has already decided. Bounds are
            // still checked, because an out-of-range tap is silently dropped by
            // the driver and reads as a broken tool.
            const info = await mobileCliDeviceInfo(device);
            const s = info?.screen;
            if (s && (point.x > s.width || point.y > s.height)) {
              return err(
                `mobile tap: (${point.x}, ${point.y}) is outside the ${s.width}x${s.height} pt screen, so it would ` +
                  `be dropped silently. These look like PHYSICAL PIXELS — divide by ${s.scale}: ` +
                  `(${Math.round(point.x / s.scale)}, ${Math.round(point.y / s.scale)}).`,
              );
            }
            const ok = await mobileCliTap(device, point.x, point.y);
            return ok ? { output: `tapped (${Math.round(point.x)}, ${Math.round(point.y)})` } : err("mobile tap failed.");
          }
          // A description: the fused resolver decides, and narrates how.
          // `bundleId` foregrounds the app first, so "launch it and tap X" is
          // one call — and a launch that fails stops before tapping whatever
          // happened to be on screen.
          return tapVisualAction(
            { element: target, device, retries: 1, ...(args?.bundleId ? { bundleId: String(args.bundleId) } : {}) },
            ctx,
          );
        }

        case "longpress": {
          // Context menus and drag handles. Resolved the same way as `tap`,
          // but without the vision fallback: a long press on the wrong thing is
          // more disruptive than a missed tap, so it only fires on evidence —
          // exact coordinates, or a label the tree actually reports.
          const raw = args?.target ? String(args.target) : "";
          if (!raw) return err('mobile longpress: `target` is required — a description or "x,y".');
          let point = asPoint(raw);
          if (!point) {
            const { elements } = await mobileCliScreen(device);
            const hit = matchElement(elements, raw);
            if (!hit) {
              return err(
                `mobile longpress: nothing on screen matches "${raw}". Use \`look\` to see what is there, ` +
                  `or pass exact \`x,y\` logical points.`,
              );
            }
            point = elementCenter(hit);
          }
          const ok = await mobileCliLongPress(device, point.x, point.y);
          return ok ? { output: `long-pressed (${point.x}, ${point.y})` } : err("mobile longpress failed.");
        }

        case "swipe": {
          const info = await mobileCliDeviceInfo(device);
          const screen = info?.screen;
          let from = asPoint(args?.target ? String(args.target) : undefined);
          if (!from) {
            // No origin given: swipe from the middle of the screen, which is
            // what "scroll this list" means in practice.
            if (!screen) return err("mobile swipe: give `target` as `x,y` — the screen size is unknown.");
            from = { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
          }
          const to = swipeTo(from, args?.to ? String(args.to) : undefined, screen);
          if (!to) return err('mobile swipe: `to` must be `x,y` or one of up/down/left/right.');
          const ok = await mobileCliSwipe(device, from, to);
          return ok
            ? { output: `swiped (${from.x}, ${from.y}) → (${to.x}, ${to.y})` }
            : err("mobile swipe failed.");
        }

        case "type": {
          const text = args?.text === undefined ? "" : String(args.text);
          if (!text) return err("mobile type: `text` is required.");
          // A `target` means "focus this first" — the common two-step that
          // otherwise fails silently when nothing is focused.
          if (args?.target) {
            const { elements } = await mobileCliScreen(device);
            const hit = matchElement(elements, String(args.target));
            if (hit) await mobileCliTap(device, elementCenter(hit).x, elementCenter(hit).y);
          }
          const ok = await mobileCliTypeText(device, text);
          return ok ? { output: "typed" } : err("mobile type failed.");
        }

        case "press": {
          const ok = await mobileCliButton(device, String(args?.button ?? "HOME"));
          return ok ? { output: "pressed" } : err("mobile press failed.");
        }

        case "open": {
          const url = String(args?.url ?? args?.target ?? "");
          if (!url) return err("mobile open: `url` is required.");
          const ok = await mobileCliOpenUrl(device, url);
          return ok
            ? { output: `opened ${url}` }
            : err(
                `mobile open: could not open \`${url}\`. A scheme the app does not handle fails quietly — ` +
                  `confirm with \`look\` that it landed where you expected.`,
              );
        }

        case "launch": {
          const bundleId = String(args?.bundleId ?? args?.target ?? "");
          if (!bundleId) return err("mobile launch: `bundleId` is required.");
          const ok = await mobileCliLaunch(device, bundleId);
          if (!ok) {
            return err(`mobile launch: could not launch \`${bundleId}\`. \`mobile { action: "apps" }\` lists what is installed.`);
          }
          const fg = await mobileCliForegroundApp(device);
          return { output: `launched ${bundleId}${fg ? ` (foreground: ${fg.packageName})` : ""}` };
        }

        case "terminate": {
          const bundleId = String(args?.bundleId ?? args?.target ?? "");
          if (!bundleId) return err("mobile terminate: `bundleId` is required.");
          const ok = await mobileCliTerminate(device, bundleId);
          return ok ? { output: "terminated" } : err("mobile terminate failed.");
        }

        case "install": {
          const appPath = String(args?.path ?? args?.target ?? "");
          if (!appPath) return err("mobile install: `path` is required.");
          const ok = await mobileCliInstall(device, appPath);
          return ok ? { output: `installed ${appPath}` } : err(`mobile install: failed for \`${appPath}\`.`);
        }

        case "apps": {
          try {
            return { output: JSON.stringify({ apps: await mobileCliListApps(device) }, null, 2) };
          } catch (e) {
            return err(`mobile apps: ${(e as Error).message}`);
          }
        }

        default:
          return err(`mobile: unhandled action "${action}".`);
      }
    },
  };
}
