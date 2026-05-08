import { makeRegistry, type Tool, type ToolRegistry } from "./types.js";
import { readFile } from "./read_file.js";
import { writeFile } from "./write_file.js";
import { editFile } from "./edit_file.js";
import { bash } from "./bash.js";
import { grep } from "./grep.js";
import { glob } from "./glob.js";
import { listDir } from "./list_dir.js";
import { spawnAgent, createSpawnAgentTool } from "./spawn_agent.js";
import { createSkillTool } from "./skill.js";
import { webFetch } from "./web_fetch.js";
import { webSearch } from "./web_search.js";

export {
  readFile,
  writeFile,
  editFile,
  bash,
  grep,
  glob,
  listDir,
  spawnAgent,
  createSpawnAgentTool,
  createSkillTool,
  webFetch,
  webSearch,
};
export type { Tool, ToolRegistry };
export type {
  ToolDefinition,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolDisplay,
  AgentToolHooks,
  OneshotArgs,
  SpawnAgentArgs,
  SpawnAgentOutcome,
  SubagentSpec,
} from "./types.js";

export function builtInTools(): Tool[] {
  return [
    readFile,
    writeFile,
    editFile,
    bash,
    grep,
    glob,
    listDir,
    spawnAgent,
    webFetch,
    webSearch,
  ];
}

export function builtInRegistry(): ToolRegistry {
  return makeRegistry(builtInTools());
}

/**
 * Combine the built-in tools with an arbitrary set of dynamically-registered
 * tools (currently MCP). Conflicts are resolved in favor of the dynamic set
 * because MCP tool names are namespaced and shouldn't collide with built-ins
 * — but if they do, the user-configured tool wins.
 */
export function combinedRegistry(extra: Tool[]): ToolRegistry {
  return makeRegistry([...builtInTools(), ...extra]);
}
