/**
 * Simulators and emulators the MACHINE already has, with no MCP in between.
 *
 * WHY THIS FILE EXISTS
 *
 * `activity_inspect` is the harness's visual check, and its device half was
 * wired exclusively to a device MCP (`mobile_take_screenshot` and friends). When
 * none is connected the tool answers "no device automation tools available" —
 * which the model correctly reports as a missing capability, and then declares
 * the change unverifiable and stops. On a Mac with Xcode that conclusion is
 * false: a booted simulator is right there, and `xcrun simctl` can list it,
 * launch an app on it and screenshot it in three commands. The same holds for
 * `adb` and an Android emulator.
 *
 * So this module implements the four operations `inspectMobile` needs, backed by
 * the platform CLIs, shaped as `AgentTool`s so they drop into the existing
 * finder slots unchanged. A device MCP still WINS when one is connected — it can
 * do more (element trees, taps, gestures) than these four commands. This is the
 * floor, not the ceiling: the difference between "no visual verification is
 * possible" and "here is a screenshot of the app".
 *
 * These tools are not registered for the model to call directly. They are an
 * internal fallback, so the model keeps ONE way to ask for a screen
 * (`activity_inspect`) and does not have to know which backend answered.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, ToolResult, ToolResultContent } from "../types.js";
import { resolveShellEnvironment } from "../exec/shell-env.js";

/** Bounded run of a platform CLI. Never throws; failures come back as text. */
async function run(
  file: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { env } = await resolveShellEnvironment();
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout ?? "").toString().trim(),
        stderr: ((stderr ?? "").toString() || (err?.message ?? "")).trim(),
      });
    });
  });
}

export interface LocalDevice {
  id: string;
  name: string;
  platform: "ios" | "android";
  /** Always "booted" — only running devices are ever returned. */
  state: "booted";
  version?: string;
}

interface SimctlDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

/**
 * Booted iOS simulators.
 *
 * `simctl list devices booted -j` is asked for explicitly rather than filtering
 * the full list ourselves: a machine with two Xcode versions installed lists
 * dozens of shut-down runtimes, and "booted" is the only state a screenshot can
 * come from anyway.
 */
export async function listBootedIosSimulators(): Promise<LocalDevice[]> {
  if (process.platform !== "darwin") return [];
  const res = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"], 20_000);
  if (!res.ok || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout) as { devices?: Record<string, SimctlDevice[]> };
    const out: LocalDevice[] = [];
    for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
      // Runtime keys look like "com.apple.CoreSimulator.SimRuntime.iOS-26-5".
      const version = runtime.split(".").pop()?.replace(/^iOS-/, "").replace(/-/g, ".");
      for (const device of list ?? []) {
        if (!device.udid || device.state !== "Booted") continue;
        out.push({
          id: device.udid,
          name: device.name ?? "iOS Simulator",
          platform: "ios",
          state: "booted",
          ...(version ? { version } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Connected Android devices and running emulators. */
export async function listBootedAndroidDevices(): Promise<LocalDevice[]> {
  const res = await run("adb", ["devices", "-l"], 20_000);
  if (!res.ok || !res.stdout) return [];
  const out: LocalDevice[] = [];
  for (const line of res.stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || state !== "device") continue;
    const model = rest.find((part) => part.startsWith("model:"))?.slice("model:".length);
    out.push({ id: serial, name: model ?? serial, platform: "android", state: "booted" });
  }
  return out;
}

/**
 * Every device this machine can capture from right now.
 *
 * Cached briefly: `inspectMobile` asks for the list, then launches, then
 * screenshots, and a run of `simctl` per step on a cold Xcode is seconds of dead
 * time. Short enough that a simulator booted mid-run is picked up on the next
 * inspection rather than at the end of the session.
 */
const DEVICE_CACHE_MS = 5_000;
let deviceCache: { at: number; devices: LocalDevice[] } | undefined;

/**
 * Replaces the platform-CLI probe.
 *
 * The discovery step is the one thing here that depends on the machine, and a
 * test whose result changes with whether a simulator happens to be booted is
 * worse than no test. Hosts can use the same seam to supply their own device
 * inventory (a remote device farm, a preselected target).
 */
let probeOverride: (() => Promise<LocalDevice[]>) | undefined;

export function setLocalDeviceProbe(probe: (() => Promise<LocalDevice[]>) | undefined): void {
  probeOverride = probe;
  deviceCache = undefined;
}

/**
 * Hosts that want device capture to come from an MCP and nowhere else set
 * `TURING_DISABLE_LOCAL_DEVICES=1`. Read per call rather than cached so it can
 * be flipped between tests.
 */
function localDevicesDisabled(): boolean {
  const flag = process.env.TURING_DISABLE_LOCAL_DEVICES;
  return flag === "1" || flag === "true";
}

export async function listLocalDevices(): Promise<LocalDevice[]> {
  if (localDevicesDisabled()) return [];
  if (probeOverride) return probeOverride();
  const now = Date.now();
  if (deviceCache && now - deviceCache.at < DEVICE_CACHE_MS) return deviceCache.devices;
  const [ios, android] = await Promise.all([listBootedIosSimulators(), listBootedAndroidDevices()]);
  const devices = [...ios, ...android];
  deviceCache = { at: now, devices };
  return devices;
}

/** Forget the cached device list. For tests, and after booting a simulator. */
export function resetLocalDeviceCache(): void {
  deviceCache = undefined;
}

/** Is a local device available to capture from? Drives the fallback decision. */
export async function hasLocalDevice(): Promise<boolean> {
  return (await listLocalDevices()).length > 0;
}

/**
 * Which platform a device id belongs to.
 *
 * Resolved from the live list rather than guessed from the id's shape, because
 * `flutter devices` and the user both hand over ids in several formats and a
 * wrong guess sends `adb` commands to a simulator.
 */
async function platformFor(deviceId: string): Promise<"ios" | "android" | undefined> {
  const devices = await listLocalDevices();
  const match = devices.find((d) => d.id.toLowerCase() === deviceId.toLowerCase());
  if (match) return match.platform;
  // An id we did not list (a physical device, or one booted a second ago) —
  // fall back to shape. iOS simulator udids are canonical UUIDs.
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(deviceId)) return "ios";
  return undefined;
}

function textResult(output: string, isError = false): ToolResult {
  return { output, isError };
}

/**
 * The four operations, as `AgentTool`s.
 *
 * This is the zero-dependency fallback for when `mobilecli` is not installed.
 * It covers list / screenshot / launch / open-url — everything an INSPECTION
 * needs. It deliberately cannot tap: neither `xcrun simctl` nor a plain `adb`
 * call injects touch events reliably, and a tap that silently does nothing is
 * worse than an absent capability. Tapping requires mobilecli.
 */
export function localDeviceTools(): {
  list: AgentTool;
  screenshot: AgentTool;
  launch: AgentTool;
  openUrl: AgentTool;
} {
  const list: AgentTool = {
    name: "local_device_list",
    description: "List booted iOS simulators and Android devices using the platform CLIs.",
    mutates: false,
    parameters: { type: "object", properties: {} },
    async execute() {
      const devices = await listLocalDevices();
      // The shape `pickDevice` parses, so the MCP and the fallback are
      // indistinguishable to the caller.
      return textResult(JSON.stringify({ devices }));
    },
  };

  const screenshot: AgentTool = {
    name: "local_device_screenshot",
    description: "Capture a PNG of a booted simulator/device screen.",
    mutates: false,
    parameters: {
      type: "object",
      properties: { device: { type: "string", description: "Device/simulator id." } },
    },
    async execute(_id, args, ctx) {
      const device = args.device ? String(args.device) : (await listLocalDevices())[0]?.id;
      if (!device) {
        return textResult("No booted simulator or device. Boot one, then capture again.", true);
      }
      const platform = await platformFor(device);
      if (!platform) {
        return textResult(`Unknown device \`${device}\` — not a booted simulator or an adb device.`, true);
      }

      const dir = path.join(ctx.cwd, ".turing", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `device-${device.slice(0, 8)}-${Date.now()}.png`);

      const res =
        platform === "ios"
          ? await run("xcrun", ["simctl", "io", device, "screenshot", file], 45_000)
          : // `screencap -p` writes the PNG to stdout, and `execFile` would decode
            // those bytes as text. The redirect keeps them binary.
            await run(
              "/bin/sh",
              ["-c", `adb -s ${JSON.stringify(device)} exec-out screencap -p > ${JSON.stringify(file)}`],
              45_000,
            );
      if (!res.ok) return textResult(`Screenshot failed: ${res.stderr || res.stdout}`, true);

      let data: string;
      try {
        data = (await fs.readFile(file)).toString("base64");
      } catch (err) {
        return textResult(`Screenshot was not written: ${(err as Error).message}`, true);
      }
      if (!data) return textResult("Screenshot file is empty.", true);

      const content: ToolResultContent[] = [
        { type: "text", text: `Screenshot saved to ${file}` },
        { type: "image", data, mimeType: "image/png" },
      ];
      return { output: `Screenshot saved to ${file}`, content, isError: false, details: { device, path: file } };
    },
  };

  const launch: AgentTool = {
    name: "local_device_launch",
    description: "Bring an installed app to the foreground on a booted simulator/device.",
    mutates: true,
    parameters: {
      type: "object",
      properties: {
        device: { type: "string" },
        bundleId: { type: "string" },
        packageName: { type: "string" },
      },
    },
    async execute(_id, args) {
      const bundleId = String(args.bundleId ?? args.packageName ?? "");
      if (!bundleId) return textResult("launch: `bundleId` is required.", true);
      const device = args.device ? String(args.device) : (await listLocalDevices())[0]?.id;
      if (!device) return textResult("No booted simulator or device to launch on.", true);
      const platform = await platformFor(device);

      const res =
        platform === "android"
          ? await run("adb", ["-s", device, "shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"])
          : await run("xcrun", ["simctl", "launch", device, bundleId]);

      if (!res.ok) {
        return textResult(
          `Launch of \`${bundleId}\` failed: ${res.stderr || res.stdout}\n` +
            "If the app is not installed on this device yet, build and install it first " +
            "(e.g. `flutter run -d <device>`), then capture.",
          true,
        );
      }
      return textResult(`Launched \`${bundleId}\` on ${device}.`);
    },
  };

  const openUrl: AgentTool = {
    name: "local_device_open_url",
    description: "Open a URL or deep link on a booted simulator/device.",
    mutates: true,
    parameters: {
      type: "object",
      properties: { device: { type: "string" }, url: { type: "string" } },
    },
    async execute(_id, args) {
      const url = String(args.url ?? "");
      if (!url) return textResult("open_url: `url` is required.", true);
      const device = args.device ? String(args.device) : (await listLocalDevices())[0]?.id;
      if (!device) return textResult("No booted simulator or device to open the URL on.", true);
      const platform = await platformFor(device);

      const res =
        platform === "android"
          ? await run("adb", ["-s", device, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url])
          : await run("xcrun", ["simctl", "openurl", device, url]);

      if (!res.ok) return textResult(`Opening \`${url}\` failed: ${res.stderr || res.stdout}`, true);
      return textResult(`Opened \`${url}\` on ${device}.`);
    },
  };

  return { list, screenshot, launch, openUrl };
}
