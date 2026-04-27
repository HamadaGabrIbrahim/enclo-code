import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "../../src/tools/read_file.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-rf-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("declares itself as a read-category, no-permission tool", () => {
    expect(readFile.category).toBe("read");
    expect(readFile.requiresPermission).toBe(false);
    expect(readFile.definition.function.name).toBe("read_file");
  });

  it("reads a small file with line numbering", async () => {
    const file = path.join(tmpDir, "hello.txt");
    await fs.writeFile(file, "alpha\nbeta\ngamma");
    const r = await readFile.execute({ path: file }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("     1\talpha");
    expect(r.content).toContain("     2\tbeta");
    expect(r.content).toContain("     3\tgamma");
  });

  it("respects offset and limit", async () => {
    const file = path.join(tmpDir, "lines.txt");
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    await fs.writeFile(file, lines);
    const r = await readFile.execute({ path: file, offset: 10, limit: 5 }, { cwd: tmpDir });
    expect(r.content).toContain("    10\tline10");
    expect(r.content).toContain("    14\tline14");
    expect(r.content).not.toContain("\tline15");
    expect(r.content).toContain("[truncated");
  });

  it("resolves relative paths against cwd", async () => {
    await fs.writeFile(path.join(tmpDir, "rel.txt"), "hi");
    const r = await readFile.execute({ path: "rel.txt" }, { cwd: tmpDir });
    expect(r.content).toContain("hi");
  });

  it("returns an error result for missing files", async () => {
    const r = await readFile.execute({ path: "no-such-file.txt" }, { cwd: tmpDir });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ENOENT|no such file/i);
  });

  it("rejects malformed arguments", async () => {
    await expect(readFile.execute({}, { cwd: tmpDir })).rejects.toThrow(/path/);
    await expect(readFile.execute({ path: 5 }, { cwd: tmpDir })).rejects.toThrow();
  });
});
