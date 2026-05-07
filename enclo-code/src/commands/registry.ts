export type SlashCommandName =
  | "signup"
  | "signin"
  | "signout"
  | "models"
  | "clear"
  | "help"
  | "exit"
  | "tools"
  | "allow"
  | "cd"
  | "plan"
  | "image"
  | "context"
  | "reload-context"
  | "history"
  | "list"
  | "resume"
  | "reload-commands"
  | "mcp"
  | "reload-mcp"
  | "hooks"
  | "reload-hooks"
  | "agents"
  | "reload-agents"
  | "reasoning";

export interface SlashCommand {
  name: SlashCommandName;
  description: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "signup", description: "Create a new account on the configured server" },
  { name: "signin", description: "Sign in to the configured server" },
  { name: "signout", description: "Sign out and clear stored tokens" },
  { name: "models", description: "List available models and pick the active one" },
  { name: "clear", description: "Start a new conversation (clears on-screen history)" },
  { name: "tools", description: "List available tools and their permission categories" },
  { name: "allow", description: "Show / add / remove session and persisted tool permissions" },
  { name: "cd", description: "Change working directory (used by tools next turn)" },
  { name: "plan", description: "Toggle plan mode (read-only investigation, write/exec disabled)" },
  { name: "image", description: "Attach an image (PNG/JPEG/WebP/GIF) to the next message: /image <path>" },
  { name: "context", description: "Show the loaded enclo.md project context (or where it was searched for)" },
  { name: "reload-context", description: "Re-discover enclo.md from the current cwd" },
  { name: "history", description: "List prior conversations and pick one to resume" },
  { name: "list", description: "Alias of /history" },
  { name: "resume", description: "Resume a conversation by id: /resume <id>" },
  { name: "reload-commands", description: "Re-discover custom slash commands from .enclo/commands/" },
  { name: "mcp", description: "Show status of configured MCP servers and their tools" },
  { name: "reload-mcp", description: "Reload ~/.enclo/mcp.json + .enclo/mcp.json and reconnect MCP servers" },
  { name: "hooks", description: "Show currently configured lifecycle hooks (counts per event)" },
  { name: "reload-hooks", description: "Re-read ~/.enclo/hooks.json + .enclo/hooks.json" },
  { name: "agents", description: "List registered custom subagents (name + description)" },
  { name: "reload-agents", description: "Re-discover custom subagents from .enclo/agents/" },
  { name: "reasoning", description: "Collapse / expand the most recent thinking pane" },
  { name: "help", description: "Show this help" },
  { name: "exit", description: "Quit enclo" },
];

export interface ParsedSlash {
  name: SlashCommandName;
  args: string[];
}

const NAMES = new Set<string>(COMMANDS.map((c) => c.name));

/**
 * Parse a raw input line into a slash-command invocation, or null if the line
 * is not a slash command.
 */
export function parseSlash(line: string): ParsedSlash | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? "";
  if (!NAMES.has(head)) return null;
  return { name: head as SlashCommandName, args: parts.slice(1) };
}

export function isSlash(line: string): boolean {
  return line.trim().startsWith("/");
}
