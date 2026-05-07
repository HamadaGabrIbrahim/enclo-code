import { spawn } from "node:child_process";
import type { Tool, ToolResult, ToolContext, ToolPartialChunk } from "./types.js";
import { readCommandArg } from "./_args.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type BashPartialSink = (chunk: ToolPartialChunk) => void;

interface Args {
  command: string;
  timeout?: number;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("bash: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  const cmd = readCommandArg(obj);
  if (cmd === undefined) {
    throw new Error("bash: 'command' must be a non-empty string (alias accepted: cmd)");
  }
  const args: Args = { command: cmd };
  if (obj["timeout"] !== undefined) {
    if (typeof obj["timeout"] !== "number" || obj["timeout"] <= 0) {
      throw new Error("bash: 'timeout' must be a positive number (milliseconds)");
    }
    args.timeout = Math.min(Math.floor(obj["timeout"]), MAX_TIMEOUT_MS);
  }
  return args;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export function runBash(
  command: string,
  opts: { cwd: string; timeoutMs: number; onPartial?: BashPartialSink },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
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
    }, opts.timeoutMs);

    const emitPartial = (channel: "stdout" | "stderr", text: string) => {
      if (!opts.onPartial || text.length === 0) return;
      try { opts.onPartial({ channel, content: text }); } catch { /* never break the child */ }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += text;
      // Always emit partials so the user sees the line; the buffer cap is
      // about what we send to the model, not what we render live.
      emitPartial("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += text;
      emitPartial("stderr", text);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, exitCode: -1, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      const exitCode = code ?? (signal ? 128 : -1);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stdout += `\n[truncated — ${stdoutBytes - MAX_OUTPUT_BYTES} more bytes]`;
      }
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        stderr += `\n[truncated — ${stderrBytes - MAX_OUTPUT_BYTES} more bytes]`;
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

export const bash: Tool = {
  category: "exec",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in /bin/sh and return its stdout, stderr, and exit code. Use this for build steps, tests, git operations, and other one-off commands. Default timeout 120s, max 600s. Avoid long-running interactive processes.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run.",
          },
          timeout: {
            type: "integer",
            description: "Timeout in milliseconds (default 120000, max 600000).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const result = await runBash(args.command, {
      cwd: ctx.cwd,
      timeoutMs: args.timeout ?? DEFAULT_TIMEOUT_MS,
      onPartial: ctx.onPartial,
    });
    const lines: string[] = [];
    lines.push(`$ ${args.command}`);
    if (result.stdout.length > 0) lines.push(result.stdout.trimEnd());
    if (result.stderr.length > 0) {
      lines.push("--- stderr ---");
      lines.push(result.stderr.trimEnd());
    }
    lines.push(`[exit ${result.exitCode}${result.timedOut ? " — TIMED OUT" : ""}]`);
    return {
      content: lines.join("\n"),
      isError: result.exitCode !== 0 || result.timedOut,
      display: {
        kind: "bash",
        command: args.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    };
  },
};
