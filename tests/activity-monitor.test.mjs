/**
 * Tests for the activity-monitor PROVIDER — a set of small tools rather than one
 * tool behind an `action` switch (registered `kind: "mcp"`, like builtin:coding).
 *
 * The decomposition is the point: the trace workflow used to run inside a single
 * `activity_monitor{action:"trace"}` call that drove its own private LLM sub-loop,
 * reading and editing files through its own dispatch. Minutes passed with nothing
 * visible, and none of the model's reasoning or edits reached the transcript or the
 * permission gate. Now each step is its own tool call and the MAIN loop does the
 * instrumenting with its ordinary read/edit tools.
 *
 * All offline — no LLM is needed except where a study is explicitly exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEBUGGING_LOOP,
  LogStore,
  Registry,
  createActivityMonitorTools,
  registerBuiltins,
  setLocalDeviceProbe,
} from "../dist/index.js";
import { WORK_PROMPT, READ_PROMPT, INSPECT_PROMPT, CATEGORIZER_PROMPTS, buildWorkPrompt, buildPhaseLikePrompt } from "./helpers/v2-prompts.mjs";
import { setMobileCliOverride, setMobileCliAvailableOverride } from "../dist/devices/mobilecli.js";
import { traceMarker } from "../dist/probe-marker.js";
import { fakeMobileCli } from "./fake-mobilecli.mjs";

// `activity_inspect` drives whatever device surface exists, so "is mobilecli
// installed / is anything booted on THIS machine?" would otherwise decide the
// outcome of half the tests below — they would pass on a laptop with a running
// simulator and fail in CI. Pin both inventories to empty by default; the tests
// that want a device opt in explicitly.
setLocalDeviceProbe(async () => []);
setMobileCliAvailableOverride(false);

/** Run `fn` with a fake mobilecli on PATH, then restore the empty inventory. */
async function withDevice(opts, fn) {
  const fake = fakeMobileCli(opts);
  setMobileCliAvailableOverride(undefined);
  setMobileCliOverride(fake.bin);
  try {
    return await fn(fake);
  } finally {
    setMobileCliOverride(undefined);
    setMobileCliAvailableOverride(false);
    fake.cleanup();
  }
}

function setup() {
  const logStore = new LogStore();
  const tools = new Map(createActivityMonitorTools({ logStore }).map((t) => [t.name, t]));
  const ctx = { cwd: os.tmpdir(), log: (entry) => logStore.append(entry) };
  return { logStore, tools, ctx };
}

/** Start a trace session and return its ids. */
async function startTrace(tools, ctx, args = {}) {
  const res = await tools.get("activity_trace_start").execute("t", { language: "typescript", ...args }, ctx);
  return { res, traceId: res.details.traceId, traceFile: res.details.traceFile };
}

test("the provider exposes one tool per step, not an action switch", () => {
  const { tools } = setup();
  assert.deepEqual(
    [...tools.keys()],
    [
      "activity_search",
      "activity_tags",
      "activity_tail_file",
      "activity_study",
      "activity_trace_start",
      "add_log",
      "remove_log",
      "activity_collect",
      "activity_cleanup",
      "activity_inspect",
    ],
    "mobile_tap_visual moved to the `mobile` tool's `tap` action; the rest stay one-per-step",
  );
  // No tool HERE takes an `action` argument — for this provider the tool name
  // IS the action, because each step is a distinct decision the model makes and
  // must be separately visible, permissioned and reviewable.
  //
  // The device toolkit deliberately went the other way (`mobile { action }`),
  // and the distinction is the point: the rule exists to stop a tool hiding an
  // LLM SUB-LOOP. `mobile` hides only deterministic resolution — a screenshot,
  // a UI tree, and arithmetic — and narrates every step of it in the result.
  // Debuggability was never about the call count.
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.properties.action, undefined, `${tool.name} should not take an 'action'`);
  }
  // The mutating ones are those that touch processes or project files:
  // trace_start may spawn a server, add_log writes logging into source, remove_log
  // takes it out again, cleanup kills the server and clears whatever remains.
  const mutating = [...tools.values()].filter((t) => t.mutates).map((t) => t.name);
  assert.deepEqual(mutating, ["activity_trace_start", "add_log", "remove_log", "activity_cleanup"]);
});

test("activity_trace_start returns a session and instructs the MODEL to instrument", async () => {
  const { tools, ctx } = setup();
  const { res, traceId, traceFile } = await startTrace(tools, ctx, { hint: "test trace" });

  assert.ok(traceId.startsWith("turing-trace-"));
  assert.ok(traceFile.includes(traceId));
  assert.equal(res.details.language, "typescript");
  assert.equal(res.details.runMode, "manual");
  // The snippet the model pastes, carrying this session's id.
  assert.match(res.output, /TURING_TRACE/);
  assert.ok(res.output.includes(traceMarker(traceId)), "the snippet names THIS session's unique marker");
  assert.match(res.output, /console\.log/, "the snippet uses the language's own print");
  assert.ok(res.output.includes(traceId));
  // The instrumenting is explicitly the model's job now, via read/edit.
  assert.match(res.output, /`read`.*`edit`/s);
  assert.match(res.output, /activity_collect/);
  // No `files` argument: the tool never edits code itself any more.
  assert.equal(tools.get("activity_trace_start").parameters.properties.files, undefined);

  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
});

test("activity_trace_start detects the language when not told", async () => {
  const { tools, ctx } = setup();
  const res = await tools.get("activity_trace_start").execute("t", {}, ctx);
  assert.equal(typeof res.details.language, "string");
  assert.ok(res.details.language.length > 0);
  await tools.get("activity_cleanup").execute("c", { traceId: res.details.traceId }, ctx);
});

test("activity_collect returns only this session's lines", async () => {
  const { tools, ctx } = setup();
  const { traceId, traceFile } = await startTrace(tools, ctx);
  const marker = traceMarker(traceId);

  await fs.writeFile(
    traceFile,
    [
      `[2026-07-27T10:00:00.000Z] ${marker} user clicked login`,
      `[2026-07-27T10:00:01.000Z] ${marker} form validated: { valid: true }`,
      `[2026-07-27T10:00:03.000Z] noise from another process`,
      `[2026-07-27T10:00:04.000Z] ${marker} API responded 200 { userId: 42 }`,
    ].join("\n"),
    "utf8",
  );

  const res = await tools.get("activity_collect").execute("c", { traceId }, ctx);
  assert.equal(res.details.traceLines, 3, "the foreign line must be filtered out");
  assert.match(res.output, /user clicked login/);
  assert.match(res.output, /API responded 200/);
  assert.doesNotMatch(res.output, /noise from another process/);
  // Points at the next step rather than leaving the model to guess.
  assert.match(res.output, /activity_study/);

  await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
});

test("two trace sessions get distinct markers, and each collect ignores the other's", async () => {
  // The stale-probe incident: a probe a previous run left in the source emits
  // into a NEW session's trace file the moment the app re-launches. With one
  // shared marker those lines were counted as the new run's evidence — the new
  // check read the old check's output as its own. Markers are per-session and
  // collection follows the session's marker only.
  const { tools, ctx } = setup();
  const a = await startTrace(tools, ctx);
  const b = await startTrace(tools, ctx, { force: true });
  assert.notEqual(a.traceId, b.traceId);
  assert.notEqual(traceMarker(a.traceId), traceMarker(b.traceId));

  await fs.writeFile(
    b.traceFile,
    [
      `[ts] ${traceMarker(a.traceId)} stale probe from session A`,
      "[ts] TURING_TRACE bare family prefix, no session suffix",
      `[ts] ${traceMarker(b.traceId)} this session's own line`,
    ].join("\n"),
    "utf8",
  );

  const res = await tools.get("activity_collect").execute("c", { traceId: b.traceId }, ctx);
  assert.equal(res.details.traceLines, 1, "only the session's own marker counts");
  assert.equal(res.details.captured, 1, "the gate's evidence contract follows the same count");
  assert.doesNotMatch(res.output, /stale probe from session A/);
  // The leftovers are REPORTED, not silently dropped — they still need cleanup.
  assert.equal(res.details.foreignLines, 2);
  assert.match(res.output, /OTHER probe markers/);

  await tools.get("activity_cleanup").execute("cl", { traceId: a.traceId }, ctx);
  await tools.get("activity_cleanup").execute("cl", { traceId: b.traceId }, ctx);
});

test("activity_collect explains an empty trace instead of erroring", async () => {
  const { tools, ctx } = setup();
  const { traceId } = await startTrace(tools, ctx);

  const res = await tools.get("activity_collect").execute("c", { traceId }, ctx);
  assert.equal(res.isError ?? false, false, "an un-run flow is not an error");
  assert.equal(res.details.traceLines, 0);
  assert.match(res.output, /no trace lines yet/i);
  assert.match(res.output, /has not run/i);

  await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
});

test("activity_collect waitMs polls for output and reports progress while waiting", async () => {
  const { tools, ctx } = setup();
  const { traceId, traceFile } = await startTrace(tools, ctx);

  // The flow "runs" shortly AFTER collect is called — the case waitMs exists for.
  const updates = [];
  setTimeout(() => {
    void fs.writeFile(traceFile, `[ts] ${traceMarker(traceId)} late line\n`, "utf8");
  }, 300);

  const res = await tools
    .get("activity_collect")
    .execute("c", { traceId, waitMs: 5000 }, { ...ctx, progress: (u) => updates.push(u) });

  assert.equal(res.details.traceLines, 1, "the line written during the wait is picked up");
  // The wait must be VISIBLE — that is the whole point of the progress channel.
  assert.ok(updates.length >= 1, "waiting must emit progress");
  assert.ok(updates.every((u) => u.waiting === true), "a wait on the user is flagged as waiting");
  assert.match(updates[0].message, /waiting for trace output/);

  await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
});

test("activity_collect reports a missing traceId and a missing file distinctly", async () => {
  const { tools, ctx } = setup();

  const missingArg = await tools.get("activity_collect").execute("c", {}, ctx);
  assert.equal(missingArg.isError, true);
  assert.match(missingArg.output, /traceId/);

  const missingFile = await tools
    .get("activity_collect")
    .execute("c", { traceId: "turing-trace-nonexistent" }, ctx);
  assert.equal(missingFile.isError, true);
  assert.match(missingFile.output, /No trace file found/);
});

test("activity_cleanup deletes the trace file and is safe to repeat", async () => {
  const { tools, ctx } = setup();
  const { traceId, traceFile } = await startTrace(tools, ctx);

  const first = await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
  assert.match(first.output, /Deleted trace file/);
  assert.equal(first.details.deletedFile, true);
  await assert.rejects(() => fs.access(traceFile), "the file is really gone");

  const second = await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
  assert.equal(second.isError ?? false, false, "cleaning up twice must not throw");
});

test("activity_search and activity_tags read the harness log", async () => {
  const { tools, ctx, logStore } = setup();
  logStore.append({ level: "info", tags: ["test", "activity"], message: "test log entry", timestamp: Date.now() });

  const search = await tools.get("activity_search").execute("s", { tags: ["test"] }, ctx);
  assert.ok(search.details.count >= 1);
  assert.match(search.output, /test log entry/);

  const tags = await tools.get("activity_tags").execute("t", {}, ctx);
  assert.ok(tags.details.test >= 1);
  assert.match(tags.output, /test/);
});

test("activity_tail_file filters a log file outside the harness", async () => {
  const { tools, ctx } = setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activity-tail-"));
  const file = path.join(dir, "app.log");
  await fs.writeFile(file, ["API call started", "unrelated line", "API responded 200"].join("\n"), "utf8");

  const res = await tools.get("activity_tail_file").execute("t", { file, text: "API" }, ctx);
  assert.match(res.output, /API call started/);
  assert.match(res.output, /API responded 200/);
  assert.doesNotMatch(res.output, /unrelated line/);
  assert.equal(res.details.matched, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("activity_study studies a trace by id, and says so when there is nothing to study", async () => {
  const { tools, ctx } = setup();
  const { traceId, traceFile } = await startTrace(tools, ctx);

  const empty = await tools.get("activity_study").execute("s", { traceId }, ctx);
  assert.match(empty.output, /no lines yet/i, "an empty trace must not reach the model");

  await fs.writeFile(
    traceFile,
    `[ts] ${traceMarker(traceId)} login called\n[ts] ${traceMarker(traceId)} fetch failed 500\n`,
    "utf8",
  );

  // A stub bridge stands in for the study model, so the wiring is checked offline.
  const seen = [];
  const llm = {
    resolveModel: (slug) => ({ id: slug, openRouterSlug: slug }),
    complete: async (_model, context) => {
      seen.push(context);
      return {
        role: "assistant",
        content: [{ type: "text", text: "The login call fails with a 500 from /api/login." }],
        model: "stub", api: "openrouter", provider: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 0,
      };
    },
  };

  const studied = await tools.get("activity_study").execute("s", { traceId }, { ...ctx, llm });
  assert.match(studied.output, /500/);
  // The collected trace lines are what got studied.
  const sent = JSON.stringify(seen[0].messages);
  assert.match(sent, /login called/);
  assert.match(sent, /fetch failed 500/);

  await tools.get("activity_cleanup").execute("cl", { traceId }, ctx);
});

test("the work loop's system prompt teaches the trace workflow", () => {
  // A tool the model cannot discover may as well not exist. Observed failure: the
  // model said "let me use the activity monitor to trace this", then ran
  // `bash ls -la /var/folders/.../T/` hunting for a trace file — because the loop
  // prompt documented the memory tools in detail and never mentioned these.
  for (const name of [
    "activity_tags",
    "activity_search",
    "activity_study",
    "activity_trace_start",
    "activity_collect",
    "activity_cleanup",
    "activity_inspect",
    "activity_tail_file",
  ]) {
    assert.ok(WORK_PROMPT.includes(name), `the loop prompt must name ${name}`);
  }
  // The steps have to be ordered, and the instrumenting has to be owned by the model.
  const startAt = WORK_PROMPT.indexOf("activity_trace_start");
  const collectAt = WORK_PROMPT.indexOf("activity_collect");
  const cleanupAt = WORK_PROMPT.indexOf("activity_cleanup");
  assert.ok(startAt < collectAt && collectAt < cleanupAt, "the workflow must be given in order");
  assert.match(WORK_PROMPT, /YOU place\s+the calls with `read`\/`edit`/);
  // And the specific wrong turn we saw is called out.
  assert.match(WORK_PROMPT, /Do NOT go hunting for trace files with bash/);
});

test("every activity tool the prompt names is actually registered", () => {
  // The other half of discoverability: a prompt that names a tool the registry does
  // not expose sends the model after something that will never resolve.
  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const registered = new Set(reg.allTools().map((t) => t.name));
  const named = [...WORK_PROMPT.matchAll(/activity_[a-z_]+/g)].map((m) => m[0]);
  assert.ok(named.length >= 8);
  for (const name of new Set(named)) {
    assert.ok(registered.has(name), `${name} is named in the prompt but not registered`);
  }
});

test("activity_inspect degrades clearly with no browser or device MCP connected", async () => {
  const { tools, ctx } = setup();
  const res = await tools.get("activity_inspect").execute("i", { url: "http://localhost:3000" }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /No browser or device automation tools/);
  // The degraded message must close the bash escape hatch explicitly. Without
  // this line the model reads "no tool available" as licence to "verify" with
  // curl or a build command, which is exactly the non-verification this tool exists to replace.
  assert.match(res.output, /Do NOT substitute bash/);
});

// ---------------------------------------------------------------------------
// Device inspection. `activity_inspect` resolved only browser_*/playwright_*
// tool names, so on a mobile repo with a device connected and a simulator
// booted it still answered "no browser automation tools available" — leaving the
// model with no way to look at the screen it had just changed.
//
// The device backend is now the `mobilecli` binary, so these drive a FAKE
// BINARY rather than a stubbed registry tool: the argv the harness builds is
// half of what can break, and a module-level fake would test none of it.
// ---------------------------------------------------------------------------

test("activity_inspect drives the device when mobilecli is available", async () => {
  const { tools, ctx } = setup();
  await withDevice({}, async (fake) => {
    const res = await tools
      .get("activity_inspect")
      .execute("i", { bundleId: "com.uniqode.cards", url: "cards://my-cards" }, ctx);

    assert.notEqual(res.isError, true, res.output);
    // Device resolved automatically, then launch, then deep link, then ONE
    // capture. Screenshot-only by design: no element dump, no coordinate taps.
    assert.deepEqual(fake.calls().map((a) => a[0]), ["devices", "apps", "url", "screenshot"]);
    assert.ok(!fake.calls().some((a) => a[0] === "dump"), "no element dump during an inspection");
    assert.ok(!fake.calls().some((a) => a[0] === "io"), "an inspection never taps");
    // Every post-lookup call carries the auto-selected device id.
    for (const argv of fake.calls().slice(1)) assert.ok(argv.includes("SIM-1"), argv.join(" "));
    assert.deepEqual(fake.cmd("apps", "launch")[0].slice(0, 3), ["apps", "launch", "com.uniqode.cards"]);
    assert.deepEqual(fake.cmd("url")[0].slice(0, 2), ["url", "cards://my-cards"]);
    assert.equal(res.details.surface, "mobile");
    assert.equal(res.details.device, "SIM-1");
    assert.equal(res.details.backend, "mobilecli");
  });
});

test("the capture is NATIVE resolution — the downsampling that broke localization is gone", async () => {
  const { tools, ctx } = setup();
  await withDevice({ shotSize: [1206, 2622] }, async () => {
    const res = await tools.get("activity_inspect").execute("i", { target: "mobile" }, ctx);
    assert.notEqual(res.isError, true, res.output);
    assert.match(res.output, /Capture: mobilecli \(native resolution\)/);
  });
});

test("a device screenshot reaches the model as an image, not as the word 'ok'", async () => {
  const { tools, ctx } = setup();
  await withDevice({}, async () => {
    const res = await tools.get("activity_inspect").execute("i", {}, ctx);

    // The regression this guards: forwarding only `output` flattened the capture
    // to "ok". The run then reported a screenshot the model never actually saw.
    assert.ok(Array.isArray(res.content), "screenshot content blocks must be forwarded");
    assert.equal(res.content.filter((b) => b.type === "image").length, 1);
    assert.equal(res.details.screenshotCaptured, true);
    assert.doesNotMatch(res.output, /^ok$/m);
  });
});

test("a device inspection that captured no image says so instead of passing quietly", async () => {
  const { tools, ctx } = setup();
  await withDevice({ noScreenshot: true }, async () => {
    const res = await tools.get("activity_inspect").execute("i", {}, ctx);
    assert.equal(res.details.screenshotCaptured, false);
    assert.match(res.output, /This is NOT a pass/);
  });
});

test("no booted device is an error, not an empty pass", async () => {
  const { tools, ctx } = setup();
  await withDevice({ devices: [] }, async () => {
    const res = await tools.get("activity_inspect").execute("i", {}, ctx);
    assert.equal(res.isError, true);
    assert.match(res.output, /No booted device or simulator/);
  });
});

test("a bare inspect call captures the current device screen rather than demanding a url", async () => {
  const { tools, ctx } = setup();
  await withDevice({}, async (fake) => {
    const res = await tools.get("activity_inspect").execute("i", {}, ctx);

    // "Screenshot whatever is on screen" is the most natural way to ask, and it
    // used to fall through to the browser path and die on a missing `url`.
    assert.notEqual(res.isError, true, res.output);
    assert.equal(fake.cmd("screenshot").length, 1);
    assert.equal(fake.cmd("url").length, 0);
  });
});

test("a failed deep link fails the inspection instead of capturing the wrong screen", async () => {
  const { tools, ctx } = setup();
  await withDevice({ failOpenUrl: true }, async (fake) => {
    const res = await tools.get("activity_inspect").execute("i", { url: "cards://nope", target: "mobile" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.output, /Opening `cards:\/\/nope` failed/);
    assert.equal(fake.cmd("screenshot").length, 0, "no capture of whatever happened to be on screen");
  });
});

// ---------------------------------------------------------------------------
// Navigation-failure detection. The regression this guards: on a mobile repo
// the model invented http://localhost:3000/contacts (nothing serves it), the
// browser served a 404/error page, `activity_inspect` returned isError:null and
// — with analyze:true — handed the error page to the study model, which
// fabricated a detailed UI review of a contacts page that never existed. An
// error page is NOT a pass; it must fail loudly, and on a mobile project it must
// steer back to the device surface where the real app lives.
// ---------------------------------------------------------------------------

/** A fake browser MCP. `navigateResult` simulates what the navigate tool prints. */
function browserRegistry({ navigateResult = "Page URL: http://x/\nPage Title: App\nHTTP status: 200", extra = [] } = {}) {
  const calls = [];
  const record = (name, result) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async (_id, args) => {
      calls.push({ name, args });
      return typeof result === "function" ? result(args) : result;
    },
  });
  const tools = new Map(
    [
      record("browser_navigate", { output: navigateResult }),
      record("browser_take_screenshot", {
        output: "ok",
        content: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
      }),
      record("browser_snapshot", { output: "<page>Contacts</page>" }),
      record("browser_evaluate", { output: "" }),
      ...extra,
    ].map((t) => [t.name, t]),
  );
  return { calls, registry: { getTool: (n) => tools.get(n), allTools: () => [...tools.values()] } };
}

test("a 404 navigation fails loudly instead of capturing the error page", async () => {
  const { tools, ctx } = setup();
  // The exact shape Playwright MCP returned on the failed run.
  const { registry } = browserRegistry({
    navigateResult:
      "### Page\n- Page URL: http://localhost:3000/contacts\n- Page Title: Error response\n- HTTP status: 404 File not found\n- Console: 2 errors, 0 warnings",
  });
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000/contacts", analyze: true }, { ...ctx, registry });

  assert.equal(res.isError, true, "a 404 must not pass as a successful inspection");
  assert.match(res.output, /did not reach a real page/i);
  assert.match(res.output, /404/);
  // The screenshot step must NEVER run for an error page — capturing it is what
  // used to feed garbage into analyze.
  assert.ok(!res.content, "no screenshot must be attached for a failed navigation");
  assert.equal(res.details.mobileAvailable, false);
});

// ---------------------------------------------------------------------------
// No device MCP, but a booted simulator.
//
// The run this closes: a Flutter repo with no device MCP configured. Every
// mobile capture answered "no device automation tools available", the model
// generalised that into "this change cannot be verified", and shipped a UI
// change checked by nothing but re-reading the file — while a booted simulator
// sat there, capturable with three `xcrun simctl` calls.
// ---------------------------------------------------------------------------

/** Stand in for a booted simulator, so the fallback is exercised off-machine. */
function pinBootedDevice(devices = [{ id: "SIM-1", name: "iPhone 17 Pro", platform: "ios", state: "booted" }]) {
  setLocalDeviceProbe(async () => devices);
  return () => setLocalDeviceProbe(async () => []);
}

test("with no device MCP, a booted simulator is still a capturable surface", async (t) => {
  const restore = pinBootedDevice();
  t.after(restore);
  const { tools, ctx } = setup();
  const res = await tools.get("activity_inspect").execute("i", { target: "mobile" }, ctx);

  // The capture itself needs a real simulator, so what is asserted here is that
  // the tool ROUTED to the device instead of refusing for lack of an MCP.
  assert.ok(
    !/No browser or device automation tools/.test(res.output),
    `must not refuse when a device is booted:\n${res.output}`,
  );
  assert.ok(
    /SIM-1/.test(res.output) || /screenshot/i.test(res.output),
    `reached the device path:\n${res.output}`,
  );
});

test("with nothing booted and no MCP, the refusal says how to get a surface", async () => {
  const { tools, ctx } = setup();
  const res = await tools.get("activity_inspect").execute("i", { target: "mobile" }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /No browser or device automation tools/);
  // A dead end the model can act on: boot one. Without this it reports a missing
  // capability and stops.
  assert.match(res.output, /simctl|boot a simulator/i);
});

test("mobilecli wins over the simctl/adb fallback when both are available", async (t) => {
  const restore = pinBootedDevice();
  t.after(restore);
  const { tools, ctx } = setup();
  await withDevice({}, async (fake) => {
    const res = await tools.get("activity_inspect").execute("i", { target: "mobile" }, ctx);
    assert.equal(res.details.backend, "mobilecli");
    assert.equal(fake.cmd("screenshot").length, 1, "the CLI captured it, not simctl");
  });
});

test("a connection-refused page fails too (the dev server is not running)", async () => {
  const { tools, ctx } = setup();
  const { registry } = browserRegistry({
    navigateResult: "Page Title: This site can’t be reached\nlocalhost refused to connect (ERR_CONNECTION_REFUSED)",
  });
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:5173" }, { ...ctx, registry });
  assert.equal(res.isError, true);
  assert.match(res.output, /start.*dev server|start it first/i);
});

test("an error-page navigation with a device available steers to the simulator", async () => {
  const { tools, ctx } = setup();
  const browser = browserRegistry({
    navigateResult: "Page Title: 404 Not Found\nHTTP status: 404 File not found",
  });
  // A browser MCP connected AND a device reachable — the real run's setup.
  const res = await withDevice({}, () =>
    tools.get("activity_inspect").execute("i", { url: "http://localhost:3000/contacts" }, { ...ctx, registry: browser.registry }),
  );

  assert.equal(res.isError, true);
  assert.equal(res.details.mobileAvailable, true);
  // The recovery message must point at the device surface, not leave the model
  // to guess another URL — that was how it looped on 404s the first time.
  assert.match(res.output, /target:"mobile"/);
  assert.match(res.output, /bundleId/);
  assert.match(res.output, /mobile.*native.*app|Flutter.*React Native/i);
});

test("a navigation-failure prompt line teaches the model to reject error pages", () => {
  // The DEBUGGING ladder's VISUAL rung must name the error-page outcome so the
  // model treats it as a failed check rather than a captured screen.
  assert.match(DEBUGGING_LOOP, /error-page\/navigation-failed result/i);
  assert.match(DEBUGGING_LOOP, /do not analyse the error page/i);
});

test("the activity_inspect description steers mobile apps to the device surface", () => {
  const { tools } = setup();
  const desc = tools.get("activity_inspect").description;
  // The model reads the description at call time; it must learn here that a
  // mobile app has no http URL and that it must pass target:"mobile"+bundleId.
  assert.match(desc, /has NO http URL/i);
  assert.match(desc, /target:"mobile"/);
  assert.match(desc, /invent.*localhost/i);
  // Compactness guard: the description must teach the single-call contract
  // (capture AND judge) without the model needing media_analysis afterwards.
  assert.match(desc, /do NOT also run `media_analysis`/i);
});

// ---------------------------------------------------------------------------
// analyze:true delegation. The regression this guards: activity_inspect's
// analyze flag used to run its OWN inline model with a generic "find alignment /
// spacing / color issues" prompt. That prompt PRESUPPOSES defects, so on any
// screenshot it produced a confident list — real or invented — and it bypassed
// the media_analysis lens:"qa" verifier every prompt teaches. Worse, on the 404
// run it fabricated a whole contacts-page UI review of an error page. analyze
// now DELEGATES to media_analysis lens:"qa"; when that tool is absent it returns
// the screenshot UNANALYSED with a nudge, never a weaker inline describer.
// ---------------------------------------------------------------------------

/** A registry whose media_analysis records its call so delegation can be asserted. */
function registryWithMediaAnalysis({ navigateResult = "Page Title: App\nHTTP status: 200", analysis = "VERDICT: PASS — no defects." } = {}) {
  const mediaCalls = [];
  const browser = browserRegistry({ navigateResult });
  const media = {
    name: "media_analysis",
    description: "media_analysis",
    parameters: { type: "object", properties: {} },
    execute: async (_id, args) => {
      mediaCalls.push(args);
      return { output: analysis };
    },
  };
  const tools = new Map([...browser.registry.allTools().map((t) => [t.name, t]), [media.name, media]]);
  return {
    mediaCalls,
    registry: { getTool: (n) => tools.get(n), allTools: () => [...tools.values()] },
  };
}

test("analyze:true delegates to media_analysis lens:qa, not a parallel inline analyzer", async () => {
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", analyze: true }, { ...ctx, registry });

  assert.notEqual(res.isError, true);
  assert.equal(mediaCalls.length, 1, "exactly one media_analysis call must be made");
  // The delegation must use the QA lens (pass/fail), never the describe lens.
  assert.equal(mediaCalls[0].lens, "qa");
  // A persisted screenshot path is the contract media_analysis reads by.
  assert.match(mediaCalls[0].file, /turing-inspect-.*\.(png|jpg|webp)$/);
  // The inline hallucination-prone analysis is gone; the verdict comes through.
  assert.match(res.output, /VERDICT: PASS/);
  assert.doesNotMatch(res.output, /alignment issues|spacing inconsistencies/i, "no generic 'find issues' describer");
});

test("the inspect QA prompt scopes element states out of the verdict", async () => {
  // The run that looped: the dialog title WAS changed and verified, but the
  // analyst failed the screen because "Confirm is disabled" — the app's
  // intended state before input, which pixels cannot prove either way. The
  // prompt sent with the capture must tell the analyst exactly that.
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  await tools.get("activity_inspect").execute(
    "i",
    { url: "http://localhost:3000", analyze: true, expected: 'Dialog titled "Delete Account?" with Cancel and Confirm buttons' },
    { ...ctx, registry },
  );

  const prompt = mediaCalls[0].prompt ?? "";
  assert.match(prompt, /Delete Account\?/, "the expected claims travel with the capture");
  assert.match(prompt, /ONLY if the EXPECTED above says/i);
  assert.match(prompt, /non-deciding observations/i);
  // And the schema teaches the caller to state intended states up front.
  const desc = tools.get("activity_inspect").parameters.properties.expected.description;
  assert.match(desc, /Confirm disabled until the email/i);
  assert.match(desc, /judges an unstated state as a defect/i);
});

test("analyze:true with no media_analysis available degrades to a nudge, not a fake analysis", async () => {
  const { tools, ctx } = setup();
  // Browser registry WITHOUT a media_analysis tool.
  const { registry } = browserRegistry();
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", analyze: true }, { ...ctx, registry });

  // The screenshot is still captured and forwarded (the model needs to SEE it).
  assert.ok(Array.isArray(res.content) && res.content.some((b) => b.type === "image"));
  // But the analysis must NOT invent defects — it must say it could not analyse
  // and point at media_analysis. This is the "no substitute verification" rule.
  assert.match(res.output, /captured but not analysed/i);
  assert.match(res.output, /media_analysis/i);
  assert.match(res.output, /not a pass/i);
  assert.doesNotMatch(res.output, /VERDICT:|defects:/i, "no fabricated verdict when the verifier is absent");
});

// ---------------------------------------------------------------------------
// Reference-image gap analysis. When a reference image is supplied (explicit
// `reference` arg, or an image attached to the run via ctx.images),
// activity_inspect delegates a TWO-IMAGE comparison to media_analysis: the live
// capture vs the reference (a design mockup for replication, or a known-good
// screenshot for debugging). One call replaces the inspect→media_analysis dance.
// ---------------------------------------------------------------------------

/** A real temp PNG so the reference-existence check passes. Cleaned up by the caller. */
async function realReferenceFile(name = "reference.png") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activity-ref-"));
  const file = path.join(dir, name);
  // A minimal valid PNG (1x1) — the existence check only stats it.
  await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  return file;
}

test("a `reference` arg triggers a two-image gap analysis via media_analysis", async () => {
  const { tools, ctx } = setup();
  const reference = await realReferenceFile();
  const { mediaCalls, registry } = registryWithMediaAnalysis({
    analysis: "VERDICT: FAIL\n- (major) the hero copy reads 'Hello' but the reference reads 'Welcome'",
  });
  try {
    const res = await tools
      .get("activity_inspect")
      // No `analyze:true` — the reference alone implies the comparison.
      .execute("i", { url: "http://localhost:3000", reference }, { ...ctx, registry });

    assert.notEqual(res.isError, true);
    assert.equal(mediaCalls.length, 1, "exactly one media_analysis call (the gap analysis)");
    // Both images must reach the analyst: the persisted screenshot + the reference.
    assert.ok(Array.isArray(mediaCalls[0].files), "the comparison uses `files` (multi-attachment)");
    assert.equal(mediaCalls[0].files.length, 2, "live capture + reference");
    assert.match(mediaCalls[0].files[0], /turing-inspect-.*\.(png|jpg|webp)$/, "first file is the live capture");
    assert.equal(mediaCalls[0].files[1], reference, "second file is the reference");
    assert.equal(mediaCalls[0].lens, "qa", "reuses the qa lens so the verdict format is recognised");
    assert.match(mediaCalls[0].prompt, /LIVE CAPTURE/i);
    assert.match(mediaCalls[0].prompt, /REFERENCE/i);
    assert.match(res.output, /VERDICT: FAIL/);
  } finally {
    await fs.rm(path.dirname(reference), { recursive: true, force: true });
  }
});

test("an image attached to the run (ctx.images) is used when no `reference` arg is passed", async () => {
  const { tools, ctx } = setup();
  const reference = await realReferenceFile("known-good.png");
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  try {
    await tools
      .get("activity_inspect")
      .execute(
        "i",
        { url: "http://localhost:3000" },
        { ...ctx, registry, images: [{ path: reference, mimeType: "image/png" }] },
      );

    assert.equal(mediaCalls.length, 1, "the attached image triggered the gap analysis");
    assert.equal(mediaCalls[0].files[1], reference, "the run attachment is the reference");
  } finally {
    await fs.rm(path.dirname(reference), { recursive: true, force: true });
  }
});

test("an explicit `reference` arg wins over a run attachment", async () => {
  const { tools, ctx } = setup();
  const explicit = await realReferenceFile("explicit.png");
  const attachment = await realReferenceFile("attachment.png");
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  try {
    await tools
      .get("activity_inspect")
      .execute(
        "i",
        { url: "http://localhost:3000", reference: explicit },
        { ...ctx, registry, images: [{ path: attachment, mimeType: "image/png" }] },
      );

    assert.equal(mediaCalls[0].files[1], explicit, "the explicit arg outranks the attachment");
  } finally {
    await fs.rm(path.dirname(explicit), { recursive: true, force: true });
    await fs.rm(path.dirname(attachment), { recursive: true, force: true });
  }
});

test("a missing reference path is rejected cleanly, not silently degraded to single-image QA", async () => {
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", reference: "/tmp/does-not-exist-mockup.png" }, { ...ctx, registry });

  // The gap analysis must NOT run with a single image (the silent-degradation bug).
  assert.equal(mediaCalls.length, 0, "no media_analysis call when the reference is missing");
  // The error is surfaced clearly, with the live capture still attached.
  assert.match(res.output, /reference image.*does not exist/i);
  assert.ok(Array.isArray(res.content) && res.content.some((b) => b.type === "image"), "the capture is still attached");
});

test("the persisted screenshot temp file is cleaned up after analysis", async () => {
  // Guards the leak fix: analyzeCapture used to leave a turing-inspect-*.png in
  // os.tmpdir() on every call. Read the tmpdir contents before and after.
  const { tools, ctx } = setup();
  const { registry } = registryWithMediaAnalysis();
  const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("turing-inspect-"));
  await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", analyze: true }, { ...ctx, registry });
  // Give the async unlink a moment, then re-check.
  const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("turing-inspect-"));
  assert.equal(after.length, before.length, "no new turing-inspect-* temp files leaked");
});


test("no analyze flag → the capture IS analysed (one call captures and judges)", async () => {
  // `analyze` defaults ON. It used to default off, which made the tool the prompts
  // nominate as THE way to verify a screen return, by default, a screenshot with no
  // verdict attached — and the verification gate accepted that as a check. It also
  // produced a duplicate QA pass whenever the model followed the prompt and called
  // `media_analysis` on the capture itself.
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  await tools.get("activity_inspect").execute("i", { url: "http://localhost:3000" }, { ...ctx, registry });
  assert.equal(mediaCalls.length, 1, "the default capture is evaluated, not just taken");
  assert.equal(mediaCalls[0].lens, "qa", "and judged with the verdict-producing lens");
});

test("analyze:false is still an opt-out — a raw capture with no verdict", async () => {
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", analyze: false }, { ...ctx, registry });
  assert.equal(mediaCalls.length, 0, "an explicit opt-out does not invoke the analyser");
});

test("`expected` reaches the analyser, so the verdict is judged against the change", async () => {
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", expected: "the heading reads Welcome Back" }, { ...ctx, registry });
  assert.equal(mediaCalls.length, 1);
  assert.match(mediaCalls[0].prompt, /Welcome Back/, "the expectation must be in the prompt");
});

test("analyze:true without a reference keeps the single-image QA behaviour", async () => {
  const { tools, ctx } = setup();
  const { mediaCalls, registry } = registryWithMediaAnalysis();
  await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", analyze: true }, { ...ctx, registry });
  // Single-image: `file` (not `files`), and the standard QA prompt.
  assert.equal(mediaCalls[0].file !== undefined, true, "the no-reference path uses `file`, not `files`");
  assert.equal(mediaCalls[0].files, undefined);
  assert.doesNotMatch(mediaCalls[0].prompt, /LIVE CAPTURE.*REFERENCE|REFERENCE/i, "no two-image framing");
});

test("a reference with no media_analysis available degrades to the same nudge", async () => {
  const { tools, ctx } = setup();
  const { registry } = browserRegistry(); // no media_analysis tool
  const res = await tools
    .get("activity_inspect")
    .execute("i", { url: "http://localhost:3000", reference: "/tmp/mockup.png" }, { ...ctx, registry });
  assert.ok(Array.isArray(res.content) && res.content.some((b) => b.type === "image"));
  assert.match(res.output, /captured but not analysed/i);
  assert.doesNotMatch(res.output, /VERDICT:/i, "no fabricated verdict without the verifier");
});


test("analyze:true on the mobile path also delegates to media_analysis lens:qa", async () => {
  const { tools, ctx } = setup();
  const mediaCalls = [];
  const media = {
    name: "media_analysis",
    description: "media_analysis",
    parameters: { type: "object", properties: {} },
    execute: async (_id, args) => { mediaCalls.push(args); return { output: "VERDICT: FAIL — status text stale." }; },
  };
  const registry = { getTool: (n) => (n === "media_analysis" ? media : undefined), allTools: () => [media] };

  const res = await withDevice({}, () =>
    tools
      .get("activity_inspect")
      .execute("i", { target: "mobile", bundleId: "com.example.app", analyze: true }, { ...ctx, registry }),
  );

  assert.equal(mediaCalls.length, 1);
  assert.equal(mediaCalls[0].lens, "qa");
  assert.match(res.output, /VERDICT: FAIL/);
});

// ---------------------------------------------------------------------------
// Browser and localhost logs. The specific failure this addresses: `__t()` in
// front-end code called require("fs"), which is a no-op in a browser — so the
// devtools console filled up, the trace file stayed empty, and the only recovery
// was asking the user to run the whole flow again.
// ---------------------------------------------------------------------------

test("a trace session stands up a local sink and a prefix line reaches collect", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-sink-"));
  const tools = new Map(createActivityMonitorTools({ logStore: new LogStore() }).map((t) => [t.name, t]));
  const res = await tools.get("activity_trace_start").execute(
    "c1", { language: "typescript", hint: "hero click does nothing" }, { cwd: dir, log: () => {} },
  );

  const { traceId, traceFile, collectorUrl } = res.details;
  assert.match(collectorUrl, /^http:\/\/127\.0\.0\.1:\d+\/t$/, "bound to loopback only, never a public interface");
  assert.ok(res.output.includes("TURING_TRACE"), "the model is told the prefix to use");

  // A line carrying THIS session's marker, POSTed to the sink, lands in the same
  // trace file — and only the session's marker is collected.
  const line = `${traceMarker(traceId)} [2026-01-01T00:00:00.000Z] hero button clicked {"id":7}`;
  const posted = await fetch(collectorUrl, { method: "POST", body: line });
  assert.equal(posted.status, 204);

  const collected = await tools.get("activity_collect").execute(
    "c2", { traceId, waitMs: 500 }, { cwd: dir, log: () => {} },
  );
  assert.match(collected.output, /hero button clicked/, "a prefix line reaches activity_collect");
  assert.ok((await fs.readFile(traceFile, "utf8")).includes("hero button clicked"));

  // Cleanup closes the port rather than holding it for the life of the process.
  const cleaned = await tools.get("activity_cleanup").execute("c3", { traceId }, { cwd: dir, log: () => {} });
  assert.match(cleaned.output, /Closed the browser\/localhost trace sink/);
  await assert.rejects(fetch(collectorUrl, { method: "POST", body: "x" }), "the sink is really closed");

  await fs.rm(dir, { recursive: true, force: true });
});

test("the debugging guidance encodes the whole loop, not just the tools", () => {
  // Who runs the app is settled before anything is instrumented.
  assert.match(DEBUGGING_LOOP, /WHO RUNS THE SYSTEM — settle this FIRST/);
  assert.match(DEBUGGING_LOOP, /ask \("ask_user_question"\) whether you/);
  // Instrument the risk sites, and end-to-end so the gap is visible.
  assert.match(DEBUGGING_LOOP, /INSTRUMENT WHERE CODE ACTUALLY BREAKS/);
  assert.match(DEBUGGING_LOOP, /WHERE THE TRAIL STOPS/);
  assert.match(DEBUGGING_LOOP, /cannot tell you your suspicion was wrong/);
  // The vanishing-logs failure is named so it is not re-diagnosed as a dead flow.
  assert.match(DEBUGGING_LOOP, /LOGS THAT ACTUALLY GET WRITTEN/);
  assert.match(DEBUGGING_LOOP, /no `TURING_TRACE` lines means the flow didn't reach the log point/);
  // Running a slice of code beats running the whole app. This used to be its own
  // step; it now lives on the cheap-to-expensive ladder, where the choice
  // actually gets made, rather than as a reminder further down.
  assert.match(DEBUGGING_LOOP, /NARROWEST real execution you can arrange/);
  assert.match(DEBUGGING_LOOP, /scratch script that imports/);
  // UI: probe one component, hand it to the right media lens with a real prompt.
  assert.match(DEBUGGING_LOOP, /data-turing-probe/);
  assert.match(DEBUGGING_LOOP, /lens:"component"/);
  assert.match(DEBUGGING_LOOP, /not\n?\s*just "look at this"/);
  // The part that is usually skipped.
  assert.match(DEBUGGING_LOOP, /FIXED: remove every `TURING_TRACE`/);
  assert.match(DEBUGGING_LOOP, /NOT FIXED: REVERT that change before trying the next one/);
  assert.match(DEBUGGING_LOOP, /the same hypothesis twice is not/);
  assert.match(DEBUGGING_LOOP, /Never report a bug as fixed on the strength of the code looking right/);

  assert.ok(WORK_PROMPT.includes(DEBUGGING_LOOP));
  assert.ok(CATEGORIZER_PROMPTS.activity_inspect.includes(DEBUGGING_LOOP), "missing from activity_inspect");
  // The old, thinner RUNTIME DEBUGGING section is retired, not left to drift.
  assert.doesNotMatch(WORK_PROMPT, /RUNTIME DEBUGGING \(when reading/);
});

// ---------------------------------------------------------------------------
// The probe helper must work in an ES MODULE.
//
// Found by driving a real reproduce-first run: in a `.mjs` / `"type":"module"`
// file — i.e. most modern Node projects — there is no `require`, so `__t_fs()`
// fell through every branch, the catch swallowed it, and each probe wrote to the
// console only. The trace collected ZERO lines and the model was told "either the
// instrumented code has not run, or the helper is not writing" with no way to
// tell which. `process.getBuiltinModule` is the sync ESM-safe path.
// ---------------------------------------------------------------------------

test("a TURING_TRACE stdout line reaches the trace file when stdout is piped", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-esm-"));
  const traceFile = path.join(dir, "trace.log");

  // No helper, no imports: a plain stdout line carrying the prefix, as
  // `activity_trace_start` tells the model to write.
  const script = path.join(dir, "run.mjs");
  await fs.writeFile(script, 'console.log("TURING_TRACE probe ran", { ok: true });\n');
  // `activity_trace_start` pipes the run's stdout into the trace file — mirror it
  // by capturing the child's stdout and writing it where collect reads.
  const run = await promisify(execFile)(process.execPath, [script]);
  await fs.writeFile(traceFile, (run.stdout ?? "") + (run.stderr ?? ""));

  const written = await fs.readFile(traceFile, "utf8");
  assert.match(written, /TURING_TRACE probe ran/, "the prefix line reached the trace file via stdout");
});


// ---------------------------------------------------------------------------
// add_log — logging that is not an edit.
//
// Written after a real run showed why "the model MAY place `__t()` calls with
// `edit`" does not work: the gate opened a trace, refused the premature fix, said
// probes were permitted — and the model opened a SECOND trace and went back to
// reading source. Nothing was instrumented, the trace stayed dry, nothing was
// observed. Logging needs to be its own action: `edit`'s anchor shape (so the model
// writes the message and the values it wants) with none of `edit`'s machinery — no
// authoring model, no verification debt, and no ability to change code.
// ---------------------------------------------------------------------------

/**
 * `setup()` points ctx.cwd at the shared tmpdir, which is fine for tools that only
 * read a trace file. `add_log` WRITES project files, so it gets an isolated working
 * dir — otherwise two tests log into each other's fixtures.
 */
async function setupInDir() {
  const logStore = new LogStore();
  const tools = new Map(createActivityMonitorTools({ logStore }).map((t) => [t.name, t]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "add-log-"));
  return { logStore, tools, dir, ctx: { cwd: dir, log: (entry) => logStore.append(entry) } };
}

test("add_log writes the line verbatim and adds the helper once", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const marker = traceMarker(traceId);
  const file = path.join(dir, "svc.ts");
  await fs.writeFile(file, ["export function tick(status: string) {", "  const changed = status !== last;", "  return changed;", "}", ""].join("\n"));

  const res = await tools.get("add_log").execute("l", {
    traceId, path: "svc.ts",
    oldString: "  const changed = status !== last;",
    newString: `  const changed = status !== last;\n  console.log("${marker} status compared", { status, changed });`,
  }, ctx);

  assert.equal(res.isError, undefined, res.output);
  const after = await fs.readFile(file, "utf8");
  assert.match(after, new RegExp(`console\\.log\\("${marker} status compared", \\{ status, changed \\}\\);`), "the line is EXACTLY what was asked for");
  assert.match(after, /const changed = status !== last;/, "the anchor line survives");
  assert.equal(res.details.kind, "insert");
  assert.match(res.output, /RUN THE FLOW/);

  // A second call on the same file just adds a second prefix line — nothing to stack.
  const again = await tools.get("add_log").execute("l2", {
    traceId, path: "svc.ts",
    oldString: "  return changed;",
    newString: `  console.log("${marker} returning", { changed });\n  return changed;`,
  }, ctx);
  assert.equal(again.isError, undefined, again.output);
  const twice = await fs.readFile(file, "utf8");
  assert.equal(twice.match(/TURING_TRACE/g).length, 2, "two marker lines now");
});

test("add_log REFUSES a bare or foreign marker and names the session's own", async () => {
  // A probe carrying the wrong marker emits lines this session's collect will
  // never show — the flow then looks dead. The refusal teaches the exact line.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const marker = traceMarker(traceId);
  const file = path.join(dir, "wrong.ts");
  await fs.writeFile(file, ["export function go() {", "  const same = true;", "}", ""].join("\n"));

  const res = await tools.get("add_log").execute("l", {
    traceId, path: "wrong.ts",
    oldString: "  const same = true;",
    newString: '  const same = true;\n  console.log("TURING_TRACE same", { same });',
  }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /THIS session's marker/);
  assert.ok(res.output.includes(marker), "the refusal names the marker to use");
  assert.match(res.output, /activity_collect/);
  assert.equal(await fs.readFile(file, "utf8"), ["export function go() {", "  const same = true;", "}", ""].join("\n"), "nothing was written");
});

test("add_log REFUSES anything that is not log-only", async () => {
  // The hole a "just write the file" tool would be: it would let the unobserved fix
  // through the gate wearing a log. Every anchor line must survive verbatim.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const file = path.join(dir, "fix.ts");
  const original = ["export function go(a, b) {", "  const same = a === b;", "  return same;", "}", ""].join("\n");
  await fs.writeFile(file, original);

  for (const [why, newString] of [
    ["a rewritten line", '  const same = normalize(a) === normalize(b);\n  console.log("TURING_TRACE compared", { same });'],
    ["a deleted line", '  console.log("TURING_TRACE compared");'],
    ["no log at all", "  const same = a === b; // tidy up"],
  ]) {
    const res = await tools.get("add_log").execute("l", {
      traceId, path: "fix.ts", oldString: "  const same = a === b;", newString,
    }, ctx);
    assert.ok(res.isError, `${why} must be refused`);
    assert.match(res.output, /not log-only|fix/i);
    assert.equal(await fs.readFile(file, "utf8"), original, `${why}: the file is untouched`);
  }
});

test("add_log puts the helper AFTER a language's leading directives", async () => {
  // Dart rejects a declaration before its imports, so a helper at line 1 does not
  // compile — and that surfaces later as a trace that captured nothing, which reads
  // like a harness bug rather than a placement bug.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx, { language: "dart" });
  const file = path.join(dir, "provider.dart");
  await fs.writeFile(file, [
    "import 'dart:async';",
    "import 'package:flutter/foundation.dart';",
    "",
    "class LeadsProvider {",
    "  Future<void> reload() async {",
    "    final lead = await fetch();",
    "  }",
    "}",
    "",
  ].join("\n"));

  const res = await tools.get("add_log").execute("l", {
    traceId, path: "provider.dart",
    oldString: "    final lead = await fetch();",
    newString: `    final lead = await fetch();\n    console.log("${traceMarker(traceId)} reload fetched", {"id": lead.id});`,
  }, ctx);
  assert.equal(res.isError, undefined, res.output);

  const lines = (await fs.readFile(file, "utf8")).split("\n");
  assert.equal(lines.findIndex((l) => l.startsWith("import ")), 0, "imports still lead the file");
  assert.ok(
    lines.some((l) => l.includes(`${traceMarker(traceId)} reload fetched`)),
    "the session-marker log line landed",
  );
});

test("add_log needs an open trace, and says which when several are open", async () => {
  // `activeTraces` is module-global, so this test owns it for the duration —
  // otherwise "no session is open" is a claim about test ordering, not behaviour.
  const { __activeTracesForTest: sessions } = await import("../dist/tools/builtin/activity-monitor.js");
  const saved = [...sessions.entries()];
  sessions.clear();
  try {
    const { tools, ctx, dir } = await setupInDir();
    await fs.writeFile(path.join(dir, "x.ts"), "const a = 1;\n");
    const args = { path: "x.ts", oldString: "const a = 1;", newString: 'const a = 1;\nconsole.log("TURING_TRACE a");' };

    const none = await tools.get("add_log").execute("l", args, ctx);
    assert.ok(none.isError);
    assert.match(none.output, /no trace session is open/);
    assert.match(none.output, /activity_trace_start/);

    // Exactly one open session: the traceId is optional — friction with no upside.
    const { traceId } = await startTrace(tools, ctx);
    const sessionArgs = {
      path: "x.ts", oldString: "const a = 1;",
      newString: `const a = 1;\nconsole.log("${traceMarker(traceId)} a");`,
    };
    const implicit = await tools.get("add_log").execute("l", sessionArgs, ctx);
    assert.equal(implicit.isError, undefined, implicit.output);
    assert.equal(implicit.details.traceId, traceId);

    // Two open sessions: it must ask which, not pick one.
    const second = await startTrace(tools, ctx, { language: "python" });
    await fs.writeFile(path.join(dir, "y.ts"), "const b = 2;\n");
    const ambiguous = await tools.get("add_log").execute("l", {
      path: "y.ts", oldString: "const b = 2;", newString: 'const b = 2;\nconsole.log("TURING_TRACE b");',
    }, ctx);
    assert.ok(ambiguous.isError);
    assert.match(ambiguous.output, /2 trace sessions are open/);
    assert.match(ambiguous.output, new RegExp(traceId));
    assert.match(ambiguous.output, new RegExp(second.traceId));

    // A named session that does not exist is its own error.
    const unknown = await tools.get("add_log").execute("l", { ...args, traceId: "turing-trace-nope" }, ctx);
    assert.ok(unknown.isError);
    assert.match(unknown.output, /no open trace session/);
  } finally {
    sessions.clear();
    for (const [k, v] of saved) sessions.set(k, v);
  }
});

test("add_log rejects an ambiguous or missing anchor rather than guessing", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const marker = traceMarker(traceId);
  const file = path.join(dir, "amb.ts");
  await fs.writeFile(file, ["call();", "call();", ""].join("\n"));

  const dup = await tools.get("add_log").execute("l", {
    traceId, path: "amb.ts", oldString: "call();", newString: `call();\nconsole.log("${marker} called");`,
  }, ctx);
  assert.ok(dup.isError);
  assert.match(dup.output, /appears 2 times/);

  const missing = await tools.get("add_log").execute("l", {
    traceId, path: "amb.ts", oldString: "nope();", newString: `nope();\nconsole.log("${marker} x");`,
  }, ctx);
  assert.ok(missing.isError);
  assert.match(missing.output, /not found/);

  // replaceAll is the documented way to log every occurrence.
  const all = await tools.get("add_log").execute("l", {
    traceId, path: "amb.ts", oldString: "call();", newString: `call();\nconsole.log("${marker} called");`, replaceAll: true,
  }, ctx);
  assert.equal(all.isError, undefined, all.output);
  assert.equal((await fs.readFile(file, "utf8")).match(/console\.log\("TURING_TRACE[_A-Za-z0-9-]* called"\)/g).length, 2);
});

test("activity_cleanup takes the logs back out, exactly", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const file = path.join(dir, "round.ts");
  const original = [
    "export function tick(status: string) {",
    "  if (!status) return false;",
    "  const changed = status !== last;",
    "  return changed;",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(file, original);

  await tools.get("add_log").execute("l1", {
    traceId, path: "round.ts",
    oldString: "  if (!status) return false;",
    newString: `  console.log("${traceMarker(traceId)} guard reached", { status });\n  if (!status) return false;`,
  }, ctx);
  await tools.get("add_log").execute("l2", {
    traceId, path: "round.ts",
    oldString: "  const changed = status !== last;",
    newString: `  const changed = status !== last;\n  console.log("${traceMarker(traceId)} compared", { changed });`,
  }, ctx);
  assert.notEqual(await fs.readFile(file, "utf8"), original, "logs are in");

  const clean = await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
  assert.equal(clean.isError, undefined, clean.output);
  assert.equal(await fs.readFile(file, "utf8"), original, "the file is byte-identical to before");
  assert.deepEqual(clean.details.stripped, [file]);
  assert.deepEqual(clean.details.remaining, []);
});

test("the round trip is byte-exact even in a file full of blank lines", async () => {
  // The bug this pins: the helper block was spliced in as ONE multi-line element,
  // which recorded a phantom trailing empty line. "Remove one blank line" then
  // matched the FIRST blank anywhere in the file — so cleanup deleted a blank from
  // the imports and left the helper's own, restoring a file of the right length and
  // the wrong content. Caught only by comparing bytes on a real source file.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx, { language: "dart" });
  const file = path.join(dir, "spaced.dart");
  const original = [
    "import 'dart:async';", "", "", "import 'package:flutter/foundation.dart';", "",
    "class P {", "", "  Future<void> reload() async {", "", "    final lead = await fetch();", "", "  }", "", "}", "",
  ].join("\n");
  await fs.writeFile(file, original);

  await tools.get("add_log").execute("l", {
    traceId, path: "spaced.dart",
    oldString: "    final lead = await fetch();",
    newString: `    final lead = await fetch();\n    console.log("${traceMarker(traceId)} fetched");`,
  }, ctx);
  assert.notEqual(await fs.readFile(file, "utf8"), original);

  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
  assert.equal(await fs.readFile(file, "utf8"), original, "byte-for-byte, blank lines included");
});

test("cleanup removes only what it added, never a hand-written log's own line", async () => {
  // `if (x) console.log("TURING_TRACE y");` carries a marker AND a guard. Any rule broad enough to delete
  // helper lines by shape would delete that too, dropping the guard during a step
  // whose whole job is to leave no trace. So it is left and REPORTED.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const file = path.join(dir, "hand.ts");
  await fs.writeFile(file, ["export function go(x) {", "  return x;", "}", ""].join("\n"));
  await tools.get("add_log").execute("l", {
    traceId, path: "hand.ts", oldString: "  return x;", newString: `  console.log("${traceMarker(traceId)} returning", { x });\n  return x;`,
  }, ctx);

  const withHand = (await fs.readFile(file, "utf8")).replace(
    "export function go(x) {",
    'export function go(x) {\n  if (x) console.log("TURING_TRACE hand-written");',
  );
  await fs.writeFile(file, withHand);

  const clean = await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
  const after = await fs.readFile(file, "utf8");
  assert.match(after, /if \(x\) console\.log\("TURING_TRACE hand-written"\);/, "the fused line was NOT deleted");
  assert.doesNotMatch(after, new RegExp(`console\\.log\\("${traceMarker(traceId)} returning"`), "the added line WAS removed");
  assert.ok(clean.details.remaining.length > 0, "and the leftover is reported, not silently shipped");
});

test("a second trace_start REUSES an open session that has no logs yet", async () => {
  // The observed move: refused a premature fix, told that logging was permitted, and
  // the run opened ANOTHER trace and went back to reading source. Two empty sessions,
  // nothing logged, nothing observed. Reusing is what stops that WITHOUT the failure
  // mode a refusal has — `activeTraces` outlives a run, so refusing on behalf of an
  // abandoned session would break the first step of every later run.
  const { tools, ctx, dir } = await setupInDir();
  const first = await tools.get("activity_trace_start").execute("t1", { language: "typescript" }, ctx);
  const traceId = first.details.traceId;
  assert.equal(first.details.reused, undefined);

  const second = await tools.get("activity_trace_start").execute("t2", { language: "typescript" }, ctx);
  assert.equal(second.isError, undefined, "the call SUCCEEDS — a usable traceId always comes back");
  assert.equal(second.details.traceId, traceId, "and it is the session that already existed");
  assert.equal(second.details.reused, true);
  assert.match(second.output, /Reusing the open trace session/);
  assert.match(second.output, /add_log/, "and it names the step that was actually missing");

  // Once the session HAS logs, a further session is a legitimate ask again.
  const file = path.join(dir, "x.ts");
  await fs.writeFile(file, ["function f() {", "  return 1;", "}", ""].join("\n"));
  await tools.get("add_log").execute("l", {
    traceId, path: "x.ts", oldString: "  return 1;", newString: `  console.log("${traceMarker(traceId)} returning");\n  return 1;`,
  }, ctx);
  const third = await tools.get("activity_trace_start").execute("t3", { language: "typescript" }, ctx);
  assert.equal(third.details.reused, undefined, "a session with logs no longer absorbs a new one");
  assert.notEqual(third.details.traceId, traceId);

  // A different project never reuses another project's session.
  const other = await setupInDir();
  const elsewhere = await tools.get("activity_trace_start").execute("t4", { language: "typescript" }, other.ctx);
  assert.equal(elsewhere.details.reused, undefined, "reuse is scoped to the project");

  for (const id of [traceId, third.details.traceId, elsewhere.details.traceId]) {
    await tools.get("activity_cleanup").execute("c", { traceId: id }, ctx);
  }
});

test("an abandoned session from an earlier run never blocks a later one", async () => {
  // `activeTraces` is module-global and the harness process outlives a run. If a
  // run ends with an un-probed session open — which is exactly what the wedged run
  // did, twice — honouring it forever would turn one bad run into every subsequent
  // run refused at the first step. Stale un-probed sessions are reaped instead.
  const { tools, ctx } = await setupInDir();
  const stale = await tools.get("activity_trace_start").execute("t1", { language: "typescript" }, ctx);
  const staleId = stale.details.traceId;

  // Age it past the window, the way a previous run's leftovers would be.
  const { __activeTracesForTest } = await import("../dist/tools/builtin/activity-monitor.js");
  assert.ok(__activeTracesForTest, "the session map is reachable for this test");
  __activeTracesForTest.get(staleId).startedAt = Date.now() - 11 * 60 * 1000;

  const next = await tools.get("activity_trace_start").execute("t2", { language: "typescript" }, ctx);
  assert.equal(next.isError, undefined, "a new session opens despite the abandoned one");
  assert.notEqual(next.details.traceId, staleId, "the abandoned session is not handed back");
  assert.equal(__activeTracesForTest.has(staleId), false, "it was reaped");
  await tools.get("activity_cleanup").execute("c", { traceId: next.details.traceId }, ctx);
});

// ---------------------------------------------------------------------------
// remove_log — take one log out, or all of them.
//
// The id matters mid-investigation: a log at the wrong point is noise in every
// later collect, and the alternative was tearing the whole session down and
// re-adding everything else. The helper's lifetime is the subtle part — removing it
// while another `__t()` call survives leaves a syntax-clean file that throws the
// moment the logged path runs, which is worse than a leftover helper.
// ---------------------------------------------------------------------------

/** Add one log and return its id. */
async function addLog(tools, ctx, traceId, path_, oldString, message) {
  const res = await tools.get("add_log").execute("l", {
    traceId, path: path_, oldString,
    newString: `${oldString}\n  console.log("${traceMarker(traceId)} ${message}");`,
  }, ctx);
  assert.equal(res.isError, undefined, res.output);
  return res.details.logId;
}

test("add_log hands back an id, and remove_log takes out exactly that one", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const file = path.join(dir, "two.ts");
  const original = ["function f(a, b) {", "  const x = a + b;", "  const y = x * 2;", "  return y;", "}", ""].join("\n");
  await fs.writeFile(file, original);

  const first = await addLog(tools, ctx, traceId, "two.ts", "  const x = a + b;", "x computed");
  const second = await addLog(tools, ctx, traceId, "two.ts", "  const y = x * 2;", "y computed");
  assert.match(first, /^log-\d+$/);
  assert.match(second, /^log-\d+$/);
  assert.notEqual(first, second, "each add_log call gets its own id");

  const res = await tools.get("remove_log").execute("r", { logId: first }, ctx);
  assert.equal(res.isError, undefined, res.output);
  const after = await fs.readFile(file, "utf8");
  assert.doesNotMatch(after, /x computed/, "the named log is gone");
  assert.match(after, /y computed/, "the other log survives");
  assert.match(res.output, new RegExp("Removed `" + first + "`"));
  assert.match(res.output, /x computed/, "and it says what it took out");
  assert.deepEqual(res.details.remainingLogIds, [second]);

  // Removing the last one takes the helper with it, and restores the file.
  const res2 = await tools.get("remove_log").execute("r2", { logId: second }, ctx);
  assert.equal(res2.isError, undefined, res2.output);
  assert.equal(await fs.readFile(file, "utf8"), original, "byte-for-byte back to the original");
  assert.deepEqual(res2.details.remainingLogIds, []);
  assert.match(res2.output, /No logging from this session remains/);
});

test("remove_log with all:true clears every log across every file", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const a = path.join(dir, "a.ts");
  const b = path.join(dir, "b.ts");
  const originalA = ["export function ga() {", "  return 1;", "}", ""].join("\n");
  const originalB = ["export function gb() {", "  return 2;", "}", ""].join("\n");
  await fs.writeFile(a, originalA);
  await fs.writeFile(b, originalB);

  await addLog(tools, ctx, traceId, "a.ts", "  return 1;", "a returning");
  await addLog(tools, ctx, traceId, "b.ts", "  return 2;", "b returning");

  // `traceId` is explicit here: with several sessions open, `all` correctly refuses
  // to guess which one it should clear.
  const res = await tools.get("remove_log").execute("r", { all: true, traceId }, ctx);
  assert.equal(res.isError, undefined, res.output);
  assert.equal(await fs.readFile(a, "utf8"), originalA);
  assert.equal(await fs.readFile(b, "utf8"), originalB);
  assert.equal(res.details.removed.length, 2);
  assert.deepEqual(res.details.remainingLogIds, []);

  // The session is still open — that is the difference from activity_cleanup.
  const { __activeTracesForTest: sessions } = await import("../dist/tools/builtin/activity-monitor.js");
  assert.ok(sessions.has(traceId), "removing logs does not end the session");
  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
});

test("remove_log with all + path clears one file and leaves the other", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const a = path.join(dir, "keep.ts");
  const b = path.join(dir, "clear.ts");
  await fs.writeFile(a, ["export function k() {", "  return 1;", "}", ""].join("\n"));
  const originalB = ["export function c() {", "  return 2;", "}", ""].join("\n");
  await fs.writeFile(b, originalB);
  const keep = await addLog(tools, ctx, traceId, "keep.ts", "  return 1;", "keep me");
  await addLog(tools, ctx, traceId, "clear.ts", "  return 2;", "clear me");

  const res = await tools.get("remove_log").execute("r", { all: true, path: "clear.ts", traceId }, ctx);
  assert.equal(res.isError, undefined, res.output);
  assert.equal(await fs.readFile(b, "utf8"), originalB, "the named file is clean");
  assert.match(await fs.readFile(a, "utf8"), /keep me/, "the other file is untouched");
  assert.deepEqual(res.details.remainingLogIds, [keep]);
  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
});

test("remove_log finds the session from the logId alone", async () => {
  // The caller should not have to remember which session a log belonged to.
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  const file = path.join(dir, "s.ts");
  await fs.writeFile(file, ["function f() {", "  return 1;", "}", ""].join("\n"));
  const id = await addLog(tools, ctx, traceId, "s.ts", "  return 1;", "returning");

  const res = await tools.get("remove_log").execute("r", { logId: id }, ctx);
  assert.equal(res.isError, undefined, res.output);
  assert.equal(res.details.traceId, traceId, "the session was inferred");
  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
});

test("remove_log explains itself rather than half-acting", async () => {
  const { tools, ctx, dir } = await setupInDir();
  const { traceId } = await startTrace(tools, ctx);
  await fs.writeFile(path.join(dir, "z.ts"), "const z = 1;\n");

  // Neither scope given.
  const vague = await tools.get("remove_log").execute("r", {}, ctx);
  assert.ok(vague.isError);
  assert.match(vague.output, /logId/);
  assert.match(vague.output, /all: true/);

  // An id that never existed, listing what does.
  const id = await addLog(tools, ctx, traceId, "z.ts", "const z = 1;", "z");
  const unknown = await tools.get("remove_log").execute("r", { logId: "log-999" }, ctx);
  assert.ok(unknown.isError);
  assert.match(unknown.output, /no open session has a log/);
  assert.match(unknown.output, new RegExp(id), "and it names the ids that exist");

  // Removing the same id twice is refused clearly, not silently repeated.
  await tools.get("remove_log").execute("r", { logId: id }, ctx);
  const again = await tools.get("remove_log").execute("r", { logId: id }, ctx);
  assert.ok(again.isError);
  assert.match(again.output, /no open session has a log|already be removed/);
  await tools.get("activity_cleanup").execute("c", { traceId }, ctx);
});

test("all:true with one open session needs no traceId", async () => {
  // The common case: one session, and the model should not have to restate its id.
  const { __activeTracesForTest: sessions } = await import("../dist/tools/builtin/activity-monitor.js");
  const saved = [...sessions.entries()];
  sessions.clear();
  try {
    const { tools, ctx, dir } = await setupInDir();
    const { traceId } = await startTrace(tools, ctx);
    const file = path.join(dir, "solo.ts");
    const original = ["function f() {", "  return 1;", "}", ""].join("\n");
    await fs.writeFile(file, original);
    await addLog(tools, ctx, traceId, "solo.ts", "  return 1;", "returning");

    const res = await tools.get("remove_log").execute("r", { all: true }, ctx);
    assert.equal(res.isError, undefined, res.output);
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    sessions.clear();
    for (const [k, v] of saved) sessions.set(k, v);
  }
});

// ---------------------------------------------------------------------------
// The refusal that had no way out
// ---------------------------------------------------------------------------

/**
 * From a real run: the reproduce hop wanted to log inside `if (setEquals(a, b))
 * return;`. You cannot do that without adding braces, and adding them changes an
 * existing line, so `add_log` refused — correctly, and with nothing to try next.
 * The model then spent a dozen turns going around it: `sed -i`, a hallucinated
 * `shell` tool, and finally four `python3` heredocs that rewrote the source.
 *
 * The way through is always available and purely additive: log the DECISION on a
 * new line above, printing the values that decide which way it goes.
 */
test("add_log's log-only refusal names the additive way through", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "add-log-braces-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "screen.dart");
  const source = [
    "void recompute() {",
    "  final ids = provider.enrichingIds;",
    "  if (setEquals(ids, last)) return;",
    "  last = ids;",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(file, source);

  const reg = new Registry();
  registerBuiltins(reg, { logStore: new LogStore() });
  const ctx = { cwd: dir, log: () => {} };
  const started = await reg.getTool("activity_trace_start").execute("i", { language: "dart", hint: "polling" }, ctx);
  const traceId = started.details?.traceId;
  const marker = started.output.match(/TURING_TRACE_[a-z0-9]+/)?.[0];
  assert.ok(traceId && marker, "a trace session and its marker");

  // What the run actually tried: braces around the early return so a log fits.
  const anchor = "  if (setEquals(ids, last)) return;";
  const braced = await reg.getTool("add_log").execute(
    "i",
    { path: file, oldString: anchor, newString: `  if (setEquals(ids, last)) {\n    print("${marker} early");\n    return;\n  }`, traceId },
    ctx,
  );
  assert.equal(braced.isError, true, "still refused — adding braces is a code change");
  assert.match(braced.output, /IF THE LINE YOU WANT TO LOG INSIDE HAS NO BRACES/);
  assert.match(braced.output, /on a new line directly ABOVE it/);
  assert.equal(await fs.readFile(file, "utf8"), source, "and nothing was written");

  // The alternative the refusal names, and it works.
  const above = await reg.getTool("add_log").execute(
    "i",
    { path: file, oldString: anchor, newString: `  print("${marker} recompute ids=$ids last=$last");\n${anchor}`, traceId },
    ctx,
  );
  assert.equal(above.isError ?? false, false, "logging the decision is accepted");
  const written = await fs.readFile(file, "utf8");
  assert.match(written, /print\("TURING_TRACE_[a-z0-9]+ recompute ids=\$ids last=\$last"\);/);
  assert.match(written, /^ {2}if \(setEquals\(ids, last\)\) return;$/m, "the decision line is byte-identical");
});
