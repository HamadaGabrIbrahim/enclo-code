import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  ApiClient,
  ApiError,
  AuthError,
  signin,
  signup,
  signout,
  fetchMe,
  listModels,
  listConversations,
  getConversation,
  getConversationUsage,
  compactConversation,
  HOOK_EVENTS,
  buildSystemMessages,
  createApiAdapter,
  createHooksManager,
  createPermissionManager,
  addPersistedRule,
  removePersistedRule,
  loadPersistedPermissions,
  loadMcpConfig,
  McpManager,
  builtInRegistry,
  combinedRegistry,
  createSpawnAgentTool,
  makeRegistry,
  discoverCustomCommands,
  discoverCustomSubagents,
  findProjectContext,
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type ConfigStore,
  type CustomCommand,
  type CustomSubagent,
  type HooksManager,
  type Model,
  type PermissionPrompt,
  type PermissionRuleEffect,
  type PermissionChoice,
  type ProjectContext,
  type SubagentSpec,
  type ToolRegistry,
  type UserContentBlock,
} from "@enclo/core";
import ky, { HTTPError } from "ky";

import {
  parseStream,
  writeMessage,
  FramingError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcErrorObject,
} from "./framing.js";
import { createMemoryConfigStore } from "./in-memory-config.js";

// ---- Public entry point ----------------------------------------------------

export interface RunJsonRpcServerOptions {
  /** Defaults to process.stdin. */
  input?: Readable;
  /** Defaults to process.stdout. */
  output?: Writable;
  /** Defaults to process.stderr. */
  errorOutput?: Writable;
  /** Override starting cwd. Defaults to process.cwd(). */
  cwd?: string;
  /** Pre-seeded config store (for tests). Defaults to in-memory + optional file. */
  config?: ConfigStore;
  /** Optional file path to persist config tokens between subprocess invocations. */
  configFilePath?: string;
  /** Inject ApiClient (for tests). */
  apiClientFactory?: (config: ConfigStore) => ApiClient;
  /** Skip MCP/hooks/custom command discovery (for tests). */
  skipDiscovery?: boolean;
  /** Called once per emitted notification (test introspection). */
  onNotify?: (n: JsonRpcNotification) => void;
}

export async function runJsonRpcServer(
  opts: RunJsonRpcServerOptions = {},
): Promise<number> {
  const server = new JsonRpcServer(opts);
  await server.run();
  return server.exitCode;
}

// ---- Error codes -----------------------------------------------------------

export const RPC_ERROR_INVALID_REQUEST = -32600;
export const RPC_ERROR_METHOD_NOT_FOUND = -32601;
export const RPC_ERROR_INVALID_PARAMS = -32602;
export const RPC_ERROR_INTERNAL = -32603;
export const RPC_ERROR_DOMAIN = 1001;

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function invalidParams(message: string, data?: unknown): RpcError {
  return new RpcError(RPC_ERROR_INVALID_PARAMS, message, data);
}

function domainError(errorCode: string, message: string, extra?: Record<string, unknown>): RpcError {
  return new RpcError(RPC_ERROR_DOMAIN, message, { error_code: errorCode, ...(extra ?? {}) });
}

// ---- Server ----------------------------------------------------------------

type MethodHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>;

interface PendingPermission {
  prompt: PermissionPrompt;
  promptId: string;
}

interface ActiveTurn {
  /** Best-effort cancellation flag checked by the streaming loop. */
  cancelled: boolean;
}

/**
 * JSON-RPC stdio server: reads framed messages from `input`, dispatches to
 * registered method handlers, writes framed responses to `output`. Streaming
 * methods (e.g. `streamChat`) emit interim `notify` messages and return
 * `null` as the final response.
 */
export class JsonRpcServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly errorOutput: Writable;
  private readonly options: RunJsonRpcServerOptions;
  private readonly handlers = new Map<string, MethodHandler>();

  private cwd: string;
  private cfgStore: ConfigStore;
  private client!: ApiClient;
  private permissions = createPermissionManager({
    storage: {
      add: (a) =>
        addPersistedRule(
          {
            tool: a.tool,
            ...(a.target !== undefined ? { target: a.target } : {}),
            scope: a.scope,
            effect: a.effect,
          },
          a.storageScope,
          a.cwd,
        ),
      remove: (a) =>
        removePersistedRule(a.tool, a.target, a.scope, a.storageScope, a.cwd),
      clearUser: async () => {
        /* RPC consumers manage clearing themselves */
      },
    },
  });
  private hooks: HooksManager | null = null;
  private mcpManager: McpManager | null = null;
  private customCommands: Map<string, CustomCommand> = new Map();
  private customSubagents: Map<string, CustomSubagent> = new Map();
  private projectContext: ProjectContext | null = null;
  private models: Model[] = [];
  private agentHistory: AgentMessage[] = [];
  private conversationIdRef: { current: string | null } = { current: null };

  private pendingPermissions = new Map<string, PendingPermission>();
  private activeTurn: ActiveTurn | null = null;
  private shutdown = false;
  /** Remember failing graceful exit to set process exit code. */
  exitCode = 0;

  constructor(opts: RunJsonRpcServerOptions = {}) {
    this.options = opts;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.errorOutput = opts.errorOutput ?? process.stderr;
    this.cwd = opts.cwd ?? process.cwd();
    this.cfgStore =
      opts.config ??
      createMemoryConfigStore({
        ...(opts.configFilePath ? { filePath: opts.configFilePath } : {}),
      });
    this.registerHandlers();
  }

  async run(): Promise<void> {
    this.client = this.options.apiClientFactory
      ? this.options.apiClientFactory(this.cfgStore)
      : new ApiClient({
          config: this.cfgStore,
          onAuthLost: () => {
            this.notify("auth.lost", {});
          },
        });

    if (!this.options.skipDiscovery) {
      await this.bootstrapDiscovery();
    }

    // Subscribe permission prompts → notifications, register response promise.
    this.permissions.onPrompt((p) => this.dispatchPermissionPrompt(p));

    // Seed persisted permissions for this cwd.
    if (!this.options.skipDiscovery) {
      try {
        const rules = await loadPersistedPermissions(this.cwd);
        this.permissions.seedPersistedRules(rules);
      } catch {
        /* corrupt file etc. */
      }
    }

    const inflight = new Set<Promise<void>>();
    try {
      for await (const msg of parseStream(this.input)) {
        if (this.shutdown) break;
        // Dispatch concurrently so a long-running method (e.g. streamChat
        // awaiting a permission prompt) doesn't block other requests
        // (e.g. permissions.respondToPrompt) on the same stdio channel.
        const p = this.handleMessage(msg).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.allSettled(inflight);
    } catch (err) {
      if (err instanceof FramingError) {
        this.logError(`framing error: ${err.message}`);
        this.exitCode = 1;
      } else {
        this.logError(`fatal: ${(err as Error).message}`);
        this.exitCode = 1;
      }
    } finally {
      try {
        if (this.mcpManager) await this.mcpManager.stop();
      } catch {
        /* ignore on shutdown */
      }
    }
  }

  // ---- Discovery -----------------------------------------------------------

  private async bootstrapDiscovery(): Promise<void> {
    // Hooks
    const hooks = createHooksManager({ projectDir: this.cwd });
    await hooks.reload();
    this.hooks = hooks;
    // MCP
    const mgr = new McpManager();
    this.mcpManager = mgr;
    const { config: mcpConfig, errors: mcpErrors } = await loadMcpConfig(this.cwd);
    if (mcpErrors.length > 0) {
      this.notify("mcp.config_errors", { errors: mcpErrors });
    }
    if (Object.keys(mcpConfig.mcpServers ?? {}).length > 0) {
      try {
        await mgr.start(mcpConfig);
      } catch (err) {
        this.logError(`mcp start: ${(err as Error).message}`);
      }
    }
    this.customCommands = await discoverCustomCommands(this.cwd);
    this.customSubagents = await discoverCustomSubagents(this.cwd);
    this.projectContext = await findProjectContext(this.cwd);
  }

  private buildToolRegistry(): ToolRegistry {
    const subagentSpecs = this.subagentSpecs();
    const dynamicSpawn = createSpawnAgentTool(subagentSpecs);
    const base = this.mcpManager
      ? combinedRegistry(this.mcpManager.getTools())
      : builtInRegistry();
    const swapped = base
      .list()
      .map((t) => (t.definition.function.name === "spawn_agent" ? dynamicSpawn : t));
    return makeRegistry(swapped);
  }

  private subagentSpecs(): ReadonlyMap<string, SubagentSpec> {
    const out = new Map<string, SubagentSpec>();
    for (const [name, sub] of this.customSubagents) {
      const spec: SubagentSpec = {
        description: sub.description,
        systemPrompt: sub.systemPrompt,
      };
      if (sub.tools) spec.tools = sub.tools;
      if (sub.model) spec.model = sub.model;
      out.set(name, spec);
    }
    return out;
  }

  // ---- Permission prompt routing ------------------------------------------

  private dispatchPermissionPrompt(p: PermissionPrompt): void {
    const promptId = randomUUID();
    this.pendingPermissions.set(promptId, { prompt: p, promptId });
    this.notify("permission_prompt", {
      prompt_id: promptId,
      tool: p.request.tool.definition.function.name,
      args: p.request.args,
      cwd: p.request.cwd,
    });
  }

  // ---- Method handlers -----------------------------------------------------

  private registerHandlers(): void {
    // Auth
    this.handlers.set("signup", (p) => this.signup(p));
    this.handlers.set("signin", (p) => this.signin(p));
    this.handlers.set("signout", () => this.signout());
    this.handlers.set("me", () => this.me());

    // Models
    this.handlers.set("listModels", () => this.listModels());
    this.handlers.set("setActiveModel", (p) => this.setActiveModel(p));
    this.handlers.set("getActiveModel", () => this.getActiveModel());

    // Conversations
    this.handlers.set("listConversations", () => this.listConversations());
    this.handlers.set("getConversation", (p) => this.getConversation(p));
    this.handlers.set("deleteConversation", (p) => this.deleteConversation(p));
    this.handlers.set("compact", (p) => this.compact(p));
    this.handlers.set("getUsage", (p) => this.getUsage(p));

    // Agent
    this.handlers.set("streamChat", (p, id) => this.streamChat(p, id));
    this.handlers.set("cancelChat", () => this.cancelChat());

    // Discovery
    this.handlers.set("listHooks", () => this.listHooks());
    this.handlers.set("listMcpStatus", () => this.listMcpStatus());
    this.handlers.set("listCustomCommands", () => this.listCustomCommands());
    this.handlers.set("listSubagents", () => this.listSubagents());
    this.handlers.set("reloadHooks", () => this.reloadHooks());
    this.handlers.set("reloadMcp", () => this.reloadMcp());
    this.handlers.set("reloadCustomCommands", () => this.reloadCustomCommands());
    this.handlers.set("reloadSubagents", () => this.reloadSubagents());

    // Permissions
    this.handlers.set("permissions.snapshot", () => this.permissionsSnapshot());
    this.handlers.set("permissions.add", (p) => this.permissionsAdd(p));
    this.handlers.set("permissions.remove", (p) => this.permissionsRemove(p));
    this.handlers.set("permissions.respondToPrompt", (p) =>
      this.permissionsRespondToPrompt(p),
    );

    // Misc
    this.handlers.set("attachImage", (p) => this.attachImage(p));
    this.handlers.set("setCwd", (p) => this.setCwd(p));
    this.handlers.set("exit", () => this.exit());
  }

  // ---- Message dispatch ----------------------------------------------------

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (!isRequest(msg)) {
      // Notifications from the client — none currently expected; ignore.
      return;
    }
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.respondError(msg.id, RPC_ERROR_METHOD_NOT_FOUND, `method not found: ${msg.method}`);
      return;
    }
    try {
      const result = await handler(msg.params, msg.id);
      this.respondSuccess(msg.id, result ?? null);
    } catch (err) {
      if (err instanceof RpcError) {
        this.respondError(msg.id, err.code, err.message, err.data);
        return;
      }
      const mapped = mapDomainError(err);
      if (mapped) {
        this.respondError(msg.id, mapped.code, mapped.message, mapped.data);
        return;
      }
      this.respondError(
        msg.id,
        RPC_ERROR_INTERNAL,
        `internal error: ${(err as Error).message}`,
      );
    }
  }

  // ---- Auth methods --------------------------------------------------------

  private async signup(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "signup");
    const email = expectString(params, "email");
    const password = expectString(params, "password");
    const display_name = optString(params, "display_name");
    await this.requireApiUrl(params);
    const args: { email: string; password: string; display_name?: string } = {
      email,
      password,
    };
    if (display_name !== undefined) args.display_name = display_name;
    const pair = await signup(this.client, this.cfgStore, args);
    return pair;
  }

  private async signin(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "signin");
    const email = expectString(params, "email");
    const password = expectString(params, "password");
    await this.requireApiUrl(params);
    const pair = await signin(this.client, this.cfgStore, { email, password });
    return pair;
  }

  private async signout(): Promise<unknown> {
    await signout(this.client, this.cfgStore);
    return { ok: true };
  }

  private async me(): Promise<unknown> {
    return await fetchMe(this.client);
  }

  /**
   * Allow editors to set the API URL on a per-call basis when they call
   * signin / signup. If the config doesn't already have one and the call
   * supplies `api_url`, persist it before issuing the request.
   */
  private async requireApiUrl(params: Record<string, unknown>): Promise<void> {
    const supplied = optString(params, "api_url");
    if (supplied !== undefined) {
      await this.cfgStore.update({ api_url: supplied });
      await this.client.invalidateConfig();
      return;
    }
    const cfg = await this.cfgStore.load();
    if (!cfg.api_url) {
      throw invalidParams("api_url not configured (pass api_url in params or set it ahead of time)");
    }
  }

  // ---- Models --------------------------------------------------------------

  private async listModels(): Promise<unknown> {
    this.models = await listModels(this.client);
    return { models: this.models };
  }

  private async setActiveModel(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "setActiveModel");
    const id = expectString(params, "id");
    await this.cfgStore.update({ active_model: id });
    await this.client.invalidateConfig();
    return { ok: true };
  }

  private async getActiveModel(): Promise<unknown> {
    const cfg = await this.cfgStore.load();
    return cfg.active_model ? { id: cfg.active_model } : null;
  }

  // ---- Conversations -------------------------------------------------------

  private async listConversations(): Promise<unknown> {
    const conversations = await listConversations(this.client);
    return { conversations };
  }

  private async getConversation(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "getConversation");
    const id = expectString(params, "id");
    return await getConversation(this.client, id);
  }

  private async deleteConversation(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "deleteConversation");
    const id = expectString(params, "id");
    const cfg = await this.cfgStore.load();
    if (!cfg.api_url) throw invalidParams("api_url not configured");
    if (!cfg.access_token) throw new RpcError(RPC_ERROR_DOMAIN, "not signed in", { error_code: "unauthorized" });
    try {
      await ky.delete(`${stripTrailing(cfg.api_url)}/v1/conversations/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${cfg.access_token}` },
        retry: 0,
        timeout: 30_000,
      });
    } catch (err) {
      throw await mapKyError(err);
    }
    return { ok: true };
  }

  private async compact(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "compact");
    const id = expectString(params, "id");
    const outcome = await compactConversation(this.client, id);
    if (outcome.kind === "ok") return outcome.result;
    if (outcome.kind === "nothing_to_compact") {
      throw domainError("compact_unavailable", "fewer than 10 messages — nothing to compact");
    }
    throw domainError("compact_failed", outcome.message);
  }

  private async getUsage(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "getUsage");
    const id = expectString(params, "id");
    return await getConversationUsage(this.client, id);
  }

  // ---- Agent / streaming ---------------------------------------------------

  private async streamChat(rawParams: unknown, requestId: string | number | null): Promise<unknown> {
    if (this.activeTurn) {
      throw domainError("turn_in_progress", "another streamChat is already running");
    }
    const params = expectObject(rawParams, "streamChat");
    const userInputRaw = params["userInput"];
    const userInput = normalizeUserInput(userInputRaw);
    if (userInput === null) {
      throw invalidParams("streamChat.userInput must be a string or array of content blocks");
    }
    const conversationId = optString(params, "conversationId") ?? null;
    if (conversationId !== null) {
      this.conversationIdRef.current = conversationId;
    }
    const historyParam = params["history"];
    if (historyParam !== undefined) {
      if (!Array.isArray(historyParam)) {
        throw invalidParams("streamChat.history must be an array of AgentMessage objects");
      }
      this.agentHistory = historyParam as AgentMessage[];
    }
    const cfg = await this.cfgStore.load();
    const modelOverride = optString(params, "model");
    const model = modelOverride ?? cfg.active_model;
    if (!model) {
      throw domainError("no_active_model", "no active model — call setActiveModel first");
    }

    const turn: ActiveTurn = { cancelled: false };
    this.activeTurn = turn;

    try {
      const tools = this.buildToolRegistry();
      const subagentSpecs = this.subagentSpecs();
      const adapter = createApiAdapter({
        client: this.client,
        model,
        conversationIdRef: this.conversationIdRef,
      });

      const systemMessages = await buildSystemMessages({
        cwd: this.cwd,
        tools: tools.list(),
        ...(this.projectContext ? { projectContext: this.projectContext } : {}),
      });
      let history: AgentMessage[] =
        this.agentHistory.length === 0
          ? systemMessages.map((content) => ({ role: "system" as const, content }))
          : this.agentHistory;

      const runOpts: Parameters<typeof runAgent>[0] = {
        api: adapter,
        tools,
        permissions: this.permissions,
        cwd: this.cwd,
        history,
        userInput,
        apiFactory: (modelId) =>
          createApiAdapter({
            client: this.client,
            model: modelId,
            conversationIdRef: this.conversationIdRef,
          }),
      };
      if (this.hooks) runOpts.hooks = this.hooks;
      if (subagentSpecs.size > 0) runOpts.subagents = subagentSpecs;

      for await (const ev of runAgent(runOpts)) {
        if (turn.cancelled) {
          this.notify("agent.cancelled", { request_id: requestId });
          break;
        }
        this.notify("agent.event", serializeAgentEvent(ev));
        if (ev.type === "agent_done") {
          this.agentHistory = ev.finalMessages;
          if (this.conversationIdRef.current) {
            // Persist conversation id implicitly so subsequent streamChat
            // calls reuse it. The editor can still override per-call.
          }
          this.notify("agent.done", {
            conversation_id: this.conversationIdRef.current,
            final_message_count: ev.finalMessages.length,
          });
        }
      }
    } finally {
      if (this.activeTurn === turn) this.activeTurn = null;
    }
    return null;
  }

  private async cancelChat(): Promise<unknown> {
    if (!this.activeTurn) return { ok: false, reason: "no_active_turn" };
    this.activeTurn.cancelled = true;
    return { ok: true };
  }

  // ---- Discovery RPC -------------------------------------------------------

  private async listHooks(): Promise<unknown> {
    if (!this.hooks) return { counts: {}, errors: ["hooks not initialized"] };
    const counts = this.hooks.counts();
    const out: Record<string, number> = {};
    for (const ev of HOOK_EVENTS) out[ev] = counts[ev];
    return {
      counts: out,
      user_path: this.hooks.userPath,
      project_path: this.hooks.projectPath,
      errors: this.hooks.loadErrors(),
    };
  }

  private async listMcpStatus(): Promise<unknown> {
    if (!this.mcpManager) return { servers: [] };
    return { servers: this.mcpManager.getStatus() };
  }

  private async listCustomCommands(): Promise<unknown> {
    const commands = [...this.customCommands.values()].map((c) => ({
      name: c.name,
      description: c.description,
      argument_hint: c.argumentHint ?? null,
    }));
    return { commands };
  }

  private async listSubagents(): Promise<unknown> {
    const subagents = [...this.customSubagents.values()].map((s) => ({
      name: s.name,
      description: s.description,
      tools: s.tools ?? null,
      model: s.model ?? null,
    }));
    return { subagents };
  }

  private async reloadHooks(): Promise<unknown> {
    if (!this.hooks) {
      this.hooks = createHooksManager({ projectDir: this.cwd });
    }
    await this.hooks.reload();
    return { ok: true, errors: this.hooks.loadErrors() };
  }

  private async reloadMcp(): Promise<unknown> {
    if (!this.mcpManager) this.mcpManager = new McpManager();
    const { config: mcpConfig, errors } = await loadMcpConfig(this.cwd);
    await this.mcpManager.start(mcpConfig);
    return { ok: true, status: this.mcpManager.getStatus(), errors };
  }

  private async reloadCustomCommands(): Promise<unknown> {
    this.customCommands = await discoverCustomCommands(this.cwd);
    return { count: this.customCommands.size };
  }

  private async reloadSubagents(): Promise<unknown> {
    this.customSubagents = await discoverCustomSubagents(this.cwd);
    return { count: this.customSubagents.size };
  }

  // ---- Permissions ---------------------------------------------------------

  private async permissionsSnapshot(): Promise<unknown> {
    return this.permissions.snapshot();
  }

  private async permissionsAdd(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "permissions.add");
    const tool = expectString(params, "tool");
    const target = optString(params, "target");
    const scope = expectString(params, "scope");
    const effect = expectString(params, "effect");
    if (effect !== "allow" && effect !== "deny") {
      throw invalidParams("effect must be 'allow' or 'deny'");
    }
    if (scope === "session") {
      if (effect === "deny") {
        throw invalidParams("session-scoped deny rules are not supported (use a persisted scope)");
      }
      if (target) {
        this.permissions.allowTarget(tool, target);
      } else {
        this.permissions.allowTool(tool);
      }
      return { ok: true };
    }
    if (scope !== "persisted_user" && scope !== "persisted_project") {
      throw invalidParams("scope must be 'session' | 'persisted_user' | 'persisted_project'");
    }
    const storageScope: "user" | "project" =
      scope === "persisted_user" ? "user" : "project";
    const stored = await this.permissions.addPersistedRule({
      tool,
      ...(target !== undefined ? { target } : {}),
      scope: target ? "target" : "tool",
      effect: effect as PermissionRuleEffect,
      storageScope,
      cwd: this.cwd,
    });
    return { ok: true, rule: stored };
  }

  private async permissionsRemove(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "permissions.remove");
    const tool = expectString(params, "tool");
    const target = optString(params, "target");
    const scope = expectString(params, "scope");
    if (scope === "session") {
      // Session rules clear via a fresh allowTool/allowTarget reset.
      // We expose a scoped-down "remove just this entry" by resetting all
      // session allows when target is omitted, otherwise reverting via the
      // snapshot — but the public manager doesn't have per-entry session
      // delete, so we conservatively reject.
      throw invalidParams("session removal not supported — call permissions.snapshot then add a deny rule if needed");
    }
    if (scope !== "persisted_user" && scope !== "persisted_project") {
      throw invalidParams("scope must be 'persisted_user' | 'persisted_project'");
    }
    const storageScope: "user" | "project" =
      scope === "persisted_user" ? "user" : "project";
    const removed = await this.permissions.removePersistedRule({
      tool,
      ...(target !== undefined ? { target } : {}),
      scope: target ? "target" : "tool",
      storageScope,
      cwd: this.cwd,
    });
    return { ok: removed };
  }

  private async permissionsRespondToPrompt(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "permissions.respondToPrompt");
    const promptId = expectString(params, "prompt_id");
    const choice = expectString(params, "choice");
    const pending = this.pendingPermissions.get(promptId);
    if (!pending) {
      throw domainError("unknown_prompt", `no pending permission prompt with id ${promptId}`);
    }
    this.pendingPermissions.delete(promptId);
    const decision = decodePermissionChoice(choice);
    pending.prompt.resolve(decision);
    return { ok: true };
  }

  // ---- Misc ---------------------------------------------------------------

  private async attachImage(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "attachImage");
    const target = expectString(params, "path");
    const abs = path.isAbsolute(target) ? target : path.resolve(this.cwd, target);
    const ext = path.extname(abs).toLowerCase();
    const mime = inferImageMime(ext);
    if (!mime) {
      throw invalidParams(`unsupported image extension '${ext || "(none)"}' (use .png, .jpg, .jpeg, .webp, .gif)`);
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      throw domainError("attach_failed", (err as Error).message);
    }
    const base64 = buf.toString("base64");
    return {
      base64_data_url: `data:${mime};base64,${base64}`,
      name: path.basename(abs),
      size_bytes: buf.length,
    };
  }

  private async setCwd(rawParams: unknown): Promise<unknown> {
    const params = expectObject(rawParams, "setCwd");
    const target = expectString(params, "path");
    const next = path.isAbsolute(target) ? target : path.resolve(this.cwd, target);
    try {
      const stat = await fs.stat(next);
      if (!stat.isDirectory()) {
        throw invalidParams(`${next} is not a directory`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw domainError("setcwd_failed", (err as Error).message);
    }
    this.cwd = next;
    if (!this.options.skipDiscovery) {
      this.customCommands = await discoverCustomCommands(this.cwd);
      this.customSubagents = await discoverCustomSubagents(this.cwd);
      this.projectContext = await findProjectContext(this.cwd);
      try {
        const rules = await loadPersistedPermissions(this.cwd);
        this.permissions.seedPersistedRules(rules);
      } catch {
        /* ignore */
      }
    }
    return { ok: true, cwd: this.cwd };
  }

  private async exit(): Promise<unknown> {
    this.shutdown = true;
    // Defer ending stdio one tick so the response is flushed.
    setImmediate(() => {
      try {
        this.input.removeAllListeners?.();
      } catch {
        /* ignore */
      }
    });
    return { ok: true };
  }

  // ---- Wire helpers --------------------------------------------------------

  private respondSuccess(id: string | number | null, result: unknown): void {
    const msg: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
    writeMessage(this.output, msg);
  }

  private respondError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const errObj: JsonRpcErrorObject = { code, message };
    if (data !== undefined) errObj.data = data;
    const msg: JsonRpcFailure = { jsonrpc: "2.0", id, error: errObj };
    writeMessage(this.output, msg);
  }

  private notify(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    writeMessage(this.output, msg);
    this.options.onNotify?.(msg);
  }

  private logError(line: string): void {
    try {
      this.errorOutput.write(`enclo-rpc: ${line}\n`);
    } catch {
      /* ignore */
    }
  }
}

// ---- Helpers --------------------------------------------------------------

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    typeof (msg as JsonRpcRequest).method === "string" &&
    Object.prototype.hasOwnProperty.call(msg, "id")
  );
}

function expectObject(value: unknown, methodName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidParams(`${methodName}: params must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidParams(`missing required string param: ${key}`);
  }
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw invalidParams(`param ${key} must be a string`);
  }
  return v;
}

/**
 * Accept either a plain string or an array of UserContentBlock objects.
 * Returns null for malformed input so callers can produce a friendly error.
 */
function normalizeUserInput(value: unknown): string | UserContentBlock[] | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const block of value) {
      if (!block || typeof block !== "object") return null;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") continue;
      if (b["type"] === "image_url" && b["image_url"] && typeof b["image_url"] === "object") {
        const iu = b["image_url"] as Record<string, unknown>;
        if (typeof iu["url"] === "string") continue;
      }
      return null;
    }
    return value as UserContentBlock[];
  }
  return null;
}

function decodePermissionChoice(choice: string): PermissionChoice {
  switch (choice) {
    case "allow_once":
    case "allow_session_tool":
    case "allow_session_target":
    case "allow_persisted_tool":
    case "allow_persisted_target":
    case "deny_persisted":
    case "deny":
      return { kind: choice };
    default:
      throw invalidParams(`unknown permission choice: ${choice}`);
  }
}

/**
 * Translate AgentEvents into JSON-friendly notification params. Most pass
 * through verbatim; we emit a stable wire shape so editors don't break when
 * core adds new event fields.
 */
function serializeAgentEvent(ev: AgentEvent): unknown {
  if (ev.type === "tool_result") {
    return {
      type: "tool_result",
      call_id: ev.call_id,
      name: ev.name,
      result: { content: ev.result.content, isError: ev.result.isError ?? false },
      ...(ev.display ? { display: ev.display } : {}),
    };
  }
  if (ev.type === "agent_done") {
    return { type: "agent_done", final_messages: ev.finalMessages };
  }
  return ev as unknown;
}

function inferImageMime(ext: string): string | null {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function stripTrailing(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function mapDomainError(err: unknown): { code: number; message: string; data?: unknown } | null {
  if (err instanceof AuthError) {
    return {
      code: RPC_ERROR_DOMAIN,
      message: err.message,
      data: { error_code: err.code },
    };
  }
  if (err instanceof ApiError) {
    return {
      code: RPC_ERROR_DOMAIN,
      message: err.message,
      data: { error_code: err.code, http_status: err.status },
    };
  }
  return null;
}

async function mapKyError(err: unknown): Promise<RpcError> {
  if (err instanceof HTTPError) {
    try {
      const body = await err.response.clone().json() as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? "http_error";
      const message = body.error?.message ?? `HTTP ${err.response.status}`;
      return new RpcError(RPC_ERROR_DOMAIN, message, {
        error_code: code,
        http_status: err.response.status,
      });
    } catch {
      return new RpcError(
        RPC_ERROR_DOMAIN,
        `HTTP ${err.response.status}`,
        { error_code: "http_error", http_status: err.response.status },
      );
    }
  }
  return new RpcError(RPC_ERROR_INTERNAL, (err as Error).message);
}
