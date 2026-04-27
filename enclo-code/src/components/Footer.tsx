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

export interface FooterProps {
  usage: TokenUsageState;
  /** Context window of the active model. Undefined hides the percent. */
  contextLength?: number | undefined;
  /** Optional $/1M token rates. When unset or zero, cost is hidden. */
  costRates?: Partial<CostRates> | undefined;
}

const SEVERITY_COLOR: Record<ContextSeverity, string> = {
  ok: "gray",
  warn: "yellow",
  danger: "red",
};

export function Footer({
  usage,
  contextLength,
  costRates,
}: FooterProps): React.ReactElement | null {
  // Hide entirely until we have a single completed request — avoids a
  // distracting "0 in / 0 out" line on first launch.
  if (usage.requestCount === 0) return null;

  const ctx = computeContextUsed(usage, contextLength);
  const cost =
    costRates !== undefined ? computeCostUsd(usage, costRates) : null;

  return (
    <Box paddingX={1}>
      <Text color="gray">Tokens: </Text>
      <Text color="cyan">{formatTokenCount(usage.promptTokens)}</Text>
      <Text color="gray"> in / </Text>
      <Text color="cyan">{formatTokenCount(usage.completionTokens)}</Text>
      <Text color="gray"> out</Text>
      {ctx && (
        <>
          <Text color="gray"> · ~</Text>
          <Text color={SEVERITY_COLOR[ctx.severity]}>
            {formatPercent(ctx.fraction)}
          </Text>
          <Text color="gray"> context used</Text>
        </>
      )}
      {cost !== null && (
        <>
          <Text color="gray"> · </Text>
          <Text color="green">{formatCostUsd(cost)}</Text>
        </>
      )}
    </Box>
  );
}
