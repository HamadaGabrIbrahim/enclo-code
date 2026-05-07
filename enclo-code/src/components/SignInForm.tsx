import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface SignInFormProps {
  onSubmit: (args: { email: string; password: string }) => void;
  busy?: boolean;
  error?: string | undefined;
}

export function SignInForm({
  onSubmit,
  busy,
  error,
}: SignInFormProps): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<"email" | "password">("email");
  // After a failed submission (error appears while not busy), clear the
  // password field and return focus to it so the user types fresh — appending
  // to a masked buffer is invisible and confusing.
  const sawErrorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (error && !busy && sawErrorRef.current !== error) {
      sawErrorRef.current = error;
      setPassword("");
      setStage("password");
    }
    if (!error) sawErrorRef.current = undefined;
  }, [error, busy]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Sign in to enclo
      </Text>
      <Box marginTop={1}>
        <Text>email: </Text>
        <TextInput
          value={email}
          onChange={setEmail}
          onSubmit={(v) => {
            if (v.trim().length > 0) setStage("password");
          }}
          showCursor={stage === "email" && !busy}
          focus={stage === "email" && !busy}
        />
      </Box>
      <Box>
        <Text>password: </Text>
        <TextInput
          value={password}
          onChange={setPassword}
          onSubmit={(v) => {
            if (v.length > 0 && !busy) {
              onSubmit({ email: email.trim(), password: v });
            }
          }}
          mask="*"
          showCursor={stage === "password" && !busy}
          focus={stage === "password" && !busy}
        />
      </Box>
      {busy && (
        <Box marginTop={1}>
          <Text color="yellow">Signing in…</Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
}
