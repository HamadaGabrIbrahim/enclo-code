import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { glyph } from "../../src/util/glyphs.js";

const KEY = "ENCLO_ASCII";

describe("glyph()", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("returns unicode glyphs by default", () => {
    delete process.env[KEY];
    expect(glyph("cursor")).toBe("❯");
    expect(glyph("check")).toBe("✓");
    expect(glyph("cross")).toBe("✗");
    expect(glyph("ellipsis")).toBe("…");
  });

  it("returns ascii fallbacks when ENCLO_ASCII=1", () => {
    process.env[KEY] = "1";
    expect(glyph("cursor")).toBe(">");
    expect(glyph("check")).toBe("[x]");
    expect(glyph("cross")).toBe("[ ]");
    expect(glyph("ellipsis")).toBe("...");
    expect(glyph("zwsp")).toBe("");
  });

  it("does not flip when the env var is anything other than '1'", () => {
    process.env[KEY] = "yes";
    expect(glyph("cursor")).toBe("❯");
    process.env[KEY] = "0";
    expect(glyph("cursor")).toBe("❯");
    process.env[KEY] = "";
    expect(glyph("cursor")).toBe("❯");
  });
});
