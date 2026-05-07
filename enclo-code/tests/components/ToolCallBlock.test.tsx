import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { ToolCallBlock } from "../../src/components/ToolCallBlock.js";
import { captureFrame, stripAnsi, settle } from "./_helpers.js";

describe("ToolCallBlock — pending state and summaries", () => {
  it("shows pending icon (⏵) for read_file", async () => {
    const { lastFrame } = render(
      <ToolCallBlock name="read_file" args={{ path: "/etc/hosts" }} status="pending" />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⏵");
    expect(frame).toContain("Reading /etc/hosts");
    await captureFrame("ToolCallBlock-read-pending", lastFrame());
  });

  it("shows ✓ when done", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="read_file"
        args={{ path: "/etc/hosts" }}
        status="done"
        result={{ content: "127.0.0.1 localhost\n" }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("✓");
    expect(frame).toContain("Reading /etc/hosts");
    expect(frame).toContain("127.0.0.1 localhost");
    await captureFrame("ToolCallBlock-read-done", lastFrame());
  });

  it("shows ✗ when denied", async () => {
    const { lastFrame } = render(
      <ToolCallBlock name="bash" args={{ command: "rm -rf /" }} status="denied" />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("✗");
    expect(frame).toContain("Running: rm -rf /");
    await captureFrame("ToolCallBlock-bash-denied", lastFrame());
  });

  it("shows ✗ icon when result.isError is true (even with status=done)", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="read_file"
        args={{ path: "/missing" }}
        status="done"
        result={{ content: "ENOENT", isError: true }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("✗"); // not ✓
    expect(frame).not.toMatch(/^\s*✓/);
    expect(frame).toContain("Reading /missing");
    expect(frame).toContain("ENOENT");
    await captureFrame("ToolCallBlock-read-error", lastFrame());
  });

  it("shows ✗ icon when bash exit code != 0 even without isError flag", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="bash"
        args={{ command: "false" }}
        status="done"
        display={{ kind: "bash", command: "false", stdout: "", stderr: "", exitCode: 1 }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("✗");
    expect(frame).toContain("[exit 1]");
    expect(frame.split("\n")[0]).not.toContain("✓");
  });
});

describe("ToolCallBlock — summary text per tool name", () => {
  const cases: Array<{ name: string; args: unknown; expect: string }> = [
    { name: "read_file", args: { path: "a.ts" }, expect: "Reading a.ts" },
    { name: "write_file", args: { path: "out.txt" }, expect: "Writing out.txt" },
    { name: "edit_file", args: { path: "x.py" }, expect: "Editing x.py" },
    { name: "bash", args: { command: "ls" }, expect: "Running: ls" },
    { name: "grep", args: { pattern: "TODO" }, expect: 'Searching for "TODO"' },
    { name: "glob", args: { pattern: "**/*.ts" }, expect: 'Globbing "**/*.ts"' },
    { name: "list_dir", args: { path: "src" }, expect: "Listing src" },
    { name: "spawn_agent", args: { task: "do thing" }, expect: "spawn_agent" },
  ];
  for (const c of cases) {
    it(`summarizes ${c.name}`, async () => {
      const { lastFrame } = render(
        <ToolCallBlock name={c.name} args={c.args} status="pending" />,
      );
      await settle();
      expect(stripAnsi(lastFrame() ?? "")).toContain(c.expect);
    });
  }
});

describe("ToolCallBlock — display variants", () => {
  it("renders 'text' display preview", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="read_file"
        args={{ path: "a.ts" }}
        status="done"
        display={{ kind: "text", preview: "line one\nline two\n" }}
      />,
    );
    await settle();
    expect(stripAnsi(lastFrame() ?? "")).toContain("line one");
    await captureFrame("ToolCallBlock-display-text", lastFrame());
  });

  it("renders 'list' display items", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="list_dir"
        args={{ path: "src" }}
        status="done"
        display={{ kind: "list", items: ["a.ts", "b.ts", "components/"] }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("a.ts");
    expect(frame).toContain("b.ts");
    expect(frame).toContain("components/");
    await captureFrame("ToolCallBlock-display-list", lastFrame());
  });

  it("renders 'bash' display with stdout, stderr, exitCode 0", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="bash"
        args={{ command: "node -e 'console.log(1); console.error(2)'" }}
        status="done"
        display={{
          kind: "bash",
          command: "node -e ...",
          stdout: "1\n",
          stderr: "2\n",
          exitCode: 0,
        }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("1");
    expect(frame).toContain("2");
    expect(frame).toContain("[exit 0]");
    await captureFrame("ToolCallBlock-display-bash-ok", lastFrame());
  });

  it("renders 'bash' display with non-zero exit and shows ✗ headline (UX fix)", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="bash"
        args={{ command: "false" }}
        status="done"
        display={{ kind: "bash", command: "false", stdout: "", stderr: "", exitCode: 1 }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("✗"); // not ✓ — exit 1 is a failure
    expect(frame).toContain("[exit 1]");
    await captureFrame("ToolCallBlock-display-bash-fail", lastFrame());
  });

  it("renders 'diff' display with +/-/= lines marked", async () => {
    const { lastFrame } = render(
      <ToolCallBlock
        name="edit_file"
        args={{ path: "x.ts" }}
        status="done"
        display={{
          kind: "diff",
          path: "x.ts",
          before: "line a\nline b\nline c\n",
          after: "line a\nLINE B\nline c\n",
        }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("x.ts");
    expect(frame).toMatch(/\+\s*LINE B/);
    expect(frame).toMatch(/-\s*line b/);
    await captureFrame("ToolCallBlock-display-diff", lastFrame());
  });
});

describe("ToolCallBlock — output truncation + sub-agent", () => {
  it("truncates fallback content preview after 10 lines", async () => {
    const big = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lastFrame } = render(
      <ToolCallBlock
        name="read_file"
        args={{ path: "big.txt" }}
        status="done"
        result={{ content: big }}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line 1");
    expect(frame).toContain("more lines");
    expect(frame).not.toContain("line 20");
  });

  it("renders sub-agent event tail (last 5 events)", async () => {
    const events = Array.from({ length: 8 }, (_, i) => ({
      id: `e${i}`,
      label: `step-${i + 1}`,
    }));
    const { lastFrame } = render(
      <ToolCallBlock
        name="spawn_agent"
        args={{ task: "summarize" }}
        status="pending"
        subAgentEvents={events}
      />,
    );
    await settle();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("sub-agent: 8 events");
    expect(frame).toContain("step-4");
    expect(frame).toContain("step-8");
    expect(frame).not.toContain("step-1");
    await captureFrame("ToolCallBlock-sub-agent", lastFrame());
  });
});
