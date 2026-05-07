import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { theme } from "../theme.js";

export interface SlashSuggestion {
  name: string;
  description?: string;
}

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
  /**
   * Slash-command suggestions for autocomplete. When the value starts with
   * `/`, matching entries render below the input. Tab completes, Up/Down
   * navigate, Esc dismisses.
   */
  commands?: SlashSuggestion[];
}

const MAX_SUGGESTIONS = 8;

function findSuggestions(query: string, commands: SlashSuggestion[]): SlashSuggestion[] {
  // Drop the leading "/" before matching.
  const q = query.startsWith("/") ? query.slice(1).toLowerCase() : query.toLowerCase();
  // Allow autocomplete on the COMMAND token only — not its arguments. So
  // "/all" → match. "/allow clear" → don't show suggestions (the user is
  // typing args, not picking a command).
  if (q.includes(" ")) return [];
  // Empty query (just "/") → show everything alphabetically.
  if (q === "") {
    return [...commands].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SUGGESTIONS);
  }
  // Prefix matches first, then anywhere-substring matches. Same alpha order
  // within each tier so the list is predictable.
  const prefix: SlashSuggestion[] = [];
  const inner: SlashSuggestion[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(c);
    else if (n.includes(q)) inner.push(c);
  }
  prefix.sort((a, b) => a.name.localeCompare(b.name));
  inner.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...inner].slice(0, MAX_SUGGESTIONS);
}

export function Input({
  placeholder,
  disabled = false,
  planMode = false,
  onSubmit,
  onPasteShortcut,
  commands = [],
}: InputProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Mode-aware placeholder so the user knows which "shape" their next message
  // takes: a slash command, a planning request (read-only), or a normal turn.
  const effectivePlaceholder =
    placeholder ??
    (value.startsWith("/")
      ? "Type a slash command — /help for the list"
      : planMode
        ? "Plan mode — describe a goal; no edits will be made"
        : "Type a message, or /help");

  const suggestions = useMemo(
    () => (value.startsWith("/") && !dismissed ? findSuggestions(value, commands) : []),
    [value, commands, dismissed],
  );
  const showSuggestions = suggestions.length > 0;

  // Reset selection / dismissal when the query changes shape.
  useEffect(() => {
    setSelectedIdx(0);
  }, [value]);
  useEffect(() => {
    if (!value.startsWith("/")) setDismissed(false);
  }, [value]);

  function handleSubmit(line: string): void {
    if (disabled) return;
    if (line.trim().length === 0) return;
    setValue("");
    setDismissed(false);
    onSubmit(line);
  }

  function applyCompletion(name: string): void {
    // Replace the slash command token with the chosen name and append a
    // space so the user can immediately type args.
    setValue(`/${name} `);
  }

  useInput(
    (input, key) => {
      // Paste shortcut handling stays first.
      if (onPasteShortcut) {
        const isMacPaste = key.meta && input === "v";
        const isOtherPaste = key.ctrl && input === "v";
        if (isMacPaste || isOtherPaste) {
          void onPasteShortcut();
          return;
        }
      }

      if (!showSuggestions) return;

      // Up / Down navigate the suggestion list.
      if (key.upArrow) {
        setSelectedIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => (i + 1) % suggestions.length);
        return;
      }

      // Tab completes to the selected suggestion. Right-arrow at the end
      // of the buffer is ALSO an accept-the-completion gesture in many
      // shells — wire it to the same path.
      if (key.tab) {
        const sel = suggestions[selectedIdx];
        if (sel) applyCompletion(sel.name);
        return;
      }

      // Esc dismisses the picker but leaves the value alone so the user
      // can keep typing without losing what they've written.
      if (key.escape) {
        setDismissed(true);
        return;
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.accent}>{"❯ "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={effectivePlaceholder}
          showCursor={!disabled}
        />
      </Box>
      {showSuggestions ? (
        <Box flexDirection="column" paddingX={1} marginLeft={1}>
          {suggestions.map((s, idx) => {
            const selected = idx === selectedIdx;
            return (
              <Box key={s.name}>
                <Text color={selected ? theme.accent : theme.muted} dimColor={!selected}>
                  {selected ? "▸ " : "  "}/{s.name}
                </Text>
                {s.description ? (
                  <Text color={theme.muted} dimColor>
                    {"  — "}{s.description}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          <Text color={theme.muted} dimColor>
            {"  "}tab: complete · ↑/↓: navigate · esc: dismiss
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
