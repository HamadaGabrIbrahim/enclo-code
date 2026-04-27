import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";
import { builtInTools } from "../../src/tools/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-prompt-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
  it("interpolates cwd and tool list into the default template", async () => {
    const prompt = await buildSystemPrompt({
      cwd: "/some/dir",
      tools: builtInTools(),
      overridePath: path.join(tmpDir, "missing.md"),
    });
    expect(prompt).toContain("Working directory: /some/dir");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("bash");
  });

  it("honors a user-provided override file", async () => {
    const override = path.join(tmpDir, "system.md");
    await fs.writeFile(override, "Custom prompt for {{CWD}} with {{TOOLS}}.");
    const prompt = await buildSystemPrompt({
      cwd: "/x",
      tools: builtInTools().slice(0, 2),
      overridePath: override,
    });
    expect(prompt).toContain("Custom prompt for /x with read_file, write_file.");
  });
});
