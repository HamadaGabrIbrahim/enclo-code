import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Lifecycle events at which hooks may fire.
 */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
];

export interface HookMatcher {
  /** Exact tool name (PreToolUse / PostToolUse only). */
  tool?: string;
  /** Glob against the tool's primary path arg. */
  path_glob?: string;
  /** Regex against bash command (only meaningful when tool === "bash"). */
  command_pattern?: string;
}

export interface HookConfig {
  matcher?: HookMatcher;
  command: string;
  /** Per-hook timeout in milliseconds. Capped at MAX_TIMEOUT_MS. */
  timeout_ms?: number;
}

export type HooksFile = Partial<Record<HookEvent, HookConfig[]>>;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDOUT_BYTES = 16 * 1024;

/**
 * Payload describing the lifecycle event the hook is firing for.
 * Serialized to stdin as JSON and partially exposed via env vars.
 */
export type HookPayload =
  | {
      event: "PreToolUse";
      tool_name: string;
      tool_args: unknown;
      cwd: string;
    }
  | {
      event: "PostToolUse";
      tool_name: string;
      tool_args: unknown;
      cwd: string;
      result: { content: string; isError?: boolean };
    }
  | { event: "UserPromptSubmit"; prompt: string; cwd: string }
  | { event: "Stop"; reason: string; cwd: string }
  | { event: "SubagentStop"; description: string; final_text: string; is_error: boolean; cwd: string }
  | { event: "SessionStart"; cwd: string }
  | { event: "SessionEnd"; cwd: string };

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** What the loop should do given exitCode. */
  action: "continue" | "block" | "warn";
  /** First line of stdout, suitable for chat notice. */
  notice?: string;
}

/**
 * Aggregated outcome of running every hook for an event.
 * `blocked` = at least one hook returned exit code 2; `blockMessage` is its stdout.
 * `notices` = list of `🪝 hook: ...` strings to surface.
 * `warnings` = list of `⚠ hook failed: ...` strings to surface.
 */
export interface HookRunOutcome {
  blocked: boolean;
  blockMessage?: string;
  notices: string[];
  warnings: string[];
}

export interface HooksManager {
  /** Path to the user-global hooks file (~/.enclo/hooks.json). */
  userPath: string;
  /** Path to the project-local hooks file (<cwd>/.enclo/hooks.json). */
  projectPath: string;
  /** Re-read both config files. Replaces in-memory state. */
  reload(): Promise<void>;
  /** Run every hook matching the given event + payload sequentially. */
  run(event: HookEvent, payload: HookPayload): Promise<HookRunOutcome>;
  /** Counts of registered hooks per event (for /hooks). */
  counts(): Record<HookEvent, number>;
  /** Errors encountered during the most recent reload (parse / IO). */
  loadErrors(): string[];
}

/**
 * Load + parse a single hooks file. Returns an empty file on ENOENT.
 * Returns parse errors as the second tuple element so callers can surface them.
 */
export async function loadHooksFile(file: string): Promise<{ hooks: HooksFile; errors: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { hooks: {}, errors: [] };
    return { hooks: {}, errors: [`${file}: ${e.message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { hooks: {}, errors: [`${file}: invalid JSON: ${(err as Error).message}`] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { hooks: {}, errors: [`${file}: top-level must be an object`] };
  }
  const obj = parsed as Record<string, unknown>;
  const out: HooksFile = {};
  const errors: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const list = obj[ev];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`${file}: '${ev}' must be an array`);
      continue;
    }
    const valid: HookConfig[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (!item || typeof item !== "object") {
        errors.push(`${file}: ${ev}[${i}] must be an object`);
        continue;
      }
      const it = item as Record<string, unknown>;
      if (typeof it["command"] !== "string" || it["command"].length === 0) {
        errors.push(`${file}: ${ev}[${i}].command must be a non-empty string`);
        continue;
      }
      const cfg: HookConfig = { command: it["command"] };
      const m = it["matcher"];
      if (m !== undefined) {
        if (!m || typeof m !== "object") {
          errors.push(`${file}: ${ev}[${i}].matcher must be an object`);
          continue;
        }
        const mo = m as Record<string, unknown>;
        const matcher: HookMatcher = {};
        if (mo["tool"] !== undefined) {
          if (typeof mo["tool"] !== "string") {
            errors.push(`${file}: ${ev}[${i}].matcher.tool must be a string`);
            continue;
          }
          matcher.tool = mo["tool"];
        }
        if (mo["path_glob"] !== undefined) {
          if (typeof mo["path_glob"] !== "string") {
            errors.push(`${file}: ${ev}[${i}].matcher.path_glob must be a string`);
            continue;
          }
          matcher.path_glob = mo["path_glob"];
        }
        if (mo["command_pattern"] !== undefined) {
          if (typeof mo["command_pattern"] !== "string") {
            errors.push(`${file}: ${ev}[${i}].matcher.command_pattern must be a string`);
            continue;
          }
          matcher.command_pattern = mo["command_pattern"];
        }
        cfg.matcher = matcher;
      }
      if (it["timeout_ms"] !== undefined) {
        if (typeof it["timeout_ms"] !== "number" || it["timeout_ms"] <= 0) {
          errors.push(`${file}: ${ev}[${i}].timeout_ms must be a positive number`);
          continue;
        }
        cfg.timeout_ms = Math.min(Math.floor(it["timeout_ms"]), MAX_TIMEOUT_MS);
      }
      valid.push(cfg);
    }
    if (valid.length > 0) out[ev] = valid;
  }
  return { hooks: out, errors };
}

/**
 * Translate a glob pattern into an anchored RegExp.
 * Supports `*` (any non-slash chars), `**` (any chars including slashes),
 * and `?` (single non-slash char). Other regex metachars are escaped.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Pull the "primary path" from a tool's argument object — used for path_glob
 * matching. Returns undefined for tools without a path-like arg.
 */
export function primaryPath(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  if (toolName === "bash") return undefined;
  if (typeof obj["path"] === "string") return obj["path"];
  return undefined;
}

/**
 * Return true iff every set field in the matcher is satisfied by the payload.
 * Empty matcher (or no matcher) → matches everything.
 */
export function matcherMatches(matcher: HookMatcher | undefined, payload: HookPayload): boolean {
  if (!matcher) return true;
  if (matcher.tool !== undefined) {
    if (payload.event !== "PreToolUse" && payload.event !== "PostToolUse") return false;
    if (payload.tool_name !== matcher.tool) return false;
  }
  if (matcher.path_glob !== undefined) {
    if (payload.event !== "PreToolUse" && payload.event !== "PostToolUse") return false;
    const p = primaryPath(payload.tool_name, payload.tool_args);
    if (p === undefined) return false;
    if (!globToRegExp(matcher.path_glob).test(p)) return false;
  }
  if (matcher.command_pattern !== undefined) {
    if (payload.event !== "PreToolUse" && payload.event !== "PostToolUse") return false;
    if (payload.tool_name !== "bash") return false;
    const args = payload.tool_args;
    if (!args || typeof args !== "object") return false;
    const cmd = (args as Record<string, unknown>)["command"];
    if (typeof cmd !== "string") return false;
    let re: RegExp;
    try {
      re = new RegExp(matcher.command_pattern);
    } catch {
      return false;
    }
    if (!re.test(cmd)) return false;
  }
  return true;
}

/**
 * Build the env-var bag passed to the hook process. CLAUDE_CODE-compatible
 * names (TOOL_NAME, TOOL_ARGS_JSON, TOOL_PATH, USER_PROMPT, STOP_REASON …)
 * are layered on top of the parent process env.
 */
export function buildHookEnv(payload: HookPayload): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["HOOK_EVENT"] = payload.event;
  env["HOOK_CWD"] = payload.cwd;
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") {
    env["TOOL_NAME"] = payload.tool_name;
    env["TOOL_ARGS_JSON"] = JSON.stringify(payload.tool_args ?? {});
    const p = primaryPath(payload.tool_name, payload.tool_args);
    if (p !== undefined) env["TOOL_PATH"] = p;
    if (payload.tool_name === "bash") {
      const args = payload.tool_args;
      if (args && typeof args === "object") {
        const cmd = (args as Record<string, unknown>)["command"];
        if (typeof cmd === "string") env["TOOL_COMMAND"] = cmd;
      }
    }
    if (payload.event === "PostToolUse") {
      env["TOOL_RESULT_IS_ERROR"] = payload.result.isError ? "1" : "0";
    }
  } else if (payload.event === "UserPromptSubmit") {
    env["USER_PROMPT"] = payload.prompt;
  } else if (payload.event === "Stop") {
    env["STOP_REASON"] = payload.reason;
  } else if (payload.event === "SubagentStop") {
    env["SUBAGENT_DESCRIPTION"] = payload.description;
    env["SUBAGENT_IS_ERROR"] = payload.is_error ? "1" : "0";
  }
  return env;
}

/**
 * Run a single hook command. Spawns /bin/sh -lc with the payload on stdin
 * and the appropriate env vars set. Captures stdout (capped at 16 KB),
 * stderr, exit code, and times out per the configured / default budget.
 */
export function runHook(
  event: HookEvent,
  hook: HookConfig,
  payload: HookPayload,
): Promise<HookResult> {
  const timeoutMs = Math.min(hook.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", hook.command], {
      cwd: payload.cwd,
      env: buildHookEnv(payload),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stdout += `\n[truncated — ${stdoutBytes - MAX_STDOUT_BYTES} more bytes]`;
      }
      let action: HookResult["action"];
      if (exitCode === 0) action = "continue";
      else if (exitCode === 2) action = "block";
      else action = "warn";
      const firstLine = stdout.split(/\r?\n/, 1)[0] ?? "";
      const result: HookResult = {
        exitCode,
        stdout,
        stderr,
        timedOut,
        action,
        ...(firstLine.length > 0 ? { notice: firstLine } : {}),
      };
      resolve(result);
    };

    child.on("error", (err) => {
      if (settled) return;
      stderr += `\n[spawn error: ${err.message}]`;
      finish(-1);
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 : -1);
      finish(exitCode);
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      /* stdin may already be closed if process died fast */
    }
  });
}

export interface HooksManagerOptions {
  /** Override ~/.enclo (used for tests). */
  userDir?: string;
  /** Project root (where .enclo/hooks.json lives). */
  projectDir: string;
}

/**
 * Build a hooks manager rooted at the given project dir. Loads both files
 * lazily on `reload()`. Project-local hooks override the user-global file
 * per-event (the project list replaces the user list for that event).
 */
export function createHooksManager(opts: HooksManagerOptions): HooksManager {
  const userDir = opts.userDir ?? path.join(homedir(), ".enclo");
  const userFile = path.join(userDir, "hooks.json");
  const projectFile = path.join(opts.projectDir, ".enclo", "hooks.json");

  let merged: HooksFile = {};
  let errors: string[] = [];

  async function reload(): Promise<void> {
    const [u, p] = await Promise.all([loadHooksFile(userFile), loadHooksFile(projectFile)]);
    const next: HooksFile = {};
    for (const ev of HOOK_EVENTS) {
      const projectList = p.hooks[ev];
      const userList = u.hooks[ev];
      if (projectList && projectList.length > 0) next[ev] = projectList;
      else if (userList && userList.length > 0) next[ev] = userList;
    }
    merged = next;
    errors = [...u.errors, ...p.errors];
  }

  async function run(event: HookEvent, payload: HookPayload): Promise<HookRunOutcome> {
    const list = merged[event] ?? [];
    const out: HookRunOutcome = { blocked: false, notices: [], warnings: [] };
    for (const hook of list) {
      if (!matcherMatches(hook.matcher, payload)) continue;
      const r = await runHook(event, hook, payload);
      if (r.timedOut) {
        out.warnings.push(
          `⚠ hook timed out after ${hook.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms: ${hook.command}`,
        );
        continue;
      }
      if (r.action === "block") {
        out.blocked = true;
        out.blockMessage = r.stdout.trim().length > 0 ? r.stdout.trim() : "blocked by hook";
        return out;
      }
      if (r.action === "warn") {
        const detail = r.stderr.trim().split(/\r?\n/, 1)[0] ?? "";
        out.warnings.push(
          `⚠ hook failed (exit ${r.exitCode})${detail ? `: ${detail}` : ""}`,
        );
        continue;
      }
      if (r.notice) out.notices.push(`🪝 hook: ${r.notice}`);
    }
    return out;
  }

  function counts(): Record<HookEvent, number> {
    const c = {} as Record<HookEvent, number>;
    for (const ev of HOOK_EVENTS) c[ev] = (merged[ev] ?? []).length;
    return c;
  }

  return {
    userPath: userFile,
    projectPath: projectFile,
    reload,
    run,
    counts,
    loadErrors: () => [...errors],
  };
}
