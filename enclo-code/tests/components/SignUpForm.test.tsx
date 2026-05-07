import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SignUpForm } from "../../src/components/SignUpForm.js";
import { captureFrame, stripAnsi, settle, type, press } from "./_helpers.js";

describe("SignUpForm", () => {
  it("renders title and three fields", async () => {
    const { lastFrame } = render(<SignUpForm onSubmit={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Create an enclo account");
    expect(frame).toContain("email:");
    expect(frame).toContain("display name (optional)");
    expect(frame).toContain("password (8+ chars):");
    await captureFrame("SignUpForm-initial", lastFrame());
  });

  it("requires 8+ char password to submit (rejects <8)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SignUpForm onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "a@b.co");
    await press(stdin, "\r");
    await type(stdin, "Alice");
    await press(stdin, "\r");
    await type(stdin, "short");
    await press(stdin, "\r"); // 5 chars — should NOT submit
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits with 8+ char password and trimmed display_name", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SignUpForm onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "alice@example.com");
    await press(stdin, "\r");
    await type(stdin, "  Alice  ");
    await press(stdin, "\r");
    await type(stdin, "longenough");
    await press(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: "alice@example.com",
      password: "longenough",
      display_name: "Alice",
    });
  });

  it("omits display_name when blank", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SignUpForm onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "a@b.co");
    await press(stdin, "\r");
    await press(stdin, "\r"); // blank name
    await type(stdin, "longenough");
    await press(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: "a@b.co",
      password: "longenough",
    });
  });

  it("masks the password", async () => {
    const { stdin, lastFrame } = render(<SignUpForm onSubmit={() => {}} />);
    await settle();
    await type(stdin, "a@b.co");
    await press(stdin, "\r");
    await type(stdin, "Alice");
    await press(stdin, "\r");
    await type(stdin, "topsecret123");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("topsecret123");
    expect(frame).toContain("*");
    await captureFrame("SignUpForm-password-masked", lastFrame());
  });

  it("renders busy and error states", async () => {
    const { lastFrame, rerender } = render(<SignUpForm onSubmit={() => {}} busy />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Creating account…");
    await captureFrame("SignUpForm-busy", lastFrame());

    rerender(<SignUpForm onSubmit={() => {}} error="Email already in use." />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Email already in use.");
    await captureFrame("SignUpForm-error", lastFrame());
  });
});
