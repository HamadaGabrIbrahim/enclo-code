import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildHookEnv,
  createHooksManager,
  globToRegExp,
  loadHooksFile,
  matcherMatches,
  primaryPath,
  runHook,
  type HookConfig,
  type HookPayload,
} from "../../src/agent/hooks.js";
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

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-hooks-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function writeHooksFile(file: string, body: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body), "utf8");
}

describe("globToRegExp", () => {
  it("matches simple star against a single segment", () => {
    expect(globToRegExp("*.ts").test("foo.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("foo/bar.ts")).toBe(false);
  });

  it("doublestar matches across slashes", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
  });

  it("escapes regex metachars", () => {
    expect(globToRegExp("foo.bar").test("foo.bar")).toBe(true);
    expect(globToRegExp("foo.bar").test("fooXbar")).toBe(false);
  });
});

describe("primaryPath", () => {
  it("returns the path arg for write/edit/read tools", () => {
    expect(primaryPath("write_file", { path: "/abs/x.ts" })).toBe("/abs/x.ts");
    expect(primaryPath("edit_file", { path: "rel.ts" })).toBe("rel.ts");
  });

  it("returns undefined for bash (paths come via command)", () => {
    expect(primaryPath("bash", { command: "ls" })).toBeUndefined();
  });
});

describe("matcherMatches", () => {
  const prePayload = (toolName: string, args: unknown): HookPayload => ({
    event: "PreToolUse",
    tool_name: toolName,
    tool_args: args,
    cwd: "/cwd",
  });

  it("undefined matcher matches anything", () => {
    expect(matcherMatches(undefined, prePayload("write_file", { path: "x.ts" }))).toBe(true);
  });

  it("matches by exact tool name", () => {
    expect(matcherMatches({ tool: "write_file" }, prePayload("write_file", {}))).toBe(true);
    expect(matcherMatches({ tool: "write_file" }, prePayload("read_file", {}))).toBe(false);
  });

  it("matches by path_glob against the primary path arg", () => {
    expect(
      matcherMatches({ path_glob: "*.ts" }, prePayload("write_file", { path: "x.ts" })),
    ).toBe(true);
    expect(
      matcherMatches({ path_glob: "*.ts" }, prePayload("write_file", { path: "x.md" })),
    ).toBe(false);
  });

  it("matches command_pattern only for bash", () => {
    expect(
      matcherMatches(
        { command_pattern: "^rm\\s+-rf" },
        prePayload("bash", { command: "rm -rf /" }),
      ),
    ).toBe(true);
    expect(
      matcherMatches(
        { command_pattern: "^rm\\s+-rf" },
        prePayload("bash", { command: "ls" }),
      ),
    ).toBe(false);
    expect(
      matcherMatches(
        { command_pattern: "^rm" },
        prePayload("write_file", { path: "rm.ts" }),
      ),
    ).toBe(false);
  });

  it("AND-combines all set fields", () => {
    const m = { tool: "write_file", path_glob: "*.ts" };
    expect(matcherMatches(m, prePayload("write_file", { path: "x.ts" }))).toBe(true);
    expect(matcherMatches(m, prePayload("write_file", { path: "x.md" }))).toBe(false);
    expect(matcherMatches(m, prePayload("read_file", { path: "x.ts" }))).toBe(false);
  });

  it("non-tool events skip tool/path/command matchers", () => {
    const promptPayload: HookPayload = {
      event: "UserPromptSubmit",
      prompt: "hi",
      cwd: "/cwd",
    };
    expect(matcherMatches({ tool: "write_file" }, promptPayload)).toBe(false);
    expect(matcherMatches(undefined, promptPayload)).toBe(true);
  });
});

describe("loadHooksFile", () => {
  it("returns empty when file is missing", async () => {
    const r = await loadHooksFile(path.join(workDir, "nope.json"));
    expect(r.hooks).toEqual({});
    expect(r.errors).toEqual([]);
  });

  it("parses a valid file", async () => {
    const file = path.join(workDir, "hooks.json");
    await writeHooksFile(file, {
      PreToolUse: [
        { matcher: { tool: "write_file" }, command: "echo hi", timeout_ms: 1000 },
      ],
    });
    const r = await loadHooksFile(file);
    expect(r.errors).toEqual([]);
    expect(r.hooks.PreToolUse).toHaveLength(1);
    expect(r.hooks.PreToolUse?.[0]?.command).toBe("echo hi");
    expect(r.hooks.PreToolUse?.[0]?.matcher?.tool).toBe("write_file");
  });

  it("collects validation errors and skips the bad entries", async () => {
    const file = path.join(workDir, "hooks.json");
    await writeHooksFile(file, {
      PreToolUse: [{ command: "ok" }, { foo: "bar" }],
    });
    const r = await loadHooksFile(file);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.hooks.PreToolUse).toHaveLength(1);
  });

  it("rejects malformed JSON without throwing", async () => {
    const file = path.join(workDir, "hooks.json");
    await fs.writeFile(file, "{ not json", "utf8");
    const r = await loadHooksFile(file);
    expect(r.errors[0]).toMatch(/invalid JSON/);
    expect(r.hooks).toEqual({});
  });
});

describe("buildHookEnv", () => {
  it("sets TOOL_NAME / TOOL_ARGS_JSON / TOOL_PATH for write_file", () => {
    const env = buildHookEnv({
      event: "PreToolUse",
      tool_name: "write_file",
      tool_args: { path: "x.ts", content: "y" },
      cwd: "/cwd",
    });
    expect(env["TOOL_NAME"]).toBe("write_file");
    expect(env["TOOL_PATH"]).toBe("x.ts");
    expect(JSON.parse(env["TOOL_ARGS_JSON"]!)).toEqual({ path: "x.ts", content: "y" });
    expect(env["HOOK_EVENT"]).toBe("PreToolUse");
  });

  it("sets TOOL_COMMAND for bash", () => {
    const env = buildHookEnv({
      event: "PreToolUse",
      tool_name: "bash",
      tool_args: { command: "ls -la" },
      cwd: "/cwd",
    });
    expect(env["TOOL_COMMAND"]).toBe("ls -la");
    expect(env["TOOL_PATH"]).toBeUndefined();
  });

  it("sets USER_PROMPT for UserPromptSubmit", () => {
    const env = buildHookEnv({ event: "UserPromptSubmit", prompt: "hello", cwd: "/c" });
    expect(env["USER_PROMPT"]).toBe("hello");
  });

  it("sets STOP_REASON for Stop", () => {
    const env = buildHookEnv({ event: "Stop", reason: "stop", cwd: "/c" });
    expect(env["STOP_REASON"]).toBe("stop");
  });
});

describe("runHook", () => {
  const cwd = "/tmp";
  const payload: HookPayload = {
    event: "PreToolUse",
    tool_name: "write_file",
    tool_args: { path: "x.ts", content: "" },
    cwd,
  };

  it("captures stdout and a zero exit code as 'continue'", async () => {
    const r = await runHook("PreToolUse", { command: "echo hello" }, payload);
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe("continue");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.notice).toBe("hello");
  });

  it("treats exit 2 as 'block'", async () => {
    const r = await runHook("PreToolUse", { command: "echo nope; exit 2" }, payload);
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe("block");
    expect(r.stdout.trim()).toBe("nope");
  });

  it("treats other non-zero exits as 'warn'", async () => {
    const r = await runHook("PreToolUse", { command: "exit 7" }, payload);
    expect(r.exitCode).toBe(7);
    expect(r.action).toBe("warn");
  });

  it("can read the JSON payload from stdin", async () => {
    const r = await runHook(
      "PreToolUse",
      { command: "cat | head -c 200" },
      payload,
    );
    expect(r.exitCode).toBe(0);
    const got = JSON.parse(r.stdout);
    expect(got.event).toBe("PreToolUse");
    expect(got.tool_name).toBe("write_file");
    expect(got.tool_args).toEqual({ path: "x.ts", content: "" });
  });

  it("reads env vars set on the hook process", async () => {
    const r = await runHook(
      "PreToolUse",
      { command: 'echo "$TOOL_NAME:$TOOL_PATH"' },
      payload,
    );
    expect(r.stdout.trim()).toBe("write_file:x.ts");
  });

  it("times out long-running commands", async () => {
    const r = await runHook(
      "PreToolUse",
      { command: "sleep 5", timeout_ms: 200 },
      payload,
    );
    expect(r.timedOut).toBe(true);
  }, 10_000);
});

describe("HooksManager.run aggregation", () => {
  it("project file overrides user file per event", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(userDir, "hooks.json"), {
      UserPromptSubmit: [{ command: "echo USER" }],
    });
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      UserPromptSubmit: [{ command: "echo PROJECT" }],
    });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const out = await mgr.run("UserPromptSubmit", {
      event: "UserPromptSubmit",
      prompt: "hi",
      cwd: projectDir,
    });
    expect(out.notices).toEqual(["🪝 hook: PROJECT"]);
  });

  it("user-only events still fire", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(userDir, "hooks.json"), {
      Stop: [{ command: "echo USER_STOP" }],
    });
    await fs.mkdir(projectDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const out = await mgr.run("Stop", { event: "Stop", reason: "stop", cwd: projectDir });
    expect(out.notices).toEqual(["🪝 hook: USER_STOP"]);
  });

  it("first blocking exit short-circuits the rest", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    const sentinel = path.join(workDir, "sentinel");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PreToolUse: [
        { command: "echo FIRST; exit 2" },
        { command: `touch '${sentinel}'` },
      ],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const out = await mgr.run("PreToolUse", {
      event: "PreToolUse",
      tool_name: "write_file",
      tool_args: { path: "a" },
      cwd: projectDir,
    });
    expect(out.blocked).toBe(true);
    expect(out.blockMessage).toBe("FIRST");
    await expect(fs.stat(sentinel)).rejects.toBeDefined();
  });

  it("warn-level (non-zero non-2) exits accumulate", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PostToolUse: [{ command: "exit 9" }, { command: "echo ok" }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const out = await mgr.run("PostToolUse", {
      event: "PostToolUse",
      tool_name: "write_file",
      tool_args: { path: "x" },
      cwd: projectDir,
      result: { content: "ok" },
    });
    expect(out.blocked).toBe(false);
    expect(out.warnings.length).toBe(1);
    expect(out.notices).toContain("🪝 hook: ok");
  });

  it("reload picks up changes to the file", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    const file = path.join(projectDir, ".enclo", "hooks.json");
    await writeHooksFile(file, { UserPromptSubmit: [{ command: "echo V1" }] });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const before = await mgr.run("UserPromptSubmit", {
      event: "UserPromptSubmit",
      prompt: "hi",
      cwd: projectDir,
    });
    expect(before.notices).toEqual(["🪝 hook: V1"]);

    await writeHooksFile(file, { UserPromptSubmit: [{ command: "echo V2" }] });
    await mgr.reload();
    const after = await mgr.run("UserPromptSubmit", {
      event: "UserPromptSubmit",
      prompt: "hi",
      cwd: projectDir,
    });
    expect(after.notices).toEqual(["🪝 hook: V2"]);
  });

  it("counts() reports per-event totals", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PreToolUse: [{ command: "echo a" }, { command: "echo b" }],
      Stop: [{ command: "echo s" }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();
    const c = mgr.counts();
    expect(c.PreToolUse).toBe(2);
    expect(c.Stop).toBe(1);
    expect(c.PostToolUse).toBe(0);
  });
});

// --- runAgent integration ---

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

const writeStub: Tool = {
  category: "write",
  requiresPermission: false, // skip permission to isolate hook behavior
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "fake",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  async execute() {
    return { content: "wrote" };
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("runAgent + hooks", () => {
  it("PreToolUse exit 2 blocks the tool with a synthetic error result", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PreToolUse: [{ command: "echo dont-write; exit 2" }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();

    const { api } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "write_file",
          arguments: '{"path":"x.ts"}',
        },
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
        tools: makeRegistry([writeStub]),
        permissions: createPermissionManager(),
        cwd: projectDir,
        history: [],
        userInput: "x",
        hooks: mgr,
      }),
    );

    const result = events.find(
      (e): e is { type: "tool_result"; call_id: string; name: string; result: { content: string; isError?: boolean } } =>
        e.type === "tool_result",
    );
    expect(result?.result.isError).toBe(true);
    expect(result?.result.content).toContain("blocked_by_hook");
    expect(result?.result.content).toContain("dont-write");
  });

  it("Stop exit 2 forces another loop iteration with a synthetic system message", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      Stop: [{ command: 'echo "keep going"; exit 2' }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();

    // Turn 1: model says "done". Turn 2: also "done" (Stop hook will not
    // fire infinitely because we replace the file on the second turn —
    // simpler: keep the iteration cap small and assert the Stop block
    // pushed a new request).
    const { api, requests } = fakeApi([
      [
        { type: "delta", content: "i think im done" },
        { type: "end", finishReason: "stop" },
      ],
      [
        { type: "delta", content: "actually here it is" },
        { type: "end", finishReason: "stop" },
      ],
    ]);

    // Disable the Stop hook before the second turn ends so we don't loop
    // forever — easier: intercept via a max-iterations cap.
    const events = await collect(
      runAgent({
        api,
        tools: makeRegistry([writeStub]),
        permissions: createPermissionManager(),
        cwd: projectDir,
        history: [],
        userInput: "do it",
        hooks: mgr,
        maxIterations: 2,
      }),
    );

    // Two model calls happened — proving the Stop hook forced a loop.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    // The second request should include a system message with the hook's
    // stdout so the model sees why it was forced to continue.
    const second = requests[1]!;
    const synthetic = second.messages.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("keep going"),
    );
    expect(synthetic).toBeDefined();
    // No agent_done expected within the iteration cap, since the hook
    // would block again — instead an iteration-cap agent_error.
    expect(events.find((e) => e.type === "agent_error")).toBeDefined();
  });

  it("PostToolUse non-zero (warn) does not block and emits a hook_warning", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PostToolUse: [{ command: "exit 9" }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();

    const { api } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "write_file",
          arguments: '{"path":"x.ts"}',
        },
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
        tools: makeRegistry([writeStub]),
        permissions: createPermissionManager(),
        cwd: projectDir,
        history: [],
        userInput: "x",
        hooks: mgr,
      }),
    );

    const result = events.find((e): e is AgentEvent & { type: "tool_result" } => e.type === "tool_result");
    expect(result?.result.content).toBe("wrote");
    const warn = events.find((e) => e.type === "hook_warning");
    expect(warn).toBeDefined();
  });

  it("PreToolUse exit 0 with stdout surfaces a hook_notice", async () => {
    const userDir = path.join(workDir, "userhome");
    const projectDir = path.join(workDir, "proj");
    await writeHooksFile(path.join(projectDir, ".enclo", "hooks.json"), {
      PreToolUse: [{ command: "echo lint clean" }],
    });
    await fs.mkdir(userDir, { recursive: true });
    const mgr = createHooksManager({ userDir, projectDir });
    await mgr.reload();

    const { api } = fakeApi([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "write_file",
          arguments: '{"path":"x.ts"}',
        },
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
        tools: makeRegistry([writeStub]),
        permissions: createPermissionManager(),
        cwd: projectDir,
        history: [],
        userInput: "x",
        hooks: mgr,
      }),
    );

    const notice = events.find((e) => e.type === "hook_notice");
    expect(notice).toBeDefined();
    if (notice && notice.type === "hook_notice") {
      expect(notice.message).toContain("lint clean");
    }
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
  });
});
