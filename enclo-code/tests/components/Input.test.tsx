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
    expect(frame).toContain("❯");
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

  describe("slash autocomplete", () => {
    const cmds = [
      { name: "models", description: "List models" },
      { name: "model-picker", description: "open the model picker" },
      { name: "help", description: "Show help" },
      { name: "history", description: "Resume a conversation" },
      { name: "exit", description: "Quit" },
    ];

    it("shows all commands when value is just '/'", async () => {
      const { stdin, lastFrame } = render(<Input onSubmit={() => {}} commands={cmds} />);
      await settle();
      await type(stdin, "/");
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("/exit");
      expect(frame).toContain("/help");
      expect(frame).toContain("/history");
      expect(frame).toContain("/models");
      expect(frame).toContain("tab: complete");
      await captureFrame("Input-slash-suggestions", lastFrame());
    });

    it("filters by prefix as the user types", async () => {
      const { stdin, lastFrame } = render(<Input onSubmit={() => {}} commands={cmds} />);
      await settle();
      await type(stdin, "/mo");
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("/models");
      expect(frame).toContain("/model-picker");
      expect(frame).not.toContain("/help");
      expect(frame).not.toContain("/exit");
    });

    it("hides suggestions once the user types a space (typing args)", async () => {
      const { stdin, lastFrame } = render(<Input onSubmit={() => {}} commands={cmds} />);
      await settle();
      await type(stdin, "/help foo");
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).not.toContain("tab: complete");
    });

    it("Tab completes to the highlighted suggestion + a trailing space", async () => {
      const onSubmit = vi.fn();
      const { stdin, lastFrame } = render(
        <Input onSubmit={onSubmit} commands={cmds} />,
      );
      await settle();
      await type(stdin, "/his");
      // single match → /history is selected by default at idx 0
      await press(stdin, "\t");
      // After tab the picker should hide (query no longer needs picking)
      // and the buffer should hold "/history ". Trailing whitespace isn't
      // visible at end-of-line in ink frames, so verify via submit instead.
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("/history");
      await press(stdin, "\r");
      expect(onSubmit).toHaveBeenCalledWith("/history ");
    });

    it("Down arrow cycles suggestions, then Tab completes the chosen one", async () => {
      const onSubmit = vi.fn();
      const { stdin } = render(
        <Input onSubmit={onSubmit} commands={cmds} />,
      );
      await settle();
      await type(stdin, "/h");
      // /help and /history match. Down once → /history highlighted.
      await press(stdin, "\x1b[B"); // Down arrow
      await press(stdin, "\t");
      await press(stdin, "\r");
      expect(onSubmit).toHaveBeenCalledWith("/history ");
    });

    it("Esc dismisses the picker but keeps the typed value", async () => {
      const { stdin, lastFrame } = render(
        <Input onSubmit={() => {}} commands={cmds} />,
      );
      await settle();
      await type(stdin, "/he");
      const before = stripAnsi(lastFrame() ?? "");
      expect(before).toContain("/help");
      expect(before).toContain("tab: complete");
      await press(stdin, "\x1b"); // Esc
      const after = stripAnsi(lastFrame() ?? "");
      expect(after).not.toContain("tab: complete");
      // Typed value still visible.
      expect(after).toContain("/he");
    });
  });
});
