# Skills — on-demand instruction sets

A **skill** is a reusable instruction set the agent can load mid-turn (via
the `Skill` tool) or that you can run directly as a prompt (via the
`/skill` slash command). Use skills for:

- Domain checklists you want the model to follow ("review code for OWASP
  top-10", "write a postmortem in our standard format").
- Multi-step procedures the model should reach for when it sees a matching
  request ("when asked to ship a PR, first run tests, then …").
- Reference material that's too long to keep in `enclo.md` but should be
  loadable on demand.

Skills are different from custom commands and subagents:

| | invoked by | runs as | isolation |
|---|---|---|---|
| custom command (`/foo`) | user | next user turn | none |
| **skill (`Skill` tool / `/skill foo`)** | **model OR user** | **inline (instructions loaded into context)** | **none** |
| subagent (`spawn_agent`) | model | child agent loop | full (separate history) |

## Quick start

1. Drop a markdown file at one of these locations:
   - `<cwd>/.enclo/skills/<name>.md` — project-scoped (takes precedence on
     name collision).
   - `~/.enclo/skills/<name>.md` — user-global.
2. Start enclo. Run `/skills` to confirm it was discovered.
3. Either invoke directly with `/skill <name> [args]`, or let the model
   call the `Skill` tool when the description matches the user's request.
4. Run `/reload-skills` after editing without restarting.

## File format

```markdown
---
name: security-review            # optional; defaults to filename stem
description: Run an OWASP-style review on the current changes
allowed-tools: [grep, read_file] # optional; only honored by /skill, not the Skill tool
model: claude-sonnet-4           # optional; only honored by /skill
---
Review the user-supplied diff against the OWASP top-10:

1. Check input handling for $1.
2. Look for hard-coded secrets (use grep on $CWD).
3. Verify authn/z on every new endpoint.

Body uses the same placeholders as custom commands:
$ARGUMENTS, $1, $2, …, $CWD.
```

Frontmatter is optional. If `description` is missing, a synthetic one is
synthesized from the filename so the model can still see what the skill is
for.

## How the model invokes a skill

When at least one skill is registered, enclo registers a `Skill` tool with
an `enum` of every skill name and a description that lists each skill's
when-to-use blurb. The model calls `Skill(skill: "<name>", args: "...")`
and the skill's body (with placeholders substituted) is returned as the
tool result. The model then follows those instructions for the rest of
the turn.

Per-skill `allowed-tools` and `model` are **only** applied for the user-
invoked `/skill` path (where they affect the next agent turn). When the
*model* loads a skill via the `Skill` tool, it stays in the same turn and
keeps the active model + tool surface.

## Discovery rules

- Walks upward from `cwd` to your home directory, loading every `*.md`
  from `.enclo/skills/` along the way, then loads `~/.enclo/skills/`
  last.
- On name collision, the skill closer to `cwd` wins (project overrides
  user-global).
- Names are lowercased.
- A frontmatter `tools:` key is accepted as a synonym for `allowed-tools:`
  for parity with the subagents format.

## Slash commands

- `/skills` — list discovered skills with their description and any
  per-skill overrides.
- `/reload-skills` — re-discover after editing a `.md` file.
- `/skill <name> [args]` — run a skill as the next prompt. Substitutes
  `$ARGUMENTS`, `$1`, `$2`, `$CWD` into the body. Per-skill `model` and
  `allowed-tools` overrides are applied to that turn.

## Choosing skills vs custom commands vs subagents

- **Custom command** if the user always initiates and you want a quick
  prompt expansion (e.g. `/explain`, `/blame-this-line`).
- **Skill** if the model should be able to reach for it mid-conversation
  whenever the request matches its description (e.g. "security-review",
  "postmortem-template", "release-checklist").
- **Subagent** if the work is large enough to deserve its own isolated
  conversation and you don't want its tool calls cluttering the main
  transcript (e.g. "investigate this stack trace, return a 1-paragraph
  finding").
