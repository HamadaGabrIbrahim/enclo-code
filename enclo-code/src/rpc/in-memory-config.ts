import { promises as fs } from "node:fs";
import { ConfigSchema } from "@enclo/core";
import type { ConfigStore, EncloConfig } from "@enclo/core";

/**
 * Backing store for an in-memory ConfigStore. Optionally seeds from / persists
 * to a JSON file on disk. The on-disk format is identical to the CLI's
 * config.json so the same file can be shared.
 */
export interface MemoryConfigOptions {
  /** Initial config (used when no file is given or the file is missing). */
  initial?: EncloConfig;
  /** Optional file path. When set, load+save mirror the JSON file. */
  filePath?: string;
}

/**
 * Build a ConfigStore that lives in process memory. When `filePath` is given,
 * it is loaded once at startup and re-written on each save (so editor
 * subprocesses can persist tokens between runs without piling them into the
 * regular `~/.enclo/config.json`).
 */
export function createMemoryConfigStore(
  opts: MemoryConfigOptions = {},
): ConfigStore {
  let cfg: EncloConfig = opts.initial ? { ...opts.initial } : {};
  let primed = false;
  const filePath = opts.filePath;

  async function primeOnce(): Promise<void> {
    if (primed) return;
    primed = true;
    if (!filePath) return;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = ConfigSchema.safeParse(parsed);
      if (result.success) cfg = result.data;
    } catch {
      /* ENOENT / parse errors → leave cfg as-is */
    }
  }

  async function persist(): Promise<void> {
    if (!filePath) return;
    try {
      await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch {
      /* best-effort; failure to persist must not crash the RPC server */
    }
  }

  async function load(): Promise<EncloConfig> {
    await primeOnce();
    return { ...cfg };
  }

  async function save(next: EncloConfig): Promise<void> {
    await primeOnce();
    cfg = { ...next };
    await persist();
  }

  async function update(patch: Partial<EncloConfig>): Promise<EncloConfig> {
    await primeOnce();
    cfg = { ...cfg, ...patch };
    await persist();
    return { ...cfg };
  }

  async function clear(): Promise<void> {
    await primeOnce();
    cfg = {};
    await persist();
  }

  return {
    path: filePath ?? "<in-memory>",
    load,
    save,
    update,
    clear,
  };
}
