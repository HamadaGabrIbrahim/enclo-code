import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  describeSubagents,
  discoverCustomSubagents,
  parseCustomSubagent,
  type CustomSubagent,
} from "../../src/agent/custom-subagents.js";
import {
  runAgent,
  type AgentEvent,
  type ApiAdapter,
  type ChatRequest,
  type ChatStream,
  type StreamEvent,
} from "../../src/agent/loop.js";
import { makeRegistry, type Tool, type SubagentSpec } from "../../src/tools/types.js";
import { createSpawnAgentTool } from "../../src/tools/spawn_agent.js";
import { createPermissionManager } from "../../src/agent/permissions.js";

let tmpHome: string;
let tmpRoot: string;
let tmpUserGlobal: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-sub-home-"));
  tmpRoot = await fs.mkdtemp(path.join(tmpHome, "proj-"));
  tmpUserGlobal = path.join(tmpHome, ".enclo", "agents");
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function writeAgent(dir: string, name: string, body: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, `${name}.md`);
  await fs.writeFile(full, body);
  return full;
}

function streamFrom(events: StreamEvent[]): ChatStream {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
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

const grepTool: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: "Pretend grep",
      parameters: { type: "object", properties: {} },
    },
  },
  async execute() {
    return { content: "grep result" };
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function allowSpawn() {
  const p = createPermissionManager();
  p.allowTool("spawn_agent");
  return p;
}

describe("parseCustomSubagent", () => {
  it("parses frontmatter and body as system prompt", () => {
    const raw = [
      "---",
      "name: code-reviewer",
      "description: Use to review code changes",
      "tools: [read_file, grep, glob]",
      "model: qwen3-coder-480b",
      "---",
      "You are a code reviewer.",
      "",
      "Focus on correctness.",
      "",
    ].join("\n");
    const sub = parseCustomSubagent("default", raw, "/x");
    expect(sub.name).toBe("code-reviewer");
    expect(sub.description).toBe("Use to review code changes");
    expect(sub.tools).toEqual(["read_file", "grep", "glob"]);
    expect(sub.model).toBe("qwen3-coder-480b");
    expect(sub.systemPrompt).toContain("You are a code reviewer.");
    expect(sub.systemPrompt).toContain("Focus on correctness.");
  });

  it("defaults the name to the filename stem when frontmatter omits it", () => {
    const raw = "---\ndescription: simple\n---\nbody only\n";
    const sub = parseCustomSubagent("test-writer", raw, "/x");
    expect(sub.name).toBe("test-writer");
    expect(sub.description).toBe("simple");
    expect(sub.tools).toBeUndefined();
    expect(sub.model).toBeUndefined();
  });

  it("falls back to a synthetic description when frontmatter has none", () => {
    const sub = parseCustomSubagent("foo", "no frontmatter at all\n", "/x");
    expect(sub.description).toMatch(/foo/);
    expect(sub.systemPrompt).toContain("no frontmatter at all");
  });

  it("lowercases the name", () => {
    const sub = parseCustomSubagent("Mixed", "---\nname: CODE-REVIEWER\n---\nx\n", "/x");
    expect(sub.name).toBe("code-reviewer");
  });
});

describe("discoverCustomSubagents", () => {
  it("loads agents from .enclo/agents/ at the cwd", async () => {
    await writeAgent(
      path.join(tmpRoot, ".enclo", "agents"),
      "code-reviewer",
      "---\ndescription: reviews code\n---\nyou are a reviewer\n",
    );
    const subs = await discoverCustomSubagents(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(subs.has("code-reviewer")).toBe(true);
    expect(subs.get("code-reviewer")?.description).toBe("reviews code");
  });

  it("walks upward from a nested cwd", async () => {
    const nested = path.join(tmpRoot, "x", "y");
    await fs.mkdir(nested, { recursive: true });
    await writeAgent(
      path.join(tmpRoot, ".enclo", "agents"),
      "outer",
      "---\ndescription: outer\n---\nbody\n",
    );
    const subs = await discoverCustomSubagents(nested, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(subs.has("outer")).toBe(true);
  });

  it("project-level overrides user-global on name collision", async () => {
    await writeAgent(
      tmpUserGlobal,
      "shared",
      "---\ndescription: from user\n---\nuser body\n",
    );
    await writeAgent(
      path.join(tmpRoot, ".enclo", "agents"),
      "shared",
      "---\ndescription: from project\n---\nproject body\n",
    );
    const subs = await discoverCustomSubagents(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(subs.get("shared")?.description).toBe("from project");
    expect(subs.get("shared")?.systemPrompt).toContain("project body");
  });

  it("returns an empty map when no agents exist anywhere", async () => {
    const subs = await discoverCustomSubagents(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(subs.size).toBe(0);
  });

  it("ignores non-.md files", async () => {
    const dir = path.join(tmpRoot, ".enclo", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore");
    await fs.writeFile(path.join(dir, "ok.md"), "---\ndescription: kept\n---\nyo\n");
    const subs = await discoverCustomSubagents(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(subs.size).toBe(1);
  });
});

describe("describeSubagents", () => {
  it("returns the base description when no subagents are registered", () => {
    expect(describeSubagents(new Map())).not.toContain("Available custom subagents");
  });

  it("appends a list of registered subagents to the description", () => {
    const m = new Map<string, CustomSubagent>([
      [
        "code-reviewer",
        {
          name: "code-reviewer",
          description: "Reviews diffs",
          systemPrompt: "x",
          sourcePath: "/x",
        },
      ],
      [
        "test-writer",
        {
          name: "test-writer",
          description: "Writes tests",
          systemPrompt: "y",
          sourcePath: "/y",
        },
      ],
    ]);
    const desc = describeSubagents(m);
    expect(desc).toContain("code-reviewer (Reviews diffs)");
    expect(desc).toContain("test-writer (Writes tests)");
  });
});

describe("spawn_agent with subagent_type", () => {
  function fakeApiCapturing(turns: StreamEvent[][]) {
    const requests: ChatRequest[] = [];
    let i = 0;
    const api: ApiAdapter = {
      async streamChat(req) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        const turn = turns[i] ?? [{ type: "end", finishReason: "stop" }];
        i += 1;
        return streamFrom(turn);
      },
    };
    return { api, requests };
  }

  const reviewerSpec: SubagentSpec = {
    description: "Reviews code",
    systemPrompt: "You are a code reviewer. Be thorough.",
    tools: ["grep"],
  };
  const subagents = new Map<string, SubagentSpec>([["code-reviewer", reviewerSpec]]);

  it("uses the named subagent's system prompt", async () => {
    const { api, requests } = fakeApiCapturing([
      // Parent calls spawn_agent with subagent_type
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "p1",
          name: "spawn_agent",
          arguments:
            '{"description":"review","prompt":"check this","subagent_type":"code-reviewer"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      // Sub-agent returns plain text answer
      [{ type: "delta", content: "looks good" }, { type: "end", finishReason: "stop" }],
      // Parent stops
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    await collect(
      runAgent({
        api,
        tools: makeRegistry([createSpawnAgentTool(subagents), grepTool, echoTool]),
        permissions: allowSpawn(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
        subagents,
      }),
    );
    // Sub-agent request is the second one — verify its system message.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const subRequest = requests[1]!;
    const sysMsg = subRequest.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toBe("You are a code reviewer. Be thorough.");
  });

  it("narrows the sub-agent's tool list to the subagent's tools field", async () => {
    const { api, requests } = fakeApiCapturing([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "p1",
          name: "spawn_agent",
          arguments:
            '{"description":"review","prompt":"check","subagent_type":"code-reviewer"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
      [{ type: "delta", content: "done" }, { type: "end", finishReason: "stop" }],
    ]);
    await collect(
      runAgent({
        api,
        tools: makeRegistry([createSpawnAgentTool(subagents), grepTool, echoTool]),
        permissions: allowSpawn(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
        subagents,
      }),
    );
    const subRequest = requests[1]!;
    const toolNames = subRequest.tools.map((t) => t.function.name);
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("echo");
    expect(toolNames).not.toContain("spawn_agent");
  });

  it("returns a helpful error when subagent_type is unknown", async () => {
    const { api } = fakeApiCapturing([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "p1",
          name: "spawn_agent",
          arguments:
            '{"description":"x","prompt":"y","subagent_type":"missing"}',
        },
        { type: "end", finishReason: "tool_calls" },
      ],
      [{ type: "delta", content: "ok" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([createSpawnAgentTool(subagents), grepTool, echoTool]),
        permissions: allowSpawn(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
        subagents,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.result.isError).toBe(true);
    expect(result?.result.content).toMatch(/unknown subagent_type/);
    expect(result?.result.content).toMatch(/code-reviewer/);
  });

  it("applies the subagent's model override via apiFactory", async () => {
    const factoryCalls: string[] = [];
    const requests: ChatRequest[] = [];
    let parentTurn = 0;
    const parentApi: ApiAdapter = {
      async streamChat(req) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        if (parentTurn === 0) {
          parentTurn += 1;
          return streamFrom([
            {
              type: "tool_call_delta",
              index: 0,
              id: "p1",
              name: "spawn_agent",
              arguments:
                '{"description":"r","prompt":"p","subagent_type":"code-reviewer"}',
            },
            { type: "end", finishReason: "tool_calls" },
          ]);
        }
        return streamFrom([
          { type: "delta", content: "done" },
          { type: "end", finishReason: "stop" },
        ]);
      },
    };
    const childApi: ApiAdapter = {
      async streamChat(req) {
        requests.push({ messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
        return streamFrom([
          { type: "delta", content: "child reply" },
          { type: "end", finishReason: "stop" },
        ]);
      },
    };
    const reviewerWithModel: SubagentSpec = {
      ...reviewerSpec,
      model: "qwen3-coder-480b",
    };
    const subs = new Map<string, SubagentSpec>([["code-reviewer", reviewerWithModel]]);

    await collect(
      runAgent({
        api: parentApi,
        tools: makeRegistry([createSpawnAgentTool(subs), grepTool, echoTool]),
        permissions: allowSpawn(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
        subagents: subs,
        apiFactory: (model) => {
          factoryCalls.push(model);
          return childApi;
        },
      }),
    );
    expect(factoryCalls).toEqual(["qwen3-coder-480b"]);
  });

  it("does not advertise subagent_type when no subagents are registered", () => {
    const tool = createSpawnAgentTool();
    const props = tool.definition.function.parameters.properties;
    expect("subagent_type" in props).toBe(false);
    expect(tool.definition.function.description).not.toContain("Available custom subagents");
  });

  it("advertises subagent_type and lists names in its description when subagents exist", () => {
    const tool = createSpawnAgentTool(subagents);
    const props = tool.definition.function.parameters.properties;
    expect("subagent_type" in props).toBe(true);
    expect(tool.definition.function.description).toContain("code-reviewer");
  });

  it("still works with no subagent_type (back-compat)", async () => {
    const { api } = fakeApiCapturing([
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
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([createSpawnAgentTool(subagents), grepTool, echoTool]),
        permissions: allowSpawn(),
        cwd: "/tmp",
        history: [],
        userInput: "go",
        subagents,
      }),
    );
    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.result.content).toBe("child answer");
    expect(result?.result.isError).toBe(false);
  });
});
