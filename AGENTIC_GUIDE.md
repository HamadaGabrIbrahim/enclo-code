# enclo Agentic Guide

This guide covers what changed when `enclo-code` became an agent, how the
agent loop works, what tools ship by default, the permission UX, the system
prompt, how enclo compares to Claude Code, how to add new tools, and the
known limitations of the current build.

---

## What changed

`enclo-code` used to be a chat client: you typed, the model answered, end of
turn. It is now an **agent**: the model can call tools to read your files,
edit them, search your repo, and run shell commands, then react to the
results — all in one turn — until the task is done.

Concretely:
- The CLI sends a `tools` schema with every chat request.
- The server (`enclo-api`) forwards that schema verbatim to vLLM/Ollama and
  forwards the model's tool calls back as a new SSE event type
  (`tool_call_delta`).
- The CLI executes those tool calls locally, prompts the user for permission
  when needed, and replays the results to the model as `role:"tool"`
  messages, looping until the model returns plain text or hits the turn cap.

No part of this changes how `enclo-api` is deployed — the only schema/DB
change is one Alembic migration (`0002_tool_calls.py`) adding `tool_call_id`
and `tool_calls` columns to `messages`.

---

## The agent loop

```
                   +----------------------+
        you  ----> | user message         |
                   +----------+-----------+
                              |
                              v
                   +----------------------+
                   |   model (server)     |
                   +----+--------+--------+
                        |        |
        text reply <----+        +----> tool_calls (one or many)
                                            |
                                            v
                              +----------------------------+
                              | enclo-code agent loop      |
                              | - permission prompt        |
                              | - execute tool locally     |
                              | - render result inline     |
                              +-------------+--------------+
                                            |
                                            v
                              +----------------------------+
                              | role:"tool" reply messages |
                              +-------------+--------------+
                                            |
                                            v
                                       (back to model)
```

In code, the loop lives in `enclo-code/src/agent/loop.ts` and runs until one
of three things happens:
1. The model finishes a turn with `finish_reason: "stop"` (no tool calls).
2. A tool call is denied by the user (the loop ends gracefully and the model
   sees an explanatory tool result).
3. A safety cap on iterations is hit — currently 25 model calls per turn —
   to avoid runaway loops on a misbehaving model.

Each model call uses the full message history including all prior
`role:"tool"` results. The CLI keeps the history in memory; the server
persists every assistant turn (including the `tool_calls` JSON) and every
tool reply (with its `tool_call_id`) so re-opening a conversation
reconstructs the full agentic context.

---

## Built-in tools

| Name         | Category | What it does                                                            | Needs permission?           |
|--------------|----------|--------------------------------------------------------------------------|------------------------------|
| `read_file`  | read     | Read a file from disk and return its contents                            | No (auto-allowed)            |
| `list_dir`   | read     | List the entries of a directory                                          | No (auto-allowed)            |
| `glob`       | read     | Find files matching a glob pattern                                       | No (auto-allowed)            |
| `grep`       | read     | Search file contents with a regex                                        | No (auto-allowed)            |
| `write_file` | write    | Create a new file or replace an existing one                             | Yes                          |
| `edit_file`  | write    | Apply an exact-string substitution to an existing file                   | Yes                          |
| `bash`       | exec     | Run a shell command in the active working directory                      | Yes                          |
| `web_fetch`  | exec     | Fetch a public URL, convert HTML→markdown, summarize via the active model | Yes                          |
| `web_search` | exec     | Search the web (Brave / Serper / Tavily / Google CSE, DDG fallback)      | Yes                          |
| `spawn_agent`| meta     | Run a focused sub-agent on a scoped task; result returned as the tool reply | No (spawning is auto-allowed) |

Categories drive the default permission policy: anything in the `read`
category auto-runs without a prompt; `write` and `exec` always prompt unless
pre-approved by the user (see below). `spawn_agent` itself is auto-allowed —
the *child* agent's tool calls are gated by the same permission layer, so
the parent can never use it to bypass approval. Source: `enclo-code/src/tools/`.

In **plan mode** (`/plan` or Shift-Tab) the `write` and `exec` categories are
denied automatically — see the dedicated section below.

`/tools` from the CLI prints the same table at runtime, so users can audit
exactly what their model is being told about.

---

## Permission UX

When the model calls a tool that is not auto-allowed and not pre-approved,
the CLI pauses the turn and shows a seven-option prompt:

```
+---------------------------------------------------------------+
|  enclo wants to: bash                                         |
|    command: npm test                                          |
|                                                               |
|  > Approve once                                               |
|    Allow for this session (bash)                              |
|    Allow for this session (this exact target)                 |
|    Allow forever (this tool, all sessions)                    |
|    Allow forever (this exact target, all sessions)            |
|    Deny forever (this tool)                                   |
|    Deny                                                       |
+---------------------------------------------------------------+
```

The seven options map to the scopes the permission manager understands
(see `enclo-code/src/agent/permissions.ts`):

| Choice                                                       | Scope                                                                         |
|--------------------------------------------------------------|--------------------------------------------------------------------------------|
| **Approve once**                                             | Just this call                                                                 |
| **Allow for this session (`<tool>`)**                        | Every future call to this tool, until restart                                  |
| **Allow for this session (this exact target)**               | Future session calls with the same target                                      |
| **Allow forever (this tool, all sessions)**                  | Persisted to `~/.enclo/permissions.json` — survives restart                    |
| **Allow forever (this exact target, all sessions)**          | Persisted at the target scope — survives restart                               |
| **Deny forever (this tool)**                                 | Persisted deny rule — beats all allows including auto-allow on read tools     |
| **Deny**                                                     | One-shot — tool result becomes "user denied", but rule is not remembered      |

"Target" means the resolved file path for `write_file`/`edit_file`/`read_file`,
the first whitespace-delimited token (the program) for `bash`, the URL host
for `web_fetch`/`web_search`, and the pattern for `grep`/`glob`. So choosing
"this exact target" on a `bash npm test` call allow-lists `bash:npm` — every
future `npm` invocation runs without prompting, but `bash rm -rf /` still
pops the prompt.

The three "forever" options write to the persisted rule store described in
[Persisted permissions](#persisted-permissions). Inspect, add, or remove
session and persisted rules with `/allow`.

---

## Persisted permissions

Choices 4–6 in the prompt above write rules to disk so they survive
restart. Rules live in two places:

- **User-global** — `~/.enclo/permissions.json` (created with mode `0700`
  on the directory and `0600` on the file, written atomically through a
  `.tmp` + `rename`).
- **Project-local** — `<repo>/.enclo/permissions.json`. The loader walks
  upward from cwd to the user's home dir and merges every
  `.enclo/permissions.json` it finds along the way. Project rules
  override user rules with the same `(tool, target, scope)` key.

The on-disk schema (`enclo-code/src/agent/permissions-storage.ts`):

```json
{
  "version": 1,
  "rules": [
    {
      "tool": "bash",
      "target": "git",
      "scope": "target",
      "effect": "allow",
      "grantedAt": "2026-04-26T20:11:00.000Z"
    },
    {
      "tool": "bash",
      "target": "rm",
      "scope": "target",
      "effect": "deny",
      "grantedAt": "2026-04-26T20:12:00.000Z"
    },
    {
      "tool": "web_fetch",
      "scope": "tool",
      "effect": "allow",
      "grantedAt": "2026-04-26T20:13:00.000Z"
    }
  ]
}
```

Field semantics:
- `tool` — the registered tool name (`bash`, `web_fetch`, `mcp__github__create_issue`, …).
- `target` — optional; matches the same "target" string the prompt uses
  (program for `bash`, file path for write/edit, URL host for web tools, …).
- `scope` — `"tool"` (any call to this tool) or `"target"` (only when the
  request's target matches).
- `effect` — `"allow"` or `"deny"`.
- `grantedAt` — ISO timestamp the rule was written.

**Persisted denies win over everything.** The check order in
`permissions.check()` is: persisted-deny → persisted-allow → session-allow
→ auto-allow (read tools). That ordering is deliberate: in shared or
teaching environments you can drop a project-level deny on `bash:rm` (or
`web_fetch` entirely) and know the model will be refused even if a student
later session-allows the tool. Auto-allow on read tools does **not** beat
a persisted deny either — useful for locking down `read_file` against a
secrets directory.

**Project beats user; inner project beats outer.** When the same
`(tool, target, scope)` key shows up in both the user file and a project
file, the project entry wins. When the same key shows up in nested
projects, the directory closest to cwd wins. This matches how `enclo.md`
context files merge.

### `/allow` subcommands

`/allow` with no argument prints the current session allows, persisted user
allows, persisted user denies, and any project rules (read-only — never
written from the CLI; edit `<repo>/.enclo/permissions.json` by hand to
share rules through git).

| Command                              | What it does                                                                  |
|--------------------------------------|-------------------------------------------------------------------------------|
| `/allow`                             | Render the grouped session + persisted rule table                              |
| `/allow clear`                       | Drop all session-only allows (does not touch the on-disk file)                |
| `/allow clear-persisted`             | Wipe the user file (`~/.enclo/permissions.json`); prompts `[Y/n]` first       |
| `/allow add <tool> [target]`         | Write a persisted user allow rule (target → `scope:"target"`, else `"tool"`)  |
| `/allow remove <tool> [target]`      | Remove the matching persisted user rule; no-op if nothing matches             |
| `/allow deny <tool> [target]`        | Write a persisted user deny rule                                              |

Examples:

```bash
/allow add bash git              # always-allow `bash git ...` without prompting
/allow add web_fetch             # always-allow web_fetch (any URL)
/allow deny bash rm              # never run `rm` — beats session allows
/allow deny web_search           # block web_search project-wide (in user file)
/allow remove bash git           # take it back
/allow clear-persisted           # nuke ~/.enclo/permissions.json (user rules only)
```

Project rules are not added through `/allow` — write them to
`<repo>/.enclo/permissions.json` and commit. Useful for a teaching
checkout that ships with `bash:rm` denied for everyone.

---

## Web tools (`web_fetch`, `web_search`)

Two exec-category tools let the model pull live information from the
public internet. Both default to `requiresPermission: true` — you have
to `/allow` them (or pick "Allow forever") before they run silently.

### `web_fetch`

Fetches a single HTTP/HTTPS URL, converts HTML to markdown via Turndown,
then asks the active model to answer the caller's `prompt` against that
content. Returns the model's concise answer with a `[source: <final-url>]`
footer.

Caps:
- 30-second per-request timeout
- 10 MB max response body (cuts the stream as it crosses the limit)
- 5 redirect hops max — each hop's resolved IP is re-validated
- Only `text/html`, `application/xhtml+xml`, and `text/plain`
  content-types are accepted; PDFs and images are refused

**SSRF protection.** Before each fetch (and again after every redirect)
the URL's hostname is DNS-resolved and the resolved IP is checked
against:

- IPv4 loopback / private / link-local / 0.0.0.0 ranges (`127.0.0.0/8`,
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
  `0.0.0.0/8`)
- IPv6 loopback (`::1`), unspecified (`::`), link-local (`fe80::/10`),
  ULA (`fc00::/7`)
- The cloud metadata literal `169.254.169.254` (also caught by
  link-local) — relevant on AWS / GCP / Azure VMs
- The hostname blocklist `localhost`, `metadata.google.internal`,
  `metadata.azure.com`

If a hostname resolves into a blocked range — or the URL contains an IP
in a blocked range directly — the call returns an error before any
network traffic leaves the machine. Schemes other than `http://` and
`https://` are rejected up front.

**Caching.** Successful fetches cache for 15 minutes, keyed by the
originally-requested URL (so callers asking different `prompt`s about
the same page hit the same cached markdown). The cache is in-process —
restart the CLI to clear it. The result indicates `(cached)` in the
source footer when the cache served the markdown.

**No model fallback.** If the agent context has no model attached
(test environments), `web_fetch` returns the raw markdown rather than
failing.

### `web_search`

Searches the web and returns a ranked list of `{title, url, snippet}`
results. Provider is chosen in priority order:

1. **Environment variables** — `WEB_SEARCH_PROVIDER` (one of
   `brave`, `serper`, `tavily`, `google`) plus `WEB_SEARCH_API_KEY`.
   For Google CSE also set `WEB_SEARCH_CX` (the Custom Search engine ID).
2. **`~/.enclo/web-search.json`** — same shape (see below).
3. **DuckDuckGo HTML scrape** — best-effort fallback that hits
   `https://html.duckduckgo.com/html/` and parses the no-JS rendering.
   If DDG changes their HTML the fallback returns an empty list rather
   than throwing — treat it as "no results found" not "tool broken."

Sample `~/.enclo/web-search.json`:

```json
{
  "provider": "brave",
  "api_key": "YOUR_BRAVE_KEY"
}
```

For Google CSE, add the engine id:

```json
{
  "provider": "google",
  "api_key": "YOUR_GOOGLE_API_KEY",
  "cx": "YOUR_CUSTOM_SEARCH_ENGINE_ID"
}
```

Optional arguments to the tool itself:
- `max_results` — default 10, hard cap 20
- `allowed_domains` — only return results whose hostname matches one
  of these (subdomain match, so `nytimes.com` matches `www.nytimes.com`)
- `blocked_domains` — exclude results whose hostname matches one of these

A sample config ships at the repo root as
[`web-search.example.json`](../web-search.example.json) — copy it to
`~/.enclo/web-search.json` and fill in your key.

---

## System prompt

The default system prompt is short on purpose — most tool-using models
don't need much hand-holding once they see the tool schemas.

```
You are enclo, an AI coding assistant. You help with software engineering
tasks on the user's machine.

Working directory: {{CWD}}
Available tools: {{TOOLS}}

Use tools to read/write files and run commands rather than guessing or asking
the user to paste content. Prefer reading files before editing them. Use grep
and glob to find code rather than listing directories.

Edits must be surgical — use edit_file with exact strings rather than
write_file for changes to existing files. write_file is for new files only.

When the task is complete, give a brief summary. Do not narrate every tool
call; the user can see them.
```

`{{CWD}}` and `{{TOOLS}}` are template placeholders that get filled at
runtime (`enclo-code/src/agent/system-prompt.ts`).

To override, write your own template to `~/.enclo/system-prompt.md`. Both
placeholders are honored if present; if you omit them the model just won't
see the cwd or tool list in the prompt (it still sees the tools schema in
the request itself).

```bash
mkdir -p ~/.enclo
cat > ~/.enclo/system-prompt.md <<'EOF'
You are a senior staff engineer pairing with the user.
Working directory: {{CWD}}
Tools: {{TOOLS}}

Always run the tests before reporting a change as complete.
EOF
```

---

## Plan mode

Plan mode is a read-only thinking step before you let the agent touch the
filesystem or shell. Toggle it on, ask the model to lay out an approach,
review what it intends to do, then toggle it off and let the loop execute.

**How to enter:** press **Shift-Tab** at the input prompt, or type **`/plan`**
on its own line. Both flip the same flag. The header gets a magenta banner
to make the state obvious:

```
+-------------------------------------------------------------------+
|  enclo   http://localhost:8000     you@example.com  model: gemma  |
+-------------------------------------------------------------------+
+-------------------------------------------------------------------+
|  [PLAN MODE]   write/exec tools disabled — Shift-Tab or /plan to  |
|                toggle                                             |
+-------------------------------------------------------------------+
```

**What is blocked while plan mode is on:**
- `write_file` — denied by the permission layer
- `edit_file`  — denied
- `bash`       — denied

The agent loop sees these as `user denied` tool results, so the model is
told plainly that it cannot mutate anything and almost always switches to
narrating a plan instead.

**What stays available:**
- `read_file`, `list_dir`, `glob`, `grep` — read-category tools auto-run
  exactly as in normal mode

**Toggling off mid-conversation:** the second time you press Shift-Tab (or
type `/plan`) while plan mode is on, the CLI shows a one-shot confirmation
notice — *"Plan mode: OFF — execution approved for next turn."* — and
clears the flag. The next chat turn runs with full tool access. If you
press Shift-Tab again before sending anything, you cancel the exit and
stay in plan mode.

**When to use it:**
- Before kicking off a large change in a codebase you don't fully know yet
- When the user asks "what would you do here?" instead of "do it"
- As a sanity check before letting a smaller open-weight model loose on
  `bash` (the model often plans better than it executes)

Implementation: `enclo-code/src/app.tsx` (state + Shift-Tab handler),
`enclo-code/src/agent/permissions.ts` (the deny path), and
`enclo-code/src/components/Header.tsx` (banner).

---

## Vision

enclo-code can attach images to a message and route them through the
multi-modal `content` schema documented in `ARCHITECTURE.md`.

**How to attach:** at the input prompt, run

```
/image ./screenshot.png
```

before sending your message. The CLI reads the file, base64-encodes it,
and pins a chip to the input strip — for example
`[image: screenshot.png 184 KB]`. You can attach multiple images; each
`/image` call adds another chip. The next message you send carries the
attachments as `image_url` blocks alongside your text.

**Supported formats:** `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`. Anything
else is rejected client-side before the request is built. Mime mapping
lives in `enclo-code/src/commands/image.ts`.

**Size caps:**
- **5 MB per file** — enforced in the CLI (`MAX_IMAGE_BYTES`). Bigger
  files print an error chip and are not attached.
- **10 MB total decoded bytes per message** — enforced server-side
  (`enclo-api`). Sending a few mid-sized images is fine; cramming a
  whole album into one turn is not. Oversized payloads return
  `422 validation_error`.

**Vision-capable model required.** The image blocks are forwarded
verbatim to the active model's backend; if the model doesn't understand
images you'll get a confused text answer (or sometimes an upstream
error). Pick a model in the registry that supports vision before sending:

| Tier            | Vision-capable entry            |
|-----------------|----------------------------------|
| `laptop-ollama` | `qwen2.5vl:7b` (or `llava-phi3:latest` fallback) |
| `single-gpu`    | `gemma-4-31b`                    |

Use `/models` to switch. Sending an image to a text-only model is not
prevented by the CLI — it's a "you'll get garbage out" warning, not a hard
block, because the registry doesn't yet carry a `vision: true` flag.

**Known limitation — history rendering:** when you scroll back, attached
images render as `[image: foo.png]` placeholders, not as actual images.
The terminal can't draw them inline, and we haven't wired up an external
viewer. The bytes are still on the server (in `messages.content_parts`),
so re-opening the conversation round-trips them losslessly to the model;
only the on-screen preview is degraded.

---

## Sub-agents

The `spawn_agent` tool lets the model fork a focused **child agent** with
its own conversation, run it to completion, and consume its final answer
as a tool result. It exists for work that would otherwise blow the parent
context budget or fan out into parallelizable chunks.

**What `spawn_agent` does:**
- Starts a brand-new agent loop with a system prompt scoped to the
  description the parent passed in (`"You are a sub-agent of enclo,
  focused on a specific task: <description>. ..."`)
- Inherits the parent's tool registry, minus `spawn_agent` itself by
  default (so children can't recursively spawn unless the parent
  explicitly allow-lists it)
- Runs until the child model returns a final text answer; that answer
  becomes the `spawn_agent` tool result the parent sees
- Renders nested in the TUI: the parent's transcript shows a collapsible
  block labelled with the child's `description`, and the child's tool
  calls + outputs stream inside it

**When to use it:**
- Large investigations where the intermediate scratch (file contents,
  grep hits, build logs) would burn the parent's context window
- Independent sub-tasks the parent can fan out (e.g. "audit each of
  these three modules for X")
- Anything where you'd otherwise tell the user "let me start a fresh
  conversation to look at Y"

**Caps and limits:**
- **Max sub-agent depth: 3.** The root conversation is depth 0; a child
  spawned from root is depth 1; etc. Going deeper returns
  `spawn_agent: maximum sub-agent depth (3) reached` as the tool error.
- **Iteration cap per sub-agent: 15** (`SUB_AGENT_MAX_ITERATIONS`). The
  root agent's cap is 25 (`DEFAULT_MAX_ITERATIONS`). If the child hits
  its cap, it surfaces what it has and the parent decides what to do.
- **Permission inheritance — v1 limitation.** The sub-agent shares the
  parent's session permission allowlist. If you have already approved
  `bash:npm` in the parent, the child can run `npm` without prompting.
  This is intentional for ergonomics in v1 but means a child cannot be
  confined to a stricter policy than its parent — track this if you spawn
  agents that handle untrusted inputs.

Implementation: `enclo-code/src/tools/spawn_agent.ts` (the tool itself,
including the `MAX_DEPTH` constant) and `enclo-code/src/agent/loop.ts`
(the recursive `runAgent` entry point, the iteration cap, and the
nested-render event flushing).

---

## Project context (`enclo.md`)

`enclo.md` is the project's analogue of Claude Code's `CLAUDE.md`: a small
markdown file that gets loaded as a **second `system` message** on every
turn so the model knows the stack, conventions, and entry points without
the user having to repeat them.

**Where it lives.** On startup, `enclo-code` walks upward from the current
working directory looking for either `enclo.md` at a directory root or
`.enclo/enclo.md` inside one (project-local override). The first match
wins. If nothing is found, the agent runs without project context — same
as today.

**Caps.** 50 KB hard cap; anything larger is truncated with a notice in
the footer. Big files defeat the purpose anyway — keep it scannable.

**Slash commands.**
- `/context` — print the resolved path, byte size, and full content of
  the loaded `enclo.md` so you can audit what the model is being told.
- `/reload-context` — re-read the file from disk after editing it
  in-session. The next turn picks up the change; in-flight turns are not
  affected.

**Sample minimal `enclo.md`:**

```markdown
# my-app

- Stack: Go 1.22, Postgres, sqlc.
- Conventions: errors are wrapped with `fmt.Errorf("%w", err)`; no panics
  in HTTP handlers; SQL lives in `internal/db/queries/*.sql`.
- Tests: `go test ./...` from the repo root; integration tests need
  `docker compose up -d db`.
- Entry point: `cmd/server/main.go`.
```

Implementation: `enclo-code/src/context/enclo-md.ts` (loader + walk),
`enclo-code/src/commands/context.ts` (`/context`, `/reload-context`).

---

## `@file` references

Typing `@<path>` anywhere in a prompt expands inline to the file's
contents before the message is sent to the model. The point is to skip
the round-trip of the model issuing `read_file` and waiting for the
result — when *you* already know which files are relevant, paste them in
once and let the model reason.

```
explain the streaming protocol — see @enclo-api/src/enclo_api/routers/chat.py
                                  and @ARCHITECTURE.md
```

**Glob support.** `@src/**/*.ts` expands to every match. Useful for
"audit all the tool definitions" style prompts:

```
@enclo-code/src/tools/*.ts  — which of these need to be denied in plan mode?
```

**Caps.** 5 files per message, 100 KB per file. Beyond that the
expansion is dropped with a `[truncated: too many files]` notice — paste
fewer paths or use `read_file` from inside the loop instead.

**When the *model* says it.** If a model response contains `@x.ts`, the
CLI expands it in the **next** user turn the same way. So a back-and-forth
like *"look at @parser.ts"* → *"@parser.ts"* gets you the file inlined
without an extra tool call. Big productivity win for "explain this
function" / "how do these two files interact" prompts.

Implementation: `enclo-code/src/input/file-refs.ts` (parser + glob +
caps), wired into the input pipeline in `enclo-code/src/app.tsx`.

---

## Clipboard image paste

Press **Cmd-V** (macOS) or **Ctrl-V** (Linux/Windows) at the input
prompt. If the system clipboard contains an image, the CLI attaches it
to the next message exactly as if you had run `/image <path>`; if the
clipboard is text, the keystroke falls through to a normal text paste.

- **Format:** PNG only. Other clipboard image formats are ignored.
- **Cap:** 5 MB per image (same as `/image`).
- **Vision-capable model required.** No different from `/image`: the
  attachment is forwarded to the active backend; if the model is
  text-only you'll get a confused reply.

Implementation: `enclo-code/src/input/clipboard.ts` (per-OS shell-out:
`pngpaste` / `xclip` / `powershell.exe Get-Clipboard`), input handler in
`enclo-code/src/components/Input.tsx`.

---

## Token / cost display

The Footer shows live token usage for the current conversation:

```
Tokens: 1,204 in / 318 out · 19% context
```

The numbers come from `GET /v1/conversations/{id}/usage` and are
refreshed after every assistant turn.

**Color thresholds for the percentage:**
- 0–60% — default
- 60–80% — yellow
- 80–100% — red (this is the cue to `/compact` or `/clear`)

The percentage is `(prompt_tokens + completion_tokens) / model.context_length`,
where `context_length` comes from `/v1/models`.

**Optional dollar-cost display.** Off by default. Add a `cost` block to
`~/.enclo/config.json` to opt in:

```json
{
  "cost": {
    "enabled": true,
    "per_million_input_tokens": 0.20,
    "per_million_output_tokens": 0.60
  }
}
```

Costs are CLI-side estimates — `enclo-api` does not bill anything; the
prices are whatever you punch in. Reset by `/clear` (new conversation
starts at 0) and by `/signout` (config is rewritten without tokens, but
the `cost` block is preserved).

Implementation: `enclo-code/src/components/Footer.tsx` (rendering +
thresholds), `enclo-code/src/api/usage.ts` (polling).

---

## Conversation resume + auto-compaction

**`/history`** (alias **`/list`**) prints the user's recent
conversations from `GET /v1/conversations`, newest first, each line
showing id prefix, model, message count, and updated-at:

```
> /history
  c4f3a1…  llama-3.1-8b-instruct   24 msgs   2026-04-26 14:02
  9b21ee…  qwen2.5-coder-7b         8 msgs   2026-04-25 19:51
  ...
```

**`/resume <id-prefix>`** loads the chosen conversation and continues
it: the CLI fetches `GET /v1/conversations/{id}` and rehydrates the
in-memory transcript including assistant `tool_calls`, `role:"tool"`
results (with their `tool_call_id` linkage), and multi-modal
`content_parts` blocks. The next message you send goes through with the
existing `conversation_id`, so server-side history continues unbroken.
You can resume across `enclo` restarts, across machines, anywhere your
tokens take you.

**Auto-compaction.** When the live context usage crosses **70 %** of the
model's `context_length`, the CLI automatically calls
`POST /v1/conversations/{id}/compact` *before* the next turn, replaces
the oldest messages with a single `role:"system"` summary, and surfaces
a one-line success notice in the transcript:

```
* compacted 14 messages → summary (saved ~11k tokens)
```

If the API returns `compact_unavailable` (conversation too short to
compact) or any other error, the CLI disables auto-compaction for the
rest of the session and prints a one-shot warning — it will not retry
on every turn.

The threshold is configurable per-user:

```json
{ "compact_threshold": 0.7 }
```

Set to `1.0` to disable entirely. Manual `/compact` always works
regardless of the threshold.

Implementation: `enclo-code/src/commands/history.ts` and `resume.ts`,
`enclo-code/src/agent/auto-compact.ts`,
`enclo-api/src/enclo_api/routers/conversations.py` (server side).

---

## Custom slash commands

User-defined slash commands let you bind a name (e.g. `/triage`) to a
parameterized prompt that gets sent to the model with light substitution.
Useful for codifying repeated workflows ("review this diff for security
issues", "explain the failing test in $1").

**Where files go.** enclo merges two directories on startup:

- `~/.enclo/commands/*.md` — user-global, available in every project.
- `<cwd>/.enclo/commands/*.md` — project-local, walks upward like
  `enclo.md`. Project commands shadow user commands of the same name.

The filename (without `.md`) becomes the command. So
`~/.enclo/commands/triage.md` is invoked as `/triage`.

**Built-ins always win.** A user command with the same name as a built-in
slash command (`/help`, `/models`, `/plan`, etc.) is ignored with a
warning at load time — built-ins are not overridable in v1. Run
`/reload-commands` to re-scan both directories after editing.

**Frontmatter.** Optional YAML front matter tunes execution:

```markdown
---
description: Triage a failing test and propose a fix
argument-hint: <test-file-path>
model: qwen2.5-coder-7b
allowed-tools: [read_file, grep, glob, bash]
---
You are debugging a failing test. The user supplied: $ARGUMENTS

Working directory: $CWD

1. Read $1 and identify the assertion that's failing.
2. Use grep / read_file to find the production code under test.
3. Propose a minimal fix and explain *why* it fixes the symptom.
```

| Field           | Effect                                                                          |
|-----------------|----------------------------------------------------------------------------------|
| `description`   | Shown by `/help` and the autocomplete dropdown.                                  |
| `argument-hint` | Inline hint rendered next to the command in autocomplete.                        |
| `model`         | Overrides the active model for just this turn (still subject to `/v1/models`).   |
| `allowed-tools` | Restricts the tool schema for this turn — useful for read-only review commands.  |

**Substitutions.** Before the body is sent, enclo replaces:

- `$ARGUMENTS` — everything the user typed after the command name.
- `$1`, `$2`, … — whitespace-split positional args.
- `$CWD` — the current working directory.

Unmatched placeholders are left literal (so the model sees them and can
ask). Substitution is plain text replacement — there is no shell
interpolation, so user input cannot break out of the prompt.

**Slash commands shipped to manage them:** `/reload-commands` re-reads
both directories. The autocomplete dropdown surfaces the merged set on
every `/`-prefix.

Implementation: `enclo-code/src/commands/custom-loader.ts` (loader +
merge), `enclo-code/src/commands/registry.ts` (precedence), and
`enclo-code/src/commands/reload-commands.ts`.

---

## Custom subagents

Custom subagents extend the built-in `spawn_agent` tool with named,
pre-configured personas. Instead of the parent model passing a free-form
`description`, it can call
`spawn_agent(subagent_type: "code-reviewer", task: "review the diff")`
and enclo loads the matching subagent definition from disk.

**Where files go.** Same pattern as slash commands:

- `~/.enclo/agents/*.md` — user-global.
- `<cwd>/.enclo/agents/*.md` — project-local; project shadows user.

The filename (without `.md`) is the subagent's `name` (also
overridable via frontmatter).

**Frontmatter.**

```markdown
---
name: code-reviewer
description: Reviews a diff for correctness, style, and obvious bugs
tools: [read_file, grep, glob]
model: qwen2.5-coder-7b
---
You are a senior code reviewer. The user (the parent agent) will hand you
a task. Your job:

1. Read every file mentioned in the task.
2. Look for: missing error handling, off-by-one errors, hardcoded paths,
   silently swallowed exceptions.
3. Reply with a numbered list of findings, each with a file:line ref and
   a 1-2 sentence explanation. No filler.
```

| Field         | Effect                                                                              |
|---------------|--------------------------------------------------------------------------------------|
| `name`        | The string the parent passes as `subagent_type`.                                     |
| `description` | Shown in the `spawn_agent` tool schema so the parent model knows when to use it.     |
| `tools`       | Restricts the child's tool registry. Omit to inherit the parent's tools (minus `spawn_agent`). |
| `model`       | Overrides the model for the child loop only.                                         |

**How it's invoked.** When the parent calls
`spawn_agent(subagent_type: "code-reviewer", task: "...")`, enclo:

1. Looks up `code-reviewer` in the merged registry.
2. Builds a fresh agent loop with the body of `code-reviewer.md` as the
   system prompt and `task` as the first user message.
3. Restricts the tool registry per `tools:` (if specified).
4. Runs the child to completion (depth + iter caps from the Sub-agents
   section still apply).
5. Returns the child's final answer to the parent as the `spawn_agent`
   tool result.

If the named subagent doesn't exist, the tool returns an error result
("unknown subagent_type: code-reviewer"); the parent sees that and
typically falls back to a free-form `description`.

**Slash commands:** `/agents` lists what's loaded (name, description,
file path, scope user vs project); `/reload-agents` re-scans both
directories.

Implementation: `enclo-code/src/agents/custom-loader.ts`,
`enclo-code/src/tools/spawn_agent.ts` (subagent_type lookup),
`enclo-code/src/commands/agents.ts`.

---

## Hooks

Hooks are user-defined shell commands that fire at specific moments in
the agent loop — before/after tool calls, on user prompt submit, on
session start/end, when the model is about to stop. They let you enforce
policy ("block writes outside this directory"), automate side effects
("run `prettier` after every `write_file`"), or steer the model
("if tests still fail, prompt for another iteration").

**Config locations.** Same precedence pattern as MCP and custom commands:

- `~/.enclo/hooks.json` — user-global.
- `<cwd>/.enclo/hooks.json` — project-local; project entries **replace**
  the user list per-event (so a project can disable a global hook by
  declaring an empty array).

**Seven event types** — `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`.

**Exit code semantics:**

| Exit code | Meaning                                                              |
|-----------|----------------------------------------------------------------------|
| `0`       | Continue normally.                                                   |
| `2`       | Block the action (only honored on blocking events; see HOOKS.md).    |
| any other | Warn — the hook's stderr is shown but the action proceeds.           |

**Matchers** filter when a hook fires (tool name, path glob, command
regex). Stdin gets a JSON payload describing the event; selected fields
are also exposed as env vars (`$TOOL_PATH`, `$TOOL_NAME`, etc.) for
one-line shell hooks.

**Example use cases:**

- Auto-prettier on every TypeScript write:
  ```jsonc
  { "PostToolUse": [
      { "matcher": { "tool": "write_file", "path_glob": "**/*.ts" },
        "command": "prettier --write $TOOL_PATH" }
  ]}
  ```
- Audit log of every `bash` invocation:
  ```jsonc
  { "PreToolUse": [
      { "matcher": { "tool": "bash" },
        "command": "echo \"$(date -u +%FT%TZ)  $TOOL_ARGS\" >> ~/.enclo/audit.log" }
  ]}
  ```
- Run tests on `Stop` and force another iteration if they fail
  (exit 2 blocks the stop, returning control to the model).

`/hooks` lists what's loaded; `/reload-hooks` re-reads after edits — no
restart needed. Full reference (all seven events, payload shapes,
blocking vs warning, security notes) lives in
[`../enclo-code/docs/HOOKS.md`](../enclo-code/docs/HOOKS.md).

---

## MCP servers

The [Model Context Protocol](https://modelcontextprotocol.io) is an open
JSON-RPC standard that lets a client (enclo) talk to external tool
servers — filesystems, databases, GitHub, custom in-house services —
over a uniform transport. enclo speaks MCP as a **client**: any server
you configure shows up as a set of tools the agent can call, sitting
alongside the built-in `bash`, `read_file`, `edit_file`, etc.

**Config locations.**

- `~/.enclo/mcp.json` — user-global.
- `<cwd>/.enclo/mcp.json` — project-local; project entries with the same
  `<name>` shadow user-global ones.

**Two transports** are supported via `@modelcontextprotocol/sdk`:

- **stdio** — enclo spawns `command` with `args` and speaks JSON-RPC
  over its stdin/stdout. Standard for the MCP reference servers
  (`@modelcontextprotocol/server-filesystem`, `…server-github`,
  `…server-postgres`, etc.).
- **sse** — enclo connects to a remote `url` over Server-Sent Events.
  Useful for in-house MCP servers that already run as services.

**Sample servers** (drop into `~/.enclo/mcp.json`):

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
    }
  }
}
```

**Tool naming.** MCP tools are exposed to the model with a
`mcp__<server>__<tool>` prefix to avoid colliding with built-ins. So the
filesystem server's `read_file` shows up as `mcp__filesystem__read_file`
and is distinct from enclo's own `read_file`.

**Permissions.** Every MCP tool defaults to **permission required**
(treated like the `write` / `exec` categories). The 4-option permission
prompt fires the first time the model calls one; you can scope-allow per
server with `mcp__filesystem` or per tool with
`mcp__filesystem__read_file` from the prompt.

`/mcp` shows server status + the full list of registered tools;
`/reload-mcp` reconnects after editing the config without restarting.
Full reference (config schema, merge semantics, transport details,
security notes) lives in
[`../enclo-code/docs/MCP.md`](../enclo-code/docs/MCP.md).

---

## Editor extensions

enclo ships three first-class editor surfaces, all backed by the same
`enclo-api` server and (for JetBrains / Vim) the same `enclo` CLI in a
new `--json-rpc` mode. They share no client-side state with the CLI —
auth and conversation history live on the server, so signing in from
one surface surfaces conversations from any other.

All three reach feature parity with the CLI for **MCP servers, hooks,
custom slash commands, and custom subagents**: VS Code reads the same
`~/.enclo/*` and `<repo>/.enclo/*` configs directly via the embedded
`@enclo/core` library, while JetBrains and Vim inherit them
transparently because they bridge to the `enclo --json-rpc` subprocess
which reads them on startup. The shared JSON-RPC wire format is
documented at [`./JSON_RPC_PROTOCOL.md`](./JSON_RPC_PROTOCOL.md).

### VS Code (v0.2.0)

**Install.** Build the `.vsix`, then "Install from VSIX..." in the
Extensions panel:

```bash
cd enclo-vscode
npm install
npm run build
npx vsce package --no-dependencies
# → enclo-vscode-0.2.0.vsix
```

**Configure.** Open VS Code settings (`Cmd+,`) and search for "enclo":

| Setting              | Default                  | Purpose                              |
|----------------------|--------------------------|--------------------------------------|
| `enclo.apiUrl`       | `http://localhost:8000`  | Base URL of your `enclo-api` server. |
| `enclo.defaultModel` | _(empty)_                | Pin a default model id.              |

**Sign in.** Run **enclo: Sign In** (or **Sign Up**) from the command
palette. Tokens go into VS Code's secret storage and refresh
automatically.

**Sidebar chat.** Click the `enclo` icon in the activity bar. Press
`Enter` to send, `Shift+Enter` for a newline. Status bar shows the
active model and conversation.

**Ask About Selection.** Highlight code, right-click, choose
**enclo: Ask About Selection**. The chat input is pre-filled with the
file path and selection.

**File edits via the diff editor.** When the assistant proposes a
`write_file` / `edit_file` tool call, a "Review change" button opens
VS Code's native diff editor (original on the left, proposal on the
right). Choose **Apply** to write the file, **Reject** to send a
rejection back to the agent — same semantics as the CLI's permission
prompt.

**MCP / hooks / custom commands / custom subagents.** All four flows
read the same `.enclo/*` config files as the CLI. Use the new command
palette entries (`enclo: Reload MCP`, `enclo: Reload Hooks`,
`enclo: Reload Commands`, `enclo: Reload Agents`) after editing config.

Full extension docs: [`../enclo-vscode/README.md`](../enclo-vscode/README.md).

### JetBrains (v0.1.0)

Targets **IntelliJ Platform 2024.3+** and runs unchanged on every
Platform-based IDE: IntelliJ IDEA (Community + Ultimate), PyCharm
(Community + Professional), WebStorm, GoLand, RubyMine, PhpStorm,
RustRover, and any other 243+ IDE.

**Install.** Requires JDK 21 to build:

```bash
cd enclo-jetbrains
./gradlew buildPlugin
# → build/distributions/enclo-jetbrains-0.1.0.zip
```

Then in any supported IDE: **Settings → Plugins → ⚙ → Install Plugin
from Disk…** and pick the `.zip`.

**Configure.** Open **Settings → Tools → enclo**:

| Setting          | Default                  | Purpose                                        |
|------------------|--------------------------|------------------------------------------------|
| API URL          | `http://localhost:8000`  | Base URL of your `enclo-api` server.           |
| enclo CLI path   | `enclo`                  | Absolute path or `enclo` if it's on `$PATH`.   |
| Default model    | _(empty)_                | Pin a model id; otherwise pick interactively.  |

The "Test connection" button spawns the CLI in `--json-rpc` mode and
calls the `me` RPC, surfacing any launch error inline.

**Tool window.** Open the **enclo** tool window in the right sidebar.
Pick a model from the top combo, type, and click Send (or
`Cmd/Ctrl-Enter`). Streaming deltas append to the latest assistant
bubble in real time; click Cancel mid-turn to abort.

**Ask enclo About This Code.** Right-click an editor selection and pick
**enclo: Ask enclo About This Code**. The chat input is pre-filled
with `Explain @<rel-path>:` plus a fenced code block.

**File edits via IntelliJ's diff editor.** When the agent proposes a
`write_file` / `edit_file` / `create_file` tool call, a "Review change"
button opens IntelliJ's native diff editor via `DiffManager`, then
prompts Apply / Reject.

**Permission prompts.** Tool calls that need explicit approval surface
a modal with the standard enclo choice set (allow once / session /
persisted / deny / persisted-deny).

**MCP / hooks / custom commands / custom subagents.** Inherited
transparently from the spawned `enclo --json-rpc` subprocess, which
reads the same `~/.enclo/*` and `<project>/.enclo/*` configs. v1 has
no dedicated UI to inspect or reload them — restart the IDE (or use
the CLI) when you edit configs.

**v1 limitations.** No clipboard image paste in the tool window
(workaround: pass an image path with `/image <path>` from the chat
input). No dedicated UI for MCP / hooks status panels.

Full plugin docs: [`../enclo-jetbrains/README.md`](../enclo-jetbrains/README.md).

### Vim / Neovim (v0.1.0)

Targets **Neovim 0.10+**. Classic Vim 8 is not supported in v1 — the
streaming + Content-Length framing flow needs Neovim's libuv-backed
jobs and `vim.system`. Vim 8 support is tracked for v2.

**Install (lazy.nvim).**

```lua
{
  "enclo/enclo.vim",
  config = function()
    require("enclo").setup({
      api_url = "http://localhost:8000",
    })
  end,
}
```

**Install (packer.nvim).**

```lua
use {
  "enclo/enclo.vim",
  config = function()
    require("enclo").setup({})
  end,
}
```

**Install (vim-plug).**

```vim
Plug 'enclo/enclo.vim'
" then in init.lua:
" require('enclo').setup({})
```

**Configure.**

```lua
require("enclo").setup({
  api_url       = "http://localhost:8000",
  binary_path   = "enclo",     -- path to the enclo CLI
  default_model = nil,          -- e.g. "qwen2.5-coder-7b"

  keymaps = {
    open_chat     = "<leader>ec",
    ask_selection = "<leader>ea",
  },
  floating_window = { width = 0.7, height = 0.7 },
  autostart       = false,
})
```

**Commands.** `:Enclo` (open chat), `:EncloAsk` (visual mode — chat
prefilled with selection), `:EncloSignIn`, `:EncloSignOut`,
`:EncloModels`, `:EncloHistory`, `:EncloResume <id>`,
`:EncloAccept [path]`, `:EncloReject [path]`, `:EncloCancel`.

**Floating chat.** Two-pane floating window — messages on top, input
below. Normal-mode `<CR>` sends; insert-mode `<CR>` is a newline; `q`
closes.

**Permissions.** When the agent calls a tool that needs approval, a
7-option `vim.ui.select` prompt appears (allow once / session /
persisted / deny / persisted-deny / etc.).

**File edits via `:diffthis`.** Proposed `write_file` / `edit_file`
calls open a tab with original on the left and proposal on the right.
Resolve with `:EncloAccept` or `:EncloReject`.

**MCP / hooks / custom commands / custom subagents.** Inherited
transparently from the spawned `enclo --json-rpc` subprocess.

**v1 limitations.** Classic Vim 8 deferred to v2. No clipboard image
paste. Custom slash commands and MCP status panels have no dedicated
UI yet (call them via the chat input or
`:lua require('enclo').get_rpc():call(...)`).

Full plugin docs: [`../enclo-vim/README.md`](../enclo-vim/README.md).

---

## How it compares to Claude Code

Honest, feature-by-feature.

| Capability                                 | enclo                                                                | Claude Code                                                          |
|--------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Built-in tool set                          | 10 tools (read, write, edit, bash, grep, glob, list_dir, spawn_agent, web_fetch, web_search) | 15+ (incl. WebFetch, WebSearch, Task, NotebookEdit, …) |
| Permission model                           | 7-option prompt, session + persisted (`~/.enclo/permissions.json`) allowlist with project overrides | 4-option prompt, persisted allowlist + settings.json rules |
| WebFetch / WebSearch built-ins             | Yes (`web_fetch`, `web_search`; SSRF-protected; pluggable search provider) | Yes |
| Persisted permission allowlist             | Yes (`~/.enclo/permissions.json`, project override at `.enclo/permissions.json`, deny-wins ordering) | Yes |
| Streaming                                  | SSE; per-token text + per-chunk tool_call_delta                      | SSE; per-token text + per-chunk tool_call_delta                      |
| Vision / image input                       | Yes (`/image <path>`, multi-modal content blocks)                    | Yes (drag-drop screenshots)                                          |
| Plan mode / explicit planning              | Yes (Shift-Tab or `/plan`)                                           | Yes                                                                  |
| Sub-agents / Task tool                     | Yes (`spawn_agent`, depth 3, iter cap 15)                            | Yes                                                                  |
| Project context (CLAUDE.md equivalent)     | Yes (`enclo.md`, walks upward, 50 KB cap, `/context` / `/reload-context`) | Yes (`CLAUDE.md`)                                               |
| `@file` references                         | Yes (glob, 5-file / 100 KB caps, auto-expanded in user turns)        | Yes                                                                  |
| Clipboard image paste                      | Yes (Cmd-V / Ctrl-V, PNG, 5 MB cap; CLI + VS Code)                   | Yes                                                                  |
| Token / cost tracking                      | Yes (Footer; 60 % / 80 % thresholds; opt-in `cost` in config.json)   | Yes                                                                  |
| Conversation resume                        | Yes (`/history`, `/resume`, restores tool_calls + multi-modal)       | Yes                                                                  |
| Context auto-compaction                    | Yes (server-side `/compact`, CLI auto-trigger at 70 %)               | Yes                                                                  |
| Custom slash commands                      | Yes (`.enclo/commands/*.md`, frontmatter, `$ARGUMENTS` / `$1` / `$CWD`) — works in CLI + VS Code + JetBrains + Vim | Yes |
| Custom subagents                           | Yes (`.enclo/agents/*.md`, invoked via `spawn_agent(subagent_type:)`) — works in CLI + VS Code + JetBrains + Vim | Yes |
| Hooks (pre/post tool, on stop)             | Yes (7 events, exit-code semantics, `~/.enclo/hooks.json`) — works in CLI + VS Code + JetBrains + Vim | Yes (settings.json hooks) |
| MCP server support                         | Yes (full MCP client, stdio + SSE, `mcp__server__tool` prefix) — works in CLI + VS Code + JetBrains + Vim | Yes (full MCP client) |
| VS Code extension                          | Yes — sidebar chat, diff-editor reviews, MCP / hooks / custom commands / subagents **NEW** | Yes |
| JetBrains plugin                           | Yes — IntelliJ Platform 2024.3+ (IDEA, PyCharm, WebStorm, GoLand, RubyMine, PhpStorm, RustRover); right-sidebar tool window, native IntelliJ diff editor for file edits **NEW** | Yes |
| Vim / Neovim plugin                        | Yes — Neovim 0.10+; floating chat window, `:diffthis` for file edits, `vim.ui.select` permission prompt **NEW** | Yes |
| JSON-RPC editor bridge                     | Yes — `enclo --json-rpc` stdio JSON-RPC 2.0 server (LSP-style Content-Length framing) used by JetBrains and Vim plugins **NEW** | (Anthropic-hosted SDK) |
| Slash commands                             | 24+ built-in (signin, models, tools, allow, cd, plan, image, context, reload-context, history, list, resume, reload-commands, agents, reload-agents, hooks, reload-hooks, mcp, reload-mcp, …) plus user-defined | Many, plus user-defined skills |
| Hosted vs self-hosted                      | Self-hosted (your GPU, your network)                                 | Anthropic-hosted models                                              |
| Conversation history                       | Server-persisted, multi-device                                       | Local + Anthropic-hosted                                             |

enclo is at full feature parity with Claude Code, across CLI and all three major editor surfaces (VS Code, JetBrains family, Neovim).

---

## Adding new tools

Every tool is a single TypeScript module that exports a `Tool` object —
schema + executor + permission category. Source of truth:
`enclo-code/src/tools/types.ts`.

Minimal example — a `read_url` tool that fetches an HTTP resource:

```ts
// enclo-code/src/tools/read_url.ts
import type { Tool } from "./types.js";

export const readUrl: Tool = {
  category: "read",            // auto-allowed (no prompt)
  requiresPermission: false,   // honored when category is auto-allowed
  definition: {
    type: "function",
    function: {
      name: "read_url",
      description: "Fetch the body of an HTTPS URL and return it as text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  async execute(args, _ctx) {
    const url = (args as { url?: string }).url;
    if (!url) {
      return { content: "missing 'url' argument", isError: true };
    }
    const res = await fetch(url);
    const body = await res.text();
    return {
      content: body.slice(0, 200_000),
      display: { kind: "text", preview: `${url} (${body.length} bytes)` },
    };
  },
};
```

Then register it in `enclo-code/src/tools/index.ts`:

```ts
import { readUrl } from "./read_url.js";

export function builtInTools(): Tool[] {
  return [readFile, writeFile, editFile, bash, grep, glob, listDir, readUrl];
}
```

That's it — the agent loop will discover it via the registry, the model will
see it in the tools schema on the next request, and the permission manager
will respect its `category` / `requiresPermission` settings. Add a vitest
under `enclo-code/test/tools/` to lock in the contract.

---

## Known limitations

- **Model-dependent quality.** The agent loop is only as good as the model's
  tool-calling. Smaller open-weight models (≤7B) frequently mis-format
  arguments, hallucinate file paths, or forget to check returned errors. See
  `docs/CODING_MODELS_APR2026.md` and `docs/ONPREM_PICK.md` for the picks
  that have the strongest tool-calling track record. As a rule of thumb:
  Kimi-K2.6 > GLM-5.1 > Qwen3-Coder-480B > Qwen3.6-35B-A3B > Devstral-2-24B
  for agentic loops.
- **No tool parallelism.** When the model emits multiple tool calls in one
  turn, the loop runs them sequentially. (Models do this less than you might
  expect — most prefer chains over fans.)
- **No shell session persistence.** Each `bash` call is a fresh shell. `cd`
  doesn't carry over between calls; use the `/cd` slash command to change
  the CLI's working directory for subsequent tool invocations.
- **Sub-agents share parent permissions.** The `spawn_agent` child inherits
  the parent's session allowlist (a v1 ergonomics choice — see the
  Sub-agents section).
- **No retries on tool errors.** If a tool fails, the model sees the error
  text and decides whether to try again — the loop itself does no automatic
  retry.
- **Session permissions remain in-memory.** Anything approved with the
  three "session" choices in the prompt clears on restart. The three
  "forever" choices (and the `/allow add` / `/allow deny` subcommands)
  write to `~/.enclo/permissions.json` and survive across runs — see
  [Persisted permissions](#persisted-permissions).
