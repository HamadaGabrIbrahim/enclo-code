import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage, ToolDisplay, ToolResult } from "@enclo/core";
import { ToolCallBlock, type ToolStatus } from "./ToolCallBlock.js";

export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: ToolResult;
  display?: ToolDisplay;
  /** For spawn_agent: nested events from the sub-agent. */
  subAgentEvents?: SubAgentEventEntry[];
  /**
   * Live stdout/stderr accumulated from tool_partial events while the
   * tool is still running (or kept around briefly so the user sees the
   * trail). Cleared once the final tool_result lands and display.kind
   * already carries the authoritative output.
   */
  partial?: { stdout: string; stderr: string };
}

export interface SubAgentEventEntry {
  id: string;
  /** Short label of the event (e.g. tool name or text snippet). */
  label: string;
}

export interface TextBlock {
  kind: "text";
  id: string;
  text: string;
}

/**
 * CoT/thinking stream from a reasoning model. Rendered in a distinct
 * dim/italic pane so the user can tell it apart from the final answer.
 * Not persisted as part of the assistant message.
 *
 * `collapsed` is set when real assistant_text starts arriving — the
 * thinking pane folds to a one-line `[+ thinking (N chars)]` summary so
 * the answer doesn't get pushed off-screen. Press `r` (reasoning) to
 * toggle the most recent block back open.
 */
export interface ReasoningBlock {
  kind: "reasoning";
  id: string;
  text: string;
  collapsed?: boolean;
}

export type AssistantBlock = TextBlock | ToolBlock | ReasoningBlock;

export interface RenderedMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
  pending?: boolean;
  /** For assistant messages: structured blocks for streaming text + tool calls. */
  blocks?: AssistantBlock[];
}

export interface ChatProps {
  messages: RenderedMessage[];
  streaming?: string;
  streamingBlocks?: AssistantBlock[];
  notice?: string | undefined;
}

export function Chat({
  messages,
  streaming,
  streamingBlocks,
  notice,
}: ChatProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} flexGrow={1}>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
      {(streaming !== undefined || (streamingBlocks && streamingBlocks.length > 0)) && (
        <MessageView
          message={{
            id: "__streaming__",
            role: "assistant",
            content: streaming ?? "",
            pending: true,
            ...(streamingBlocks ? { blocks: streamingBlocks } : {}),
          }}
        />
      )}
      {notice && (
        <Box marginTop={1}>
          <Text color="gray" italic>
            {notice}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function MessageViewImpl({ message }: { message: RenderedMessage }): React.ReactElement {
  const { color, label } = roleStyle(message.role);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}
        {message.pending ? " …" : ""}
      </Text>
      {message.blocks && message.blocks.length > 0 ? (
        <Box flexDirection="column">
          {message.blocks.map((block) => {
            if (block.kind === "text") {
              return <Text key={block.id}>{block.text}</Text>;
            }
            if (block.kind === "reasoning") {
              if (block.collapsed) {
                return (
                  <Box key={block.id} marginLeft={1}>
                    <Text color="gray" dimColor italic>
                      [+ thinking ({block.text.length} chars) — press r to expand]
                    </Text>
                  </Box>
                );
              }
              return (
                <Box key={block.id} marginLeft={1} flexDirection="column">
                  <Text color="gray" dimColor italic>
                    thinking…
                  </Text>
                  <Text color="gray" dimColor italic>
                    {block.text}
                  </Text>
                </Box>
              );
            }
            return (
              <ToolCallBlock
                key={block.id}
                name={block.name}
                args={block.args}
                status={block.status}
                {...(block.result ? { result: block.result } : {})}
                {...(block.display ? { display: block.display } : {})}
                {...(block.subAgentEvents ? { subAgentEvents: block.subAgentEvents } : {})}
                {...(block.partial ? { partial: block.partial } : {})}
              />
            );
          })}
        </Box>
      ) : (
        <Text>{message.content}</Text>
      )}
    </Box>
  );
}

const MessageView = React.memo(
  MessageViewImpl,
  (prev, next) => {
    const a = prev.message;
    const b = next.message;
    if (a.id !== b.id || a.role !== b.role || a.pending !== b.pending) return false;
    if (a.content !== b.content) return false;
    // Blocks reference equality is enough — caller mutates in place by
    // pushing new arrays on each flush.
    if (a.blocks !== b.blocks) return false;
    return true;
  },
);

function roleStyle(role: ChatMessage["role"]): { color: string; label: string } {
  switch (role) {
    case "user":
      return { color: "green", label: "you" };
    case "assistant":
      return { color: "cyan", label: "enclo" };
    case "system":
      return { color: "gray", label: "system" };
    case "tool":
      return { color: "magenta", label: "tool" };
    default:
      return { color: "white", label: String(role) };
  }
}
