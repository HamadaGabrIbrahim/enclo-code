/**
 * Tolerant argument readers for tools.
 *
 * Small local models (qwen2.5-coder, llama3.1) sometimes emit common
 * synonyms for the canonical field names — `file_path` instead of
 * `path`, `cmd` instead of `command`, etc. Each failed attempt costs
 * the user a permission prompt and a re-prompt round, so it's worth
 * accepting the common aliases and treating the canonical name as
 * preferred (still required in the JSON Schema; this is a runtime
 * tolerance, not a contract change).
 *
 * Keep the alias lists short and obvious — the goal is to recover
 * from a near-miss, not to legitimize loose schemas.
 */

const PATH_ALIASES = ["path", "file_path", "filepath", "filename", "file"] as const;
const COMMAND_ALIASES = ["command", "cmd", "bash_command"] as const;

/**
 * Pick the first non-empty string from `obj` matching any of `keys`.
 * Returns `undefined` when none match.
 */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Read a file path from a tool's arguments. Accepts common aliases. */
export function readPathArg(obj: Record<string, unknown>): string | undefined {
  return pickString(obj, PATH_ALIASES);
}

/** Read a shell command from a tool's arguments. Accepts common aliases. */
export function readCommandArg(obj: Record<string, unknown>): string | undefined {
  return pickString(obj, COMMAND_ALIASES);
}
