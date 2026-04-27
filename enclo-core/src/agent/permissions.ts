import path from "node:path";
import type { Tool, ToolCategory } from "../tools/types.js";
import type {
  PermissionRule,
  PermissionRuleEffect,
  PermissionRuleScope,
  PermissionRuleSource,
} from "./permissions-storage.js";

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  tool: Tool;
  args: unknown;
  cwd: string;
}

export interface PermissionPrompt {
  request: PermissionRequest;
  /** Caller invokes this with the user's choice to resolve the awaiting check(). */
  resolve(choice: PermissionChoice): void;
}

/**
 * The seven options the user sees in the Ink prompt.
 *
 * Session choices live only for the current process; persisted choices are
 * written to ~/.enclo/permissions.json (user-global) and survive restarts.
 *
 * `deny` is one-time (this call only); `deny_persisted` writes a permanent
 * deny rule that beats any session allow.
 */
export type PermissionChoice =
  | { kind: "allow_once" }
  | { kind: "allow_session_tool" }
  | { kind: "allow_session_target" }
  | { kind: "allow_persisted_tool" }
  | { kind: "allow_persisted_target" }
  | { kind: "deny_persisted" }
  | { kind: "deny" };

export interface AllowEntry {
  tool: string;
  target?: string;
  scope: PermissionRuleScope;
  source: PermissionRuleSource | "session";
  /** ISO timestamp; only present for persisted rules. */
  grantedAt?: string;
}

export interface DenyEntry {
  tool: string;
  target?: string;
  scope: PermissionRuleScope;
  source: PermissionRuleSource;
  grantedAt: string;
}

export interface PermissionSnapshot {
  /** Session-only allows, kept for backward-compat with older /allow output. */
  tools: string[];
  targets: { tool: string; target: string }[];
  /** Flat lists for the new /allow grouped UI. */
  sessionAllows: AllowEntry[];
  persistedAllows: AllowEntry[];
  persistedDenies: DenyEntry[];
}

export interface PermissionManager {
  /** Decide whether to run a tool call. Auto-allows reads; otherwise asks. */
  check(req: PermissionRequest): Promise<PermissionDecision>;
  /** Subscribe to prompts that need a user decision. */
  onPrompt(handler: (p: PermissionPrompt) => void): () => void;
  /** Pre-allow a whole tool by name (used by `/allow`). */
  allowTool(toolName: string): void;
  /** Pre-allow a specific (tool, target) pair. */
  allowTarget(toolName: string, target: string): void;
  /** Reset the session allowlist (does NOT touch persisted rules). */
  reset(): void;
  /** Inspect the current allowlist (for `/allow` UI). */
  snapshot(): PermissionSnapshot;
  /**
   * Add a persisted (user-global or project) rule both to the in-memory
   * list and to disk. Returns the stored rule with its `grantedAt`.
   */
  addPersistedRule(args: {
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    effect: PermissionRuleEffect;
    storageScope?: "user" | "project";
    cwd?: string;
  }): Promise<PermissionRule>;
  /**
   * Remove a persisted rule from disk and from the in-memory list. Returns
   * true if a rule was removed.
   */
  removePersistedRule(args: {
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    storageScope?: "user" | "project";
    cwd?: string;
  }): Promise<boolean>;
  /** Wipe the user-global permissions file (and drop those rules from memory). */
  clearPersistedUserRules(): Promise<void>;
  /**
   * Replace the in-memory persisted rule cache with the supplied set. Used at
   * startup (and when cwd changes, since project rules walk from cwd) to feed
   * the manager rules already loaded from disk.
   */
  seedPersistedRules(rules: PermissionRule[]): void;
}

/**
 * Compute the "target" of a tool call — used as the allowlist key for
 * "approve and remember this exact path" decisions. Falls back to a stable
 * hash-ish string when the tool has no obvious path arg.
 */
export function targetOf(toolName: string, args: unknown, cwd: string): string {
  if (!args || typeof args !== "object") return toolName;
  const obj = args as Record<string, unknown>;
  if (typeof obj["path"] === "string") {
    const p = obj["path"];
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
  }
  if (typeof obj["command"] === "string") {
    // For bash, key on the first whitespace-delimited token (the program).
    return `bash:${obj["command"].trim().split(/\s+/)[0]}`;
  }
  if (typeof obj["pattern"] === "string") return `${toolName}:${obj["pattern"]}`;
  return toolName;
}

export interface PermissionStorageBackend {
  add(args: {
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    effect: PermissionRuleEffect;
    storageScope: "user" | "project";
    cwd: string;
  }): Promise<PermissionRule>;
  remove(args: {
    tool: string;
    target?: string;
    scope: PermissionRuleScope;
    storageScope: "user" | "project";
    cwd: string;
  }): Promise<boolean>;
  clearUser(): Promise<void>;
}

export interface PermissionManagerOptions {
  /** Categories that auto-approve without prompting. Defaults to ["read"]. */
  autoAllow?: ToolCategory[];
  /** Initial persisted rules to seed the allow/deny lists. */
  persistedRules?: PermissionRule[];
  /**
   * Storage backend used by addPersistedRule / removePersistedRule /
   * clearPersistedUserRules. When omitted, those methods are no-ops on
   * disk and only update the in-memory list — handy for tests.
   */
  storage?: PermissionStorageBackend;
  /** Default cwd used when callers omit it on the storage helpers. */
  defaultCwd?: string;
}

export function createPermissionManager(opts: PermissionManagerOptions = {}): PermissionManager {
  const autoAllow = new Set<ToolCategory>(opts.autoAllow ?? ["read"]);
  // Session allows.
  const tools = new Set<string>();
  const targets = new Set<string>(); // serialized as `${toolName}::${target}`
  // Persisted rules, keyed for fast lookup. Allow/deny live in their own maps.
  const persistedAllows = new Map<string, PermissionRule>(); // key = ruleKey
  const persistedDenies = new Map<string, PermissionRule>();
  const promptHandlers = new Set<(p: PermissionPrompt) => void>();

  function ruleKey(tool: string, target: string | undefined, scope: PermissionRuleScope): string {
    return `${tool}|${scope}|${target ?? ""}`;
  }
  function sessionTargetKey(tool: string, target: string): string {
    return `${tool}::${target}`;
  }

  for (const r of opts.persistedRules ?? []) {
    const k = ruleKey(r.tool, r.target, r.scope);
    if (r.effect === "deny") persistedDenies.set(k, r);
    else persistedAllows.set(k, r);
  }

  function denyMatches(toolName: string, target: string): PermissionRule | undefined {
    const toolKey = ruleKey(toolName, undefined, "tool");
    const tgtKey = ruleKey(toolName, target, "target");
    return persistedDenies.get(toolKey) ?? persistedDenies.get(tgtKey);
  }

  function allowMatches(toolName: string, target: string): PermissionRule | undefined {
    const toolKey = ruleKey(toolName, undefined, "tool");
    const tgtKey = ruleKey(toolName, target, "target");
    return persistedAllows.get(toolKey) ?? persistedAllows.get(tgtKey);
  }

  function snapshot(): PermissionSnapshot {
    const sessionTargets: { tool: string; target: string }[] = [];
    for (const k of targets) {
      const [t, ...rest] = k.split("::");
      sessionTargets.push({ tool: t ?? "", target: rest.join("::") });
    }
    const sessionAllows: AllowEntry[] = [
      ...[...tools].sort().map<AllowEntry>((tool) => ({
        tool,
        scope: "tool" as const,
        source: "session" as const,
      })),
      ...sessionTargets.map<AllowEntry>((t) => ({
        tool: t.tool,
        target: t.target,
        scope: "target" as const,
        source: "session" as const,
      })),
    ];
    const allowsList: AllowEntry[] = [...persistedAllows.values()].map((r) => ({
      tool: r.tool,
      ...(r.target !== undefined ? { target: r.target } : {}),
      scope: r.scope,
      source: r.source ?? "user",
      grantedAt: r.grantedAt,
    }));
    const deniesList: DenyEntry[] = [...persistedDenies.values()].map((r) => ({
      tool: r.tool,
      ...(r.target !== undefined ? { target: r.target } : {}),
      scope: r.scope,
      source: r.source ?? "user",
      grantedAt: r.grantedAt,
    }));
    return {
      tools: [...tools].sort(),
      targets: sessionTargets,
      sessionAllows,
      persistedAllows: allowsList,
      persistedDenies: deniesList,
    };
  }

  function setPersistedRule(rule: PermissionRule): void {
    const k = ruleKey(rule.tool, rule.target, rule.scope);
    if (rule.effect === "deny") {
      persistedDenies.set(k, rule);
      persistedAllows.delete(k);
    } else {
      persistedAllows.set(k, rule);
      persistedDenies.delete(k);
    }
  }

  function deletePersistedRule(
    tool: string,
    target: string | undefined,
    scope: PermissionRuleScope,
  ): boolean {
    const k = ruleKey(tool, target, scope);
    const had = persistedAllows.delete(k);
    const had2 = persistedDenies.delete(k);
    return had || had2;
  }

  return {
    onPrompt(handler) {
      promptHandlers.add(handler);
      return () => {
        promptHandlers.delete(handler);
      };
    },
    allowTool(toolName) {
      tools.add(toolName);
    },
    allowTarget(toolName, target) {
      targets.add(sessionTargetKey(toolName, target));
    },
    reset() {
      tools.clear();
      targets.clear();
    },
    snapshot,
    async addPersistedRule(args) {
      const storageScope = args.storageScope ?? "user";
      const cwd = args.cwd ?? opts.defaultCwd ?? process.cwd();
      let stored: PermissionRule;
      if (opts.storage) {
        stored = await opts.storage.add({
          tool: args.tool,
          ...(args.target !== undefined ? { target: args.target } : {}),
          scope: args.scope,
          effect: args.effect,
          storageScope,
          cwd,
        });
      } else {
        stored = {
          tool: args.tool,
          ...(args.target !== undefined ? { target: args.target } : {}),
          scope: args.scope,
          effect: args.effect,
          grantedAt: new Date().toISOString(),
          source: storageScope,
        };
      }
      setPersistedRule(stored);
      return stored;
    },
    async removePersistedRule(args) {
      const storageScope = args.storageScope ?? "user";
      const cwd = args.cwd ?? opts.defaultCwd ?? process.cwd();
      let removed = false;
      if (opts.storage) {
        removed = await opts.storage.remove({
          tool: args.tool,
          ...(args.target !== undefined ? { target: args.target } : {}),
          scope: args.scope,
          storageScope,
          cwd,
        });
      } else {
        removed = deletePersistedRule(args.tool, args.target, args.scope);
      }
      // Always purge from memory so the manager reflects the on-disk state.
      deletePersistedRule(args.tool, args.target, args.scope);
      return removed;
    },
    seedPersistedRules(rules) {
      persistedAllows.clear();
      persistedDenies.clear();
      for (const r of rules) {
        const k = ruleKey(r.tool, r.target, r.scope);
        if (r.effect === "deny") persistedDenies.set(k, r);
        else persistedAllows.set(k, r);
      }
    },
    async clearPersistedUserRules() {
      if (opts.storage) {
        await opts.storage.clearUser();
      }
      // Drop user-source rules from memory (project rules survive).
      for (const [k, r] of persistedAllows) {
        if ((r.source ?? "user") === "user") persistedAllows.delete(k);
      }
      for (const [k, r] of persistedDenies) {
        if ((r.source ?? "user") === "user") persistedDenies.delete(k);
      }
    },
    async check(req) {
      const name = req.tool.definition.function.name;
      const target = targetOf(name, req.args, req.cwd);

      // Persisted denies are absolute — they win over auto-allow categories
      // and over any session-level allow.
      const denied = denyMatches(name, target);
      if (denied) return "deny";

      if (!req.tool.requiresPermission) return "allow";
      if (autoAllow.has(req.tool.category)) return "allow";

      // Persisted allows.
      if (allowMatches(name, target)) return "allow";

      // Session allows.
      if (tools.has(name)) return "allow";
      if (targets.has(sessionTargetKey(name, target))) return "allow";

      // Need to ask. If nobody is listening, default-deny (safe).
      if (promptHandlers.size === 0) return "deny";
      return await new Promise<PermissionDecision>((resolve) => {
        const prompt: PermissionPrompt = {
          request: req,
          resolve: (choice) => {
            switch (choice.kind) {
              case "deny":
                resolve("deny");
                return;
              case "deny_persisted": {
                void (async () => {
                  try {
                    const stored = opts.storage
                      ? await opts.storage.add({
                          tool: name,
                          scope: "tool",
                          effect: "deny",
                          storageScope: "user",
                          cwd: req.cwd,
                        })
                      : ({
                          tool: name,
                          scope: "tool" as const,
                          effect: "deny" as const,
                          grantedAt: new Date().toISOString(),
                          source: "user" as const,
                        } satisfies PermissionRule);
                    setPersistedRule(stored);
                  } finally {
                    resolve("deny");
                  }
                })();
                return;
              }
              case "allow_once":
                resolve("allow");
                return;
              case "allow_session_tool":
                tools.add(name);
                resolve("allow");
                return;
              case "allow_session_target":
                targets.add(sessionTargetKey(name, target));
                resolve("allow");
                return;
              case "allow_persisted_tool": {
                void (async () => {
                  try {
                    const stored = opts.storage
                      ? await opts.storage.add({
                          tool: name,
                          scope: "tool",
                          effect: "allow",
                          storageScope: "user",
                          cwd: req.cwd,
                        })
                      : ({
                          tool: name,
                          scope: "tool" as const,
                          effect: "allow" as const,
                          grantedAt: new Date().toISOString(),
                          source: "user" as const,
                        } satisfies PermissionRule);
                    setPersistedRule(stored);
                  } finally {
                    resolve("allow");
                  }
                })();
                return;
              }
              case "allow_persisted_target": {
                void (async () => {
                  try {
                    const stored = opts.storage
                      ? await opts.storage.add({
                          tool: name,
                          target,
                          scope: "target",
                          effect: "allow",
                          storageScope: "user",
                          cwd: req.cwd,
                        })
                      : ({
                          tool: name,
                          target,
                          scope: "target" as const,
                          effect: "allow" as const,
                          grantedAt: new Date().toISOString(),
                          source: "user" as const,
                        } satisfies PermissionRule);
                    setPersistedRule(stored);
                  } finally {
                    resolve("allow");
                  }
                })();
                return;
              }
            }
          },
        };
        for (const h of promptHandlers) h(prompt);
      });
    },
  };
}
