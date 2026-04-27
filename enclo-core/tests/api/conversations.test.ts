import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "../../src/api/client.js";
import {
  compactConversation,
  getConversation,
  listConversations,
} from "../../src/api/conversations.js";
import { restoreHistory } from "../../src/agent/resume.js";
import { createMemoryConfigStore as createConfigStore } from "../_helpers/config-store.js";
import type { ConversationDetail } from "../../src/api/schemas.js";

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(handler: (req: RecordedRequest) => Response): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const f: typeof fetch = async (input, init) => {
    let url: string;
    let method: string;
    let bodyText: string | undefined;
    if (input instanceof Request) {
      url = input.url;
      method = (init?.method ?? input.method ?? "GET").toUpperCase();
      try {
        bodyText = await input.clone().text();
        if (bodyText.length === 0) bodyText = undefined;
      } catch {
        bodyText = undefined;
      }
    } else {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String(input);
      method = (init?.method ?? "GET").toUpperCase();
    }
    if (init?.body !== undefined && typeof init.body === "string") {
      bodyText = init.body;
    }
    let body: unknown = undefined;
    if (bodyText !== undefined) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    const rec: RecordedRequest = { url, method, body };
    calls.push(rec);
    return handler(rec);
  };
  return { fetch: f, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-resume-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function authedClient(handler: (req: RecordedRequest) => Response): Promise<{
  client: ApiClient;
  calls: RecordedRequest[];
}> {
  const config = createConfigStore();
  await config.save({
    api_url: "http://srv",
    access_token: "atk",
    refresh_token: "rtk",
  });
  const { fetch: f, calls } = makeFetch(handler);
  const client = new ApiClient({ config, fetch: f });
  return { client, calls };
}

describe("listConversations", () => {
  it("hits GET /v1/conversations and returns the array", async () => {
    const { client, calls } = await authedClient((req) => {
      expect(req.url).toContain("/v1/conversations");
      expect(req.method).toBe("GET");
      return jsonResponse(200, {
        conversations: [
          {
            id: "c1",
            title: "Hello",
            model: "qwen",
            created_at: "2026-04-25T10:00:00Z",
            updated_at: "2026-04-25T11:00:00Z",
            message_count: 4,
            total_prompt_tokens: 1000,
            total_completion_tokens: 200,
          },
        ],
      });
    });
    const list = await listConversations(client);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Hello");
    expect(list[0]?.total_prompt_tokens).toBe(1000);
    expect(calls).toHaveLength(1);
  });

  it("validates new total_* fields as optional (back-compat with older servers)", async () => {
    const { client } = await authedClient(() =>
      jsonResponse(200, {
        conversations: [
          {
            id: "c1",
            title: null,
            model: "qwen",
            created_at: "2026-04-25T10:00:00Z",
            updated_at: "2026-04-25T11:00:00Z",
            message_count: 0,
          },
        ],
      }),
    );
    const list = await listConversations(client);
    expect(list[0]?.total_prompt_tokens).toBeUndefined();
  });
});

describe("getConversation", () => {
  it("URL-encodes the id and parses the detail", async () => {
    const { client, calls } = await authedClient((req) => {
      expect(req.url).toContain("/v1/conversations/abc%20def");
      return jsonResponse(200, {
        id: "abc def",
        title: "x",
        model: "qwen",
        messages: [],
      });
    });
    const detail = await getConversation(client, "abc def");
    expect(detail.id).toBe("abc def");
    expect(calls).toHaveLength(1);
  });
});

describe("restoreHistory — preserves tool_calls and role=tool messages", () => {
  it("converts every message including assistant tool_calls and tool results", () => {
    const detail: ConversationDetail = {
      id: "c1",
      title: null,
      model: "qwen",
      messages: [
        { role: "system", content: "you are enclo." },
        { role: "user", content: "read package.json" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"package.json"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "read_file",
          content: "{\"name\":\"enclo-code\"}",
        },
        { role: "assistant", content: "It's the enclo-code package." },
      ],
    };
    const out = restoreHistory(detail);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ role: "system", content: "you are enclo." });
    expect(out[1]).toEqual({ role: "user", content: "read package.json" });
    expect(out[2]).toMatchObject({
      role: "assistant",
      content: "",
    });
    expect(out[2]).toHaveProperty("tool_calls");
    const asAssistant = out[2] as {
      role: "assistant";
      tool_calls: { id: string; function: { name: string } }[];
    };
    expect(asAssistant.tool_calls).toHaveLength(1);
    expect(asAssistant.tool_calls[0]?.id).toBe("call_1");
    expect(asAssistant.tool_calls[0]?.function.name).toBe("read_file");
    expect(out[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      name: "read_file",
      content: '{"name":"enclo-code"}',
    });
    expect(out[4]).toEqual({
      role: "assistant",
      content: "It's the enclo-code package.",
    });
  });

  it("drops malformed tool messages (missing tool_call_id) without crashing", () => {
    const detail: ConversationDetail = {
      id: "c1",
      model: "qwen",
      messages: [
        { role: "user", content: "hi" },
        // Bogus tool message — no tool_call_id, no name.
        { role: "tool", content: "garbage" },
        { role: "assistant", content: "ok" },
      ],
    };
    const out = restoreHistory(detail);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });

  it("preserves multi-modal user content blocks for vision-capable models", () => {
    const detail: ConversationDetail = {
      id: "c1",
      model: "qwen-vl",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,xxx" },
            },
          ],
        },
      ],
    };
    const out = restoreHistory(detail);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,xxx" },
        },
      ],
    });
  });
});

describe("compactConversation", () => {
  it("returns ok with compact stats on success", async () => {
    const { client } = await authedClient((req) => {
      expect(req.url).toContain("/v1/conversations/c1/compact");
      expect(req.method).toBe("POST");
      return jsonResponse(200, {
        compacted_count: 12,
        summary_token_count: 500,
        remaining_messages: 4,
      });
    });
    const out = await compactConversation(client, "c1");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.result.compacted_count).toBe(12);
    expect(out.result.remaining_messages).toBe(4);
  });

  it("returns nothing_to_compact on a 400 (fewer than 10 messages)", async () => {
    const { client } = await authedClient(() =>
      jsonResponse(400, {
        error: { code: "too_few_messages", message: "fewer than 10" },
      }),
    );
    const out = await compactConversation(client, "c1");
    expect(out.kind).toBe("nothing_to_compact");
  });

  it("returns error on a 502 (with the upstream message)", async () => {
    const { client } = await authedClient(() =>
      jsonResponse(502, {
        error: { code: "upstream_error", message: "vLLM unreachable" },
      }),
    );
    const out = await compactConversation(client, "c1");
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toMatch(/vLLM unreachable/);
  });
});
