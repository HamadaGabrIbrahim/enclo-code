import type {
  ToolDefinition,
  ToolRegistry,
  ToolResult,
  ToolDisplay,
  AgentToolHooks,
  SpawnAgentArgs,
  SpawnAgentOutcome,
  SubagentSpec,
} from "../tools/index.js";
import { makeRegistry, type Tool } from "../tools/types.js";
import type { PermissionManager } from "./permissions.js";
import type { HooksManager } from "./hooks.js";

/**
 * Multi-modal content blocks for vision-capable models. Mirrors the OpenAI
 * shape forwarded straight through to the backend.
 */
export type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

/**
 * Agent-side message types. Mostly mirrors OpenAI's chat schema, with the
 * `tool` role for tool results. Stored shape, not the wire format — the API
 * client is free to translate when it sends messages to the server.
 *
 * `user` content may be a plain string OR a list of multi-modal blocks
 * (text + images). All other roles use plain string content.
 */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentBlock[] }
  | {
      role: "assistant";
      content: string;
      tool_calls?: AgentToolCall[];
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * The loop-level event surface. The TUI consumes this AsyncIterable and
 * renders streaming text + tool calls inline.
 */
export type AgentEvent =
  | { type: "assistant_text"; delta: string }
  | { type: "tool_call_partial"; index: number; call: Partial<AgentToolCall> }
  | { type: "tool_call_pending"; call: AgentToolCall }
  | {
      type: "tool_result";
      call_id: string;
      name: string;
      result: ToolResult;
      display?: ToolDisplay;
    }
  | { type: "tool_denied"; call_id: string; name: string }
  | {
      type: "turn_complete";
      finishReason: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }
  | { type: "agent_done"; finalMessages: AgentMessage[] }
  | { type: "agent_error"; message: string }
  /** Lifecycle hook surfaced a stdout line — render as a chat notice. */
  | { type: "hook_notice"; message: string }
  /** A hook exited non-zero (and not 2) — render as a warning. */
  | { type: "hook_warning"; message: string }
  /**
   * Wrapper for events emitted by a child agent spawned via the
   * spawn_agent tool. `parentCallId` identifies the spawn_agent tool call
   * the child belongs to, so the TUI can render the events nested
   * underneath that tool block.
   */
  | { type: "sub_agent_event"; parentCallId: string; event: AgentEvent };

/**
 * Streamed events from the underlying chat completion. The api/chat module
 * already emits these; we re-export shapes here so the loop is decoupled
 * from the SSE wire details.
 */
export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | {
      type: "end";
      finishReason: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }
  | { type: "error"; message: string };

export interface ChatRequest {
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export interface ChatStream {
  /**
   * AsyncIterable of streamed events from a single completion. The loop
   * consumes this exactly once per turn.
   */
  events: AsyncIterable<StreamEvent>;
}

export interface ApiAdapter {
  streamChat(req: ChatRequest): Promise<ChatStream>;
}

export interface RunAgentOptions {
  api: ApiAdapter;
  tools: ToolRegistry;
  permissions: PermissionManager;
  cwd: string;
  history: AgentMessage[];
  /**
   * The user's message for this turn. Pass a plain string for text-only
   * input, or a list of multi-modal blocks (text + images) for vision.
   */
  userInput: string | UserContentBlock[];
  /** Safety cap on the number of tool-call rounds. */
  maxIterations?: number;
  /** When true, write/exec tools are blocked with a synthetic plan-mode result. */
  planMode?: boolean;
  /** Sub-agent depth (root = 0). Used by spawn_agent to cap recursion. */
  depth?: number;
  /**
   * Optional hook manager. When set, the loop fires lifecycle events
   * (PreToolUse, PostToolUse, Stop, SubagentStop) at the matching points.
   * UserPromptSubmit / SessionStart / SessionEnd fire higher up in the app.
   */
  hooks?: HooksManager;
  /**
   * Optional factory for ApiAdapters keyed by model id. When a sub-agent
   * is spawned with a `model` override (e.g. via a custom subagent), the
   * loop calls this factory to produce a fresh adapter; without it the
   * parent's adapter is reused and the model override is ignored.
   */
  apiFactory?: (model: string) => ApiAdapter;
  /**
   * Optional registry of named custom subagents. Forwarded to the
   * spawn_agent tool via AgentToolHooks so it can resolve `subagent_type`
   * lookups without a global lookup.
   */
  subagents?: ReadonlyMap<string, SubagentSpec>;
}

const DEFAULT_MAX_ITERATIONS = 25;
const SUB_AGENT_MAX_ITERATIONS = 15;
const MAX_SUB_AGENT_DEPTH = 3;

const PLAN_MODE_BLOCKED_RESULT =
  "plan_mode: this tool is disabled in plan mode. Describe what you would do, list the steps, and wait for the user to exit plan mode.";

const SUB_AGENT_SYSTEM_PROMPT = (description: string): string =>
  `You are a sub-agent of enclo, focused on a specific task: ${description}. Complete the task using the available tools and return a concise final answer. Do not ask the user clarifying questions; use your best judgment.`;

/** Restrict a parent registry to a subset of tool names, or strip spawn_agent. */
function childRegistry(parent: ToolRegistry, allowed?: string[]): ToolRegistry {
  const all = parent.list();
  let filtered: Tool[];
  if (allowed && allowed.length > 0) {
    const set = new Set(allowed);
    filtered = all.filter((t) => set.has(t.definition.function.name));
  } else {
    filtered = all.filter((t) => t.definition.function.name !== "spawn_agent");
  }
  return makeRegistry(filtered);
}

/**
 * Drive a single user turn end-to-end. Yields events as they happen and
 * terminates when the model returns a non-tool finish reason or the
 * iteration cap is hit.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const messages: AgentMessage[] = [...opts.history, { role: "user", content: opts.userInput }];
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolDefs = opts.tools.definitions();

  for (let iter = 0; iter < maxIter; iter += 1) {
    let stream: ChatStream;
    try {
      stream = await opts.api.streamChat({ messages, tools: toolDefs });
    } catch (err) {
      yield { type: "agent_error", message: (err as Error).message };
      return;
    }

    const assistantMsg: {
      role: "assistant";
      content: string;
      tool_calls: AgentToolCall[];
    } = { role: "assistant", content: "", tool_calls: [] };
    let finishReason = "stop";
    let streamError: string | undefined;
    let endUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    for await (const ev of stream.events) {
      if (ev.type === "delta") {
        assistantMsg.content += ev.content;
        yield { type: "assistant_text", delta: ev.content };
      } else if (ev.type === "tool_call_delta") {
        const slot = assistantMsg.tool_calls[ev.index] ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (ev.id) slot.id = ev.id;
        if (ev.name) slot.function.name = ev.name;
        if (ev.arguments) slot.function.arguments += ev.arguments;
        assistantMsg.tool_calls[ev.index] = slot;
        yield { type: "tool_call_partial", index: ev.index, call: slot };
      } else if (ev.type === "end") {
        finishReason = ev.finishReason;
        if (ev.usage) endUsage = ev.usage;
      } else if (ev.type === "error") {
        streamError = ev.message;
      }
    }

    if (streamError) {
      yield { type: "agent_error", message: streamError };
      return;
    }

    // Persist the assistant message we just built.
    const persisted: AgentMessage =
      assistantMsg.tool_calls.length > 0
        ? assistantMsg
        : { role: "assistant", content: assistantMsg.content };
    messages.push(persisted);

    yield endUsage
      ? { type: "turn_complete", finishReason, usage: endUsage }
      : { type: "turn_complete", finishReason };

    if (finishReason !== "tool_calls" || assistantMsg.tool_calls.length === 0) {
      // Stop hook: a non-empty stdout with exit 2 forces another loop
      // iteration so the model sees why it was forced to continue.
      if (opts.hooks) {
        const outcome = await opts.hooks.run("Stop", {
          event: "Stop",
          reason: finishReason,
          cwd: opts.cwd,
        });
        for (const w of outcome.warnings) yield { type: "hook_warning", message: w };
        for (const n of outcome.notices) yield { type: "hook_notice", message: n };
        if (outcome.blocked) {
          messages.push({
            role: "system",
            content:
              `Stop hook blocked completion. Reason: ${outcome.blockMessage ?? "blocked"}\n` +
              "Continue working on the task.",
          });
          continue;
        }
      }
      yield { type: "agent_done", finalMessages: messages };
      return;
    }

    // Execute each tool call in order.
    for (const call of assistantMsg.tool_calls) {
      // Defensive: synthesize an id if the model/server omitted one.
      if (!call.id) call.id = `call_${Math.random().toString(36).slice(2, 10)}`;
      yield { type: "tool_call_pending", call };

      const tool = opts.tools.get(call.function.name);
      if (!tool) {
        const result: ToolResult = {
          isError: true,
          content: `Unknown tool: ${call.function.name}`,
        };
        yield { type: "tool_result", call_id: call.id, name: call.function.name, result };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result.content,
        });
        continue;
      }

      let parsedArgs: unknown = {};
      let parseError: string | undefined;
      const argText = call.function.arguments?.trim() ?? "";
      if (argText.length > 0) {
        try {
          parsedArgs = JSON.parse(argText);
        } catch (err) {
          parseError = `Invalid JSON arguments for ${call.function.name}: ${(err as Error).message}`;
        }
      }
      if (parseError) {
        const result: ToolResult = { isError: true, content: parseError };
        yield { type: "tool_result", call_id: call.id, name: call.function.name, result };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result.content,
        });
        continue;
      }

      if (opts.planMode && (tool.category === "write" || tool.category === "exec")) {
        const blocked: ToolResult = { content: PLAN_MODE_BLOCKED_RESULT };
        yield { type: "tool_result", call_id: call.id, name: call.function.name, result: blocked };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: blocked.content,
        });
        continue;
      }

      if (opts.hooks) {
        const pre = await opts.hooks.run("PreToolUse", {
          event: "PreToolUse",
          tool_name: call.function.name,
          tool_args: parsedArgs,
          cwd: opts.cwd,
        });
        for (const w of pre.warnings) yield { type: "hook_warning", message: w };
        for (const n of pre.notices) yield { type: "hook_notice", message: n };
        if (pre.blocked) {
          const synthetic: ToolResult = {
            isError: true,
            content: JSON.stringify({
              error: "blocked_by_hook",
              message: pre.blockMessage ?? "blocked by hook",
            }),
          };
          yield {
            type: "tool_result",
            call_id: call.id,
            name: call.function.name,
            result: synthetic,
          };
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: synthetic.content,
          });
          continue;
        }
      }

      const decision = await opts.permissions.check({
        tool,
        args: parsedArgs,
        cwd: opts.cwd,
      });

      if (decision === "deny") {
        const denial: ToolResult = {
          isError: true,
          content: "User denied this tool call.",
        };
        yield { type: "tool_denied", call_id: call.id, name: call.function.name };
        yield { type: "tool_result", call_id: call.id, name: call.function.name, result: denial };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: denial.content,
        });
        continue;
      }

      // Build agent hooks for this tool call. Sub-agent events are
      // buffered here and flushed after execute() resolves so we can
      // yield them in order (generator can't yield from within an
      // awaited callback).
      const subAgentBuffer: AgentEvent[] = [];
      const hooks: AgentToolHooks = {
        depth: opts.depth ?? 0,
        spawn: async (sa: SpawnAgentArgs): Promise<SpawnAgentOutcome> => {
          return runSubAgent({
            parent: opts,
            args: sa,
            onEvent: (ev) => subAgentBuffer.push(ev),
          });
        },
        oneshot: async (oa): Promise<string> => {
          const oneshotMessages: AgentMessage[] = [
            { role: "system", content: oa.system },
            { role: "user", content: oa.user },
          ];
          const oneshotStream = await opts.api.streamChat({
            messages: oneshotMessages,
            tools: [],
          });
          let text = "";
          for await (const ev of oneshotStream.events) {
            if (ev.type === "delta") text += ev.content;
            else if (ev.type === "error") throw new Error(ev.message);
          }
          return text;
        },
        ...(opts.subagents ? { subagents: opts.subagents } : {}),
      };

      let result: ToolResult;
      try {
        result = await tool.execute(parsedArgs, { cwd: opts.cwd, agent: hooks });
      } catch (err) {
        result = { isError: true, content: `Error: ${(err as Error).message}` };
      }
      // Flush any sub-agent events captured during execute().
      for (const ev of subAgentBuffer) {
        yield { type: "sub_agent_event", parentCallId: call.id, event: ev };
      }
      yield {
        type: "tool_result",
        call_id: call.id,
        name: call.function.name,
        result,
        ...(result.display ? { display: result.display } : {}),
      };
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result.content,
      });

      if (opts.hooks) {
        const post = await opts.hooks.run("PostToolUse", {
          event: "PostToolUse",
          tool_name: call.function.name,
          tool_args: parsedArgs,
          cwd: opts.cwd,
          result: { content: result.content, ...(result.isError ? { isError: true } : {}) },
        });
        for (const w of post.warnings) yield { type: "hook_warning", message: w };
        for (const n of post.notices) yield { type: "hook_notice", message: n };
        // PostToolUse cannot block — exit-2 is treated as a notice/warning.
      }
    }
    // Loop back: send tool results to the model.
  }

  yield {
    type: "agent_error",
    message: `Agent stopped after ${maxIter} iterations without finishing.`,
  };
}

interface RunSubAgentArgs {
  parent: RunAgentOptions;
  args: SpawnAgentArgs;
  onEvent: (ev: AgentEvent) => void;
}

/**
 * Run a child agent loop to completion, forwarding its events to
 * `onEvent` and returning a SpawnAgentOutcome with the final assistant
 * text.
 */
async function runSubAgent(opts: RunSubAgentArgs): Promise<SpawnAgentOutcome> {
  const parentDepth = opts.parent.depth ?? 0;
  if (parentDepth >= MAX_SUB_AGENT_DEPTH) {
    return {
      text: `spawn_agent: maximum sub-agent depth (${MAX_SUB_AGENT_DEPTH}) reached`,
      isError: true,
    };
  }
  const tools = childRegistry(opts.parent.tools, opts.args.allowedTools);
  const systemPrompt = opts.args.systemPrompt ?? SUB_AGENT_SYSTEM_PROMPT(opts.args.description);
  const history: AgentMessage[] = [{ role: "system", content: systemPrompt }];

  // If the spawn requested a specific model and the parent gave us a
  // factory, build a fresh adapter for that model. Otherwise reuse the
  // parent's adapter (and silently ignore the model override).
  const api =
    opts.args.model && opts.parent.apiFactory
      ? opts.parent.apiFactory(opts.args.model)
      : opts.parent.api;

  const childOpts: RunAgentOptions = {
    api,
    tools,
    permissions: opts.parent.permissions,
    cwd: opts.parent.cwd,
    history,
    userInput: opts.args.prompt,
    maxIterations: SUB_AGENT_MAX_ITERATIONS,
    depth: parentDepth + 1,
  };
  if (opts.parent.planMode !== undefined) childOpts.planMode = opts.parent.planMode;
  if (opts.parent.hooks) childOpts.hooks = opts.parent.hooks;
  if (opts.parent.apiFactory) childOpts.apiFactory = opts.parent.apiFactory;
  if (opts.parent.subagents) childOpts.subagents = opts.parent.subagents;

  let finalText = "";
  let lastError: string | undefined;
  for await (const ev of runAgent(childOpts)) {
    opts.onEvent(ev);
    if (ev.type === "assistant_text") {
      // Accumulate the very last assistant text (cleared at every
      // turn_complete that is followed by another turn).
      finalText += ev.delta;
    } else if (ev.type === "turn_complete" && ev.finishReason === "tool_calls") {
      // The current text was just an interim assistant message before
      // tool calls — discard it; the final answer comes in a later turn.
      finalText = "";
    } else if (ev.type === "agent_error") {
      lastError = ev.message;
    }
  }
  const isError = lastError !== undefined;
  const finalAnswer = isError ? `sub_agent error: ${lastError}` : finalText.trim();
  if (opts.parent.hooks) {
    const outcome = await opts.parent.hooks.run("SubagentStop", {
      event: "SubagentStop",
      description: opts.args.description,
      final_text: finalAnswer,
      is_error: isError,
      cwd: opts.parent.cwd,
    });
    for (const w of outcome.warnings) opts.onEvent({ type: "hook_warning", message: w });
    for (const n of outcome.notices) opts.onEvent({ type: "hook_notice", message: n });
  }
  if (isError) return { text: finalAnswer, isError: true };
  return { text: finalAnswer, isError: false };
}
