import { describe, expect, it } from "vitest";
import { createSkillTool } from "../../src/tools/skill.js";
import { parseCustomSkill, type CustomSkill } from "../../src/discovery/custom-skills.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctx: ToolContext = { cwd: "/wd" };

function makeMap(skills: CustomSkill[]): Map<string, CustomSkill> {
  return new Map(skills.map((s) => [s.name, s]));
}

describe("createSkillTool", () => {
  it("returns null when no skills are registered", () => {
    expect(createSkillTool(new Map())).toBeNull();
  });

  it("builds a tool whose enum lists every registered skill", () => {
    const map = makeMap([
      parseCustomSkill("a", "---\ndescription: alpha\n---\nbody-a\n", "/x"),
      parseCustomSkill("b", "---\ndescription: beta\n---\nbody-b\n", "/x"),
    ]);
    const tool = createSkillTool(map);
    expect(tool).not.toBeNull();
    const props = tool!.definition.function.parameters.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props["skill"]?.enum?.sort()).toEqual(["a", "b"]);
    expect(tool!.definition.function.description).toContain("alpha");
    expect(tool!.definition.function.description).toContain("beta");
  });

  it("returns the skill body as the result content", async () => {
    const skill = parseCustomSkill(
      "review",
      "---\ndescription: Run review\n---\nReview the code carefully.\n",
      "/x",
    );
    const tool = createSkillTool(makeMap([skill]))!;
    const result = await tool.execute({ skill: "review" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Review the code carefully.");
  });

  it("substitutes $ARGUMENTS / $1 / $CWD when args are passed", async () => {
    const skill = parseCustomSkill(
      "echo",
      "---\ndescription: echo\n---\nargs=$ARGUMENTS first=$1 cwd=$CWD\n",
      "/x",
    );
    const tool = createSkillTool(makeMap([skill]))!;
    const result = await tool.execute({ skill: "echo", args: "alpha beta" }, ctx);
    expect(result.content).toBe("args=alpha beta first=alpha cwd=/wd");
  });

  it("is case-insensitive on the skill name", async () => {
    const skill = parseCustomSkill("review", "body\n", "/x");
    const tool = createSkillTool(makeMap([skill]))!;
    const result = await tool.execute({ skill: "REVIEW" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("body");
  });

  it("returns an error result with the available list when the name is unknown", async () => {
    const skill = parseCustomSkill("review", "body\n", "/x");
    const tool = createSkillTool(makeMap([skill]))!;
    const result = await tool.execute({ skill: "missing" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing");
    expect(result.content).toContain("review");
  });

  it("rejects malformed args", async () => {
    const tool = createSkillTool(
      makeMap([parseCustomSkill("x", "body\n", "/x")]),
    )!;
    await expect(tool.execute({}, ctx)).rejects.toThrow(/skill/i);
    await expect(tool.execute({ skill: "x", args: 5 }, ctx)).rejects.toThrow(
      /args/i,
    );
  });

  it("does not require permission (read-only reference load)", () => {
    const tool = createSkillTool(
      makeMap([parseCustomSkill("x", "body\n", "/x")]),
    )!;
    expect(tool.requiresPermission).toBe(false);
    expect(tool.category).toBe("read");
  });
});
