import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFile } from "../../src/tools/edit_file.js";

let tmpDir: string;
let file: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-ef-"));
  file = path.join(tmpDir, "f.txt");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("declares write permission", () => {
    expect(editFile.requiresPermission).toBe(true);
    expect(editFile.category).toBe("write");
  });

  it("performs an exact-string replacement", async () => {
    await fs.writeFile(file, "alpha beta gamma\n");
    const r = await editFile.execute(
      { path: file, old_string: "beta", new_string: "BETA" },
      { cwd: tmpDir },
    );
    expect(r.isError).not.toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("alpha BETA gamma\n");
    expect(r.display?.kind).toBe("diff");
  });

  it("rejects when old_string is missing", async () => {
    await fs.writeFile(file, "alpha beta gamma\n");
    const r = await editFile.execute(
      { path: file, old_string: "delta", new_string: "DELTA" },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it("rejects when old_string is ambiguous (without replace_all)", async () => {
    await fs.writeFile(file, "x\nx\nx\n");
    const r = await editFile.execute(
      { path: file, old_string: "x", new_string: "y" },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/3 times/);
  });

  it("supports replace_all for repeated matches", async () => {
    await fs.writeFile(file, "x\nx\nx\n");
    const r = await editFile.execute(
      { path: file, old_string: "x", new_string: "y", replace_all: true },
      { cwd: tmpDir },
    );
    expect(r.isError).not.toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("y\ny\ny\n");
    expect(r.content).toMatch(/3 replacements/);
  });

  it("rejects no-op edits where old===new", async () => {
    await fs.writeFile(file, "abc");
    const r = await editFile.execute(
      { path: file, old_string: "abc", new_string: "abc" },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/identical/);
  });

  it("returns an error result when the file does not exist", async () => {
    const r = await editFile.execute(
      { path: path.join(tmpDir, "missing"), old_string: "a", new_string: "b" },
      { cwd: tmpDir },
    );
    expect(r.isError).toBe(true);
  });
});
