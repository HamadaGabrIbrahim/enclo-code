import { describe, expect, it } from "vitest";
import { COMMANDS, isSlash, parseSlash } from "../src/commands/registry.js";

describe("parseSlash", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlash("hello there")).toBeNull();
    expect(parseSlash("")).toBeNull();
    expect(parseSlash("  hi /models")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(parseSlash("/nope")).toBeNull();
  });

  it.each(COMMANDS.map((c) => c.name))("dispatches /%s", (name) => {
    expect(parseSlash(`/${name}`)).toEqual({ name, args: [] });
  });

  it("preserves args after the command", () => {
    expect(parseSlash("/models foo bar")).toEqual({
      name: "models",
      args: ["foo", "bar"],
    });
  });

  it("is case-insensitive on the command name", () => {
    expect(parseSlash("/HELP")).toEqual({ name: "help", args: [] });
  });

  it("trims leading whitespace before the slash", () => {
    expect(parseSlash("   /clear")).toEqual({ name: "clear", args: [] });
  });
});

describe("isSlash", () => {
  it("returns true for any line starting with / (after trim)", () => {
    expect(isSlash("/foo")).toBe(true);
    expect(isSlash("  /bar")).toBe(true);
  });
  it("returns false otherwise", () => {
    expect(isSlash("hello")).toBe(false);
  });
});

describe("COMMANDS registry", () => {
  it("contains all required slash commands", () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "agents",
        "allow",
        "cd",
        "clear",
        "context",
        "exit",
        "help",
        "history",
        "hooks",
        "image",
        "list",
        "mcp",
        "models",
        "plan",
        "reasoning",
        "reload-agents",
        "reload-commands",
        "reload-context",
        "reload-hooks",
        "reload-mcp",
        "resume",
        "signin",
        "signout",
        "signup",
        "tools",
      ].sort(),
    );
  });
});
