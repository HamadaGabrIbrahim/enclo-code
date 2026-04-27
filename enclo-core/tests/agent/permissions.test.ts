import { describe, expect, it } from "vitest";
import {
  createPermissionManager,
  targetOf,
  type PermissionPrompt,
  type PermissionStorageBackend,
} from "../../src/agent/permissions.js";
import type {
  PermissionRule,
  PermissionRuleScope,
} from "../../src/agent/permissions-storage.js";
import type { Tool } from "../../src/tools/types.js";

const readTool: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "reader",
      description: "",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    return { content: "" };
  },
};

const writeTool: Tool = {
  category: "write",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "writer",
      description: "",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute() {
    return { content: "" };
  },
};

describe("targetOf", () => {
  it("uses path arg when present", () => {
    expect(targetOf("write_file", { path: "/abs/file" }, "/cwd")).toBe("/abs/file");
    expect(targetOf("write_file", { path: "rel" }, "/cwd")).toBe("/cwd/rel");
  });

  it("uses the program token for bash", () => {
    expect(targetOf("bash", { command: "ls -la /tmp" }, "/cwd")).toBe("bash:ls");
  });

  it("falls back to tool name", () => {
    expect(targetOf("foo", {}, "/cwd")).toBe("foo");
  });
});

describe("createPermissionManager", () => {
  it("auto-allows read-category tools", async () => {
    const pm = createPermissionManager();
    const decision = await pm.check({ tool: readTool, args: {}, cwd: "/" });
    expect(decision).toBe("allow");
  });

  it("auto-allows tools that don't require permission", async () => {
    const pm = createPermissionManager();
    const tool: Tool = { ...readTool, requiresPermission: false, category: "exec" };
    const decision = await pm.check({ tool, args: {}, cwd: "/" });
    expect(decision).toBe("allow");
  });

  it("denies when no prompt handler is registered", async () => {
    const pm = createPermissionManager();
    const decision = await pm.check({ tool: writeTool, args: {}, cwd: "/" });
    expect(decision).toBe("deny");
  });

  it("forwards a prompt and resolves with the user's choice", async () => {
    const pm = createPermissionManager();
    let received: PermissionPrompt | null = null;
    pm.onPrompt((p) => {
      received = p;
    });
    const promise = pm.check({ tool: writeTool, args: { path: "x" }, cwd: "/cwd" });
    expect(received).not.toBeNull();
    received!.resolve({ kind: "allow_once" });
    expect(await promise).toBe("allow");
  });

  it("remembers tool-level approval for the rest of the session", async () => {
    const pm = createPermissionManager();
    pm.onPrompt((p) => p.resolve({ kind: "allow_session_tool" }));
    const first = await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(first).toBe("allow");

    // Second call: detach the prompt handler — manager must auto-allow now.
    pm.onPrompt(() => {
      throw new Error("must not prompt again");
    });
    const second = await pm.check({ tool: writeTool, args: { path: "b" }, cwd: "/cwd" });
    expect(second).toBe("allow");
  });

  it("remembers target-level approval but re-prompts for new targets", async () => {
    const pm = createPermissionManager();
    pm.onPrompt((p) => p.resolve({ kind: "allow_session_target" }));
    await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });

    const snap = pm.snapshot();
    expect(snap.targets).toEqual([{ tool: "writer", target: "/cwd/a" }]);

    // New target → new prompt.
    let prompted = false;
    pm.onPrompt((p) => {
      prompted = true;
      p.resolve({ kind: "allow_once" });
    });
    await pm.check({ tool: writeTool, args: { path: "b" }, cwd: "/cwd" });
    expect(prompted).toBe(true);
  });

  it("reset() clears the allowlist", async () => {
    const pm = createPermissionManager();
    pm.allowTool("writer");
    expect(pm.snapshot().tools).toContain("writer");
    pm.reset();
    expect(pm.snapshot().tools).toEqual([]);
  });
});

function fakeBackend(): {
  backend: PermissionStorageBackend;
  added: Array<{
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    effect: "allow" | "deny";
    storageScope: "user" | "project";
  }>;
  removed: Array<{ tool: string; target?: string; scope: PermissionRuleScope }>;
  cleared: number;
} {
  const added: Array<{
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    effect: "allow" | "deny";
    storageScope: "user" | "project";
  }> = [];
  const removed: Array<{ tool: string; target?: string; scope: PermissionRuleScope }> = [];
  const state = { cleared: 0 };
  const backend: PermissionStorageBackend = {
    async add(args) {
      added.push({
        tool: args.tool,
        ...(args.target !== undefined ? { target: args.target } : {}),
        scope: args.scope,
        effect: args.effect,
        storageScope: args.storageScope,
      });
      const stored: PermissionRule = {
        tool: args.tool,
        ...(args.target !== undefined ? { target: args.target } : {}),
        scope: args.scope,
        effect: args.effect,
        grantedAt: "2026-04-26T00:00:00.000Z",
        source: args.storageScope,
      };
      return stored;
    },
    async remove(args) {
      removed.push({
        tool: args.tool,
        ...(args.target !== undefined ? { target: args.target } : {}),
        scope: args.scope,
      });
      return true;
    },
    async clearUser() {
      state.cleared += 1;
    },
  };
  return { backend, added, removed, get cleared() { return state.cleared; } } as ReturnType<typeof fakeBackend>;
}

describe("createPermissionManager: persisted rules", () => {
  it("seeds from persistedRules: persisted allow lets the call through without prompting", async () => {
    const seed: PermissionRule[] = [
      {
        tool: "writer",
        scope: "tool",
        effect: "allow",
        grantedAt: "2026-04-26T00:00:00.000Z",
        source: "user",
      },
    ];
    const pm = createPermissionManager({ persistedRules: seed });
    pm.onPrompt(() => {
      throw new Error("must not prompt — persisted allow should hit");
    });
    const decision = await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(decision).toBe("allow");
  });

  it("persisted deny wins over a session allow", async () => {
    const pm = createPermissionManager({
      persistedRules: [
        {
          tool: "writer",
          scope: "tool",
          effect: "deny",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
      ],
    });
    pm.allowTool("writer");
    const decision = await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(decision).toBe("deny");
  });

  it("persisted deny wins over the auto-allow read category", async () => {
    const pm = createPermissionManager({
      persistedRules: [
        {
          tool: "reader",
          scope: "tool",
          effect: "deny",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
      ],
    });
    const decision = await pm.check({ tool: readTool, args: {}, cwd: "/" });
    expect(decision).toBe("deny");
  });

  it("snapshot exposes persisted allows and denies grouped by source", () => {
    const pm = createPermissionManager({
      persistedRules: [
        {
          tool: "writer",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
        {
          tool: "bash",
          target: "bash:rm",
          scope: "target",
          effect: "deny",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
        {
          tool: "edit_file",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "project",
        },
      ],
    });
    const snap = pm.snapshot();
    expect(snap.persistedAllows).toHaveLength(2);
    expect(snap.persistedDenies).toHaveLength(1);
    expect(snap.persistedAllows.find((r) => r.tool === "writer")?.source).toBe("user");
    expect(snap.persistedAllows.find((r) => r.tool === "edit_file")?.source).toBe("project");
  });
});

describe("createPermissionManager: 7-option prompt routing", () => {
  it("allow_persisted_tool calls storage.add with scope=tool, effect=allow", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    pm.onPrompt((p) => p.resolve({ kind: "allow_persisted_tool" }));
    const decision = await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(decision).toBe("allow");
    expect(f.added).toEqual([
      { tool: "writer", scope: "tool", effect: "allow", storageScope: "user" },
    ]);
    // And it's now active in memory.
    pm.onPrompt(() => {
      throw new Error("must not prompt twice");
    });
    expect(await pm.check({ tool: writeTool, args: { path: "b" }, cwd: "/cwd" })).toBe("allow");
  });

  it("allow_persisted_target calls storage.add with scope=target", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    pm.onPrompt((p) => p.resolve({ kind: "allow_persisted_target" }));
    await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(f.added).toEqual([
      {
        tool: "writer",
        target: "/cwd/a",
        scope: "target",
        effect: "allow",
        storageScope: "user",
      },
    ]);
  });

  it("deny_persisted writes a deny rule and resolves to deny", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    pm.onPrompt((p) => p.resolve({ kind: "deny_persisted" }));
    const decision = await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(decision).toBe("deny");
    expect(f.added).toEqual([
      { tool: "writer", scope: "tool", effect: "deny", storageScope: "user" },
    ]);
    // And the in-memory deny is now load-bearing — even with a session allow it stays denied.
    pm.allowTool("writer");
    expect(await pm.check({ tool: writeTool, args: { path: "b" }, cwd: "/cwd" })).toBe("deny");
  });

  it("session_tool / session_target do NOT touch storage", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    pm.onPrompt((p) => p.resolve({ kind: "allow_session_tool" }));
    await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    pm.onPrompt((p) => p.resolve({ kind: "allow_session_target" }));
    await pm.check({ tool: writeTool, args: { path: "b" }, cwd: "/cwd2" });
    expect(f.added).toEqual([]);
  });

  it("allow_once does not seed any allowlist", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    pm.onPrompt((p) => p.resolve({ kind: "allow_once" }));
    await pm.check({ tool: writeTool, args: { path: "a" }, cwd: "/cwd" });
    expect(f.added).toEqual([]);
    expect(pm.snapshot().sessionAllows).toEqual([]);
  });
});

describe("createPermissionManager: management methods", () => {
  it("addPersistedRule with storageScope=user stores via backend and reflects in snapshot", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({ storage: f.backend });
    await pm.addPersistedRule({
      tool: "writer",
      scope: "tool",
      effect: "allow",
      storageScope: "user",
      cwd: "/cwd",
    });
    expect(f.added).toHaveLength(1);
    expect(pm.snapshot().persistedAllows[0]?.tool).toBe("writer");
  });

  it("removePersistedRule routes to backend and drops it from memory", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({
      storage: f.backend,
      persistedRules: [
        {
          tool: "writer",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
      ],
    });
    const removed = await pm.removePersistedRule({
      tool: "writer",
      scope: "tool",
      storageScope: "user",
      cwd: "/cwd",
    });
    expect(removed).toBe(true);
    expect(f.removed).toEqual([{ tool: "writer", scope: "tool" }]);
    expect(pm.snapshot().persistedAllows).toEqual([]);
  });

  it("clearPersistedUserRules drops user rules from memory but keeps project rules", async () => {
    const f = fakeBackend();
    const pm = createPermissionManager({
      storage: f.backend,
      persistedRules: [
        {
          tool: "writer",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "user",
        },
        {
          tool: "edit_file",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
          source: "project",
        },
      ],
    });
    await pm.clearPersistedUserRules();
    expect(f.cleared).toBe(1);
    const remaining = pm.snapshot().persistedAllows;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tool).toBe("edit_file");
    expect(remaining[0]?.source).toBe("project");
  });

  it("seedPersistedRules replaces the entire in-memory cache", async () => {
    const pm = createPermissionManager();
    pm.seedPersistedRules([
      {
        tool: "writer",
        scope: "tool",
        effect: "allow",
        grantedAt: "2026-04-26T00:00:00.000Z",
        source: "user",
      },
    ]);
    expect(pm.snapshot().persistedAllows).toHaveLength(1);
    pm.seedPersistedRules([]);
    expect(pm.snapshot().persistedAllows).toEqual([]);
  });
});
