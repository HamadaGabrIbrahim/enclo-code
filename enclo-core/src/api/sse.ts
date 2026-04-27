import { StreamEventSchema, type StreamEvent } from "./schemas.js";

/**
 * Discriminated union of every event the CLI can observe while reading an SSE
 * body. `done` is the sentinel emitted on `data: [DONE]`.
 */
export type ParsedEvent =
  | { kind: "event"; event: StreamEvent }
  | { kind: "done" }
  | { kind: "malformed"; raw: string; reason: string };

/**
 * Parse a single SSE record (the text between two blank-line separators) into
 * zero or more parsed events. SSE allows multiple `data:` lines per record;
 * we concatenate them with newlines as the spec dictates.
 */
export function parseSseRecord(record: string): ParsedEvent[] {
  const dataLines: string[] = [];
  for (const rawLine of record.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment
    if (!line.startsWith("data:")) continue; // ignore event:/id:/retry:
    const value = line.slice(5).replace(/^ /, "");
    dataLines.push(value);
  }
  if (dataLines.length === 0) return [];
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return [{ kind: "done" }];
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch {
    return [{ kind: "malformed", raw: payload, reason: "invalid_json" }];
  }
  const result = StreamEventSchema.safeParse(parsedJson);
  if (!result.success) {
    return [
      {
        kind: "malformed",
        raw: payload,
        reason: result.error.issues.map((i) => i.message).join("; "),
      },
    ];
  }
  return [{ kind: "event", event: result.data }];
}

/**
 * Consume an async iterable (or ReadableStream) of Uint8Array chunks and yield
 * `ParsedEvent`s as records arrive. Records are delimited by a blank line.
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedEvent, void, void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  for await (const chunk of toAsyncIterable(source)) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, remainder } = drainBuffer(buffer);
    buffer = remainder;
    for (const ev of events) yield ev;
  }
  buffer += decoder.decode();
  // Flush any final record that wasn't terminated by a blank line.
  const normalized = buffer.replace(/\r\n/g, "\n").trim();
  if (normalized.length > 0) {
    for (const ev of parseSseRecord(normalized)) yield ev;
  }
}

function drainBuffer(buffer: string): {
  events: ParsedEvent[];
  remainder: string;
} {
  const events: ParsedEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    if (part.length === 0) continue;
    events.push(...parseSseRecord(part));
  }
  return { events, remainder };
}

function toAsyncIterable(
  src: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in (src as object)) {
    return src as AsyncIterable<Uint8Array>;
  }
  const stream = src as ReadableStream<Uint8Array>;
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const reader = stream.getReader();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const { value, done } = await reader.read();
          if (done) return { value: undefined, done: true };
          return { value: value as Uint8Array, done: false };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await reader.cancel();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
