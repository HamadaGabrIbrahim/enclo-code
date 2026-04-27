import { ApiClient } from "./client.js";
import { parseSseStream, type ParsedEvent } from "./sse.js";

import type { ChatMessageContent } from "./schemas.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatMessageContent;
}

export interface ChatStreamArgs {
  model: string;
  messages: ChatMessage[];
  conversation_id: string | null;
  temperature?: number;
  max_tokens?: number;
}

/**
 * POST /v1/chat/completions and stream parsed events. Yields events from the
 * SSE body. Caller is responsible for handling `done`/`malformed`/error events.
 */
export async function* streamChat(
  client: ApiClient,
  args: ChatStreamArgs,
): AsyncGenerator<ParsedEvent, void, void> {
  const body = {
    model: args.model,
    messages: args.messages,
    conversation_id: args.conversation_id,
    stream: true,
    temperature: args.temperature ?? 0.7,
    max_tokens: args.max_tokens ?? 2048,
  };
  const resp = await client.requestStream("post", "v1/chat/completions", body);
  if (!resp.body) {
    throw new Error("server returned no body for /v1/chat/completions");
  }
  yield* parseSseStream(resp.body);
}
