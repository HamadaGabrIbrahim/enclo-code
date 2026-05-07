import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../../src/components/Header.js";
import { captureFrame, stripAnsi, settle } from "./_helpers.js";

describe("Header", () => {
  it("shows signed-out state with no api url", async () => {
    const { lastFrame } = render(
      <Header apiUrl={undefined} email={undefined} activeModel={undefined} />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("enclo");
    expect(frame).toContain("(no server)");
    expect(frame).toContain("signed out");
    expect(frame).toContain("(none)");
    await captureFrame("Header-signed-out", lastFrame());
  });

  it("shows signed-in state with api url, email, and model", async () => {
    const { lastFrame } = render(
      <Header
        apiUrl="http://localhost:8000"
        email="alice@example.com"
        activeModel="qwen3:8b"
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("enclo");
    expect(frame).toContain("http://localhost:8000");
    expect(frame).toContain("alice@example.com");
    expect(frame).toContain("qwen3:8b");
    await captureFrame("Header-signed-in", lastFrame());
  });

  it("shows plan-mode banner when planMode=true", async () => {
    const { lastFrame } = render(
      <Header apiUrl="http://localhost:8000" email="a@b.co" activeModel="m" planMode />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("[PLAN MODE]");
    expect(frame).toContain("write/exec tools disabled");
    await captureFrame("Header-plan-mode", lastFrame());
  });

  it("hides plan-mode banner when planMode is false", async () => {
    const { lastFrame } = render(
      <Header apiUrl="http://x" email="a@b.co" activeModel="m" planMode={false} />,
    );
    await settle();
    expect(lastFrame() ?? "").not.toContain("[PLAN MODE]");
  });
});
