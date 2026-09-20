# Versioned API Matrix

This matrix tracks the public `/v1` API shape for the open-source runtime. It
is a compatibility guide for SDK authors and integrators; it is not a promise
that every Claude hosted capability exists locally.

## Version Policy

- The current public namespace is `/v1`.
- Resource ids are opaque.
- Collection responses use `{ data, has_more, first_id, last_id }`.
- Errors use `{ error: { type, message } }`.
- CMA requests using `x-api-key`, `anthropic-version`, or `anthropic-beta` are
  admitted before `/v1` CMA handlers: version `2023-06-01` and beta
  `managed-agents-2026-04-01` are required, except `/v1/memory_stores` routes
  require `agent-memory-2026-07-22`. Memory-store requests reject a combined
  managed-agents and agent-memory beta; `GET /v1/memory_stores/{id}/memories`
  accepts either beta. A request must carry exactly one of `Authorization` or
  `x-api-key`; existing bearer requests without CMA compatibility headers remain
  supported.

- A protected runtime applies best-effort in-process fixed-window inbound throttling after authentication: 300 write requests/minute and 1200 read requests/minute by default, credential-scoped buckets, structured `429` responses, and no counting for `/v1/x/health` or CORS `OPTIONS` preflight. Open local runtimes are unlimited by default; environment overrides are documented in `docs/api.md`.

## `/v1` Resource Matrix

| Area | Endpoint group | Status | Notes |
| --- | --- | --- | --- |
| Agents | `/v1/agents` | Supported | Create, list, retrieve, update, archive, and list versions. Create and update validate `web_fetch` and `web_search` domain lists against the published grammar and reject a malformed list with `invalid_request_error` naming the list and index. The `model` field accepts the canonical object form and carries `effort` through, while an unrecognized or unsupported field is refused by name with `unsupported_model_field`. |
| Sessions | `/v1/sessions` | Supported | Create, list, retrieve, stop, delete, durable event ingestion/listing, sequence-resumable SSE, and message convenience endpoint A stream connection can opt into token-level previews with a repeated `event_deltas[]` parameter for `agent.message` and `agent.thinking`; preview frames carry no id and are never persisted. | Creation also accepts an optional `initial_events` array of `user.message` events that are validated and written in the same transaction, so a non-empty list yields a `running` session whose log already holds them and a rejected batch leaves no session behind. Create accepts optional `loop_engine`; the resolved engine is persisted and frozen on the session. Unavailable engines return `loop_engine_not_supported`, unknown values return `loop_engine_invalid`, and rejected requests leave no session row or event. Session status includes `requires_action` while an approval group is pending. Event envelopes include `seq`, immutable metadata, and optional model/token/stop-reason/duration metadata. A `session.usage` snapshot event carrying `input_tokens`, `output_tokens`, and `active_seconds` is written immediately before every `session.status_idle`; cost, budget, and server-tool counters are omitted rather than reported as zero. `agent.mcp_tool_use` and `agent.mcp_tool_result` events carry `mcp_server_name` (and results carry `mcp_tool_use_id`) so two servers exposing the same tool name stay distinguishable. Pi stdout final replies and native tool trajectories use the same event history; transient deltas are not replayed; Pi native tools remain outside Harness approval and sandbox path policy. Pi cleanup may surface `cancelled`, `timed_out`, or `cleanup_pending` rather than fabricated success. | Creation validates web-tool domain lists on the supplied agent definition and rejects a malformed list before the session is persisted. |
| Runs | `/v1/runs` | Supported | Start one turn and return its result. `response_mode` selects `wait` (200 with output and usage), `sse` (event stream), or `async` (202 with a query handle); `max_wait_seconds` bounds only the wait and answers 202 with `wait_deadline_reached` when it elapses. Pre-execution refusals answer with their own status, and a mid-run failure is recorded once as `session.error`. Session budgets are not part of this endpoint. |
| Session errors | `session.error` event | Supported | Every failed turn appends one `session.error` whose top-level `error` object carries `type`, `message`, and `retry_status`. The disposition is derived from the error code, an unrecognized code reports `unknown`, and an aborted turn records nothing. |
| Session artifacts | `/v1/sessions/{id}/artifacts` | Supported | Create/list artifact records and fetch content. |
| Files | `/v1/files` | Supported | Upload/list/retrieve/delete workspace files and fetch content. A file attached to a session takes a logical `mount_path` that the runtime maps under its own mount root, so the sandbox layout is never part of the public field. |
| Environments | `/v1/environments` | Supported | Create/list/retrieve/update/archive environment templates. |
| Environment worker keys | `/v1/environments/{id}/worker-keys` | Advanced | Create/list/revoke scoped self-hosted worker keys; not needed for the default local runtime. |
| Environment work queue | `/v1/environments/{id}/work-items` | Advanced | Inspect recent queued self-hosted work and queue stats; not needed for the default local runtime. |
| Credential vaults | `/v1/credential_vaults` | Supported | Create/list/retrieve/update/archive/delete vaults. |
| Vault credentials | `/v1/credential_vaults/{id}/credentials` | Supported | Create/list/update/delete credentials with secret redaction. |
| Credential audit | `/v1/credential_vaults/{id}/audit` | Supported | Lists rotation/use/audit metadata events. |
| Memory stores | `/v1/memory_stores` | Supported | Create/list/retrieve/update/archive/delete stores. |
| Memory records | `/v1/memory_stores/{id}/memories` | Supported | Create/list/update/delete memory records with size/hash metadata. |
| Skills | `/v1/skills` | Supported | List built-in/custom skills and upload validated custom ZIPs. |
| API keys | `/v1/api-keys` | Supported | List/create/delete managed keys; config/env keys are read-only. |
| Webhooks | `/v1/webhooks` | Advanced | Create/list/update/archive, test deliveries, attempts, and retry due deliveries. Not needed for the first local run. |
| Scheduled deployments | `/v1/scheduled-deployments` | Advanced | Create/list/update/archive/pause/unpause/run/run-due schedules. Not needed for the first local run. |
| Outcomes | `/v1/outcomes` and `/v1/sessions/{id}/outcomes` | Advanced | Create/list/update/archive outcomes and evaluate sessions. Not needed for the first local run. |
| Runtime capabilities | `/v1/x/capabilities` | Supported | Canonical executable built-in capability inventory. `web_fetch` and `web_search` are explicitly unavailable and rejected before agent/session persistence, while a declared domain list on either tool is validated independently of executability. |
| Runtime settings | `/v1/x/settings` | Supported | Read/patch/validate canonical runtime settings for one active model provider boundary, loop engine, metadata store, artifact store, memory backend, and sandbox backend. The `pi` loop-engine option freezes the selected provider on each new session, requires a locally installed Pi CLI and the local sandbox provider, and routes validated stdout JSONL into the same durable session events; session-file continuity remains out of scope for this behavior. |
| Runtime operations | `/v1/x/health`, `/v1/x/logs`, `/v1/x/metrics`, `/v1/x/metrics/summary`, `/v1/x/restart` | Supported | Health, logs, Prometheus-style metrics, summary cards, and local restart hook. |
| Worker queue | `/v1/x/worker/claim`, `/v1/x/worker/complete` | Advanced | Used by `managed-agents worker poll` when running a self-hosted worker. |
| Custom client tools | Session events and SDK helpers | Partial | Custom tool result submission is supported; first-class tool registration/discovery is planned. |
| Hosted cloud deployment | N/A | Missing | The open-source runtime runs locally or in user-owned infrastructure. |

## SDK Coverage

| SDK resource | Coverage |
| --- | --- |
| `client.agents` | list, get, create, update, versions, archive |
| `client.sessions` | create, get, list, events, send event, message, chat, tail, artifacts, create artifact, artifact text, stop, delete, interrupt, approve/deny tool, submit custom tool result |
| `client.files` | list, get, create, text, delete |
| `client.apiKeys` | list, create, delete |
| `client.metrics` | Prometheus text and runtime summary |
| `client.settings` | get, patch, validate canonical runtime settings |
| `client.environments` | list, get, create, update, archive, worker keys, create/revoke worker key |

## CLI Coverage

| CLI group | Coverage |
| --- | --- |
| `managed-agents init/start/list/reload/chat` | Core local lifecycle and chat workflows. |
| `managed-agents session ...` | Create, message, tail, inspect, and logs. |
| `managed-agents worker poll` | Advanced self-hosted environment worker queue execution. |
| `managed-agents settings ...` | Get, set model boundary, and validate canonical runtime settings. |
| `managed-agents environments ...` | List, inspect, create, update, archive, and list worker keys. |
| `managed-agents workspace ...` | Create, open/register, list, resolve, and remove local workspace registry entries. |
| `managed-agents template ...` | List, install, and create templates. |

## Compatibility Gaps To Track

- Client-side custom tools need named registration/discovery above the current
  event result protocol.
- Desktop workspace switching still needs a process manager; the CLI registry
  supplies the durable workspace index.
- Additional sandbox provider packages should be separated from the core once
  provider contracts stabilize.
- Historical provider CRUD endpoints, the old `client.modelProviders` SDK
  helper, and the old `managed-agents models ...` CLI command have been
  removed from the v1 public surface. The canonical v1 path is
  `/v1/x/settings`.
- Browser Dashboard smoke tests require an environment that allows binding a
  local HTTP port.
