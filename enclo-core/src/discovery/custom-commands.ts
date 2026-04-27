import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * A user-authored slash command discovered from a `.enclo/commands/<name>.md`
 * file. The body becomes the user's prompt for the turn (with $ARGUMENTS /
 * $1 / $CWD substitutions). Optional frontmatter fields tweak the per-turn
 * model and the visible tool list.
 */
export interface CustomCommand {
  /** Command name (filename stem, lowercased). */
  name: string;
  /** One-line description shown in /help. */
  description: string;
  /** Optional argument hint shown next to the description. */
  argumentHint?: string;
  /** Optional model override applied for the turn the command runs on. */
  model?: string;
  /** Optional whitelist of tool names available to the agent for this turn. */
  allowedTools?: string[];
  /** Body of the markdown file (after frontmatter). */
  body: string;
  /** Absolute path the command was loaded from (for diagnostics). */
  sourcePath: string;
}

export interface CustomFsAdapter {
  readdir: (p: string) => Promise<string[]>;
  readFile: (p: string) => Promise<string>;
  stat: (p: string) => Promise<{ isDirectory: () => boolean }>;
}

const DEFAULT_FS: CustomFsAdapter = {
  readdir: (p) => fs.readdir(p),
  readFile: (p) => fs.readFile(p, "utf8"),
  async stat(p) {
    const s = await fs.stat(p);
    return { isDirectory: () => s.isDirectory() };
  },
};

export interface DiscoverOptions {
  fs?: CustomFsAdapter;
  /** Stop the upward walk at this directory (inclusive). Defaults to the user's home dir. */
  stopAt?: string;
  /** Override the user-global commands dir (defaults to ~/.enclo/commands). */
  userGlobalDir?: string;
}

/**
 * Walk from `cwd` up toward `stopAt` (default: home dir). At each ancestor,
 * load every `*.md` from `.enclo/commands/`. Then load the user-global
 * `~/.enclo/commands/` directory. Project-level commands (closer to cwd)
 * override user-global on name collision.
 */
export async function discoverCustomCommands(
  cwd: string,
  options: DiscoverOptions = {},
): Promise<Map<string, CustomCommand>> {
  const fsImpl = options.fs ?? DEFAULT_FS;
  const stopAt = path.resolve(options.stopAt ?? homedir());
  const userGlobal = options.userGlobalDir ?? path.join(homedir(), ".enclo", "commands");

  // Collect candidate dirs in priority order: closest project first, then
  // outer ancestors, then user-global. Earlier entries win on collision.
  const dirs: string[] = [];
  const visited = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    dirs.push(path.join(dir, ".enclo", "commands"));
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // User-global lives at the end (lowest priority).
  if (!dirs.includes(userGlobal)) dirs.push(userGlobal);

  const out = new Map<string, CustomCommand>();
  for (const d of dirs) {
    let entries: string[];
    try {
      const st = await fsImpl.stat(d);
      if (!st.isDirectory()) continue;
      entries = await fsImpl.readdir(d);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const name = entry.slice(0, -3).toLowerCase();
      if (out.has(name)) continue; // earlier (closer) wins
      const full = path.join(d, entry);
      let raw: string;
      try {
        raw = await fsImpl.readFile(full);
      } catch {
        continue;
      }
      const cmd = parseCustomCommand(name, raw, full);
      out.set(name, cmd);
    }
  }
  return out;
}

/**
 * Parse a markdown file with optional YAML-style frontmatter into a
 * CustomCommand. Frontmatter is delimited by lines containing only `---`.
 * Recognized fields: description, argument-hint, model, allowed-tools.
 */
export function parseCustomCommand(
  name: string,
  raw: string,
  sourcePath: string,
): CustomCommand {
  // Normalize line endings so frontmatter detection works on Windows.
  const text = raw.replace(/\r\n/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let frontmatter: Record<string, string> = {};
  let body = text;
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1] ?? "");
    body = text.slice(fmMatch[0].length);
  }
  const description = frontmatter["description"] ?? `Custom command: ${name}`;
  const cmd: CustomCommand = {
    name,
    description,
    body,
    sourcePath,
  };
  if (frontmatter["argument-hint"]) cmd.argumentHint = frontmatter["argument-hint"];
  if (frontmatter["model"]) cmd.model = frontmatter["model"];
  const tools = parseToolList(frontmatter["allowed-tools"]);
  if (tools) cmd.allowedTools = tools;
  return cmd;
}

/**
 * Tiny YAML-frontmatter parser. Supports `key: value`, `key: "quoted"`, and
 * inline-array `key: [a, b, c]`. Sufficient for our flat schema; we
 * deliberately avoid pulling in a YAML dependency.
 */
function parseFrontmatter(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseToolList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const inner = raw.trim();
  if (!inner.startsWith("[") || !inner.endsWith("]")) {
    // Comma-separated scalar form.
    const parts = inner
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  const list = inner
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export interface AppliedCustomCommand {
  prompt: string;
  modelOverride?: string;
  allowedToolsOverride?: string[];
}

/**
 * Substitute the supported placeholders in the command body and return the
 * prompt to send for this turn (along with any per-turn overrides).
 *
 * Recognized placeholders:
 *   $ARGUMENTS  → the entire raw argument string after the command name
 *   $1, $2 …    → positional args (whitespace-split from $ARGUMENTS)
 *   $CWD        → the agent's current working directory
 * Anything else (e.g. $FOO, $PATH) is left literal so commands can include
 * shell-like text without surprises.
 */
export function applyCustomCommand(
  cmd: CustomCommand,
  args: string,
  cwd: string,
): AppliedCustomCommand {
  const trimmedArgs = args.trim();
  const positional = trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/) : [];

  const prompt = cmd.body.replace(/\$([A-Z][A-Z0-9_]*|\d+)/g, (match, token: string) => {
    if (token === "ARGUMENTS") return trimmedArgs;
    if (token === "CWD") return cwd;
    if (/^\d+$/.test(token)) {
      const idx = parseInt(token, 10) - 1;
      if (idx >= 0 && idx < positional.length) return positional[idx] ?? "";
      // Out-of-range numeric placeholder collapses to empty (positional
      // args that weren't provided shouldn't render as literal "$3").
      return "";
    }
    return match;
  });

  const out: AppliedCustomCommand = { prompt };
  if (cmd.model) out.modelOverride = cmd.model;
  if (cmd.allowedTools) out.allowedToolsOverride = cmd.allowedTools;
  return out;
}
