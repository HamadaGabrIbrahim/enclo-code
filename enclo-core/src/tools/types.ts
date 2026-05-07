/**
 * Shared types for the built-in tool registry. The schema mirrors OpenAI's
 * function-calling format so the model can be told about tools verbatim.
 */

export type ToolCategory = "read" | "write" | "exec";

export interface ToolFunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionSchema;
}

export interface ToolResult {
  /** Human/model-readable text. Always present, even on error. */
  content: string;
  /** Whether the tool reported an error. */
  isError?: boolean;
  /** Optional structured payload for the TUI (preview, diff, exit code …). */
  display?: ToolDisplay;
}

export type ToolDisplay =
  | { kind: "text"; preview: string }
  | { kind: "diff"; path: string; before: string; after: string }
  | { kind: "bash"; command: string; stdout: string; stderr: string; exitCode: number }
  | { kind: "list"; items: string[] };

export interface ToolContext {
  /** The current working directory used to resolve relative paths. */
  cwd: string;
  /**
   * Extras populated by the agent loop, used by tools that need to call
   * back into the agent (e.g. spawn_agent). Optional — tools that don't
   * need them can ignore the field.
   */
  agent?: AgentToolHooks;
  /**
   * Optional callback for incremental output. Long-running tools (notably
   * bash) call this as stdout/stderr arrive so the TUI can display live
   * progress instead of a blank pause until completion. Wire-level only —
   * the final ToolResult.content remains authoritative for the model.
   */
  onPartial?: (chunk: ToolPartialChunk) => void;
}

export interface ToolPartialChunk {
  channel: "stdout" | "stderr";
  content: string;
}

/**
 * Hooks the agent loop hands to tools that recursively run the agent
 * (currently just `spawn_agent`). Kept narrow — this is an escape hatch.
 */
export interface AgentToolHooks {
  /** Current sub-agent depth (root = 0). */
  depth: number;
  /**
   * Run a child agent loop to completion, returning its final answer.
   * Internally, the implementation may buffer the child's events on a
   * sink the agent loop drains after this tool call returns.
   */
  spawn(args: SpawnAgentArgs): Promise<SpawnAgentOutcome>;
  /**
   * Optional registry of named custom subagents the spawn_agent tool may
   * select via `subagent_type`. Keys are lowercase subagent names.
   */
  subagents?: ReadonlyMap<string, SubagentSpec>;
  /**
   * Optional one-shot completion against the active model with no tools.
   * Used by tools (e.g. web_fetch) that need to summarize content with
   * the model out-of-band from the main conversation history. Returns
   * the assistant text accumulated from a single streamed completion.
   */
  oneshot?(args: OneshotArgs): Promise<string>;
}

export interface OneshotArgs {
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Minimal spec the spawn_agent tool needs to apply a named custom
 * subagent: its system prompt, optional tool whitelist, and optional
 * model override. Names live as keys in the surrounding Map.
 */
export interface SubagentSpec {
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

export interface SpawnAgentArgs {
  description: string;
  prompt: string;
  /** Optional restriction on which tool names the sub-agent may see. */
  allowedTools?: string[];
  /**
   * Optional override for the sub-agent's system prompt. Used when a
   * named custom subagent is invoked via `subagent_type`.
   */
  systemPrompt?: string;
  /**
   * Optional model id the sub-agent should run under. The agent loop
   * builds a fresh ApiAdapter for this model via the parent's
   * apiFactory; if no factory is configured, the override is ignored
   * and the parent's adapter (and model) is used.
   */
  model?: string;
}

export interface SpawnAgentOutcome {
  /** Final concatenated assistant text from the sub-agent's last turn. */
  text: string;
  /** True if the sub-agent hit its iteration cap or otherwise failed. */
  isError: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  category: ToolCategory;
  /** Whether the tool requires per-invocation user approval. */
  requiresPermission: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
  definitions(): ToolDefinition[];
}

export function makeRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map<string, Tool>();
  for (const t of tools) map.set(t.definition.function.name, t);
  return {
    list: () => [...map.values()],
    get: (name) => map.get(name),
    definitions: () => [...map.values()].map((t) => t.definition),
  };
}
