import { describe, expect, it } from "vitest";
import {
  attachImage,
  buildMultiModalContent,
  formatBytes,
  MAX_IMAGE_BYTES,
  type PendingImage,
} from "../../src/commands/image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fsWith(map: Record<string, Buffer | Error>): { readFile: (p: string) => Promise<Buffer> } {
  return {
    async readFile(p: string): Promise<Buffer> {
      const v = map[p];
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

describe("attachImage", () => {
  it("attaches a valid PNG and base64-encodes it", async () => {
    const fs = fsWith({ "/work/foo.png": PNG_MAGIC });
    const res = await attachImage("foo.png", { cwd: "/work", fs });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.image.name).toBe("foo.png");
    expect(res.image.mime).toBe("image/png");
    expect(res.image.bytes).toBe(PNG_MAGIC.length);
    expect(res.image.base64DataUrl).toMatch(/^data:image\/png;base64,/);
    // round-trip the base64 content
    const decoded = Buffer.from(res.image.base64DataUrl.split(",")[1] ?? "", "base64");
    expect(decoded.equals(PNG_MAGIC)).toBe(true);
  });

  it("accepts .jpg, .jpeg, .webp, and .gif extensions", async () => {
    const fs = fsWith({
      "/w/a.jpg": Buffer.from([0xff, 0xd8]),
      "/w/b.jpeg": Buffer.from([0xff, 0xd8]),
      "/w/c.webp": Buffer.from([0x52, 0x49, 0x46, 0x46]),
      "/w/d.gif": Buffer.from([0x47, 0x49, 0x46, 0x38]),
    });
    const a = await attachImage("a.jpg", { cwd: "/w", fs });
    const b = await attachImage("b.jpeg", { cwd: "/w", fs });
    const c = await attachImage("c.webp", { cwd: "/w", fs });
    const d = await attachImage("d.gif", { cwd: "/w", fs });
    expect(a.ok && a.image.mime).toBe("image/jpeg");
    expect(b.ok && b.image.mime).toBe("image/jpeg");
    expect(c.ok && c.image.mime).toBe("image/webp");
    expect(d.ok && d.image.mime).toBe("image/gif");
  });

  it("rejects unsupported extensions like .pdf", async () => {
    const fs = fsWith({ "/w/x.pdf": Buffer.from("%PDF-1.7") });
    const res = await attachImage("x.pdf", { cwd: "/w", fs });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unsupported extension/);
    expect(res.error).toMatch(/\.pdf/);
  });

  it("rejects files larger than the cap with a friendly message", async () => {
    const big = Buffer.alloc(7 * 1024 * 1024);
    const fs = fsWith({ "/w/big.png": big });
    const res = await attachImage("big.png", { cwd: "/w", fs });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/too large/);
    // The default cap is 5 MB.
    expect(res.error).toMatch(/5\.0MB cap/);
  });

  it("respects a custom cap (used in tests)", async () => {
    const fs = fsWith({ "/w/k.png": Buffer.alloc(2000) });
    const res = await attachImage("k.png", { cwd: "/w", fs, maxBytes: 1024 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/too large/);
  });

  it("returns a friendly error when the file is missing", async () => {
    const fs = fsWith({});
    const res = await attachImage("nope.png", { cwd: "/w", fs });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/ENOENT/);
  });

  it("rejects empty paths", async () => {
    const res = await attachImage("   ", { cwd: "/w" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/usage/);
  });

  it("resolves relative paths against cwd", async () => {
    const fs = fsWith({ "/work/sub/dir/foo.png": PNG_MAGIC });
    const res = await attachImage("sub/dir/foo.png", { cwd: "/work", fs });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.image.path).toBe("/work/sub/dir/foo.png");
  });

  it("default cap matches MAX_IMAGE_BYTES (5 MB)", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("buildMultiModalContent", () => {
  it("serializes a text+image message into the multi-modal content array", () => {
    const img: PendingImage = {
      path: "/w/foo.png",
      name: "foo.png",
      base64DataUrl: "data:image/png;base64,QUJDRA==",
      bytes: 4,
      mime: "image/png",
    };
    const content = buildMultiModalContent("what is this?", [img]);
    expect(content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
    ]);
  });

  it("omits the text block when text is empty", () => {
    const img: PendingImage = {
      path: "/w/foo.png",
      name: "foo.png",
      base64DataUrl: "data:image/png;base64,xx",
      bytes: 1,
      mime: "image/png",
    };
    const content = buildMultiModalContent("", [img]);
    expect(content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ]);
  });

  it("supports multiple images", () => {
    const a: PendingImage = {
      path: "/w/a.png",
      name: "a.png",
      base64DataUrl: "data:image/png;base64,a",
      bytes: 1,
      mime: "image/png",
    };
    const b: PendingImage = {
      path: "/w/b.jpg",
      name: "b.jpg",
      base64DataUrl: "data:image/jpeg;base64,b",
      bytes: 1,
      mime: "image/jpeg",
    };
    const content = buildMultiModalContent("compare", [a, b]);
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "compare" });
    expect(content[1]?.type).toBe("image_url");
    expect(content[2]?.type).toBe("image_url");
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatBytes(500)).toBe("500B");
    expect(formatBytes(2048)).toBe("2KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
  });
});

describe("multi-modal end-to-end through the agent loop", () => {
  it("sends a multi-modal user message to the API adapter", async () => {
    const { runAgent, makeRegistry, createPermissionManager } = await import("@enclo/core");
    const captured: unknown[] = [];
    const api = {
      async streamChat(req: { messages: unknown[]; tools: unknown[] }) {
        captured.push(...req.messages);
        return {
          events: (async function* () {
            yield { type: "delta" as const, content: "ok" };
            yield { type: "end" as const, finishReason: "stop" };
          })(),
        };
      },
    };
    const img: PendingImage = {
      path: "/w/foo.png",
      name: "foo.png",
      base64DataUrl: "data:image/png;base64,xx",
      bytes: 2,
      mime: "image/png",
    };
    const content = buildMultiModalContent("look", [img]);
    const events: unknown[] = [];
    for await (const ev of runAgent({
      api,
      tools: makeRegistry([]),
      permissions: createPermissionManager(),
      cwd: "/w",
      history: [],
      userInput: content,
    })) {
      events.push(ev);
    }
    const userMsg = captured.find(
      (m): m is { role: string; content: unknown } =>
        typeof m === "object" && m !== null && (m as { role?: string }).role === "user",
    );
    expect(userMsg?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ]);
  });
});
