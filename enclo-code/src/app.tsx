import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  ApiClient,
  ApiError,
  AuthError,
  signin,
  signup,
  signout,
  fetchMe,
  listModels,
  compactConversation,
  getConversation,
  listConversations,
  applyCustomCommand,
  discoverCustomCommands,
  discoverCustomSubagents,
  EMPTY_USAGE,
  addUsage,
  restoreHistory,
  shouldAutoCompact,
  builtInRegistry,
  combinedRegistry,
  createSpawnAgentTool,
  makeRegistry,
  McpManager,
  loadMcpConfig,
  runAgent,
  createApiAdapter,
  buildSystemMessages,
  findProjectContext,
  listSearchPaths,
  expandFileRefs,
  createPermissionManager,
  addPersistedRule,
  clearPersistedUserRules,
  loadPersistedPermissions,
  removePersistedRule,
  userPermissionsPath,
  createHooksManager,
  HOOK_EVENTS,
  type CustomCommand,
  type CustomSubagent,
  type ConversationSummary,
  type Model,
  type TokenUsageState,
  type SubagentSpec,
  type McpServerState,
  type AgentEvent,
  type AgentMessage,
  type UserContentBlock,
  type ProjectContext,
  type PermissionPrompt as PermPrompt,
  type PermissionRule,
  type HooksManager,
} from "@enclo/core";

import type { ConfigStore, EncloConfig } from "./config.js";
import { COMMANDS, parseSlash } from "./commands/registry.js";

import { Header } from "./components/Header.js";
import {
  Chat,
  type RenderedMessage,
  type AssistantBlock,
  type ToolBlock,
  type TextBlock,
  type ReasoningBlock,
} from "./components/Chat.js";
import { Footer } from "./components/Footer.js";
import { HistoryPicker } from "./components/HistoryPicker.js";
import { Input } from "./components/Input.js";
import { FirstRun } from "./components/FirstRun.js";
import { SignInForm } from "./components/SignInForm.js";
import { SignUpForm } from "./components/SignUpForm.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PermissionPromptView } from "./components/PermissionPrompt.js";
import {
  attachImage,
  buildMultiModalContent,
  formatBytes,
  type PendingImage,
} from "./commands/image.js";
import {
  detectPlatform,
  tryReadClipboardImage,
} from "./commands/clipboard.js";

type Screen =
  | { kind: "loading" }
  | { kind: "first_run" }
  | { kind: "auth_choice" }
  | { kind: "signin" }
  | { kind: "signup" }
  | { kind: "model_picker"; models: Model[] }
  | { kind: "history_picker"; conversations: ConversationSummary[] }
  | { kind: "chat" };

export interface AppProps {
  config: ConfigStore;
}

export function App({ config }: AppProps): React.ReactElement {
  const app = useApp();
  const [cfg, setCfg] = useState<EncloConfig>({});
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const [streamingBlocks, setStreamingBlocks] = useState<AssistantBlock[] | undefined>(undefined);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<PermPrompt | undefined>(undefined);
  const [showHelpHint, setShowHelpHint] = useState(false);
  const [cwd, setCwd] = useState<string>(process.cwd());
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [planExitConfirm, setPlanExitConfirm] = useState<boolean>(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [customCommands, setCustomCommands] = useState<Map<string, CustomCommand>>(
    () => new Map(),
  );
  const [customSubagents, setCustomSubagents] = useState<Map<string, CustomSubagent>>(
    () => new Map(),
  );
  const customShadowWarnedRef = useRef<boolean>(false);
  /**
   * Forward reference to sendChat so the (earlier-declared) handleSlash
   * can dispatch a custom command without hitting a TDZ. Populated by an
   * effect once sendChat itself has been bound.
   */
  const sendChatRef = useRef<
    (
      line: string,
      opts?: { modelOverride?: string; allowedToolsOverride?: string[] },
    ) => Promise<void>
  >(async () => {
    /* replaced once sendChat is constructed */
  });
  const clipboardSeqRef = useRef<number>(0);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageState>(EMPTY_USAGE);
  const [models, setModels] = useState<Model[]>([]);

  const [mcpServerStates, setMcpServerStates] = useState<McpServerState[]>([]);
  const [mcpToolsTick, setMcpToolsTick] = useState<number>(0);
  const mcpManagerRef = useRef<McpManager | null>(null);

  // Convert the discovered CustomSubagents into the lighter-weight
  // SubagentSpec map the spawn_agent tool and the loop need.
  const subagentSpecs = useMemo<ReadonlyMap<string, SubagentSpec>>(() => {
    const out = new Map<string, SubagentSpec>();
    for (const [name, sub] of customSubagents) {
      const spec: SubagentSpec = {
        description: sub.description,
        systemPrompt: sub.systemPrompt,
      };
      if (sub.tools) spec.tools = sub.tools;
      if (sub.model) spec.model = sub.model;
      out.set(name, spec);
    }
    return out;
  }, [customSubagents]);

  const tools = useMemo(() => {
    const mgr = mcpManagerRef.current;
    const dynamicSpawn = createSpawnAgentTool(subagentSpecs);
    const base = mgr ? combinedRegistry(mgr.getTools()) : builtInRegistry();
    // Replace the static spawn_agent with one whose description lists
    // the currently-registered custom subagents.
    const swapped = base
      .list()
      .map((t) => (t.definition.function.name === "spawn_agent" ? dynamicSpawn : t));
    return makeRegistry(swapped);
    // mcpToolsTick is the dependency that signals "MCP tools changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpToolsTick, subagentSpecs]);
  const permissions = useMemo(
    () =>
      createPermissionManager({
        storage: {
          add: (args) =>
            addPersistedRule(
              {
                tool: args.tool,
                ...(args.target !== undefined ? { target: args.target } : {}),
                scope: args.scope,
                effect: args.effect,
              },
              args.storageScope,
              args.cwd,
            ),
          remove: (args) =>
            removePersistedRule(
              args.tool,
              args.target,
              args.scope,
              args.storageScope,
              args.cwd,
            ),
          clearUser: () => clearPersistedUserRules(),
        },
        defaultCwd: process.cwd(),
      }),
    [],
  );
  // Track confirmation flow for /allow clear-persisted (Y/n).
  const [persistedClearConfirm, setPersistedClearConfirm] = useState<{ count: number } | null>(
    null,
  );
  const [hooks, setHooks] = useState<HooksManager | null>(null);
  const sessionStartedRef = useRef<boolean>(false);
  const conversationIdRef = useRef<{ current: string | null }>({ current: null });
  const agentHistoryRef = useRef<AgentMessage[]>([]);
  /** Number of assistant turns since plan mode was last turned on. */
  const planTurnsRef = useRef<number>(0);
  /** When set, inject a system message at the start of the next chat turn. */
  const pendingSystemRef = useRef<string | null>(null);
  /** True after a /compact failure — disables auto-compact for the rest of the session. */
  const compactDisabledRef = useRef<boolean>(false);
  /** Stale-while-revalidate cache for /history so reopening is instant. */
  const historyCacheRef = useRef<ConversationSummary[] | null>(null);

  const activeModel = useMemo(
    () =>
      cfg.active_model
        ? models.find((m) => m.id === cfg.active_model)
        : undefined,
    [cfg.active_model, models],
  );

  // Subscribe to permission prompts.
  useEffect(() => {
    return permissions.onPrompt((p) => setPendingPrompt(p));
  }, [permissions]);

  // Re-load persisted permissions whenever cwd changes (project rules walk
  // upward from cwd, so the set may differ between projects).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rules = await loadPersistedPermissions(cwd);
        if (!cancelled) permissions.seedPersistedRules(rules);
      } catch {
        /* corrupt file etc. — leave manager untouched */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, permissions]);

  // Auto-load enclo.md whenever cwd changes (and on startup).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ctx = await findProjectContext(cwd);
      if (!cancelled) setProjectContext(ctx);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Auto-discover custom slash commands whenever cwd changes (and on
  // startup). Warn once per session if any custom command shadows a
  // built-in (we keep the built-in winning).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await discoverCustomCommands(cwd);
      if (cancelled) return;
      const builtInNames = new Set(COMMANDS.map((c) => c.name as string));
      const shadowed: string[] = [];
      for (const name of found.keys()) {
        if (builtInNames.has(name)) shadowed.push(name);
      }
      setCustomCommands(found);
      if (shadowed.length > 0 && !customShadowWarnedRef.current) {
        customShadowWarnedRef.current = true;
        setNotice(
          `⚠ Custom commands shadow built-ins (built-in wins): ${shadowed.join(", ")}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Auto-discover custom subagents whenever cwd changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await discoverCustomSubagents(cwd);
      if (!cancelled) setCustomSubagents(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Build a hooks manager rooted at the current cwd whenever cwd changes.
  // Loads ~/.enclo/hooks.json + <cwd>/.enclo/hooks.json on construction.
  useEffect(() => {
    let cancelled = false;
    const mgr = createHooksManager({ projectDir: cwd });
    void (async () => {
      await mgr.reload();
      if (cancelled) return;
      setHooks(mgr);
      const errs = mgr.loadErrors();
      if (errs.length > 0) {
        setNotice(`⚠ hooks: ${errs.join("\n")}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // SessionEnd fires when the App unmounts (best-effort — hook timeouts are
  // capped so we don't block process exit indefinitely).
  useEffect(() => {
    return () => {
      if (hooks) {
        void hooks.run("SessionEnd", { event: "SessionEnd", cwd });
      }
    };
  }, [cwd, hooks]);

  // Bring up MCP servers whenever cwd changes. Each server's progress shows
  // up as a notice line; the global tools registry is rebuilt once all
  // connections settle.
  useEffect(() => {
    let cancelled = false;
    const mgr = new McpManager();
    mcpManagerRef.current = mgr;
    void (async () => {
      const { config: mcpConfig, errors } = await loadMcpConfig(cwd);
      if (cancelled) return;
      if (errors.length > 0) {
        setNotice(`⚠ mcp config: ${errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
      }
      const serverNames = Object.keys(mcpConfig.mcpServers ?? {});
      if (serverNames.length === 0) {
        setMcpServerStates([]);
        return;
      }
      setNotice(`Connecting to ${serverNames.length} MCP server(s)…`);
      await mgr.start(mcpConfig, (state) => {
        if (cancelled) return;
        setMcpServerStates(mgr.getStatus());
      });
      if (cancelled) {
        await mgr.stop();
        return;
      }
      setMcpServerStates(mgr.getStatus());
      setMcpToolsTick((t) => t + 1);
      const summary = mgr
        .getStatus()
        .map((s) =>
          s.status === "connected"
            ? `🔌 ${s.server} ✓ (${s.toolCount} tools)`
            : `🔌 ${s.server} ✗ (${s.error ?? s.status})`,
        )
        .join("\n");
      setNotice(summary);
    })();
    return () => {
      cancelled = true;
      void mgr.stop();
      if (mcpManagerRef.current === mgr) {
        mcpManagerRef.current = null;
      }
    };
  }, [cwd]);

  const client = useMemo(
    () =>
      new ApiClient({
        config,
        onAuthLost: () => {
          setNotice("Session expired — please sign in again.");
          setScreen({ kind: "signin" });
        },
      }),
    [config],
  );

  const reloadCfg = useCallback(async (): Promise<EncloConfig> => {
    const fresh = await client.invalidateConfig();
    setCfg(fresh);
    return fresh;
  }, [client]);

  // Bootstrap.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial = await config.load();
      if (cancelled) return;
      setCfg(initial);
      if (!initial.api_url) {
        setScreen({ kind: "first_run" });
        return;
      }
      if (!initial.access_token) {
        setScreen({ kind: "auth_choice" });
        return;
      }
      try {
        await fetchMe(client);
        await reloadCfg();
        setScreen({ kind: "chat" });
      } catch {
        setScreen({ kind: "signin" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, config, reloadCfg]);

  const runSignin = useCallback(
    async (args: { email: string; password: string }) => {
      setAuthBusy(true);
      setAuthError(undefined);
      try {
        await signin(client, config, args);
        await reloadCfg();
        setNotice(undefined);
        setScreen({ kind: "chat" });
      } catch (err) {
        setAuthError(formatError(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [client, config, reloadCfg],
  );

  const runSignup = useCallback(
    async (args: { email: string; password: string; display_name?: string }) => {
      setAuthBusy(true);
      setAuthError(undefined);
      try {
        await signup(client, config, args);
        await reloadCfg();
        setNotice(undefined);
        setScreen({ kind: "chat" });
      } catch (err) {
        setAuthError(formatError(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [client, config, reloadCfg],
  );

  const runSignout = useCallback(async () => {
    await signout(client, config);
    await reloadCfg();
    setMessages([]);
    setConversationId(null);
    conversationIdRef.current.current = null;
    agentHistoryRef.current = [];
    setTokenUsage(EMPTY_USAGE);
    compactDisabledRef.current = false;
    setNotice("Signed out.");
    setScreen({ kind: "auth_choice" });
  }, [client, config, reloadCfg]);

  const openModelPicker = useCallback(async () => {
    setNotice("Loading models…");
    try {
      const list = await listModels(client);
      setModels(list);
      setNotice(undefined);
      setScreen({ kind: "model_picker", models: list });
    } catch (err) {
      setNotice(`Failed to load models: ${formatError(err)}`);
    }
  }, [client]);

  // Eagerly load the model registry once we're authed, so the Footer can
  // compute "context used" without waiting for the user to open /models.
  useEffect(() => {
    if (screen.kind !== "chat") return;
    if (models.length > 0) return;
    if (!cfg.access_token) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listModels(client);
        if (!cancelled) setModels(list);
      } catch {
        /* non-fatal — Footer just won't show the % */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg.access_token, client, models.length, screen.kind]);

  const handleCd = useCallback(
    async (target: string) => {
      const next = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      try {
        const stat = await fs.stat(next);
        if (!stat.isDirectory()) {
          setNotice(`/cd: ${next} is not a directory.`);
          return;
        }
        setCwd(next);
        setNotice(`cwd: ${next}`);
      } catch (err) {
        setNotice(`/cd: ${(err as Error).message}`);
      }
    },
    [cwd],
  );

  const handleAllow = useCallback(
    async (subargs: string[]) => {
      const sub = subargs[0]?.toLowerCase();
      const rest = subargs.slice(1);

      if (sub === "clear") {
        permissions.reset();
        setNotice("Cleared session permissions.");
        return;
      }

      if (sub === "clear-persisted") {
        const snap = permissions.snapshot();
        const userCount =
          snap.persistedAllows.filter((r) => r.source === "user").length +
          snap.persistedDenies.filter((r) => r.source === "user").length;
        if (userCount === 0) {
          setNotice("No persisted user rules to clear.");
          return;
        }
        setPersistedClearConfirm({ count: userCount });
        setNotice(
          `This will delete ${userCount} persisted user rule${userCount === 1 ? "" : "s"} from ${userPermissionsPath()}. Continue? [Y/n]`,
        );
        return;
      }

      if (sub === "add" || sub === "deny") {
        const tool = rest[0];
        if (!tool) {
          setNotice(`/allow ${sub}: usage: /allow ${sub} <tool> [target]`);
          return;
        }
        const target = rest.slice(1).join(" ") || undefined;
        try {
          await permissions.addPersistedRule({
            tool,
            ...(target !== undefined ? { target } : {}),
            scope: target ? "target" : "tool",
            effect: sub === "deny" ? "deny" : "allow",
            storageScope: "user",
            cwd,
          });
          const where = target ? `${tool} → ${target}` : tool;
          setNotice(
            sub === "deny"
              ? `Persisted user deny added: ${where}`
              : `Persisted user allow added: ${where}`,
          );
        } catch (err) {
          setNotice(`/allow ${sub} failed: ${formatError(err)}`);
        }
        return;
      }

      if (sub === "remove") {
        const tool = rest[0];
        if (!tool) {
          setNotice("/allow remove: usage: /allow remove <tool> [target]");
          return;
        }
        const target = rest.slice(1).join(" ") || undefined;
        try {
          const removed = await permissions.removePersistedRule({
            tool,
            ...(target !== undefined ? { target } : {}),
            scope: target ? "target" : "tool",
            storageScope: "user",
            cwd,
          });
          if (!removed) {
            const where = target ? `${tool} → ${target}` : tool;
            setNotice(`/allow remove: no matching rule for ${where}.`);
            return;
          }
          const where = target ? `${tool} → ${target}` : tool;
          setNotice(`Removed persisted user rule: ${where}`);
        } catch (err) {
          setNotice(`/allow remove failed: ${formatError(err)}`);
        }
        return;
      }

      // Default: render grouped table.
      const snap = permissions.snapshot();
      const lines: string[] = [];

      lines.push("Session allows:");
      if (snap.sessionAllows.length === 0) {
        lines.push("  (none)");
      } else {
        for (const e of snap.sessionAllows) {
          if (e.scope === "tool") lines.push(`  ${e.tool} (tool)`);
          else lines.push(`  ${e.tool}:${e.target ?? ""} (target)`);
        }
      }

      const userAllows = snap.persistedAllows.filter((r) => r.source === "user");
      lines.push("Persisted user allows:");
      if (userAllows.length === 0) {
        lines.push("  (none)");
      } else {
        for (const e of userAllows) {
          const head =
            e.scope === "tool"
              ? `${e.tool} (tool)`
              : `${e.tool}:${e.target ?? ""} (target)`;
          const granted = e.grantedAt ? `  — granted ${e.grantedAt.slice(0, 10)}` : "";
          lines.push(`  ${head}${granted}`);
        }
      }

      const userDenies = snap.persistedDenies.filter((r) => r.source === "user");
      lines.push("Persisted user denies:");
      if (userDenies.length === 0) {
        lines.push("  (none)");
      } else {
        for (const e of userDenies) {
          const head =
            e.scope === "tool"
              ? `${e.tool} (tool)`
              : `${e.tool}:${e.target ?? ""} (target)`;
          lines.push(`  ${head}  — granted ${e.grantedAt.slice(0, 10)}`);
        }
      }

      const projectAllows = snap.persistedAllows.filter((r) => r.source === "project");
      const projectDenies = snap.persistedDenies.filter((r) => r.source === "project");
      if (projectAllows.length > 0 || projectDenies.length > 0) {
        lines.push("Project rules (.enclo/permissions.json):");
        for (const e of projectAllows) {
          const head =
            e.scope === "tool"
              ? `${e.tool} (tool)`
              : `${e.tool}:${e.target ?? ""} (target)`;
          lines.push(`  allow ${head}`);
        }
        for (const e of projectDenies) {
          const head =
            e.scope === "tool"
              ? `${e.tool} (tool)`
              : `${e.tool}:${e.target ?? ""} (target)`;
          lines.push(`  deny  ${head}`);
        }
      }

      lines.push("");
      lines.push("Subcommands: clear | clear-persisted | add <tool> [target] | remove <tool> [target] | deny <tool> [target]");
      setNotice(lines.join("\n"));
    },
    [cwd, permissions],
  );

  const enterPlanMode = useCallback(() => {
    setPlanMode(true);
    planTurnsRef.current = 0;
    setPlanExitConfirm(false);
    setNotice("Plan mode: ON — write/exec tools disabled.");
  }, []);

  const exitPlanModeNow = useCallback(
    (approveExecution: boolean) => {
      setPlanMode(false);
      setPlanExitConfirm(false);
      if (approveExecution) {
        pendingSystemRef.current =
          "User has reviewed the plan and approved execution. Execute the planned steps now.";
        setNotice("Plan mode: OFF — execution approved for next turn.");
      } else {
        setNotice("Plan mode: OFF.");
      }
      planTurnsRef.current = 0;
    },
    [],
  );

  const handleImage = useCallback(
    async (args: string[]) => {
      const target = args.join(" ").trim();
      const res = await attachImage(target, { cwd });
      if (!res.ok) {
        setNotice(res.error);
        return;
      }
      setPendingImages((prev) => [...prev, res.image]);
      setNotice(
        `Attached: ${res.image.name} (${formatBytes(res.image.bytes)}). Send your message to include it.`,
      );
    },
    [cwd],
  );

  const handleContext = useCallback(() => {
    if (projectContext) {
      setNotice(
        `enclo.md loaded from ${projectContext.path} (${projectContext.content.length} chars):\n\n${projectContext.content}`,
      );
    } else {
      const paths = listSearchPaths(cwd);
      setNotice(
        `No enclo.md found. Searched:\n${paths.map((p) => `  ${p}`).join("\n")}`,
      );
    }
  }, [cwd, projectContext]);

  const handleReloadContext = useCallback(async () => {
    const ctx = await findProjectContext(cwd);
    setProjectContext(ctx);
    if (ctx) {
      setNotice(`Reloaded enclo.md from ${ctx.path} (${ctx.content.length} chars).`);
    } else {
      setNotice(`No enclo.md found under ${cwd} (walked toward home dir).`);
    }
  }, [cwd]);

  const handleClipboardPaste = useCallback(async (): Promise<boolean> => {
    clipboardSeqRef.current += 1;
    const img = await tryReadClipboardImage({
      platform: detectPlatform(),
      sequence: clipboardSeqRef.current,
    });
    if (!img) {
      // No image — let the keystroke fall through to terminal text paste.
      clipboardSeqRef.current -= 1;
      return false;
    }
    const pending: PendingImage = {
      path: `clipboard:${img.name}`,
      name: img.name,
      base64DataUrl: img.base64DataUrl,
      bytes: img.sizeBytes,
      mime: "image/png",
    };
    setPendingImages((prev) => [...prev, pending]);
    setNotice(
      `Attached: ${pending.name} (${formatBytes(pending.bytes)}). Send your message to include it.`,
    );
    return true;
  }, []);

  const togglePlanMode = useCallback(() => {
    if (planExitConfirm) return;
    if (!planMode) {
      enterPlanMode();
      return;
    }
    if (planTurnsRef.current > 0) {
      setPlanExitConfirm(true);
      setNotice("Exit plan mode and execute the planned steps? [Y/n]");
    } else {
      exitPlanModeNow(false);
    }
  }, [enterPlanMode, exitPlanModeNow, planExitConfirm, planMode]);

  // Global key handler: Shift-Tab toggles plan mode; Y/n resolves either the
  // plan-mode exit confirmation or the persisted-clear confirmation.
  useInput(
    (input, key) => {
      if (persistedClearConfirm) {
        const ch = input.toLowerCase();
        if (ch === "y" || key.return) {
          const count = persistedClearConfirm.count;
          setPersistedClearConfirm(null);
          void (async () => {
            try {
              await permissions.clearPersistedUserRules();
              setNotice(`Cleared ${count} persisted user rule${count === 1 ? "" : "s"}.`);
            } catch (err) {
              setNotice(`/allow clear-persisted failed: ${formatError(err)}`);
            }
          })();
        } else if (ch === "n" || key.escape) {
          setPersistedClearConfirm(null);
          setNotice("Cancelled. Persisted rules unchanged.");
        }
        return;
      }
      if (planExitConfirm) {
        const ch = input.toLowerCase();
        if (ch === "y" || key.return) {
          exitPlanModeNow(true);
        } else if (ch === "n" || key.escape) {
          setPlanExitConfirm(false);
          setNotice("Plan mode: still ON.");
        }
        return;
      }
      if (key.shift && key.tab) togglePlanMode();
    },
    { isActive: screen.kind === "chat" && !pendingPrompt },
  );

  // Toggle the most-recent reasoning block (collapsed ↔ expanded). Hooked
  // up to the `/reasoning` slash command rather than a bare keystroke so it
  // doesn't conflict with normal text input.
  const toggleLatestReasoning = useCallback(() => {
    const msgs = messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.blocks) {
        for (let j = m.blocks.length - 1; j >= 0; j -= 1) {
          const b = m.blocks[j];
          if (b && b.kind === "reasoning") {
            b.collapsed = !b.collapsed;
            // setMessages with the new array reference so React re-renders.
            setMessages([...msgs]);
            setNotice(b.collapsed ? "Reasoning collapsed." : "Reasoning expanded.");
            return;
          }
        }
      }
    }
    setNotice("No reasoning block to toggle.");
  }, [messages]);

  const handleTools = useCallback(() => {
    const lines = tools.list().map((t) => {
      const flag = t.requiresPermission ? "needs-permission" : "auto";
      return `  ${t.definition.function.name}  [${t.category}, ${flag}]`;
    });
    setNotice(["Available tools:", ...lines].join("\n"));
  }, [tools]);

  const performResume = useCallback(
    async (id: string) => {
      setNotice(`Resuming ${id}…`);
      try {
        const detail = await getConversation(client, id);
        const restored = restoreHistory(detail);
        agentHistoryRef.current = restored;
        conversationIdRef.current.current = detail.id;
        setConversationId(detail.id);
        const rendered: RenderedMessage[] = restored
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const content =
              typeof m.content === "string"
                ? m.content
                : m.content
                    .map((b) =>
                      b.type === "text" ? b.text : `[image: ${b.image_url.url.slice(0, 40)}…]`,
                    )
                    .join("\n");
            return { id: randomUUID(), role: m.role, content };
          });
        setMessages(rendered);
        setTokenUsage(EMPTY_USAGE);
        compactDisabledRef.current = false;
        if (cfg.active_model && detail.model && detail.model !== cfg.active_model) {
          await config.update({ active_model: detail.model });
          await reloadCfg();
          setNotice(
            `Resumed conversation. Switched model from ${cfg.active_model} to ${detail.model} (the conversation's original model).`,
          );
        } else {
          setNotice(`Resumed conversation (${restored.length} messages).`);
        }
        setScreen({ kind: "chat" });
      } catch (err) {
        setNotice(`/resume failed: ${formatError(err)}`);
        setScreen({ kind: "chat" });
      }
    },
    [cfg.active_model, client, config, reloadCfg],
  );

  const handleHistory = useCallback(async () => {
    // Render the cached list first (instant) so the picker isn't blank for
    // the network roundtrip; the background fetch then refreshes the screen
    // when it lands. Only network errors surface as a notice; if the cache
    // is empty, fall through to the existing "Loading…" placeholder.
    const cached = historyCacheRef.current;
    if (cached && cached.length > 0) {
      setScreen({ kind: "history_picker", conversations: cached });
      setNotice("Refreshing conversations…");
    } else {
      setNotice("Loading conversations…");
    }
    try {
      const conversations = await listConversations(client);
      historyCacheRef.current = conversations;
      setNotice(undefined);
      setScreen({ kind: "history_picker", conversations });
    } catch (err) {
      setNotice(`/history failed: ${formatError(err)}`);
    }
  }, [client]);

  const handleResume = useCallback(
    async (args: string[]) => {
      const id = args[0]?.trim();
      if (!id) {
        setNotice("/resume: usage: /resume <id>");
        return;
      }
      await performResume(id);
    },
    [performResume],
  );

  const tryAutoCompact = useCallback(
    async (lastPromptTokens: number) => {
      const cid = conversationIdRef.current.current;
      if (!cid) return;
      if (
        !shouldAutoCompact({
          lastRequestPromptTokens: lastPromptTokens,
          contextLength: activeModel?.context_length,
          threshold: cfg.compact_threshold,
          disabled: compactDisabledRef.current,
          hasConversationId: true,
        })
      ) {
        return;
      }
      const outcome = await compactConversation(client, cid);
      if (outcome.kind === "nothing_to_compact") return;
      if (outcome.kind === "error") {
        compactDisabledRef.current = true;
        setNotice(
          `⚠ Auto-compact failed: ${outcome.message}. Disabling for this session.`,
        );
        return;
      }
      try {
        const detail = await getConversation(client, cid);
        agentHistoryRef.current = restoreHistory(detail);
        setNotice(
          `📦 Context auto-compacted: ${outcome.result.compacted_count} turns summarized.`,
        );
      } catch (err) {
        compactDisabledRef.current = true;
        setNotice(
          `⚠ Auto-compact failed: ${formatError(err)}. Disabling for this session.`,
        );
      }
    },
    [activeModel?.context_length, cfg.compact_threshold, client],
  );

  const handleReloadCommands = useCallback(async () => {
    const found = await discoverCustomCommands(cwd);
    setCustomCommands(found);
    setNotice(
      found.size > 0
        ? `Reloaded ${found.size} custom command(s): ${[...found.keys()].join(", ")}`
        : "No custom commands found under .enclo/commands/.",
    );
  }, [cwd]);

  const handleAgents = useCallback(() => {
    if (customSubagents.size === 0) {
      setNotice(
        "No custom subagents found under .enclo/agents/. Add a markdown file there with frontmatter (name, description, tools, model).",
      );
      return;
    }
    const lines = ["Custom subagents:"];
    for (const sub of customSubagents.values()) {
      const tools = sub.tools ? ` [tools: ${sub.tools.join(", ")}]` : "";
      const model = sub.model ? ` [model: ${sub.model}]` : "";
      lines.push(`  ${sub.name} — ${sub.description}${tools}${model}`);
    }
    setNotice(lines.join("\n"));
  }, [customSubagents]);

  const handleReloadAgents = useCallback(async () => {
    const found = await discoverCustomSubagents(cwd);
    setCustomSubagents(found);
    setNotice(
      found.size > 0
        ? `Reloaded ${found.size} custom subagent(s): ${[...found.keys()].join(", ")}`
        : "No custom subagents found under .enclo/agents/.",
    );
  }, [cwd]);

  const handleHooks = useCallback(() => {
    if (!hooks) {
      setNotice("Hooks not loaded yet.");
      return;
    }
    const counts = hooks.counts();
    const lines: string[] = [
      `Hook config files:`,
      `  user:    ${hooks.userPath}`,
      `  project: ${hooks.projectPath}  (overrides user per event)`,
      `Counts per event:`,
    ];
    let total = 0;
    for (const ev of HOOK_EVENTS) {
      lines.push(`  ${ev}: ${counts[ev]}`);
      total += counts[ev];
    }
    if (total === 0) lines.push("  (no hooks configured)");
    const errs = hooks.loadErrors();
    if (errs.length > 0) {
      lines.push("Load errors:");
      for (const e of errs) lines.push(`  ${e}`);
    }
    setNotice(lines.join("\n"));
  }, [hooks]);

  const handleReloadHooks = useCallback(async () => {
    if (!hooks) {
      setNotice("Hooks not loaded yet.");
      return;
    }
    await hooks.reload();
    const counts = hooks.counts();
    const total = HOOK_EVENTS.reduce((s, e) => s + counts[e], 0);
    const errs = hooks.loadErrors();
    const errSuffix = errs.length > 0 ? `\n⚠ ${errs.join("\n⚠ ")}` : "";
    setNotice(`Reloaded hooks (${total} total).${errSuffix}`);
  }, [hooks]);

  const handleMcpStatus = useCallback(() => {
    if (mcpServerStates.length === 0) {
      setNotice(
        "No MCP servers configured. Add ~/.enclo/mcp.json or .enclo/mcp.json — see docs/MCP.md.",
      );
      return;
    }
    const lines: string[] = ["MCP servers:"];
    for (const s of mcpServerStates) {
      const head = `  ${s.server}  [${s.status}]  tools=${s.toolCount}`;
      lines.push(s.error ? `${head}  error=${s.error}` : head);
    }
    const mgr = mcpManagerRef.current;
    if (mgr) {
      const mcpTools = mgr.getTools();
      if (mcpTools.length > 0) {
        lines.push("");
        lines.push("Tools:");
        for (const t of mcpTools) {
          lines.push(`  ${t.definition.function.name}`);
        }
      }
    }
    setNotice(lines.join("\n"));
  }, [mcpServerStates]);

  const handleReloadMcp = useCallback(async () => {
    const mgr = mcpManagerRef.current;
    if (!mgr) {
      setNotice("/reload-mcp: no MCP manager available.");
      return;
    }
    setNotice("Reloading MCP config…");
    const { config: mcpConfig, errors } = await loadMcpConfig(cwd);
    if (errors.length > 0) {
      setNotice(
        `⚠ mcp config: ${errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`,
      );
    }
    await mgr.start(mcpConfig);
    setMcpServerStates(mgr.getStatus());
    setMcpToolsTick((t) => t + 1);
    const summary = mgr
      .getStatus()
      .map((s) =>
        s.status === "connected"
          ? `🔌 ${s.server} ✓ (${s.toolCount} tools)`
          : `🔌 ${s.server} ✗ (${s.error ?? s.status})`,
      )
      .join("\n");
    setNotice(summary || "No MCP servers configured.");
  }, [cwd]);

  const handleSlash = useCallback(
    async (line: string): Promise<boolean> => {
      const parsed = parseSlash(line);
      if (!parsed) {
        // Maybe a custom command — built-ins always win, so we only get
        // here when the head doesn't match a built-in name.
        const trimmed = line.trim();
        if (trimmed.startsWith("/")) {
          const space = trimmed.indexOf(" ");
          const head = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
          const argText = space === -1 ? "" : trimmed.slice(space + 1);
          const cmd = customCommands.get(head);
          if (cmd) {
            const applied = applyCustomCommand(cmd, argText, cwd);
            const chatOpts: { modelOverride?: string; allowedToolsOverride?: string[] } = {};
            if (applied.modelOverride) chatOpts.modelOverride = applied.modelOverride;
            if (applied.allowedToolsOverride) {
              chatOpts.allowedToolsOverride = applied.allowedToolsOverride;
            }
            await sendChatRef.current(applied.prompt, chatOpts);
            return true;
          }
        }
        return false;
      }
      switch (parsed.name) {
        case "exit":
          app.exit();
          return true;
        case "help": {
          const builtIn = COMMANDS.map((c) => `  /${c.name} — ${c.description}`).join("\n");
          const custom = [...customCommands.values()]
            .map((c) => {
              const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
              return `  /${c.name}${hint} — ${c.description}`;
            })
            .join("\n");
          const sections = [`Built-in commands:\n${builtIn}`];
          if (custom) sections.push(`Custom commands:\n${custom}`);
          setNotice(sections.join("\n\n"));
          return true;
        }
        case "clear":
          setMessages([]);
          setConversationId(null);
          conversationIdRef.current.current = null;
          agentHistoryRef.current = [];
          setTokenUsage(EMPTY_USAGE);
          compactDisabledRef.current = false;
          setNotice("Started a new conversation.");
          return true;
        case "signout":
          await runSignout();
          return true;
        case "signin":
          setAuthError(undefined);
          setScreen({ kind: "signin" });
          return true;
        case "signup":
          setAuthError(undefined);
          setScreen({ kind: "signup" });
          return true;
        case "models":
          await openModelPicker();
          return true;
        case "tools":
          handleTools();
          return true;
        case "reasoning":
          toggleLatestReasoning();
          return true;
        case "allow":
          await handleAllow(parsed.args);
          return true;
        case "cd":
          if (parsed.args.length === 0) {
            setNotice(`cwd: ${cwd}`);
          } else {
            await handleCd(parsed.args.join(" "));
          }
          return true;
        case "plan":
          togglePlanMode();
          return true;
        case "image":
          await handleImage(parsed.args);
          return true;
        case "context":
          handleContext();
          return true;
        case "reload-context":
          await handleReloadContext();
          return true;
        case "history":
        case "list":
          await handleHistory();
          return true;
        case "resume":
          await handleResume(parsed.args);
          return true;
        case "reload-commands":
          await handleReloadCommands();
          return true;
        case "mcp":
          handleMcpStatus();
          return true;
        case "reload-mcp":
          await handleReloadMcp();
          return true;
        case "hooks":
          handleHooks();
          return true;
        case "reload-hooks":
          await handleReloadHooks();
          return true;
        case "agents":
          handleAgents();
          return true;
        case "reload-agents":
          await handleReloadAgents();
          return true;
        default:
          // Unknown built-in name (e.g. a parallel feature added a name
          // to the registry but no handler here yet). Fall through so the
          // caller can treat it as plain chat.
          return false;
      }
    },
    [
      app,
      customCommands,
      cwd,
      handleAgents,
      handleAllow,
      handleCd,
      handleContext,
      handleHistory,
      handleImage,
      handleHooks,
      handleMcpStatus,
      handleReloadAgents,
      handleReloadCommands,
      handleReloadContext,
      handleReloadHooks,
      handleReloadMcp,
      handleResume,
      handleTools,
      openModelPicker,
      runSignout,
      togglePlanMode,
    ],
  );

  const sendChat = useCallback(
    async (
      line: string,
      opts: { modelOverride?: string; allowedToolsOverride?: string[] } = {},
    ) => {
      const modelForTurn = opts.modelOverride ?? cfg.active_model;
      if (!modelForTurn) {
        setNotice("No active model. Run /models to pick one.");
        return;
      }
      const toolsForTurn = (() => {
        if (!opts.allowedToolsOverride) return tools;
        const allow = new Set(opts.allowedToolsOverride);
        const filtered = tools.list().filter((t) => allow.has(t.definition.function.name));
        return makeRegistry(filtered);
      })();

      // Fire SessionStart once per session (first chat send).
      if (hooks && !sessionStartedRef.current) {
        sessionStartedRef.current = true;
        const startOutcome = await hooks.run("SessionStart", { event: "SessionStart", cwd });
        for (const m of [...startOutcome.warnings, ...startOutcome.notices]) {
          setMessages((prev) => [
            ...prev,
            { id: randomUUID(), role: "system", content: m },
          ]);
        }
      }

      // Fire UserPromptSubmit; a non-zero "block" exit stops the turn.
      if (hooks) {
        const promptOutcome = await hooks.run("UserPromptSubmit", {
          event: "UserPromptSubmit",
          prompt: line,
          cwd,
        });
        for (const m of [...promptOutcome.warnings, ...promptOutcome.notices]) {
          setMessages((prev) => [
            ...prev,
            { id: randomUUID(), role: "system", content: m },
          ]);
        }
        if (promptOutcome.blocked) {
          setMessages((prev) => [
            ...prev,
            {
              id: randomUUID(),
              role: "system",
              content: `🪝 prompt blocked by hook: ${promptOutcome.blockMessage ?? ""}`,
            },
          ]);
          return;
        }
      }

      // Snapshot and clear any pending image attachments — they belong to
      // exactly one outgoing message.
      const imagesForTurn = pendingImages;
      if (imagesForTurn.length > 0) setPendingImages([]);
      const hasImages = imagesForTurn.length > 0;

      // Expand @file references inline before building the user message.
      const expansion = await expandFileRefs(line, cwd);
      const expandedLine = expansion.expandedText;
      if (expansion.errors.length > 0) {
        setNotice(expansion.errors.join("\n"));
      }

      const userInput: string | UserContentBlock[] = hasImages
        ? buildMultiModalContent(expandedLine, imagesForTurn)
        : expandedLine;
      const fileChips = expansion.includedFiles
        .map((f) => `[+ ${f.displayPath}]`)
        .join(" ");
      const userDisplayContent = hasImages
        ? `${line}${line || fileChips ? "\n" : ""}${fileChips ? `${fileChips}\n` : ""}${imagesForTurn.map((i) => `[image: ${i.name}]`).join(" ")}`
        : `${line}${fileChips ? `\n${fileChips}` : ""}`;
      const userMsg: RenderedMessage = {
        id: randomUUID(),
        role: "user",
        content: userDisplayContent,
      };
      setMessages((prev) => [...prev, userMsg]);
      setChatBusy(true);
      setNotice(undefined);

      const blocks: AssistantBlock[] = [];
      const blocksRef = { current: blocks };
      let activeText: TextBlock | null = null;
      let activeReasoning: ReasoningBlock | null = null;
      const flushBlocks = (): void => {
        setStreamingBlocks([...blocksRef.current]);
      };
      flushBlocks();

      const adapter = createApiAdapter({
        client,
        model: modelForTurn,
        conversationIdRef: conversationIdRef.current,
      });

      try {
        const systemMessages = await buildSystemMessages({
          cwd,
          tools: toolsForTurn.list(),
          planMode,
          projectContext,
        });
        let history: AgentMessage[] =
          agentHistoryRef.current.length === 0
            ? systemMessages.map((content) => ({ role: "system", content }))
            : agentHistoryRef.current;
        if (pendingSystemRef.current) {
          history = [...history, { role: "system", content: pendingSystemRef.current }];
          pendingSystemRef.current = null;
        }

        let lastPromptTokens = 0;

        for await (const ev of runAgent({
          api: adapter,
          tools: toolsForTurn,
          permissions,
          cwd,
          history,
          userInput,
          planMode,
          ...(hooks ? { hooks } : {}),
          ...(subagentSpecs.size > 0 ? { subagents: subagentSpecs } : {}),
          apiFactory: (modelId) =>
            createApiAdapter({
              client,
              model: modelId,
              conversationIdRef: conversationIdRef.current,
            }),
        })) {
          if (ev.type === "assistant_text") {
            // A real answer chunk arrived — collapse the open thinking pane
            // to a one-line summary so the answer isn't pushed off-screen.
            // The user can still re-expand it by pressing `r`.
            if (activeReasoning) {
              activeReasoning.collapsed = true;
              activeReasoning = null;
            }
            if (!activeText) {
              activeText = { kind: "text", id: randomUUID(), text: "" };
              blocksRef.current.push(activeText);
            }
            activeText.text += ev.delta;
            flushBlocks();
          } else if (ev.type === "assistant_reasoning") {
            // Streaming CoT from a thinking model. Render in a dim/italic
            // pane; do NOT add to assistant content (the loop already
            // excludes it from the persisted message).
            if (!activeReasoning) {
              activeReasoning = { kind: "reasoning", id: randomUUID(), text: "" };
              blocksRef.current.push(activeReasoning);
            }
            activeReasoning.text += ev.delta;
            flushBlocks();
          } else if (ev.type === "tool_call_pending") {
            activeText = null;
            activeReasoning = null;
            const tb: ToolBlock = {
              kind: "tool",
              id: ev.call.id,
              name: ev.call.function.name,
              args: safeJson(ev.call.function.arguments),
              status: "pending",
            };
            blocksRef.current.push(tb);
            flushBlocks();
          } else if (ev.type === "tool_partial") {
            const tb = blocksRef.current.find(
              (b) => b.kind === "tool" && b.id === ev.call_id,
            ) as ToolBlock | undefined;
            if (tb) {
              if (!tb.partial) tb.partial = { stdout: "", stderr: "" };
              tb.partial[ev.channel] += ev.content;
              flushBlocks();
            }
          } else if (ev.type === "tool_denied") {
            const tb = blocksRef.current.find(
              (b) => b.kind === "tool" && b.id === ev.call_id,
            ) as ToolBlock | undefined;
            if (tb) tb.status = "denied";
            flushBlocks();
          } else if (ev.type === "tool_result") {
            const tb = blocksRef.current.find(
              (b) => b.kind === "tool" && b.id === ev.call_id,
            ) as ToolBlock | undefined;
            if (tb) {
              tb.status = tb.status === "denied" ? "denied" : "done";
              tb.result = ev.result;
              if (ev.display) tb.display = ev.display;
            }
            flushBlocks();
          } else if (ev.type === "sub_agent_event") {
            const tb = blocksRef.current.find(
              (b) => b.kind === "tool" && b.id === ev.parentCallId,
            ) as ToolBlock | undefined;
            if (tb) {
              if (!tb.subAgentEvents) tb.subAgentEvents = [];
              const label = labelSubAgentEvent(ev.event);
              if (label) {
                tb.subAgentEvents.push({ id: randomUUID(), label });
              }
            }
            flushBlocks();
          } else if (ev.type === "turn_complete") {
            if (ev.usage) {
              setTokenUsage((prev) => addUsage(prev, ev.usage));
              const p = ev.usage.prompt_tokens ?? 0;
              if (p > 0) lastPromptTokens = p;
            }
          } else if (ev.type === "agent_done") {
            agentHistoryRef.current = ev.finalMessages;
            if (conversationIdRef.current.current) {
              setConversationId(conversationIdRef.current.current);
            }
            if (planMode) planTurnsRef.current += 1;
          } else if (ev.type === "hook_notice" || ev.type === "hook_warning") {
            setMessages((prev) => [
              ...prev,
              { id: randomUUID(), role: "system", content: ev.message },
            ]);
          } else if (ev.type === "agent_error") {
            setNotice(humanizeAgentError(ev.message));
          }
        }

        // Commit the final assistant message into the persistent history.
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "assistant",
            content: blocksRef.current
              .filter((b): b is TextBlock => b.kind === "text")
              .map((b) => b.text)
              .join(""),
            blocks: [...blocksRef.current],
          },
        ]);

        if (lastPromptTokens > 0) {
          await tryAutoCompact(lastPromptTokens);
        }
      } catch (err) {
        setNotice(`Request failed: ${formatError(err)}`);
      } finally {
        setStreamingBlocks(undefined);
        setChatBusy(false);
      }
    },
    [cfg.active_model, client, cwd, hooks, pendingImages, permissions, planMode, projectContext, subagentSpecs, tools, tryAutoCompact],
  );

  useEffect(() => {
    sendChatRef.current = sendChat;
  }, [sendChat]);

  const dismissHelpHint = useCallback(() => {
    setShowHelpHint(false);
    if (cfg.help_hint_seen) return;
    void config.update({ help_hint_seen: true }).catch(() => undefined);
  }, [cfg.help_hint_seen, config]);

  const handleSubmit = useCallback(
    async (line: string) => {
      if (showHelpHint) dismissHelpHint();
      if (await handleSlash(line)) return;
      await sendChat(line);
    },
    [dismissHelpHint, handleSlash, sendChat, showHelpHint],
  );

  // First-run hint: show under the input when the user hasn't seen it yet.
  // Auto-hides (and marks the config flag) after 8 s OR on the next submit.
  useEffect(() => {
    if (screen.kind !== "chat") return;
    if (cfg.help_hint_seen) return;
    setShowHelpHint(true);
    const t = setTimeout(() => dismissHelpHint(), 8000);
    return () => clearTimeout(t);
  }, [screen.kind, cfg.help_hint_seen, dismissHelpHint]);

  // ----- render -----
  if (screen.kind === "loading") {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text color="gray">Loading…</Text>
      </Box>
    );
  }

  if (screen.kind === "first_run") {
    return (
      <FirstRun
        apiUrlSet={false}
        onApiUrl={async (url) => {
          await config.update({ api_url: url });
          await reloadCfg();
          setScreen({ kind: "auth_choice" });
        }}
        onAuthChoice={() => {
          /* unused at this stage */
        }}
      />
    );
  }

  if (screen.kind === "auth_choice") {
    return (
      <FirstRun
        apiUrlSet
        onApiUrl={() => {
          /* unused */
        }}
        onAuthChoice={(choice) => {
          setAuthError(undefined);
          setScreen({ kind: choice });
        }}
      />
    );
  }

  if (screen.kind === "signin") {
    return <SignInForm onSubmit={runSignin} busy={authBusy} error={authError} />;
  }
  if (screen.kind === "signup") {
    return <SignUpForm onSubmit={runSignup} busy={authBusy} error={authError} />;
  }

  if (screen.kind === "model_picker") {
    return (
      <ModelPicker
        models={screen.models}
        initial={cfg.active_model}
        onSelect={async (id) => {
          await config.update({ active_model: id });
          await reloadCfg();
          setNotice(`Active model set to ${id}.`);
          setScreen({ kind: "chat" });
        }}
      />
    );
  }

  if (screen.kind === "history_picker") {
    return (
      <HistoryPicker
        conversations={screen.conversations}
        onSelect={(id) => {
          void performResume(id);
        }}
      />
    );
  }

  const costRates =
    cfg.cost_per_million_prompt_tokens !== undefined ||
    cfg.cost_per_million_completion_tokens !== undefined
      ? {
          ...(cfg.cost_per_million_prompt_tokens !== undefined
            ? { promptPerMillion: cfg.cost_per_million_prompt_tokens }
            : {}),
          ...(cfg.cost_per_million_completion_tokens !== undefined
            ? { completionPerMillion: cfg.cost_per_million_completion_tokens }
            : {}),
        }
      : undefined;

  return (
    <Box flexDirection="column">
      <Header
        email={cfg.user?.email}
        apiUrl={cfg.api_url}
        activeModel={cfg.active_model}
        planMode={planMode}
        streaming={streamingBlocks !== undefined}
      />
      <Chat messages={messages} streamingBlocks={streamingBlocks} notice={notice} />
      <Footer
        usage={tokenUsage}
        contextLength={activeModel?.context_length}
        costRates={costRates}
      />
      {pendingPrompt ? (
        <PermissionPromptView
          prompt={{
            request: pendingPrompt.request,
            resolve: (choice) => {
              pendingPrompt.resolve(choice);
              setPendingPrompt(undefined);
            },
          }}
        />
      ) : (
        <Box flexDirection="column">
          {pendingImages.length > 0 && (
            <Box paddingX={1}>
              {pendingImages.map((img) => (
                <Text key={img.path} color="magenta">
                  {"[+ "}
                  {img.name}
                  {"] "}
                </Text>
              ))}
            </Box>
          )}
          <Input onSubmit={handleSubmit} disabled={chatBusy} planMode={planMode} onPasteShortcut={handleClipboardPaste} />
          {showHelpHint && (
            <Box paddingX={1}>
              <Text color="gray" dimColor>
                tip: /help for the command list · /history to revisit a chat · /reasoning to fold a thinking pane
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function formatError(err: unknown): string {
  if (err instanceof AuthError) return `${err.code}: ${err.message}`;
  if (err instanceof ApiError) return `${err.code} (${err.status}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Translate raw agent error messages into something the user can act on. We
 * specifically catch the common networking failures because the unadorned
 * "fetch failed" / ECONNREFUSED messages bubble up otherwise and read as
 * scary internals to a user who just wants to know the server is down.
 */
function humanizeAgentError(msg: string): string {
  const m = String(msg);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|network error/i.test(m)) {
    return "Cannot reach the enclo-api server — check that it's running, then send your message again.";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(m)) {
    return "API URL doesn't resolve — check the host name in your config (try /signout to set it again).";
  }
  if (/timed?out|timeout/i.test(m)) {
    return "Request timed out — the model or server is slow. Try a smaller request or a different model.";
  }
  if (/upstream returned 404|model.*not found/i.test(m)) {
    return "The selected model isn't pulled on the server — pull it (e.g. `ollama pull <model>`) and try again, or pick a different model with /models.";
  }
  if (/upstream returned 5\d\d/i.test(m)) {
    return "The model server returned an error — check its logs and try again.";
  }
  if (/401|unauthor/i.test(m)) {
    return "Your session expired — run /signin to log back in.";
  }
  return `agent error: ${m}`;
}

function safeJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function labelSubAgentEvent(ev: AgentEvent): string | null {
  if (ev.type === "tool_call_pending") return `tool: ${ev.call.function.name}`;
  if (ev.type === "tool_result") return `result: ${ev.name} (${ev.result.isError ? "error" : "ok"})`;
  if (ev.type === "tool_denied") return `denied: ${ev.name}`;
  if (ev.type === "agent_done") return "done";
  if (ev.type === "agent_error") return `error: ${ev.message}`;
  return null;
}
