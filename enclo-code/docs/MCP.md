# MCP — Model Context Protocol

The [Model Context Protocol](https://modelcontextprotocol.io) is an open
JSON-RPC standard that lets a client (enclo) talk to external tool servers
(filesystems, databases, GitHub, custom in-house services) over a uniform
transport. enclo speaks MCP as a client: any server you configure shows up
as a set of tools the agent can call, sitting alongside the built-in
`bash`, `read_file`, `edit_file`, etc.

## Quick start

1. Drop a config file at one of these locations (project takes precedence):
   - `~/.enclo/mcp.json` — user-global, applies everywhere.
   - `<cwd>/.enclo/mcp.json` — per-project overrides.
2. Start enclo. You'll see one progress line per server:
   ```
   🔌 filesystem ✓ (4 tools)
   🔌 github     ✓ (12 tools)
   🔌 broken     ✗ (spawn npx ENOENT)
   ```
3. Run `/mcp` at any time to see status + the full list of registered tools.
4. Run `/reload-mcp` after editing the config to reconnect without restarting.

## Config schema

```jsonc
{
  "mcpServers": {
    "<name>": {
      // ---- stdio (subprocess) ----
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
      "env": { "EXTRA_VAR": "value" },
      "cwd": "/optional/working/dir",

      // ---- OR sse (remote) ----
      "url": "https://mcp.example.com/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

A server entry must specify either `command` (stdio) or `url` + `"transport":
"sse"`. Mixing the two is rejected at load time. `env` is merged on top of
the parent process environment for stdio servers.

### Merge semantics

User-global config is loaded first, then project config is merged on top.
Project entries with the same `<name>` shadow user-global ones — useful for
overriding a default with a per-repo variant (e.g. a project-specific
filesystem root).

A malformed file is reported on startup and skipped; valid files continue
to load. This means one bad project config can't break MCP for the whole
session.

## Sample servers

The MCP team maintains a catalog at https://modelcontextprotocol.io/examples
(plus community servers at https://github.com/modelcontextprotocol/servers).
A few useful starting points:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/mydb"]
    },
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "/Users/me/projects/foo"]
    }
  }
}
```

## How tool naming works

When a server is connected, enclo reads its `tools/list` response and
exposes each tool to the model under a deterministic prefixed name:

```
mcp__<server>__<tool>
```

For example, the `filesystem` server's `read_file` tool becomes
`mcp__filesystem__read_file`. The prefix:

- Prevents collisions with built-in tools and with tools from other
  MCP servers.
- Lets enclo's tool router send a call back to the right server based
  on the name alone.

When a server-side tool name itself contains underscores (e.g.
`list_pull_requests`), only the **first** `__` after the server name is
treated as the separator — `mcp__github__list_pull_requests` parses as
server `github`, tool `list_pull_requests`.

## Permission model

MCP tools are categorized as `exec` and require explicit user approval on
first use, just like `bash`. The first time the model calls
`mcp__github__create_issue`, you'll see the standard prompt with four
options:

```
Run mcp__github__create_issue?
  > allow once
    allow this tool for the session
    allow this exact target for the session
    deny
```

`allow this tool for the session` whitelists the prefixed name for the
remainder of the enclo session. Use `/allow` to inspect the session
allowlist or `/allow clear` to wipe it.

There is intentionally no way to "auto-approve all MCP tools" — the
model can call literally anything the server exposes, and you don't
necessarily want a remote `delete_repository` tool firing without a
prompt.

## Slash commands

| Command       | Effect                                                      |
| ------------- | ----------------------------------------------------------- |
| `/mcp`        | Show per-server status + every registered MCP tool.         |
| `/reload-mcp` | Re-read both config files, tear down old connections, reconnect. |

`/reload-mcp` is the right move after editing `mcp.json` — it does not
restart enclo or affect the conversation.

## Troubleshooting

**`spawn npx ENOENT`** — the `command` you specified isn't on `$PATH`.
Either use an absolute path (`/usr/local/bin/npx`) or make sure the
binary is reachable from the shell that launched enclo.

**`connect timed out after 15000ms`** — the server process started but
never completed the MCP handshake within 15s. For stdio servers, the most
common cause is a server that printed a Node deprecation warning to
stdout (corrupting the JSON-RPC stream); make sure the server only writes
JSON-RPC messages to stdout and logs to stderr.

**`schema mismatch`** under `⚠ mcp config:` — the JSON parsed but
doesn't match the expected shape. Double-check that each entry has either
`command` (stdio) or both `url` and `"transport": "sse"`. You can't mix
the two.

**SSE: no events, then a 401** — the `headers` block is sent on the
recurring POSTs *and* on the initial SSE GET. If your server requires
custom auth on the GET (instead of the default Bearer token flow),
verify it accepts the `Authorization` header on `text/event-stream`
requests as well.

**My server connects but `tools/list` returns nothing** — most MCP
servers gate their tool list behind a configuration step. For example,
`@modelcontextprotocol/server-filesystem` only exposes paths you list
on the command line. Read the server's README; misconfiguration is the
single most common reason for an empty tool list.

**Stale tools after editing the config** — config is loaded once at
session start. Run `/reload-mcp` to pick up changes. (Restarting enclo
also works.)

**Failed server keeps the others working** — by design. Each server's
connect runs in parallel and failures are reported per-server in
`/mcp` output; they never abort the session or prevent other servers
from connecting.

## Internals

- Implementation: `src/mcp/client.ts` (`McpManager` class).
- Config loader: `src/mcp/config.ts`.
- Types: `src/mcp/types.ts`.
- Wire-up: `src/app.tsx` constructs the manager, calls `start()` once
  per cwd change, and rebuilds the tool registry via `combinedRegistry`
  in `src/tools/index.ts` so MCP tools appear alongside built-ins.
- Lifecycle: `start()` connects every configured server in parallel.
  `stop()` is called automatically on App unmount and `/reload-mcp`
  (which is just `stop()` then `start()` against a fresh config read).
