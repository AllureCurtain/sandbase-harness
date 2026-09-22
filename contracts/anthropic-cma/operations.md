# CMA Contract — operations

Contract area: the operational surface that runs without a caller driving it —
webhook subscriptions and their delivery behaviour, and scheduled deployments.
Status: `partial` for both, see §4 and §7.
Source: `src/api/routes/operations.ts`,
`src/core/operations/webhook-dispatcher.ts`,
`src/core/operations/webhook-signature.ts`, `src/core/operations/cron.ts`,
`src/core/operations/scheduler.ts`, `src/core/operations/outcome-evaluator.ts`.

---

## 1. Official definition

Two published documents cover this area:

- **Webhooks.** A subscription is created with a URL and a list of event names.
  A delivery is a *reference*, not the resource: the body is
  `{type: "event", id, created_at, data}`, where the root `type` is the literal
  `event` and the event's own name and subject live in
  `data.type` / `data.id`. The receiver performs a `GET` by that pair to read
  current state. Requests carry `webhook-id`, `webhook-timestamp` and
  `webhook-signature`; the signature is a Standard Webhooks `v1,<base64>`
  HMAC-SHA256 computed over `id + "." + timestamp + "." + body`. Delivery
  retries up to three times per endpoint and event with 5–120 s jittered
  exponential backoff, and the same `event.id` is carried on every attempt so a
  receiver can deduplicate. An endpoint is automatically `disabled` with a
  machine-readable `disabled_reason` on a `3xx` (never followed), on a URL that
  resolves to a non-public address, or after a sustained duration of failures —
  and a single `2xx` resets that window. Disabling is reversible; events
  published while disabled are not replayed.
- **Scheduled deployments.** A deployment is a stored session template plus a
  cron cadence and a timezone. Triggers produce deployment-run records with a
  `trigger_context` (`schedule` with `scheduled_at`, or `manual`). Lifecycle
  changes are published as `deployment.*` and `deployment_run.*` webhook
  events. The failure behaviour is asymmetric by design: a rate-limited session
  creation is recorded as a run and *not* retried (the next cadence tries
  again), an archived *child* agent or other unrecoverable session-creation
  failure records a failed run and *auto-pauses* the deployment with
  `paused_reason.error.type` mirroring the run's `error.type`, and the
  deployment's *own* agent being archived or deleted auto-archives the
  deployment in the same operation **without** recording a run.

## 2. Current SandBase shape

Webhooks live under `/v1/webhooks`, mounted at both `/v1` and `/v1/x` by
`src/api/server.ts`, so the compatibility mirror is real. Subscriptions are
created, read, updated and archived over REST, and `operations.ts` adds a
test-delivery route, a delivery list, a manual `POST /webhooks/dispatch` and a
manual `POST /webhooks/retry-due`. There is no disable or re-enable route, and
nothing in the runtime writes `webhooks.status` after creation: a subscription
is created `active` (the schema default) and stays `active` until archived.

`webhook-dispatcher.ts` is the delivery engine:

- `dispatchWebhookEvent` selects `archived_at IS NULL AND status = 'active'`
  rows, matches the event name against each subscription's `events` array
  (exact, `*`, or a `prefix.*` wildcard), and delivers synchronously, returning
  one delivery record per match.
- `makePayload` builds the local envelope
  `{type: 'webhook_event', id, event, webhook_id, data, created_at}`. The root
  `type` is the local `webhook_event` literal and the event name is a top-level
  `event` field, so the body is not the published reference envelope. The
  resource is not inlined, which is the one property it shares with the
  published shape.
- Every attempt sends the legacy `X-Managed-Agents-Signature`
  (`sha256=<hex>` over the body) *and* the published `webhook-id`,
  `webhook-timestamp` and `webhook-signature` headers, the last computed by
  `webhookDeliverySignature` over `id.timestamp.body`. The stored `signature`
  column holds the legacy value, so its meaning does not change with the header
  set. A retry keeps the delivery id and re-signs with its own timestamp, so the
  published header set is continuous across attempts.
- Each subscription is signed with its own `whsec_` secret, minted by `M038` when
  the subscription is created and returned by that response only; the row keeps it
  encrypted with the same AES-256-GCM store the credential vaults use. A
  subscription written before `M038` holds no secret and keeps the legacy
  derivation — the workspace data-directory value this runtime used before
  per-endpoint secrets existed — because inventing one during the migration would
  silently invalidate every receiver still verifying with the old key.
- Rotating a subscription mints a new secret and keeps the previous one valid — the
  `secret_previous_*` columns of `M039` — so every delivery carries both signatures,
  current first, until `retire-secret` is called. The previous secret is replaced
  rather than accumulated, so rotating twice without retiring leaves one window
  rather than a growing list, and rotating a subscription that had no stored secret
  is the call that takes it off the legacy derivation, which is why the new value is
  returned by that response alone.
- `nextRetryAt` is a fixed `2 ** (attempt - 1) * 60` seconds — 60 s, then
  120 s — with `maxAttempts` defaulting to 3 and no jitter.
- `retryDueWebhookDeliveries` takes `pending_retry` rows whose `next_retry_at`
  has elapsed, joined to a non-archived active subscription, and re-attempts up
  to 50 of them.
- A failure is recorded on the delivery row (`pending_retry` until the ceiling,
  then `failed`). It is never written back to the subscription and never raises
  a disable.

The runtime composes an operations bridge at startup: it registers a broadcast
listener that projects every durable session event to the matching subscriptions,
re-arms the forward schedule of active deployments, and starts one 60-second tick
that retries due deliveries and runs due deployments. `POST /v1/webhooks/dispatch`
and `POST /v1/webhooks/retry-due` remain for a caller that wants a pass on demand.
No disable policy exists: the published disable rules — the `3xx` rule, the
private-address rule, the sustained-failure window, `disabled_reason`, and the
reset-on-success rule — have no implementation here, and neither does the
published 5–120 s jitter.

Scheduled deployments live under `/v1/scheduled-deployments`, the historical
local spelling only; there is no `/v1/deployments` alias. `operations.ts`
exposes create, read, update, archive, `POST /:id/run`, `GET /:id/runs` and
`POST /run-due`, and no pause or unpause route.

`scheduler.ts` is the run engine:

- `nextCronRun` refuses an unrecognized zone rather than defaulting to UTC and
  delegates the arithmetic to `cron.ts`.
- `runDueScheduledDeployments` selects active, unarchived rows whose
  `next_run_at` is due and runs each one.
- `runSchedule` computes the next occurrence in the deployment's own zone,
  creates a session through `sessionManager.create`, records a
  `scheduled_deployment_runs` row, and advances `last_run_at` / `next_run_at` in
  both the success and the failure path.
- Failure handling is symmetric inside one `try`/`catch`: success records a
  `created_session` run, and any thrown error records a `failed` run with the
  message. There is no rate-limit branch, no `classifyRunError`, no
  `pauseForError`, no preflight of the deployment's own agent, no auto-pause and
  no auto-archive.
- `initial_events` is never passed. The session is created with `agent`,
  `environmentId`, `title` and a `metadata` block carrying
  `scheduled_deployment_id`, `scheduled_deployment_run_id` and `trigger_type`,
  so the trigger is a value in run metadata rather than a `trigger_context`.

`timezone` is a real column on `scheduled_deployments` (migration `M037`) and
`scheduleTimeZone` reads it, falling back to `UTC` for a row written before the
column existed. The create and update routes validate the name, so a stored
schedule is always evaluable. `deployment.*` and `deployment_run.*` have no
producer: no code path names either event.

## 3. Alignment

Alignment is partial, and asymmetric between the two sub-areas.

**Cron semantics — aligned.** `cron.ts` evaluates a five-field expression in the
deployment's IANA zone, a wall time inside a spring-forward gap yields no run
rather than a shifted one, and a fall-back overlap resolves to its first
instant. `nextCronRun` refuses an unknown zone, and `M037` plus the route-level
validation means the stored zone is the zone the cadence actually runs in.

**Signature arithmetic — correct, but only half-wired.**
`webhook-signature.ts` implements the published scheme: `whsec_` + base64 key
derivation, `id.timestamp.body` as the signed content, `v1,<base64>` output, a
constant-time verifier, and a space-separated rotation window.
`verifyWebhookDelivery` recomputes the signature, so the format is asserted
rather than assumed. The header set is wired into every attempt: a retry keeps
the delivery id and carries its own timestamp. The one local choice left is the
persisted `signature` column, which holds the legacy value.

**The rest is local behaviour that overlaps the published contract in name
only.** The delivery envelope, the disable policy, the retry schedule, the
deployment endpoint paths, the control surface, the trigger representation and
the failure behaviour are all either absent or implemented differently, as §4
records.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Delivery payload envelope | The published body is `{type: "event", id, created_at, data: {type, id}}` so a receiver reads current state by `data.type` / `data.id`. The local body is `{type: "webhook_event", id, event, webhook_id, data, created_at}`. A handler written for the published envelope cannot read this one. |
| Automatic disable | Not implemented. There is no `3xx` rule, no private-address check, no sustained-failure window, no `disabled_reason`, no reset-on-success, and no route that could re-enable an endpoint. |
| Private-address rule | Absent rather than opt-in. No code inspects the resolved address of a subscription URL, so no reason string exists to fire. |
| Retry backoff | Fixed 60 s and 120 s, with no jitter. The three-attempt ceiling matches the published one. |
| Secret rotation | A window is opened by `POST /v1/webhooks/{id}/rotate-secret` and closed by `POST /v1/webhooks/{id}/retire-secret`, with both signatures carried in `webhook-signature` while it is open. Nothing retires the previous secret automatically: the operator decides when the old value stops being accepted, because only they know when every receiver has moved. |
| Delivery trigger | The runtime's own bridge ticks every 60 seconds and projects each durable event as it is broadcast, so an unwatched runtime delivers; `POST /webhooks/dispatch` and `POST /webhooks/retry-due` remain for on-demand passes. The published jittered 5–120 s backoff is not implemented: the local schedule is a fixed 60 s then 120 s. |
| Subscription management surface | REST under `/v1/webhooks` with the `/v1/x` mirror; no disable or enable route. |
| Webhook event vocabulary | Subscriptions name SandBase event types. No `deployment.*` or `deployment_run.*` event has a producer, and the runtime publishes its own names (`session.updated`, `turn_complete`, `span.*`). |
| Deployment endpoint paths | The historical local `/v1/scheduled-deployments` is served; there is no `/v1/deployments` alias, so a client written against the published path gets no route. |
| Deployment control surface | Create, read, update, archive, manual run and run-due. No pause and no unpause. |
| Trigger representation | `trigger_type` is a key in the session's and the run's metadata. There is no `trigger_context` field and no `schedule` / `manual` polymorphic payload. |
| Session startup | `sessionManager.create` without `initial_events`; a schedule cannot seed startup events the way the canonical session path can. |
| Failure behaviour | Symmetric: every thrown session-creation error records a `failed` run and advances the cadence. No split by error class, no failure class recorded beyond the message, no preflight, no auto-pause, no auto-archive. |
| Re-arming after downtime | A consequence of the persisted `next_run_at`, not a startup step. A runtime that was down while a slot passed runs those rows only when `run-due` is next called. |
| Outcome evaluation | The published contract has no deterministic outcome evaluator; `evaluateDeterministicOutcome` is a local extension used by the operations routes. |
| Collection envelope | Extension collections use the local `has_more` / `first_id` / `last_id` envelope rather than the canonical `{data, prev_page, next_page}` cursors. This is the documented extension-envelope rule, not a per-endpoint choice. |

## 5. Reason for the difference

- The runtime implemented the operations *resources* first — a subscription
  table, a delivery table, a schedule table, a run table — and the published
  contract describes the hosted service's *lifecycle* behaviour on top of the
  same resources. The gap is behavioural, not structural, which is why the
  entries are `partial` rather than `unavailable`.
- No disable policy is the largest gap. The published rule defends a
  multi-tenant service against agent-authored URLs, and a self-hosted runtime
  pointing a webhook at `127.0.0.1` is exactly the case a default-on
  private-address rule would break — that is a reason not to enable it by
  default, not a reason to describe it as opt-in when no check exists at all.
  The disable *mechanism* is genuinely absent, and is named here as such.
- The runtime owns the delivery loop now, and owns its shutdown story with it: the
  timer is `unref`'d so it cannot keep a process alive on its own, and the runtime
  stopper clears it. The earlier caller-driven design avoided that responsibility
  at the cost of delivering nothing while nobody polled, which is the trade this
  replaces.
- The deployment failure split is absent because the scheduler never grew a
  preflight step. Recording the failure and advancing the cadence does not lose
  the error, but it does lose the operator signal the published contract
  provides, so the asymmetry is documented as missing rather than approximated.
- Fire-and-forget remains the right disposition for both: a webhook delivery
  must not be able to fail a turn, and a deployment runs on its own cadence.

## 6. Corresponding tests

- `tests/unit/webhook-signature.test.ts` — secret minting (`whsec_` + base64,
  distinct per call), key derivation (decoded bytes, unprefixed raw UTF-8, and
  the malformed-body fallback), coverage (the `v1,<base64>` form and
  `id.timestamp.body` binding), verification (a correctly signed delivery, a
  tampered body, id or timestamp, a wrong secret, an empty header, and any
  signature in a rotation window), and the published header names.
- `tests/unit/webhook-dispatcher.test.ts` — dispatch to matching active
  subscriptions with a stored signed delivery record, the published header set
  on every attempt with the delivery id unchanged across a two-attempt retry,
  and a failed delivery queued as `pending_retry` and later marked delivered.
- `tests/integration/webhook-endpoint-secret.test.ts` — the secret returned once at
  creation and absent from every read, the row holding ciphertext that decrypts
  back to it (including from a second handle), a different secret per
  subscription, a test delivery signed with the endpoint's own secret, and a
  subscription written before `M038` still resolving to the legacy key.
- `tests/integration/webhook-secret-rotation.test.ts` — a rotation returns the new
  secret once and no read returns either value, a delivery carries the current
  signature first and the previous one second until `retire-secret` closes the
  window, a second rotation replaces the window rather than appending to it, an
  unknown subscription is a 404, and a subscription with no stored secret gains one
  and leaves the legacy derivation behind.
- `tests/integration/operations-bridge.test.ts` and
  `tests/integration/operations-runtime-composition.test.ts` — the broadcast
  listener projects a durable event to a matching subscription, the timers retry a
  due delivery and run a due deployment, and a composed runtime has both a listener
  and a running timer that its stop function clears.
- `tests/unit/cron-timezone.test.ts` — the field grammar, the refusal of a
  malformed or out-of-range field and of an unknown zone, the same wall time
  resolving to different instants per zone, the instant moving across a DST
  boundary, a spring-forward gap reporting no run, and successive occurrences
  without a repeat.
- `tests/unit/scheduler.test.ts` — the next cron run, and running due schedules
  while advancing `next_run_at`.
- `tests/integration/scheduled-deployment-timezone.test.ts` — the stored
  `timezone` column and its `NOT NULL DEFAULT 'UTC'` shape, the zone being
  resolved into `next_run_at`, both accepted wire shapes (`cron` + `timezone`,
  and the nested `schedule` object), an unknown zone refused with no row
  written, cadence re-arming on update, and a runner-level check that two due
  rows differing only in `timezone` advance in their own zones.
- `tests/unit/outcome-evaluator.test.ts` — deterministic criteria evaluation and
  the honest unsupported result when no model provider exists.

## 7. Status

`partial` for both, and the reason is no longer narrow. Cron-in-zone, the
signature arithmetic, the per-endpoint secret, the published headers on every
attempt and the background tick that delivers without a caller are the aligned
parts. The published delivery envelope, the entire
auto-disable policy, the deployment endpoint alias, the pause/unpause surface, the
`trigger_context` representation, the lifecycle event names and the asymmetric
failure split are absent, and are listed in §4 so that "covered by a contract" does
not read as "implemented". Neither entry is `supported`; neither is `unavailable`, because
the resource, the delivery engine, the scheduler and the run records are real
and exercised by the tests in §6. No claim is made that a client written against
the published contract works unchanged.
