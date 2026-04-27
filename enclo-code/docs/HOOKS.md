# Hooks — lifecycle shell commands

Hooks are user-defined shell commands that fire at specific moments in
enclo's agent loop. They let you enforce policy (block writes outside a
directory), automate side effects (run a formatter after every write,
append to an audit log), or steer the model (force another iteration if
tests still fail).

## Quick start

1. Drop a config file at one of these locations (project takes precedence
   per-event):
   - `~/.enclo/hooks.json` — user-global, applies everywhere.
   - `<cwd>/.enclo/hooks.json` — per-project overrides.
2. Run `/hooks` to confirm enclo loaded what you wrote.
3. Run `/reload-hooks` after editing the config — no restart needed.

Each hook is a `/bin/sh -lc "<command>"` invocation. The hook's exit code
controls what enclo does next (see [Exit codes](#exit-codes)). Stdin
receives a JSON payload describing the event; selected fields are also
exposed as environment variables for one-line shell hooks.

## Config schema

```jsonc
{
  "<EventName>": [
    {
      "matcher": {                       // optional; AND-combined
        "tool": "write_file",            // exact tool name
        "path_glob": "src/**/*.ts",      // glob against the tool's path arg
        "command_pattern": "^rm\\s+-rf"  // regex; bash tool only
      },
      "command": "prettier --check $TOOL_PATH",
      "timeout_ms": 30000                // default 30s, capped at 5min
    }
  ]
}
```

All matcher fields are optional; an absent matcher matches every event.
Multiple hooks under the same event run sequentially in declaration
order. The first hook that returns a blocking exit short-circuits the
rest for that event.

Project-level hooks **replace** the user-level list for that event (they
do not concatenate) — this lets a project disable a global hook by
declaring an empty array.

## Events

| Event              | Fires when                                       | Can block? |
| ------------------ | ------------------------------------------------ | ---------- |
| `SessionStart`     | First user prompt of the session                 | no         |
| `UserPromptSubmit` | A new user message is about to be sent           | yes        |
| `PreToolUse`       | Before the permission check + tool execute       | yes        |
| `PostToolUse`      | Right after a tool returns its result            | no (warn)  |
| `Stop`             | Model is about to finish without a tool call     | yes        |
| `SubagentStop`     | A `spawn_agent` child completed                  | no         |
| `SessionEnd`       | App is unmounting (`/exit` or normal shutdown)   | no         |

## Stdin payloads

Every hook receives a single JSON object on stdin. The shape depends on
the event:

```jsonc
// PreToolUse / PostToolUse
{ "event": "PreToolUse",
  "tool_name": "write_file",
  "tool_args": { "path": "src/x.ts", "content": "…" },
  "cwd": "/abs/project" }

// PostToolUse adds:
{ "result": { "content": "…", "isError": false } }

// UserPromptSubmit
{ "event": "UserPromptSubmit", "prompt": "<the user's text>", "cwd": "…" }

// Stop / SubagentStop / SessionStart / SessionEnd
{ "event": "Stop", "reason": "stop", "cwd": "…" }
{ "event": "SubagentStop",
  "description": "search for callers", "final_text": "…", "is_error": false, "cwd": "…" }
{ "event": "SessionStart", "cwd": "…" }
{ "event": "SessionEnd",   "cwd": "…" }
```

## Environment variables

Common fields are also exposed as env vars so you don't need a JSON
parser for one-liners:

| Variable             | Set for                                  |
| -------------------- | ---------------------------------------- |
| `HOOK_EVENT`         | every hook                               |
| `HOOK_CWD`           | every hook                               |
| `TOOL_NAME`          | `PreToolUse` / `PostToolUse`             |
| `TOOL_ARGS_JSON`     | `PreToolUse` / `PostToolUse`             |
| `TOOL_PATH`          | when the tool has a `path` arg           |
| `TOOL_COMMAND`       | when `tool_name == "bash"`               |
| `TOOL_RESULT_IS_ERROR` | `PostToolUse` (`"0"` or `"1"`)         |
| `USER_PROMPT`        | `UserPromptSubmit`                       |
| `STOP_REASON`        | `Stop`                                   |
| `SUBAGENT_DESCRIPTION` | `SubagentStop`                         |
| `SUBAGENT_IS_ERROR`  | `SubagentStop` (`"0"` or `"1"`)          |

## Exit codes

| Exit | Meaning   | Effect                                                                                     |
| ---: | --------- | ------------------------------------------------------------------------------------------ |
| `0`  | continue  | Normal. If stdout is non-empty, its first line is shown as `🪝 hook: <line>` in chat.       |
| `2`  | block     | See per-event behavior below. Stdout becomes the block message visible to the user/model.  |
| any other | warn | Logged in chat as `⚠ hook failed (exit N)…`. The agent loop continues normally.           |

### Per-event blocking behavior

- **`PreToolUse` (block)** — the tool's `execute()` is skipped. The model
  receives a synthetic tool result `{ "error": "blocked_by_hook",
  "message": "<hook stdout>" }` instead.
- **`UserPromptSubmit` (block)** — the turn is dropped before any model
  call. A `🪝 prompt blocked by hook: <stdout>` notice is shown.
- **`Stop` (block)** — instead of finishing, the loop runs another
  iteration with a synthetic system message containing the hook's stdout
  (`Stop hook blocked completion. Reason: <stdout>. Continue working on
  the task.`). Use this to force the model to keep going until tests pass
  or coverage hits a threshold.
- **`PostToolUse` / `SubagentStop` / `SessionStart` / `SessionEnd`** —
  cannot block. Exit 2 is treated like any other warn.

Stdout is captured up to **16 KB** per hook; anything beyond is
truncated. Hooks that exceed `timeout_ms` (default `30_000`, max
`300_000`) are killed with `SIGTERM` then `SIGKILL`, and a warning is
shown in chat.

## Examples

### Auto-format any TypeScript file the agent writes

```jsonc
{
  "PostToolUse": [
    {
      "matcher": { "tool": "write_file", "path_glob": "**/*.ts" },
      "command": "prettier --write \"$TOOL_PATH\" >/dev/null && echo formatted $TOOL_PATH"
    }
  ]
}
```

### Append every tool call to an audit log

```jsonc
{
  "PostToolUse": [
    {
      "command": "echo \"$(date -Iseconds) $TOOL_NAME $TOOL_PATH\" >> ~/.enclo/audit.log"
    }
  ]
}
```

### Block destructive bash commands

```jsonc
{
  "PreToolUse": [
    {
      "matcher": { "tool": "bash", "command_pattern": "(?:^|\\s)rm\\s+-rf\\s+/" },
      "command": "echo refusing rm -rf /; exit 2"
    }
  ]
}
```

### Run tests on Stop, force another loop if they fail

```jsonc
{
  "Stop": [
    {
      "command": "npm test --silent >/tmp/enclo-test.log 2>&1 || { tail -n 20 /tmp/enclo-test.log; exit 2; }",
      "timeout_ms": 120000
    }
  ]
}
```

When the suite passes the hook exits 0 and enclo finishes the turn.
When it fails, exit 2 sends the failing tail back to the model as a
system message and the agent continues working on the bug.

## Slash commands

- `/hooks` — show the loaded config files and the hook count per event.
- `/reload-hooks` — re-read both files (project and user-global). Shows
  the new total and surfaces any parse errors.

## Troubleshooting

- **A hook didn't run.** Check `/hooks` — the count for the event must
  be ≥ 1, and parse errors are listed at the bottom. Project hooks
  *replace* user hooks per-event, so a project block with `[]` silences
  the user-global ones.
- **A `path_glob` didn't match.** Globs are anchored (`*.ts` matches
  `foo.ts` but not `src/foo.ts`; use `**/*.ts` for recursive). Globs
  match against the **raw** path arg the model sent — relative for
  relative paths, absolute for absolute. The bash tool has no path arg,
  so `path_glob` never matches it; use `command_pattern` instead.
- **A blocking Stop hook loops forever.** Hooks see the model's previous
  output via the synthetic system message; if your check never passes,
  the iteration cap (default 25) kicks in and surfaces an
  `agent_error`. Make the check eventually succeed, or add a sentinel
  the hook can read to disable itself.
