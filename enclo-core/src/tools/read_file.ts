import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("read_file: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["path"] !== "string" || obj["path"].length === 0) {
    throw new Error("read_file: 'path' must be a non-empty string");
  }
  const args: Args = { path: obj["path"] };
  if (obj["offset"] !== undefined) {
    if (typeof obj["offset"] !== "number" || obj["offset"] < 0) {
      throw new Error("read_file: 'offset' must be a non-negative number");
    }
    args.offset = Math.floor(obj["offset"]);
  }
  if (obj["limit"] !== undefined) {
    if (typeof obj["limit"] !== "number" || obj["limit"] <= 0) {
      throw new Error("read_file: 'limit' must be a positive number");
    }
    args.limit = Math.floor(obj["limit"]);
  }
  return args;
}

export const readFile: Tool = {
  category: "read",
  requiresPermission: false,
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file from the local filesystem. Returns up to 2000 lines at a time, prefixed with line numbers (cat -n style). Use offset and limit to page through larger files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file. Relative paths resolve against the working directory.",
          },
          offset: {
            type: "integer",
            description: "Line number to start reading from (1-based). Defaults to 1.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read. Defaults to 2000.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    let buf: string;
    try {
      buf = await fs.readFile(abs, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        isError: true,
        content: `Error reading ${abs}: ${e.code ?? ""} ${e.message}`.trim(),
      };
    }
    const allLines = buf.split("\n");
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const limit = Math.min(args.limit ?? MAX_LINES, MAX_LINES);
    const slice = allLines.slice(start, start + limit);
    const numbered = slice.map((line, i) => {
      const lineNo = start + i + 1;
      const truncated =
        line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "…" : line;
      return `${String(lineNo).padStart(6, " ")}\t${truncated}`;
    });
    const totalLines = allLines.length;
    let content = numbered.join("\n");
    if (start + slice.length < totalLines) {
      content += `\n\n[truncated — file has ${totalLines} lines, showed ${slice.length} starting at ${start + 1}]`;
    }
    if (slice.length === 0) {
      content = `[empty file or offset past end of file (${totalLines} lines)]`;
    }
    return {
      content,
      display: { kind: "text", preview: numbered.slice(0, 10).join("\n") },
    };
  },
};
