import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * A user-authored sub-agent specialist discovered from a
 * `.enclo/agents/<name>.md` file. The body is the system prompt the
 * sub-agent runs under. Frontmatter fields tweak which tools the
 * specialist can see and which model it runs against.
 */
export interface CustomSubagent {
  /** Subagent name (frontmatter `name`, defaults to filename stem). */
  name: string;
  /** When-to-use description shown in /agents and surfaced to the parent agent. */
  description: string;
  /** Optional whitelist of tool names available to this subagent. */
  tools?: string[];
  /** Optional model override for this subagent's turns. */
  model?: string;
  /** System prompt for the subagent. */
  systemPrompt: string;
  /** Absolute path the subagent was loaded from (for diagnostics). */
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
  /** Stop the upward walk at this directory (inclusive). Defaults to ~. */
  stopAt?: string;
  /** Override the user-global agents dir (defaults to ~/.enclo/agents). */
  userGlobalDir?: string;
}

/**
 * Walk from `cwd` up toward `stopAt` (default: home). At each ancestor,
 * load every `*.md` from `.enclo/agents/`. Then load the user-global
 * `~/.enclo/agents/` directory. Project-level subagents (closer to cwd)
 * override user-global on name collision.
 */
export async function discoverCustomSubagents(
  cwd: string,
  options: DiscoverOptions = {},
): Promise<Map<string, CustomSubagent>> {
  const fsImpl = options.fs ?? DEFAULT_FS;
  const stopAt = path.resolve(options.stopAt ?? homedir());
  const userGlobal = options.userGlobalDir ?? path.join(homedir(), ".enclo", "agents");

  const dirs: string[] = [];
  const visited = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    dirs.push(path.join(dir, ".enclo", "agents"));
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!dirs.includes(userGlobal)) dirs.push(userGlobal);

  const out = new Map<string, CustomSubagent>();
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
      const stem = entry.slice(0, -3);
      const full = path.join(d, entry);
      let raw: string;
      try {
        raw = await fsImpl.readFile(full);
      } catch {
        continue;
      }
      const sub = parseCustomSubagent(stem, raw, full);
      if (out.has(sub.name)) continue; // earlier (closer) wins
      out.set(sub.name, sub);
    }
  }
  return out;
}

/**
 * Parse a markdown file with optional YAML-style frontmatter into a
 * CustomSubagent. The body becomes the system prompt; the `name` field
 * (if present) overrides the filename stem.
 */
export function parseCustomSubagent(
  filenameStem: string,
  raw: string,
  sourcePath: string,
): CustomSubagent {
  const text = raw.replace(/\r\n/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let frontmatter: Record<string, string> = {};
  let body = text;
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1] ?? "");
    body = text.slice(fmMatch[0].length);
  }
  const name = (frontmatter["name"] ?? filenameStem).toLowerCase();
  const description = frontmatter["description"] ?? `Custom subagent: ${name}`;
  const sub: CustomSubagent = {
    name,
    description,
    systemPrompt: body.trim(),
    sourcePath,
  };
  if (frontmatter["model"]) sub.model = frontmatter["model"];
  const tools = parseToolList(frontmatter["tools"]);
  if (tools) sub.tools = tools;
  return sub;
}

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

/**
 * Build the dynamic description for the spawn_agent tool. Lists every
 * registered custom subagent with its description so the model knows what
 * specialists are available before deciding whether to set
 * `subagent_type`.
 */
export function describeSubagents(subagents: Map<string, CustomSubagent>): string {
  const base =
    "Run a focused sub-agent on a specific task with its own conversation. The sub-agent has access to the same tools (except spawn_agent itself by default) and runs until it produces a final answer, which is returned as this tool's result. Use for parallelizable or scoped work that you want to keep out of the main conversation.";
  if (subagents.size === 0) return base;
  const list = [...subagents.values()]
    .map((s) => `${s.name} (${s.description})`)
    .join("; ");
  return `${base}\n\nAvailable custom subagents (pass via 'subagent_type'): ${list}`;
}
