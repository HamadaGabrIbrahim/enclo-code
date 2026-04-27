import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { formatTokenCount, type ConversationSummary } from "@enclo/core";

export interface HistoryPickerProps {
  conversations: ConversationSummary[];
  onSelect: (id: string) => void;
  onCancel?: () => void;
}

export function HistoryPicker({
  conversations,
  onSelect,
}: HistoryPickerProps): React.ReactElement {
  if (conversations.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text color="gray">No prior conversations.</Text>
      </Box>
    );
  }

  // Most recent first.
  const sorted = [...conversations].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );

  const items = sorted.map((c) => ({
    key: c.id,
    label: rowLabel(c),
    value: c.id,
  }));

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Resume a conversation (↑/↓ + Enter)
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          limit={10}
          onSelect={(item) => onSelect(item.value as string)}
        />
      </Box>
    </Box>
  );
}

export function rowLabel(c: ConversationSummary): string {
  const date = formatShortDate(c.updated_at);
  const title = (c.title ?? "(untitled)").trim() || "(untitled)";
  const totalTokens =
    (c.total_prompt_tokens ?? 0) + (c.total_completion_tokens ?? 0);
  const tk =
    totalTokens > 0 ? ` · ${formatTokenCount(totalTokens)} tk` : "";
  return `[${date}] ${title} (${c.model} · ${c.message_count} msgs${tk})`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
