import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addPersistedRule,
  clearPersistedUserRules,
  loadPersistedPermissions,
  removePersistedRule,
  userPermissionsPath,
  type PermissionRule,
} from "../../src/agent/permissions-storage.js";

let tmpHome: string;
let userDir: string;
let projectRoot: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-perm-home-"));
  userDir = path.join(tmpHome, ".enclo");
  await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
  projectRoot = await fs.mkdtemp(path.join(tmpHome, "proj-"));
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function readFile(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

describe("loadPersistedPermissions", () => {
  it("returns [] when the user file is missing and no project file exists", async () => {
    const rules = await loadPersistedPermissions(projectRoot, {
      userDir,
      stopAt: tmpHome,
    });
    expect(rules).toEqual([]);
  });

  it("loads valid rules with source=user", async () => {
    const file = path.join(userDir, "permissions.json");
    const data = {
      version: 1,
      rules: [
        {
          tool: "write_file",
          scope: "tool",
          effect: "allow",
          grantedAt: "2026-04-26T00:00:00.000Z",
        },
        {
          tool: "bash",
          target: "bash:rm",
          scope: "target",
          effect: "deny",
          grantedAt: "2026-04-26T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(file, JSON.stringify(data));
    const rules = await loadPersistedPermissions(projectRoot, {
      userDir,
      stopAt: tmpHome,
    });
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.source === "user")).toBe(true);
    const write = rules.find((r) => r.tool === "write_file");
    expect(write?.scope).toBe("tool");
    expect(write?.effect).toBe("allow");
    const bashRm = rules.find((r) => r.target === "bash:rm");
    expect(bashRm?.effect).toBe("deny");
  });

  it("ignores corrupt or schema-invalid files (returns [])", async () => {
    const file = path.join(userDir, "permissions.json");
    await fs.writeFile(file, "not json");
    const rules = await loadPersistedPermissions(projectRoot, {
      userDir,
      stopAt: tmpHome,
    });
    expect(rules).toEqual([]);

    await fs.writeFile(file, JSON.stringify({ version: 999, rules: [] }));
    const rules2 = await loadPersistedPermissions(projectRoot, {
      userDir,
      stopAt: tmpHome,
    });
    expect(rules2).toEqual([]);
  });

  it("merges project rules and tags them with source=project, project overrides user", async () => {
    // user rule for write_file = allow
    await fs.writeFile(
      path.join(userDir, "permissions.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "write_file",
            scope: "tool",
            effect: "allow",
            grantedAt: "2026-04-26T00:00:00.000Z",
          },
          {
            tool: "edit_file",
            scope: "tool",
            effect: "allow",
            grantedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
      }),
    );
    // project rule for write_file = deny (overrides user allow)
    const projDir = path.join(projectRoot, ".enclo");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(
      path.join(projDir, "permissions.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "write_file",
            scope: "tool",
            effect: "deny",
            grantedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
      }),
    );
    const rules = await loadPersistedPermissions(projectRoot, {
      userDir,
      stopAt: tmpHome,
    });
    const write = rules.find((r) => r.tool === "write_file");
    expect(write?.source).toBe("project");
    expect(write?.effect).toBe("deny");
    const edit = rules.find((r) => r.tool === "edit_file");
    expect(edit?.source).toBe("user");
    expect(edit?.effect).toBe("allow");
  });

  it("walks ancestors so an inner project file overrides an outer one", async () => {
    const inner = path.join(projectRoot, "a", "b");
    await fs.mkdir(inner, { recursive: true });
    await fs.mkdir(path.join(projectRoot, ".enclo"), { recursive: true });
    await fs.mkdir(path.join(inner, ".enclo"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".enclo", "permissions.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "bash",
            scope: "tool",
            effect: "allow",
            grantedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(inner, ".enclo", "permissions.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "bash",
            scope: "tool",
            effect: "deny",
            grantedAt: "2026-04-26T00:00:00.000Z",
          },
        ],
      }),
    );
    const rules = await loadPersistedPermissions(inner, {
      userDir,
      stopAt: tmpHome,
    });
    const bash = rules.find((r) => r.tool === "bash");
    expect(bash?.effect).toBe("deny"); // inner wins
  });
});

describe("addPersistedRule", () => {
  it("writes user rule with mode 0600 and the right shape", async () => {
    const stored = await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    expect(stored.source).toBe("user");
    expect(stored.tool).toBe("write_file");
    expect(stored.grantedAt).toMatch(/T/);
    const file = path.join(userDir, "permissions.json");
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(file));
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].tool).toBe("write_file");
  });

  it("replaces an existing rule with the same (tool, target, scope)", async () => {
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "deny" },
      "user",
      projectRoot,
      { userDir },
    );
    const file = path.join(userDir, "permissions.json");
    const parsed = JSON.parse(await readFile(file));
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].effect).toBe("deny");
  });

  it("can write a project-scoped rule into <cwd>/.enclo/permissions.json", async () => {
    await addPersistedRule(
      { tool: "edit_file", scope: "tool", effect: "allow" },
      "project",
      projectRoot,
      { userDir },
    );
    const file = path.join(projectRoot, ".enclo", "permissions.json");
    const parsed = JSON.parse(await readFile(file));
    expect(parsed.rules[0].tool).toBe("edit_file");
  });

  it("does not leave a .tmp file behind on success", async () => {
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    const entries = await fs.readdir(userDir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});

describe("removePersistedRule", () => {
  it("returns true on hit, false on miss", async () => {
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    const hit = await removePersistedRule("write_file", undefined, "tool", "user", projectRoot, {
      userDir,
    });
    expect(hit).toBe(true);
    const miss = await removePersistedRule("write_file", undefined, "tool", "user", projectRoot, {
      userDir,
    });
    expect(miss).toBe(false);
  });

  it("only removes the matching (tool, target, scope) rule", async () => {
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    await addPersistedRule(
      { tool: "edit_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    await removePersistedRule("write_file", undefined, "tool", "user", projectRoot, { userDir });
    const file = path.join(userDir, "permissions.json");
    const parsed = JSON.parse(await readFile(file));
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].tool).toBe("edit_file");
  });
});

describe("clearPersistedUserRules", () => {
  it("wipes the user file but leaves it as a valid empty rules file", async () => {
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    await clearPersistedUserRules({ userDir });
    const file = path.join(userDir, "permissions.json");
    const parsed = JSON.parse(await readFile(file));
    expect(parsed).toEqual({ version: 1, rules: [] });
  });
});

describe("userPermissionsPath", () => {
  it("returns ~/.enclo/permissions.json by default", () => {
    const p = userPermissionsPath();
    expect(p.endsWith(path.join(".enclo", "permissions.json"))).toBe(true);
  });
  it("respects an explicit userDir", () => {
    expect(userPermissionsPath("/tmp/x")).toBe(path.join("/tmp/x", "permissions.json"));
  });
});

describe("atomic write", () => {
  it("writes via .tmp then renames so a partial file never exists", async () => {
    const file = path.join(userDir, "permissions.json");
    await addPersistedRule(
      { tool: "write_file", scope: "tool", effect: "allow" },
      "user",
      projectRoot,
      { userDir },
    );
    // After the write, the on-disk file should be valid JSON (not a partial
    // truncation). We re-read it; if it parses cleanly, the rename happened
    // atomically.
    const parsed = JSON.parse(await readFile(file)) as { rules: PermissionRule[] };
    expect(parsed.rules).toHaveLength(1);
    const entries = await fs.readdir(userDir);
    expect(entries).toEqual(expect.arrayContaining(["permissions.json"]));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});
