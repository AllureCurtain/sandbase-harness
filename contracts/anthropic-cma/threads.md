# CMA Contract — session threads and the coordinator

Contract area: threads, the multi-agent roster, thread lifecycle and message
events, thread listing and archive.
Status: `partial` — the primary thread exists on every session and the thread
read routes are live; the roster, coordinator tools, child threads, thread
archive, and per-thread interrupt/budget are not yet implemented. See §7.
Source: `src/core/session/session-threads.ts`,
`src/core/session/event-logger.ts`, `src/core/session/session-manager.ts`,
`src/api/routes/session-threads.ts`, `src/api/routes/stream.ts`,
`src/api/standard.ts`.

<!-- capability-status
threads-and-coordinator: partial
-->

---

## 1. Official definition

- Every agent runs in its own **session thread**: a context-isolated event stream
  with its own conversation history. All agents share the session's sandbox,
  filesystem, and vaults, but not their context.
- The **primary thread** is the session-level event stream itself. Its
  `parent_thread_id` is `null`; a full thread list includes it.
- `multiagent.agents` is a roster of at most 20 distinct agents, with at most one
  `advisor` entry. Member forms are `{type: 'agent', id, version?}`,
  `{type: 'self'}`, and `{type: 'advisor', model}`. The reserved advisor name is
  `anthropic.advisor`. Delegation is one level deep: a roster member may not
  declare a roster of its own.
- At most **25 concurrent threads**. A coordinator may run several threads for
  one roster agent. **Advisor consultations are exempt.**
- A thread's transitions are announced as `session.thread_created`,
  `session.thread_status_running`, `session.thread_status_idle` (with
  `stop_reason`), and `session.thread_status_terminated`. Every session emits
  `session.thread_status_running` for its primary thread; child transitions are
  cross-posted to the primary stream.
- Message direction is named **relative to the stream the event appears on**:
  `agent.thread_message_sent` on the sender's stream, carrying
  `to_session_thread_id` / `to_agent_name`; `agent.thread_message_received` on
  the receiver's stream, carrying `from_session_thread_id` / `from_agent_name`.
- `GET /v1/sessions/{session_id}/threads` lists them;
  `POST /v1/sessions/{session_id}/threads/{thread_id}/archive` archives one.
  Only an idle thread is archivable, and a thread parked on `requires_action`
  counts as idle.
- `user.interrupt` carrying `session_thread_id` stops that thread; omitting it
  interrupts every unarchived thread including the primary one.
- Session status is the aggregate of thread statuses, and the session budget is
  one shared ceiling across threads.

## 2. Current SandBase shape

The thread store is `src/core/session/session-threads.ts`, the columns and
stream predicates live in `src/core/session/event-logger.ts`, the status
aggregation in `src/core/session/session-manager.ts`, the routes in
`src/api/routes/session-threads.ts` and `src/api/routes/stream.ts`, and the
wire projections in `src/api/standard.ts`.

**The primary thread exists on every session.** Migration
`062_session_threads` adds `session_threads` and `events.thread_id` /
`events.cross_posted`, back-fills one primary row per existing session plus a
`thread_id` on every pre-thread event, and `SessionManager.create` writes the
row in the same call as the session. The primary thread's id is derived —
`sth_` plus the session id's suffix — so a lookup never scans for it.

- `GET /v1/sessions/{id}/threads` lists every thread (primary first,
  archived included) with the same cursor envelope as `GET /:id/events`;
  `GET .../threads/{tid}` returns the thread object — `agent` is the resolved
  snapshot the thread runs, `stats` and `usage` are `null` until the thread
  has transitioned (`startup_seconds` is a fixed 0 — the runtime has no
  per-thread provisioning delay to report).
- `GET .../threads/{tid}/events` and `GET .../threads/{tid}/stream` expose the
  thread's own log and SSE stream with the same envelope, cursor discipline,
  `Last-Event-ID` resume, and `event_deltas[]` opt-in as the session-level
  routes — the stream is a filter over the same broadcast.
- The session-level `GET /:id/events` and `/events/stream` are the primary
  stream by definition: the primary thread's own rows plus rows a child
  cross-posted (`cross_posted = 1`), one row with one seq for both views.
- Every thread status transition emits a `session.thread_status_*` event
  carrying `session_thread_id` and `agent_name` — including the primary
  thread's, which is the `session.thread_status_running` the contract
  requires of every session. The session-level `session.status_*` event
  follows the thread event that produced it, and `session.usage` still sits
  immediately before `session.status_idle`.
- Session status is recomputed from thread status after every transition
  (`recomputeSessionStatus`). With one thread the aggregation is the identity
  map, so a single-agent session's lifecycle is exactly what it was before.
- `toApiEvent` gains a stream context: an event read on the primary stream
  whose `thread_id` names a different thread carries `session_thread_id` (the
  seven event types the SDK declares it on); the same event read on its own
  thread's stream does not repeat the field.

What does **not** exist yet:

- No `multiagent` roster — still refused by name on agent create and update
  (`multiagent-roster`).
- No coordinator tools (`list_agents`, `send_to_agent`), no child threads, no
  `session.thread_created`, no `agent.thread_message_*`, no cross-posted rows
  in practice — the machinery exists, nothing produces them yet.
- `POST .../threads/{tid}/archive` is still a mounted `unsupported_capability`
  refusal.
- `user.interrupt` still targets the session as a whole; `session_thread_id`
  on the input event is not yet routed.
- The shared session budget still parks the session as a whole; per-thread
  `budget_reached` is not emitted.
- The local delegation extension (`delegations`, `enable_general_subagent`)
  is unchanged and remains a separate mechanism, not the roster.

## 3. Alignment

Aligned for: the primary thread on every session, the thread object shape and
id prefix (`sth_`), the read routes and their envelopes, the primary stream
definition (primary rows plus cross-posted rows), per-thread status events
with `session_thread_id`/`agent_name`, the thread event → session event
ordering, `session.usage` before `session.status_idle`, and the internal
state machine the projection reuses (thread status maps to the same four wire
values through the same table).

## 4. Differences

| Difference | Detail |
| --- | --- |
| Roster | `multiagent` is still refused by name on both write paths (`multiagent-roster`). The published roster is not stored yet. |
| Child threads | None. No coordinator tools exist, so `send_to_agent` cannot create one and `session.thread_created` / `agent.thread_message_*` are never emitted. |
| Archive | `POST .../threads/{tid}/archive` remains a mounted refusal. A thread cannot be archived. |
| Interrupt targeting | `user.interrupt` has no `session_thread_id` handling; it aborts the session's running turn as before. |
| Thread-scoped budget | Absent. The budget is one session-level ceiling; no `budget_reached` signal is emitted per thread. |
| Cross-posting | The columns, predicates, and `session_thread_id` projection exist and are tested through the primary stream; nothing produces a cross-posted row until child threads land. |
| `event_deltas` scope | Child-thread previews will appear only on the child's stream per spec; the projector already runs per-connection, so the rule holds when children exist. |
| `stats.startup_seconds` | Always 0 — a fixed honest value: a thread's first turn is enqueued with its creation, and there is no thread-level provisioning delay to measure. |

## 5. Reason for the difference

- The surface is landing in slices rather than all at once: the data model,
  the primary thread, and the read routes are the foundation every later
  behaviour (roster, coordinator tools, archive, per-thread interrupt and
  budget) is built on, and this slice is that foundation.
- The session stream is defined as the primary stream rather than renamed:
  pre-thread sessions had exactly one stream, and making the session-level
  routes *be* the primary thread's stream keeps a single-threaded session's
  observable behaviour identical while giving the multi-agent surface the
  same envelope to build on.
- `startup_seconds` reports a fixed 0 instead of a fabricated measurement:
  the runtime provisions the sandbox once per session and threads share it,
  so there is no per-thread startup the field could truthfully measure.
- The roster refusal stays in place rather than relaxing it early: accepting
  `multiagent` before the coordinator exists would let a caller write a
  configuration no turn could honour.

## 6. Corresponding tests

- `tests/unit/session-primary-thread.test.ts` — migration back-fill (primary
  row per pre-existing session, `thread_id` on every pre-thread event),
  create-time primary insert, the `session.thread_status_*` emission order,
  the single-thread event-sequence regression (pre-thread sequence plus only
  the thread events), the primary/thread stream predicates, and session
  delete clearing thread rows.
- `tests/conformance/session-threads.test.ts` — the official SDK drives
  `threads.list`, `threads.retrieve`, `threads.events.list`, and
  `threads.events.stream` over HTTP against a live turn.
- `tests/conformance/official-route-coverage.test.ts` — thread list,
  retrieve, and events decode the real route's 404 for an unknown session;
  archive keeps the `unsupported_capability` envelope.
- `tests/unit/session-archive.test.ts` — a session archive now emits the
  primary thread's `session.thread_status_terminated` ahead of the
  session-level `session.status_terminated`.

## 7. Status

`partial`. Implemented: the `session_threads` table and `events.thread_id` /
`cross_posted` columns with migration back-fill, a derived primary-thread id,
`session.thread_status_*` events on every thread transition, thread-aware
session status aggregation, the four thread read routes (list, retrieve,
events, stream) with the published envelopes and resume semantics, and the
primary-stream definition of the session-level event surface.

Not implemented: the `multiagent` roster (still refused), coordinator tools,
child threads, `session.thread_created` and `agent.thread_message_*` events,
`user.interrupt` thread targeting, thread archive (mounted refusal), and
per-thread budget signalling. The advisor entry type is out of scope by
decision and is not planned.
