import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grep } from "../../src/tools/grep.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-grep-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("grep", () => {
  it("declares itself as auto-approve read tool", () => {
    expect(grep.requiresPermission).toBe(false);
    expect(grep.category).toBe("read");
  });

  it("finds matches across multiple files", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "hello world\nfoo bar\n");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "another hello\n");
    const r = await grep.execute({ pattern: "hello", path: tmpDir }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("hello world");
    expect(r.content).toContain("another hello");
  });

  it("reports no matches gracefully", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "nothing here");
    const r = await grep.execute({ pattern: "zzz", path: tmpDir }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toMatch(/No matches/);
  });

  it("greps a single file directly", async () => {
    const f = path.join(tmpDir, "single.txt");
    await fs.writeFile(f, "line one\nline two\n");
    const r = await grep.execute({ pattern: "two", path: f }, { cwd: tmpDir });
    expect(r.content).toMatch(/line two/);
  });

  it("short-circuits the walk to a glob's literal prefix", async () => {
    // src/foo.ts hits; unrelated/deep/file.ts ALSO has the pattern but must
    // not be visited because the glob prefix says only src/**/*.ts is
    // relevant.
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "unrelated", "deep"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "foo.ts"), "needle here\n");
    await fs.writeFile(path.join(tmpDir, "unrelated", "deep", "file.ts"), "needle hidden\n");
    const r = await grep.execute(
      { pattern: "needle", path: tmpDir, glob: "src/**/*.ts" },
      { cwd: tmpDir },
    );
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("foo.ts");
    expect(r.content).not.toContain("unrelated");
  });
});
