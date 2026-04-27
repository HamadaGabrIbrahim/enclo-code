import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

interface Args {
  pattern: string;
  path?: string;
}

const MAX_RESULTS = 500;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv"]);

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("glob: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["pattern"] !== "string" || obj["pattern"].length === 0) {
    throw new Error("glob: 'pattern' must be a non-empty string");
  }
  const args: Args = { pattern: obj["pattern"] };
  if (typeof obj["path"] === "string") args.path = obj["path"];
  return args;
}

/** Translate a glob (with **, *, ?) into a RegExp matching the full path. */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i += 2;
        // Eat a trailing slash so "**/foo" matches "foo" too.
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === ".") {
      re += "\\.";
      i += 1;
    } else if (ch === "/") {
      re += "/";
      i += 1;
    } else if ("+^$()|{}[]\\".includes(ch ?? "")) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

async function* walk(dir: string, base: string): AsyncGenerator<{ abs: string; rel: string; mtime: number }> {
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
      yield* walk(full, base);
    } else if (entry.isFile()) {
      let mtime = 0;
      try {
        const st = await fs.stat(full);
        mtime = st.mtimeMs;
      } catch {
        /* ignore */
      }
      yield { abs: full, rel: path.relative(base, full), mtime };
    }
  }
}

export const glob: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern (supports **, *, ?). Returns absolute paths sorted by most-recently-modified first.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. 'src/**/*.ts'.",
          },
          path: {
            type: "string",
            description: "Root to search under (default: cwd).",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const root = args.path
      ? path.isAbsolute(args.path)
        ? args.path
        : path.resolve(ctx.cwd, args.path)
      : ctx.cwd;
    const re = globToRegex(args.pattern);
    const matches: { abs: string; mtime: number }[] = [];
    for await (const f of walk(root, root)) {
      if (re.test(f.rel)) {
        matches.push({ abs: f.abs, mtime: f.mtime });
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    if (matches.length === 0) {
      return { content: `No files matching ${args.pattern} under ${root}.` };
    }
    const list = matches.map((m) => m.abs).join("\n");
    return {
      content: `${matches.length} file${matches.length === 1 ? "" : "s"}:\n${list}`,
      display: { kind: "list", items: matches.slice(0, 10).map((m) => m.abs) },
    };
  },
};
