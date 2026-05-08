import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyCustomSkill,
  discoverCustomSkills,
  parseCustomSkill,
  substituteSkillBody,
} from "../../src/discovery/custom-skills.js";

let tmpHome: string;
let tmpRoot: string;
let tmpUserGlobal: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-skill-home-"));
  tmpRoot = await fs.mkdtemp(path.join(tmpHome, "proj-"));
  tmpUserGlobal = path.join(tmpHome, ".enclo", "skills");
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, `${name}.md`);
  await fs.writeFile(full, body);
  return full;
}

describe("parseCustomSkill", () => {
  it("parses frontmatter and body", () => {
    const raw = [
      "---",
      "description: Run security review",
      "model: claude-sonnet-4",
      "allowed-tools: [grep, read_file]",
      "---",
      "Review $ARGUMENTS for security issues.",
      "",
    ].join("\n");
    const skill = parseCustomSkill("security-review", raw, "/tmp/security-review.md");
    expect(skill.name).toBe("security-review");
    expect(skill.description).toBe("Run security review");
    expect(skill.model).toBe("claude-sonnet-4");
    expect(skill.allowedTools).toEqual(["grep", "read_file"]);
    expect(skill.body.startsWith("Review $ARGUMENTS")).toBe(true);
  });

  it("falls back to a synthetic description when frontmatter is missing", () => {
    const skill = parseCustomSkill("plain", "just a body\n", "/x");
    expect(skill.description).toMatch(/plain/);
    expect(skill.body).toContain("just a body");
    expect(skill.allowedTools).toBeUndefined();
  });

  it("accepts `tools:` as a synonym for `allowed-tools:`", () => {
    const raw = "---\ntools: grep, glob\n---\nbody\n";
    const skill = parseCustomSkill("x", raw, "/x");
    expect(skill.allowedTools).toEqual(["grep", "glob"]);
  });

  it("lowercases the name from frontmatter", () => {
    const raw = "---\nname: SecurityReview\n---\nbody\n";
    const skill = parseCustomSkill("filename", raw, "/x");
    expect(skill.name).toBe("securityreview");
  });
});

describe("substituteSkillBody", () => {
  it("substitutes $ARGUMENTS, $1, $2, $CWD", () => {
    const skill = parseCustomSkill(
      "echo",
      "args=$ARGUMENTS first=$1 second=$2 cwd=$CWD\n",
      "/x",
    );
    const out = substituteSkillBody(skill, "alpha beta gamma", "/wd");
    expect(out).toBe("args=alpha beta gamma first=alpha second=beta cwd=/wd");
  });

  it("collapses out-of-range positional placeholders to empty", () => {
    const skill = parseCustomSkill("x", "first=$1 third=$3\n", "/x");
    const out = substituteSkillBody(skill, "only", "/wd");
    expect(out).toBe("first=only third=");
  });

  it("leaves unrecognized placeholders literal", () => {
    const skill = parseCustomSkill("x", "$PATH stays $FOO too\n", "/x");
    const out = substituteSkillBody(skill, "", "/wd");
    expect(out).toBe("$PATH stays $FOO too");
  });
});

describe("applyCustomSkill", () => {
  it("applies substitutions and surfaces overrides", () => {
    const raw = [
      "---",
      "model: gpt-4",
      "allowed-tools: [grep]",
      "---",
      "find $1",
      "",
    ].join("\n");
    const skill = parseCustomSkill("find", raw, "/x");
    const applied = applyCustomSkill(skill, "needle", "/wd");
    expect(applied.prompt).toBe("find needle");
    expect(applied.modelOverride).toBe("gpt-4");
    expect(applied.allowedToolsOverride).toEqual(["grep"]);
  });

  it("omits overrides when frontmatter doesn't set them", () => {
    const skill = parseCustomSkill("plain", "body\n", "/x");
    const applied = applyCustomSkill(skill, "", "/wd");
    expect(applied.modelOverride).toBeUndefined();
    expect(applied.allowedToolsOverride).toBeUndefined();
  });
});

describe("discoverCustomSkills", () => {
  it("loads skills from .enclo/skills under cwd", async () => {
    await writeSkill(
      path.join(tmpRoot, ".enclo", "skills"),
      "review",
      "---\ndescription: Review code\n---\nbody\n",
    );
    const found = await discoverCustomSkills(tmpRoot, { stopAt: tmpHome });
    expect([...found.keys()]).toEqual(["review"]);
    expect(found.get("review")?.description).toBe("Review code");
  });

  it("project-level skills win over user-global on name collision", async () => {
    await writeSkill(
      path.join(tmpRoot, ".enclo", "skills"),
      "shared",
      "---\ndescription: project version\n---\nbody-proj\n",
    );
    await writeSkill(
      tmpUserGlobal,
      "shared",
      "---\ndescription: user version\n---\nbody-user\n",
    );
    const found = await discoverCustomSkills(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(found.get("shared")?.description).toBe("project version");
  });

  it("loads from user-global directory when no project skills exist", async () => {
    await writeSkill(
      tmpUserGlobal,
      "global-only",
      "---\ndescription: from home\n---\nbody\n",
    );
    const found = await discoverCustomSkills(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(found.get("global-only")?.description).toBe("from home");
  });

  it("returns an empty map when no skills directory exists anywhere", async () => {
    const found = await discoverCustomSkills(tmpRoot, {
      stopAt: tmpHome,
      userGlobalDir: tmpUserGlobal,
    });
    expect(found.size).toBe(0);
  });
});
