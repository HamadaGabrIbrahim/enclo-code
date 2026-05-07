import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export interface InputProps {
  placeholder?: string;
  disabled?: boolean;
  /** When true, swap the placeholder for a plan-mode-specific hint. */
  planMode?: boolean;
  onSubmit: (line: string) => void;
  /**
   * Called when the user hits the platform paste shortcut (Cmd-V on macOS,
   * Ctrl-V elsewhere). Returning true tells the input that the paste was
   * handled (e.g. an image was pulled from the clipboard); returning false
   * lets the keystroke fall through so the terminal's normal paste runs.
   */
  onPasteShortcut?: () => boolean | Promise<boolean>;
}

export function Input({
  placeholder,
  disabled = false,
  planMode = false,
  onSubmit,
  onPasteShortcut,
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");
  // Mode-aware placeholder so the user knows which "shape" their next message
  // takes: a slash command, a planning request (read-only), or a normal turn.
  const effectivePlaceholder =
    placeholder ??
    (value.startsWith("/")
      ? "Type a slash command — /help for the list"
      : planMode
        ? "Plan mode — describe a goal; no edits will be made"
        : "Type a message, or /help");

  function handleSubmit(line: string): void {
    if (disabled) return;
    if (line.trim().length === 0) return;
    setValue("");
    onSubmit(line);
  }

  useInput(
    (input, key) => {
      if (!onPasteShortcut) return;
      const isMacPaste = key.meta && input === "v";
      const isOtherPaste = key.ctrl && input === "v";
      if (isMacPaste || isOtherPaste) {
        // Fire-and-forget: clipboard handlers manage their own state and
        // surface notices via the parent.
        void onPasteShortcut();
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">{"› "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={effectivePlaceholder}
        showCursor={!disabled}
      />
    </Box>
  );
}
