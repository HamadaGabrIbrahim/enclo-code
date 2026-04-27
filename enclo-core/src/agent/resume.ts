import type { AgentMessage, AgentToolCall, UserContentBlock } from "./loop.js";
import type { ConversationDetail, StoredMessage } from "../api/schemas.js";

/**
 * Turn server-shaped conversation messages into the agent loop's
 * AgentMessage[] history. Preserves EVERYTHING — assistant tool_calls and
 * role=tool messages — so the resumed model has full context of what tools
 * were invoked and what their results were.
 *
 * Messages with unknown shape (missing tool_call_id on a tool message,
 * unsupported role) are dropped rather than crashing the resume — those are
 * always the result of a server bug, and the model can usually proceed without
 * them.
 */
export function restoreHistory(detail: ConversationDetail): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of detail.messages) {
    const converted = toAgentMessage(m);
    if (converted) out.push(converted);
  }
  return out;
}

function toAgentMessage(m: StoredMessage): AgentMessage | null {
  if (m.role === "system") {
    return { role: "system", content: stringContent(m.content) };
  }
  if (m.role === "user") {
    return { role: "user", content: userContent(m.content) };
  }
  if (m.role === "assistant") {
    const text = stringContent(m.content);
    if (m.tool_calls && m.tool_calls.length > 0) {
      const calls: AgentToolCall[] = m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.function.name, arguments: c.function.arguments },
      }));
      return { role: "assistant", content: text, tool_calls: calls };
    }
    return { role: "assistant", content: text };
  }
  // role === "tool"
  if (!m.tool_call_id || !m.name) return null;
  return {
    role: "tool",
    tool_call_id: m.tool_call_id,
    name: m.name,
    content: stringContent(m.content),
  };
}

/**
 * Flatten a content payload to a string. Multi-modal blocks are concatenated
 * by their text fields; image_url blocks are replaced by a placeholder so
 * the model can see they were present.
 */
function stringContent(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : `[image: ${truncateUrl(b.image_url.url)}]`))
    .join("");
}

/**
 * Preserve multi-modal user content blocks for vision-capable models.
 * Strings stay strings.
 */
function userContent(
  content: StoredMessage["content"],
): string | UserContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "image_url",
      image_url: b.image_url.detail
        ? { url: b.image_url.url, detail: b.image_url.detail }
        : { url: b.image_url.url },
    };
  });
}

function truncateUrl(url: string): string {
  if (url.length <= 40) return url;
  return `${url.slice(0, 32)}…`;
}
