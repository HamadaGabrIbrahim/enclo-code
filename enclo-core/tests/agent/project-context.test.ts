import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findProjectContext,
  listSearchPaths,
  MAX_PROJECT_CONTEXT_BYTES,
} from "../../src/agent/project-context.js";

let tmpHome: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-home-"));
  tmpRoot = await fs.mkdtemp(path.join(tmpHome, "proj-"));
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("findProjectContext", () => {
  it("discovers enclo.md from a nested cwd", async () => {
    const nested = path.join(tmpRoot, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    const target = path.join(tmpRoot, "enclo.md");
    await fs.writeFile(target, "# project rules\nprefer foo over bar.");

    const ctx = await findProjectContext(nested, { stopAt: tmpHome });
    expect(ctx).not.toBeNull();
    expect(ctx?.path).toBe(target);
    expect(ctx?.content).toContain("prefer foo over bar");
  });

  it("falls through to .enclo/enclo.md when no top-level enclo.md exists", async () => {
    const sub = path.join(tmpRoot, "sub");
    await fs.mkdir(path.join(tmpRoot, ".enclo"), { recursive: true });
    await fs.mkdir(sub);
    const target = path.join(tmpRoot, ".enclo", "enclo.md");
    await fs.writeFile(target, "subdir form");

    const ctx = await findProjectContext(sub, { stopAt: tmpHome });
    expect(ctx?.path).toBe(target);
    expect(ctx?.content).toBe("subdir form");
  });

  it("prefers a top-level enclo.md over .enclo/enclo.md in the same dir", async () => {
    await fs.mkdir(path.join(tmpRoot, ".enclo"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, ".enclo", "enclo.md"), "subdir");
    await fs.writeFile(path.join(tmpRoot, "enclo.md"), "toplevel");

    const ctx = await findProjectContext(tmpRoot, { stopAt: tmpHome });
    expect(ctx?.content).toBe("toplevel");
  });

  it("returns null when no enclo.md exists in any ancestor", async () => {
    const nested = path.join(tmpRoot, "x", "y");
    await fs.mkdir(nested, { recursive: true });
    const ctx = await findProjectContext(nested, { stopAt: tmpHome });
    expect(ctx).toBeNull();
  });

  it("warns and returns null when enclo.md exceeds the size cap", async () => {
    const target = path.join(tmpRoot, "enclo.md");
    await fs.writeFile(target, "x".repeat(200));
    const warnings: string[] = [];
    const ctx = await findProjectContext(tmpRoot, {
      stopAt: tmpHome,
      maxBytes: 50,
      onWarn: (m) => warnings.push(m),
    });
    expect(ctx).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipping/);
    expect(warnings[0]).toMatch(/cap 50/);
  });

  it("invalidates by changing cwd: a sibling tree without enclo.md returns null", async () => {
    const projA = await fs.mkdtemp(path.join(tmpHome, "projA-"));
    const projB = await fs.mkdtemp(path.join(tmpHome, "projB-"));
    await fs.writeFile(path.join(projA, "enclo.md"), "rules for A");

    const ctxA = await findProjectContext(projA, { stopAt: tmpHome });
    expect(ctxA?.content).toBe("rules for A");

    const ctxB = await findProjectContext(projB, { stopAt: tmpHome });
    expect(ctxB).toBeNull();
  });

  it("walks up exactly to stopAt and no further", async () => {
    // Place enclo.md just outside the stop boundary; should NOT be found.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-outside-"));
    try {
      await fs.writeFile(path.join(outside, "enclo.md"), "should not be loaded");
      const ctx = await findProjectContext(tmpRoot, { stopAt: tmpHome });
      expect(ctx).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("default cap matches MAX_PROJECT_CONTEXT_BYTES (50 KB)", () => {
    expect(MAX_PROJECT_CONTEXT_BYTES).toBe(50 * 1024);
  });
});

describe("listSearchPaths", () => {
  it("lists both filename forms at every ancestor up to stopAt", async () => {
    const nested = path.join(tmpRoot, "a", "b");
    const paths = listSearchPaths(nested, tmpHome);
    expect(paths).toContain(path.join(nested, "enclo.md"));
    expect(paths).toContain(path.join(nested, ".enclo", "enclo.md"));
    expect(paths).toContain(path.join(tmpRoot, "enclo.md"));
    expect(paths).toContain(path.join(tmpHome, "enclo.md"));
  });
});
