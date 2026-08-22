/**
 * Each categorizer's prompt teaches HOW TO WORK — an explicit order of
 * operations for that category — and setup.ts wires the tools those flows
 * promise. Pinned here so a prompt or tool-list change that breaks the flow
 * fails loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCategorizerSystemPrompt,
  DEFAULT_CATEGORIZER_PROMPTS,
  DEFAULT_ROUTER_PROMPT,
  DEFAULT_CATEGORIZER_SETUP,
} from "../dist/index.js";

const build = (id, toolNames) =>
  buildCategorizerSystemPrompt({ id, systemPrompt: DEFAULT_CATEGORIZER_PROMPTS[id] }, toolNames);

const CONVERSATION_TOOLS = ["web_search", "web_fetch", "web_scrape", "bash", "ask_user_question", "deliver"];
const READ_TOOLS = ["project_memory", "file_memory", "graph_memory", "read", "ls", "grep", "media_analysis", "deliver"];
const WRITE_TOOLS = ["read", "write", "edit", "create_plan", "media_analysis", "inspiration_generator", "assets_generator", "bash", "deliver"];
const INSPECT_TOOLS = ["drive", "mobile", "media_analysis", "activity_inspect", "add_log", "remove_log", "ask_user_question", "deliver"];

test("conversation teaches the research pipeline in order: search → fetch → scrape → cross-check → compose", () => {
  const p = build("conversation", CONVERSATION_TOOLS);
  const order = [
    p.indexOf("1. web_search opens the question"),
    p.indexOf("2. web_fetch the 2-4 pages"),
    p.indexOf("3. web_scrape only when"),
    p.indexOf("4. CROSS-CHECK"),
    p.indexOf("5. COMPOSE"),
  ];
  assert.ok(order.every((i) => i >= 0), `all five steps present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "research steps appear in order");
  assert.match(p, /Never state a number or fact you did not read/);
  assert.match(p, /gaps in the ecommerce market/);
});

test("read teaches memory-first → read → attachments → link → deliver", () => {
  const p = build("read", READ_TOOLS);
  const order = [
    p.indexOf("1. MEMORY FIRST"),
    p.indexOf("2. READ the exact files"),
    p.indexOf("3. ATTACHMENTS"),
    p.indexOf("4. LINK"),
    p.indexOf("5. DELIVER the code summary"),
  ];
  assert.ok(order.every((i) => i >= 0), `all five steps present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "read flow appears in order");
  assert.match(p, /media_analysis/);
  assert.match(p, /route/);
  assert.match(p, /the chain ends/);
  // The handoff names the pass that follows a READ, and which one depends on the
  // task: a reported defect reproduces first, a change goes straight to work.
  assert.match(p, /your deliverable IS the handoff the next pass starts from/);
  assert.match(p, /`activity_reproduce` when the task is a reported defect/);
  // The deliver contract teaches the per-attachment handoff notes.
  assert.match(p, /attachmentNotes/);
});

test("write_edit teaches handoff → inspiration → plan → execute → build+run → deliver", () => {
  const p = build("write_edit", WRITE_TOOLS);
  const order = [
    p.indexOf("1. TAKE THE HANDOFF"),
    p.indexOf("2. INSPIRATION"),
    p.indexOf("3. ALWAYS PLAN FIRST"),
    p.indexOf("4. EXECUTE"),
    p.indexOf("5. BUILD + RUN to completion"),
    p.indexOf("6. DELIVER the write report"),
  ];
  assert.ok(order.every((i) => i >= 0), `all six steps present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "write flow appears in order");
  assert.match(p, /create_plan/);
  assert.match(p, /INSPIRATION \(UI work only\)/);
  assert.match(p, /inspiration_generator/, "the guidance names the inspiration tool when attached");
  assert.match(p, /Route each attachment to ONLY the steps that need it/);
  assert.match(p, /ask_user_question BEFORE the plan/);
  // The QA split: write_edit hands over runnable, activity_inspect verifies.
  assert.match(p, /you deliver it RUNNABLE/);
  assert.match(p, /they\s*\n?\s*deliver it VERIFIED/s);
  assert.match(p, /activity_inspect's job/);
});

test("activity_inspect asks WHO DOES THE QA before the pipeline, and teaches the hand-back", () => {
  const p = build("activity_inspect", INSPECT_TOOLS);
  const whoDrives = p.indexOf("0. WHO DOES THE QA");
  const instrument = p.indexOf("1. INSTRUMENT");
  assert.ok(whoDrives >= 0, "step 0 present");
  assert.ok(whoDrives < instrument, "the question comes before instrumenting");
  // The three answers, and the fact that the gate enforces the question.
  assert.match(p, /You verify it/);
  assert.match(p, /I'll verify it myself/);
  assert.match(p, /Skip QA/);
  assert.match(p, /REFUSED until it has been answered/);
  // Asked once, and then the pass RUNS — it does not keep asking permission.
  assert.match(p, /Asked ONCE PER RUN/);
  assert.match(p, /do NOT ask permission to/);
  assert.match(p, /hands back to write_edit WITH this evidence/);
});

test("the router prompt carries the worked example shapes (research / read-only / build / bug)", () => {
  assert.match(DEFAULT_ROUTER_PROMPT, /research the ecommerce market/);
  assert.match(DEFAULT_ROUTER_PROMPT, /read → summarise/);
  assert.match(DEFAULT_ROUTER_PROMPT, /read → write_edit → activity_inspect/);
  // A bug report now reproduces BEFORE the fix and verifies after it.
  assert.match(DEFAULT_ROUTER_PROMPT, /read → activity_reproduce → write_edit → activity_inspect/);
});

test("setup wires the tools each flow promises: read and write_edit carry media_analysis", () => {
  const byId = Object.fromEntries(DEFAULT_CATEGORIZER_SETUP.categories.map((c) => [c.id, c]));
  assert.ok(byId.read.tools.includes("media_analysis"), "read can analyse attachments");
  assert.ok(byId.write_edit.tools.includes("media_analysis"), "write_edit can analyse un-noted attachments");
  assert.ok(byId.read.tools.includes("graph_memory"), "read starts from graph memory");
  assert.ok(byId.write_edit.tools.includes("create_plan"), "write_edit always plans first");
  assert.match(byId.read.returns.description, /attachment/);
  // The flow graph the prompts describe: read → activity_reproduce | write_edit,
  // write_edit → activity_inspect, either QA hop → write_edit.
  assert.deepEqual(byId.read.children, ["activity_reproduce", "write_edit"]);
  assert.deepEqual(byId.write_edit.children, ["activity_inspect"]);
  assert.deepEqual(byId.activity_reproduce.children, ["write_edit"]);
  assert.deepEqual(byId.activity_inspect.children, ["write_edit"]);
  // The reproduce hop shares the QA tool surface without re-declaring it.
  assert.ok(byId.activity_reproduce.tools.includes("drive"));
  assert.ok(byId.activity_reproduce.tools.includes("mobile"));
  assert.equal(byId.activity_reproduce.toolScope, "activity_inspect");
});
