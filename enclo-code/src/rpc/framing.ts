/**
 * LSP-style Content-Length framing for JSON-RPC over stdio.
 *
 * Wire format:
 *   Content-Length: <N>\r\n
 *   \r\n
 *   <N bytes of UTF-8 JSON>
 *
 * The parser is robust to TCP-style chunking — it buffers across reads until
 * a full message is available, then yields it. Multiple back-to-back messages
 * in a single chunk are supported.
 */
import type { Readable, Writable } from "node:stream";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/**
 * Async iterator over framed JSON-RPC messages read from `input`. Yields each
 * decoded JSON object as it becomes available. Throws `FramingError` on a
 * malformed Content-Length header (e.g. non-numeric value, missing header).
 *
 * Bytes that don't form a complete frame are buffered and combined with the
 * next chunk; the iterator only ends once the underlying stream ends.
 */
export async function* parseStream(
  input: Readable,
): AsyncGenerator<JsonRpcMessage, void, void> {
  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);

    // Drain as many complete messages as the buffer holds.
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerStr = buffer.subarray(0, headerEnd).toString("utf8");
      const length = parseContentLength(headerStr);
      const bodyStart = headerEnd + 4;
      const total = bodyStart + length;
      if (buffer.length < total) break;
      const bodyBuf = buffer.subarray(bodyStart, total);
      buffer = buffer.subarray(total);
      const text = bodyBuf.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new FramingError(`invalid JSON in body: ${(err as Error).message}`);
      }
      yield parsed as JsonRpcMessage;
    }
  }
}

/**
 * Frame and synchronously write a single JSON-RPC message to `output`. Uses
 * UTF-8 byte length for Content-Length (so multibyte characters in strings
 * round-trip correctly).
 */
export function writeMessage(output: Writable, msg: JsonRpcMessage): void {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, "utf8");
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  output.write(header);
  output.write(body);
}

function parseContentLength(headerStr: string): number {
  const lines = headerStr.split(/\r\n/);
  let length: number | undefined;
  for (const line of lines) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new FramingError(`malformed header line: ${line}`);
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-length") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new FramingError(`invalid Content-Length: ${value}`);
      }
      length = n;
    }
  }
  if (length === undefined) {
    throw new FramingError("missing Content-Length header");
  }
  return length;
}
