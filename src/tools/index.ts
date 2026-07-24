/**
 * Assembles the internal (bundled) tool providers and registers them into a
 * {@link Registry}. These are the "Internal / came bundled in" capabilities of
 * req #3; external mcp/skills are added separately via `registry.add(...)`.
 */
import type { Registry, ProviderInput } from "../registry/registry.js";
import type { LogStore } from "../logging/logger.js";
import { CODING_TOOLS } from "./builtin/coding.js";
import { createAssetsGeneratorTool, type AssetsGeneratorConfig } from "./builtin/assets-generator.js";
import { createUiScreenAuditorTool, type UiScreenAuditorConfig } from "./builtin/ui-screen-auditor.js";
import { createActivityMonitorTool } from "./builtin/activity-monitor.js";
import { askUserQuestionTool } from "./builtin/ask-user-question.js";

export * from "./builtin/coding.js";
export * from "./builtin/assets-generator.js";
export * from "./builtin/ui-screen-auditor.js";
export * from "./builtin/activity-monitor.js";
export * from "./builtin/file-memory.js";
export * from "./builtin/graph-memory.js";
export * from "./builtin/ask-user-question.js";

export interface BuiltinToolsConfig {
  logStore: LogStore;
  assets?: AssetsGeneratorConfig;
  auditor?: UiScreenAuditorConfig;
  studyModel?: string;
}

/** Build the internal provider definitions (not yet registered). */
export function builtinProviders(config: BuiltinToolsConfig): ProviderInput[] {
  const assetsGenerator = createAssetsGeneratorTool(config.assets);
  const uiAuditor = createUiScreenAuditorTool(config.auditor);
  const activityMonitor = createActivityMonitorTool({ logStore: config.logStore, studyModel: config.studyModel });

  return [
    {
      id: "builtin:coding",
      kind: "mcp",
      source: "internal",
      name: "coding",
      description: "Core coding tools: bash, bash_readonly, read, write, edit, ls, grep.",
      tools: CODING_TOOLS,
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
      id: "builtin:ui_screen_auditor",
      kind: "tool",
      source: "internal",
      name: "ui_screen_auditor",
      tools: [uiAuditor],
    },
    {
      id: "builtin:activity_monitor",
      kind: "tool",
      source: "internal",
      name: "activity_monitor",
      tools: [activityMonitor],
    },
  ];
}

/** Register all internal providers into the given registry. */
export function registerBuiltins(registry: Registry, config: BuiltinToolsConfig): void {
  for (const p of builtinProviders(config)) registry.add(p);
}
