import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDir } from "../../src/tools/list_dir.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-ls-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("list_dir", () => {
  it("declares itself as auto-approve read tool", () => {
    expect(listDir.requiresPermission).toBe(false);
    expect(listDir.category).toBe("read");
  });

  it("lists files and dirs (dirs with trailing slash)", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "x");
    await fs.mkdir(path.join(tmpDir, "subdir"));
    const r = await listDir.execute({ path: tmpDir }, { cwd: tmpDir });
    expect(r.content).toContain("a.txt");
    expect(r.content).toContain("subdir/");
  });

  it("reports empty directories", async () => {
    const r = await listDir.execute({ path: tmpDir }, { cwd: tmpDir });
    expect(r.content).toMatch(/empty/);
  });

  it("returns an error when the path doesn't exist", async () => {
    const r = await listDir.execute(
      { path: path.join(tmpDir, "missing") },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
  });
});
