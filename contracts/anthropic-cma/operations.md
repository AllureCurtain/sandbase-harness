# CMA Contract — operations

Contract area: the operational surface that runs without a caller driving it —
webhook subscriptions and their delivery behaviour, and scheduled deployments.
Status: `partial` for both, see §4.
Source: `src/api/routes/operations.ts`, `src/api/operations-bridge.ts`,
`src/core/operations/webhook-dispatcher.ts`,
`src/core/operations/webhook-signature.ts`, `src/core/operations/cron.ts`,
`src/core/operations/scheduler.ts`, `src/core/operations/outcome-evaluator.ts`,
`src/index.ts`.

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

Webhooks live under `/v1/webhooks` (canonical, with the `/v1/x/webhooks`
compatibility mirror). Subscriptions are created, read, updated, archived,
disabled and re-enabled over REST. `POST /v1/webhooks` mints a per-endpoint
`whsec_` secret with `generateWebhookSecret()` and returns it exactly once;
`toWebhook` never projects the column back, so the write-once property survives
a later read.

Delivery is implemented in `webhook-dispatcher.ts`:

- `makePayload` emits `{type: 'event', id, created_at, data: {type, id, ...}}`.
  The resource itself is never inlined, so a retried delivery cannot carry a
  snapshot the resource has moved past.
- `signAttempt` signs `id + "." + timestamp + "." + body` via
  `signWebhookDelivery` and sends the three documented headers. The timestamp is
  regenerated per attempt and `webhook-id` is not, which is what makes a
  legitimate retry survive a receiver's freshness window while staying
  deduplicable.
- `nextRetryAt` implements the bounded jittered backoff and the three-attempt
  ceiling; `recordFailureWindow` owns the three disable reasons
  (`WEBHOOK_DISABLE_REASONS`) and the reset-on-success rule.
- `retryDueWebhookDeliveries` re-attempts `pending_retry` rows whose
  `next_retry_at` has elapsed, joining the endpoint's secret and open failure
  window so a retry sees the same state a first attempt would.

Scheduled deployments live under `/v1/scheduled-deployments`, including
`POST /:id/pause`, `/unpause`, `/run` and `GET /:id/runs`. `cron.ts` computes
occurrences in the deployment's IANA timezone, so a `0 9 * * *` cadence keeps
its local hour across a DST transition and never fires a wall-clock time the
spring-forward transition skipped. `scheduler.ts` starts a session through the
same `createWithInitialEvents` path `POST /v1/sessions` uses, records a
deployment-run row for every attempt, advances `next_run_at`, and applies the
published failure split: `selfAgentFault` preflights the deployment's own agent
and archives the deployment with no run when it is missing or archived, while
`classifyRunError` + `pauseForError` handle the failures raised during session
creation (rate limit → no pause; archived child agent, archived environment,
missing or invalid startup events → failed run + pause).

`composeOperations` composes both wirings at runtime startup
(`src/index.ts`): it registers the webhook broadcast listener on the session
manager, re-arms deployments whose slot passed while the process was down, and
starts one interval timer. Ordering is deliberate — listener before timers, and
both before the server accepts traffic. `stopOperationsTimers` is returned for
the runtime stopper and the timer is `unref()`'d, so background work never keeps
a process alive or outlives shutdown.

Neither wiring may gate the model loop: a webhook is an advisory projection of
an event already durable in the append-only log, and a deployment runs on its
own cadence, so both are fire-and-forget with failures recorded as delivery
rows rather than propagated into a turn.

## 3. Alignment

**Webhook delivery — aligned.** The payload envelope, the signature scheme and
its covered bytes, the header names, the per-attempt timestamp with a stable
`event.id`, the three-attempt ceiling, the 5–120 s jittered backoff, all three
disable reasons and the reset-on-success rule are implemented as published. The
round trip is asserted rather than assumed: `verifyWebhookDelivery` recomputes
the signature, and
`tests/integration/operations-bridge.test.ts` verifies a real projected event's
delivery against it.

**Scheduled deployments — aligned on behaviour.** Cron-in-timezone semantics,
`initial_events` startup through the canonical session path, run records with
`trigger_context`, pause/unpause, lifecycle webhook event names, re-arming after
downtime, and the asymmetric failure split (including the own-agent
auto-archive that records no run) all follow the published text.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Endpoint paths | Both `/v1/deployments` (published compatibility spelling) and `/v1/scheduled-deployments` (historical local spelling) are served by the same handlers and records. The response remains the local `scheduled_deployment` shape, so the route alias does not claim complete hosted deployment-schema parity. |
| Subscription management surface | Upstream manages subscriptions in its Console; here `POST/GET/PUT/DELETE /v1/webhooks` is a REST surface, which a client may use directly. |
| Webhook event vocabulary | Subscriptions name SandBase event types. The published catalogue and the local one overlap on the lifecycle names (`deployment.*`, `deployment_run.*`, `session.*`) but the local runtime also publishes its own (`session.updated`, `turn_complete`, `span.*`), and no claim is made that every published name has a producer here. |
| Private-address auto-disable is opt-in | The published rule disables an endpoint whose URL resolves to a non-public address. Here that check is behind `blockPrivateTargets` (default **off**): this runtime is self-hosted, and a Console on `127.0.0.1` or a sidecar on the same host is an ordinary webhook target — enabling the rule by default would disable every local subscriber on its first delivery. The reason string is implemented and fires when the policy is enabled. |
| Sustained-failure window | The trigger is the published one (a *duration* of uninterrupted failure, reset by a single `2xx`); the window length is this runtime's choice, `WEBHOOK_FAILURE_WINDOW_MS` = 1 hour. |
| Outcome evaluation | The published contract has no deterministic outcome evaluator; `evaluateDeterministicOutcome` is a local extension used by the operations routes. |
| Webhook delivery attempt ceiling vs local cron | A delivery ceiling is per endpoint and event; scheduled deployments have no attempt ceiling because the cadence already spaces attempts. |
| Collection envelope | Extension collections use the local `has_more` / `first_id` / `last_id` envelope rather than the canonical `{data, prev_page, next_page}` cursors. This is the documented extension-envelope rule, not a per-endpoint choice. |

## 5. Reason for the difference

- The published deployment path is now served as an alias alongside the historical
  local path. The response and local subscription/control-plane differences remain
  documented rather than hidden behind a route name.
- Subscription CRUD is exposed over REST because a self-hosted runtime has no
  Console-only control plane: an operator with API access and no browser still
  needs to manage subscriptions.
- The private-address rule is opt-in because the published rule exists to defend
  a multi-tenant hosted service against agent-authored URLs; a single-tenant
  local runtime is the case where it would cause harm and the threat is absent.
  It is enableable for deployments that do treat the agent as untrusted.
- Fire-and-forget is the only safe disposition: making a webhook delivery part
  of a turn would let an unreachable subscriber fail work the user asked for.
- Splitting the archived-agent cases matters beyond literal compliance: recording
  a run for a deployment that never attempted one would make the run history
  assert something false, and pausing a deployment whose own agent is gone would
  leave an operator with a paused deployment they cannot fix in place.

## 6. Corresponding tests

- `tests/unit/webhook-dispatcher.test.ts` — the delivery contract: reference
  payload, header names, a signature verified against the endpoint's own secret
  (and rejected against the fallback), one `event.id` across a fan-out, retry
  body stability with a fresh timestamp, the `3xx` disable, the attempt ceiling,
  the sustained window and its reset, and the opt-in private-address disable.
- `tests/unit/scheduler.test.ts` — cron in timezone (including the DST cases),
  session startup from `initial_events`, the rate-limit / unrecoverable split,
  the own-agent auto-archive with no run, the child-agent pause with
  `paused_reason`, re-arming, and the manual-run webhook exclusion.
- `tests/integration/operations-bridge.test.ts` — the bridge wiring: a durable
  session event projects onto a matching subscription with a verifiable
  signature, failures are recorded and retried by the timer, and the timer stops
  cleanly.
- `tests/integration/operations-runtime-composition.test.ts` — the composition
  itself on a started runtime.
- `tests/unit/outcome-evaluator.test.ts` — determinism of the local evaluator.

## 7. Status

`partial`, and the reason is narrow: the behaviour of both sub-areas follows the
published text, and the only deviations are the endpoint paths (§4, first row),
the local subscription CRUD surface, the partially-local event vocabulary, the
opt-in private-address policy and the locally-chosen failure-window length. No
claim is made that a client written against the published deployment path works
unchanged, and the `unverified` marker is not used because the delivery
behaviour is asserted directly against the published rules rather than inferred
from a description.
