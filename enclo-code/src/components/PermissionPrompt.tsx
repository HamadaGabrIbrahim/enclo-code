import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { PermissionPrompt as Prompt, PermissionChoice } from "@enclo/core";

export interface PermissionPromptProps {
  prompt: Prompt;
}

interface Item {
  key: string;
  label: string;
  value: PermissionChoice;
}

function previewArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 200) {
      lines.push(`${k}: ${v.slice(0, 200)}…`);
    } else if (typeof v === "string") {
      const isMultiline = v.includes("\n");
      if (isMultiline) {
        const head = v.split("\n").slice(0, 20).join("\n");
        lines.push(`${k}:\n${head}${v.split("\n").length > 20 ? "\n…" : ""}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines;
}

export function PermissionPromptView({ prompt }: PermissionPromptProps): React.ReactElement {
  const name = prompt.request.tool.definition.function.name;
  const items: Item[] = [
    { key: "once", label: "Approve once", value: { kind: "allow_once" } },
    {
      key: "session_tool",
      label: `Allow for this session (${name})`,
      value: { kind: "allow_session_tool" },
    },
    {
      key: "session_target",
      label: "Allow for this session (this exact target)",
      value: { kind: "allow_session_target" },
    },
    {
      key: "persisted_tool",
      label: `Allow forever (this tool, all sessions)`,
      value: { kind: "allow_persisted_tool" },
    },
    {
      key: "persisted_target",
      label: `Allow forever (this exact target, all sessions)`,
      value: { kind: "allow_persisted_target" },
    },
    {
      key: "deny_persisted",
      label: `Deny forever (this tool)`,
      value: { kind: "deny_persisted" },
    },
    { key: "deny", label: "Deny", value: { kind: "deny" } },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">
        enclo wants to: {name}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {previewArgs(prompt.request.args).map((line, idx) => (
          <Text key={idx} color="gray">
            {line}
          </Text>
        ))}
      </Box>
      <SelectInput
        items={items}
        onSelect={(item) => prompt.resolve((item as Item).value)}
      />
    </Box>
  );
}
