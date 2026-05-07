import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { PermissionPrompt as Prompt, PermissionChoice } from "@enclo/core";
import { theme } from "../theme.js";

export interface PermissionPromptProps {
  prompt: Prompt;
}

interface Item {
  key: string;
  label: string;
  value: PermissionChoice;
  /** When true, render the row dim + warn-color so persistent rules stand out. */
  persistent?: boolean;
}

function ItemRenderer({ isSelected = false, label }: { isSelected?: boolean; label: string }): React.ReactElement {
  // ink-select-input renders the cursor; we just render the label, but check
  // the leading marker we encode below to decide color.
  const isPersistent = label.startsWith("​"); // ZWSP-prefix sentinel
  const text = isPersistent ? label.slice(1) : label;
  if (isPersistent) {
    return (
      <Text color={theme.warn} dimColor={!isSelected}>
        {text}
      </Text>
    );
  }
  return (
    <Text color={isSelected ? theme.accent : undefined}>
      {text}
    </Text>
  );
}

function targetSummary(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return typeof obj["path"] === "string" ? `target = ${obj["path"]}` : null;
    case "bash":
      return typeof obj["command"] === "string" ? `target = ${String(obj["command"]).split("\n")[0]}` : null;
    case "grep": {
      const pat = obj["pattern"];
      const path = obj["path"];
      if (typeof pat !== "string") return null;
      return `target = ${pat}${typeof path === "string" ? ` in ${path}` : ""}`;
    }
    case "glob":
      return typeof obj["pattern"] === "string" ? `target = ${obj["pattern"]}` : null;
    case "list_dir":
      return typeof obj["path"] === "string" ? `target = ${obj["path"]}` : null;
    default:
      return null;
  }
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
  const target = targetSummary(name, prompt.request.args);
  // ZWSP prefix marks rows that install a *persistent* rule — ItemRenderer
  // picks them out and styles them yellow+dim so the user can see at a glance
  // which option carries cross-session weight.
  const ZWSP = "​";
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
      label: `${ZWSP}Allow forever (this tool, all sessions)`,
      value: { kind: "allow_persisted_tool" },
      persistent: true,
    },
    {
      key: "persisted_target",
      label: `${ZWSP}Allow forever (this exact target, all sessions)`,
      value: { kind: "allow_persisted_target" },
      persistent: true,
    },
    {
      key: "deny_persisted",
      label: `${ZWSP}Deny forever (this tool)`,
      value: { kind: "deny_persisted" },
      persistent: true,
    },
    { key: "deny", label: "Deny", value: { kind: "deny" } },
  ];
  return (
    // No bright yellow border — just a left rule that signals "this is a
    // gate, not a regular block". Accent on the verb keeps it readable.
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box>
        <Text color={theme.accent} bold>
          ⚠  permission needed
        </Text>
        <Text color={theme.muted} dimColor>{"  "}{name}</Text>
      </Box>
      {target && (
        <Box marginTop={0}>
          <Text color={theme.muted}>{target}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {previewArgs(prompt.request.args).map((line, idx) => (
          <Text key={idx} color={theme.muted} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      <SelectInput
        items={items}
        itemComponent={ItemRenderer}
        onSelect={(item) => prompt.resolve((item as Item).value)}
      />
      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          persistent rules (in yellow) apply across sessions
        </Text>
      </Box>
    </Box>
  );
}
