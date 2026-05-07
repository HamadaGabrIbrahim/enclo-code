import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { TokenUsageState } from "@enclo/core";
import { Footer } from "../../src/components/Footer.js";
import { captureFrame, stripAnsi, settle } from "./_helpers.js";

const empty: TokenUsageState = {
  promptTokens: 0,
  completionTokens: 0,
  requestCount: 0,
  lastRequestPromptTokens: 0,
};

const usedSome: TokenUsageState = {
  promptTokens: 1234,
  completionTokens: 567,
  requestCount: 3,
  lastRequestPromptTokens: 4096,
};

describe("Footer", () => {
  it("renders nothing on first launch (requestCount=0)", async () => {
    const { lastFrame } = render(<Footer usage={empty} />);
    await settle();
    expect(lastFrame() ?? "").toBe("");
  });

  it("shows in/out token counts after first request", async () => {
    const { lastFrame } = render(<Footer usage={usedSome} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toMatch(/1[\.,]?2(3?4?[Kk]?|34)/); // formatTokenCount: 1234 or 1.2k or 1,234
    expect(frame).toContain("in");
    expect(frame).toContain("out");
    expect(frame).toContain("567");
    await captureFrame("Footer-with-usage", lastFrame());
  });

  it("shows context % when contextLength provided", async () => {
    const { lastFrame } = render(<Footer usage={usedSome} contextLength={32768} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("ctx");
    // 4096/32768 = 12.5%
    expect(frame).toMatch(/1[23]\s*%|12\.5\s*%/);
    await captureFrame("Footer-with-context", lastFrame());
  });

  it("shows danger-tier context value when usage > 90% of context", async () => {
    const danger: TokenUsageState = { ...usedSome, lastRequestPromptTokens: 30000 };
    const { lastFrame } = render(<Footer usage={danger} contextLength={32768} />);
    await settle();
    // 30000 / 32768 = ~91.5% — danger threshold (red).
    expect(stripAnsi(lastFrame() ?? "")).toMatch(/9[12]\s*%/);
    await captureFrame("Footer-context-danger", lastFrame());
  });

  it("shows cost when both rates supplied", async () => {
    const { lastFrame } = render(
      <Footer
        usage={usedSome}
        costRates={{ promptPerMillion: 0.5, completionPerMillion: 1.0 }}
      />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("$");
    await captureFrame("Footer-with-cost", lastFrame());
  });

  it("hides cost when one rate is missing", async () => {
    const { lastFrame } = render(
      <Footer usage={usedSome} costRates={{ promptPerMillion: 0.5 }} />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("$");
  });

  it("hides cost when rates are zero", async () => {
    const { lastFrame } = render(
      <Footer
        usage={usedSome}
        costRates={{ promptPerMillion: 0, completionPerMillion: 0 }}
      />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("$");
  });
});
