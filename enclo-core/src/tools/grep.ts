import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { runBash } from "./bash.js";

interface Args {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
}

const MAX_RESULTS = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv"]);

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("grep: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["pattern"] !== "string" || obj["pattern"].length === 0) {
    throw new Error("grep: 'pattern' must be a non-empty string");
  }
  const args: Args = { pattern: obj["pattern"] };
  if (typeof obj["path"] === "string") args.path = obj["path"];
  if (typeof obj["glob"] === "string") args.glob = obj["glob"];
  if (typeof obj["type"] === "string") args.type = obj["type"];
  return args;
}

async function hasRipgrep(): Promise<boolean> {
  const result = await runBash("command -v rg >/dev/null 2>&1 && echo yes || echo no", {
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  return result.stdout.trim() === "yes";
}

let rgChecked = false;
let rgAvailable = false;
async function checkRg(): Promise<boolean> {
  if (rgChecked) return rgAvailable;
  rgAvailable = await hasRipgrep();
  rgChecked = true;
  return rgAvailable;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function runRipgrep(args: Args, cwd: string, searchPath: string): Promise<ToolResult> {
  const parts = ["rg", "--no-heading", "--line-number", "--color=never", "--max-count=50"];
  if (args.glob) parts.push("--glob", shellQuote(args.glob));
  if (args.type) parts.push("--type", shellQuote(args.type));
  parts.push("--", shellQuote(args.pattern), shellQuote(searchPath));
  const cmd = parts.join(" ");
  const result = await runBash(cmd, { cwd, timeoutMs: 30_000 });
  if (result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0) {
    return { content: `No matches for ${args.pattern} in ${searchPath}.` };
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      isError: true,
      content: `grep (rg) failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  const lines = result.stdout.split("\n").filter((l) => l.length > 0).slice(0, MAX_RESULTS);
  if (lines.length === 0) {
    return { content: `No matches for ${args.pattern} in ${searchPath}.` };
  }
  return {
    content: `${lines.length} match${lines.length === 1 ? "" : "es"}:\n${lines.join("\n")}`,
    display: { kind: "list", items: lines.slice(0, 10) },
  };
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += ".";
    } else if (ch === ".") {
      re += "\\.";
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function nodeGrep(args: Args, cwd: string, searchPath: string): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch (err) {
    return { isError: true, content: `grep: invalid regex: ${(err as Error).message}` };
  }
  const globRe = args.glob ? globToRegex(args.glob) : null;
  const results: string[] = [];
  let stat;
  try {
    stat = await fs.stat(searchPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { isError: true, content: `grep: cannot access ${searchPath}: ${e.message}` };
  }
  const files: string[] = [];
  if (stat.isFile()) {
    files.push(searchPath);
  } else {
    for await (const f of walk(searchPath)) {
      if (globRe) {
        const rel = path.relative(searchPath, f);
        if (!globRe.test(rel) && !globRe.test(path.basename(f))) continue;
      }
      files.push(f);
    }
  }
  outer: for (const f of files) {
    let buf: string;
    try {
      buf = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    const lines = buf.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i] ?? "")) {
        const rel = path.relative(cwd, f) || f;
        results.push(`${rel}:${i + 1}:${lines[i]}`);
        if (results.length >= MAX_RESULTS) break outer;
      }
    }
  }
  if (results.length === 0) {
    return { content: `No matches for ${args.pattern} in ${searchPath}.` };
  }
  return {
    content: `${results.length} match${results.length === 1 ? "" : "es"}:\n${results.join("\n")}`,
    display: { kind: "list", items: results.slice(0, 10) },
  };
}

export const grep: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search for a regex pattern across files. Uses ripgrep when available (fast, .gitignore-aware) and falls back to a Node implementation. Returns matching lines as path:line:content.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "File or directory to search in (default: cwd)." },
          glob: {
            type: "string",
            description: "Glob filter (e.g. '*.ts'). Only files matching the glob are searched.",
          },
          type: {
            type: "string",
            description: "ripgrep file type (e.g. 'ts', 'py'). Ignored by the fallback implementation.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const target = args.path ?? ".";
    const searchPath = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
    if (await checkRg()) {
      return runRipgrep(args, ctx.cwd, searchPath);
    }
    return nodeGrep(args, ctx.cwd, searchPath);
  },
};

/** Test helper: reset the ripgrep-availability cache. */
export function _resetRgCacheForTest(): void {
  rgChecked = false;
  rgAvailable = false;
}
