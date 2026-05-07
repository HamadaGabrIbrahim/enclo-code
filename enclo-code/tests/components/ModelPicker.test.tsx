import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Model } from "@enclo/core";
import { ModelPicker } from "../../src/components/ModelPicker.js";
import { captureFrame, stripAnsi, settle, press } from "./_helpers.js";

const models: Model[] = [
  { id: "qwen3:8b", display_name: "Qwen3 8B", context_length: 32768, available: true },
  { id: "llama3.1:8b", display_name: "Llama 3.1 8B", context_length: 131072, available: false },
  { id: "qwen2.5-coder:7b", display_name: "Qwen2.5 Coder 7B", context_length: 32768, available: true },
];

describe("ModelPicker", () => {
  it("renders the title and every model row", async () => {
    const { lastFrame } = render(<ModelPicker models={models} onSelect={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Select active model");
    expect(frame).toContain("Qwen3 8B");
    expect(frame).toContain("Llama 3.1 8B");
    expect(frame).toContain("Qwen2.5 Coder 7B");
    // v0.2 layout: model id renders on a second dim line beneath the
    // display name, no longer wrapped in brackets.
    expect(frame).toContain("qwen3:8b");
    await captureFrame("ModelPicker-default", lastFrame());
  });

  it("marks unavailable models with a hint label", async () => {
    const { lastFrame } = render(<ModelPicker models={models} onSelect={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("(unavailable)");
    const lines = frame.split("\n");
    const qwenLine = lines.find((l) => l.includes("Qwen3 8B")) ?? "";
    expect(qwenLine).not.toContain("(unavailable)");
  });

  it("calls onSelect with the model id when Enter is pressed", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ModelPicker models={models} onSelect={onSelect} />);
    await settle();
    await press(stdin, "\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("qwen3:8b");
  });

  it("respects the initial cursor index when `initial` is provided", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelPicker models={models} initial="qwen2.5-coder:7b" onSelect={onSelect} />,
    );
    await settle();
    await press(stdin, "\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("qwen2.5-coder:7b");
  });

  it("renders with empty list (does not crash)", async () => {
    const { lastFrame } = render(<ModelPicker models={[]} onSelect={() => {}} />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Select active model");
    await captureFrame("ModelPicker-empty", lastFrame());
  });

  it("renders the model id on a second dim line under the display name", async () => {
    const { lastFrame } = render(<ModelPicker models={models} onSelect={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    const lines = frame.split("\n");
    // Display name and id appear on different lines (the id row is dim).
    const nameIdx = lines.findIndex((l) => l.includes("Qwen3 8B") && !l.includes("qwen3:8b"));
    const idIdx = lines.findIndex((l) => l.includes("qwen3:8b"));
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThan(nameIdx);
  });
});
