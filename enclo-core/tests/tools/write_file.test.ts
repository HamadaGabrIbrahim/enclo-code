import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFile } from "../../src/tools/write_file.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-wf-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("write_file", () => {
  it("requires permission and is in the write category", () => {
    expect(writeFile.requiresPermission).toBe(true);
    expect(writeFile.category).toBe("write");
  });

  it("creates a new file", async () => {
    const file = path.join(tmpDir, "new.txt");
    const r = await writeFile.execute({ path: file, content: "hi\nthere" }, { cwd: tmpDir });
    expect(r.isError).not.toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("hi\nthere");
    expect(r.content).toMatch(/Created/);
    expect(r.display?.kind).toBe("diff");
  });

  it("creates nested parent directories automatically", async () => {
    const file = path.join(tmpDir, "a", "b", "c.txt");
    await writeFile.execute({ path: file, content: "x" }, { cwd: tmpDir });
    expect(await fs.readFile(file, "utf8")).toBe("x");
  });

  it("overwrites existing files and reports diff metadata", async () => {
    const file = path.join(tmpDir, "f.txt");
    await fs.writeFile(file, "old\ncontent");
    const r = await writeFile.execute({ path: file, content: "new\ncontent" }, { cwd: tmpDir });
    expect(r.content).toMatch(/Overwrote/);
    expect(await fs.readFile(file, "utf8")).toBe("new\ncontent");
    if (r.display?.kind !== "diff") throw new Error("expected diff display");
    expect(r.display.before).toBe("old\ncontent");
    expect(r.display.after).toBe("new\ncontent");
  });

  it("rejects non-string content", async () => {
    await expect(
      writeFile.execute({ path: "x", content: 5 }, { cwd: tmpDir }),
    ).rejects.toThrow();
  });

  it("accepts 'file_path' as an alias for 'path' (model alias tolerance)", async () => {
    const file = path.join(tmpDir, "alias.txt");
    const r = await writeFile.execute(
      { file_path: file, content: "via alias" },
      { cwd: tmpDir },
    );
    expect(r.isError).not.toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("via alias");
  });

  it("accepts 'filename' as an alias too", async () => {
    const file = path.join(tmpDir, "fn.txt");
    const r = await writeFile.execute(
      { filename: file, content: "via filename" },
      { cwd: tmpDir },
    );
    expect(r.isError).not.toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("via filename");
  });

  it("error message names 'path' as canonical and mentions the alias", async () => {
    let err: Error | undefined;
    try {
      await writeFile.execute({ content: "x" }, { cwd: tmpDir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("'path'");
    expect(err!.message).toContain("file_path");
  });
});
