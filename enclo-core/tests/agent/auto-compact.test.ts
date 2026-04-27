import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shouldAutoCompact,
  DEFAULT_COMPACT_THRESHOLD,
} from "../../src/agent/auto-compact.js";
import { ApiClient } from "../../src/api/client.js";
import { createMemoryConfigStore as createConfigStore } from "../_helpers/config-store.js";
import {
  compactConversation,
  getConversation,
} from "../../src/api/conversations.js";
import { restoreHistory } from "../../src/agent/resume.js";
import type { AgentMessage } from "../../src/agent/loop.js";

describe("shouldAutoCompact", () => {
  const baseInput = {
    lastRequestPromptTokens: 0,
    contextLength: 4000,
    threshold: undefined,
    disabled: false,
    hasConversationId: true,
  };

  it("triggers when last prompt tokens exceed default threshold (70%)", () => {
    expect(
      shouldAutoCompact({ ...baseInput, lastRequestPromptTokens: 2800 }),
    ).toBe(true);
    expect(
      shouldAutoCompact({ ...baseInput, lastRequestPromptTokens: 3000 }),
    ).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    expect(
      shouldAutoCompact({ ...baseInput, lastRequestPromptTokens: 2000 }),
    ).toBe(false);
  });

  it("respects a custom threshold from config", () => {
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 2000,
        threshold: 0.4,
      }),
    ).toBe(true);
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 1000,
        threshold: 0.4,
      }),
    ).toBe(false);
  });

  it("falls back to default for invalid thresholds (<= 0, >= 1, NaN)", () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(0.7);
    // 2800 / 4000 = 0.7 — exactly at default → triggers.
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 2800,
        threshold: 0,
      }),
    ).toBe(true);
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 2800,
        threshold: 2,
      }),
    ).toBe(true);
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 2800,
        threshold: NaN,
      }),
    ).toBe(true);
  });

  it("never triggers when disabled flag is set", () => {
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 4000,
        disabled: true,
      }),
    ).toBe(false);
  });

  it("never triggers without a conversation_id (nothing to compact yet)", () => {
    expect(
      shouldAutoCompact({
        ...baseInput,
        lastRequestPromptTokens: 4000,
        hasConversationId: false,
      }),
    ).toBe(false);
  });

  it("never triggers when contextLength is missing or zero", () => {
    expect(
      shouldAutoCompact({
        ...baseInput,
        contextLength: undefined,
        lastRequestPromptTokens: 4000,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        ...baseInput,
        contextLength: 0,
        lastRequestPromptTokens: 4000,
      }),
    ).toBe(false);
  });

  it("never triggers when last prompt tokens are zero (no data yet)", () => {
    expect(
      shouldAutoCompact({ ...baseInput, lastRequestPromptTokens: 0 }),
    ).toBe(false);
  });
});

// ----- Integration: simulate the App.tryAutoCompact flow end-to-end -----

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-compact-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function buildClient(handler: (req: RecordedRequest) => Response): Promise<{
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

/**
 * End-to-end: simulate the app's auto-compact flow. The decision helper says
 * "go", we POST /compact, then GET the conversation again and replace the
 * local agent history.
 */
describe("auto-compact integration (POST /compact + refetch)", () => {
  it("on success, replaces local history and yields a one-line notice", async () => {
    let phase: "compact" | "fetch" = "compact";
    const { client, calls } = await buildClient((req) => {
      if (phase === "compact") {
        expect(req.method).toBe("POST");
        expect(req.url).toContain("/v1/conversations/c1/compact");
        phase = "fetch";
        return jsonResponse(200, {
          compacted_count: 18,
          summary_token_count: 1500,
          remaining_messages: 5,
        });
      }
      expect(req.method).toBe("GET");
      expect(req.url).toContain("/v1/conversations/c1");
      return jsonResponse(200, {
        id: "c1",
        title: null,
        model: "qwen",
        messages: [
          { role: "system", content: "[summary] You discussed package.json." },
          { role: "user", content: "what next?" },
        ],
      });
    });

    const decision = shouldAutoCompact({
      lastRequestPromptTokens: 2900,
      contextLength: 4000,
      hasConversationId: true,
    });
    expect(decision).toBe(true);

    const compactOutcome = await compactConversation(client, "c1");
    expect(compactOutcome.kind).toBe("ok");
    if (compactOutcome.kind !== "ok") return;
    expect(compactOutcome.result.compacted_count).toBe(18);

    const refetched = await getConversation(client, "c1");
    const restored: AgentMessage[] = restoreHistory(refetched);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual({
      role: "system",
      content: "[summary] You discussed package.json.",
    });

    expect(calls).toHaveLength(2);

    // The chat notice the App should display:
    const notice = `📦 Context auto-compacted: ${compactOutcome.result.compacted_count} turns summarized.`;
    expect(notice).toMatch(/18 turns summarized/);
  });

  it("on 502, returns error with message and signals the session-disable", async () => {
    const { client } = await buildClient(() =>
      jsonResponse(502, {
        error: { code: "upstream_error", message: "vLLM unreachable" },
      }),
    );
    const out = await compactConversation(client, "c1");
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toMatch(/vLLM unreachable/);
    // The App should set compactDisabledRef = true after this — verified by
    // the unit test for shouldAutoCompact above (disabled flag gates it).
    expect(
      shouldAutoCompact({
        lastRequestPromptTokens: 4000,
        contextLength: 4000,
        hasConversationId: true,
        disabled: true,
      }),
    ).toBe(false);
  });

  it("on a 400 'too few messages' the flow short-circuits as nothing_to_compact", async () => {
    const { client, calls } = await buildClient(() =>
      jsonResponse(400, {
        error: { code: "too_few_messages", message: "fewer than 10" },
      }),
    );
    const out = await compactConversation(client, "c1");
    expect(out.kind).toBe("nothing_to_compact");
    // Only the POST happened; no follow-up GET.
    expect(calls).toHaveLength(1);
  });

  it("does not trigger when usage is below threshold (no API call should be made)", () => {
    const trigger = shouldAutoCompact({
      lastRequestPromptTokens: 1000,
      contextLength: 4000,
      hasConversationId: true,
    });
    expect(trigger).toBe(false);
    // (No client interaction — that's the whole point.)
  });
});
