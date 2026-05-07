import React from "react";
import { Box, Text, useStdout } from "ink";
import Spinner from "ink-spinner";
import { theme } from "../theme.js";

export interface HeaderProps {
  email?: string | undefined;
  apiUrl?: string | undefined;
  activeModel?: string | undefined;
  planMode?: boolean;
  /** When true, render an inline spinner so the user can see the model is alive. */
  streaming?: boolean;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return value.slice(0, max - 1) + "…";
}

/**
 * Header is the persistent chrome at the top of the chat. We deliberately
 * keep it visually quiet: a single dim rule line under one row of metadata.
 * Only the brand mark uses the accent color so the user's eye lands on
 * actual content, not the chrome.
 */
export function Header({
  email,
  apiUrl,
  activeModel,
  planMode = false,
  streaming = false,
}: HeaderProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const segCap = Math.max(12, Math.floor(cols / 4));
  const url = truncate(apiUrl ?? "(no server)", segCap);
  const who = truncate(email ?? "signed out", segCap);
  const model = truncate(activeModel ?? "(none)", segCap);
  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexDirection="row" justifyContent="space-between">
        <Box>
          <Text color={theme.accent} bold>
            ● enclo
          </Text>
          {streaming && (
            <Text color={theme.accent}>  <Spinner type="dots" /></Text>
          )}
          <Text color={theme.muted} dimColor>  {url}</Text>
        </Box>
        <Box>
          <Text color={theme.muted} dimColor>{who}  ·  </Text>
          <Text color={theme.muted}>{model}</Text>
        </Box>
      </Box>
      {planMode ? (
        <Box paddingX={1}>
          <Text color={theme.warn} bold>plan mode</Text>
          <Text color={theme.muted} dimColor>  write/exec disabled · shift-tab or /plan to toggle</Text>
        </Box>
      ) : null}
      {/* Subtle separator rule under the chrome */}
      <Box paddingX={1}>
        <Text color={theme.border} dimColor>
          {"─".repeat(Math.max(20, cols - 2))}
        </Text>
      </Box>
    </Box>
  );
}
