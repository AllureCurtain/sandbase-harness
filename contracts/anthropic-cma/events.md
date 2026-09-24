# CMA Contract — events

Contract area: the session event log — event domains, ordering, `processed_at`,
and `session.error`.
Status: `supported`, with the error enumeration marked `unverified`, see §4.
Source: `src/api/standard.ts` (`toApiEvent`), `src/core/session/session-manager.ts`,
`src/core/db/migrations.ts`.

<!-- capability-status
append-only-event-log: supported
processed-at-lifecycle: supported
session-error-structure: supported
error-enum-completeness: unverified
-->

---

## 1. Official definition

- The event log is append-only. Events are never rewritten or removed.
- Events belong to domains: inbound user events, outbound agent events,
  lifecycle events, tool events, and system events.
- Inbound events carry `processed_at` once admitted, so a client can tell queued
  from handled.
- `session.error` carries a structured error object rather than a bare string.
- Evaluation of a declared outcome is observable as span events:
  `span.outcome_evaluation_start`, `span.outcome_evaluation_ongoing` and
  `span.outcome_evaluation_end`. The end event carries the verdict, so a client
  can distinguish "still being measured" from "measured, and this is the
  answer".

## 2. Current SandBase shape

The append path and the row shape are `src/core/session/session-manager.ts` and
`src/core/db/migrations.ts`; the wire projection is `toApiEvent` in
`src/api/standard.ts`.

- Every event carries a monotonically increasing per-session `seq`. Ordering is
  `created_at` with a `rowid` tiebreak, because `created_at` has second
  precision and two events in the same second must still order deterministically.
- Event payloads are stored in `events.metadata` and projected through
  `toApiEvent`, so a new field does not require a schema migration.
- `processed_at` is recorded once an inbound event is admitted.
- `session.error` carries a structured payload.
- A tool event carries its payload in `content[0]` and also projects `name` and
  `input` to the top level for `agent.tool_use`, `agent.mcp_tool_use` and
  `agent.custom_tool_use`, `tool_use_id` for `agent.tool_result`, and
  `custom_tool_use_id` for `user.custom_tool_result`. The top-level `id` stays the
  persisted event id and `content` is unchanged; [`tools.md`](./tools.md) records
  why the two ids must not be conflated.
- `session.usage` is emitted before the session goes idle, so a client reading
  the stream observes usage before the terminal status.
- `session.status_idle` carries the session-level `stop_reason` **object at the
  top level**, which is where the published client reads
  `stop_reason.type` to choose between answering a blocking call and stopping. Its
  `event_ids` names the pending calls by their own event id, and a
  `user.tool_confirmation` may address a call by that id (or by the local
  `tool_use` block id). The object is persisted in the metadata carrier and lifted
  by `toApiEvent`, so `metadata` keeps it too; a model-derived event keeps the
  provider's `stop_reason` **string** from the `events.stop_reason` column, and
  the two shapes are distinguished by event type. [`sessions.md`](./sessions.md)
  records both, including the custom-tool path the array does not yet cover.
- One outcome evaluation appends exactly three events, in order, and the end
  event is appended on every path — including the one where the grader throws or
  cannot run, so a client waiting on it cannot hang on an outcome that is already
  over. Each carries `outcome_id` and `iteration` (`0` is the evaluation of the
  declared outcome, `n` the re-evaluation after the n-th revision). The end event
  adds `result`, `explanation`, and the id of the start event it closes. `result`
  is `satisfied | needs_revision | failed` after a grading pass,
  `max_iterations_reached` when the grader asked for a revision that the spent
  budget cannot run, and `budget_reached` when the session spent its ceiling before
  the loop could finish. The `ongoing` event carries no partial verdict: the grader's
  reasoning is opaque, and progress that cannot be observed would be invented.
- An interrupt, or a session that reached its spending ceiling, closes the outcome
  with one further `span.outcome_evaluation_end` carrying `result: "interrupted"` or
  `"budget_reached"` and an empty `outcome_evaluation_start_id`. The close is not
  tied to one evaluation, and the empty id is what keeps it distinguishable from the
  end event of an evaluation that actually ran.
- A revision is a real `user.message`: the grader's explanation is appended to the
  same log, so the next turn reads its instruction from the log rather than from
  memory, and a replayed session reconstructs the same sequence.
- A `user.define_outcome` payload rides in `metadata` and is projected back into
  the agent's context as the turn's instruction; the event has no content blocks
  of its own.

## 3. Alignment

Aligned for: append-only semantics, deterministic ordering, `processed_at`
lifecycle, structured `session.error`, and usage-before-idle ordering.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Error enumeration | The published contract does not exhaustively enumerate `session.error` codes. SandBase error codes are local and are marked `unverified` against upstream values. |
| Event metadata storage | SandBase stores event payloads in a metadata column rather than per-field columns. This is a storage choice with no wire effect. |
| Local event types | SandBase emits extension event types under `/v1/x` that are not part of the canonical domain set. |
| No `session.updated` | The runtime emits no `session.updated` event. A session's `updated_at` field is the whole signal, and the Console reads it rather than subscribing to an event. An event with no producer and no consumer is not documented as if it existed. |
| Outcome span vocabulary | `span.outcome_evaluation_*` is the local spelling for the outcome evaluation spans. The three-event shape and the verdict vocabulary are a SandBase profile: they are recorded here rather than presented as a verified upstream enumeration. |
| Outcome progression | The grader's own reasoning is not published while an evaluation runs. `span.outcome_evaluation_ongoing` marks that the evaluation is in flight and carries no content, because a partial verdict derived from nothing would be a claim about the deliverable that the runtime cannot support. |

## 5. Reason for the difference

- Marking the error enumeration `unverified` is the honest position: the
  published documentation does not list the codes, so claiming a match would be
  a guess presented as a fact.
- Storing payloads in metadata keeps the log forward-compatible. Adding a
  column per new event field would make migrations the bottleneck for changes
  that have no storage requirement.
- `session.updated` was removed rather than implemented: `updated_at` already
  carries the information, the Console reads that field instead of subscribing,
  and an event no client consumes is scope rather than a contract.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — event list and stream ordering assertions,
  and the rejection of an unsupported `event_deltas[]` value.
- `tests/unit/event-logger.test.ts` — the append path assigns a monotonically
  increasing `seq` and the listing returns events in that order, plus the
  `afterSeq` filter a resuming reader uses.
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
- `tests/unit/outcome-evaluation.test.ts` — one evaluation appends the three span
  events in order with the declared outcome's id and iteration, the end event
  carries the verdict and the explanation and names the start event it closes, a
  grader that throws still closes the end event before the failure propagates,
  and the transcript excludes the runtime's own scaffolding.
- `tests/integration/outcome-grading.test.ts` — the same sequence through a
  session: a declared outcome reaches the agent's context, the completed turn is
  graded with the span triple on the event listing, and a runtime with no
  provider records `session.error` with `outcome_evaluator_unavailable` and
  `retry_status: not_retryable`.
- `tests/unit/outcome-loop.test.ts` — the loop's span bookkeeping: one triple per
  evaluation with `iteration` counting from 0, the budget verdict on the last
  allowed evaluation, one revision message per revision, and the closes that name
  no evaluation — `interrupted` and `budget_reached` — carrying an empty
  `outcome_evaluation_start_id`.
- `tests/integration/outcome-loop.test.ts` — the same through a session: the
  revision `user.message` in the event listing, the executor re-entered for it,
  the status a stop leaves behind, the ceiling ending an outcome before its next
  grading pass or turn, and the admission refusal that keeps a declared outcome off
  a runtime with no grader.
- `tests/integration/tool-event-fields.test.ts` — the tool-event projection: the
  lifted `name` / `input` / `tool_use_id` / `custom_tool_use_id` fields, the
  top-level `id` remaining the event id, `content` unchanged, and no field
  reaching an event type that declares none.
- `tests/integration/session-stop-reason.test.ts` — the `session.status_idle`
  projection: the object readable at the top level for both `requires_action` and
  `end_turn`, the metadata carrier kept and agreeing, the model-event string
  untouched, and the field omitted rather than `null` when there is no reason.
- `tests/integration/approval-event-id.test.ts` — the event-id address: the
  pending call's own event id reported in `event_ids` and not the block id, a
  decision naming it executed, the block-id spelling still accepted, and every
  refusal — a second decision for one call, an id naming nothing, a resolved
  call — preserved.

## 7. Status

`supported` for append-only ordering, `processed_at`, structured
`session.error`, and the outcome evaluation span sequence. The error code
vocabulary and the outcome span vocabulary are `unverified` against upstream and
are recorded that way in the capability matrix.
