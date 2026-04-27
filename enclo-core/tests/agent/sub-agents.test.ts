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
import { spawnAgent } from "../../src/tools/spawn_agent.js";
import { createPermissionManager } from "../../src/agent/permissions.js";

function streamFrom(events: StreamEvent[]): ChatStream {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

/**
 * Scripted API client. Each "turn" is a list of stream events. Subsequent
 * calls beyond the script return a default "stop" turn (no tool calls).
 */
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
    return { content: `echoed: ${(args as { value: string }).value}` };
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// Permissions auto-allow exec/write tools (no UI handler) — but spawn_agent
// requires permission. We pre-allow it on the manager.
function allowSpawnPerms() {
  const p = createPermissionManager();
  p.allowTool("spawn_agent");
  return p;
}

describe("spawn_agent (sub-agents)", () => {
  it("runs a sub-agent to completion and returns its final text", async () => {
    // Parent: turn 0 calls spawn_agent. Turn 1 just stops with text.
    // Sub-agent: turn 0 returns plain text (its final answer).
    const { api } = fakeApi([
      // Parent turn 0: emit spawn_agent tool call
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "p1",
          name: "spawn_agent",
          arguments:
            '{"description":"check files","prompt":"list the files"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      // Sub-agent turn 0: returns plain text answer
      [
        { type: "delta", content: "found three files: a.ts, b.ts, c.ts" },
        { type: "end", finishReason: "stop" },
      ],
      // Parent turn 1: receives the sub-agent result, says ok and stops
      [
        { type: "delta", content: "thanks" },
        { type: "end", finishReason: "stop" },
      ],
    ]);

    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([spawnAgent, echoTool]),
        permissions: allowSpawnPerms(),
        cwd: "/tmp",
        history: [],
        userInput: "do it",
      }),
    );

    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.name).toBe("spawn_agent");
    expect(result?.result.content).toBe("found three files: a.ts, b.ts, c.ts");
    expect(result?.result.isError).toBe(false);

    // Sub-agent events were forwarded as sub_agent_event wrappers.
    const subEvents = events.filter(
      (e): e is { type: "sub_agent_event"; parentCallId: string; event: AgentEvent } =>
        e.type === "sub_agent_event",
    );
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents[0]?.parentCallId).toBe("p1");
  });

  it("forwards the sub-agent result as a tool message and the parent continues", async () => {
    const { api, requests } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "p1",
          name: "spawn_agent",
          arguments: '{"description":"d","prompt":"p"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "child answer" }, { type: "end", finishReason: "stop" }],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    await collect(
      runAgent({
        api,
        tools: makeRegistry([spawnAgent, echoTool]),
        permissions: allowSpawnPerms(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
      }),
    );

    // Parent's second call must include a role: tool message named spawn_agent
    // with the child's answer as its content.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const parentSecond = requests[2]!;
    const lastMsg = parentSecond.messages[parentSecond.messages.length - 1];
    expect(lastMsg).toMatchObject({
      role: "tool",
      tool_call_id: "p1",
      name: "spawn_agent",
      content: "child answer",
    });
  });

  it("refuses to spawn beyond depth 3", async () => {
    // We invoke spawn directly via the loop's hook by running runAgent at
    // depth=3 with a spawn_agent tool call.
    const { api } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "x",
          name: "spawn_agent",
          arguments: '{"description":"d","prompt":"p"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([spawnAgent]),
        permissions: allowSpawnPerms(),
        cwd: "/tmp",
        history: [],
        userInput: "deep",
        depth: 3,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.result.isError).toBe(true);
    expect(result?.result.content).toMatch(/maximum sub-agent depth \(3\) reached/);
  });

  it("hits the sub-agent iteration cap (15) when the sub-agent loops forever", async () => {
    // Build a fakeApi that always returns the same tool call. The sub-agent
    // will eventually exhaust its 15-iteration cap and return an error.
    const requests: ChatRequest[] = [];
    let parentTurn = 0;
    const api: ApiAdapter = {
      async streamChat(req) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        // Detect parent vs sub-agent by checking if echo is in tools.
        const hasSpawn = req.tools.some((t) => t.function.name === "spawn_agent");
        if (hasSpawn) {
          // Parent turn
          if (parentTurn === 0) {
            parentTurn += 1;
            return streamFrom([
              {
                type: "tool_call_delta",
                index: 0,
                id: "p1",
                name: "spawn_agent",
                arguments: '{"description":"d","prompt":"p"}',
              },
              { type: "end", finishReason: "tool_calls" },
            ]);
          }
          return streamFrom([
            { type: "delta", content: "done" },
            { type: "end", finishReason: "stop" },
          ]);
        }
        // Sub-agent turn — always emits an echo tool call (loop forever).
        return streamFrom([
          {
            type: "tool_call_delta",
            index: 0,
            id: `c${requests.length}`,
            name: "echo",
            arguments: '{"value":"x"}',
          },
          { type: "end", finishReason: "tool_calls" },
        ]);
      },
    };

    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([spawnAgent, echoTool]),
        permissions: allowSpawnPerms(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.result.isError).toBe(true);
    expect(result?.result.content).toMatch(/sub_agent error:/);
    expect(result?.result.content).toMatch(/15 iterations/);
  });

  it("does not expose spawn_agent inside the sub-agent's tool list (no recursion of spawn_agent)", async () => {
    // Capture tools sent to the sub-agent's first call.
    const requests: ChatRequest[] = [];
    let parentTurn = 0;
    const api: ApiAdapter = {
      async streamChat(req) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        const hasSpawn = req.tools.some((t) => t.function.name === "spawn_agent");
        if (hasSpawn) {
          if (parentTurn === 0) {
            parentTurn += 1;
            return streamFrom([
              {
                type: "tool_call_delta",
                index: 0,
                id: "p1",
                name: "spawn_agent",
                arguments: '{"description":"d","prompt":"p"}',
              },
              { type: "end", finishReason: "tool_calls" },
            ]);
          }
          return streamFrom([
            { type: "delta", content: "ok" },
            { type: "end", finishReason: "stop" },
          ]);
        }
        return streamFrom([
          { type: "delta", content: "child done" },
          { type: "end", finishReason: "stop" },
        ]);
      },
    };

    await collect(
      runAgent({
        api,
        tools: makeRegistry([spawnAgent, echoTool]),
        permissions: allowSpawnPerms(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
      }),
    );

    // Find the first sub-agent request (the one without spawn_agent in tools).
    const subRequests = requests.filter((r) => !r.tools.some((t) => t.function.name === "spawn_agent"));
    expect(subRequests.length).toBeGreaterThan(0);
    expect(subRequests[0]?.tools.find((t) => t.function.name === "spawn_agent")).toBeUndefined();
    expect(subRequests[0]?.tools.find((t) => t.function.name === "echo")).toBeDefined();
  });
});
