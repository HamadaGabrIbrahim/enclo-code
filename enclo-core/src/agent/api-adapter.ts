import type { ApiClient } from "../api/client.js";
import { parseSseStream } from "../api/sse.js";
import type { ApiAdapter, ChatRequest, ChatStream, StreamEvent, AgentMessage } from "./loop.js";
import type { ChatMessage } from "../api/chat.js";

export interface CreateAdapterOptions {
  client: ApiClient;
  model: string;
  conversationIdRef: { current: string | null };
  temperature?: number;
  maxTokens?: number;
}

/**
 * Wire the existing /v1/chat/completions SSE endpoint into the agent loop's
 * `ApiAdapter` shape. Includes tools in the request body and translates
 * `tool_call_delta` server events into the loop's StreamEvent union.
 */
export function createApiAdapter(opts: CreateAdapterOptions): ApiAdapter {
  return {
    async streamChat(req: ChatRequest): Promise<ChatStream> {
      const wireMessages = req.messages.map(toWireMessage);
      const body = {
        model: opts.model,
        messages: wireMessages,
        conversation_id: opts.conversationIdRef.current,
        stream: true,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        tools: req.tools,
      };
      const resp = await opts.client.requestStream("post", "v1/chat/completions", body);
      if (!resp.body) throw new Error("server returned no body for /v1/chat/completions");
      return { events: translate(parseSseStream(resp.body), opts.conversationIdRef) };
    },
  };
}

async function* translate(
  source: AsyncIterable<import("../api/sse.js").ParsedEvent>,
  convoRef: { current: string | null },
): AsyncGenerator<StreamEvent, void, void> {
  for await (const ev of source) {
    if (ev.kind === "done") return;
    if (ev.kind === "malformed") continue;
    const e = ev.event;
    if (e.type === "start") {
      convoRef.current = e.conversation_id;
    } else if (e.type === "delta") {
      yield { type: "delta", content: e.content };
    } else if (e.type === "tool_call_delta") {
      const out: StreamEvent = { type: "tool_call_delta", index: e.index };
      if (e.id !== undefined) out.id = e.id;
      if (e.name !== undefined) out.name = e.name;
      if (e.arguments !== undefined) out.arguments = e.arguments;
      yield out;
    } else if (e.type === "end") {
      const out: StreamEvent = { type: "end", finishReason: e.finish_reason ?? "stop" };
      if (e.usage) out.usage = e.usage;
      yield out;
    } else if (e.type === "error") {
      yield { type: "error", message: `${e.code}: ${e.message}` };
    }
  }
}

/**
 * Translate an AgentMessage into the wire shape sent to the server. The
 * server sees an OpenAI-flavored chat/completions schema; tool messages
 * use role="tool" with tool_call_id. User content may be a string or a
 * list of multi-modal blocks (text + images).
 */
function toWireMessage(m: AgentMessage): ChatMessage | Record<string, unknown> {
  if (m.role === "system") return { role: m.role, content: m.content };
  if (m.role === "user") return { role: m.role, content: m.content };
  if (m.role === "assistant") {
    const out: Record<string, unknown> = { role: "assistant", content: m.content };
    if (m.tool_calls && m.tool_calls.length > 0) out["tool_calls"] = m.tool_calls;
    return out;
  }
  return { role: "tool", tool_call_id: m.tool_call_id, name: m.name, content: m.content };
}
