import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfigStore } from "../src/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-cfg-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createConfigStore", () => {
  it("returns empty config when file does not exist", async () => {
    const store = createConfigStore({ dir: path.join(tmpDir, "missing") });
    const cfg = await store.load();
    expect(cfg).toEqual({});
  });

  it("round-trips through save and load", async () => {
    const store = createConfigStore({ dir: tmpDir });
    await store.save({
      api_url: "http://server.local:8000",
      access_token: "atk",
      refresh_token: "rtk",
      user: { id: "u1", email: "a@b.com", display_name: "A" },
      active_model: "llama-3.1-8b-instruct",
    });
    const loaded = await store.load();
    expect(loaded.api_url).toBe("http://server.local:8000");
    expect(loaded.user?.email).toBe("a@b.com");
    expect(loaded.active_model).toBe("llama-3.1-8b-instruct");
  });

  it("writes file with mode 0600", async () => {
    const store = createConfigStore({ dir: tmpDir });
    await store.save({ api_url: "http://x" });
    const stat = await fs.stat(store.path);
    // Mask off the filetype bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("update merges into existing config", async () => {
    const store = createConfigStore({ dir: tmpDir });
    await store.save({ api_url: "http://x" });
    const merged = await store.update({ active_model: "qwen" });
    expect(merged.api_url).toBe("http://x");
    expect(merged.active_model).toBe("qwen");
  });

  it("recovers from a corrupt config file by returning {}", async () => {
    const store = createConfigStore({ dir: tmpDir });
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(store.path, "not json");
    const loaded = await store.load();
    expect(loaded).toEqual({});
  });

  it("creates the parent directory with mode 0700", async () => {
    const dir = path.join(tmpDir, "nested", "enclo");
    const store = createConfigStore({ dir });
    await store.save({ api_url: "http://x" });
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});
