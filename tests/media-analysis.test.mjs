/**
 * Tests for the `media_analysis` tool (formerly `image_analysis`, before that
 * `ui_screen_auditor`).
 *
 * It takes a prompt plus `file`/`files` of any modality — image, video, audio,
 * document — classifies each one, reads the bytes off disk (or references the path
 * when inlining would be wrong), and calls a multimodal model over the OpenRouter
 * bridge. Freeform only: there is no structured QA mode.
 *
 * All offline — a stub bridge captures exactly what would go over the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LOOP_SYSTEM_PROMPT,
  MEDIA_UNDERSTANDING,
  OpenRouterBridge,
  Registry,
  classifyMedia,
  createMediaAnalysisTool,
  lensSystemPrompt,
  resolveLens,
} from "../dist/index.js";

// A 1x1 PNG — enough to prove the bytes are read and base64-encoded.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeBridge(replyText) {
  const llm = new OpenRouterBridge();
  const seen = [];
  llm.complete = async (model, ctx) => {
    seen.push({ model: model.openRouterSlug ?? model.id, ctx });
    return {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      model: model.openRouterSlug ?? model.id,
      api: "openrouter", provider: "test",
      usage: zeroUsage(), stopReason: "stop", timestamp: 0,
    };
  };
  return { llm, seen };
}

/** Write a fixture with arbitrary bytes; defaults to the 1x1 PNG. */
async function tmpFile(name = "mockup.png", bytes = PNG_BYTES) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-analysis-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { dir, file };
}

function ctxFor(llm, dir, extra = {}) {
  return { cwd: dir, llm, log: () => {}, ...extra };
}

function contentOf(seen, i = 0) {
  return seen[i].ctx.messages[0].content;
}

test("media_analysis: sends the image bytes + prompt and returns the analysis", async () => {
  const { dir, file } = await tmpFile();
  const { llm, seen } = makeBridge("A login form with a centered card and a blue primary button.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "What does this show?" }, ctxFor(llm, dir));

  assert.equal(res.isError ?? false, false);
  assert.match(res.output, /login form/);
  assert.equal(res.details.analysis, "A login form with a centered card and a blue primary button.");
  assert.deepEqual(res.details.analyzed.map((m) => [m.path, m.kind]), [[file, "image"]]);

  // The wire payload: the prompt as text, then the image as base64 with a mime type.
  const content = contentOf(seen);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "What does this show?");
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
  assert.equal(content[1].data, PNG_BYTES.toString("base64"));
  assert.match(seen[0].ctx.systemPrompt, /precise media analyst/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: `files` analyzes several attachments in one call", async () => {
  const { dir, file: before } = await tmpFile("before.png");
  const after = path.join(dir, "after.png");
  await fs.writeFile(after, PNG_BYTES);
  const { llm, seen } = makeBridge("The button moved down 8px.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { files: [before, after], prompt: "What changed?" }, ctxFor(llm, dir));

  assert.equal(res.isError ?? false, false);
  assert.deepEqual(res.details.analyzed.map((m) => m.path), [before, after]);
  // Both images ride on the SAME request, which is what makes comparison possible.
  assert.equal(contentOf(seen).filter((c) => c.type === "image").length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: audio is inlined as an audio block", async () => {
  const { dir, file } = await tmpFile("note.mp3", Buffer.from("fake-audio"));
  const { llm, seen } = makeBridge("The speaker asks for a dark mode toggle.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "What is asked for?" }, ctxFor(llm, dir));

  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.analyzed[0].kind, "audio");
  const block = contentOf(seen)[1];
  assert.equal(block.type, "audio");
  assert.equal(block.mimeType, "audio/mpeg");
  assert.equal(block.data, Buffer.from("fake-audio").toString("base64"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: a document rides as a file block with its bytes", async () => {
  const { dir, file } = await tmpFile("spec.pdf", Buffer.from("%PDF-1.4 fake"));
  const { llm, seen } = makeBridge("It specifies a 3-step onboarding.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "Summarize the spec." }, ctxFor(llm, dir));

  assert.equal(res.details.analyzed[0].kind, "document");
  const block = contentOf(seen)[1];
  assert.equal(block.type, "file");
  assert.equal(block.mimeType, "application/pdf");
  assert.equal(block.data, Buffer.from("%PDF-1.4 fake").toString("base64"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: video is carried by reference, never inlined", async () => {
  const { dir, file } = await tmpFile("demo.mp4", Buffer.from("fake-video"));
  const { llm, seen } = makeBridge("The list flickers at 0:03.");
  const tool = createMediaAnalysisTool();

  const res = await tool.execute("c1", { file, prompt: "Where does it break?" }, ctxFor(llm, dir));

  assert.equal(res.details.analyzed[0].kind, "video");
  assert.equal(res.details.analyzed[0].inline, false, "a recording's bytes must not be inlined");
  const block = contentOf(seen)[1];
  assert.equal(block.type, "video");
  assert.equal(block.uri, file);
  assert.equal(block.data, undefined, "the address is sent, not the bytes");
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: `type` overrides a missing or misleading extension", async () => {
  // A screenshot saved with no image extension: inference alone would reject it.
  const { dir, file } = await tmpFile("screenshot.tmp");
  const { llm, seen } = makeBridge("A settings screen.");
  const tool = createMediaAnalysisTool();

  const rejected = await tool.execute("c1", { file, prompt: "Describe" }, ctxFor(llm, dir));
  assert.equal(rejected.isError, true);
  assert.match(rejected.output, /pass `type`/);

  const res = await tool.execute("c2", { file, prompt: "Describe", type: "image" }, ctxFor(llm, dir));
  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.analyzed[0].kind, "image");
  assert.equal(contentOf(seen)[1].type, "image");
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: classifyMedia infers per extension and honours the pin", () => {
  assert.deepEqual(classifyMedia("/x/a.PNG"), { kind: "image", mimeType: "image/png" });
  assert.deepEqual(classifyMedia("/x/a.mov"), { kind: "video", mimeType: "video/quicktime" });
  assert.deepEqual(classifyMedia("/x/a.wav"), { kind: "audio", mimeType: "audio/wav" });
  assert.deepEqual(classifyMedia("/x/a.pdf"), { kind: "document", mimeType: "application/pdf" });
  assert.equal(classifyMedia("/x/a.xyz"), undefined);
  // A pin for an unknown extension falls back to the kind's own mime type...
  assert.deepEqual(classifyMedia("/x/a.xyz", "image"), { kind: "image", mimeType: "image/png" });
  // ...but a matching known extension keeps its more specific one.
  assert.deepEqual(classifyMedia("/x/a.jpg", "image"), { kind: "image", mimeType: "image/jpeg" });
});

test("media_analysis: falls back to host-attached images when the model names none", async () => {
  const { dir, file } = await tmpFile();
  const { llm } = makeBridge("A dashboard.");
  const tool = createMediaAnalysisTool();

  // The user attached a mockup but the model called the tool without `file`.
  // Without the ctx fallback this would be a dead-end error on the happy path.
  const res = await tool.execute(
    "c1",
    { prompt: "Describe the attachment" },
    ctxFor(llm, dir, { images: [{ path: file, mimeType: "image/png" }] }),
  );

  assert.equal(res.isError ?? false, false);
  assert.deepEqual(res.details.analyzed.map((m) => m.path), [file]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: unreadable paths are reported, not fatal", async () => {
  const { dir, file } = await tmpFile();
  const { llm, seen } = makeBridge("Only one attachment was legible.");
  const tool = createMediaAnalysisTool();

  const missing = path.join(dir, "does-not-exist.png");
  const res = await tool.execute("c1", { files: [file, missing], prompt: "Describe" }, ctxFor(llm, dir));

  assert.equal(res.isError ?? false, false);
  assert.deepEqual(res.details.analyzed.map((m) => m.path), [file], "only the readable file counts");
  // The miss is folded into the prompt rather than dropped, so a partial analysis
  // is never mistaken for a complete one. Backends only ever receive paths that
  // were verified readable.
  const texts = contentOf(seen).filter((c) => c.type === "text").map((c) => c.text);
  assert.ok(texts.some((t) => t.includes("could not analyze")), "the miss is surfaced to the model");
  assert.equal(contentOf(seen).filter((c) => c.type === "image").length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: a relative path that doesn't exist under cwd falls back to process.cwd()", async () => {
  // The real failure: an MCP browser tool saves a screenshot relative to the MCP
  // SERVER's CWD (the host process CWD), but this run's `ctx.cwd` is the project
  // dir. A relative path like `.playwright-mcp/page-*.png` joined to `ctx.cwd`
  // ENOENTs even though the file exists where the MCP server wrote it. The
  // resolver falls back to `process.cwd()` before giving up.
  const { llm } = makeBridge("page title is kofin");

  // Create a scratch file under a temp dir that we treat as the MCP server's CWD
  // (i.e. process.cwd() during this test run). Use a uniquely-named subfolder so
  // nothing else is likely to resolve to it, and clean it up.
  const procCwd = process.cwd();
  const scratch = path.join(procCwd, `.media-analysis-cwd-fallback-${process.pid}-${Date.now()}`);
  await fs.mkdir(scratch, { recursive: true });
  const relUnderProc = path.join(path.basename(scratch), "shot.png");
  const absUnderProc = path.join(scratch, "shot.png");
  await fs.writeFile(absUnderProc, PNG_BYTES);
  try {
    // A SEPARATE temp dir stands in for the project cwd — the file is NOT under it.
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-cwd-mismatch-"));

    const tool = createMediaAnalysisTool({ cache: false });
    const res = await tool.execute(
      "c1",
      { file: relUnderProc, prompt: "read the title" },
      ctxFor(llm, projectDir),
    );

    assert.equal(res.isError ?? false, false, "the fallback resolved the file, no error");
    assert.equal(res.details.analyzed.length, 1, "the file was analyzed via the fallback");
    assert.equal(res.details.analyzed[0].path, absUnderProc, "resolved against process.cwd()");
    await fs.rm(projectDir, { recursive: true, force: true });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("media_analysis: errors clearly when there is nothing to analyze", async () => {
  const { llm } = makeBridge("unused");
  const tool = createMediaAnalysisTool();
  const res = await tool.execute("c1", { prompt: "Describe" }, ctxFor(llm, os.tmpdir()));
  assert.equal(res.isError, true);
  assert.match(res.output, /no attachment to analyze/);
});

test("media_analysis: a provider error is surfaced, not swallowed as an empty success", async () => {
  // The bridge's `complete()` swallows transport/provider errors and returns an
  // empty message with stopReason:"error" + errorMessage. Without the fix this
  // became a successful-looking "(the model returned no analysis)"; now it must
  // surface as an isError carrying the real reason so the model can react.
  const { dir, file } = await tmpFile();
  const llm = new OpenRouterBridge();
  llm.complete = async (_model, _ctx) => ({
    role: "assistant",
    content: [],
    model: "google/gemini-2.5-flash",
    api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "error",
    errorMessage: "401 Unauthorized: invalid API key",
    timestamp: 0,
  });

  const tool = createMediaAnalysisTool({ cache: false });
  const res = await tool.execute("c1", { file, prompt: "Describe" }, ctxFor(llm, dir));

  assert.equal(res.isError, true, "a provider error returns isError, not an empty success");
  assert.match(res.output, /401 Unauthorized/);
  assert.doesNotMatch(res.output, /\(the model returned no analysis\)/, "the misleading empty fallback is gone");
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: an abort surfaces as an error rather than an empty success", async () => {
  const { dir, file } = await tmpFile();
  const llm = new OpenRouterBridge();
  llm.complete = async (_model, _ctx) => ({
    role: "assistant",
    content: [],
    model: "google/gemini-2.5-flash",
    api: "openrouter", provider: "test",
    usage: zeroUsage(), stopReason: "aborted",
    timestamp: 0,
  });

  const tool = createMediaAnalysisTool({ cache: false });
  const res = await tool.execute("c1", { file, prompt: "Describe" }, ctxFor(llm, dir));

  assert.equal(res.isError, true, "an abort surfaces as an error");
  assert.match(res.output, /aborted/);
  await fs.rm(dir, { recursive: true, force: true });
});



test("media_analysis: config model overrides the default, arg model overrides both", async () => {
  const { dir, file } = await tmpFile();
  const { llm, seen } = makeBridge("ok");

  // `cache: false` — this test checks provider routing on each call, so it must
  // not be short-circuited by the content-hash cache (same file + prompt).
  await createMediaAnalysisTool({ model: "cfg/vision", cache: false }).execute(
    "c1", { file, prompt: "d" }, ctxFor(llm, dir),
  );
  await createMediaAnalysisTool({ model: "cfg/vision", cache: false }).execute(
    "c2", { file, prompt: "d", model: "arg/vision" }, ctxFor(llm, dir),
  );

  assert.equal(seen[0].model, "cfg/vision");
  assert.equal(seen[1].model, "arg/vision");
  await fs.rm(dir, { recursive: true, force: true });
});

test("media_analysis: a host-supplied backend replaces the bundled OpenRouter path", async () => {
  const { dir, file } = await tmpFile();
  // No `ctx.llm` at all — proving a host backend can reach any provider
  // (Runware, a proxy, a local model) without the harness bridge.
  const calls = [];
  const tool = createMediaAnalysisTool({
    analyze: async (req) => {
      calls.push(req);
      return { text: "from the host provider" };
    },
  });

  const res = await tool.execute("c1", { file, prompt: "Describe" }, { cwd: dir, log: () => {} });

  assert.equal(res.isError ?? false, false);
  assert.equal(res.details.analysis, "from the host provider");
  // The tool still owns path resolution, classification and the inline policy —
  // a backend only has to make the request.
  assert.equal(calls[0].attachments.length, 1);
  assert.equal(calls[0].attachments[0].path, file);
  assert.equal(calls[0].attachments[0].kind, "image");
  assert.equal(calls[0].attachments[0].mimeType, "image/png");
  assert.equal(calls[0].attachments[0].inline, true);
  assert.match(calls[0].systemPrompt, /precise media analyst/);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lenses. Same model, same attachment — what changes is what it is asked to
// produce. A lens that exists but cannot be selected is a lens that does nothing,
// so these assert the parameter actually reaches the system prompt.
// ---------------------------------------------------------------------------

test("each lens sends its own system prompt to the model", async () => {
  const { dir, file } = await tmpFile();
  const expectations = {
    describe: /precise media analyst/i,
    ocr: /OCR engine/i,
    ui: /UI analyst/i,
    component: /ONE UI component in isolation/i,
    qa: /visual QA analyst/i,
  };

  for (const [lens, pattern] of Object.entries(expectations)) {
    const { llm, seen } = makeBridge("ok");
    await createMediaAnalysisTool({ cache: false }).execute("c1", { prompt: "look", file, lens }, ctxFor(llm, dir));
    assert.match(seen[0].ctx.systemPrompt, pattern, `lens=${lens}`);
  }

  // Omitted or unrecognized falls back to `describe` rather than failing the call.
  for (const lens of [undefined, "nonsense"]) {
    const { llm, seen } = makeBridge("ok");
    await createMediaAnalysisTool({ cache: false }).execute("c1", { prompt: "look", file, ...(lens ? { lens } : {}) }, ctxFor(llm, dir));
    assert.match(seen[0].ctx.systemPrompt, /precise media analyst/i, `lens=${lens}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("the lenses ask for what each job actually needs", () => {
  // OCR must not interpret; a summarizing OCR pass is a silently wrong OCR pass.
  assert.match(lensSystemPrompt("ocr"), /VERBATIM/);
  assert.match(lensSystemPrompt("ocr"), /Do NOT summarize, translate, correct spelling/);
  assert.match(lensSystemPrompt("ocr"), /\[illegible\]/, "missing text is marked, not guessed");
  // The ui lens is a rebuild spec, so it owes structure and a design system.
  assert.match(lensSystemPrompt("ui"), /REBUILT from your/);
  assert.match(lensSystemPrompt("ui"), /color palette with approximate hex/);
  assert.match(lensSystemPrompt("ui"), /Distinguish what you can SEE from what you are inferring/);
  // A component is judged on the states it must support, not just how it looks.
  assert.match(lensSystemPrompt("component"), /default, hover, focus, active, disabled, loading, error/);
  assert.match(lensSystemPrompt("component"), /cut off at the crop edge/);
  // QA returns a verdict, and refuses to rule on what a still frame cannot show.
  assert.match(lensSystemPrompt("qa"), /VERDICT: PASS/);
  assert.match(lensSystemPrompt("qa"), /NOT VERIFIABLE HERE/);
  // QA's verdict is scoped: an element state the expectation does not mention is
  // an observation, not a defect. A real run failed a VERIFIED dialog because
  // the analyst read the intended "Confirm disabled until email typed" state as
  // a major defect — the analyst sees pixels, not code, and cannot know intent.
  assert.match(lensSystemPrompt("qa"), /SCOPE OF THE VERDICT/);
  assert.match(lensSystemPrompt("qa"), /unless the expectation says otherwise/);
  assert.match(lensSystemPrompt("qa"), /'OBSERVED'/);
  assert.match(lensSystemPrompt("qa"), /never as a defect that fails the screen/);
  assert.equal(resolveLens("UI"), "ui", "case-insensitive");
  assert.equal(resolveLens(undefined), "describe");
});

test("the qa expected spec asks for intended interactive states", async () => {
  // The failing run's `expected` said "Cancel and Confirm buttons" without the
  // state — so the intended disabled Confirm read as a defect. The description
  // must teach the caller to state intended states, not just elements.
  const { createMediaAnalysisTool } = await import("../dist/index.js");
  const tool = createMediaAnalysisTool({});
  const desc = tool.parameters.properties.expected.description;
  assert.match(desc, /states you implemented/);
  assert.match(desc, /Confirm disabled/);
  assert.match(desc, /not judged as a defect/);
});

// ---------------------------------------------------------------------------
// `url`: screenshot a live page, keep the file, analyze it.
// ---------------------------------------------------------------------------

/** A registry exposing fake Playwright navigate/screenshot tools. */
function browserRegistry({ screenshot, navigate } = {}) {
  const calls = { navigate: [], screenshot: [] };
  const reg = new Registry();
  reg.add({
    id: "mcp:playwright", kind: "mcp", source: "external", name: "playwright",
    tools: [
      {
        name: "browser_navigate", description: "nav", mutates: false,
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        async execute(_id, args) { calls.navigate.push(args.url); return navigate ? navigate(args) : { output: "ok" }; },
      },
      {
        name: "browser_take_screenshot", description: "shot", mutates: false,
        parameters: { type: "object", properties: {} },
        async execute(_id, args) {
          calls.screenshot.push(args);
          return screenshot
            ? screenshot(args)
            : { output: "captured", content: [{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" }] };
        },
      },
    ],
  });
  return { reg, calls };
}

test("url: navigates, saves the screenshot, and analyzes the saved file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-url-"));
  const { reg, calls } = browserRegistry();
  const { llm, seen } = makeBridge("a hero with a dark nav");

  const res = await createMediaAnalysisTool().execute(
    "c1",
    { prompt: "describe the layout", url: "https://example.com/pricing", lens: "ui" },
    ctxFor(llm, dir, { registry: reg }),
  );

  assert.equal(calls.navigate[0], "https://example.com/pricing");
  // The capture is a real artifact, kept where a later step can reuse it.
  const saved = res.details.screenshot;
  assert.ok(saved, "the screenshot path is reported");
  assert.match(saved, /\.turing[/\\]screenshots[/\\]example-com-pricing-\d+\.png$/);
  assert.deepEqual(await fs.readFile(saved), PNG_BYTES, "the bytes hit disk intact");
  // The model saw that file, through the ui lens.
  assert.equal(res.details.analyzed[0].path, saved);
  assert.match(seen[0].ctx.systemPrompt, /UI analyst/);
  // And the model-facing output names the file so the next step can attach it.
  assert.match(res.output, /Screenshot saved: /);
  assert.match(res.output, /a hero with a dark nav/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("url: a server that writes its own file is followed to that path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-url-path-"));
  const existing = path.join(dir, "shot.png");
  await fs.writeFile(existing, PNG_BYTES);
  const { reg } = browserRegistry({ screenshot: () => ({ output: `Saved screenshot to ${existing}` }) });
  const { llm } = makeBridge("ok");

  const res = await createMediaAnalysisTool().execute(
    "c1", { prompt: "look", url: "https://example.com" }, ctxFor(llm, dir, { registry: reg }),
  );
  assert.equal(res.details.screenshot, existing, "no second copy is written");
  assert.equal(res.details.analyzed[0].path, existing);
  await fs.rm(dir, { recursive: true, force: true });
});

test("url: selector and fullPage are only sent when asked for", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-url-args-"));
  const { reg, calls } = browserRegistry();
  const { llm } = makeBridge("ok");
  const tool = createMediaAnalysisTool();

  await tool.execute("c1", { prompt: "p", url: "https://example.com" }, ctxFor(llm, dir, { registry: reg }));
  // MCP servers commonly reject unknown properties, so nothing extra is sent.
  assert.deepEqual(calls.screenshot[0], {});

  await tool.execute("c2", {
    prompt: "p", url: "https://example.com", selector: ".pricing-card", fullPage: true, lens: "component",
  }, ctxFor(llm, dir, { registry: reg }));
  assert.deepEqual(calls.screenshot[1], { selector: ".pricing-card", fullPage: true });

  await fs.rm(dir, { recursive: true, force: true });
});

test("url: with no browser MCP it says so instead of pretending", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-url-none-"));
  const { llm } = makeBridge("ok");
  const res = await createMediaAnalysisTool().execute(
    "c1", { prompt: "look", url: "https://example.com" }, ctxFor(llm, dir, { registry: new Registry() }),
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /needs a browser MCP/);
  assert.match(res.output, /Do not substitute bash\+curl/, "curl cannot render or screenshot a page");
  await fs.rm(dir, { recursive: true, force: true });
});

test("url: a screenshot that yields no image is reported, not analyzed as nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-url-empty-"));
  const { reg } = browserRegistry({ screenshot: () => ({ output: "done" }) });
  const { llm, seen } = makeBridge("ok");
  const res = await createMediaAnalysisTool().execute(
    "c1", { prompt: "look", url: "https://example.com" }, ctxFor(llm, dir, { registry: reg }),
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /returned no readable image/);
  assert.equal(seen.length, 0, "no analysis call is made on nothing");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the prompts put analysis before planning, and name the lens for each job", () => {
  // The expensive failure: plan from the words, discover the design at step 4.
  assert.match(MEDIA_UNDERSTANDING, /ANALYSE BEFORE YOU PLAN/);
  assert.match(MEDIA_UNDERSTANDING, /what the design contains is what the steps ARE|A design tells you what the steps actually are/);
  // Analysis is what makes per-step attachment routing possible at all.
  assert.match(MEDIA_UNDERSTANDING, /the ROUTING/);
  assert.match(MEDIA_UNDERSTANDING, /belongs on the hero step/);
  // Each lens is named with the job it does.
  for (const lens of ["ocr", "ui", "component", "qa", "compare"]) {
    assert.ok(MEDIA_UNDERSTANDING.includes(`lens:"${lens}"`), `names lens ${lens}`);
  }
  // The two comparison lenses overlap enough to be confusable, so the guidance has
  // to state the rule that separates them rather than leaving it to be inferred.
  assert.match(MEDIA_UNDERSTANDING, /comparing against an IMAGE is `compare`/);
  // Replication closes the loop: capture, build from the system, then compare
  // against the original and ACT on the deltas.
  assert.match(MEDIA_UNDERSTANDING, /REPLICATING SOMETHING THAT ALREADY EXISTS/);
  assert.match(MEDIA_UNDERSTANDING, /lens:"compare"[\s\S]*as `reference`/);
  assert.match(MEDIA_UNDERSTANDING, /is not a check/);
  assert.match(MEDIA_UNDERSTANDING, /re-compare until it/, "a MISMATCH is acted on, not just reported");
  assert.ok(LOOP_SYSTEM_PROMPT.includes(MEDIA_UNDERSTANDING), "the loop carries it verbatim");
});

test("media_analysis: the default analysis model is gemini-3.7-flash (pinned)", async () => {
  const { dir, file } = await tmpFile();
  const { llm, seen } = makeBridge("ok");
  await createMediaAnalysisTool({ cache: false }).execute(
    "c1", { file, prompt: "d" }, ctxFor(llm, dir),
  );
  assert.equal(seen[0].model, "google/gemini-3.7-flash");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the compare lens covers UI consistency between two screens of one app", async () => {
  const { LENS_SYSTEM } = await import("../dist/tools/builtin/media-analysis.js");
  const compare = LENS_SYSTEM.compare;
  assert.match(compare, /TWO SCREENS OF THE SAME APP/i);
  assert.match(compare, /CONSISTENCY/i);
  assert.match(compare, /type scale|spacing rhythm/i);
  // And the tool description routes both jobs: visual QA and consistency diffing.
  const { createMediaAnalysisTool } = await import("../dist/index.js");
  const desc = createMediaAnalysisTool({}).description;
  assert.match(desc, /VISUAL QA/);
  assert.match(desc, /CONSISTENCY/);
  assert.match(desc, /files:\[a,b\]/);
});
