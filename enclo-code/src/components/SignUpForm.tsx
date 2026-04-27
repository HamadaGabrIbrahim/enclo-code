import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface SignUpFormProps {
  onSubmit: (args: { email: string; password: string; display_name?: string }) => void;
  busy?: boolean;
  error?: string | undefined;
}

type Stage = "email" | "name" | "password";

export function SignUpForm({
  onSubmit,
  busy,
  error,
}: SignUpFormProps): React.ReactElement {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<Stage>("email");

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Create an enclo account
      </Text>
      <Box marginTop={1}>
        <Text>email: </Text>
        <TextInput
          value={email}
          onChange={setEmail}
          onSubmit={(v) => {
            if (v.trim().length > 0) setStage("name");
          }}
          showCursor={stage === "email" && !busy}
          focus={stage === "email" && !busy}
        />
      </Box>
      <Box>
        <Text>display name (optional): </Text>
        <TextInput
          value={name}
          onChange={setName}
          onSubmit={() => setStage("password")}
          showCursor={stage === "name" && !busy}
          focus={stage === "name" && !busy}
        />
      </Box>
      <Box>
        <Text>password (8+ chars): </Text>
        <TextInput
          value={password}
          onChange={setPassword}
          onSubmit={(v) => {
            if (v.length >= 8 && !busy) {
              const trimmedName = name.trim();
              onSubmit({
                email: email.trim(),
                password: v,
                ...(trimmedName ? { display_name: trimmedName } : {}),
              });
            }
          }}
          mask="*"
          showCursor={stage === "password" && !busy}
          focus={stage === "password" && !busy}
        />
      </Box>
      {busy && (
        <Box marginTop={1}>
          <Text color="yellow">Creating account…</Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
