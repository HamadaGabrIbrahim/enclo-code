import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

interface Args {
  path: string;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("list_dir: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  const p = obj["path"];
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("list_dir: 'path' must be a non-empty string");
  }
  return { path: p };
}

export const listDir: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List immediate children of a directory. Directories appear with a trailing slash. Use glob/grep for recursive listings.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Relative paths resolve against the working directory." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(abs, { withFileTypes: true })) as import("node:fs").Dirent[];
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        isError: true,
        content: `Error listing ${abs}: ${e.code ?? ""} ${e.message}`.trim(),
      };
    }
    const items = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    if (items.length === 0) {
      return { content: `${abs} is empty.` };
    }
    return {
      content: `${abs}:\n${items.join("\n")}`,
      display: { kind: "list", items: items.slice(0, 20) },
    };
  },
};
