import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SignInForm } from "../../src/components/SignInForm.js";
import { captureFrame, stripAnsi, settle, type, press } from "./_helpers.js";

describe("SignInForm", () => {
  it("shows the title and both fields on initial render", async () => {
    const { lastFrame } = render(<SignInForm onSubmit={() => {}} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Sign in to enclo");
    expect(frame).toContain("email:");
    expect(frame).toContain("password:");
    await captureFrame("SignInForm-initial", lastFrame());
  });

  it("transitions email -> password and submits on second Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<SignInForm onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "alice@example.com");
    await press(stdin, "\r"); // submit email -> stage password
    await type(stdin, "hunter2hunter2");
    await press(stdin, "\r"); // submit password
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: "alice@example.com",
      password: "hunter2hunter2",
    });
    await captureFrame("SignInForm-submitted", lastFrame());
  });

  it("masks the password (does not reveal cleartext in frame)", async () => {
    const { stdin, lastFrame } = render(<SignInForm onSubmit={() => {}} />);
    await settle();
    await type(stdin, "alice@example.com");
    await press(stdin, "\r");
    await type(stdin, "supersecret");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("supersecret");
    expect(frame).toContain("*"); // mask char
    await captureFrame("SignInForm-password-masked", lastFrame());
  });

  it("renders busy state and hides cursor", async () => {
    const { lastFrame } = render(<SignInForm onSubmit={() => {}} busy />);
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Signing in…");
    await captureFrame("SignInForm-busy", lastFrame());
  });

  it("renders error message", async () => {
    const { lastFrame } = render(
      <SignInForm onSubmit={() => {}} error="Invalid credentials." />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("Invalid credentials.");
    await captureFrame("SignInForm-error", lastFrame());
  });

  it("does not submit on blank email", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SignInForm onSubmit={onSubmit} />);
    await settle();
    await press(stdin, "\r"); // empty email
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while busy", async () => {
    const onSubmit = vi.fn();
    const { stdin, rerender } = render(<SignInForm onSubmit={onSubmit} />);
    await settle();
    await type(stdin, "a@b.co");
    await press(stdin, "\r");
    rerender(<SignInForm onSubmit={onSubmit} busy />);
    await settle();
    await type(stdin, "password");
    await press(stdin, "\r");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
