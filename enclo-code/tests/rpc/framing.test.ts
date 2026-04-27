import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  parseStream,
  writeMessage,
  FramingError,
  type JsonRpcMessage,
} from "../../src/rpc/framing.js";

function frame(json: string): string {
  const body = Buffer.byteLength(json, "utf8");
  return `Content-Length: ${body}\r\n\r\n${json}`;
}

function streamFrom(chunks: (string | Buffer)[]): Readable {
  const arr = chunks.map((c) => (typeof c === "string" ? Buffer.from(c, "utf8") : c));
  return Readable.from(arr);
}

class CapturingWritable extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function collect(input: Readable): Promise<JsonRpcMessage[]> {
  const out: JsonRpcMessage[] = [];
  for await (const m of parseStream(input)) out.push(m);
  return out;
}

describe("parseStream", () => {
  it("parses a single complete message", async () => {
    const input = streamFrom([
      frame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { x: 1 } })),
    ]);
    const messages = await collect(input);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { x: 1 },
    });
  });

  it("parses multiple back-to-back messages in one chunk", async () => {
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" });
    const b = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" });
    const c = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "c" });
    const input = streamFrom([frame(a) + frame(b) + frame(c)]);
    const messages = await collect(input);
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it("handles split chunks across the header boundary", async () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "split" });
    const framed = frame(json);
    // Split the framed bytes into 4 random small chunks.
    const buf = Buffer.from(framed, "utf8");
    const chunks: Buffer[] = [
      buf.subarray(0, 5),
      buf.subarray(5, 12),
      buf.subarray(12, 30),
      buf.subarray(30),
    ];
    const input = streamFrom(chunks);
    const messages = await collect(input);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { method: string }).method).toBe("split");
  });

  it("handles a chunk that contains a full message plus a partial next one", async () => {
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" });
    const b = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" });
    const framedA = frame(a);
    const framedB = frame(b);
    const splitPoint = framedB.length - 5;
    const input = streamFrom([
      framedA + framedB.slice(0, splitPoint),
      framedB.slice(splitPoint),
    ]);
    const messages = await collect(input);
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2]);
  });

  it("rejects malformed Content-Length", async () => {
    const input = streamFrom(["Content-Length: NaN\r\n\r\n{}"]);
    await expect(async () => {
      await collect(input);
    }).rejects.toThrow(FramingError);
  });

  it("rejects missing Content-Length header", async () => {
    const input = streamFrom(["X-Other: 1\r\n\r\n{}"]);
    await expect(async () => {
      await collect(input);
    }).rejects.toThrow(FramingError);
  });

  it("rejects malformed JSON body", async () => {
    const input = streamFrom(["Content-Length: 4\r\n\r\nnope"]);
    await expect(async () => {
      await collect(input);
    }).rejects.toThrow(FramingError);
  });

  it("preserves UTF-8 multibyte characters via byte-length framing", async () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: { s: "héllo🌟" } });
    const input = streamFrom([frame(json)]);
    const messages = await collect(input);
    expect((messages[0] as { params: { s: string } }).params.s).toBe("héllo🌟");
  });
});

describe("writeMessage", () => {
  it("frames a simple response", () => {
    const out = new CapturingWritable();
    writeMessage(out, { jsonrpc: "2.0", id: 1, result: { ok: true } });
    const text = out.text();
    expect(text.startsWith("Content-Length: ")).toBe(true);
    const idx = text.indexOf("\r\n\r\n");
    expect(idx).toBeGreaterThan(0);
    const headerLen = Number(text.slice("Content-Length: ".length, idx));
    const body = text.slice(idx + 4);
    expect(Buffer.byteLength(body, "utf8")).toBe(headerLen);
    expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("round-trips a notification with multibyte content", async () => {
    const out = new CapturingWritable();
    writeMessage(out, {
      jsonrpc: "2.0",
      method: "notify",
      params: { msg: "résumé 🎉" },
    });
    const buf = Buffer.concat(out.chunks);
    const input = Readable.from([buf]);
    const messages = await collect(input);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { params: { msg: string } }).params.msg).toBe("résumé 🎉");
  });
});
