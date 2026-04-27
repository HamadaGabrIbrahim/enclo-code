import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { McpConfigSchema, type McpConfig } from "./types.js";

export interface FsLike {
  readFile(p: string, encoding: BufferEncoding): Promise<string>;
}

const defaultFs: FsLike = {
  readFile: (p, enc) => fsPromises.readFile(p, enc),
};

export interface LoadMcpConfigResult {
  config: McpConfig;
  /** Files actually read (for diagnostics). */
  sources: string[];
  /** Per-file parse errors (file existed but content was rejected). */
  errors: { path: string; message: string }[];
}

/** Path to the user-global config file. */
export function userConfigPath(): string {
  return path.join(homedir(), ".enclo", "mcp.json");
}

/** Path to the project-local config file (relative to cwd). */
export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".enclo", "mcp.json");
}

async function readConfigFile(
  fs: FsLike,
  filepath: string,
): Promise<{ raw?: string; missing: boolean }> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    return { raw, missing: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { missing: true };
    throw err;
  }
}

function parseOrThrow(raw: string, filepath: string): McpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filepath}: invalid JSON — ${(err as Error).message}`);
  }
  const result = McpConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${filepath}: schema mismatch — ${result.error.message}`);
  }
  return result.data;
}

/**
 * Load MCP configuration. Project config (`.enclo/mcp.json` under `cwd`) is
 * merged into the user-global config (`~/.enclo/mcp.json`); project entries
 * shadow user entries with the same server name.
 *
 * Missing files are tolerated. A malformed file is reported in `errors` and
 * its contents are skipped so a single bad config doesn't break the session.
 */
export async function loadMcpConfig(
  cwd: string,
  fs: FsLike = defaultFs,
): Promise<LoadMcpConfigResult> {
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);
  const sources: string[] = [];
  const errors: { path: string; message: string }[] = [];

  let merged: McpConfig = { mcpServers: {} };

  for (const filepath of [userPath, projectPath]) {
    const { raw, missing } = await readConfigFile(fs, filepath);
    if (missing || raw === undefined) continue;
    sources.push(filepath);
    try {
      const cfg = parseOrThrow(raw, filepath);
      merged = {
        mcpServers: { ...merged.mcpServers, ...cfg.mcpServers },
      };
    } catch (err) {
      errors.push({ path: filepath, message: (err as Error).message });
    }
  }

  return { config: merged, sources, errors };
}
