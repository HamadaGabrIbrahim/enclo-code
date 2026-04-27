import type { Tool, ToolContext, ToolResult, SubagentSpec } from "./types.js";

const MAX_DEPTH = 3;

const BASE_DESCRIPTION =
  "Run a focused sub-agent on a specific task with its own conversation. The sub-agent has access to the same tools (except spawn_agent itself by default) and runs until it produces a final answer, which is returned as this tool's result. Use for parallelizable or scoped work that you want to keep out of the main conversation.";

interface Args {
  description: string;
  prompt: string;
  allowed_tools?: string[];
  subagent_type?: string;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("spawn_agent: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["description"] !== "string" || obj["description"].length === 0) {
    throw new Error("spawn_agent: 'description' must be a non-empty string");
  }
  if (typeof obj["prompt"] !== "string" || obj["prompt"].length === 0) {
    throw new Error("spawn_agent: 'prompt' must be a non-empty string");
  }
  const args: Args = { description: obj["description"], prompt: obj["prompt"] };
  const allowed = obj["allowed_tools"];
  if (allowed !== undefined) {
    if (!Array.isArray(allowed) || !allowed.every((t) => typeof t === "string")) {
      throw new Error("spawn_agent: 'allowed_tools' must be a string array if provided");
    }
    args.allowed_tools = allowed as string[];
  }
  const sub = obj["subagent_type"];
  if (sub !== undefined) {
    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("spawn_agent: 'subagent_type' must be a non-empty string if provided");
    }
    args.subagent_type = sub;
  }
  return args;
}

/**
 * Build a spawn_agent Tool. The optional `subagents` map customizes the
 * tool's description (so the model can see what specialists exist) and
 * enables `subagent_type` lookups at execute time. Pass an empty map to
 * disable custom subagents while keeping the same code path.
 */
export function createSpawnAgentTool(
  subagents: ReadonlyMap<string, SubagentSpec> = new Map(),
): Tool {
  const description = describeWithSubagents(subagents);
  const properties: Record<string, unknown> = {
    description: {
      type: "string",
      description: "Short label shown in the TUI (e.g. 'search for callers of foo').",
    },
    prompt: {
      type: "string",
      description:
        "The actual task instructions for the sub-agent. Be specific — the sub-agent cannot ask clarifying questions.",
    },
    allowed_tools: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional list of tool names the sub-agent is allowed to use. Defaults to all tools available to the parent except spawn_agent.",
    },
  };
  if (subagents.size > 0) {
    properties["subagent_type"] = {
      type: "string",
      enum: [...subagents.keys()],
      description:
        "Optional name of a registered custom subagent. When set, the sub-agent runs under that subagent's system prompt, tool whitelist, and model.",
    };
  }
  return {
    category: "exec",
    requiresPermission: true,
    definition: {
      type: "function",
      function: {
        name: "spawn_agent",
        description,
        parameters: {
          type: "object",
          properties,
          required: ["description", "prompt"],
          additionalProperties: false,
        },
      },
    },
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(raw);
      if (!ctx.agent) {
        return {
          isError: true,
          content: "spawn_agent: agent hooks not available in this context",
        };
      }
      if (ctx.agent.depth >= MAX_DEPTH) {
        return {
          isError: true,
          content: `spawn_agent: maximum sub-agent depth (${MAX_DEPTH}) reached`,
        };
      }

      // Resolve named custom subagent (if requested). We prefer the live
      // registry from ctx.agent.subagents over the closure-captured one
      // so reload-agents takes effect without rebuilding the tool.
      const liveSubagents = ctx.agent.subagents ?? subagents;
      let resolved: SubagentSpec | undefined;
      if (args.subagent_type) {
        const key = args.subagent_type.toLowerCase();
        resolved = liveSubagents.get(key);
        if (!resolved) {
          const available =
            liveSubagents.size > 0
              ? [...liveSubagents.keys()].join(", ")
              : "(none registered)";
          return {
            isError: true,
            content: `spawn_agent: unknown subagent_type "${args.subagent_type}". Available: ${available}`,
          };
        }
      }

      const spawnArgs: {
        description: string;
        prompt: string;
        allowedTools?: string[];
        systemPrompt?: string;
        model?: string;
      } = {
        description: args.description,
        prompt: args.prompt,
      };
      // Order: subagent fields take precedence over per-call allowed_tools
      // (the subagent author has thought about its tool surface). If the
      // caller passes allowed_tools explicitly, use it.
      if (args.allowed_tools !== undefined) {
        spawnArgs.allowedTools = args.allowed_tools;
      } else if (resolved?.tools) {
        spawnArgs.allowedTools = resolved.tools;
      }
      if (resolved) {
        spawnArgs.systemPrompt = resolved.systemPrompt;
        if (resolved.model) spawnArgs.model = resolved.model;
      }
      const outcome = await ctx.agent.spawn(spawnArgs);
      return {
        isError: outcome.isError,
        content: outcome.text,
        display: { kind: "text", preview: outcome.text.slice(0, 200) },
      };
    },
  };
}

function describeWithSubagents(subagents: ReadonlyMap<string, SubagentSpec>): string {
  if (subagents.size === 0) return BASE_DESCRIPTION;
  const list = [...subagents.entries()]
    .map(([name, s]) => `${name} (${s.description})`)
    .join("; ");
  return `${BASE_DESCRIPTION}\n\nAvailable custom subagents (pass via 'subagent_type'): ${list}`;
}

/** Default spawn_agent tool with no custom subagents — back-compat. */
export const spawnAgent: Tool = createSpawnAgentTool();
