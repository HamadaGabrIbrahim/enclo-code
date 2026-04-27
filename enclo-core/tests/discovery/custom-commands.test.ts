import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyCustomCommand,
  discoverCustomCommands,
  parseCustomCommand,
} from "../../src/discovery/custom-commands.js";

let tmpHome: string;
let tmpRoot: string;
let tmpUserGlobal: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-cmd-home-"));
  tmpRoot = await fs.mkdtemp(path.join(tmpHome, "proj-"));
  tmpUserGlobal = path.join(tmpHome, ".enclo", "commands");
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function writeCommand(dir: string, name: string, body: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, `${name}.md`);
  await fs.writeFile(full, body);
  return full;
}

describe("parseCustomCommand", () => {
  it("parses frontmatter and body", () => {
    const raw = [
      "---",
      "description: Find all callers of a function",
      "argument-hint: <function-name>",
      "model: qwen3.6-35b-a3b",
      "allowed-tools: [grep, read_file]",
      "---",
      "Find all callers of $1.",
      "",
    ].join("\n");
    const cmd = parseCustomCommand("find-callers", raw, "/tmp/find-callers.md");
    expect(cmd.name).toBe("find-callers");
    expect(cmd.description).toBe("Find all callers of a function");
    expect(cmd.argumentHint).toBe("<function-name>");
    expect(cmd.model).toBe("qwen3.6-35b-a3b");
    expect(cmd.allowedTools).toEqual(["grep", "read_file"]);
    expect(cmd.body.startsWith("Find all callers of $1.")).toBe(true);
  });

  it("falls back to a synthetic description when frontmatter is missing", () => {
    const cmd = parseCustomCommand("plain", "just a body, no frontmatter\n", "/x");
    expect(cmd.description).toMatch(/plain/);
    expect(cmd.body).toContain("just a body");
    expect(cmd.argumentHint).toBeUndefined();
    expect(cmd.model).toBeUndefined();
    expect(cmd.allowedTools).toBeUndefined();
  });

  it("handles partial frontmatter (only description)", () => {
    const raw = "---\ndescription: only desc\n---\nbody\n";
    const cmd = parseCustomCommand("x", raw, "/x");
    expect(cmd.description).toBe("only desc");
    expect(cmd.model).toBeUndefined();
    expect(cmd.allowedTools).toBeUndefined();
    expect(cmd.body).toBe("body\n");
  });

  it("strips quoted values in frontmatter", () => {
    const raw = '---\ndescription: "with: colon"\nmodel: \'gpt-4\'\n---\nbody\n';
    const cmd = parseCustomCommand("q", raw, "/x");
    expect(cmd.description).toBe("with: colon");
    expect(cmd.model).toBe("gpt-4");
  });

  it("accepts comma-separated allowed-tools without brackets", () => {
    const raw = "---\nallowed-tools: grep, read_file\n---\nbody\n";
    const cmd = parseCustomCommand("c", raw, "/x");
    expect(cmd.allowedTools).toEqual(["grep", "read_file"]);
  });
});

describe("discoverCustomCommands", () => {
  it("loads commands from .enclo/commands/ at the cwd", async () => {
    await writeCommand(
      path.join(tmpRoot, ".enclo", "commands"),
      "explain-bug",
      "---\ndescription: Explain a bug\n---\nDebug $ARGUMENTS.\n",
    );
    const cmds = await discoverCustomCommands(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.has("explain-bug")).toBe(true);
    expect(cmds.get("explain-bug")?.description).toBe("Explain a bug");
  });

  it("walks upward from a nested cwd", async () => {
    const nested = path.join(tmpRoot, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    await writeCommand(
      path.join(tmpRoot, ".enclo", "commands"),
      "outer",
      "---\ndescription: outer\n---\nbody\n",
    );
    const cmds = await discoverCustomCommands(nested, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.get("outer")?.description).toBe("outer");
  });

  it("project-level commands override user-global on name collision", async () => {
    await writeCommand(
      tmpUserGlobal,
      "shared",
      "---\ndescription: from user-global\n---\nuser body\n",
    );
    await writeCommand(
      path.join(tmpRoot, ".enclo", "commands"),
      "shared",
      "---\ndescription: from project\n---\nproject body\n",
    );
    const cmds = await discoverCustomCommands(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.get("shared")?.description).toBe("from project");
    expect(cmds.get("shared")?.body).toContain("project body");
  });

  it("closer ancestors override farther ancestors on name collision", async () => {
    const inner = path.join(tmpRoot, "inner");
    await fs.mkdir(inner, { recursive: true });
    await writeCommand(
      path.join(tmpRoot, ".enclo", "commands"),
      "dup",
      "---\ndescription: outer\n---\nouter\n",
    );
    await writeCommand(
      path.join(inner, ".enclo", "commands"),
      "dup",
      "---\ndescription: inner\n---\ninner\n",
    );
    const cmds = await discoverCustomCommands(inner, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.get("dup")?.description).toBe("inner");
  });

  it("loads user-global commands when present and no project-level shadowing", async () => {
    await writeCommand(
      tmpUserGlobal,
      "global-only",
      "---\ndescription: global one\n---\nhi\n",
    );
    const cmds = await discoverCustomCommands(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.get("global-only")?.description).toBe("global one");
  });

  it("returns an empty map when no commands exist anywhere", async () => {
    const cmds = await discoverCustomCommands(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.size).toBe(0);
  });

  it("ignores non-.md files in the commands directory", async () => {
    const dir = path.join(tmpRoot, ".enclo", "commands");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "README.txt"), "ignore me");
    await fs.writeFile(path.join(dir, "ok.md"), "---\ndescription: kept\n---\nyo\n");
    const cmds = await discoverCustomCommands(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(cmds.size).toBe(1);
    expect(cmds.has("ok")).toBe(true);
  });
});

describe("applyCustomCommand", () => {
  function build(body: string, extra: Partial<{ model: string; allowedTools: string[] }> = {}) {
    return parseCustomCommand(
      "t",
      `---\n${extra.model ? `model: ${extra.model}\n` : ""}${extra.allowedTools ? `allowed-tools: [${extra.allowedTools.join(", ")}]\n` : ""}---\n${body}`,
      "/x",
    );
  }

  it("substitutes $ARGUMENTS with the full arg string", () => {
    const cmd = build("debug: $ARGUMENTS");
    const out = applyCustomCommand(cmd, "auth fails on signup", "/p");
    expect(out.prompt).toContain("debug: auth fails on signup");
  });

  it("substitutes $1, $2 positional args", () => {
    const cmd = build("first=$1 second=$2 third=$3");
    const out = applyCustomCommand(cmd, "alpha beta", "/p");
    expect(out.prompt).toContain("first=alpha");
    expect(out.prompt).toContain("second=beta");
    expect(out.prompt).toContain("third=");
  });

  it("substitutes $CWD", () => {
    const cmd = build("working dir is $CWD");
    const out = applyCustomCommand(cmd, "", "/some/dir");
    expect(out.prompt).toContain("working dir is /some/dir");
  });

  it("leaves unmatched $FOO literal", () => {
    const cmd = build("envname=$FOO and $PATH stays");
    const out = applyCustomCommand(cmd, "", "/p");
    expect(out.prompt).toContain("$FOO");
    expect(out.prompt).toContain("$PATH");
  });

  it("applies the model override when present", () => {
    const cmd = build("hi", { model: "qwen3.6-35b-a3b" });
    const out = applyCustomCommand(cmd, "", "/p");
    expect(out.modelOverride).toBe("qwen3.6-35b-a3b");
  });

  it("applies the allowed-tools override when present", () => {
    const cmd = build("hi", { allowedTools: ["grep", "read_file"] });
    const out = applyCustomCommand(cmd, "", "/p");
    expect(out.allowedToolsOverride).toEqual(["grep", "read_file"]);
  });

  it("leaves overrides undefined when frontmatter omits them", () => {
    const cmd = build("hi");
    const out = applyCustomCommand(cmd, "", "/p");
    expect(out.modelOverride).toBeUndefined();
    expect(out.allowedToolsOverride).toBeUndefined();
  });
});
