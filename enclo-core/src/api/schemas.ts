import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable().optional(),
});
export type EncloUser = z.infer<typeof UserSchema>;

// ---- Multi-modal chat content ----

export const TextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export const ImageUrlContentBlockSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});
export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextContentBlockSchema,
  ImageUrlContentBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Chat message content: either a plain string or a list of typed blocks. */
export const ChatMessageContentSchema = z.union([
  z.string(),
  z.array(ContentBlockSchema),
]);
export type ChatMessageContent = z.infer<typeof ChatMessageContentSchema>;

export const TokenPairSchema = z.object({
  user: UserSchema,
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("bearer"),
  expires_in: z.number(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const ModelSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  context_length: z.number(),
  available: z.boolean(),
});
export const ModelsResponseSchema = z.object({
  models: z.array(ModelSchema),
});
export type Model = z.infer<typeof ModelSchema>;

// ---- Conversations / usage / compaction ----

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * Server-shaped conversation message. `content` may be a plain string (text-only
 * message) or an array of multi-modal blocks for messages persisted with
 * `content_parts`. Assistant messages may carry `tool_calls`; messages with
 * role="tool" carry `tool_call_id` and `name`.
 */
export const StoredMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: ChatMessageContentSchema,
  created_at: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  model: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  message_count: z.number().int().nonnegative(),
  total_prompt_tokens: z.number().int().nonnegative().optional(),
  total_completion_tokens: z.number().int().nonnegative().optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationsListResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});

export const ConversationDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  model: z.string(),
  messages: z.array(StoredMessageSchema),
  total_prompt_tokens: z.number().int().nonnegative().optional(),
  total_completion_tokens: z.number().int().nonnegative().optional(),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

export const CompactResponseSchema = z.object({
  compacted_count: z.number().int().nonnegative(),
  summary_token_count: z.number().int().nonnegative(),
  remaining_messages: z.number().int().nonnegative(),
});
export type CompactResponse = z.infer<typeof CompactResponseSchema>;

export const UsageResponseSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  message_count: z.number().int().nonnegative(),
  oldest_message_at: z.string().nullable().optional(),
  newest_message_at: z.string().nullable().optional(),
  estimated_context_used: z.number().nonnegative().optional(),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// SSE event payloads
export const StartEventSchema = z.object({
  type: z.literal("start"),
  conversation_id: z.string(),
  message_id: z.string(),
});
export const DeltaEventSchema = z.object({
  type: z.literal("delta"),
  content: z.string(),
});

/**
 * Streamed function-call delta. The server may emit several of these per
 * turn — one per tool call, possibly multiple times per call as the model
 * accumulates the JSON arguments. `index` identifies the call within the turn.
 */
export const ToolCallDeltaSchema = z.object({
  type: z.literal("tool_call_delta"),
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
});

export const EndEventSchema = z.object({
  type: z.literal("end"),
  finish_reason: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});
export const StreamErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  StartEventSchema,
  DeltaEventSchema,
  ToolCallDeltaSchema,
  EndEventSchema,
  StreamErrorEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaSchema>;
