import { describe, expect, it } from "vitest";
import {
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type ApiAdapter,
  type ChatRequest,
  type ChatStream,
  type StreamEvent,
} from "../../src/agent/loop.js";
import { makeRegistry, type Tool } from "../../src/tools/types.js";
import { createPermissionManager } from "../../src/agent/permissions.js";

function streamFrom(events: StreamEvent[]): ChatStream {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

function fakeApi(turns: StreamEvent[][]): {
  api: ApiAdapter;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    requests,
    api: {
      async streamChat(req) {
        requests.push({
          messages: req.messages.map((m) => ({ ...m })) as AgentMessage[],
          tools: req.tools,
        });
        const turn = turns[i] ?? [{ type: "end", finishReason: "stop" }];
        i += 1;
        return streamFrom(turn);
      },
    },
  };
}

const echoTool: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "echo",
      description: "Echo a value back",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  },
  async execute(args) {
    const v = (args as { value: string }).value;
    return { content: `echoed: ${v}` };
  },
};

const writeTool: Tool = {
  category: "write",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "destructive",
      description: "Pretend to write",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    return { content: "written" };
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("runAgent", () => {
  it("ends after a single turn when the model returns plain text", async () => {
    const { api, requests } = fakeApi([
      [
        { type: "delta", content: "hello " },
        { type: "delta", content: "world" },
        { type: "end", finishReason: "stop" },
      ],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([echoTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "hi",
      }),
    );
    const text = events
      .filter((e): e is { type: "assistant_text"; delta: string } => e.type === "assistant_text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("hello world");
    const done = events.find((e) => e.type === "agent_done");
    expect(done).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(requests[0]?.tools.find((t) => t.function.name === "echo")).toBeDefined();
  });

  it("executes a tool call and feeds the result back into the model", async () => {
    const { api, requests } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "call_1", name: "echo" },
        { type: "tool_call_delta", index: 0, arguments: '{"value":' },
        { type: "tool_call_delta", index: 0, arguments: '"hi"}' },
        { type: "end", finishReason: "tool_calls" },
      ],
      [
        { type: "delta", content: "done" },
        { type: "end", finishReason: "stop" },
      ],
    ]);

    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([echoTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "do it",
      }),
    );

    const toolResult = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(toolResult?.result.content).toBe("echoed: hi");

    // Second model call must include the assistant tool_call message AND the
    // tool result message.
    expect(requests).toHaveLength(2);
    const second = requests[1]!;
    const lastTwo = second.messages.slice(-2);
    expect(lastTwo[0]?.role).toBe("assistant");
    expect(lastTwo[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "echo",
      content: "echoed: hi",
    });
  });

  it("denies a write tool when no permission handler is wired", async () => {
    const { api } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "c1", name: "destructive", arguments: "{}" },
        { type: "end", finishReason: "tool_calls" },
      ],
      [
        { type: "delta", content: "ok" },
        { type: "end", finishReason: "stop" },
      ],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([writeTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "write it",
      }),
    );
    const denied = events.find((e) => e.type === "tool_denied");
    expect(denied).toBeDefined();
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(result?.result.content).toMatch(/denied/);
  });

  it("handles unknown tools gracefully", async () => {
    const { api } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "c1", name: "ghost", arguments: "{}" },
        { type: "end", finishReason: "tool_calls" },
      ],
      [
        { type: "delta", content: "fallback" },
        { type: "end", finishReason: "stop" },
      ],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([echoTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "x",
      }),
    );
    const r = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(r?.result.content).toMatch(/Unknown tool/);
  });

  it("handles malformed JSON arguments without crashing", async () => {
    const { api } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "c1", name: "echo", arguments: "not json" },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([echoTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "x",
      }),
    );
    const r = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(r?.result.content).toMatch(/Invalid JSON/);
  });

  it("respects the iteration cap and surfaces an error", async () => {
    // Always asks for the same tool — would loop forever without the cap.
    const turns: StreamEvent[][] = Array.from({ length: 10 }, () => [
      { type: "tool_call_delta", index: 0, id: "c1", name: "echo", arguments: '{"value":"x"}' },
      { type: "end", finishReason: "tool_calls" },
    ]);
    const { api } = fakeApi(turns);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([echoTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "x",
        maxIterations: 3,
      }),
    );
    const err = events.find((e) => e.type === "agent_error");
    expect(err).toBeDefined();
  });
});
