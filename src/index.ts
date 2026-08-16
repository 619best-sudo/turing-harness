/**
 * turing-harness — a 4P (Prepare, Plan, Perform, Perfect) coding-agent
 * orchestration library.
 *
 * - Multimodal (file/image/video/audio)                          (req #1)
 * - pi-compatible types & event stream                           (req #2)
 * - MCP/skills/tools registry with get/add/delete + 4P category  (req #3)
 * - Orchestrated 4P chain with Perfect→Perform verify/retry      (req #4)
 * - Customizable per-phase & per-tool models over OpenRouter     (req #5)
 * - Internal tools: assets_generator, media_analysis,
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
  type RunOptions,
  type PhaseModelConfig,
} from "./orchestrator/orchestrator.js";
export { PermissionGate } from "./orchestrator/permission.js";
export {
  VerificationGate,
  parseDeclarations,
  type VerificationDeclaration,
  type VerificationGap,
  type VerificationReport,
  type VerificationGateOptions,
  type VerificationMethod,
  type VerificationOutcome,
} from "./orchestrator/verification-gate.js";
export {
  ClarifyGate,
  type ClarifyDecision,
  type ClarifyGateOptions,
  type ClarifyReport,
} from "./orchestrator/clarify-gate.js";
export {
  sanitizeAuthoredText,
  stripAuthoredArtifacts,
  targetAllowsFences,
  isFenceLine,
  isBlankLineDriftOnly,
  type SanitizeOptions,
  type SanitizedOutput,
} from "./tools/builtin/authored-output.js";
export {
  checkBuildTarget,
  checkDeviceId,
  checkRunSurface,
  commandPlatform,
  closestDevice,
  deviceTargetInCommand,
  looksLikeDeviceId,
  type DeviceTargetVerdict,
} from "./exec/device-target.js";
export {
  composeDeviceLaunch,
  describeComposedLaunch,
  detectMobileStack,
  type ComposedLaunch,
  type MobileStack,
} from "./exec/run-commands.js";
export {
  QaGate,
  callSurface,
  deployKind,
  isCaptureTool,
  isDriveTool,
  isInspectTool,
  type QaBlockReason,
  type QaDecision,
  type QaGateOptions,
  type QaSurface,
} from "./orchestrator/qa-gate.js";
export {
  scopeImagesForTarget,
  ambiguityNote,
  type ImageScope,
  type ImageScopeReason,
} from "./multimodal/attachment-routing.js";
export {
  coordinateRunHandoff,
  detectSurfaces,
  needsRunningApp,
  type RunHandoffResult,
  type HandoffMode,
  type Surfaces,
  type CoordinateRunHandoffInput,
} from "./orchestrator/run-handoff.js";
export {
  newRunId,
  runArtifactDir,
  ensureArtifactDir,
  listEvidence,
  writeEvidence,
} from "./orchestrator/verify-artifacts.js";
export { runPhase, type PhaseRunInput } from "./orchestrator/phase-runner.js";
export { runToolLoop, type ToolLoopInput, type ToolLoopResult } from "./orchestrator/loop.js";
export { suggestToolName, unknownToolMessage, unknownArgumentKeys, unknownArgumentMessage, levenshtein } from "./orchestrator/tool-suggest.js";
export {
  coerceStringArgs,
  coerceToString,
  coercionNote,
  type CoercedArg,
  type CoercionResult,
} from "./orchestrator/tool-arg-coercion.js";
export { assessStraightforward, scanForConcurrencyRisk, isSourceFile } from "./orchestrator/straightforward-assessor.js";
export {
  ToolFallbackAdvisor,
  type FallbackAdvice,
  type ToolFallbackOptions,
} from "./orchestrator/tool-fallback.js";
export {
  SearchLadderAdvisor,
  isDiscoveryCall,
  isShellSearchCall,
  isEmptyMemoryResult,
  isColdIndex,
  type SearchAdvice,
  type SearchLadderOptions,
} from "./orchestrator/search-ladder.js";
export {
  StallGuard,
  isNonFatalLoopError,
  LOOP_STALLED,
  STEP_BUDGET_EXHAUSTED,
  type StallGuardOptions,
  type StallVerdict,
} from "./orchestrator/stall-guard.js";
export {
  extractPlanSet,
  normalizeLegacyPlanJson,
  extractPlanJson,
} from "./orchestrator/plan-extract.js";
export {
  compactHistory,
  historySize,
  pruneHistoricalMedia,
  findCutIndex,
  resolveCompactionThreshold,
  COMPACTION_ENV_VAR,
} from "./orchestrator/compaction.js";
export {
  PHASE_PROMPTS,
  buildPhaseSystemPrompt,
  buildLoopSystemPrompt,
  COMPLEXITY_CONTRACT,
  PHASE_DEFAULT_TOOLS,
  INTENT_ROUTER_PROMPT,
  CONVERSATIONAL_PROMPT,
  CONVERSATIONAL_LOOKUP,
  LOOP_SYSTEM_PROMPT,
  FILE_SEARCH_LADDER,
  WEB_AND_SCRAPING,
  CODE_CHANGE_ATTENTION,
  PROJECT_LEARNING,
  ASSETS_AND_SVG,
  MEDIA_UNDERSTANDING,
  GUIDELINE_CONTRACT,
  RUN_ORDER,
  ASKING_THE_USER,
  DEBUGGING_LOOP,
  INSPIRATION_REUSE,
  VERIFY_WHAT_YOU_WROTE,
  BUILD_TYPECHECK_COMMANDS,
} from "./phases/prompts.js";
export {
  CODE_RISK_SITES,
  CODE_RISK_FOR_RATING,
  CODE_RISK_FOR_COMPREHENSION,
  CODE_RISK_FOR_AUTHORING,
} from "./code-risk.js";

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

// ---- Backend-delegating media backends (host routes generation through its proxy) ----
export {
  createBackendImageBackend,
  createBackendVideoBackend,
  splitVideoImages,
  type BackendImageBackendConfig,
  type BackendImageClient,
  type BackendImageData,
  type BackendImageRequest,
  type BackendVideoBackendConfig,
  type BackendVideoClient,
  type BackendVideoData,
  type BackendVideoRequest,
} from "./llm/backend-image-backend.js";

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

// ---- Shell execution ----
// The environment and toolchain resolution every shell command goes through.
// Exported so a host can warm the login-shell probe during idle time, surface
// what it resolved in a diagnostics screen, and reuse the same resolution for
// commands it runs outside the harness.
export {
  primeShellEnvironment,
  resolveShellEnvironment,
  resetShellEnvironment,
  mergeShellEnv,
  mergePathEntries,
  type ShellEnvironment,
} from "./exec/shell-env.js";
// How the project itself says it runs — read from its manifests, Makefile and
// docs rather than guessed from a stack list. Exported so a host can surface
// the same commands in its own UI or prompts.
export {
  detectRunCommands,
  detectDeviceRunCommands,
  describeDeviceLaunch,
  type ProjectRunCommand,
  type RunCommandKind,
} from "./exec/run-commands.js";
export {
  resolveProjectToolchain,
  findProjectLauncher,
  installHint,
  whichExecutable,
  commandNotFoundNames,
  missingExecutableGuidance,
  substitutionNote,
  type ResolvedCommand,
  type ToolchainSubstitution,
} from "./exec/toolchain.js";

// ---- Local devices ----
// Simulators/emulators `activity_inspect` falls back to when no device MCP is
// connected. `setLocalDeviceProbe` lets a host substitute its own inventory
// (a device farm, a pinned target) or, with `TURING_DISABLE_LOCAL_DEVICES=1`,
// keep device capture MCP-only.
export {
  listLocalDevices,
  hasLocalDevice,
  localDeviceTools,
  setLocalDeviceProbe,
  resetLocalDeviceCache,
  type LocalDevice,
} from "./devices/local-devices.js";

// ---- MCP client ----
export {
  McpClient,
  connectMcpServer,
  connectMcpServerFromCache,
  // Exported so hosts can prime the npm cache on a warm path (a settings screen,
  // a project-open hook) before spawning, instead of paying the registry
  // round-trip on the latency-sensitive path.
  primeMcpServerCache,
  optimizeMcpArgs,
  type McpServerOptions,
} from "./mcp/client.js";
export {
  McpToolCache,
  defaultMcpToolCachePath,
  type CachedMcpTool,
  type McpToolCacheOptions,
} from "./mcp/tool-cache.js";
export {
  McpRuntimePool,
  wrapPooledProvider,
  mcpServerSignature,
  type McpRuntimePoolOptions,
  // Hosts that construct a pool need its logger shape to pass `log` — without
  // this the option is unusable from outside the package.
  type PoolLogger,
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
