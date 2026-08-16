/**
 * A fake `mobilecli` BINARY for tests.
 *
 * Deliberately a real executable rather than a stubbed module: the harness
 * talks to mobilecli by spawning it with an argv and parsing `{status,data}`
 * off stdout, so a module-level fake would test none of the part that actually
 * broke historically (argument shape, coordinate values, envelope parsing).
 * This records every invocation's argv, so a test can assert the exact
 * coordinates that were sent to the device.
 *
 * Shapes here are copied from a real mobilecli 1.0.1 against a booted
 * iPhone 17 Pro simulator — including `apps list` answering with a bare ARRAY
 * in `data` while everything else answers with an object.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Minimal valid PNG (IHDR only) so the dimension parser can read W×H. */
export function pngBytes(width, height, marker = "A") {
  const b = Buffer.alloc(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.set(Buffer.from("IHDR"), 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b.write(marker, 32, "ascii"); // so two "screens" differ by content
  return b;
}

const DEFAULT_DEVICE = {
  id: "SIM-1",
  name: "iPhone 17 Pro",
  platform: "ios",
  type: "simulator",
  version: "26.5",
  state: "online",
  model: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
};

/**
 * Write a fake mobilecli to a temp dir.
 *
 * @param opts.devices      device list (default: one booted iPhone 17 Pro)
 * @param opts.screen       {width,height,scale} logical screen (default 402x874 @3)
 * @param opts.elements     `dump ui` elements, or a function(callIndex) for
 *                          screens that change between captures
 * @param opts.shots        capture markers per screenshot call, e.g. ["A","B"]
 * @param opts.shotSize     [w,h] physical pixels (default 1206x2622)
 * @param opts.failTap      true -> `io tap` exits non-zero
 * @returns { bin, calls(), cleanup() }
 */
export function fakeMobileCli(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-mobilecli-"));
  const callsFile = path.join(dir, "calls.jsonl");
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(callsFile, "");
  fs.writeFileSync(stateFile, JSON.stringify({ shotN: 0, dumpN: 0 }));

  const config = {
    devices: opts.devices ?? [DEFAULT_DEVICE],
    screen: opts.screen === null ? null : (opts.screen ?? { width: 402, height: 874, scale: 3 }),
    elements: opts.elements ?? [],
    shots: opts.shots ?? ["A", "B", "C", "D", "E", "F"],
    shotSize: opts.shotSize ?? [1206, 2622],
    failTap: !!opts.failTap,
    apps: opts.apps ?? [{ packageName: "com.uniqode.cards", appName: "Cards", version: "1.0" }],
    failLaunch: !!opts.failLaunch,
    failOpenUrl: !!opts.failOpenUrl,
    noScreenshot: !!opts.noScreenshot,
    rawTree: opts.rawTree ?? null,
  };
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(config));

  const script = `#!/usr/bin/env node
import * as fs from "node:fs";
const CALLS = ${JSON.stringify(callsFile)};
const STATE = ${JSON.stringify(stateFile)};
const CFG = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(CALLS, JSON.stringify(argv) + "\\n");

const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state));
const ok = (data) => { process.stdout.write(JSON.stringify({ status: "ok", data })); process.exit(0); };
const fail = (msg) => { process.stderr.write(msg); process.exit(1); };
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positionals = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

if (argv.includes("--version")) { process.stdout.write("mobilecli version 1.0.1-fake"); process.exit(0); }

const [cmd, sub] = positionals;

if (cmd === "devices") ok({ devices: CFG.devices });

if (cmd === "device" && sub === "info") {
  const d = CFG.devices[0];
  if (!d) fail("no device");
  ok({ device: { ...d, ...(CFG.screen ? { screenSize: CFG.screen } : {}) } });
}

if (cmd === "screenshot") {
  if (CFG.noScreenshot) fail("capture failed");
  const out = flag("--output") ?? flag("-o");
  const marker = CFG.shots[Math.min(state.shotN, CFG.shots.length - 1)];
  state.shotN += 1; saveState();
  const [w, h] = CFG.shotSize;
  const b = Buffer.alloc(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.set(Buffer.from("IHDR"), 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.write(marker, 32, "ascii");
  fs.writeFileSync(out, b);
  ok({ path: out });
}

if (cmd === "dump" && sub === "ui") {
  if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "raw") ok({ rawData: CFG.rawTree ?? { children: [] } });
  const els = Array.isArray(CFG.elements) ? CFG.elements : (CFG.elements[state.dumpN] ?? []);
  const perCall = Array.isArray(CFG.elements) && Array.isArray(CFG.elements[0]);
  const chosen = perCall ? (CFG.elements[Math.min(state.dumpN, CFG.elements.length - 1)] ?? []) : els;
  state.dumpN += 1; saveState();
  ok({ elements: chosen });
}

if (cmd === "io") {
  if (sub === "tap" && CFG.failTap) fail("tap failed");
  ok({ message: \`\${sub} on \${flag("--device")} at \${positionals[2] ?? ""}\` });
}

if (cmd === "apps") {
  if (sub === "list") ok(CFG.apps);          // NOTE: bare array, like the real CLI
  if (sub === "launch" && CFG.failLaunch) fail("launch failed");
  if (sub === "foreground") ok(CFG.apps[0] ?? {});
  ok({ message: sub });
}

if (cmd === "url") {
  if (CFG.failOpenUrl) fail("open failed");
  ok({ message: "opened " + positionals[1] });
}

fail("fake mobilecli: unhandled argv " + JSON.stringify(argv));
`;

  const bin = path.join(dir, "mobilecli.mjs");
  fs.writeFileSync(bin, script, { mode: 0o755 });

  // A tiny shell shim so the harness can exec it as a plain binary.
  const shim = path.join(dir, "mobilecli");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, { mode: 0o755 });

  return {
    bin: shim,
    /** Every invocation's argv, in order. */
    calls() {
      return fs
        .readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    /** Invocations of one subcommand, e.g. cmd("io","tap"). */
    cmd(...prefix) {
      return this.calls().filter((a) => prefix.every((p, i) => a[i] === p));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An element as `dump ui` reports it — rect in LOGICAL points. */
export function el(type, label, x, y, width, height) {
  return { type, label, name: label, rect: { x, y, width, height } };
}

/**
 * A raw-tree node as `dump ui --format raw` reports it — note the CAPITALIZED
 * frame keys, which differ from the lowercase ones in the JSON view. Reading
 * the wrong casing silently yields zero candidates.
 */
export function rawNode(x, y, width, height, label = "", children = []) {
  return { frame: { X: x, Y: y, Width: width, Height: height }, label, children };
}

/**
 * The real My Cards screen from the validation device, trimmed to what
 * matters: a full-screen root, the 402x54 status bar (with a battery inside
 * it), the app-bar row, and the UNLABELED 72x40 avatar at (330,70) whose
 * centre (366,90) is the coordinate that actually opens Profile.
 */
export function cardsScreenRawTree() {
  return rawNode(0, 0, 402, 874, "", [
    rawNode(0, 0, 402, 54, "", [rawNode(326, 26, 27, 13, "100% battery power")]),
    rawNode(0, 62, 402, 56, "", [
      rawNode(16, 75.5, 298, 29, "My Cards"),
      rawNode(330, 70, 72, 40, ""), // <- the profile avatar, unlabeled
    ]),
    rawNode(114, 482, 173, 23, " Hermoine Granger"),
    rawNode(77, 629, 246, 50, "Share Card"),
  ]);
}

/**
 * The real Profile screen from the validation device — the one that broke the
 * run. Its six action rows are elementType 1 ("Other") carrying the labels,
 * which `dump ui`'s JSON view discards; only their 40x40 icons and one
 * StaticText survive that view. Includes an Application node (the true screen)
 * and a scroll container REPORTING ITS CONTENT SIZE (402x1244, taller than the
 * 874pt screen) plus rows below the fold, so the screen-derivation and
 * clipping rules are both exercised.
 */
export function profileScreenRawTree() {
  const row = (y, label) => [
    { frame: { X: 24, Y: y, Width: 354, Height: 40 }, label, elementType: 1, children: [] },
    { frame: { X: 24, Y: y, Width: 40, Height: 40 }, label: "", elementType: 9, children: [] },
  ];
  return {
    frame: { X: 0, Y: 0, Width: 402, Height: 874 },
    label: "Uniqode Cards (Staging)",
    elementType: 2, // Application — the authoritative screen
    children: [
      { frame: { X: 0, Y: 0, Width: 402, Height: 54 }, label: "", elementType: 25,
        children: [{ frame: { X: 326, Y: 26, Width: 27, Height: 13 }, label: "100% battery power", elementType: 1, children: [] }] },
      { frame: { X: 0, Y: 0, Width: 402, Height: 874 }, label: "", elementType: 4, children: [
        { frame: { X: 72, Y: 76, Width: 66, Height: 28 }, label: "Profile", elementType: 1, children: [] },
        // A scroll container reporting CONTENT size, larger than the screen.
        { frame: { X: 0, Y: 274, Width: 402, Height: 1244 }, label: "", elementType: 46, children: [
          ...row(338, "Manage Events"),
          ...row(411, "Help & Support"),
          ...row(467, "Invite Teammates"),
          ...row(607, "Log Out"),
          ...row(663, "Delete My Account"),
          ...row(719, "Report Issue"),
          // Below the fold: present in the tree, untappable on screen.
          ...row(900, "Hidden Below Fold"),
          { frame: { X: 63, Y: 1067, Width: 40, Height: 54 }, label: "z", elementType: 20, children: [] },
        ] },
      ] },
    ],
  };
}
