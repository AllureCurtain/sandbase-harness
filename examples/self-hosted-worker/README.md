# Self-hosted worker: one clean container per claim

The published worker contract separates the **poller** from the **sandbox**: a
long-running poller claims work items, and each claim is served by a fresh
container running `managed-agents worker run`. This directory is the copyable
reference for that pattern.

- `spawn-docker.sh` — the `--on-work` handler. Forwards the claim's environment
  and the item's `secret` into a fresh `docker run --rm` container whose
  entrypoint is `worker run`, with a per-session host directory mounted at
  `/workspace` so deliverables survive the container.
- `webhook-handler.mjs` — the webhook-triggered alternative to an always-on
  poller. Verifies the Standard Webhooks signature (`whsec_` key, `v1,`
  HMAC-SHA256 over `id.timestamp.body`), and on `session.status_run_started`
  starts a `worker poll --on-work` to drain the queue.

## Always-on polling

```bash
export MANAGED_AGENTS_ENVIRONMENT_KEY='mawk_...'
managed-agents worker poll \
  --port 3000 \
  --environment-id env_self_hosted \
  --on-work ./spawn-docker.sh
```

The script needs `jq` and `docker` on the poller host. `SPAWN_IMAGE` overrides
the image (default `ghcr.io/sandbaseai/sandbase-sandbox:latest`) and
`SPAWN_OUTPUTS_DIR` the per-session output root (default `./.worker-outputs`).
A `localhost`/`127.0.0.1` base URL is remapped to `host.docker.internal` so the
container reaches the runtime on the host.

## Webhook-triggered polling

When the host should run nothing while idle, let a webhook start the poller
instead. The runtime delivers `session.status_run_started` every time a
session transitions to running.

1. Subscribe an endpoint to `session.status_run_started` — in the Console's
   webhooks page or via `POST /v1/x/operations/webhooks` — pointed at this
   handler, and copy the `whsec_` signing secret shown once at creation.
2. Export it and start the handler on a port the runtime can reach:

   ```bash
   export MANAGED_AGENTS_WEBHOOK_SIGNING_KEY='whsec_...'
   export MANAGED_AGENTS_ENVIRONMENT_KEY='mawk_...'
   export MANAGED_AGENTS_ENVIRONMENT_ID='env_self_hosted'
   WEBHOOK_PORT=8080 node webhook-handler.mjs
   ```

3. Each verified `session.status_run_started` delivery launches
   `managed-agents worker poll --on-work ./spawn-docker.sh`, which claims and
   spawns until the queue is dry — the same drain the always-on poller does,
   started on demand.

Deliveries are retried while the handler is down, so a restarted endpoint picks
the event up rather than losing it.

## The contract in one paragraph

The poller claims a work item and spawns the `--on-work` command with the item
JSON on stdin — `id`, `sessionId`, `kind`, `payload`, and `secret` (a
base64url `{sessions_token, api_base_url}` envelope minted per claim) — plus
`MANAGED_AGENTS_WORK_ID`, `MANAGED_AGENTS_SESSION_ID`,
`MANAGED_AGENTS_ENVIRONMENT_ID`, `MANAGED_AGENTS_ENVIRONMENT_KEY`,
`MANAGED_AGENTS_WORKER_ID`, `MANAGED_AGENTS_BASE_URL`, and
`MANAGED_AGENTS_API_KEY` in its environment. The secret is the exception: it is
never in the poller-side environment — the handler reads it from stdin and
forwards it into only the container that serves that session. Never log it.
