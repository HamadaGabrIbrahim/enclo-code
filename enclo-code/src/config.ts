import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigSchema, UserSchema } from "@enclo/core";
import type { ConfigStore, EncloConfig, EncloUser } from "@enclo/core";

export { UserSchema, ConfigSchema };
export type { ConfigStore, EncloConfig, EncloUser };

export interface ConfigOptions {
  /** Override the directory (defaults to ~/.enclo). Useful for tests. */
  dir?: string;
}

export function defaultConfigDir(): string {
  return path.join(homedir(), ".enclo");
}

/**
 * Loads (and creates) a config file at <dir>/config.json with mode 0600.
 * The directory is created with mode 0700 if missing.
 */
export function createConfigStore(opts: ConfigOptions = {}): ConfigStore {
  const dir = opts.dir ?? defaultConfigDir();
  const file = path.join(dir, "config.json");

  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }

  async function load(): Promise<EncloConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) return {};
    return result.data;
  }

  async function save(cfg: EncloConfig): Promise<void> {
    await ensureDir();
    const tmp = `${file}.tmp`;
    const data = JSON.stringify(cfg, null, 2);
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  }

  async function update(patch: Partial<EncloConfig>): Promise<EncloConfig> {
    const current = await load();
    const next = { ...current, ...patch };
    await save(next);
    return next;
  }

  async function clear(): Promise<void> {
    await save({});
  }

  return { path: file, load, save, update, clear };
}
