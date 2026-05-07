import React from "react";
import { Box, Text } from "ink";
import { lineDiff, type ToolDisplay, type ToolResult } from "@enclo/core";

export type ToolStatus = "pending" | "denied" | "done";

export interface SubAgentEventEntry {
  id: string;
  label: string;
}

export interface ToolCallBlockProps {
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: ToolResult;
  display?: ToolDisplay;
  subAgentEvents?: SubAgentEventEntry[];
  /**
   * Live stdout/stderr accumulated from tool_partial events. Rendered in
   * cyan/red below the headline while status === "pending"; once the call
   * completes, `display` (with its full bash output) supersedes this.
   */
  partial?: { stdout: string; stderr: string };
}

const ICONS: Record<ToolStatus, string> = {
  pending: "⏵",
  denied: "✗",
  done: "✓",
};

const COLORS: Record<ToolStatus, string> = {
  pending: "yellow",
  denied: "red",
  done: "green",
};

function summarize(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const obj = args as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return `Reading ${obj["path"]}`;
    case "write_file":
      return `Writing ${obj["path"]}`;
    case "edit_file":
      return `Editing ${obj["path"]}`;
    case "bash":
      return typeof obj["command"] === "string" ? `Running: ${obj["command"]}` : "Running command";
    case "grep":
      return `Searching for ${JSON.stringify(obj["pattern"])}`;
    case "glob":
      return `Globbing ${JSON.stringify(obj["pattern"])}`;
    case "list_dir":
      return `Listing ${obj["path"]}`;
    default:
      return name;
  }
}

function ToolCallBlockImpl({
  name,
  args,
  status,
  result,
  display,
  subAgentEvents,
  partial,
}: ToolCallBlockProps): React.ReactElement {
  // Treat a non-zero bash exit as an error even when the agent layer didn't
  // surface result.isError — otherwise the user sees a green ✓ next to a
  // command that actually failed.
  const bashFailed =
    display?.kind === "bash" && display.exitCode !== 0;
  const isError = result?.isError === true || bashFailed;
  // Iconography must match meaning: a green ✓ next to red text is contradictory.
  const icon = isError ? ICONS.denied : ICONS[status];
  const color = isError ? "red" : COLORS[status];
  const headline = summarize(name, args);

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={1}>
      <Text color={color}>
        {icon} {headline}
      </Text>
      {subAgentEvents && subAgentEvents.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="gray" dimColor>
            └─ sub-agent: {subAgentEvents.length} event{subAgentEvents.length === 1 ? "" : "s"}
          </Text>
          {subAgentEvents.slice(-5).map((e) => (
            <Text key={e.id} color="gray" dimColor>
              {"   "}· {e.label}
            </Text>
          ))}
        </Box>
      )}
      {status === "pending" && partial && (partial.stdout.length > 0 || partial.stderr.length > 0) && (
        <Box flexDirection="column" marginLeft={2}>
          {partial.stdout.length > 0 && (
            <Text color="cyan">{previewText(partial.stdout.trimEnd(), 20)}</Text>
          )}
          {partial.stderr.length > 0 && (
            <Text color="red">{previewText(partial.stderr.trimEnd(), 10)}</Text>
          )}
        </Box>
      )}
      {status === "done" && display && <DisplayBlock display={display} />}
      {status === "done" && !display && result?.content ? (
        <Box marginLeft={2}>
          <Text color="gray">{previewText(result.content)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const ToolCallBlock = React.memo(
  ToolCallBlockImpl,
  (prev, next) =>
    prev.status === next.status &&
    prev.name === next.name &&
    prev.args === next.args &&
    prev.result === next.result &&
    prev.display === next.display &&
    prev.subAgentEvents === next.subAgentEvents &&
    prev.partial === next.partial &&
    (prev.partial?.stdout.length ?? 0) === (next.partial?.stdout.length ?? 0) &&
    (prev.partial?.stderr.length ?? 0) === (next.partial?.stderr.length ?? 0),
);

function previewText(text: string, maxLines = 10): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n… (${lines.length - maxLines} more lines)`;
}

function DisplayBlock({ display }: { display: ToolDisplay }): React.ReactElement | null {
  if (display.kind === "text") {
    return (
      <Box marginLeft={2}>
        <Text color="gray">{display.preview}</Text>
      </Box>
    );
  }
  if (display.kind === "list") {
    return (
      <Box flexDirection="column" marginLeft={2}>
        {display.items.map((item, idx) => (
          <Text key={idx} color="gray">
            {item}
          </Text>
        ))}
      </Box>
    );
  }
  if (display.kind === "bash") {
    return (
      <Box flexDirection="column" marginLeft={2}>
        {display.stdout.length > 0 && (
          <Text color="gray">{previewText(display.stdout.trimEnd(), 10)}</Text>
        )}
        {display.stderr.length > 0 && (
          <Text color="red">{previewText(display.stderr.trimEnd(), 5)}</Text>
        )}
        <Text color={display.exitCode === 0 ? "green" : "red"}>
          [exit {display.exitCode}]
        </Text>
      </Box>
    );
  }
  if (display.kind === "diff") {
    const lines = lineDiff(display.before, display.after).slice(0, 30);
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color="gray">{display.path}</Text>
        {lines.map((l, idx) => {
          const color = l.kind === "add" ? "green" : l.kind === "del" ? "red" : "gray";
          const prefix = l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ";
          return (
            <Text key={idx} color={color}>
              {prefix}
              {l.text}
            </Text>
          );
        })}
      </Box>
    );
  }
  return null;
}
