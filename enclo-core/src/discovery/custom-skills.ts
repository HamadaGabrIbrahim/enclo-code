import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * A user-authored skill discovered from `.enclo/skills/<name>.md`. Skills
 * are on-demand instruction sets: the agent calls the `Skill` tool to load
 * one mid-turn, or the user invokes `/skill <name>` to expand it as a
 * prompt. Body supports the same $ARGUMENTS / $1 / $CWD substitutions as
 * custom commands.
 */
export interface CustomSkill {
  /** Skill name (frontmatter `name`, defaults to filename stem). */
  name: string;
  /** When-to-use description surfaced to the model in the Skill tool's enum. */
  description: string;
  /** Optional whitelist of tool names available when the skill is run via /skill. */
  allowedTools?: string[];
  /** Optional model override (only honored by /skill, not the Skill tool). */
  model?: string;
  /** Body of the markdown file (after frontmatter) — the skill's content. */
  body: string;
  /** Absolute path the skill was loaded from (for diagnostics). */
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
  /** Override the user-global skills dir (defaults to ~/.enclo/skills). */
  userGlobalDir?: string;
}

/**
 * Walk from `cwd` up toward `stopAt` (default: home). At each ancestor,
 * load every `*.md` from `.enclo/skills/`. Then load the user-global
 * `~/.enclo/skills/` directory. Project-level skills (closer to cwd)
 * override user-global on name collision.
 */
export async function discoverCustomSkills(
  cwd: string,
  options: DiscoverOptions = {},
): Promise<Map<string, CustomSkill>> {
  const fsImpl = options.fs ?? DEFAULT_FS;
  const stopAt = path.resolve(options.stopAt ?? homedir());
  const userGlobal = options.userGlobalDir ?? path.join(homedir(), ".enclo", "skills");

  const dirs: string[] = [];
  const visited = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    dirs.push(path.join(dir, ".enclo", "skills"));
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!dirs.includes(userGlobal)) dirs.push(userGlobal);

  const out = new Map<string, CustomSkill>();
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
      const skill = parseCustomSkill(stem, raw, full);
      if (out.has(skill.name)) continue; // earlier (closer) wins
      out.set(skill.name, skill);
    }
  }
  return out;
}

/**
 * Parse a markdown file with optional YAML-style frontmatter into a
 * CustomSkill. The body becomes the on-demand instruction text.
 */
export function parseCustomSkill(
  filenameStem: string,
  raw: string,
  sourcePath: string,
): CustomSkill {
  const text = raw.replace(/\r\n/g, "\n");
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let frontmatter: Record<string, string> = {};
  let body = text;
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1] ?? "");
    body = text.slice(fmMatch[0].length);
  }
  const name = (frontmatter["name"] ?? filenameStem).toLowerCase();
  const description = frontmatter["description"] ?? `Custom skill: ${name}`;
  const skill: CustomSkill = {
    name,
    description,
    body: body.trim(),
    sourcePath,
  };
  if (frontmatter["model"]) skill.model = frontmatter["model"];
  const tools = parseToolList(frontmatter["allowed-tools"] ?? frontmatter["tools"]);
  if (tools) skill.allowedTools = tools;
  return skill;
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

export interface AppliedCustomSkill {
  prompt: string;
  modelOverride?: string;
  allowedToolsOverride?: string[];
}

/**
 * Substitute supported placeholders in the skill body and return the
 * prompt to send. Same semantics as custom commands: $ARGUMENTS, $1, $2,
 * $CWD. Used by the user-facing /skill slash command.
 */
export function applyCustomSkill(
  skill: CustomSkill,
  args: string,
  cwd: string,
): AppliedCustomSkill {
  const prompt = substitute(skill.body, args, cwd);
  const out: AppliedCustomSkill = { prompt };
  if (skill.model) out.modelOverride = skill.model;
  if (skill.allowedTools) out.allowedToolsOverride = skill.allowedTools;
  return out;
}

/**
 * Substitute placeholders without applying tool/model overrides. Used by
 * the `Skill` tool when the model loads a skill mid-turn — the result goes
 * straight back to the model as a tool message, no per-turn overrides.
 */
export function substituteSkillBody(skill: CustomSkill, args: string, cwd: string): string {
  return substitute(skill.body, args, cwd);
}

function substitute(body: string, args: string, cwd: string): string {
  const trimmed = args.trim();
  const positional = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  return body.replace(/\$([A-Z][A-Z0-9_]*|\d+)/g, (match, token: string) => {
    if (token === "ARGUMENTS") return trimmed;
    if (token === "CWD") return cwd;
    if (/^\d+$/.test(token)) {
      const idx = parseInt(token, 10) - 1;
      if (idx >= 0 && idx < positional.length) return positional[idx] ?? "";
      return "";
    }
    return match;
  });
}
