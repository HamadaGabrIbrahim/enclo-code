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

export type AssistantBlock = TextBlock | ToolBlock;

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

function MessageView({ message }: { message: RenderedMessage }): React.ReactElement {
  const { color, label } = roleStyle(message.role);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {label}
        {message.pending ? " …" : ""}
      </Text>
      {message.blocks && message.blocks.length > 0 ? (
        <Box flexDirection="column">
          {message.blocks.map((block) =>
            block.kind === "text" ? (
              <Text key={block.id}>{block.text}</Text>
            ) : (
              <ToolCallBlock
                key={block.id}
                name={block.name}
                args={block.args}
                status={block.status}
                {...(block.result ? { result: block.result } : {})}
                {...(block.display ? { display: block.display } : {})}
                {...(block.subAgentEvents ? { subAgentEvents: block.subAgentEvents } : {})}
              />
            ),
          )}
        </Box>
      ) : (
        <Text>{message.content}</Text>
      )}
    </Box>
  );
}

function roleStyle(role: ChatMessage["role"]): { color: string; label: string } {
  switch (role) {
    case "user":
      return { color: "green", label: "you" };
    case "assistant":
      return { color: "cyan", label: "enclo" };
    case "system":
      return { color: "gray", label: "system" };
  }
}
