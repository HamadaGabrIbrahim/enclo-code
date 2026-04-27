import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bash } from "../../src/tools/bash.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-bash-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("bash", () => {
  it("requires permission, exec category", () => {
    expect(bash.requiresPermission).toBe(true);
    expect(bash.category).toBe("exec");
  });

  it("captures stdout and a 0 exit code", async () => {
    const r = await bash.execute({ command: "echo hello world" }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("hello world");
    expect(r.content).toContain("[exit 0]");
    if (r.display?.kind !== "bash") throw new Error("expected bash display");
    expect(r.display.exitCode).toBe(0);
    expect(r.display.stdout).toContain("hello world");
  });

  it("captures stderr and non-zero exit code", async () => {
    const r = await bash.execute(
      { command: "echo oops 1>&2; exit 7" },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("oops");
    expect(r.content).toContain("[exit 7]");
  });

  it("runs in the provided cwd", async () => {
    await fs.writeFile(path.join(tmpDir, "marker"), "x");
    const r = await bash.execute({ command: "ls" }, { cwd: tmpDir });
    expect(r.content).toContain("marker");
  });

  it("times out long-running commands", async () => {
    const r = await bash.execute({ command: "sleep 5", timeout: 200 }, { cwd: tmpDir });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("TIMED OUT");
  }, 5000);

  it("rejects malformed args", async () => {
    await expect(bash.execute({}, { cwd: tmpDir })).rejects.toThrow();
    await expect(bash.execute({ command: "" }, { cwd: tmpDir })).rejects.toThrow();
  });
});
