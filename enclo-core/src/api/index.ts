export { ApiClient, ApiError, AuthError } from "./client.js";
export type { ApiClientOptions } from "./client.js";

export { signup, signin, signout, fetchMe } from "./auth.js";

export { listModels } from "./models.js";

export { streamChat } from "./chat.js";
export type { ChatMessage, ChatStreamArgs } from "./chat.js";

export {
  listConversations,
  getConversation,
  getConversationUsage,
  compactConversation,
} from "./conversations.js";
export type { CompactOutcome } from "./conversations.js";

export { parseSseRecord, parseSseStream } from "./sse.js";
export type { ParsedEvent } from "./sse.js";

export {
  // Schemas
  UserSchema,
  TokenPairSchema,
  ModelSchema,
  ModelsResponseSchema,
  ToolCallSchema,
  StoredMessageSchema,
  ConversationSummarySchema,
  ConversationsListResponseSchema,
  ConversationDetailSchema,
  CompactResponseSchema,
  UsageResponseSchema,
  ErrorEnvelopeSchema,
  StartEventSchema,
  DeltaEventSchema,
  ToolCallDeltaSchema,
  EndEventSchema,
  StreamErrorEventSchema,
  StreamEventSchema,
  ChatMessageContentSchema,
  ContentBlockSchema,
  TextContentBlockSchema,
  ImageUrlContentBlockSchema,
} from "./schemas.js";
export type {
  EncloUser,
  TokenPair,
  Model,
  ConversationSummary,
  ConversationDetail,
  CompactResponse,
  UsageResponse,
  ErrorEnvelope,
  StreamEvent,
  ToolCallDeltaEvent,
  StoredMessage,
  ContentBlock,
  ChatMessageContent,
} from "./schemas.js";
