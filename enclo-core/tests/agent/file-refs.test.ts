import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expandFileRefs,
  extractFileRefs,
  MAX_FILES_PER_MESSAGE,
} from "../../src/agent/file-refs.js";

describe("extractFileRefs", () => {
  it("picks up paths with slashes", () => {
    const refs = extractFileRefs("look at @src/foo.ts and @docs/readme");
    expect(refs).toEqual(["src/foo.ts", "docs/readme"]);
  });

  it("picks up bare files when extension is known", () => {
    const refs = extractFileRefs("see @README.md and @types.ts please");
    expect(refs).toEqual(["README.md", "types.ts"]);
  });

  it("accepts ./, ../, /, and ~ prefixes", () => {
    const refs = extractFileRefs("@./a.txt @../b.txt @/etc/hosts @~/notes");
    expect(refs).toEqual(["./a.txt", "../b.txt", "/etc/hosts", "~/notes"]);
  });

  it("ignores @username (no slash, no known extension)", () => {
    expect(extractFileRefs("hi @alice and @bob, what's up?")).toEqual([]);
  });

  it("ignores @user@host.com style email-like tokens", () => {
    // The leading @ is at word start; @host.com is preceded by @ (not whitespace)
    // and our regex requires whitespace/start before @ — so neither matches.
    const refs = extractFileRefs("contact me at user@host.com");
    expect(refs).toEqual([]);
  });

  it("strips trailing punctuation", () => {
    const refs = extractFileRefs("read @src/foo.ts, then @bar/baz.ts.");
    expect(refs).toEqual(["src/foo.ts", "bar/baz.ts"]);
  });

  it("dedupes repeated refs", () => {
    const refs = extractFileRefs("@foo.ts and again @foo.ts");
    expect(refs).toEqual(["foo.ts"]);
  });

  it("returns empty for plain text", () => {
    expect(extractFileRefs("just a normal message with no refs")).toEqual([]);
  });

  it("handles ref at the start of the message", () => {
    expect(extractFileRefs("@README.md please")).toEqual(["README.md"]);
  });
});

let workdir: string;
beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-frefs-"));
});
afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe("expandFileRefs", () => {
  it("inlines a single referenced file", async () => {
    const file = path.join(workdir, "hello.ts");
    await fs.writeFile(file, "export const x = 1;");
    const res = await expandFileRefs("look at @hello.ts please", workdir);
    expect(res.includedFiles).toHaveLength(1);
    expect(res.includedFiles[0]?.path).toBe(file);
    expect(res.expandedText).toContain(`<file path="${file}">`);
    expect(res.expandedText).toContain("export const x = 1;");
    expect(res.expandedText).toContain("</file>");
    expect(res.expandedText).toContain("look at");
    expect(res.expandedText).toContain("please");
    expect(res.errors).toEqual([]);
  });

  it("expands a glob pattern (** wildcards) with junk dirs excluded", async () => {
    await fs.mkdir(path.join(workdir, "src", "a"), { recursive: true });
    await fs.mkdir(path.join(workdir, "node_modules", "skip"), { recursive: true });
    await fs.writeFile(path.join(workdir, "src", "a", "x.ts"), "x");
    await fs.writeFile(path.join(workdir, "src", "y.ts"), "y");
    await fs.writeFile(path.join(workdir, "node_modules", "skip", "z.ts"), "z");

    const res = await expandFileRefs("review @src/**/*.ts", workdir);
    const paths = res.includedFiles.map((f) => f.path).sort();
    expect(paths).toEqual([
      path.join(workdir, "src", "a", "x.ts"),
      path.join(workdir, "src", "y.ts"),
    ]);
    // node_modules contents must NOT have been included.
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  it("respects the max-files cap", async () => {
    for (let i = 0; i < 8; i += 1) {
      await fs.writeFile(path.join(workdir, `f${i}.ts`), `export const v = ${i};`);
    }
    const res = await expandFileRefs("look at @*.ts", workdir);
    expect(res.includedFiles).toHaveLength(MAX_FILES_PER_MESSAGE);
    expect(res.errors.some((e) => /max-files cap/.test(e))).toBe(true);
  });

  it("emits a friendly error when a referenced file is missing and preserves the literal", async () => {
    const res = await expandFileRefs("see @missing/file.ts here", workdir);
    expect(res.includedFiles).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/file not found/);
    expect(res.expandedText).toContain("@missing/file.ts");
  });

  it("emits an error when a file exceeds the per-file size cap", async () => {
    const big = path.join(workdir, "big.ts");
    await fs.writeFile(big, "x".repeat(2048));
    const res = await expandFileRefs("@big.ts", workdir, { maxBytesPerFile: 256 });
    expect(res.includedFiles).toEqual([]);
    expect(res.errors[0]).toMatch(/too large/);
    expect(res.expandedText).toContain("@big.ts");
  });

  it("leaves @username-style tokens alone (no match → literal preserved)", async () => {
    const res = await expandFileRefs("cc @alice and @bob", workdir);
    expect(res.includedFiles).toEqual([]);
    expect(res.errors).toEqual([]);
    expect(res.expandedText).toBe("cc @alice and @bob");
  });

  it("returns the original text unchanged when there are no refs", async () => {
    const res = await expandFileRefs("hello world", workdir);
    expect(res.expandedText).toBe("hello world");
    expect(res.includedFiles).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it("reports no-match for a glob that finds nothing", async () => {
    const res = await expandFileRefs("@no-such/**/*.ts", workdir);
    expect(res.includedFiles).toEqual([]);
    expect(res.errors[0]).toMatch(/no files matched/);
  });
});
