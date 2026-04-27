import { ApiClient, ApiError } from "./client.js";
import {
  CompactResponseSchema,
  ConversationDetailSchema,
  ConversationsListResponseSchema,
  UsageResponseSchema,
  type CompactResponse,
  type ConversationDetail,
  type ConversationSummary,
  type UsageResponse,
} from "./schemas.js";

export async function listConversations(
  client: ApiClient,
): Promise<ConversationSummary[]> {
  const resp = await client.request(
    "get",
    "v1/conversations",
    ConversationsListResponseSchema,
  );
  return resp.conversations;
}

export async function getConversation(
  client: ApiClient,
  id: string,
): Promise<ConversationDetail> {
  return client.request(
    "get",
    `v1/conversations/${encodeURIComponent(id)}`,
    ConversationDetailSchema,
  );
}

export async function getConversationUsage(
  client: ApiClient,
  id: string,
): Promise<UsageResponse> {
  return client.request(
    "get",
    `v1/conversations/${encodeURIComponent(id)}/usage`,
    UsageResponseSchema,
  );
}

export type CompactOutcome =
  | { kind: "ok"; result: CompactResponse }
  | { kind: "nothing_to_compact" }
  | { kind: "error"; message: string };

/**
 * Compact a conversation server-side. Treats HTTP 400 as a soft "nothing to
 * compact" signal (the backend returns 400 when fewer than 10 messages
 * exist) so the caller doesn't need to distinguish that from a real failure.
 */
export async function compactConversation(
  client: ApiClient,
  id: string,
): Promise<CompactOutcome> {
  try {
    const result = await client.request(
      "post",
      `v1/conversations/${encodeURIComponent(id)}/compact`,
      CompactResponseSchema,
    );
    return { kind: "ok", result };
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      return { kind: "nothing_to_compact" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", message };
  }
}
