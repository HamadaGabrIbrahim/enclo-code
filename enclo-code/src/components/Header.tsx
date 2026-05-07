import React from "react";
import { Box, Text, useStdout } from "ink";
import Spinner from "ink-spinner";

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

export function Header({
  email,
  apiUrl,
  activeModel,
  planMode = false,
  streaming = false,
}: HeaderProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  // Reserve about half the line for the right side; cap each segment so the
  // header never wraps in narrow terminals.
  const segCap = Math.max(12, Math.floor(cols / 4));
  const url = truncate(apiUrl ?? "(no server)", segCap);
  const who = truncate(email ?? "signed out", segCap);
  const model = truncate(activeModel ?? "(none)", segCap);
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Box>
          <Text color="cyan" bold>
            enclo
          </Text>
          {streaming && (
            <Text color="cyan">  <Spinner type="dots" /></Text>
          )}
          <Text color="gray">  {url}</Text>
        </Box>
        <Box>
          <Text color="green">{who}</Text>
          <Text color="gray">  model: </Text>
          <Text color="yellow">{model}</Text>
        </Box>
      </Box>
      {planMode && (
        <Box
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
        >
          <Text color="magenta" bold>
            [PLAN MODE]
          </Text>
          <Text color="gray">  write/exec tools disabled — Shift-Tab or /plan to toggle</Text>
        </Box>
      )}
    </Box>
  );
}
