import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

interface Args {
  path: string;
  content: string;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("write_file: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["path"] !== "string" || obj["path"].length === 0) {
    throw new Error("write_file: 'path' must be a non-empty string");
  }
  if (typeof obj["content"] !== "string") {
    throw new Error("write_file: 'content' must be a string");
  }
  return { path: obj["path"], content: obj["content"] };
}

export const writeFile: Tool = {
  category: "write",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given contents. Use this for new files; for edits to existing files prefer edit_file (it is more surgical). Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file. Relative paths resolve against the working directory.",
          },
          content: {
            type: "string",
            description: "Full contents to write. Overwrites existing file.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    let before = "";
    let existed = false;
    try {
      before = await fs.readFile(abs, "utf8");
      existed = true;
    } catch {
      /* new file */
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        isError: true,
        content: `Error writing ${abs}: ${e.code ?? ""} ${e.message}`.trim(),
      };
    }
    const verb = existed ? "Overwrote" : "Created";
    const lines = args.content.split("\n").length;
    return {
      content: `${verb} ${abs} (${args.content.length} bytes, ${lines} lines).`,
      display: { kind: "diff", path: abs, before, after: args.content },
    };
  },
};
