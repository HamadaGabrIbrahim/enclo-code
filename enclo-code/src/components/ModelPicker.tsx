import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { Model } from "@enclo/core";

export interface ModelPickerProps {
  models: Model[];
  initial?: string | undefined;
  onSelect: (modelId: string) => void;
  onCancel?: () => void;
}

export function ModelPicker({
  models,
  initial,
  onSelect,
}: ModelPickerProps): React.ReactElement {
  const items = models.map((m) => ({
    key: m.id,
    label: `${m.display_name}${m.available ? "" : " (unavailable)"}  [${m.id}]`,
    value: m.id,
  }));

  const initialIndex = initial
    ? Math.max(
        0,
        items.findIndex((i) => i.value === initial),
      )
    : 0;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Select active model (↑/↓ + Enter)
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={initialIndex}
          onSelect={(item) => onSelect(item.value as string)}
        />
      </Box>
    </Box>
  );
}
