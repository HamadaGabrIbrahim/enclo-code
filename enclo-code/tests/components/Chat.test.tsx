import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Chat, type RenderedMessage, type AssistantBlock } from "../../src/components/Chat.js";
import { captureFrame, stripAnsi, settle } from "./_helpers.js";

const userMsg: RenderedMessage = {
  id: "m1",
  role: "user",
  content: "What's in /tmp?",
};

const assistantTextMsg: RenderedMessage = {
  id: "m2",
  role: "assistant",
  content: "I'll list the directory.",
};

const toolMsg: RenderedMessage = {
  id: "m3",
  role: "tool",
  content: "(tool result content)",
};

const systemMsg: RenderedMessage = {
  id: "m4",
  role: "system",
  content: "Project context loaded from enclo.md.",
};

describe("Chat", () => {
  it("renders an empty state with no messages", async () => {
    const { lastFrame } = render(<Chat messages={[]} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("you");
    expect(frame).not.toContain("enclo");
    await captureFrame("Chat-empty", lastFrame());
  });

  it("labels user as 'you' and assistant as 'enclo'", async () => {
    const { lastFrame } = render(<Chat messages={[userMsg, assistantTextMsg]} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("you");
    expect(frame).toContain("What's in /tmp?");
    expect(frame).toContain("enclo");
    expect(frame).toContain("I'll list the directory.");
    await captureFrame("Chat-user-and-assistant", lastFrame());
  });

  it("renders 'tool' role with magenta label without crashing (round-3 fix)", async () => {
    const { lastFrame } = render(<Chat messages={[toolMsg]} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("tool");
    expect(frame).toContain("(tool result content)");
    await captureFrame("Chat-tool-role", lastFrame());
  });

  it("renders 'system' role label", async () => {
    const { lastFrame } = render(<Chat messages={[systemMsg]} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("system");
    expect(frame).toContain("Project context loaded from enclo.md.");
  });

  it("shows the streaming pending indicator (' …') for in-flight assistant", async () => {
    const { lastFrame } = render(<Chat messages={[userMsg]} streaming="hello, working on it" />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("enclo …");
    expect(frame).toContain("hello, working on it");
    await captureFrame("Chat-streaming-text", lastFrame());
  });

  it("renders reasoning blocks distinctly with 'thinking…' header", async () => {
    const blocks: AssistantBlock[] = [
      {
        kind: "reasoning",
        id: "r1",
        text: "Hmm, the user is asking about /tmp. I should call list_dir.",
      },
    ];
    const { lastFrame } = render(<Chat messages={[userMsg]} streamingBlocks={blocks} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("Hmm, the user is asking about /tmp.");
    await captureFrame("Chat-reasoning-block", lastFrame());
  });

  it("renders both reasoning and text blocks side-by-side during a thinking-then-answer turn", async () => {
    const blocks: AssistantBlock[] = [
      { kind: "reasoning", id: "r1", text: "Let me check…" },
      { kind: "text", id: "t1", text: "Here's the answer:" },
    ];
    const { lastFrame } = render(<Chat messages={[userMsg]} streamingBlocks={blocks} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("Let me check…");
    expect(frame).toContain("Here's the answer:");
    await captureFrame("Chat-reasoning-then-text", lastFrame());
  });

  it("collapses a reasoning block to a one-line summary when collapsed=true", async () => {
    const longThinking = "Considering options ".repeat(20);
    const blocks: AssistantBlock[] = [
      { kind: "reasoning", id: "r1", text: longThinking, collapsed: true },
      { kind: "text", id: "t1", text: "Here's the answer:" },
    ];
    const { lastFrame } = render(<Chat messages={[userMsg]} streamingBlocks={blocks} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    // The full thinking text is hidden — only the chars-count summary shows.
    expect(frame).not.toContain("Considering options ");
    expect(frame).toContain(`+ thinking (${longThinking.length} chars)`);
    expect(frame).toContain("press r to expand");
    expect(frame).toContain("Here's the answer:");
  });

  it("renders tool-call blocks inline within the streaming assistant message", async () => {
    const blocks: AssistantBlock[] = [
      { kind: "text", id: "t1", text: "Listing directory…" },
      {
        kind: "tool",
        id: "tc1",
        name: "list_dir",
        args: { path: "/tmp" },
        status: "done",
        result: { content: "a.txt\nb.txt\n" },
      },
    ];
    const { lastFrame } = render(<Chat messages={[userMsg]} streamingBlocks={blocks} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Listing directory…");
    expect(frame).toContain("Listing /tmp");
    expect(frame).toContain("✓");
    await captureFrame("Chat-with-tool-call", lastFrame());
  });

  it("shows notice text in italic gray when provided", async () => {
    const { lastFrame } = render(<Chat messages={[userMsg]} notice="Compaction in progress…" />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Compaction in progress…");
  });

  it("handles a very long streaming text without exploding (truncation is layout's job)", async () => {
    const long = "x".repeat(5000);
    const { lastFrame } = render(<Chat messages={[userMsg]} streaming={long} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain("xxxxxxxxxx");
  });
});
