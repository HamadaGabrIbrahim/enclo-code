import React from "react";
import { Box, Text } from "ink";

export interface HeaderProps {
  email?: string | undefined;
  apiUrl?: string | undefined;
  activeModel?: string | undefined;
  planMode?: boolean;
}

export function Header({
  email,
  apiUrl,
  activeModel,
  planMode = false,
}: HeaderProps): React.ReactElement {
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
          <Text color="gray">  {apiUrl ?? "(no server)"}</Text>
        </Box>
        <Box>
          <Text color="green">{email ?? "signed out"}</Text>
          <Text color="gray">  model: </Text>
          <Text color="yellow">{activeModel ?? "(none)"}</Text>
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
