# CMA Contract — events

Contract area: the session event log — event domains, ordering, `processed_at`,
and `session.error`.
Status: `supported`, with the error enumeration marked `unverified`, see §4.
Source: `src/api/standard.ts` (`toApiEvent`), `src/core/session/session-manager.ts`,
`src/core/db/migrations.ts`.

---

## 1. Official definition

- The event log is append-only. Events are never rewritten or removed.
- Events belong to domains: inbound user events, outbound agent events,
  lifecycle events, tool events, and system events.
- Inbound events carry `processed_at` once admitted, so a client can tell queued
  from handled.
- `session.error` carries a structured error object rather than a bare string.

## 2. Current SandBase shape

- Every event carries a monotonically increasing per-session `seq`. Ordering is
  `created_at` with a `rowid` tiebreak, because `created_at` has second
  precision and two events in the same second must still order deterministically.
- Event payloads are stored in `events.metadata` and projected through
  `toApiEvent`, so a new field does not require a schema migration.
- `processed_at` is recorded once an inbound event is admitted.
- `session.error` carries a structured payload.
- `session.usage` is emitted before the session goes idle, so a client reading
  the stream observes usage before the terminal status.

## 3. Alignment

Aligned for: append-only semantics, deterministic ordering, `processed_at`
lifecycle, structured `session.error`, and usage-before-idle ordering.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Error enumeration | The published contract does not exhaustively enumerate `session.error` codes. SandBase error codes are local and are marked `unverified` against upstream values. |
| Event metadata storage | SandBase stores event payloads in a metadata column rather than per-field columns. This is a storage choice with no wire effect. |
| Local event types | SandBase emits extension event types under `/v1/x` that are not part of the canonical domain set. |
| `session.updated` | Emitted locally so the Console can react without polling. Not confirmed against the upstream event catalogue; treated as a local contract. |

## 5. Reason for the difference

- Marking the error enumeration `unverified` is the honest position: the
  published documentation does not list the codes, so claiming a match would be
  a guess presented as a fact.
- Storing payloads in metadata keeps the log forward-compatible. Adding a
  column per new event field would make migrations the bottleneck for changes
  that have no storage requirement.
- `session.updated` exists because the local Console otherwise has no push
  signal for non-status changes. It is labelled a local contract rather than
  claimed as canonical.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — event list and stream ordering assertions,
  and the rejection of an unsupported `event_deltas[]` value.
- `tests/unit/ordered-session-events.test.ts` — deterministic ordering under
  equal timestamps.
- `tests/unit/cma-event-contract.test.ts` — `session.error` projection: the
  structured payload reaches the top level, the text `content` survives
  alongside it, an event without a payload omits `error` rather than inventing
  one, and an unrecognized `retry_status` is carried through rather than dropped.
- `tests/integration/session-error-paths.test.ts` — the production paths, driven
  through `SessionManager.runTurn`: a model failure, a tool failure, and a
  sandbox failure each produce a structured payload; a busy session reports
  `retryable` and stays `paused`, a timed-out turn reports `not_retryable` and
  becomes `timed_out`, an unsupported capability reports `not_retryable`, an
  unrecognized code reports `unknown`, and a codeless failure falls back to
  `internal_error`. Every admission refusal (Pi policy, sandbox provider, user
  event, loop engine) is asserted `not_retryable` by its published code rather
  than by a literal, so a code renamed in one place and not the other fails here.
  A user abort records no `session.error` at all.
- `tests/unit/model-error.test.ts` — the message carried into the payload is
  enriched with provider detail and has secrets redacted before it is persisted.

## 7. Status

`supported` for append-only ordering, `processed_at`, and structured
`session.error`. The error code vocabulary is `unverified` against upstream and
is recorded that way in the capability matrix.
