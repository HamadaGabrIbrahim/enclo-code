import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JsonRpcServer,
  RPC_ERROR_INVALID_PARAMS,
  RPC_ERROR_METHOD_NOT_FOUND,
} from "../../src/rpc/server.js";
import { writeMessage, parseStream, type JsonRpcMessage } from "../../src/rpc/framing.js";
import { createMemoryConfigStore } from "../../src/rpc/in-memory-config.js";
import {
  ApiClient,
  type ConfigStore,
  type EncloConfig,
} from "@enclo/core";

class CapturingWritable extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    cb();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

/**
 * Build a fake fetch that lets the test stub responses keyed by `${METHOD} <pathRegex>`.
 * Records every call into `requests`.
 */
function makeFakeFetch(
  responders: Array<{ method: string; pathRegex: RegExp; respond: (req: RecordedRequest) => Promise<Response> | Response }>,
  requests: RecordedRequest[],
): typeof fetch {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    let method: string;
    let bodyText: string | undefined;
    const headers: Record<string, string> = {};
    if (input instanceof Request) {
      url = input.url;
      method = input.method.toUpperCase();
      try {
        bodyText = await input.clone().text();
      } catch {
        bodyText = undefined;
      }
      input.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else {
      url = typeof input === "string" ? input : input.toString();
      method = (init?.method ?? "GET").toUpperCase();
      if (init?.body && typeof init.body === "string") {
        bodyText = init.body;
      }
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
      }
    }
    let body: unknown = undefined;
    if (bodyText !== undefined && bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    const req: RecordedRequest = { method, url, headers };
    if (body !== undefined) req.body = body;
    requests.push(req);
    for (const r of responders) {
      if (method === r.method && r.pathRegex.test(url)) {
        return await r.respond(req);
      }
    }
    return new Response("not stubbed", { status: 500 });
  };
}

function makeApiClient(config: ConfigStore, fakeFetch: typeof fetch): ApiClient {
  return new ApiClient({ config, fetch: fakeFetch });
}

interface DriverHandle {
  send: (msg: JsonRpcMessage) => void;
  receive: () => Promise<JsonRpcMessage>;
  receiveAll: (n: number) => Promise<JsonRpcMessage[]>;
  close: () => void;
  serverDone: Promise<void>;
}

function startServer(opts: {
  config?: ConfigStore;
  cwd?: string;
  apiClientFactory?: (cfg: ConfigStore) => ApiClient;
}): DriverHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const server = new JsonRpcServer({
    input: stdin,
    output: stdout,
    errorOutput: stderr,
    skipDiscovery: true,
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.apiClientFactory ? { apiClientFactory: opts.apiClientFactory } : {}),
  });
  const serverDone = server.run();

  const reader = parseStream(stdout)[Symbol.asyncIterator]();

  return {
    send(msg) {
      writeMessage(stdin, msg);
    },
    async receive() {
      const next = await reader.next();
      if (next.done) throw new Error("server output closed");
      return next.value;
    },
    async receiveAll(n) {
      const out: JsonRpcMessage[] = [];
      for (let i = 0; i < n; i += 1) {
        const next = await reader.next();
        if (next.done) throw new Error("server output closed");
        out.push(next.value);
      }
      return out;
    },
    close() {
      stdin.end();
    },
    serverDone,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-rpc-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("JsonRpcServer — auth methods", () => {
  it("signin posts to /auth/signin and persists tokens", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test" },
    });
    const requests: RecordedRequest[] = [];
    const fakeFetch = makeFakeFetch(
      [
        {
          method: "POST",
          pathRegex: /\/auth\/signin$/,
          respond: () =>
            new Response(
              JSON.stringify({
                user: { id: "u1", email: "a@b.com" },
                access_token: "atk",
                refresh_token: "rtk",
                token_type: "bearer",
                expires_in: 1800,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      ],
      requests,
    );

    const driver = startServer({
      config,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });

    driver.send({
      jsonrpc: "2.0",
      id: 1,
      method: "signin",
      params: { email: "a@b.com", password: "pw12345678" },
    });
    const resp = await driver.receive();
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        access_token: "atk",
        refresh_token: "rtk",
        user: { id: "u1", email: "a@b.com" },
      },
    });
    expect(requests[0]?.body).toEqual({ email: "a@b.com", password: "pw12345678" });
    const cfg = await config.load();
    expect(cfg.access_token).toBe("atk");

    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("signin maps domain errors (invalid credentials) to JSON-RPC error 1001", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test" },
    });
    const fakeFetch = makeFakeFetch(
      [
        {
          method: "POST",
          pathRegex: /\/auth\/signin$/,
          respond: () =>
            new Response(
              JSON.stringify({ error: { code: "invalid_credentials", message: "bad email or password" } }),
              { status: 401, headers: { "content-type": "application/json" } },
            ),
        },
      ],
      [],
    );
    const driver = startServer({
      config,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });
    driver.send({
      jsonrpc: "2.0",
      id: 1,
      method: "signin",
      params: { email: "a@b.com", password: "wrong" },
    });
    const resp = await driver.receive();
    expect((resp as { error: { code: number; data: { error_code: string } } }).error.code).toBe(1001);
    expect((resp as { error: { data: { error_code: string } } }).error.data.error_code).toBe("invalid_credentials");

    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("JsonRpcServer — models + active model", () => {
  it("listModels and setActiveModel/getActiveModel round-trip", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test", access_token: "atk" },
    });
    const fakeFetch = makeFakeFetch(
      [
        {
          method: "GET",
          pathRegex: /\/v1\/models$/,
          respond: () =>
            new Response(
              JSON.stringify({
                models: [
                  { id: "llama", display_name: "L", context_length: 8192, available: true },
                  { id: "qwen", display_name: "Q", context_length: 32768, available: true },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      ],
      [],
    );
    const driver = startServer({
      config,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });

    driver.send({ jsonrpc: "2.0", id: 1, method: "listModels", params: {} });
    const list = await driver.receive();
    expect((list as { result: { models: { id: string }[] } }).result.models).toHaveLength(2);

    driver.send({ jsonrpc: "2.0", id: 2, method: "setActiveModel", params: { id: "qwen" } });
    const setResp = await driver.receive();
    expect((setResp as { result: { ok: boolean } }).result.ok).toBe(true);

    driver.send({ jsonrpc: "2.0", id: 3, method: "getActiveModel", params: {} });
    const getResp = await driver.receive();
    expect((getResp as { result: { id: string } }).result.id).toBe("qwen");

    driver.send({ jsonrpc: "2.0", id: 4, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("JsonRpcServer — error handling", () => {
  it("returns method not found for unknown methods", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "nonexistent", params: {} });
    const resp = await driver.receive();
    expect((resp as { error: { code: number } }).error.code).toBe(RPC_ERROR_METHOD_NOT_FOUND);
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("returns invalid params when required fields are missing", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "signin", params: { email: "a@b.com" } });
    const resp = await driver.receive();
    expect((resp as { error: { code: number } }).error.code).toBe(RPC_ERROR_INVALID_PARAMS);
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("JsonRpcServer — streamChat", () => {
  it("emits agent.event notifications and a final response", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test", access_token: "atk", active_model: "llama" },
    });
    // SSE stream: a delta then end.
    const sseBody = [
      'data: {"type":"start","conversation_id":"c1","message_id":"m1"}\n\n',
      'data: {"type":"delta","content":"Hello"}\n\n',
      'data: {"type":"delta","content":" world"}\n\n',
      'data: {"type":"end","finish_reason":"stop","usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const fakeFetch = makeFakeFetch(
      [
        {
          method: "POST",
          pathRegex: /\/v1\/chat\/completions$/,
          respond: () =>
            new Response(sseBody, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
        },
      ],
      [],
    );
    const driver = startServer({
      config,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });

    driver.send({
      jsonrpc: "2.0",
      id: 1,
      method: "streamChat",
      params: { userInput: "hi" },
    });

    const events: JsonRpcMessage[] = [];
    let finalResponse: JsonRpcMessage | null = null;
    while (!finalResponse) {
      const next = await driver.receive();
      if ("id" in next && next.id === 1) {
        finalResponse = next;
      } else {
        events.push(next);
      }
    }
    expect(finalResponse).toMatchObject({ id: 1, result: null });
    const eventTypes = events
      .filter((e): e is { jsonrpc: "2.0"; method: string; params: { type: string } } => "method" in e && (e as { method: string }).method === "agent.event")
      .map((e) => e.params.type);
    expect(eventTypes).toContain("assistant_text");
    expect(eventTypes).toContain("turn_complete");
    expect(eventTypes).toContain("agent_done");
    const doneNotifications = events.filter(
      (e): e is { jsonrpc: "2.0"; method: "agent.done" } => "method" in e && (e as { method: string }).method === "agent.done",
    );
    expect(doneNotifications.length).toBe(1);

    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("rejects streamChat with no active model", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test", access_token: "atk" },
    });
    const fakeFetch = makeFakeFetch([], []);
    const driver = startServer({
      config,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "streamChat", params: { userInput: "x" } });
    const resp = await driver.receive();
    expect((resp as { error: { data: { error_code: string } } }).error.data.error_code).toBe("no_active_model");
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("JsonRpcServer — permissions flow", () => {
  it("snapshot returns the empty session state initially", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "permissions.snapshot", params: {} });
    const resp = await driver.receive();
    const snap = (resp as { result: { tools: string[]; sessionAllows: unknown[] } }).result;
    expect(snap.tools).toEqual([]);
    expect(snap.sessionAllows).toEqual([]);
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("permissions.add session-scoped allow takes effect", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({
      jsonrpc: "2.0",
      id: 1,
      method: "permissions.add",
      params: { tool: "bash", scope: "session", effect: "allow" },
    });
    const r1 = await driver.receive();
    expect((r1 as { result: { ok: boolean } }).result.ok).toBe(true);

    driver.send({ jsonrpc: "2.0", id: 2, method: "permissions.snapshot", params: {} });
    const r2 = await driver.receive();
    const snap = (r2 as { result: { tools: string[] } }).result;
    expect(snap.tools).toContain("bash");

    driver.send({ jsonrpc: "2.0", id: 3, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("end-to-end permission prompt: streamChat triggers a prompt that respondToPrompt resolves", async () => {
    const config = createMemoryConfigStore({
      initial: { api_url: "http://api.test", access_token: "atk", active_model: "llama" },
    });
    // Two completions:
    //  1. assistant emits a tool_call to write_file (requires permission)
    //  2. after the tool result is fed back, assistant says "done"
    let turn = 0;
    const fakeFetch = makeFakeFetch(
      [
        {
          method: "POST",
          pathRegex: /\/v1\/chat\/completions$/,
          respond: () => {
            turn += 1;
            if (turn === 1) {
              const body = [
                'data: {"type":"start","conversation_id":"c1","message_id":"m1"}\n\n',
                'data: {"type":"tool_call_delta","index":0,"id":"call_1","name":"write_file","arguments":"{\\"path\\":\\"' + path.join(tmpDir, "out.txt").replace(/\\/g, "\\\\") + '\\",\\"content\\":\\"hi\\"}"}\n\n',
                'data: {"type":"end","finish_reason":"tool_calls","usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
                "data: [DONE]\n\n",
              ].join("");
              return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
            }
            const body = [
              'data: {"type":"start","conversation_id":"c1","message_id":"m2"}\n\n',
              'data: {"type":"delta","content":"done"}\n\n',
              'data: {"type":"end","finish_reason":"stop","usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
              "data: [DONE]\n\n",
            ].join("");
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
          },
        },
      ],
      [],
    );
    const driver = startServer({
      config,
      cwd: tmpDir,
      apiClientFactory: (cfg) => makeApiClient(cfg, fakeFetch),
    });

    driver.send({ jsonrpc: "2.0", id: 1, method: "streamChat", params: { userInput: "write hi" } });

    // Drain notifications until we see permission_prompt; respond; then drain to final.
    let promptId: string | undefined;
    let finalResponse: JsonRpcMessage | null = null;
    let respondSent = false;
    while (!finalResponse) {
      const next = await driver.receive();
      if ("id" in next && next.id === 1) {
        finalResponse = next;
        break;
      }
      const m = next as { method?: string; params?: unknown };
      if (m.method === "permission_prompt" && !respondSent) {
        promptId = (m.params as { prompt_id: string }).prompt_id;
        respondSent = true;
        driver.send({
          jsonrpc: "2.0",
          id: 2,
          method: "permissions.respondToPrompt",
          params: { prompt_id: promptId, choice: "allow_once" },
        });
      } else if ("id" in next && next.id === 2) {
        // ignore the respondToPrompt ack
      }
    }
    expect(promptId).toBeDefined();
    expect(finalResponse).toMatchObject({ id: 1, result: null });

    driver.send({ jsonrpc: "2.0", id: 99, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("respondToPrompt with unknown id returns a domain error", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({
      jsonrpc: "2.0",
      id: 1,
      method: "permissions.respondToPrompt",
      params: { prompt_id: "nope", choice: "allow_once" },
    });
    const resp = await driver.receive();
    expect((resp as { error: { data: { error_code: string } } }).error.data.error_code).toBe("unknown_prompt");
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("JsonRpcServer — attachImage + setCwd + discovery", () => {
  it("attachImage returns a base64 data URL", async () => {
    // Create a tiny PNG-like buffer (header + nothing — content doesn't have to be valid PNG;
    // we only check the base64-encoded round-trip).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const file = path.join(tmpDir, "tiny.png");
    await fs.writeFile(file, png);
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "attachImage", params: { path: file } });
    const resp = await driver.receive();
    const r = (resp as { result: { base64_data_url: string; name: string; size_bytes: number } }).result;
    expect(r.name).toBe("tiny.png");
    expect(r.size_bytes).toBe(png.length);
    expect(r.base64_data_url.startsWith("data:image/png;base64,")).toBe(true);
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("setCwd switches the working directory used for discovery", async () => {
    const sub = path.join(tmpDir, "proj");
    await fs.mkdir(sub, { recursive: true });
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
      cwd: tmpDir,
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "setCwd", params: { path: sub } });
    const resp = await driver.receive();
    expect((resp as { result: { ok: boolean; cwd: string } }).result).toEqual({ ok: true, cwd: sub });
    driver.send({ jsonrpc: "2.0", id: 2, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });

  it("listCustomCommands and listSubagents return empty arrays when none discovered", async () => {
    const driver = startServer({
      config: createMemoryConfigStore({ initial: { api_url: "http://api.test" } }),
    });
    driver.send({ jsonrpc: "2.0", id: 1, method: "listCustomCommands", params: {} });
    const r1 = await driver.receive();
    expect((r1 as { result: { commands: unknown[] } }).result.commands).toEqual([]);

    driver.send({ jsonrpc: "2.0", id: 2, method: "listSubagents", params: {} });
    const r2 = await driver.receive();
    expect((r2 as { result: { subagents: unknown[] } }).result.subagents).toEqual([]);

    driver.send({ jsonrpc: "2.0", id: 3, method: "exit", params: {} });
    await driver.receive();
    driver.close();
    await driver.serverDone;
  });
});

describe("createMemoryConfigStore", () => {
  it("seeds from a file path when present", async () => {
    const file = path.join(tmpDir, "rpc-cfg.json");
    const seed: EncloConfig = { api_url: "http://seeded.test", active_model: "llama" };
    await fs.writeFile(file, JSON.stringify(seed));
    const store = createMemoryConfigStore({ filePath: file });
    const loaded = await store.load();
    expect(loaded.api_url).toBe("http://seeded.test");
    expect(loaded.active_model).toBe("llama");
  });

  it("update merges and persists when filePath set", async () => {
    const file = path.join(tmpDir, "rpc-cfg.json");
    const store = createMemoryConfigStore({ filePath: file });
    await store.update({ api_url: "http://x" });
    await store.update({ active_model: "qwen" });
    const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as EncloConfig;
    expect(onDisk.api_url).toBe("http://x");
    expect(onDisk.active_model).toBe("qwen");
  });
});
