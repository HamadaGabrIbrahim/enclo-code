# enclo Architecture & API Contract

This document is the single source of truth that `enclo-api` (server) and `enclo-code` (CLI) code against. Both repos must conform to it.

## Topology

```
+------------------+        HTTPS/HTTP (LAN)        +-----------------------+
|  enclo-code CLI  |  ----------------------------> |     enclo-api         |
|  (user laptop)   |                                |   (Linux server)      |
+------------------+                                |                       |
                                                    |  FastAPI + JWT auth   |
                                                    |          |            |
                                                    |          v            |
                                                    |   PostgreSQL (users,  |
                                                    |   tokens, history)    |
                                                    |          |            |
                                                    |  Routes /chat to ---> |
                                                    |  vLLM registry        |
                                                    +-----------+-----------+
                                                                |
                                          +---------------------+---------------------+
                                          |                     |                     |
                                  +-------v-------+   +---------v-------+   +---------v-------+
                                  | vLLM proc #1  |   | vLLM proc #2    |   | vLLM proc #N    |
                                  | model A       |   | model B         |   | ...             |
                                  | port 8001     |   | port 8002       |   | port 800N       |
                                  +---------------+   +-----------------+   +-----------------+
```

**Why a registry, not a single vLLM:** vLLM serves exactly one base model per process. To support `/models` switching at runtime, we run one vLLM process per model on its own port. The FastAPI app keeps a registry (`MODEL_REGISTRY`) mapping `model_name -> {url, display_name, context_length, backend}` and routes `/v1/chat/completions` requests to the right backend.

**Backends:** entries declare `backend: "vllm" | "ollama"` (default `vllm`). Both speak OpenAI's `/v1/chat/completions`, so the same HTTP client handles both. The field exists so the routing layer can apply backend-specific quirks (e.g. Ollama-only options) if/when needed. Per-tier sample registries live in `config/registries/` (`laptop-ollama.yaml`, `single-gpu.yaml`, `frontier.yaml`).

## Repos

- `enclo-api/` — Python 3.11, FastAPI, SQLAlchemy 2.x, Alembic, asyncpg, httpx, pydantic v2, python-jose, passlib[bcrypt], pytest.
- `enclo-code/` — Node 20+, TypeScript, Ink, Commander, ky (HTTP), zod (schema), conf (config persistence), vitest.

## Auth flow

1. `POST /auth/signup` → creates user, returns `access_token` + `refresh_token`.
2. `POST /auth/signin` → validates password, returns `access_token` + `refresh_token`.
3. `POST /auth/refresh` → rotates refresh token, returns new pair.
4. `POST /auth/signout` → revokes the refresh token (insert into `revoked_tokens`).
5. All `/v1/*` endpoints require `Authorization: Bearer <access_token>`.

Access token lifetime: 30 minutes. Refresh token lifetime: 30 days. Refresh tokens are stored hashed in `refresh_tokens` table with `revoked_at` for signout.

Passwords: bcrypt, cost factor 12.

## REST endpoints

All requests/responses are JSON unless noted. Errors use this shape:

```json
{ "error": { "code": "string", "message": "string" } }
```

Common error codes: `invalid_credentials`, `email_taken`, `unauthorized`, `token_expired`, `token_revoked`, `model_not_found`, `validation_error`, `internal_error`.

### `POST /auth/signup`
Request:
```json
{ "email": "user@example.com", "password": "min8chars", "display_name": "optional" }
```
Response 201:
```json
{
  "user": { "id": "uuid", "email": "...", "display_name": "..." },
  "access_token": "jwt",
  "refresh_token": "opaque",
  "token_type": "bearer",
  "expires_in": 1800
}
```
Errors: `email_taken` (409), `validation_error` (422).

### `POST /auth/signin`
Request: `{ "email": "...", "password": "..." }`
Response 200: same shape as signup.
Errors: `invalid_credentials` (401).

### `POST /auth/refresh`
Request: `{ "refresh_token": "..." }`
Response 200: same shape as signup, with a fresh refresh token (old one is revoked).
Errors: `token_revoked` (401), `token_expired` (401).

### `POST /auth/signout`
Request: `{ "refresh_token": "..." }`
Response 204.
Errors: `unauthorized` (401) if access token bad. Refresh token is marked revoked; idempotent (revoking an already-revoked token is fine).

### `GET /v1/me`
Response 200: `{ "id": "uuid", "email": "...", "display_name": "..." }`. Used for token validation on CLI startup.

### `GET /v1/models`
Response 200:
```json
{
  "models": [
    {
      "id": "llama-3.1-8b-instruct",
      "display_name": "Llama 3.1 8B Instruct",
      "context_length": 8192,
      "available": true
    },
    { "id": "qwen2.5-coder-7b", "display_name": "Qwen 2.5 Coder 7B", "context_length": 32768, "available": true }
  ]
}
```
Server-side: built from `MODEL_REGISTRY` config. `available` reflects a recent health check of the underlying vLLM instance (cached 30s).

### `POST /v1/chat/completions`  *(SSE streaming)*
Request:
```json
{
  "model": "llama-3.1-8b-instruct",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_abc", "type": "function",
        "function": { "name": "read_file", "arguments": "{\"path\":\"x\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_abc", "content": "file contents" }
  ],
  "conversation_id": "uuid | null",
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file from disk",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
      }
    }
  ],
  "tool_choice": "auto"
}
```

`tools` and `tool_choice` follow OpenAI's schema and are forwarded straight through to the upstream backend (vLLM or Ollama). `tool_choice` may be `"auto"`, `"none"`, `"required"`, or `{ "type": "function", "function": { "name": "..." } }`.

#### Multi-modal content (vision)

For vision-capable models (e.g. Gemma 4 31B), `content` may also be an OpenAI-format list of typed blocks instead of a plain string:

```json
{
  "model": "gemma-4-31b",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this screenshot?" },
        { "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgo...",
            "detail": "auto"
          } }
      ]
    }
  ],
  "stream": true
}
```

Block types:
- `{ "type": "text", "text": "..." }`
- `{ "type": "image_url", "image_url": { "url": "...", "detail": "auto" | "low" | "high" } }` — `url` is either an `http(s)://` URL or a `data:image/<mime>;base64,<payload>` URL. `detail` defaults to `"auto"`.

Validation:
- Supported image mime types for `data:` URLs: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Anything else returns `422 validation_error`.
- Total decoded image bytes per message are capped at **10 MB**. Oversized payloads return `422 validation_error`.
- Malformed `data:` URLs (bad base64, wrong shape) return `422 validation_error`.
- `tool` messages must use string content; image blocks are not allowed in tool results.

Pass-through and persistence:
- The list of blocks is forwarded as-is to the upstream backend (vLLM with vision-capable models and Ollama both speak this format).
- The `messages.content` column keeps the concatenated text from `text` blocks for back-compat (existing readers see something printable). The full block list is persisted in a new nullable `messages.content_parts JSONB` column.
- `GET /v1/conversations/{id}` returns `content` as the original list of blocks for messages that were sent with `content_parts` (lossless round-trip), and as a plain string for text-only messages.

If `stream: true` (default), response is `text/event-stream`. Each event is a JSON object:

```
data: {"type":"start","conversation_id":"uuid","message_id":"uuid"}

data: {"type":"delta","content":"Hello"}

data: {"type":"delta","content":" world"}

data: {"type":"tool_call_delta","index":0,"id":"call_abc","name":"read_file","arguments_delta":"{\"path\":\"pa"}

data: {"type":"tool_call_delta","index":0,"arguments_delta":"ckage.json\"}"}

data: {"type":"end","finish_reason":"stop","usage":{"prompt_tokens":12,"completion_tokens":8}}

data: [DONE]
```

`tool_call_delta` events carry partial pieces of an OpenAI-style tool call:
- `index` (int): identifies the tool call in the assistant's response (multiple parallel tool calls have different indices).
- `id` (str, optional): set on the first delta for an index; omitted on subsequent deltas.
- `name` (str, optional): set on the first delta for an index.
- `arguments_delta` (str, optional): a chunk of the JSON arguments string. The CLI must concatenate `arguments_delta` across all events for a given `index` to reconstruct the full JSON arguments.

When the upstream finishes with tool calls, the `end` event has `finish_reason: "tool_calls"`. Other valid finish reasons are `"stop"`, `"length"`, and `"content_filter"`.

On error mid-stream:
```
data: {"type":"error","code":"upstream_error","message":"vLLM unreachable"}
```

If `stream: false`, response is a single JSON:
```json
{
  "conversation_id": "...",
  "message_id": "...",
  "content": "...",
  "tool_calls": [
    { "id": "call_abc", "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"package.json\"}" } }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8 }
}
```
`tool_calls` is `null` when the model returned plain text.

Server behavior:
- If `conversation_id` is null, create a new conversation owned by the authenticated user.
- Persist the trailing run of `user`/`tool` messages from the request before forwarding upstream. After streaming completes, persist the assistant message — including `tool_calls` JSON when present.
- Incoming messages with `role: "tool"` must include `tool_call_id` and `content`. Incoming `role: "assistant"` messages may carry `tool_calls` (used as input history when the client is replaying a turn).
- Look up the model in the registry; 404 with `model_not_found` if unknown.
- Forward to `{registry[model].url}/v1/chat/completions` (the backend's OpenAI-compatible endpoint), translate upstream SSE chunks into our event format above. The same client implementation handles both vLLM and Ollama.

### `GET /v1/conversations`
Response 200: `{ "conversations": [{ "id", "title", "model", "created_at", "updated_at", "message_count", "total_prompt_tokens", "total_completion_tokens" }, ...] }`. Sorted by `updated_at DESC`. The two `total_*` fields are sums of the corresponding columns across the conversation's messages (assistant rows are the typical contributors; rows with NULL token columns count as 0).

### `GET /v1/conversations/{id}`
Response 200: `{ "id", "title", "model", "messages": [{ "id", "role", "content", "created_at" }, ...], "total_prompt_tokens", "total_completion_tokens" }`. 404 if not owned by caller. The two `total_*` fields are the same per-conversation sums returned by the list endpoint, included here so a single fetch is enough to render usage UI.

### `DELETE /v1/conversations/{id}`
Response 204. 404 if not owned by caller.

### `GET /v1/conversations/{id}/usage`
Response 200:
```json
{
  "prompt_tokens": 12345,
  "completion_tokens": 4567,
  "message_count": 28,
  "oldest_message_at": "2026-04-25T08:00:00Z",
  "newest_message_at": "2026-04-26T15:30:00Z",
  "estimated_context_used": 16912
}
```
- `prompt_tokens` / `completion_tokens` are sums over all rows in `messages` for the conversation (NULL columns count as 0).
- `oldest_message_at` / `newest_message_at` are `min` / `max` of `created_at`. Both are `null` when the conversation has no messages.
- `estimated_context_used = prompt_tokens + completion_tokens`. This is the rough size of conversational state the next chat turn will replay; the CLI uses it (combined with the model's `context_length` from `/v1/models`) to decide when to suggest or trigger compaction.

Errors: `not_found` (404) when the conversation does not exist or is not owned by the caller.

### `POST /v1/conversations/{id}/compact`
Compacts the oldest portion of the conversation into a single `system` summary message produced by the conversation's own model.

Server behavior:
- Loads all messages for the conversation in `created_at, id` order.
- Keeps the **last 10 messages** intact and selects everything before that as the "compact set".
- Builds a summarization request using the conversation's persisted `model` (looked up in `MODEL_REGISTRY`) and posts a non-streaming `/v1/chat/completions` to the matching backend with:
  - `system`: `"Summarize this conversation history concisely. Preserve key decisions, file paths discussed, code patterns established, and unresolved questions. Output only the summary text."`
  - `user`: a serialized text blob of the compact set (each message rendered as `[role]\n<content>` with tool_call_ids and tool_calls flattened to a compact `name(args)` form).
  - `temperature: 0.2`, `max_tokens: 2048`, `stream: false`.
- In a single transaction: deletes the compact-set rows and inserts one new message with `role="system"`, `content=summary`, `prompt_tokens=null`, `completion_tokens=<summary completion_tokens from upstream usage>`, and `created_at = earliest_deleted_message.created_at` so the summary slots into the same chronological position as the messages it replaced.

Response 200:
```json
{
  "compacted_count": 18,
  "summary_token_count": 412,
  "remaining_messages": 10
}
```
`remaining_messages` is the keep-window size (10) — i.e. the number of original messages preserved after the summary; the conversation's total message count after compaction is `remaining_messages + 1` (the new summary row).

Errors:
- `not_found` (404) when the conversation does not exist or is not owned by the caller.
- `compact_unavailable` (400) when the conversation has 10 or fewer messages (nothing to compact while keeping the last 10 intact).
- `upstream_error` (502) when the summarization call to the backend fails or returns empty content, or when the conversation's model is no longer registered.

## Database schema (Postgres)

```sql
-- users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- refresh_tokens (rotation + revocation)
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,         -- sha256 of raw token
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX ON refresh_tokens(user_id);

-- conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations(user_id, updated_at DESC);

-- messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  prompt_tokens INT,
  completion_tokens INT,
  tool_call_id TEXT,           -- set when role='tool', references the assistant tool call this is a reply to
  tool_calls JSONB,            -- set when role='assistant' and the model emitted tool calls; OpenAI-format array
  content_parts JSONB,         -- set when the message was sent with multi-modal content (list of OpenAI blocks); null for plain string content
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages(conversation_id, created_at);
```

`citext` requires `CREATE EXTENSION citext;` in the Alembic init migration.

## Configuration (server)

`enclo-api` reads these env vars (via pydantic-settings):

| Var | Example | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://enclo:enclo@db:5432/enclo` | Postgres DSN |
| `JWT_SECRET` | random 64+ char | HS256 signing key |
| `ACCESS_TOKEN_TTL_SECONDS` | `1800` | Access token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token lifetime |
| `MODEL_REGISTRY_FILE` | `/etc/enclo/models.yaml` | Path to YAML registry |
| `CORS_ORIGINS` | `*` | Comma-separated origins |

`models.yaml`:
```yaml
models:
  - id: llama-3.1-8b-instruct
    display_name: Llama 3.1 8B Instruct
    url: http://vllm-llama:8000
    context_length: 8192
    backend: vllm                # default; may be omitted
  - id: qwen2.5-coder-7b
    display_name: Qwen 2.5 Coder 7B
    url: http://ollama:11434
    context_length: 32768
    backend: ollama              # use Ollama's OpenAI-compatible endpoint
```

### Ollama backend

Ollama exposes an OpenAI-compatible endpoint at `http://<host>:11434/v1/chat/completions` and supports OpenAI-format tool calls. Because both vLLM and Ollama speak the same wire format, the same `httpx`-based client (`enclo_api.vllm.client`) handles both. The `backend` field on a registry entry is currently informational — it lets future code apply backend-specific options (e.g. Ollama's `keep_alive`) without inspecting the URL.

Usage:
- Run Ollama locally: `ollama serve` (default port 11434), then `ollama pull qwen2.5-coder:7b`.
- Set the model entry's `url` to the Ollama base URL and `id` to the Ollama model tag (e.g. `qwen2.5-coder:7b`).
- For docker-compose, use `host.docker.internal:11434` from a container or run Ollama as a sibling service at `http://ollama:11434`.

Sample tiered registries are in `config/registries/`:
- `laptop-ollama.yaml` — Ollama, RTX-class laptop GPU.
- `single-gpu.yaml` — vLLM, single-GPU server.
- `frontier.yaml` — vLLM, multi-GPU rig.

## CLI behavior (enclo-code)

- First run: prompts user to enter API URL, then `/signin` or `/signup`.
- Config file at `~/.enclo/config.json`:
  ```json
  {
    "api_url": "http://server.local:8000",
    "access_token": "...",
    "refresh_token": "...",
    "user": { "id": "...", "email": "...", "display_name": "..." },
    "active_model": "llama-3.1-8b-instruct"
  }
  ```
  File mode 0600.
- On 401: try `/auth/refresh` once, retry the original request, only then surface the error and prompt re-signin.
- Slash commands:
  - `/signup` — interactive signup
  - `/signin` — interactive signin
  - `/signout` — calls `/auth/signout`, clears tokens from config
  - `/models` — fetches `/v1/models`, shows a selectable list, persists `active_model`
  - `/clear` — clears the on-screen conversation (starts a new `conversation_id`)
  - `/help` — list commands
  - `/exit` — quit
- Non-slash input: send to `/v1/chat/completions` with current `conversation_id` and `active_model`, render streamed deltas token-by-token.

## Streaming protocol (CLI side)

Use `fetch`/`undici` with `Accept: text/event-stream`. Parse each `data: {...}` line as JSON. On `type: "delta"` append `content` to current message. On `type: "end"` finalize. On `[DONE]` close. On `type: "error"` show error and reset.

## Mock vLLM (for dev)

A tiny FastAPI service exposing `/v1/models` and `/v1/chat/completions` that streams a canned response token-by-token. Lives in `enclo-api/tests/mock_vllm/` and is used by docker-compose and pytest. Lets the system run end-to-end without a GPU.

## Status codes summary

| Endpoint | Success | Common errors |
|---|---|---|
| signup | 201 | 409 email_taken, 422 validation |
| signin | 200 | 401 invalid_credentials |
| refresh | 200 | 401 token_revoked / token_expired |
| signout | 204 | 401 unauthorized |
| me | 200 | 401 unauthorized |
| models | 200 | 401 unauthorized |
| chat/completions | 200 (stream) | 401, 404 model_not_found, 502 upstream_error |
| conversations list | 200 | 401 |
| conversation get | 200 | 401, 404 |
| conversation delete | 204 | 401, 404 |
| conversation usage | 200 | 401, 404 |
| conversation compact | 200 | 400 compact_unavailable, 401, 404, 502 upstream_error |

## Non-goals (v1)

- File uploads (non-image attachments)
- Per-user rate limiting (server is on trusted LAN)
- Multi-tenant orgs
- HTTPS termination (assume reverse proxy handles it in prod)
