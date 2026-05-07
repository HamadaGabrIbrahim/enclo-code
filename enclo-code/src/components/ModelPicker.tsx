import React, { useRef, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { Model } from "@enclo/core";

interface ItemProps {
  isSelected?: boolean;
  label: string;
}

/**
 * Two-line row: display name on line 1 (cursor anchors here, so highlight
 * stays attached), model id on line 2 in dim color so narrow terminals
 * don't wrap the bracketed id.
 */
function ModelItem({ isSelected, label }: ItemProps): React.ReactElement {
  // label format produced below: "Display | id | unavailable?"
  const [name, id, flag] = label.split(" | ");
  const unavailable = flag === "u";
  const headColor = unavailable
    ? (isSelected ? "yellow" : undefined)
    : (isSelected ? "cyan" : undefined);
  return (
    <Box flexDirection="column">
      <Text color={headColor} dimColor={unavailable}>
        {name}{unavailable ? " (unavailable)" : ""}
      </Text>
      <Text dimColor>{"   "}{id}</Text>
    </Box>
  );
}

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
  const [warning, setWarning] = useState<string | null>(null);
  // Track the id we just warned about so a SECOND Enter on the same row
  // confirms. Use a ref because ink-select-input's onSelect closes over the
  // first render's `warning` value otherwise.
  const pendingConfirmRef = useRef<string | null>(null);

  const items = models.map((m) => ({
    key: m.id,
    // Pack data into the label so the custom Item renderer can split it.
    label: `${m.display_name} | ${m.id} | ${m.available ? "a" : "u"}`,
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
          itemComponent={ModelItem}
          onSelect={(item) => {
            const id = String(item.value);
            const m = models.find((x) => x.id === id);
            if (m && !m.available) {
              if (pendingConfirmRef.current === id) {
                // Second Enter on the same unavailable row — let it through.
                pendingConfirmRef.current = null;
                setWarning(null);
                onSelect(id);
                return;
              }
              pendingConfirmRef.current = id;
              setWarning(
                `${id} isn't pulled on the upstream — pull it first (e.g. \`ollama pull ${id}\`). Press Enter again to select anyway.`,
              );
              return;
            }
            pendingConfirmRef.current = null;
            setWarning(null);
            onSelect(id);
          }}
        />
      </Box>
      {warning && (
        <Box marginTop={1}>
          <Text color="yellow">⚠ {warning}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Pulled models render in normal color; (unavailable) entries need a pull.
        </Text>
      </Box>
    </Box>
  );
}
