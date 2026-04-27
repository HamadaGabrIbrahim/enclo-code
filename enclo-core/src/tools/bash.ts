import { spawn } from "node:child_process";
import type { Tool, ToolResult, ToolContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

interface Args {
  command: string;
  timeout?: number;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("bash: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["command"] !== "string" || obj["command"].length === 0) {
    throw new Error("bash: 'command' must be a non-empty string");
  }
  const args: Args = { command: obj["command"] };
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

export function runBash(command: string, opts: { cwd: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, exitCode: -1, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
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
