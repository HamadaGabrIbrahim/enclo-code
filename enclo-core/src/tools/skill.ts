import type { Tool, ToolContext, ToolResult } from "./types.js";
import {
  substituteSkillBody,
  type CustomSkill,
} from "../discovery/custom-skills.js";

const BASE_DESCRIPTION =
  "Load a named skill — a reusable instruction set authored by the user under .enclo/skills/. The tool returns the skill's body as the result; treat that body as authoritative instructions for the rest of this turn (or for the work the user just asked about).";

interface Args {
  skill: string;
  args?: string;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("Skill: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["skill"] !== "string" || obj["skill"].length === 0) {
    throw new Error("Skill: 'skill' must be a non-empty string");
  }
  const out: Args = { skill: obj["skill"] };
  if (obj["args"] !== undefined) {
    if (typeof obj["args"] !== "string") {
      throw new Error("Skill: 'args' must be a string when provided");
    }
    out.args = obj["args"];
  }
  return out;
}

/**
 * Build a Skill tool whose enum/description reflects the currently-known
 * skills. Mirrors the createSpawnAgentTool pattern — when the user reloads
 * skills we rebuild the tool. Returns `null` when no skills are
 * registered, so the model isn't told about an empty enum.
 */
export function createSkillTool(
  skills: ReadonlyMap<string, CustomSkill>,
): Tool | null {
  if (skills.size === 0) return null;

  const description = describeWithSkills(skills);
  return {
    category: "read",
    requiresPermission: false,
    definition: {
      type: "function",
      function: {
        name: "Skill",
        description,
        parameters: {
          type: "object",
          properties: {
            skill: {
              type: "string",
              enum: [...skills.keys()],
              description: "Name of the skill to load.",
            },
            args: {
              type: "string",
              description:
                "Optional free-form arguments. Substituted into the skill body via $ARGUMENTS / $1 / $2 if the skill uses them.",
            },
          },
          required: ["skill"],
          additionalProperties: false,
        },
      },
    },
    async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(raw);
      const key = args.skill.toLowerCase();
      const skill = skills.get(key);
      if (!skill) {
        const available = [...skills.keys()].join(", ") || "(none registered)";
        return {
          isError: true,
          content: `Skill: unknown skill "${args.skill}". Available: ${available}`,
        };
      }
      const body = substituteSkillBody(skill, args.args ?? "", ctx.cwd);
      return {
        isError: false,
        content: body,
        display: {
          kind: "text",
          preview: `skill: ${skill.name} — ${skill.description}`,
        },
      };
    },
  };
}

function describeWithSkills(skills: ReadonlyMap<string, CustomSkill>): string {
  const list = [...skills.values()]
    .map((s) => `${s.name} (${s.description})`)
    .join("; ");
  return `${BASE_DESCRIPTION}\n\nAvailable skills (pass via 'skill'): ${list}`;
}
