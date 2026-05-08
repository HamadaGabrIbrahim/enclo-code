import React from "react";
import { Box, Text } from "ink";
import {
  computeContextUsed,
  computeCostUsd,
  formatCostUsd,
  formatPercent,
  formatTokenCount,
  type ContextSeverity,
  type CostRates,
  type TokenUsageState,
} from "@enclo/core";
import { theme } from "../theme.js";

export interface FooterProps {
  usage: TokenUsageState;
  /** Context window of the active model. Undefined hides the percent. */
  contextLength?: number | undefined;
  /** Optional $/1M token rates. When unset or zero, cost is hidden. */
  costRates?: Partial<CostRates> | undefined;
}

const SEVERITY_COLOR: Record<ContextSeverity, string> = {
  ok: theme.muted,
  warn: theme.warn,
  danger: theme.error,
};

/**
 * One-line metadata strip below the input. Single dim color throughout
 * except for the (rare) warn/danger context-fill state. Numbers themselves
 * are rendered in normal weight so they're scannable.
 */
function FooterImpl({
  usage,
  contextLength,
  costRates,
}: FooterProps): React.ReactElement | null {
  if (usage.requestCount === 0) return null;

  const ctx = computeContextUsed(usage, contextLength);
  const cost =
    costRates !== undefined ? computeCostUsd(usage, costRates) : null;

  return (
    <Box paddingX={1}>
      <Text color={theme.muted} dimColor>
        {formatTokenCount(usage.promptTokens)} in · {formatTokenCount(usage.completionTokens)} out
        {ctx ? "  " : ""}
      </Text>
      {ctx && ctx.severity !== "ok" ? (
        <Text color={SEVERITY_COLOR[ctx.severity]}>
          {formatPercent(ctx.fraction)} ctx
        </Text>
      ) : ctx ? (
        <Text color={theme.muted} dimColor>
          {formatPercent(ctx.fraction)} ctx
        </Text>
      ) : null}
      {cost !== null && (
        <Text color={theme.muted} dimColor>
          {"  · "}{formatCostUsd(cost)}
        </Text>
      )}
    </Box>
  );
}

export const Footer = React.memo(FooterImpl);
