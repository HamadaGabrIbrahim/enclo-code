// Agent loop + streaming protocol
export {
  runAgent,
} from "./agent/loop.js";
export type {
  RunAgentOptions,
  StreamEvent as AgentStreamEvent,
  AgentEvent,
  AgentMessage,
  AgentToolCall,
  ApiAdapter,
  ChatRequest,
  ChatStream,
  UserContentBlock,
} from "./agent/loop.js";

export { createApiAdapter } from "./agent/api-adapter.js";
export type { CreateAdapterOptions } from "./agent/api-adapter.js";

// Permissions
export {
  createPermissionManager,
  targetOf,
} from "./agent/permissions.js";
export type {
  PermissionChoice,
  PermissionDecision,
  PermissionManager,
  PermissionManagerOptions,
  PermissionPrompt,
  PermissionRequest,
  PermissionSnapshot,
  PermissionStorageBackend,
  AllowEntry,
  DenyEntry,
} from "./agent/permissions.js";

export {
  loadPersistedPermissions,
  addPersistedRule,
  removePersistedRule,
  clearPersistedUserRules,
  defaultUserDir,
  userPermissionsPath,
  projectPermissionsPath,
} from "./agent/permissions-storage.js";
export type {
  PermissionRule,
  PermissionRuleScope,
  PermissionRuleEffect,
  PermissionRuleSource,
  PermissionsFile,
  StorageOptions as PermissionStorageOptions,
  AddRuleArgs,
} from "./agent/permissions-storage.js";

// Hooks
export {
  createHooksManager,
  loadHooksFile,
  globToRegExp,
  primaryPath,
  matcherMatches,
  buildHookEnv,
  runHook,
  HOOK_EVENTS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./agent/hooks.js";
export type {
  HookEvent,
  HookConfig,
  HookMatcher,
  HookPayload,
  HookResult,
  HookRunOutcome,
  HooksFile,
  HooksManager,
  HooksManagerOptions,
} from "./agent/hooks.js";

// Project context (enclo.md discovery)
export {
  findProjectContext,
  listSearchPaths,
  MAX_PROJECT_CONTEXT_BYTES,
} from "./agent/project-context.js";
export type { ProjectContext } from "./agent/project-context.js";

// File @-references
export {
  extractFileRefs,
  expandFileRefs,
  MAX_FILES_PER_MESSAGE,
  MAX_BYTES_PER_FILE,
} from "./agent/file-refs.js";
export type {
  IncludedFile,
  ExpandResult,
  ExpandOptions,
} from "./agent/file-refs.js";

// System prompt
export {
  buildSystemPrompt,
  buildSystemMessages,
  formatProjectContextMessage,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  PLAN_MODE_SUFFIX,
} from "./agent/system-prompt.js";
export type { SystemPromptArgs } from "./agent/system-prompt.js";

// Custom subagents
export {
  discoverCustomSubagents,
  parseCustomSubagent,
  describeSubagents,
} from "./agent/custom-subagents.js";
export type { CustomSubagent } from "./agent/custom-subagents.js";

// Custom skills
export {
  discoverCustomSkills,
  parseCustomSkill,
  applyCustomSkill,
  substituteSkillBody,
} from "./discovery/custom-skills.js";
export type {
  CustomSkill,
  AppliedCustomSkill,
  DiscoverOptions as CustomSkillDiscoverOptions,
} from "./discovery/custom-skills.js";

// Auto-compact
export {
  shouldAutoCompact,
  DEFAULT_COMPACT_THRESHOLD,
} from "./agent/auto-compact.js";
export type { CompactDecisionInput } from "./agent/auto-compact.js";

// Diff
export { lineDiff } from "./agent/diff.js";
export type { DiffLine } from "./agent/diff.js";

// Resume (rebuild AgentMessage[] from server conversation history)
export { restoreHistory } from "./agent/resume.js";

// MCP
export { McpManager, defaultClientFactory } from "./mcp/client.js";
export type {
  McpManagerOptions,
  McpClientLike,
  McpClientFactory,
  McpRemoteTool,
  McpContentBlock,
} from "./mcp/client.js";
export { loadMcpConfig, userConfigPath, projectConfigPath } from "./mcp/config.js";
export type { LoadMcpConfigResult, FsLike as McpFsLike } from "./mcp/config.js";
export {
  isSseConfig,
  isStdioConfig,
  makePrefixedToolName,
  parsePrefixedToolName,
  McpConfigSchema,
  McpServerEntrySchema,
  StdioServerSchema,
  SseServerSchema,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SEPARATOR,
} from "./mcp/types.js";
export type {
  McpConfig,
  McpServerEntry,
  McpServerState,
  McpServerStatus,
  StdioServerConfig,
  SseServerConfig,
  PrefixedNameParts,
} from "./mcp/types.js";

// Custom slash commands
export {
  discoverCustomCommands,
  applyCustomCommand,
  parseCustomCommand,
} from "./discovery/custom-commands.js";
export type {
  CustomCommand,
  AppliedCustomCommand,
  DiscoverOptions as CustomCommandDiscoverOptions,
} from "./discovery/custom-commands.js";

// API client + endpoints + schemas
export * from "./api/index.js";

// Tools
export {
  readFile,
  writeFile,
  editFile,
  bash,
  grep,
  glob,
  listDir,
  spawnAgent,
  createSpawnAgentTool,
  createSkillTool,
  webFetch,
  webSearch,
  builtInTools,
  builtInRegistry,
  combinedRegistry,
} from "./tools/index.js";
export type {
  Tool,
  ToolRegistry,
  ToolDefinition,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolDisplay,
  AgentToolHooks,
  OneshotArgs,
  SpawnAgentArgs,
  SpawnAgentOutcome,
  SubagentSpec,
} from "./tools/index.js";
export { makeRegistry } from "./tools/types.js";
export { runBash } from "./tools/bash.js";
export { globToRegex } from "./tools/glob.js";

// Token usage tracking
export {
  EMPTY_USAGE,
  addUsage,
  computeContextUsed,
  computeCostUsd,
  severityFor,
  formatTokenCount,
  formatCostUsd,
  formatPercent,
} from "./state/token-usage.js";
export type {
  TokenUsage,
  TokenUsageState,
  ContextSeverity,
  CostRates,
} from "./state/token-usage.js";

// Config types (consumers supply their own ConfigStore implementation)
export type { ConfigStore, EncloConfig } from "./config/types.js";
export { ConfigSchema } from "./config/types.js";
