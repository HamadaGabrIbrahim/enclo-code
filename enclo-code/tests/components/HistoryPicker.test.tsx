import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { ConversationSummary } from "@enclo/core";
import { HistoryPicker, rowLabel } from "../../src/components/HistoryPicker.js";
import { captureFrame, stripAnsi, settle, press } from "./_helpers.js";

const sample: ConversationSummary[] = [
  {
    id: "c1",
    title: "Refactor the auth flow",
    model: "qwen3:8b",
    created_at: "2026-05-06T10:00:00Z",
    updated_at: "2026-05-07T11:30:00Z",
    message_count: 12,
    total_prompt_tokens: 4000,
    total_completion_tokens: 800,
  },
  {
    id: "c2",
    title: null,
    model: "llama3.1:8b",
    created_at: "2026-05-05T08:00:00Z",
    updated_at: "2026-05-05T09:00:00Z",
    message_count: 3,
    total_prompt_tokens: null,
    total_completion_tokens: null,
  },
  {
    id: "c3",
    title:
      "An extremely long title that the picker should still be able to render without exploding the layout — it goes on and on",
    model: "qwen2.5-coder:7b",
    created_at: "2026-05-04T08:00:00Z",
    updated_at: "2026-05-04T09:00:00Z",
    message_count: 99,
    total_prompt_tokens: 100_000,
    total_completion_tokens: 50_000,
  },
];

describe("HistoryPicker", () => {
  it("shows empty-state copy when there are no conversations", async () => {
    const { lastFrame } = render(<HistoryPicker conversations={[]} onSelect={() => {}} />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("No prior conversations.");
    await captureFrame("HistoryPicker-empty", lastFrame());
  });

  it("renders title, sorted-newest-first and includes model + msg count", async () => {
    const { lastFrame } = render(<HistoryPicker conversations={sample} onSelect={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Resume a conversation");
    const idxC1 = frame.indexOf("Refactor the auth flow");
    const idxC2 = frame.indexOf("(untitled)");
    expect(idxC1).toBeGreaterThan(-1);
    expect(idxC2).toBeGreaterThan(-1);
    expect(idxC1).toBeLessThan(idxC2);
    expect(frame).toContain("qwen3:8b");
    expect(frame).toContain("12 msgs");
    await captureFrame("HistoryPicker-with-items", lastFrame());
  });

  it("falls back to '(untitled)' when title is null/empty", () => {
    const r = rowLabel(sample[1]!);
    expect(r).toContain("(untitled)");
  });

  it("includes formatted token count when totals > 0", () => {
    const r = rowLabel(sample[2]!);
    // 100k + 50k = 150k or 150,000 — accept either format.
    expect(r).toMatch(/(150[Kk]?|150,?000) tk/);
  });

  it("omits ' · X tk' suffix when totals are 0/null", () => {
    const r = rowLabel(sample[1]!);
    expect(r).not.toContain(" tk");
  });

  it("calls onSelect with the conversation id of the highlighted row", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<HistoryPicker conversations={sample} onSelect={onSelect} />);
    await settle();
    await press(stdin, "\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("truncates very long titles to keep ❯ cursor aligned in the picker", () => {
    const r = rowLabel(sample[2]!);
    // Title field shouldn't be the full 121-char input.
    expect(r).toContain("…");
    // Should still include trailing metadata.
    expect(r).toContain("qwen2.5-coder:7b · 99 msgs");
    // Total label length should be bounded — date + title(<=70) + meta ≈ <120.
    expect(r.length).toBeLessThan(140);
  });
});
