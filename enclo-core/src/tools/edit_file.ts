import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

interface Args {
  path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("edit_file: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["path"] !== "string" || obj["path"].length === 0) {
    throw new Error("edit_file: 'path' must be a non-empty string");
  }
  if (typeof obj["old_string"] !== "string") {
    throw new Error("edit_file: 'old_string' must be a string");
  }
  if (typeof obj["new_string"] !== "string") {
    throw new Error("edit_file: 'new_string' must be a string");
  }
  return {
    path: obj["path"],
    old_string: obj["old_string"],
    new_string: obj["new_string"],
    replace_all: obj["replace_all"] === true,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export const editFile: Tool = {
  category: "write",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Surgically edit an existing file by replacing exact strings. By default the old_string must appear exactly once; pass replace_all=true to replace every occurrence. Always read the file first to know the precise text to match.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit.",
          },
          old_string: {
            type: "string",
            description: "Exact string to find. Must include enough context to be unique unless replace_all is set.",
          },
          new_string: {
            type: "string",
            description: "Replacement string.",
          },
          replace_all: {
            type: "boolean",
            description: "If true, replace every occurrence; otherwise old_string must be unique.",
          },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    const args = parseArgs(raw);
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    let before: string;
    try {
      before = await fs.readFile(abs, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        isError: true,
        content: `Error reading ${abs}: ${e.code ?? ""} ${e.message}`.trim(),
      };
    }
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        content: "edit_file: old_string and new_string are identical — nothing to do.",
      };
    }
    const occurrences = countOccurrences(before, args.old_string);
    if (occurrences === 0) {
      return {
        isError: true,
        content: `edit_file: old_string not found in ${abs}.`,
      };
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        isError: true,
        content: `edit_file: old_string appears ${occurrences} times in ${abs}. Pass replace_all=true to change all of them or extend old_string to make it unique.`,
      };
    }
    const after = args.replace_all
      ? before.split(args.old_string).join(args.new_string)
      : before.replace(args.old_string, args.new_string);
    try {
      await fs.writeFile(abs, after, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        isError: true,
        content: `Error writing ${abs}: ${e.code ?? ""} ${e.message}`.trim(),
      };
    }
    const replacements = args.replace_all ? occurrences : 1;
    return {
      content: `Edited ${abs} (${replacements} replacement${replacements === 1 ? "" : "s"}).`,
      display: { kind: "diff", path: abs, before, after },
    };
  },
};
