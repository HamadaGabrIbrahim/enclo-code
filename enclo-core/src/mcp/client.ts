import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../tools/types.js";
import {
  isSseConfig,
  isStdioConfig,
  makePrefixedToolName,
  parsePrefixedToolName,
  type McpConfig,
  type McpServerEntry,
  type McpServerState,
  type McpServerStatus,
} from "./types.js";

export {
  loadMcpConfig,
  userConfigPath,
  projectConfigPath,
  type LoadMcpConfigResult,
  type FsLike,
} from "./config.js";

export type {
  McpConfig,
  McpServerEntry,
  McpServerState,
  McpServerStatus,
} from "./types.js";

/**
 * Minimal client surface used by the manager. We narrow @modelcontextprotocol/sdk
 * Client down to just the methods we exercise so tests can supply a mock without
 * implementing the full Protocol class.
 */
export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools: McpRemoteTool[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content: McpContentBlock[]; isError?: boolean }>;
  close(): Promise<void>;
}

/** Tool descriptor as returned by an MCP server's `tools/list` response. */
export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [k: string]: unknown;
  };
}

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: string; [k: string]: unknown };

/**
 * Factory used to build a fresh client + transport for a given server entry.
 * The default uses the real SDK; tests inject a mock.
 */
export interface McpClientFactory {
  create(server: string, entry: McpServerEntry): {
    client: McpClientLike;
    transport: Transport;
  };
}

export const defaultClientFactory: McpClientFactory = {
  create(server, entry) {
    const client = new Client({
      name: "enclo-code",
      version: "0.1.0",
    });
    let transport: Transport;
    if (isSseConfig(entry)) {
      const initOpts: { eventSourceInit?: { fetch?: typeof fetch }; requestInit?: RequestInit } = {};
      if (entry.headers) {
        const headers = entry.headers;
        initOpts.requestInit = { headers };
        // EventSource constructor doesn't support headers directly; use a custom fetch
        // wrapper so initial SSE GET also carries auth.
        initOpts.eventSourceInit = {
          fetch: (url, init) =>
            fetch(url as string, {
              ...(init ?? {}),
              headers: { ...((init as RequestInit | undefined)?.headers ?? {}), ...headers },
            }),
        };
      }
      transport = new SSEClientTransport(new URL(entry.url), initOpts);
    } else if (isStdioConfig(entry)) {
      transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: { ...process.env as Record<string, string>, ...(entry.env ?? {}) },
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        stderr: "pipe",
      });
    } else {
      throw new Error(`mcp[${server}]: config must specify either 'command' (stdio) or 'url' (sse)`);
    }
    return { client: client as unknown as McpClientLike, transport };
  },
};

export interface McpManagerOptions {
  /** Override the SDK client factory (for tests or alternate transports). */
  factory?: McpClientFactory;
  /** Per-server connect timeout in milliseconds. Default 15s. */
  connectTimeoutMs?: number;
  /** Per-tool-call timeout in milliseconds. Default 60s. */
  callTimeoutMs?: number;
}

interface ServerHandle {
  name: string;
  client: McpClientLike;
  transport: Transport;
  tools: McpRemoteTool[];
  status: McpServerStatus;
  error?: string;
}

const DEFAULT_CONNECT_TIMEOUT = 15_000;
const DEFAULT_CALL_TIMEOUT = 60_000;

/**
 * Manages the lifecycle of a set of MCP server connections and exposes their
 * tools as enclo `Tool` objects. The same instance can be `start()`ed and
 * `stop()`ped multiple times (e.g. for `/reload-mcp`).
 */
export class McpManager {
  private factory: McpClientFactory;
  private connectTimeoutMs: number;
  private callTimeoutMs: number;
  private handles = new Map<string, ServerHandle>();

  constructor(opts: McpManagerOptions = {}) {
    this.factory = opts.factory ?? defaultClientFactory;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT;
  }

  /**
   * Connect to every server in the config in parallel. Failures on individual
   * servers are captured in `getStatus()` and do not break the others.
   *
   * If `onProgress` is supplied, it is called with each server's outcome as
   * connections complete — useful for live UI rendering.
   */
  async start(
    config: McpConfig,
    onProgress?: (state: McpServerState) => void,
  ): Promise<void> {
    if (this.handles.size > 0) {
      await this.stop();
    }
    const entries = Object.entries(config.mcpServers ?? {});
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([name, entry]) => {
        // Pre-register a "starting" handle so getStatus() reflects it.
        const placeholder: ServerHandle = {
          name,
          client: undefined as unknown as McpClientLike,
          transport: undefined as unknown as Transport,
          tools: [],
          status: "starting",
        };
        this.handles.set(name, placeholder);
        if (onProgress) {
          onProgress({ server: name, status: "starting", toolCount: 0 });
        }

        try {
          const { client, transport } = this.factory.create(name, entry);
          await withTimeout(
            client.connect(transport),
            this.connectTimeoutMs,
            `mcp[${name}]: connect timed out after ${this.connectTimeoutMs}ms`,
          );
          const listed = await withTimeout(
            client.listTools(),
            this.connectTimeoutMs,
            `mcp[${name}]: list tools timed out`,
          );
          const tools = listed.tools ?? [];
          this.handles.set(name, {
            name,
            client,
            transport,
            tools,
            status: "connected",
          });
          if (onProgress) {
            onProgress({ server: name, status: "connected", toolCount: tools.length });
          }
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          this.handles.set(name, {
            name,
            client: undefined as unknown as McpClientLike,
            transport: undefined as unknown as Transport,
            tools: [],
            status: "failed",
            error: message,
          });
          if (onProgress) {
            onProgress({ server: name, status: "failed", toolCount: 0, error: message });
          }
        }
      }),
    );
  }

  /**
   * Tear down every active connection. Idempotent; failures are swallowed
   * (the process is exiting / the user reloaded — there's nothing useful to
   * do with a close error).
   */
  async stop(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(
      handles.map(async (h) => {
        if (!h.client) return;
        try {
          await h.client.close();
        } catch {
          /* best-effort */
        }
      }),
    );
  }

  /** Returns one entry per configured server (including failed/starting ones). */
  getStatus(): McpServerState[] {
    return [...this.handles.values()].map((h) => {
      const state: McpServerState = {
        server: h.name,
        status: h.status,
        toolCount: h.tools.length,
      };
      if (h.error !== undefined) state.error = h.error;
      return state;
    });
  }

  /** Snapshot of every connected MCP tool, adapted to enclo's `Tool` shape. */
  getTools(): Tool[] {
    const out: Tool[] = [];
    for (const h of this.handles.values()) {
      if (h.status !== "connected") continue;
      for (const remote of h.tools) {
        out.push(this.adaptTool(h.name, remote));
      }
    }
    return out;
  }

  /**
   * Route a tool invocation back to the originating server. The `name` must
   * be the prefixed form (`mcp__<server>__<tool>`).
   */
  async callTool(prefixedName: string, args: unknown): Promise<ToolResult> {
    const parts = parsePrefixedToolName(prefixedName);
    if (!parts) {
      return {
        isError: true,
        content: `mcp: '${prefixedName}' is not a valid MCP tool name (expected mcp__<server>__<tool>)`,
      };
    }
    const handle = this.handles.get(parts.server);
    if (!handle) {
      return { isError: true, content: `mcp: no server named '${parts.server}'` };
    }
    if (handle.status !== "connected") {
      return {
        isError: true,
        content: `mcp[${parts.server}]: server is ${handle.status}${handle.error ? ` (${handle.error})` : ""}`,
      };
    }
    let response: { content: McpContentBlock[]; isError?: boolean };
    try {
      response = await withTimeout(
        handle.client.callTool({
          name: parts.tool,
          arguments: (args ?? {}) as Record<string, unknown>,
        }),
        this.callTimeoutMs,
        `mcp[${parts.server}.${parts.tool}]: call timed out after ${this.callTimeoutMs}ms`,
      );
    } catch (err) {
      return { isError: true, content: `mcp[${parts.server}.${parts.tool}]: ${(err as Error).message}` };
    }
    return {
      content: renderContent(response.content ?? []),
      ...(response.isError ? { isError: true as const } : {}),
    };
  }

  private adaptTool(server: string, remote: McpRemoteTool): Tool {
    const prefixed = makePrefixedToolName(server, remote.name);
    const params = normalizeInputSchema(remote.inputSchema);
    const definition: ToolDefinition = {
      type: "function",
      function: {
        name: prefixed,
        description: remote.description ?? `MCP tool '${remote.name}' on server '${server}'.`,
        parameters: params,
      },
    };
    return {
      definition,
      category: "exec",
      requiresPermission: true,
      execute: async (rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> => {
        return this.callTool(prefixed, rawArgs);
      },
    };
  }
}

/**
 * Adapt an MCP server's `inputSchema` (raw JSON Schema) to the OpenAI
 * function-calling parameter shape enclo's `ToolDefinition` expects.
 * MCP servers sometimes omit `properties` or `type`; normalize defensively.
 */
function normalizeInputSchema(schema: McpRemoteTool["inputSchema"]): ToolDefinition["function"]["parameters"] {
  const params: ToolDefinition["function"]["parameters"] = {
    type: "object",
    properties: (schema?.properties as Record<string, unknown> | undefined) ?? {},
  };
  if (schema?.required && schema.required.length > 0) {
    params.required = [...schema.required];
  }
  if (typeof schema?.additionalProperties === "boolean") {
    params.additionalProperties = schema.additionalProperties;
  }
  return params;
}

/** Concatenate MCP content blocks into a single text payload. */
function renderContent(blocks: McpContentBlock[]): string {
  if (blocks.length === 0) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
      parts.push((b as { text: string }).text);
    } else if (b.type === "image") {
      const img = b as { mimeType?: string };
      parts.push(`[image: ${img.mimeType ?? "unknown"}]`);
    } else if (b.type === "resource") {
      const r = b as { resource?: { uri?: string; text?: string } };
      const uri = r.resource?.uri ?? "?";
      if (typeof r.resource?.text === "string") {
        parts.push(`[resource ${uri}]\n${r.resource.text}`);
      } else {
        parts.push(`[resource ${uri}]`);
      }
    } else {
      parts.push(`[${b.type}]`);
    }
  }
  return parts.join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
