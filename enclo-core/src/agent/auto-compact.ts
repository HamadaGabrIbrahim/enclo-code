/** Default fraction of context window after which auto-compaction triggers. */
export const DEFAULT_COMPACT_THRESHOLD = 0.7;

export interface CompactDecisionInput {
  /** prompt_tokens of the most recent request. */
  lastRequestPromptTokens: number;
  /** Active model's context window. */
  contextLength: number | undefined;
  /** Override threshold (config.json `compact_threshold`). */
  threshold?: number | undefined;
  /** True when a prior compact attempt failed and we've disabled for the session. */
  disabled?: boolean;
  /** True when a conversation_id is set (we can only compact existing convos). */
  hasConversationId: boolean;
}

/**
 * Decide whether to fire POST /compact after a turn. Pulled out as a pure
 * function so it's trivially testable and the App stays a thin orchestrator.
 */
export function shouldAutoCompact(input: CompactDecisionInput): boolean {
  if (input.disabled) return false;
  if (!input.hasConversationId) return false;
  if (!input.contextLength || input.contextLength <= 0) return false;
  if (input.lastRequestPromptTokens <= 0) return false;
  const t = clampThreshold(input.threshold);
  return input.lastRequestPromptTokens / input.contextLength >= t;
}

function clampThreshold(t: number | undefined): number {
  if (t === undefined || !Number.isFinite(t)) return DEFAULT_COMPACT_THRESHOLD;
  if (t <= 0 || t >= 1) return DEFAULT_COMPACT_THRESHOLD;
  return t;
}
