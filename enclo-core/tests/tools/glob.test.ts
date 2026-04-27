import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob, globToRegex } from "../../src/tools/glob.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-glob-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("globToRegex", () => {
  it("matches single-segment * but not slashes", () => {
    expect(globToRegex("*.ts").test("foo.ts")).toBe(true);
    expect(globToRegex("*.ts").test("a/foo.ts")).toBe(false);
  });

  it("matches ** across path separators", () => {
    expect(globToRegex("src/**/*.ts").test("src/foo.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegex("src/**/*.ts").test("lib/x.ts")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    expect(globToRegex("file.name").test("file.name")).toBe(true);
    expect(globToRegex("file.name").test("fileXname")).toBe(false);
  });
});

describe("glob tool", () => {
  it("declares itself as auto-approve read tool", () => {
    expect(glob.requiresPermission).toBe(false);
    expect(glob.category).toBe("read");
  });

  it("finds files matching a pattern", async () => {
    await fs.mkdir(path.join(tmpDir, "src", "a"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "a", "x.ts"), "x");
    await fs.writeFile(path.join(tmpDir, "src", "y.ts"), "y");
    await fs.writeFile(path.join(tmpDir, "z.txt"), "z");
    const r = await glob.execute({ pattern: "**/*.ts", path: tmpDir }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("x.ts");
    expect(r.content).toContain("y.ts");
    expect(r.content).not.toContain("z.txt");
  });

  it("returns a friendly message when no matches", async () => {
    const r = await glob.execute({ pattern: "**/*.foo", path: tmpDir }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toMatch(/No files matching/);
  });

  it("skips node_modules and .git automatically", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.ts"), "x");
    await fs.writeFile(path.join(tmpDir, "main.ts"), "y");
    const r = await glob.execute({ pattern: "**/*.ts", path: tmpDir }, { cwd: tmpDir });
    expect(r.content).toContain("main.ts");
    expect(r.content).not.toContain("node_modules");
  });
});
