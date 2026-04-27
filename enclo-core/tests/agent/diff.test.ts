import { describe, expect, it } from "vitest";
import { lineDiff } from "../../src/agent/diff.js";

describe("lineDiff", () => {
  it("returns nothing surprising when files are identical", () => {
    // No add/del ops, and context-collapsing eats every ctx line because
    // there is no neighboring change.
    const out = lineDiff("a\nb\nc", "a\nb\nc");
    expect(out.filter((l) => l.kind !== "ctx")).toEqual([]);
  });

  it("flags added lines", () => {
    const out = lineDiff("a\nb", "a\nb\nc");
    expect(out.some((l) => l.kind === "add" && l.text === "c")).toBe(true);
  });

  it("flags deleted lines", () => {
    const out = lineDiff("a\nb\nc", "a\nc");
    expect(out.some((l) => l.kind === "del" && l.text === "b")).toBe(true);
  });

  it("includes context around changes", () => {
    const out = lineDiff("a\nb\nc\nd\ne", "a\nb\nC\nd\ne", 1);
    const kinds = out.map((l) => l.kind);
    expect(kinds).toContain("ctx");
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
  });
});
