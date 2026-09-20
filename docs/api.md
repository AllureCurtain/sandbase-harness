# API Reference

`managed-agents` exposes a local-first JSON API under `/v1`. The Dashboard, the
TypeScript SDK, and external automation all use the same resource model: agents,
sessions, environments, credential vaults, memory stores, files, skills, API
keys, and runtime operations.

The API is intentionally close to Claude Managed Agents while remaining local
and inspectable. Resource metadata is stored in SQLite, uploaded assets live
under the runtime data directory, and session timelines are persisted as
replayable events.

## Interactive Reference

Open `Settings > API reference` in the Dashboard for an in-product reference page
modeled after platform API docs:

- endpoint navigation grouped by resource
- method/path headers for each operation
- header, query, body, and return field descriptions
- copyable `curl` examples generated from the active runtime base URL
- TypeScript SDK and Skill upload examples

Use this page when integrating a local runtime into scripts, CI jobs, desktop
apps, or an internal control plane. It reflects the server you are connected to,
including whether bearer authentication is currently enabled.

## Runtime Contract

The local server exposes the Dashboard and API from the same origin:

```text
Dashboard: http://127.0.0.1:3000/dashboard
API:       http://127.0.0.1:3000/v1
```

All timestamps are RFC 3339 strings. Identifiers are opaque tagged ids such as
`agent_...`, `sess_...`, `env_...`, `skill_...`, and `memstore_...`; clients
should not infer meaning from their length or suffix.

## CMA Compatibility Headers and Authentication

Authentication is disabled by default for local development. It is enabled when
at least one API key exists. Keys can be supplied through
`MANAGED_AGENTS_API_KEY` or created through `/v1/api-keys`.

CMA clients may authenticate with either header when authentication is enabled:

```text
x-api-key: ma_local_example
Authorization: Bearer ma_local_example
```

Use exactly one credential scheme per request. A request carrying both
`Authorization` and `x-api-key` is rejected with `401 authentication_error`,
even if the values match; this prevents credential-source ambiguity at proxy
and middleware boundaries.

Requests using `x-api-key`, or either Anthropic compatibility header, are
admitted before CMA route handlers run. They must include:

```text
anthropic-version: 2023-06-01
```

Normal CMA resources require the managed-agents beta:

```text
anthropic-beta: managed-agents-2026-04-01
```

Memory-store resources (`/v1/memory_stores` and descendants) instead require:

```text
anthropic-beta: agent-memory-2026-07-22
```

Do not combine that beta with `managed-agents-2026-04-01` on a memory-store
request: admission rejects the pair with `400 invalid_request`. The documented
read-only exception, `GET /v1/memory_stores/{id}/memories`, accepts either of
those two betas when sent alone.

`anthropic-beta` accepts comma-separated identifiers; the required identifier
must appear in the list. Missing, malformed, or unsupported compatibility
headers return `400` with the standard `invalid_request` error envelope before
route business logic executes. Runtime extension endpoints under `/v1/x` do not
use CMA header admission.

Existing bearer callers that omit the CMA compatibility headers remain supported
unchanged. A bearer request that sends either compatibility header is validated
by the same CMA policy. Raw API keys are never returned from list or retrieve
responses. A newly created managed key returns `secret_key` once; store it
before discarding the response.

## Pagination and Errors

Collection responses:

```json
{
  "data": [],
  "has_more": false,
  "first_id": null,
  "last_id": null
}
```

Error responses:

```json
{
  "error": {
    "type": "invalid_request",
    "message": "name is required"
  }
}
```

Common error types are `invalid_request`, `not_found`, `conflict`,
`not_available`, and `internal_error`.

### Rate limits

Inbound `/v1` throttling is a single-process fixed one-minute window with
independent credential buckets:

| Request class | Methods | Default budget |
| --- | --- | --- |
| Write | `POST`, `PUT`, `PATCH`, `DELETE` | 300 / minute |
| Read | `GET`, `HEAD` | 1200 / minute |

The limiter runs after authentication and before CMA request admission. An
exceeded budget returns HTTP `429` with `error.type: "rate_limit_error"`,
`error.code: "inbound_rate_limited"`, a positive `Retry-After` value, and
`X-RateLimit-Limit`/`X-RateLimit-Remaining` headers. Invalid credentials remain
`401` and do not consume a valid credential's bucket. `/v1/x/health` and CORS
`OPTIONS` preflight requests are exempt; preflight is handled by CORS before
route middleware and is not counted.

A runtime with no API keys is unlimited by default. Set
`MANAGED_AGENTS_INBOUND_RATE_LIMIT=on` to force the limiter, or `off` to
suppress the default on a key-protected runtime. Use
`MANAGED_AGENTS_INBOUND_RATE_LIMIT_READ` and
`MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE` for positive per-minute overrides.
Managed API key creation/removal updates the default auth-linked posture after
startup. The limiter is in-process and fixed-window; it is best-effort
throttling, not distributed state or DDoS protection. Forwarded IP fallback is
not a trusted proxy security boundary.

## API Keys

API keys control bearer-token authentication for the local runtime. Managed keys
are stored in SQLite as SHA-256 hashes. Keys from config or environment variables
are shown as read-only `config_env` records.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/api-keys` | List managed and configured API keys. |
| `POST` | `/v1/api-keys` | Create a managed API key. |
| `DELETE` | `/v1/api-keys/{key_id}` | Delete a managed API key. |

Create a key:

```bash
curl -X POST http://127.0.0.1:3000/v1/api-keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "Local Console" }'
```

Create response:

```json
{
  "id": "key_abc123",
  "type": "api_key",
  "name": "Local Console",
  "source": "managed",
  "key_prefix": "ma_abc123...wxyz",
  "status": "active",
  "created_at": "2026-07-12T00:00:00.000Z",
  "updated_at": "2026-07-12T00:00:00.000Z",
  "last_used_at": null,
  "archived_at": null,
  "secret_key": "ma_full_secret_returned_once"
}
```

List response entries omit `secret_key`:

```json
{
  "id": "key_abc123",
  "type": "api_key",
  "name": "Local Console",
  "source": "managed",
  "key_prefix": "ma_abc123...wxyz",
  "status": "active",
  "last_used_at": "2026-07-12T00:01:00.000Z"
}
```

## Agents

Agents are SQLite-backed runtime resources. Optional YAML files in the configured
agents directory can seed a workspace, but creates and updates are persisted in
the local database.

Agent ids are object identifiers. Seeded YAML agents use deterministic ids on
import; API and Console-created agents receive server-generated `agent_...` ids.
Names are display fields and do not need to be unique.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/agents` | List loaded agents. |
| `POST` | `/v1/agents` | Create an agent resource. |
| `GET` | `/v1/agents/{agent_id}` | Retrieve an agent. |
| `PUT` | `/v1/agents/{agent_id}` | Save a new agent version. |
| `GET` | `/v1/agents/{agent_id}/versions` | List versions known to the local store. |
| `POST` | `/v1/agents/{agent_id}/archive` | Archive an agent. |

Create an agent:

```bash
curl -X POST http://127.0.0.1:3000/v1/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "Helps with development tasks.",
    "model": "default",
    "system": "You are a helpful assistant.",
    "mcp_servers": [],
    "tools": [{ "type": "agent_toolset_20260401" }],
    "skills": [],
    "metadata": {}
  }'
```

Agent response:

```json
{
  "id": "agent_01JAbcdefghijklmnopqrstuvw",
  "type": "agent",
  "name": "assistant",
  "description": "Helps with development tasks.",
  "model": "default",
  "status": "active",
  "version": 1,
  "created_at": "2026-07-12T00:00:00.000Z",
  "updated_at": "2026-07-12T00:00:00.000Z",
  "archived_at": null
}
```

Update an agent with optimistic version checking:

```bash
curl -X PUT http://127.0.0.1:3000/v1/agents/agent_abc123 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "assistant",
    "description": "Updated instructions.",
    "model": "default",
    "system": "You are a helpful assistant. Prefer concise answers.",
    "tools": [{ "type": "agent_toolset_20260401" }],
    "skills": [],
    "expected_version": 1
  }'
```

When `expected_version` is present and does not match the current agent
version, the API returns `409 conflict`. Each successful create/update writes an
immutable snapshot returned by `/v1/agents/{agent_id}/versions`.

### Agent model object

`model` accepts either the bare model id string or the canonical object form.

```json
{ "id": "claude-opus-5", "speed": "standard", "effort": "high" }
```

| Field | Accepted values | Behaviour |
| --- | --- | --- |
| `id` | non-empty string | Required. |
| `speed` | `standard` \| `fast` \| `extended` | Optional; defaults to `standard`. `extended` is a local extension, not a published value. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max`, or `{ "type": <level> }` | Optional. Parsed, validated, and carried through to the stored agent; nothing yet varies model behaviour by it. |
| `inference_geo` | `us` \| `global` | Refused with `unsupported_model_field`. A local runtime has no inference-geography control, so honouring the pin is not possible. |

An unrecognized key is also refused with `unsupported_model_field`, and the error
lists every known field so the request can be corrected. A malformed `speed`
or `effort` is refused with its own stable code and the accepted value set
rather than being silently defaulted.

## Sessions

Sessions run an agent in an environment and persist a resumable event log.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions` | List sessions. |
| `POST` | `/v1/sessions` | Create a session. |
| `GET` | `/v1/sessions/{session_id}` | Retrieve a session. |
| `POST` | `/v1/sessions/{session_id}/messages` | Send a user message and optionally stream. |
| `POST` | `/v1/sessions/{session_id}/events` | Append user events. |
| `GET` | `/v1/sessions/{session_id}/events` | List persisted events. |
| `GET` | `/v1/sessions/{session_id}/events/stream` | Stream live events with SSE. |
| `POST` | `/v1/sessions/{session_id}/stop` | Stop a session. |
| `DELETE` | `/v1/sessions/{session_id}` | Delete a session from active listings. |

Create a session:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent_assistant",
    "environment_id": "env_default",
    "title": "Local test",
    "resources": [],
    "vault_ids": [],
    "metadata": { "source": "docs" }
  }'
```

`loop_engine` is optional and selects the execution engine for this session only.
Omit it to use the effective Settings default. The selected engine is persisted
and frozen on the session, so later Settings changes do not switch an existing
session. Every session response returns the frozen `loop_engine` value.

Admission is fail-closed and happens before the session row, event log, or
sandbox is touched:

| Requested value | Result |
| --- | --- |
| omitted or `null` | Effective Settings `loop_engine.provider` is used. |
| `builtin` | Harness tool loop, confirmation, and sandbox policy. |
| `pi` | Local Pi CLI adapter; requires Pi on `PATH` and the local sandbox. |
| `harness`, `codex`, `claude` | `400` with `loop_engine_not_supported` and the descriptor reason. |
| any other value or type | `400` with `loop_engine_invalid`. |

The Pi adapter is available but limited: Runs the Pi CLI against the host-local work directory; Pi native tools are not governed by Harness approval or sandbox path policy. An unavailable engine is never silently downgraded to `builtin`.

Pin a session to an immutable agent version snapshot:

```json
{
  "agent": {
    "id": "agent_abc123",
    "type": "agent",
    "version": 1
  },
  "environment_id": "env_default",
  "title": "Replay version 1"
}
```

When `agent.version` is supplied, the runtime stores that agent definition
snapshot on the session. Later edits to the agent do not change the pinned
session's prompt, tools, or skills.

Supported session resources:

```json
[
  {
    "type": "file",
    "file_id": "file_abc123",
    "mount_path": "/uploads/input.txt"
  },
  {
    "type": "github_repository",
    "url": "https://github.com/owner/repo",
    "authorization_token": "ghp_example",
    "checkout": "main",
    "mount_path": "/workspace/repo"
  },
  {
    "type": "memory_store",
    "memory_store_id": "memstore_abc123",
    "access": "read_write",
    "instructions": "Use this for durable project notes."
  }
]
```

Only `user.*` events can be appended by clients:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/events \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "user.message",
        "content": [{ "type": "text", "text": "Hello" }]
      }
    ]
  }'
```

Tool confirmation and client-side custom tool result events are also appended
through the same endpoint:

```json
{
  "events": [
    {
      "type": "user.tool_confirmation",
      "tool_use_id": "toolu_abc123",
      "result": "allow"
    },
    {
      "type": "user.custom_tool_result",
      "custom_tool_use_id": "customu_abc123",
      "content": [{ "type": "text", "text": "Result returned by an external client-side tool." }]
    }
  ]
}
```

The runtime currently supports the event protocol and Console/SDK result
submission. First-class custom tool registration and discovery is still a
planned extension point; until then, clients should treat custom tool use ids as
opaque ids emitted by the session event stream.

Send and stream a message:

```bash
curl -N -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello", "stream": true}'
```

Resume the event stream:

```bash
curl -N http://127.0.0.1:3000/v1/sessions/SESSION_ID/events/stream \
  -H "Last-Event-ID: 42"
```

### Event ordering and metadata

Persisted event responses include an append-only per-session `seq` and optional
`metadata`. The same envelope is used by `GET /events` and the resumable event
tail. SSE uses the numeric `seq` as its `id`; send the highest contiguous value
received as `Last-Event-ID` to replay only later durable events. Transient
`agent.message_stream_*` events have `seq: 0`, are not replayed, and must not
advance that cursor.

Model-derived events may include `model_used`, `tokens_in`, `tokens_out`,
`stop_reason`, and `duration_ms`. Token fields on event projections provide
local attribution only; session usage is recorded once per model request and
is the source for aggregate token totals.

Approval-gated `tool_use` blocks include `requires_confirmation: true` and a
`confirmation_group_id`. The corresponding `user.tool_confirmation` event
stores its target and decision in event metadata. The session stays in
`requires_action` until every tool use in that group has a paired result. The
session response exposes that state as `status: "requires_action"`; the
matching `session.status_idle` event carries metadata with
`stop_reason.type: "requires_action"`, pending `event_ids`, and
`action_type: "tool_confirmation"` for protocol compatibility.

Session event records may include optional execution metadata when available:
`model_used`, `tokens_in`, `tokens_out`, `stop_reason`, and `duration_ms`.
Clients should treat absent fields as unknown and preserve the event's existing
append-only ordering and SSE resume semantics.

### Runs

`POST /v1/runs` starts one turn and returns its result, so a client does not have to
drive the session lifecycle by hand. A run is one turn of one session, so
`run_id` and `session_id` are always the same value.

```json
{
  "agent": "agent_echo-agent",
  "input": "Summarize this repo.",
  "response_mode": "wait",
  "max_wait_seconds": 60
}
```

`response_mode` selects how the answer is delivered:

| Mode | Response |
| --- | --- |
| `wait` (default) | 200 with `run_id`, `session_id`, `status`, `output` (the `agent.message` content blocks), and `usage`. |
| `sse` | An SSE stream of the session's events, ending on a terminal event. |
| `async` | 202 with `run_id`, `session_id`, `status`, `events_url`, and `stream_url`. |

`max_wait_seconds` bounds only the `wait` mode, from 0 to 3600. When it elapses
with the turn still working, the answer is 202 with the query handle and
`wait_deadline_reached: true`. That is a transport deadline, not an execution
timeout: the session keeps running and its terminal state is not pre-empted.

The optional `session` object applies session fields at creation: `title`,
`resources`, `vault_ids`, and `metadata`.

A refusal that happens before a turn starts is answered with its own status
rather than as a runtime fault: an unavailable engine returns
`loop_engine_not_supported`, an unknown value returns `loop_engine_invalid`,
and an unknown agent returns 404. A failure raised while waiting or streaming is
recorded once into the session's event log as `session.error`, so it replays
from `GET /v1/sessions/{id}/events` exactly like one the turn loop recorded
itself.

Session budgets are not part of this endpoint.

### Starting a session with initial events

`POST /v1/sessions` accepts an optional `initial_events` array so a client can
start the agent loop in the same call that creates the session:

```json
{
  "agent": "agent_echo-agent",
  "initial_events": [{ "type": "user.message", "content": "Summarize this repo." }]
}
```

A non-empty list produces a session whose status is `running` and whose event
log already contains every supplied event, in order. An absent field and an
empty array behave the same way: the session is created idle.

Validation runs before any session row, event, or sandbox exists, and creation
and the events commit together, so a rejected batch leaves no session and no
partial history behind:

| Rejection | Error code |
| --- | --- |
| `initial_events` is not an array | `invalid_initial_events` |
| More than 50 events | `too_many_initial_events` |
| An element is not an object | `invalid_initial_events` |
| An element's `type` is not `user.message` | `invalid_initial_event_type` |
| A message `content` is neither a string nor an array of content blocks | `invalid_initial_events` |

The creation response does not echo `initial_events`; list the session's events
to confirm what was written.

### MCP tool identity

`agent.mcp_tool_use` and `agent.mcp_tool_result` events carry the MCP server
that produced the call as `mcp_server_name`, so two servers exposing the same
tool name stay distinguishable in the log. Tool results additionally carry
`mcp_tool_use_id`, the tool use they answer. Non-MCP tool events carry neither
field.

### Usage snapshots

`session.usage` is written immediately before every `session.status_idle`, so a
client can settle the finished turn before it observes the idle transition:

```json
{
  "type": "session.usage",
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 3200,
    "active_seconds": 12.5
  }
}
```

`active_seconds` is the wall-clock time the harness loop was executing the
session, derived from the `session.status_running` → `session.status_idle`
intervals in the durable log. Fields this runtime cannot report truthfully are
omitted rather than sent as zero, because a `0` reads as "supported, currently
zero":

| Field | Status |
| --- | --- |
| `input_tokens`, `output_tokens` | Reported from the session's aggregate token counters. |
| `active_seconds` | Reported. Single-threaded session, so "at least one thread running" is the sum of the turn intervals. |
| `list_cost` | Omitted. No cost model is implemented. |
| `budget` | Omitted. Session budgets are explicitly unsupported. |
| `server_tool_use` | Omitted. No built-in web tools exist. |

`active_seconds` appears only on the snapshot event. The session envelope keeps
its accumulated token counters and does not recompute activity time per
request; read the latest `session.usage` event or the log for that.

## Files

Files can be uploaded once and mounted into sessions.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/files` | List active files. |
| `POST` | `/v1/files` | Upload a file. |
| `GET` | `/v1/files/{file_id}` | Retrieve file metadata and preview. |
| `GET` | `/v1/files/{file_id}/content` | Download file content. |
| `DELETE` | `/v1/files/{file_id}` | Archive a file. |

Multipart upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/files \
  -F "file=@notes.txt"
```

JSON upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/files \
  -H "Content-Type: application/json" \
  -d '{
    "name": "notes.txt",
    "media_type": "text/plain",
    "content": "hello",
    "encoding": "utf8"
  }'
```

The per-file upload limit is 10 MB.

## Session Artifacts

Artifacts are generated outputs associated with a session. They use the same
local artifact storage backend as uploaded files, but are listed under the
session instead of `/v1/files`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sessions/{session_id}/artifacts` | List generated artifacts for a session. |
| `POST` | `/v1/sessions/{session_id}/artifacts` | Record a generated artifact. |
| `GET` | `/v1/sessions/{session_id}/artifacts/{artifact_id}/content` | Download artifact content. |

Artifact paths must start with `/artifacts/`:

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/artifacts \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/artifacts/report.md",
    "name": "report.md",
    "media_type": "text/markdown",
    "content": "# Run report\n\nGenerated locally."
  }'
```

Text, Markdown, JSON, YAML, HTML, and SVG artifacts include inline previews in
metadata responses. Raw storage paths are never returned.

## Skills

Skills are reusable instruction packages. See [Skills](skills.md) for package
format and upload rules.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/skills` | List skills. |
| `POST` | `/v1/skills` | Upload a skill package. |
| `GET` | `/v1/skills/{skill_id}` | Retrieve a skill. |
| `DELETE` | `/v1/skills/{skill_id}` | Delete a custom skill. |

List query parameters:

| Parameter | Purpose |
| --- | --- |
| `limit` | Page size, maximum 100. |
| `page` | Cursor from `next_page`. |
| `source` | `custom` or `anthropic`. |

Upload:

```bash
zip -r code-review-assistant.zip code-review-assistant

curl -X POST http://127.0.0.1:3000/v1/skills \
  -F "files=@code-review-assistant.zip"
```

Skill list responses include `next_page` in addition to the common page fields.

## Environments

Environments describe where sessions run.
Environment names are human-readable labels and do not need to be unique. Use
the returned `env_...` id when creating sessions or updating an environment.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/environments` | List environments. |
| `POST` | `/v1/environments` | Create an environment. |
| `GET` | `/v1/environments/{environment_id}` | Retrieve an environment. |
| `PUT` | `/v1/environments/{environment_id}` | Update an environment. |
| `POST` | `/v1/environments/{environment_id}/archive` | Archive an environment. |
| `GET` | `/v1/environments/{environment_id}/worker-keys` | List self-hosted worker keys without raw secrets. |
| `POST` | `/v1/environments/{environment_id}/worker-keys` | Generate a worker key. The raw key is returned once. |
| `POST` | `/v1/environments/{environment_id}/worker-keys/{key_id}/revoke` | Revoke a worker key. |
| `GET` | `/v1/environments/{environment_id}/work-items` | Inspect recent self-hosted queue items and status counts. |

Create:

```bash
curl -X POST http://127.0.0.1:3000/v1/environments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "local-dev",
    "description": "Local development environment",
    "hosting_type": "local",
    "sandbox_provider": "local",
    "network": {
      "type": "limited",
      "allow_mcp_server_network_access": false,
      "allow_package_manager_network_access": true,
      "allowed_hosts": []
    },
    "packages": []
}'
```

Worker keys and work queues are advanced self-hosted controls. They are not
needed for the default local runtime.

Generate a self-hosted worker key:

```bash
curl -X POST http://127.0.0.1:3000/v1/environments/ENV_ID/worker-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"fde-laptop"}'
```

Responses include `secret_key` only on creation. Later list/detail responses
return `key_prefix`, status, timestamps, and metadata only.

Run a local worker:

```bash
export MANAGED_AGENTS_ENVIRONMENT_KEY='mawk_...'
managed-agents worker poll \
  --environment-id ENV_ID \
  --workdir /path/to/worker/root
```

Worker polling is scoped by the environment key when supplied. The worker can
execute `exec`, `read`, `write`, and `list` work items inside `--workdir`.

## Credential Vaults

Credential vaults group secrets that sessions can attach by id.
Vault names are human-readable labels and do not need to be unique. Use the
returned `vlt_...` id when attaching a vault to a session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/credential-vaults` | List vaults. |
| `POST` | `/v1/credential-vaults` | Create a vault. |
| `GET` | `/v1/credential-vaults/{vault_id}` | Retrieve a vault. |
| `POST` | `/v1/credential-vaults/{vault_id}/archive` | Archive a vault. |
| `GET` | `/v1/credential-vaults/{vault_id}/credentials` | List credentials. |
| `POST` | `/v1/credential-vaults/{vault_id}/credentials` | Add a credential. |
| `POST` | `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/rotate` | Replace the encrypted secret value. |
| `POST` | `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/mark-used` | Mark a credential as used and append an audit event. |
| `GET` | `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/audit` | List credential audit events. |
| `POST` | `/v1/credential-vaults/{vault_id}/credentials/{credential_id}/archive` | Archive a credential. |
| `DELETE` | `/v1/credential-vaults/{vault_id}/credentials/{credential_id}` | Delete a credential. |

Credential `auth_type` values:

- `mcp_oauth`
- `bearer_token`
- `environment_variable`

Add a credential:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-token",
    "auth_type": "environment_variable",
    "variable_name": "GITHUB_TOKEN",
    "value": "ghp_example",
    "network": {
      "type": "limited",
      "allowed_hosts": ["api.github.com"]
    },
    "injection_locations": ["request_headers"]
  }'
```

Secret values are encrypted at rest. Responses return `value_hint`, not the raw
secret.

Rotate a credential:

```bash
curl -X POST http://127.0.0.1:3000/v1/credential-vaults/VAULT_ID/credentials/CREDENTIAL_ID/rotate \
  -H "Content-Type: application/json" \
  -d '{
    "value": "new-secret-value",
    "actor": "operator",
    "metadata": { "reason": "scheduled rotation" }
  }'
```

Runtime code can use the internal `resolveSessionCredentialInjections` helper to
resolve scoped credentials for a session. For a `limited` credential, the caller
must provide a target host and the host must match `allowed_hosts` before the
secret is decrypted. Exact hosts, `*.example.com` subdomains, and optional
ports are supported; a bare `*` does not mean unrestricted. Missing or malformed
policy, an empty allow-list, or an unverified target is denied. Denial happens
before decryption, produces only non-secret `runtime_denied` audit metadata, and
does not update `last_used_at`. Explicit `unrestricted` is the only policy that
can inject without a target host. The helper is an injection-boundary contract;
production web/MCP/custom-tool callers still need to propagate target-host
context before universal enforcement can be claimed.

## Memory Stores

Memory stores persist named memory entries that can be mounted into sessions.
Memory store names are human-readable labels and do not need to be unique.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/memory_stores` | List memory stores. |
| `POST` | `/v1/memory_stores` | Create a memory store. |
| `GET` | `/v1/memory_stores/{store_id}` | Retrieve a memory store. |
| `POST` | `/v1/memory_stores/{store_id}/archive` | Archive a memory store. |
| `GET` | `/v1/memory_stores/{store_id}/memories` | List memories. |
| `POST` | `/v1/memory_stores/{store_id}/memories` | Add a memory. |
| `PUT` | `/v1/memory_stores/{store_id}/memories/{memory_id}` | Update a memory. |
| `DELETE` | `/v1/memory_stores/{store_id}/memories/{memory_id}` | Delete a memory. |

Create a memory:

```bash
curl -X POST http://127.0.0.1:3000/v1/memory_stores/STORE_ID/memories \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/notes/release",
    "content": "Keep release notes concise."
  }'
```

Memory paths must start with `/` and must not end with `/`.

## Operations

Operations APIs persist local control-plane definitions for callbacks,
scheduled runs, and run-quality checks. The current runtime stores these
resources, exposes them through the API, and includes manual validation actions
for webhook test delivery, scheduled run-now, and deterministic outcome
evaluation. Automatic webhook dispatch and cron scheduling remain planned
background workers.

### Webhooks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/webhooks` | List webhook subscriptions. |
| `POST` | `/v1/webhooks` | Create a webhook subscription. |
| `GET` | `/v1/webhooks/{webhook_id}` | Retrieve a webhook subscription. |
| `PUT` | `/v1/webhooks/{webhook_id}` | Update a webhook subscription. |
| `POST` | `/v1/webhooks/{webhook_id}/archive` | Archive a webhook subscription. |
| `GET` | `/v1/webhooks/{webhook_id}/deliveries` | List webhook delivery records. |
| `POST` | `/v1/webhooks/{webhook_id}/test` | Record a signed test delivery without requiring an external network call. |
| `POST` | `/v1/webhooks/dispatch` | Dispatch an event to matching active webhooks. |
| `POST` | `/v1/webhooks/retry-due` | Retry failed deliveries whose retry time has arrived. |

```bash
curl -X POST http://127.0.0.1:3000/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Session events",
    "url": "https://example.com/managed-agents/webhook",
    "events": ["session.status_running", "session.status_terminated"]
  }'
```

Delivery responses include a `signature` field using the `sha256=...` format.
Failed dispatches are stored as `pending_retry` until their next retry time or
as `failed` after the maximum attempts.

### Scheduled Deployments

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/scheduled-deployments` | List scheduled deployment plans. |
| `POST` | `/v1/scheduled-deployments` | Create a scheduled deployment plan. |
| `GET` | `/v1/scheduled-deployments/{schedule_id}` | Retrieve a scheduled deployment plan. |
| `PUT` | `/v1/scheduled-deployments/{schedule_id}` | Update a scheduled deployment plan. |
| `POST` | `/v1/scheduled-deployments/{schedule_id}/archive` | Archive a scheduled deployment plan. |
| `GET` | `/v1/scheduled-deployments/{schedule_id}/runs` | List schedule run records. |
| `POST` | `/v1/scheduled-deployments/{schedule_id}/run` | Manually trigger a schedule and create a session. |
| `POST` | `/v1/scheduled-deployments/run-due` | Run all active schedules whose `next_run_at` is due. |

```bash
curl -X POST http://127.0.0.1:3000/v1/scheduled-deployments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning smoke",
    "agent_id": "agent_...",
    "environment_id": "env_...",
    "cron": "0 9 * * 1",
    "payload": {
      "title": "Daily FDE smoke"
    }
  }'
```

Manual and due runs create a session with schedule metadata and store a
`scheduled_deployment_run` record. The local cron runner computes `next_run_at`
in UTC for standard five-field cron expressions using `*`, comma lists, ranges,
and step values.

### Outcomes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/outcomes` | List outcome definitions. |
| `POST` | `/v1/outcomes` | Create an outcome definition. |
| `GET` | `/v1/outcomes/{outcome_id}` | Retrieve an outcome definition. |
| `PUT` | `/v1/outcomes/{outcome_id}` | Update an outcome definition. |
| `POST` | `/v1/outcomes/{outcome_id}/archive` | Archive an outcome definition. |
| `GET` | `/v1/sessions/{session_id}/outcomes` | List recorded session outcome evaluations. |
| `POST` | `/v1/sessions/{session_id}/outcomes` | Record a session outcome evaluation. |
| `POST` | `/v1/sessions/{session_id}/outcomes/evaluate` | Run the built-in deterministic transcript evaluator for an outcome. |

```bash
curl -X POST http://127.0.0.1:3000/v1/outcomes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Release readiness",
    "objective": "The agent should produce a concise release-readiness summary.",
    "criteria": ["Mentions tests", "Mentions risks"]
  }'
```

Outcome definitions accept `pass_threshold` from `0` to `1`. The local
deterministic evaluator records `passed` when the transcript score meets the
threshold, `inconclusive` for partial matches below the threshold, and `failed`
when no criteria match.

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/outcomes \
  -H "Content-Type: application/json" \
  -d '{
    "outcome_id": "out_...",
    "status": "passed",
    "score": 0.92,
    "summary": "The run met release-readiness criteria."
  }'
```

The built-in evaluator is deterministic and local: it compares outcome criteria
against persisted session event text, records a score, and stores the result in
`session_outcomes`.

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/outcomes/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "outcome_id": "out_..."
  }'
```

## Runtime Extension Endpoints

Extension endpoints expose local runtime operations.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/x/health` | Health check. |
| `GET` | `/v1/x/runtime` | Runtime status. |
| `GET` | `/v1/x/capabilities` | Truthful inventory of locally executable built-in capabilities. |
| `GET` | `/v1/x/workspace` | Workspace paths and metadata. |
| `GET` | `/v1/x/settings` | Read the versioned Settings V2 runtime document. |
| `POST` | `/v1/x/settings/validate` | Validate a complete Settings V2 document without saving. |
| `POST` | `/v1/x/settings/test` | Test one settings area without saving. |
| `PUT` | `/v1/x/settings` | Save a validated Settings V2 document. |
| `GET` | `/v1/x/templates` | Built-in agent templates. |
| `POST` | `/v1/x/reload` | Reload file-backed agents. |
| `POST` | `/v1/x/restart` | Restart the local runtime process when the server was started through the CLI. |
| `GET` | `/v1/x/logs?limit=200&level=info&q=term` | Recent in-process structured runtime logs. |
| `GET` | `/v1/x/metrics` | Prometheus metrics, when enabled. |
| `GET` | `/v1/x/metrics/summary` | JSON runtime summary for Dashboard monitoring and SDK helpers. |
| `GET` | `/v1/x/mcp/status?session_id=...` | MCP connection status for a session. |
| `POST` | `/v1/x/worker/claim` | Self-hosted sandbox worker claims pending tool-execution work. |
| `POST` | `/v1/x/worker/complete` | Self-hosted sandbox worker reports completed or failed work. |

`GET /v1/x/runtime` returns runtime-safe introspection data. Model entries expose
configuration metadata only:

```json
{
  "type": "runtime",
  "status": "running",
  "models": [
    {
      "name": "local",
      "provider": "openai",
      "model": "gpt-4o",
      "api_key_state": "configured",
      "base_url_state": "not_set"
    }
  ],
  "auth_enabled": true
}
```

`GET /v1/x/capabilities` is the source of truth for built-in tool availability.
It returns stable capability records with a `status` and, when unavailable, a
human-readable `reason`:

```json
{
  "type": "capability_inventory",
  "capabilities": [
    { "id": "read", "kind": "tool", "status": "available" },
    {
      "id": "web_fetch",
      "kind": "tool",
      "status": "unavailable",
      "reason": "No safe executable implementation is available in this runtime."
    }
  ]
}
```

Agent create/update and session creation reject enabled unavailable capabilities
with `400 unsupported_capability` before an agent or session is persisted. In
particular, `web_fetch` and `web_search` cannot reach model or tool execution
until safe runtime implementations exist.

### Web tool domain lists

`web_fetch` and `web_search` accept an optional domain list. Expressing a list is
independent of being able to run the tool: a disabled `web_fetch` with a
`blocked_domains` list is a storable declaration of intent, while an enabled
`web_fetch` is still refused by capability admission.

Agent create/update and session creation enforce these rules:

| Rule | Detail |
| --- | --- |
| One list per entry | `allowed_domains` or `blocked_domains`, never both. |
| Non-empty | An empty list is ambiguous and rejected; `null` means no restriction. |
| Size | 1-64 domains, each 1-255 characters. |
| Hostname shape | Plain ASCII hostname. No scheme, port, credentials, wildcard, whitespace, or path. No label may start or end with a hyphen. |
| Not an address | Any IP form is rejected, including bracketed IPv6 and numeric shorthand such as `127.1`. |
| Not internal | `localhost`, `.localhost`, `.local`, `.internal`, `.localdomain`, and `.invalid` are rejected. |
| Not a suffix | Bare registry suffixes such as `com`, `co.uk`, and single-label names such as `intranet` are rejected. |
| Path suffix | `web_fetch` domains carry no path; `web_search` may carry one suffix without whitespace or any of `? # $ , | ^ !`. |
| Unique | Duplicates are rejected after lowercasing and stripping one trailing slash. `www.example.com` does not stand in for `example.com`. |

`max_content_tokens` is accepted only on `web_fetch`; `user_location` only on
`web_search`.

A rejected list answers `400 invalid_request_error` naming the exact list and
zero-based index, for example `tools.0.configs.1.allowed_domains.2`.

The runtime never returns raw API keys or resolved secret values to the Console.

Settings V2 is the source of truth for model vendor, loop engine, storage,
memory, and sandbox configuration. Responses include both the saved document and
the effective document currently used by the process. Response excerpt:

```json
{
  "schema_version": 1,
  "revision": 2,
  "effective_revision": 1,
  "saved_config": {
    "schema_version": 1,
    "model": {
      "vendor": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "********",
      "options": {}
    }
  },
  "effective_config": {},
  "restart_required": true,
  "activation_status": "pending",
  "activation_errors": [],
  "diagnostics": {
    "metadata": {
      "path": ".managed-agents/data.db",
      "health": "ok"
    }
  },
  "secret_states": {
    "model": {
      "api_key": "configured"
    }
  },
  "adapters": {
    "loop_engine": [
      {
        "id": "builtin",
        "label": "Default",
        "status": "available",
        "restart_policy": "runtime",
        "options_schema": {
          "type": "object",
          "properties": {
            "default_max_steps": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000,
              "default": 25
            }
          },
          "additionalProperties": true
        }
      }
    ]
  }
}
```

Secret-looking adapter option keys, including `api_key`, `access_key`,
`secret`, `token`, `password`, and `credential`, are always masked in public
settings responses.
Adapter descriptors include backend-owned `options_schema` metadata for
adapter-specific options.

The Dashboard validates a changed candidate before enabling save, and API
clients should follow the same sequence: `GET /v1/x/settings`, edit the complete
document, `POST /v1/x/settings/validate`, optionally `POST /v1/x/settings/test`,
then `PUT /v1/x/settings` with the current `revision`. A successful save updates
`saved_config` and sets `restart_required` when the running process still uses
the older `effective_config`. The next CLI-managed restart promotes the last
valid saved revision to `effective_config`. If a saved row is corrupted outside
the API, startup keeps the last valid effective document instead of activating
the bad candidate and returns `activation_status: "failed"` with
`activation_errors` on subsequent settings reads until the saved document is
repaired.

Validate a candidate document:

```bash
curl -X POST http://127.0.0.1:3000/v1/x/settings/validate \
  -H "Content-Type: application/json" \
  -d @settings.json
```

Test one area without saving:

```bash
curl -X POST http://127.0.0.1:3000/v1/x/settings/test \
  -H "Content-Type: application/json" \
  -d '{
    "area": "storage.artifacts",
    "config": {
      "provider": "local",
      "options": {
        "base_path": "files"
      }
    }
}'
```

Model tests apply the same credential validation used by validate and save.
Other area tests are scoped to their adapter so local storage, memory, and
sandbox diagnostics can run before a model API key has been configured.
Those scoped checks still validate credentials that belong to the tested area.
Docker sandbox checks currently skip live daemon/image validation. Remote
sandbox checks require the worker API URL and key, then call
`/v1/x/health` on that remote worker API.

Save the complete document with optimistic concurrency:

```bash
curl -X PUT http://127.0.0.1:3000/v1/x/settings \
  -H "Content-Type: application/json" \
  -d '{
    "revision": 2,
    "config": {
      "schema_version": 1,
      "model": {
        "vendor": "openai",
        "api_key": "${OPENAI_API_KEY}",
        "options": {}
      },
      "loop_engine": {
        "provider": "builtin",
        "options": {
          "default_max_steps": 25
        }
      },
      "storage": {
        "metadata": {
          "provider": "sqlite",
          "options": {}
        },
        "artifacts": {
          "provider": "local",
          "options": {
            "base_path": "files"
          }
        }
      },
      "memory": {
        "enabled": true,
        "provider": "sqlite",
        "options": {}
      },
      "sandbox": {
        "provider": "local",
        "options": {
          "timeout_seconds": 300
        }
      }
    }
  }'
```

Literal secrets are encrypted at rest. API responses return masked placeholders
and `secret_states`; they never return plaintext or ciphertext.

Successful saves emit a `runtime_settings_saved` structured log with only the
old revision, new revision, changed JSON paths, and restart flag. Secret values
and internal managed-secret references are not logged.

`GET /v1/x/logs` returns a standard page envelope with the most recent log
entries captured by the current process. `level` is a minimum severity filter
(`debug`, `info`, `warn`, or `error`), and `q` searches the rendered log line.
The in-memory buffer is intended for local operations and is reset when the
runtime restarts.

`POST /v1/x/restart` schedules a local runtime restart and returns:

```json
{
  "restarting": true,
  "status": "scheduled"
}
```

Embedded test servers or custom hosts that do not provide a restart hook return
`501 unsupported`. When available, restart stops accepting requests, drains the
session manager, closes SQLite, and starts a new process with the same command
line arguments.

## Pi lifecycle status boundary

When `loop_engine.provider` is `pi`, the API may expose `cancelled`,
`timed_out`, or `cleanup_pending` rather than collapsing every child-process
outcome into `failed` or `terminated`. `cleanup_pending` is fail-closed: the
runtime has not proved that the process tree released the workspace, so it does
not clean up or accept a new turn. A live cross-runtime Pi session-file owner
returns a retryable `pi_session_busy` error. Resume refusal, corrupt headers,
path/schema mismatch, and missing SQLite continuity proof are visible errors;
they never silently start a second Pi history.

Pi-native tool events are trajectory records only. They do not carry Harness
`requires_confirmation`, do not run through the builtin `ToolResolver`, and do
not receive Harness local path confinement or an Allow/Deny card. Docker and
Kubernetes Pi transport, RPC, and a Pi-to-Harness approval bridge are not part
of this local demo.
