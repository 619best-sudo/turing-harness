/**
 * Assembles the internal (bundled) tool providers and registers them into a
 * {@link Registry}. These are the "Internal / came bundled in" capabilities of
 * req #3; external mcp/skills are added separately via `registry.add(...)`.
 */
import type { Registry, ProviderInput } from "../registry/registry.js";
import type { LogStore } from "../logging/logger.js";
import { CODING_TOOLS, createCodingTools } from "./builtin/coding.js";
import { createAssetsGeneratorTool, type AssetsGeneratorConfig } from "./builtin/assets-generator.js";
import { createMediaAnalysisTool, type MediaAnalysisConfig } from "./builtin/media-analysis.js";
import { createActivityMonitorTools } from "./builtin/activity-monitor.js";
import { askUserQuestionTool } from "./builtin/ask-user-question.js";
import { createPlanTool, type PlanToolConfig } from "./builtin/plan.js";
import { createWebTools, type WebConfig } from "./builtin/web.js";
import { createMobileTool } from "../devices/mobile-tool.js";
import {
  createInspirationGeneratorTool,
  type InspirationGeneratorConfig,
} from "./builtin/inspiration-generator.js";

export * from "./builtin/coding.js";
export * from "./builtin/assets-generator.js";
export * from "./builtin/media-analysis.js";
export * from "./builtin/activity-monitor.js";
export * from "./builtin/file-memory.js";
export * from "./builtin/graph-memory.js";
export * from "./builtin/ask-user-question.js";
export * from "./builtin/plan.js";
export * from "./builtin/web.js";
export * from "./builtin/inspiration-generator.js";

export interface BuiltinToolsConfig {
  logStore: LogStore;
  assets?: AssetsGeneratorConfig;
  mediaAnalysis?: MediaAnalysisConfig;
  /** Config for the `create_plan` tool — notably its (replaceable) prompt. */
  plan?: PlanToolConfig;
  /** Config for `web_search` / `web_fetch` (search engine, model, limits). */
  web?: WebConfig;
  /**
   * Config for the `inspiration_generator` tool — a host-injected keyword
   * lookup that returns a reusable UI/poster/parallax blueprint (or null). The
   * harness owns no HTTP client; the host wires the real backend here.
   */
  inspiration?: InspirationGeneratorConfig;
  studyModel?: string;
  /**
   * Register the `write`/`edit` tools in CONTENT-LESS mode: the schema drops
   * `content`/`newString`, so the calling model emits only the path (+ the
   * `oldString` anchor for edit) and a resolved authoring model authors the
   * bytes — eliminating the wasted full-file draft Model A would otherwise
   * generate and have discarded. Only meaningful when an authoring model is
   * configured (permission `authorModel` / `routeModel` for writes); without
   * one, every write/edit returns a clear configuration error.
   */
  authorOnlyWrites?: boolean;
}

/** Build the internal provider definitions (not yet registered). */
export function builtinProviders(config: BuiltinToolsConfig): ProviderInput[] {
  const assetsGenerator = createAssetsGeneratorTool(config.assets);
  const mediaAnalysis = createMediaAnalysisTool(config.mediaAnalysis);
  const activityMonitor = createActivityMonitorTools({
    logStore: config.logStore,
    studyModel: config.studyModel,
  });
  const inspirationGenerator = createInspirationGeneratorTool(config.inspiration);

  // Author-only mode swaps the default write/edit for content-less variants so
  // Model A never generates a draft an authoring model would discard anyway.
  const codingTools = config.authorOnlyWrites ? createCodingTools({ authorOnlyWrites: true }) : CODING_TOOLS;
  return [
    {
      id: "builtin:coding",
      kind: "mcp",
      source: "internal",
      name: "coding",
      description: "Core coding tools: bash, bash_readonly, read, write, edit, ls, grep, mark_concern_lines.",
      tools: codingTools,
    },
    {
      id: "builtin:create_plan",
      kind: "tool",
      source: "internal",
      name: "create_plan",
      tools: [createPlanTool(config.plan)],
    },
    {
      id: "builtin:ask_user_question",
      kind: "tool",
      source: "internal",
      name: "ask_user_question",
      tools: [askUserQuestionTool],
    },
    {
      id: "builtin:assets_generator",
      kind: "tool",
      source: "internal",
      name: "assets_generator",
      tools: [assetsGenerator],
    },
    {
      id: "builtin:media_analysis",
      kind: "tool",
      source: "internal",
      name: "media_analysis",
      tools: [mediaAnalysis],
    },
    {
      // Internal keyword→blueprint lookup for building UI/posters without a
      // reference image. LLM-invoked in Perform/Perfect; its `details` are for
      // the host consumer, not on-screen display.
      id: "builtin:inspiration_generator",
      kind: "tool",
      source: "internal",
      name: "inspiration_generator",
      tools: [inspirationGenerator],
    },
    {
      id: "builtin:web",
      // Two tools (find a page, read a page), so both steps of a lookup are
      // separate, visible tool calls.
      kind: "mcp",
      source: "internal",
      name: "web",
      description: "Internet lookup: web_search (find current docs/changelogs/issues) and web_fetch (read a page).",
      tools: createWebTools(config.web),
    },
    {
      // Device automation, backed by the `mobilecli` binary. This replaced the
      // external device-MCP server the mobile preset used to spawn:
      // built-in means no npx download per run, no server lifecycle, and no
      // MCP tool-name resolution between the harness and the driver.
      //
      // Registered unconditionally even when the binary is absent — each tool
      // reports the install hint itself. Gating registration on a PATH probe
      // would make the toolkit invisible in exactly the runs that need to be
      // told what is missing.
      id: "builtin:mobile",
      kind: "tool",
      source: "internal",
      name: "mobile",
      // Explicit rather than inferred: name-based inference would scatter the
      // toolkit across phases (install/launch read as Perform mutations,
      // screenshot as Perfect), and the toolkit is only coherent as a unit —
      // you cannot tap in a phase that cannot screenshot the result.
      phases: ["perform", "perfect"],
      description:
        "Drive an iOS/Android device or simulator: `mobile { action }` — look (screenshot + every " +
        "on-screen element), tap/longpress/swipe/type/press/open, launch/terminate/install/apps, devices. " +
        "`tap` takes a DESCRIPTION and resolves it against the live screen. All coordinates are LOGICAL POINTS.",
      tools: [createMobileTool()],
    },
    {
      id: "builtin:activity_monitor",
      // "mcp" (a multi-tool provider) rather than "tool": the debugging workflow is
      // a sequence of steps, and exposing one tool per step is what makes each step
      // a visible tool call with its own args, result and reasoning.
      kind: "mcp",
      source: "internal",
      name: "activity_monitor",
      description:
        "Activity log search/study plus the trace workflow: activity_search, activity_tags, " +
        "activity_tail_file, activity_study, activity_trace_start, activity_collect, activity_cleanup, " +
        "activity_inspect.",
      tools: activityMonitor,
    },
  ];
}

/** Register all internal providers into the given registry. */
export function registerBuiltins(registry: Registry, config: BuiltinToolsConfig): void {
  for (const p of builtinProviders(config)) registry.add(p);
}
