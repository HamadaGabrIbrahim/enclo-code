import type { ConfigStore, EncloConfig } from "../../src/config/types.js";

/**
 * Minimal in-memory ConfigStore for tests. The real implementations live in
 * each consumer (the CLI uses a JSON file at ~/.enclo/config.json; the VS
 * Code extension uses workspace state). Core only depends on the interface.
 */
export function createMemoryConfigStore(initial: EncloConfig = {}): ConfigStore {
  let state: EncloConfig = { ...initial };
  return {
    path: "memory://test",
    async load() {
      return { ...state };
    },
    async save(cfg) {
      state = { ...cfg };
    },
    async update(patch) {
      const next: EncloConfig = { ...state };
      for (const [k, v] of Object.entries(patch) as [keyof EncloConfig, unknown][]) {
        if (v === undefined) delete (next as Record<string, unknown>)[k as string];
        else (next as Record<string, unknown>)[k as string] = v;
      }
      state = next;
      return { ...state };
    },
    async clear() {
      state = {};
    },
  };
}
