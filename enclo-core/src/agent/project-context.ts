import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Maximum size of an enclo.md file we'll load. Larger files are skipped with a warning. */
export const MAX_PROJECT_CONTEXT_BYTES = 50 * 1024;

const FILENAMES = ["enclo.md", path.join(".enclo", "enclo.md")] as const;

export interface ProjectContext {
  /** Absolute path the context was loaded from. */
  path: string;
  /** Raw text content. */
  content: string;
}

export interface FsAdapter {
  readFile: (p: string) => Promise<Buffer>;
  stat: (p: string) => Promise<{ size: number }>;
}

export interface FindOptions {
  fs?: FsAdapter;
  /** Stop the upward walk at this directory (inclusive). Defaults to the user's home dir. */
  stopAt?: string;
  /** Override warning sink (defaults to console.warn). */
  onWarn?: (msg: string) => void;
  /** Override max bytes (used by tests). */
  maxBytes?: number;
}

const DEFAULT_FS: FsAdapter = {
  readFile: (p) => fs.readFile(p),
  async stat(p) {
    const s = await fs.stat(p);
    return { size: s.size };
  },
};

/**
 * Walk from `cwd` upward toward the home directory. At each ancestor, look for
 * `enclo.md` then `.enclo/enclo.md`. Returns the first match. Files larger than
 * `MAX_PROJECT_CONTEXT_BYTES` are skipped with a warning so the agent still
 * works even when someone drops a giant doc into the directory.
 */
export async function findProjectContext(
  cwd: string,
  options: FindOptions = {},
): Promise<ProjectContext | null> {
  const fsImpl = options.fs ?? DEFAULT_FS;
  const stopAt = path.resolve(options.stopAt ?? homedir());
  const cap = options.maxBytes ?? MAX_PROJECT_CONTEXT_BYTES;
  const warn = options.onWarn ?? ((m: string) => console.warn(m));

  const visited = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    for (const name of FILENAMES) {
      const candidate = path.join(dir, name);
      try {
        const st = await fsImpl.stat(candidate);
        if (st.size > cap) {
          warn(
            `enclo.md at ${candidate} is ${st.size} bytes (cap ${cap}); skipping.`,
          );
          return null;
        }
        const buf = await fsImpl.readFile(candidate);
        return { path: candidate, content: buf.toString("utf8") };
      } catch {
        /* not present here, keep walking */
      }
    }
    // Stop once we've checked the home directory or hit the filesystem root.
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The list of paths the discovery walk would inspect, for /context diagnostics. */
export function listSearchPaths(cwd: string, stopAt?: string): string[] {
  const stop = path.resolve(stopAt ?? homedir());
  const out: string[] = [];
  const seen = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    if (seen.has(dir)) break;
    seen.add(dir);
    for (const name of FILENAMES) out.push(path.join(dir, name));
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}
