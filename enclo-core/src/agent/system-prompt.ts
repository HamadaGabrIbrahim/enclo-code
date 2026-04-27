import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Tool } from "../tools/types.js";
import type { ProjectContext } from "./project-context.js";

const DEFAULT_TEMPLATE = `You are enclo, an AI coding assistant. You help with software engineering
tasks on the user's machine.

Working directory: {{CWD}}
Available tools: {{TOOLS}}

Use tools to read/write files and run commands rather than guessing or asking
the user to paste content. Prefer reading files before editing them. Use grep
and glob to find code rather than listing directories.

Edits must be surgical — use edit_file with exact strings rather than
write_file for changes to existing files. write_file is for new files only.

When the task is complete, give a brief summary. Do not narrate every tool
call; the user can see them.`;

export interface SystemPromptArgs {
  cwd: string;
  tools: Tool[];
  /** Optional override path (defaults to ~/.enclo/system-prompt.md). */
  overridePath?: string;
  /** When true, append the plan-mode suffix instructing read-only investigation. */
  planMode?: boolean;
}

export const PLAN_MODE_SUFFIX = `

PLAN MODE IS ACTIVE. You may use read-only tools (read_file, grep, glob, list_dir) freely to investigate. You CANNOT use write_file, edit_file, or bash. Instead, describe what you would do as a numbered list of concrete steps. Wait for the user to exit plan mode before any changes are made.`;

export async function buildSystemPrompt(args: SystemPromptArgs): Promise<string> {
  const overridePath = args.overridePath ?? path.join(homedir(), ".enclo", "system-prompt.md");
  let template = DEFAULT_TEMPLATE;
  try {
    template = await fs.readFile(overridePath, "utf8");
  } catch {
    /* no override — use default */
  }
  const toolNames = args.tools.map((t) => t.definition.function.name).join(", ");
  const base = template.replace(/\{\{CWD\}\}/g, args.cwd).replace(/\{\{TOOLS\}\}/g, toolNames);
  return args.planMode ? base + PLAN_MODE_SUFFIX : base;
}

/**
 * Format a project context (loaded enclo.md) as the wrapped string we send
 * to the model as a second system message.
 */
export function formatProjectContextMessage(ctx: ProjectContext): string {
  return `Project-specific context (loaded from ${ctx.path}):\n\n${ctx.content}`;
}

/**
 * Build the ordered list of system messages for a turn: the default prompt
 * first, optionally followed by a project-context message when an enclo.md
 * was discovered for the current cwd.
 */
export async function buildSystemMessages(
  args: SystemPromptArgs & { projectContext?: ProjectContext | null },
): Promise<string[]> {
  const base = await buildSystemPrompt(args);
  const out = [base];
  if (args.projectContext) out.push(formatProjectContextMessage(args.projectContext));
  return out;
}

export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = DEFAULT_TEMPLATE;
