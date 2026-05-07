import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { FirstRun } from "../../src/components/FirstRun.js";
import { captureFrame, stripAnsi, settle, type, press } from "./_helpers.js";

describe("FirstRun", () => {
  it("first asks for the API URL when apiUrlSet=false", async () => {
    const { lastFrame } = render(
      <FirstRun apiUrlSet={false} onApiUrl={() => {}} onAuthChoice={() => {}} />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Welcome to enclo");
    expect(frame).toContain("API URL:");
    expect(frame).toContain("http://"); // pre-filled
    await captureFrame("FirstRun-api-url-prompt", lastFrame());
  });

  it("calls onApiUrl with trailing slash trimmed", async () => {
    const onApiUrl = vi.fn();
    const { stdin } = render(
      <FirstRun apiUrlSet={false} onApiUrl={onApiUrl} onAuthChoice={() => {}} />,
    );
    await settle();
    await type(stdin, "localhost:8000///");
    await press(stdin, "\r");
    expect(onApiUrl).toHaveBeenCalledTimes(1);
    expect(onApiUrl).toHaveBeenCalledWith("http://localhost:8000");
  });

  it("rejects empty url", async () => {
    const onApiUrl = vi.fn();
    const { stdin } = render(
      <FirstRun apiUrlSet={false} onApiUrl={onApiUrl} onAuthChoice={() => {}} />,
    );
    await settle();
    // Backspace through "http://" (7 chars). Backspace = 0x7f. Send extra
    // to make sure we clear the prefix.
    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      await press(stdin, "\x7f");
    }
    await press(stdin, "\r");
    expect(onApiUrl).not.toHaveBeenCalled();
  });

  it("shows api-url error when provided", async () => {
    const { lastFrame } = render(
      <FirstRun
        apiUrlSet={false}
        onApiUrl={() => {}}
        onAuthChoice={() => {}}
        error="Could not reach server."
      />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Could not reach server.");
    await captureFrame("FirstRun-api-url-error", lastFrame());
  });

  it("shows auth choice when apiUrlSet=true", async () => {
    const { lastFrame } = render(
      <FirstRun apiUrlSet onApiUrl={() => {}} onAuthChoice={() => {}} />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Sign in or create an account");
    expect(frame).toContain("Sign in");
    expect(frame).toContain("Create account");
    await captureFrame("FirstRun-auth-choice", lastFrame());
  });

  it("calls onAuthChoice with selected value on Enter", async () => {
    const onAuthChoice = vi.fn();
    const { stdin } = render(
      <FirstRun apiUrlSet onApiUrl={() => {}} onAuthChoice={onAuthChoice} />,
    );
    await settle();
    await press(stdin, "\r");
    expect(onAuthChoice).toHaveBeenCalledTimes(1);
    expect(onAuthChoice).toHaveBeenCalledWith("signin");
  });
});
