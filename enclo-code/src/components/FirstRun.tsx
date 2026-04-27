import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";

export interface FirstRunProps {
  onApiUrl: (url: string) => void;
  onAuthChoice: (choice: "signin" | "signup") => void;
  apiUrlSet: boolean;
  error?: string | undefined;
}

export function FirstRun({
  onApiUrl,
  onAuthChoice,
  apiUrlSet,
  error,
}: FirstRunProps): React.ReactElement {
  const [url, setUrl] = useState("http://");

  if (!apiUrlSet) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="cyan">
          Welcome to enclo
        </Text>
        <Text color="gray">First, point me at your enclo-api server.</Text>
        <Box marginTop={1}>
          <Text>API URL: </Text>
          <TextInput
            value={url}
            onChange={setUrl}
            onSubmit={(v) => {
              const cleaned = v.trim().replace(/\/+$/, "");
              if (cleaned.length > 0) onApiUrl(cleaned);
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Sign in or create an account
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { key: "signin", label: "Sign in", value: "signin" },
            { key: "signup", label: "Create account", value: "signup" },
          ]}
          onSelect={(item) => onAuthChoice(item.value as "signin" | "signup")}
        />
      </Box>
    </Box>
  );
}
