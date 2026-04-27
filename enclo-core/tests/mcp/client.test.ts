import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpManager } from "../../src/mcp/client.js";
import {
  loadMcpConfig,
  projectConfigPath,
  type FsLike,
} from "../../src/mcp/config.js";
import {
  makePrefixedToolName,
  parsePrefixedToolName,
  McpConfigSchema,
  type McpConfig,
} from "../../src/mcp/types.js";
import type {
  McpClientFactory,
  McpClientLike,
  McpRemoteTool,
} from "../../src/mcp/client.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-mcp-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * In-memory fs adapter that fails ENOENT for everything except the explicit
 * paths supplied — keeps the test from accidentally reading the real
 * ~/.enclo/mcp.json on the developer's machine.
 */
function fakeFs(files: Record<string, string>): FsLike {
  return {
    async readFile(p: string): Promise<string> {
      if (p in files) return files[p]!;
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  };
}

describe("McpConfigSchema", () => {
  it("accepts a stdio entry with command + args + env", () => {
    const out = McpConfigSchema.safeParse({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "x"], env: { TOK: "abc" } },
      },
    });
    expect(out.success).toBe(true);
  });

  it("accepts an SSE entry with url + headers", () => {
    const out = McpConfigSchema.safeParse({
      mcpServers: {
        remote: {
          url: "https://example.com/sse",
          transport: "sse",
          headers: { Authorization: "Bearer x" },
        },
      },
    });
    expect(out.success).toBe(true);
  });

  it("rejects an entry with neither command nor url", () => {
    const out = McpConfigSchema.safeParse({
      mcpServers: { broken: { transport: "stdio" } },
    });
    expect(out.success).toBe(false);
  });

  it("defaults mcpServers to {} when omitted", () => {
    const out = McpConfigSchema.parse({});
    expect(out.mcpServers).toEqual({});
  });
});

describe("prefixed tool names", () => {
  it("round-trips server + tool", () => {
    const name = makePrefixedToolName("github", "list_repos");
    expect(name).toBe("mcp__github__list_repos");
    expect(parsePrefixedToolName(name)).toEqual({
      server: "github",
      tool: "list_repos",
    });
  });

  it("rejects names without the mcp__ prefix", () => {
    expect(parsePrefixedToolName("bash")).toBeNull();
    expect(parsePrefixedToolName("github__list_repos")).toBeNull();
  });

  it("handles tool names that themselves contain underscores", () => {
    const parts = parsePrefixedToolName("mcp__github__list_pull_requests");
    expect(parts).toEqual({ server: "github", tool: "list_pull_requests" });
  });

  it("rejects a missing tool segment", () => {
    expect(parsePrefixedToolName("mcp__github")).toBeNull();
    expect(parsePrefixedToolName("mcp____tool")).toBeNull();
  });
});

describe("loadMcpConfig", () => {
  it("returns an empty config when no files exist", async () => {
    const out = await loadMcpConfig(tmpDir, fakeFs({}));
    expect(out.config).toEqual({ mcpServers: {} });
    expect(out.sources).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it("loads project config from .enclo/mcp.json under cwd", async () => {
    const out = await loadMcpConfig(
      tmpDir,
      fakeFs({
        [projectConfigPath(tmpDir)]: JSON.stringify({
          mcpServers: {
            fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
          },
        }),
      }),
    );
    expect(out.errors).toEqual([]);
    expect(Object.keys(out.config.mcpServers)).toEqual(["fs"]);
  });

  it("project entries shadow user-global entries with the same name", async () => {
    // We can't easily use the real userConfigPath() in tests without
    // touching $HOME, so build paths the loader will look at by passing
    // both via the fake fs.
    const userPath = (await import("../../src/mcp/config.js")).userConfigPath();
    const projPath = projectConfigPath(tmpDir);
    const out = await loadMcpConfig(
      tmpDir,
      fakeFs({
        [userPath]: JSON.stringify({
          mcpServers: { db: { command: "user-bin" } },
        }),
        [projPath]: JSON.stringify({
          mcpServers: { db: { command: "project-bin" } },
        }),
      }),
    );
    expect(out.errors).toEqual([]);
    expect(out.config.mcpServers.db).toEqual({ command: "project-bin" });
  });

  it("captures parse errors per-file and keeps the rest", async () => {
    const userPath = (await import("../../src/mcp/config.js")).userConfigPath();
    const projPath = projectConfigPath(tmpDir);
    const out = await loadMcpConfig(
      tmpDir,
      fakeFs({
        [userPath]: "not-json",
        [projPath]: JSON.stringify({
          mcpServers: { fs: { command: "ok" } },
        }),
      }),
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.path).toBe(userPath);
    expect(out.config.mcpServers.fs).toEqual({ command: "ok" });
  });
});

// ---- McpManager (with mock SDK) -----------------------------------------

class FakeTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((m: unknown) => void) | undefined;
  start = vi.fn(async () => undefined);
  send = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

interface FakeClientOpts {
  tools?: McpRemoteTool[];
  /** When set, connect() rejects with this Error. */
  connectError?: string;
  /** When set, callTool() rejects with this Error. */
  callError?: string;
  /** Static call response. */
  callResponse?: { content: { type: string; text?: string }[]; isError?: boolean };
}

function fakeClient(opts: FakeClientOpts = {}): McpClientLike {
  return {
    connect: vi.fn(async () => {
      if (opts.connectError) throw new Error(opts.connectError);
    }),
    listTools: vi.fn(async () => ({ tools: opts.tools ?? [] })),
    callTool: vi.fn(async (_params: { name: string; arguments?: unknown }) => {
      if (opts.callError) throw new Error(opts.callError);
      return opts.callResponse ?? { content: [{ type: "text", text: "ok" }] };
    }),
    close: vi.fn(async () => undefined),
  };
}

function factoryReturning(
  servers: Record<string, McpClientLike>,
): McpClientFactory {
  return {
    create(name: string) {
      const client = servers[name];
      if (!client) throw new Error(`fakeFactory: no client for ${name}`);
      return { client, transport: new FakeTransport() };
    },
  };
}

const sampleConfig: McpConfig = {
  mcpServers: {
    files: { command: "npx", args: ["-y", "filesystem"] },
    db: { command: "npx", args: ["-y", "postgres"] },
  },
};

describe("McpManager", () => {
  it("prefixes tool names with mcp__<server>__", async () => {
    const filesClient = fakeClient({
      tools: [
        { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      ],
    });
    const dbClient = fakeClient({
      tools: [{ name: "query", description: "run sql" }],
    });
    const mgr = new McpManager({
      factory: factoryReturning({ files: filesClient, db: dbClient }),
    });
    await mgr.start(sampleConfig);

    const tools = mgr.getTools().map((t) => t.definition.function.name).sort();
    expect(tools).toEqual(["mcp__db__query", "mcp__files__read"]);

    const readTool = mgr.getTools().find(
      (t) => t.definition.function.name === "mcp__files__read",
    )!;
    expect(readTool.category).toBe("exec");
    expect(readTool.requiresPermission).toBe(true);
    expect(readTool.definition.function.parameters.required).toEqual(["path"]);
  });

  it("routes callTool to the originating server", async () => {
    const filesClient = fakeClient({
      tools: [{ name: "read" }],
      callResponse: { content: [{ type: "text", text: "hello world" }] },
    });
    const dbClient = fakeClient({
      tools: [{ name: "query" }],
      callResponse: { content: [{ type: "text", text: "rows: 2" }] },
    });
    const mgr = new McpManager({
      factory: factoryReturning({ files: filesClient, db: dbClient }),
    });
    await mgr.start(sampleConfig);

    const r = await mgr.callTool("mcp__files__read", { path: "/tmp/x" });
    expect(r.content).toBe("hello world");
    expect(r.isError).toBeUndefined();
    expect(filesClient.callTool).toHaveBeenCalledWith({
      name: "read",
      arguments: { path: "/tmp/x" },
    });
    expect(dbClient.callTool).not.toHaveBeenCalled();
  });

  it("returns an error when callTool targets an unknown server", async () => {
    const mgr = new McpManager({
      factory: factoryReturning({ files: fakeClient({ tools: [{ name: "read" }] }) }),
    });
    await mgr.start({ mcpServers: { files: sampleConfig.mcpServers.files! } });

    const r = await mgr.callTool("mcp__missing__x", {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no server named 'missing'/);
  });

  it("rejects malformed prefixed tool names", async () => {
    const mgr = new McpManager({ factory: factoryReturning({}) });
    const r = await mgr.callTool("not_an_mcp_tool", {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a valid MCP tool name/);
  });

  it("a failed server does not prevent others from connecting", async () => {
    const okClient = fakeClient({ tools: [{ name: "ping" }] });
    const badClient = fakeClient({ connectError: "network down" });
    const mgr = new McpManager({
      factory: factoryReturning({ ok: okClient, bad: badClient }),
    });
    await mgr.start({
      mcpServers: {
        ok: { command: "x" },
        bad: { command: "y" },
      },
    });

    const status = mgr.getStatus().sort((a, b) => a.server.localeCompare(b.server));
    const okState = status.find((s) => s.server === "ok")!;
    const badState = status.find((s) => s.server === "bad")!;
    expect(okState.status).toBe("connected");
    expect(okState.toolCount).toBe(1);
    expect(badState.status).toBe("failed");
    expect(badState.error).toMatch(/network down/);

    expect(mgr.getTools().map((t) => t.definition.function.name)).toEqual(["mcp__ok__ping"]);
  });

  it("captures call errors as a tool error result instead of throwing", async () => {
    const mgr = new McpManager({
      factory: factoryReturning({
        files: fakeClient({ tools: [{ name: "read" }], callError: "permission denied" }),
      }),
    });
    await mgr.start({ mcpServers: { files: { command: "x" } } });
    const r = await mgr.callTool("mcp__files__read", {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/permission denied/);
  });

  it("propagates the MCP isError flag from the server", async () => {
    const mgr = new McpManager({
      factory: factoryReturning({
        files: fakeClient({
          tools: [{ name: "read" }],
          callResponse: { content: [{ type: "text", text: "boom" }], isError: true },
        }),
      }),
    });
    await mgr.start({ mcpServers: { files: { command: "x" } } });
    const r = await mgr.callTool("mcp__files__read", {});
    expect(r.isError).toBe(true);
    expect(r.content).toBe("boom");
  });

  it("getStatus reports starting/connected/failed states", async () => {
    const okClient = fakeClient({ tools: [{ name: "x" }] });
    const badClient = fakeClient({ connectError: "nope" });
    const mgr = new McpManager({
      factory: factoryReturning({ ok: okClient, bad: badClient }),
    });
    const observedStarts: string[] = [];
    await mgr.start(
      { mcpServers: { ok: { command: "x" }, bad: { command: "y" } } },
      (s) => {
        if (s.status === "starting") observedStarts.push(s.server);
      },
    );
    expect(observedStarts.sort()).toEqual(["bad", "ok"]);
    const status = mgr.getStatus().sort((a, b) => a.server.localeCompare(b.server));
    expect(status.map((s) => [s.server, s.status])).toEqual([
      ["bad", "failed"],
      ["ok", "connected"],
    ]);
  });

  it("stop() closes every connected client and clears the tool list", async () => {
    const clientA = fakeClient({ tools: [{ name: "a" }] });
    const clientB = fakeClient({ tools: [{ name: "b" }] });
    const mgr = new McpManager({
      factory: factoryReturning({ a: clientA, b: clientB }),
    });
    await mgr.start({
      mcpServers: { a: { command: "x" }, b: { command: "y" } },
    });
    expect(mgr.getTools()).toHaveLength(2);
    await mgr.stop();
    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(clientB.close).toHaveBeenCalledTimes(1);
    expect(mgr.getTools()).toEqual([]);
    expect(mgr.getStatus()).toEqual([]);
  });

  it("start() is idempotent — calling it twice tears down the previous run", async () => {
    const v1 = fakeClient({ tools: [{ name: "v1" }] });
    const v2 = fakeClient({ tools: [{ name: "v2" }] });
    const mgr = new McpManager({
      factory: factoryReturning({ srv: v1 }),
    });
    await mgr.start({ mcpServers: { srv: { command: "x" } } });
    expect(mgr.getTools().map((t) => t.definition.function.name)).toEqual(["mcp__srv__v1"]);

    // Swap the factory and restart.
    (mgr as unknown as { factory: McpClientFactory }).factory =
      factoryReturning({ srv: v2 });
    await mgr.start({ mcpServers: { srv: { command: "x" } } });
    expect(v1.close).toHaveBeenCalledTimes(1);
    expect(mgr.getTools().map((t) => t.definition.function.name)).toEqual(["mcp__srv__v2"]);
  });

  it("execute() on the adapted Tool calls the right server", async () => {
    const mgr = new McpManager({
      factory: factoryReturning({
        files: fakeClient({
          tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }],
          callResponse: { content: [{ type: "text", text: "FILE CONTENTS" }] },
        }),
      }),
    });
    await mgr.start({ mcpServers: { files: { command: "x" } } });
    const tool = mgr.getTools()[0]!;
    const result = await tool.execute({ path: "/etc/hosts" }, { cwd: "/tmp" });
    expect(result.content).toBe("FILE CONTENTS");
  });

  it("renders multi-block responses by joining text and tagging non-text parts", async () => {
    const mgr = new McpManager({
      factory: factoryReturning({
        x: fakeClient({
          tools: [{ name: "list" }],
          callResponse: {
            content: [
              { type: "text", text: "line one" },
              { type: "image", data: "...", mimeType: "image/png" },
              { type: "text", text: "line three" },
            ],
          },
        }),
      }),
    });
    await mgr.start({ mcpServers: { x: { command: "x" } } });
    const r = await mgr.callTool("mcp__x__list", {});
    expect(r.content).toBe("line one\n[image: image/png]\nline three");
  });

  it("filters tools by allowed list when used through a sub-registry", async () => {
    // Even though the manager itself doesn't filter, this exercises the
    // contract used by allowedToolsOverride: callers can take getTools() and
    // pass only the ones they want into a registry.
    const mgr = new McpManager({
      factory: factoryReturning({
        files: fakeClient({
          tools: [{ name: "read" }, { name: "write" }, { name: "delete" }],
        }),
      }),
    });
    await mgr.start({ mcpServers: { files: { command: "x" } } });
    const allow = new Set(["mcp__files__read"]);
    const filtered = mgr.getTools().filter((t) => allow.has(t.definition.function.name));
    expect(filtered.map((t) => t.definition.function.name)).toEqual(["mcp__files__read"]);
  });
});
