import { describe, expect, it } from "vitest";
import { parseSseStream, parseSseRecord } from "../../src/api/sse.js";

function chunks(parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, void> {
      for (const p of parts) yield enc.encode(p);
    },
  };
}

async function collect(
  src: AsyncIterable<Uint8Array>,
): Promise<ReturnType<typeof parseSseRecord>> {
  const out: ReturnType<typeof parseSseRecord> = [];
  for await (const ev of parseSseStream(src)) out.push(ev);
  return out;
}

describe("parseSseRecord", () => {
  it("parses a delta event", () => {
    const out = parseSseRecord('data: {"type":"delta","content":"hi"}');
    expect(out).toEqual([
      { kind: "event", event: { type: "delta", content: "hi" } },
    ]);
  });

  it("parses a [DONE] sentinel", () => {
    const out = parseSseRecord("data: [DONE]");
    expect(out).toEqual([{ kind: "done" }]);
  });

  it("ignores comment and unknown lines", () => {
    const out = parseSseRecord(
      [": ping", "event: foo", 'data: {"type":"delta","content":"x"}'].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "event" });
  });

  it("flags malformed JSON", () => {
    const out = parseSseRecord("data: {not json");
    expect(out[0]).toMatchObject({ kind: "malformed", reason: "invalid_json" });
  });

  it("flags schema-invalid payloads", () => {
    const out = parseSseRecord('data: {"type":"unknown"}');
    expect(out[0]?.kind).toBe("malformed");
  });
});

describe("parseSseStream", () => {
  it("parses a complete normal stream", async () => {
    const stream = chunks([
      'data: {"type":"start","conversation_id":"c1","message_id":"m1"}\n\n',
      'data: {"type":"delta","content":"Hello"}\n\n',
      'data: {"type":"delta","content":" world"}\n\n',
      'data: {"type":"end","finish_reason":"stop"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect(stream);
    expect(events.map((e) => e.kind)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "done",
    ]);
    const deltas = events
      .filter((e) => e.kind === "event" && e.event.type === "delta")
      // @ts-expect-error narrowing
      .map((e) => e.event.content);
    expect(deltas.join("")).toBe("Hello world");
  });

  it("handles a record split across chunk boundaries", async () => {
    const stream = chunks([
      'data: {"type":"de',
      'lta","content":"abc"}',
      "\n\n",
      "data: [DONE]\n\n",
    ]);
    const events = await collect(stream);
    expect(events).toEqual([
      { kind: "event", event: { type: "delta", content: "abc" } },
      { kind: "done" },
    ]);
  });

  it("emits an error event mid-stream", async () => {
    const stream = chunks([
      'data: {"type":"start","conversation_id":"c","message_id":"m"}\n\n',
      'data: {"type":"error","code":"upstream_error","message":"vLLM unreachable"}\n\n',
    ]);
    const events = await collect(stream);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      kind: "event",
      event: {
        type: "error",
        code: "upstream_error",
        message: "vLLM unreachable",
      },
    });
  });

  it("tolerates CRLF line endings", async () => {
    const stream = chunks([
      'data: {"type":"delta","content":"x"}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ]);
    const events = await collect(stream);
    expect(events.map((e) => e.kind)).toEqual(["event", "done"]);
  });
});
