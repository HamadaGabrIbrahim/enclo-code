import { z } from "zod";

/**
 * Schema for a single MCP server entry. Either spawn a subprocess (stdio)
 * or open an SSE connection. The transport field is optional and inferred
 * from which fields are present.
 */
export const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  transport: z.literal("stdio").optional(),
});

export const SseServerSchema = z.object({
  url: z.string().url(),
  transport: z.literal("sse"),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerEntrySchema = z.union([StdioServerSchema, SseServerSchema]);

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerEntrySchema).default({}),
});

export type StdioServerConfig = z.infer<typeof StdioServerSchema>;
export type SseServerConfig = z.infer<typeof SseServerSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

export function isSseConfig(entry: McpServerEntry): entry is SseServerConfig {
  return "url" in entry && entry.transport === "sse";
}

export function isStdioConfig(entry: McpServerEntry): entry is StdioServerConfig {
  return "command" in entry;
}

export type McpServerStatus = "starting" | "connected" | "failed" | "stopped";

export interface McpServerState {
  server: string;
  status: McpServerStatus;
  toolCount: number;
  error?: string;
}

/**
 * The prefix delimiter used in tool names exposed to the model.
 * `mcp__<server>__<tool>` lets the manager route a call back to the right server.
 */
export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_TOOL_SEPARATOR = "__";

export function makePrefixedToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}${MCP_TOOL_SEPARATOR}${tool}`;
}

export interface PrefixedNameParts {
  server: string;
  tool: string;
}

export function parsePrefixedToolName(name: string): PrefixedNameParts | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf(MCP_TOOL_SEPARATOR);
  if (idx <= 0 || idx === rest.length - MCP_TOOL_SEPARATOR.length) return null;
  return {
    server: rest.slice(0, idx),
    tool: rest.slice(idx + MCP_TOOL_SEPARATOR.length),
  };
}
