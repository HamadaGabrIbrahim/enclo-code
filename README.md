# enclo-cli

Terminal coding **agent** for self-hosted enclo. A TypeScript + Ink TUI
that talks to a local [`enclo-api`](#pairing-with-the-api) server. Runs the
agent loop locally — read files, edit them, search, run shell — with a
permission prompt before every write or exec, so your code never leaves
the LAN.

- Node 20+, TypeScript, React + Ink
- Built-in tools: `read_file`, `write_file`, `edit_file`, `bash`, `grep`,
  `glob`, `list_dir`, `spawn_agent`, `web_fetch`, `web_search`
- Plan mode (Shift-Tab / `/plan`), vision attachments (`/image`,
  Cmd-V / Ctrl-V clipboard paste)
- Project context via `enclo.md` (walks upward, `/context` /
  `/reload-context`), `@file` references in prompts (glob, 5 / 100 KB caps)
- Live token + optional cost display; `/history` + `/resume <id>` to
  rehydrate past conversations; auto-compaction at 70 % context
- Custom slash commands (`.enclo/commands/*.md`), custom subagents
  (`.enclo/agents/*.md`), 7-event hooks subsystem (`~/.enclo/hooks.json`),
  MCP client over stdio + SSE (`~/.enclo/mcp.json`)
- Persisted permission allowlist (`~/.enclo/permissions.json`,
  project override at `<repo>/.enclo/permissions.json`); deny-wins ordering
- `web_fetch` (SSRF-protected) and `web_search` (Brave / Serper / Tavily /
  Google CSE; DuckDuckGo HTML scrape fallback)

## What this is

A terminal client for a self-hosted backend. The CLI doesn't call any
third-party LLM API on its own — every chat goes through your `enclo-api`
server, which routes to whatever local model registry you've set up.

The full agent surface (tool list, permission UX, system prompt, custom
commands / subagents / hooks / MCP) is documented in
[`AGENTIC_GUIDE.md`](./AGENTIC_GUIDE.md).

## Install on macOS / Linux

You need Node 20+ on your PATH. Then:

```bash
git clone <this-repo-url> enclo-cli
cd enclo-cli
./install.sh
```

`install.sh` builds the workspace (`@enclo/core` then `enclo-code`) and
runs `npm link` so the `enclo` binary lands on your PATH.

```bash
enclo
```

On first run the CLI prompts for the API URL, then `/signup` (or
`/signin` if you already have an account on that server).

### Connect to your enclo server

When the CLI prompts for an API URL:

- **Local development on the same machine:** `http://localhost:8000`
- **Backend on an institute server / lab box:** `http://<server-ip>:8000`
  (the `enclo-api` install script prints the LAN URLs at the end of its
  run).

The URL is stored in `~/.enclo/config.json` (mode `0600`). To point at a
different server, either delete that file (`rm -rf ~/.enclo` clears
everything) or hand-edit the `api_url` field and `/signin` again.

## Slash commands

| Command | What it does |
|---|---|
| `/signup` | Interactive signup against the configured server. |
| `/signin` | Interactive signin against the configured server. |
| `/signout` | Calls `/auth/signout` and clears tokens from config. |
| `/models` | Lists available models from `/v1/models`, lets you pick one, persists `active_model`. |
| `/tools` | Lists available tools and their permission categories. |
| `/allow` | Show or manage session + persisted (user + project) permissions. Subcommands: `clear`, `clear-persisted`, `add <tool> [target]`, `remove <tool> [target]`, `deny <tool> [target]`. |
| `/cd` | Change the working directory used by tools on subsequent turns. |
| `/plan` | Toggle plan mode (read-only thinking — write/exec tools are denied). **Shift-Tab** is an alias. |
| `/image` | Attach an image (`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`, ≤5 MB) to the next message. Cmd-V / Ctrl-V on the input pastes a clipboard PNG. |
| `/context` | Print the resolved path, byte size, and full content of the loaded `enclo.md` project context. |
| `/reload-context` | Re-read `enclo.md` from disk after editing it. |
| `/history` (alias `/list`) | List recent conversations from the server. |
| `/resume <id-prefix>` | Restore a past conversation including assistant `tool_calls`, `role:"tool"` results, and multi-modal `content_parts`. |
| `/reload-commands` | Re-scan custom slash commands. |
| `/agents` | List loaded custom subagents. |
| `/reload-agents` | Re-scan custom subagents. |
| `/hooks` | List loaded hooks per event. |
| `/reload-hooks` | Re-read hooks config. |
| `/mcp` | Show MCP server status and registered tools. |
| `/reload-mcp` | Reconnect MCP servers. |
| `/clear` | Clears the on-screen conversation (next message starts a new `conversation_id`). |
| `/help` | Lists commands (built-ins + user-defined). |
| `/exit` | Quit. |

Anything that doesn't begin with `/` is sent as a chat message and runs
through the agent loop.

## Configuration

Per-user state lives under `~/.enclo/` (mode `0700`). Each file is
optional — the CLI works out of the box without any of them.

| Path | Purpose |
|---|---|
| `~/.enclo/config.json` | API URL, access + refresh tokens, active model. Mode `0600`. |
| `~/.enclo/permissions.json` | Persisted permission allowlist (allow / deny rules). Mode `0600`. |
| `~/.enclo/hooks.json` | Shell hooks bound to the 7 lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`). |
| `~/.enclo/mcp.json` | MCP server registry (stdio + SSE transports). |
| `~/.enclo/commands/<name>.md` | User-defined slash commands. Frontmatter tunes description / argument-hint / model / tool allowlist; the body is the prompt with `$ARGUMENTS` / `$1` / `$CWD` substitution. |
| `~/.enclo/agents/<name>.md` | User-defined subagents callable via `spawn_agent(subagent_type: "<name>", ...)`. |
| `~/.enclo/web-search.json` | Web-search provider config (used as fallback when no `WEB_SEARCH_*` env vars are set). |

Project-scoped overrides live at `<repo>/.enclo/...` and follow the same
schemas. The loader walks upward from `cwd` and merges what it finds;
project rules override user rules on conflicting keys, and **persisted
denies always beat allows** so a teaching repo can ship `bash:rm` denied
and know nobody can session-allow past it.

## Project context (`enclo.md`)

Drop a markdown file at the repo root (or `.enclo/enclo.md`) and
`enclo-code` loads it as a second `system` message every turn. 50 KB
cap; walks upward from cwd. Audit with `/context`, refresh after editing
with `/reload-context`. Full reference + examples in
[`AGENTIC_GUIDE.md`](./AGENTIC_GUIDE.md#project-context-enclomd).

## Adding custom commands / subagents / hooks / MCP

**Custom slash command** — `~/.enclo/commands/triage.md`:

```markdown
---
description: Triage an issue
argument-hint: <issue-number>
---
Look at issue $1 in the current repo. Summarize root cause and propose a fix.
```

After saving, `/reload-commands` then `/triage 1234` runs it.

**Custom subagent** — `~/.enclo/agents/researcher.md`:

```markdown
---
description: Read-only deep dive
tools: read_file,grep,glob,list_dir,web_fetch,web_search
---
You are a careful researcher. Investigate the question without touching the
filesystem; return a concise report with citations.
```

The model can then call `spawn_agent(subagent_type: "researcher", task: "...")`.

**Hook** — `~/.enclo/hooks.json`:

```json
{
  "PostToolUse": [
    { "matcher": { "tool": "edit_file" }, "command": "prettier --write $TOOL_RESULT_PATH" }
  ]
}
```

Auto-formats every edited file. Exit `0` continues, `2` blocks, anything
else warns.

**MCP server** — `~/.enclo/mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

Tools land prefixed as `mcp__filesystem__<tool>` and default to
permission-required. `/reload-mcp` after editing.

Full schemas + advanced patterns: [`AGENTIC_GUIDE.md`](./AGENTIC_GUIDE.md).

## Upgrade

```bash
./scripts/upgrade.sh
```

Pulls the latest code, rebuilds `@enclo/core` and `enclo-code`, and
re-links the `enclo` binary. Your `~/.enclo/` config is untouched.

## Uninstall

```bash
./uninstall.sh
```

Removes the global `enclo` symlink. To also wipe your saved tokens and
config: `rm -rf ~/.enclo`.

## Pairing with the API

The backend lives in a separate repo: `enclo-api` (Python + FastAPI +
Postgres + Ollama). Install it on a Linux server with a GPU (or
locally on a Mac for development):

- Backend repo (placeholder URL — replace once published):
  https://github.com/enclo/enclo-api

Once the API is running, paste its URL into the CLI's first-run prompt.

## Tests

```bash
npm test               # one-shot
npm run test:watch     # watch mode
npm run typecheck      # tsc --noEmit
```
