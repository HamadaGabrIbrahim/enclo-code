/**
 * Per-session token-usage tracking. Updated on every `end` SSE event from
 * /v1/chat/completions. Pure helpers — the App component owns the state and
 * passes it through to the Footer/Header for display.
 */

export interface TokenUsage {
  /** Total prompt tokens charged across the session. */
  promptTokens: number;
  /** Total completion tokens charged across the session. */
  completionTokens: number;
  /** Number of completed model requests since last reset. */
  requestCount: number;
}

export interface TokenUsageState extends TokenUsage {
  /**
   * prompt_tokens of the most recent request — used to compute "context
   * used" because that figure represents the size of the conversation just
   * sent in (history + tools + new user message).
   */
  lastRequestPromptTokens: number;
}

export const EMPTY_USAGE: TokenUsageState = {
  promptTokens: 0,
  completionTokens: 0,
  requestCount: 0,
  lastRequestPromptTokens: 0,
};

/** Add an SSE end-event usage payload to the running totals. */
export function addUsage(
  prev: TokenUsageState,
  delta: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined } | undefined,
): TokenUsageState {
  if (!delta) return prev;
  const p = delta.prompt_tokens ?? 0;
  const c = delta.completion_tokens ?? 0;
  // Backends sometimes emit a final usage event with both fields zero (or
  // omitted). Don't bump requestCount in that case.
  if (p === 0 && c === 0) return prev;
  return {
    promptTokens: prev.promptTokens + p,
    completionTokens: prev.completionTokens + c,
    requestCount: prev.requestCount + 1,
    lastRequestPromptTokens: p > 0 ? p : prev.lastRequestPromptTokens,
  };
}

export type ContextSeverity = "ok" | "warn" | "danger";

/**
 * Compute the "% context used" figure shown in the footer:
 * lastRequestPromptTokens / activeModel.context_length, clamped to [0, 1].
 * Returns null when we have no data yet (no requests, or context_length missing).
 */
export function computeContextUsed(
  state: TokenUsageState,
  contextLength: number | undefined,
): { fraction: number; severity: ContextSeverity } | null {
  if (!contextLength || contextLength <= 0) return null;
  if (state.lastRequestPromptTokens <= 0) return null;
  const raw = state.lastRequestPromptTokens / contextLength;
  const fraction = Math.max(0, Math.min(1, raw));
  return { fraction, severity: severityFor(fraction) };
}

export function severityFor(fraction: number): ContextSeverity {
  if (fraction > 0.8) return "danger";
  if (fraction > 0.6) return "warn";
  return "ok";
}

export interface CostRates {
  promptPerMillion: number;
  completionPerMillion: number;
}

/** Optional cost display: only enabled when BOTH rates are present and > 0. */
export function computeCostUsd(
  state: TokenUsage,
  rates: Partial<CostRates>,
): number | null {
  const p = rates.promptPerMillion;
  const c = rates.completionPerMillion;
  if (p === undefined || c === undefined) return null;
  if (p <= 0 || c <= 0) return null;
  return (
    (state.promptTokens / 1_000_000) * p +
    (state.completionTokens / 1_000_000) * c
  );
}

/**
 * Compact token-count formatter for the footer:
 *   < 10_000      → "1,234"
 *   < 1_000_000   → "12.3k"
 *   ≥ 1_000_000   → "1.2M"
 * Round half-down to keep visual width stable as the count climbs.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const v = Math.round(n);
  if (v < 10_000) return v.toLocaleString("en-US");
  if (v < 1_000_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "$1.23" / "$0.0023" — pick a sensible precision for tiny numbers. */
export function formatCostUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

/** "67%" — rounded to nearest integer. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
