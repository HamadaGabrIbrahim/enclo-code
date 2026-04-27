import { describe, expect, it } from "vitest";
import {
  runAgent,
  type AgentEvent,
  type ApiAdapter,
  type ChatRequest,
  type ChatStream,
  type StreamEvent,
} from "../../src/agent/loop.js";
import { makeRegistry, type Tool } from "../../src/tools/types.js";
import { createPermissionManager } from "../../src/agent/permissions.js";
import { buildSystemPrompt, PLAN_MODE_SUFFIX } from "../../src/agent/system-prompt.js";

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
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        const turn = turns[i] ?? [{ type: "end", finishReason: "stop" }];
        i += 1;
        return streamFrom(turn);
      },
    },
  };
}

const writeTool: Tool = {
  category: "write",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  async execute() {
    return { content: "WROTE — should not have been called in plan mode" };
  },
};

const readTool: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  async execute() {
    return { content: "file contents here" };
  },
};

const bashTool: Tool = {
  category: "exec",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  async execute() {
    return { content: "EXEC — should not have been called in plan mode" };
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("plan mode", () => {
  it("blocks write tools with the synthetic plan_mode result and continues the loop", async () => {
    const { api, requests } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "write_file",
          arguments: '{"path":"x","content":"y"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      [
        { type: "delta", content: "Plan: 1) write x" },
        { type: "end", finishReason: "stop" },
      ],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([writeTool, readTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "do it",
        planMode: true,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(result?.result.content).toMatch(/^plan_mode:/);
    expect(result?.result.content).not.toMatch(/WROTE/);
    // Loop must continue: a second model request should have happened with the
    // synthetic tool result included.
    expect(requests).toHaveLength(2);
    const lastMsg = requests[1]?.messages[requests[1]!.messages.length - 1];
    expect(lastMsg).toMatchObject({
      role: "tool",
      tool_call_id: "c1",
      name: "write_file",
    });
    expect(typeof (lastMsg as { content: string }).content).toBe("string");
    expect((lastMsg as { content: string }).content).toMatch(/^plan_mode:/);
  });

  it("blocks exec (bash) tools just like write tools", async () => {
    const { api } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "c1", name: "bash", arguments: '{"command":"rm -rf /"}' },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([bashTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "run it",
        planMode: true,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(result?.result.content).toMatch(/^plan_mode:/);
    expect(result?.result.content).not.toMatch(/EXEC/);
  });

  it("allows read tools in plan mode (read tools unaffected)", async () => {
    const { api } = fakeApi([
      [
        { type: "tool_call_delta", index: 0, id: "c1", name: "read_file", arguments: '{"path":"x"}' },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "looked at it" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([readTool, writeTool]),
        permissions: createPermissionManager(),
        cwd: "/tmp",
        history: [],
        userInput: "investigate",
        planMode: true,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string } } =>
        e.type === "tool_result",
    );
    expect(result?.result.content).toBe("file contents here");
  });

  it("buildSystemPrompt appends the plan-mode suffix when planMode is true", async () => {
    const off = await buildSystemPrompt({
      cwd: "/x",
      tools: [readTool],
      overridePath: "/no/such/file",
    });
    const on = await buildSystemPrompt({
      cwd: "/x",
      tools: [readTool],
      overridePath: "/no/such/file",
      planMode: true,
    });
    expect(off).not.toContain("PLAN MODE");
    expect(on).toContain(PLAN_MODE_SUFFIX);
    expect(on).toContain("PLAN MODE IS ACTIVE");
  });
});
