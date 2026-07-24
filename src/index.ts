/**
 * turing-harness — a 4P (Prepare, Plan, Perform, Perfect) coding-agent
 * orchestration library.
 *
 * - Multimodal (file/image/video/audio)                          (req #1)
 * - pi-compatible types & event stream                           (req #2)
 * - MCP/skills/tools registry with get/add/delete + 4P category  (req #3)
 * - Orchestrated 4P chain with Perfect→Perform verify/retry      (req #4)
 * - Customizable per-phase & per-tool models over OpenRouter     (req #5)
 * - Internal tools: assets_generator, ui_screen_auditor,
 *   activity_monitor                                             (req #6)
 * - Orchestrator does no file reasoning / no writes; permission
 *   gate (ask-all / bypass / ask-mutations) with per-call model
 *   selection by complexity & attachments                        (req #7)
 * - Electron-capable (pure Node built-ins + fetch)
 */

// ---- Types (pi-compatible surface) ----
export * from "./types.js";

// ---- Top-level entry ----
export {
  Harness,
  type HarnessConfig,
  type ProjectSessionOptions,
  type ProjectSessionResult,
} from "./harness.js";
export {
  Session,
  type SessionOptions,
  type SessionInfo,
  type SessionDeps,
} from "./session.js";
export {
  HarnessAgent,
  type HarnessAgentOptions,
  type HarnessAgentState,
  type AgentHost,
} from "./agent.js";

// ---- Orchestrator / phases / permissions ----
export {
  Orchestrator,
  type OrchestratorConfig,
  type ChainResult,
  type ChainRoute,
  type AfterPrepareHook,
  type RunPhaseOptions,
  type PhaseModelConfig,
} from "./orchestrator/orchestrator.js";
export { PermissionGate } from "./orchestrator/permission.js";
export { runPhase, type PhaseRunInput } from "./orchestrator/phase-runner.js";
export {
  PHASE_PROMPTS,
  PHASE_DEFAULT_TOOLS,
  INTENT_ROUTER_PROMPT,
  CONVERSATIONAL_PROMPT,
} from "./phases/prompts.js";

// ---- Registry ----
export {
  Registry,
  type RegistryOptions,
  type ProviderInput,
  type ProviderListItem,
  type ProviderKind,
  type ProviderSource,
  type RegistryEvent,
  type ToolCategorizer,
  type PhaseToolSpec,
  type PhaseToolFilter,
  type PhaseToolResolver,
} from "./registry/registry.js";
export { categorizeTool, categorizeProvider } from "./registry/categorize.js";
export { defineSkill, type SkillDefinition } from "./registry/skill.js";

// ---- LLM (OpenRouter) ----
export {
  complete,
  stream,
  OpenRouterBridge,
  type OpenRouterBridgeOptions,
  contextToRequest,
} from "./llm/bridge.js";
export {
  callOpenRouter,
  streamOpenRouter,
  OpenRouterError,
  type OpenRouterRequest,
  type OpenRouterResponse,
  type OpenRouterStreamChunk,
  type CallOptions,
} from "./llm/openrouter.js";
export {
  MODEL_CATALOG,
  DEFAULT_PHASE_MODELS,
  resolveModel,
  registerModel,
} from "./llm/models.js";
export {
  estimateComplexity,
  selectModel,
  requiredModalities,
  type ComplexityInput,
  type SelectModelInput,
} from "./llm/model-selector.js";

// ---- Project presets (frontend / mobile / games / backend) ----
export {
  PROJECT_PRESETS,
  applyProjectPreset,
  presetPolicy,
  type ProjectCategory,
  type ProjectPreset,
  type PresetMcpEntry,
  type PresetApplyContext,
  type ApplyPresetOptions,
  type ApplyPresetReport,
} from "./presets/project-presets.js";

// ---- Tools ----
export * from "./tools/index.js";

// ---- MCP client ----
export { McpClient, connectMcpServer, type McpServerOptions } from "./mcp/client.js";
export {
  McpRuntimePool,
  wrapPooledProvider,
  mcpServerSignature,
  type McpRuntimePoolOptions,
} from "./mcp/runtime-pool.js";

// ---- Logging ----
export { LogStore, type LogQuery } from "./logging/logger.js";

// ---- Project memory (durable, tech-stack-aware) ----
export {
  GraphMemory,
  GRAPH_MEMORY_VERSION,
  type GraphMemoryOptions,
  type GraphMemoryStats,
  type GraphTraversalResult,
  type BlastRadiusResult,
} from "./memory/graph-memory.js";
export {
  FileMemory,
  FILE_MEMORY_VERSION,
  FILE_MEMORY_SUMMARY_VERSION,
  FILE_MEMORY_IGNORED_DIRS,
  TEXT_SAMPLE_BYTES,
  type FileMemoryData,
  type FileMemoryEntry,
  type FileMemoryOptions,
  type FileMemorySummarySyncData,
  type FileMemoryStats,
  type FileSearchResult,
} from "./memory/file-memory.js";
export {
  FileMemoryRuntime,
  type FileMemoryRuntimeOptions,
  type FileMemoryRuntimeStatus,
} from "./memory/file-memory-runtime.js";
export {
  summarizeFileWithLlm,
  DEFAULT_FILE_SUMMARIZER_MODEL,
  type FileSummaryLlmInput,
  type FileSummaryLlmResult,
} from "./memory/file-summary-llm.js";
export * from "./memory/graph-adapters/base.js";
export {
  ProjectMemory,
  MEMORY_VERSION,
  type ProjectMemoryData,
  type ProjectMemoryOptions,
  type MemoryFact,
} from "./memory/project-memory.js";
export { detectProject, type ProjectDetection, type TechStack } from "./memory/detect.js";
export { createGraphMemoryTool } from "./tools/builtin/graph-memory.js";
export { createFileMemoryTool } from "./tools/builtin/file-memory.js";
export {
  createProjectMemoryTool,
  resolveProjectMemoryAction,
} from "./tools/builtin/project-memory.js";

// ---- Multimodal ----
export {
  attachmentFromPath,
  attachmentToContent,
  buildUserContent,
  loadContent,
  refsFromAttachments,
  guessMimeType,
  attachmentTypeFor,
} from "./multimodal/attachment.js";
