import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Input } from "../../src/components/Input.js";
import { captureFrame, stripAnsi, settle, type, press } from "./_helpers.js";

describe("Input", () => {
  it("renders with default placeholder", async () => {
    const { lastFrame } = render(<Input onSubmit={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("›");
    expect(frame).toContain("Type a message, or /help");
    await captureFrame("Input-empty", lastFrame());
  });

  it("renders with custom placeholder", async () => {
    const { lastFrame } = render(
      <Input placeholder="Ask anything…" onSubmit={() => {}} />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Ask anything…");
  });

  it("captures typed input and submits on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Input onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "hello world");
    expect(stripAnsi(lastFrame() ?? "")).toContain("hello world");
    await press(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello world");
    await captureFrame("Input-after-submit", lastFrame());
  });

  it("does not submit empty/whitespace-only input", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Input onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "   ");
    await press(stdin, "\r");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores typing when disabled", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Input disabled onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "anything");
    await press(stdin, "\r");
    expect(onSubmit).not.toHaveBeenCalled();
    await captureFrame("Input-disabled", lastFrame());
  });

  it("clears value after a successful submit", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Input onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "first");
    await press(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("first");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("first");
  });

  it("invokes onPasteShortcut on Ctrl+V", async () => {
    const onPasteShortcut = vi.fn().mockReturnValue(true);
    const { stdin } = render(
      <Input onSubmit={() => {}} onPasteShortcut={onPasteShortcut} />,
    );
    await settle();
    await press(stdin, "\x16"); // Ctrl+V
    expect(onPasteShortcut).toHaveBeenCalled();
  });
});
