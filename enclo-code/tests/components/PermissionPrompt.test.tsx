import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import type { PermissionPrompt as Prompt, Tool } from "@enclo/core";
import { PermissionPromptView } from "../../src/components/PermissionPrompt.js";
import { captureFrame, stripAnsi, settle, press } from "./_helpers.js";

function fakeTool(name: string): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    category: "side_effect" as Tool["category"],
    requiresPermission: true,
    execute: async () => ({ content: "" }),
  };
}

function buildPrompt(opts: {
  toolName: string;
  args: unknown;
  resolve?: (...args: unknown[]) => void;
}): Prompt {
  return {
    request: { tool: fakeTool(opts.toolName), args: opts.args, cwd: "/tmp" },
    resolve: (opts.resolve ?? (() => {})) as Prompt["resolve"],
  };
}

describe("PermissionPromptView", () => {
  it("shows a header naming the requested tool and previews args", async () => {
    const prompt = buildPrompt({
      toolName: "bash",
      args: { command: "rm -rf node_modules" },
    });
    const { lastFrame } = render(<PermissionPromptView prompt={prompt} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("enclo wants to: bash");
    expect(frame).toContain("command: rm -rf node_modules");
    await captureFrame("PermissionPrompt-bash", lastFrame());
  });

  it("lists all 7 choice items", async () => {
    const prompt = buildPrompt({
      toolName: "edit_file",
      args: { path: "src/foo.ts", old_string: "a", new_string: "b" },
    });
    const { lastFrame } = render(<PermissionPromptView prompt={prompt} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Approve once");
    expect(frame).toContain("Allow for this session (edit_file)");
    expect(frame).toContain("Allow for this session (this exact target)");
    expect(frame).toContain("Allow forever (this tool, all sessions)");
    expect(frame).toContain("Allow forever (this exact target, all sessions)");
    expect(frame).toContain("Deny forever (this tool)");
    expect(frame).toContain("Deny");
    await captureFrame("PermissionPrompt-edit-file", lastFrame());
  });

  it("Enter on the highlighted (first = 'once') item resolves with allow_once", async () => {
    const resolve = vi.fn();
    const prompt = buildPrompt({
      toolName: "bash",
      args: { command: "ls" },
      resolve,
    });
    const { stdin } = render(<PermissionPromptView prompt={prompt} />);
    await settle();
    await press(stdin, "\r");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ kind: "allow_once" });
  });

  it("truncates string args longer than 200 chars", async () => {
    const long = "x".repeat(500);
    const prompt = buildPrompt({
      toolName: "write_file",
      args: { path: "out", content: long },
    });
    const { lastFrame } = render(<PermissionPromptView prompt={prompt} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("…");
    expect(frame.length).toBeLessThan(2000);
    await captureFrame("PermissionPrompt-long-arg", lastFrame());
  });

  it("renders multiline args with header and ellipsis when >20 lines", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const prompt = buildPrompt({
      toolName: "write_file",
      args: { path: "x", content: lines },
    });
    const { lastFrame } = render(<PermissionPromptView prompt={prompt} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("content:");
    expect(frame).toContain("line 0");
    expect(frame).toContain("…");
  });
});
