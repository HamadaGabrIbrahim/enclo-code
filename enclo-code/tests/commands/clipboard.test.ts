import { describe, expect, it } from "vitest";

import {
  detectPlatform,
  tryReadClipboardImage,
  type Platform,
} from "../../src/commands/clipboard.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from("payload")]);

describe("detectPlatform", () => {
  it("recognizes the three first-class platforms", () => {
    expect(detectPlatform("darwin")).toBe("darwin");
    expect(detectPlatform("linux")).toBe("linux");
    expect(detectPlatform("win32")).toBe("win32");
  });

  it("falls back to 'other' for unknown platforms", () => {
    expect(detectPlatform("aix")).toBe("other");
    expect(detectPlatform("freebsd")).toBe("other");
  });
});

describe("tryReadClipboardImage", () => {
  it("returns a PNG data URL when the platform reader yields PNG bytes", async () => {
    const got: Platform[] = [];
    const img = await tryReadClipboardImage({
      platform: "darwin",
      sequence: 1,
      readImage: async (p) => {
        got.push(p);
        return PNG_BYTES;
      },
    });
    expect(got).toEqual(["darwin"]);
    expect(img).not.toBeNull();
    expect(img?.name).toBe("clipboard-1.png");
    expect(img?.sizeBytes).toBe(PNG_BYTES.length);
    expect(img?.base64DataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Buffer.from(
      img?.base64DataUrl.split(",")[1] ?? "",
      "base64",
    );
    expect(decoded.equals(PNG_BYTES)).toBe(true);
  });

  it("auto-names with the supplied sequence number", async () => {
    const img = await tryReadClipboardImage({
      platform: "linux",
      sequence: 7,
      readImage: async () => PNG_BYTES,
    });
    expect(img?.name).toBe("clipboard-7.png");
  });

  it("returns null when the reader yields null (no image on clipboard)", async () => {
    const img = await tryReadClipboardImage({
      platform: "linux",
      sequence: 1,
      readImage: async () => null,
    });
    expect(img).toBeNull();
  });

  it("returns null when the reader yields non-PNG bytes (we only accept PNG in v1)", async () => {
    const img = await tryReadClipboardImage({
      platform: "linux",
      sequence: 1,
      readImage: async () => Buffer.from("not a png at all"),
    });
    expect(img).toBeNull();
  });

  it("returns null when the reader throws (clipboard tool missing or no image)", async () => {
    const img = await tryReadClipboardImage({
      platform: "linux",
      sequence: 1,
      readImage: async () => {
        throw new Error("xclip: command not found");
      },
    });
    expect(img).toBeNull();
  });

  it("returns null when the buffer is empty", async () => {
    const img = await tryReadClipboardImage({
      platform: "darwin",
      sequence: 1,
      readImage: async () => Buffer.alloc(0),
    });
    expect(img).toBeNull();
  });

  it("enforces the maxBytes cap (default 5 MB; overridable in tests)", async () => {
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024)]);
    const img = await tryReadClipboardImage({
      platform: "darwin",
      sequence: 1,
      readImage: async () => big,
      maxBytes: 100,
    });
    expect(img).toBeNull();
  });

  it("dispatches to the windows platform branch", async () => {
    const got: Platform[] = [];
    await tryReadClipboardImage({
      platform: "win32",
      sequence: 1,
      readImage: async (p) => {
        got.push(p);
        return PNG_BYTES;
      },
    });
    expect(got).toEqual(["win32"]);
  });
});
