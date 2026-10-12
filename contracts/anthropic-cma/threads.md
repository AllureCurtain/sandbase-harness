# CMA Contract — session threads and the coordinator

Contract area: threads, the multi-agent roster, thread lifecycle and message
events, thread listing and archive.
Status: `partial` — the coordinator tools, child threads, dispatch/reply
events, confirmation routing, per-thread interrupt, archive, and per-thread
`budget_reached` are live; there is no advisor and no Console thread surface.
See §7.
Source: `src/core/session/session-threads.ts`,
`src/core/session/event-logger.ts`, `src/core/session/session-manager.ts`,
`src/core/session/coordinator-tools.ts`, `src/core/session/thread-runner.ts`,
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
  requires of every session. A child's transition is cross-posted, so it also
  appears on the primary stream. The session-level `session.status_*` event
  follows the thread event that produced it, and `session.usage` still sits
  immediately before `session.status_idle`.
- Session status is recomputed from thread status after every transition
  (`recomputeSessionStatus`): any running thread → `running` (`retrying` when
  every active thread is), else any `requires_action` → `requires_action`,
  else all unarchived `paused` → `paused`, and a terminal primary → terminal.
  With one thread the aggregation is the identity map, so a single-agent
  session's lifecycle is exactly what it was before.
- `toApiEvent` gains a stream context: an event read on the primary stream
  whose `thread_id` names a different thread carries `session_thread_id` (the
  seven event types the SDK declares it on); the same event read on its own
  thread's stream does not repeat the field.

**The coordinator's two tools are live.** A thread whose agent carries a
`multiagent` roster (the `multiagent-roster` capability — see `agents.md`)
mounts `list_agents` and `send_to_agent`
(`src/core/session/coordinator-tools.ts`) — only that thread and any `self`
replica, which is the runtime half of the one-level rule: a roster member's
thread mounts neither, so delegation cannot recurse. `list_agents` returns the
roster's `{name, description}` members and the session's existing
`{thread_id, agent_name, status}` threads. `send_to_agent` is asynchronous
(D8): it validates the member and the optional `thread_id` follow-up target,
enforces the 25-child concurrency cap, inserts a `queued` child row with the
member's pinned definition (a `self` replica gets the coordinator's effective
configuration), writes `session.thread_created` on the parent plus the
`agent.thread_message_sent` / `agent.thread_message_received` pair, and returns
`{thread_id, status: 'sent'}` immediately. The child's first turn is enqueued
on its own execution chain — every thread serializes only its own turns, so
several children run concurrently.

**Each thread runs the same engine loop against its own slice of the log.** A
`ThreadEventLogWriter` facade wraps the session's `EventLogger` and stamps the
running thread's `thread_id` on every event and usage record, so a child's
`agent.message`, `agent.tool_use`, and `span.*` rows land on its stream without
the strategy knowing a second thread exists. Context builds from
`getThreadEvents(thread_id)` — a child's context is only its own rows. Threads
share the session's sandbox, filesystem, resources, and vault (D4): the
sandbox lifecycle is keyed by `session.id`, so `getOrProvision` reuses the one
sandbox for every thread.

**A child's reply returns to its parent on `end_turn`.** When a child's turn
closes `paused` rather than `requires_action` (a parked call is the child
waiting on its own client work, so no reply goes out then), its last assistant
text becomes the parent's `agent.thread_message_received` — cross-posted so it
also surfaces on the primary stream — and the matching
`agent.thread_message_sent` closes the pair on the child's stream. The parent's
chain is then re-entered with an `internal.thread_message` trigger, which runs
only when the parent is still idle; a running parent folds the message into its
next context rebuild instead. The `agent.thread_message_received` event
projects into the receiver's context as a user message prefixed
`[来自 <agent_name>]`; `agent.thread_message_sent` is the `send_to_agent` call
itself and is not re-projected.

**A child's parked call is answered on its own thread.** When a child's turn
ends on `requires_action` — an approval-gated `agent.tool_use` /
`agent.mcp_tool_use`, or an `agent.custom_tool_use` waiting on the caller — the
rows that parked it are lifted onto the primary stream (`cross_posted = 1`,
keeping their own `thread_id`), so a primary-stream reader sees the blocking
block attributed by `session_thread_id` on the wire. The child's
`session.thread_status_idle` carries `stop_reason.requires_action` with
`event_ids` scoped to that thread's parked calls, while the session-level
`session.status_idle` reports the union across parked threads (§4.3). The
client answers as before — `user.tool_confirmation` or
`user.custom_tool_result`, either id spelling — and the answer is resolved to
the thread that produced the call, stamped with that `thread_id`, cross-posted,
and resumed on the owning thread's own execution chain: the child's parked
set, its context projection, and its tool-result pairing are all computed on
its own stream.

**Interrupt and archive are thread-scoped.** `user.interrupt` accepts an
optional `session_thread_id`: without it every unarchived thread is stopped —
a running or retrying thread's turn is aborted through its own controller,
and a thread parked on `requires_action` has each parked call closed with the
published error result ("Tool execution was interrupted before completion.
Please retry.") before going straight to `paused` (`end_turn`), with no model
call — while with it only the named thread is touched (an id naming no thread
of the session is refused). The event itself is stamped on the thread it was
addressed to and cross-posted, so the primary stream records a scoped
interrupt against the child's stream too. `POST .../threads/{tid}/archive`
archives an idle child — a parked `requires_action` thread counts as idle —
emitting `session.thread_status_terminated` (cross-posted) and freeing its
concurrency slot; the primary thread answers `primary_thread_not_archivable`
(400) and a running one `thread_running` (409). An archived thread accepts no
input: `send_to_agent` follow-ups and turns on its chain are refused or
dropped, and its stranded parked calls leave the session's `event_ids` union.

What does **not** exist yet:

- There is no server-side advisor; an `advisor` roster member is refused at
  write time with `advisor_unsupported`.
- The local delegation extension (`delegations`, `enable_general_subagent`)
  is unchanged and remains a separate mechanism, not the roster.
- No Console thread surface: threads are reachable over the API and SSE only.

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
| `send_to_agent` parameter shape | The published contract names `list_agents` and `send_to_agent` but fixes no argument or result shape; the local `{agent, message, thread_id?}` → `{thread_id, status: 'sent'}` is the runtime's own and is unverified upstream. |
| `send_to_agent` sync/async | Local by D8: the call records the dispatch and returns `{status: 'sent'}` immediately, and the reply arrives later as `agent.thread_message_received` driving a fresh turn. A synchronous wait would freeze the coordinator through the child's whole run, which is the parallel-dispatch pattern the roster exists for. |
| Advisor | An `advisor` roster member is refused with `advisor_unsupported` — no server-side advisor exists in this runtime. |
| Child-thread `requires_action` cross-post | Implemented: the parked `agent.tool_use` / `mcp_tool_use` / `custom_tool_use` is lifted onto the primary stream (the row keeps its `thread_id`; `cross_posted = 1` admits it to the primary view, and `session_thread_id` on the wire attributes it), the child's `session.thread_status_idle` carries `stop_reason.requires_action` with only its own parked `event_ids`, the session-level `session.status_idle` reports the union across parked threads, and the answering `user.tool_confirmation` / `user.custom_tool_result` is stamped onto the owning thread and cross-posted so both streams show the request→response pair. |
| Archive | Implemented: `POST .../threads/{tid}/archive` archives an idle child (`requires_action` counts as idle), emits the cross-posted `session.thread_status_terminated`, frees the slot, returns the thread object; primary → `primary_thread_not_archivable` (400), running → `thread_running` (409), repeat → same row, no second event. |
| Interrupt targeting | Implemented: `user.interrupt` accepts `session_thread_id` — scoped interrupts one thread (unknown/cross-session id → 400), unscoped interrupts every unarchived thread; a parked thread's calls are closed with the published error result and it goes `paused` (`end_turn`) without a model call; an idle thread is a no-op. |
| Thread-scoped budget | Implemented per §4.6: the ceiling stays one shared session-level cap, but each running thread that crosses it idles on its own `session.thread_status_idle` (`budget_reached`), a suspended child posts no reply to its parent, and the aggregate reports `requires_action` while any thread still waits on a confirmation. A budget raise re-enters each budget-parked thread on its own `internal.resume_after_budget`. |
| `event_deltas` scope | Child-thread previews appear only on the child's stream; the projector already runs per-connection, so the rule holds. |
| `stats.startup_seconds` | Always 0 — a fixed honest value: a thread's first turn is enqueued with its creation, and there is no thread-level provisioning delay to measure. |

## 5. Reason for the difference

- The surface is landing in slices rather than all at once: the data model,
  the primary thread, and the read routes were the foundation; the coordinator
  tools, child threads, the dispatch/reply exchange, archive, per-thread
  interrupt, and per-thread `budget_reached` now execute on top of it; the
  advisor and the Console surface are the slices that remain.
- The session stream is defined as the primary stream rather than renamed:
  pre-thread sessions had exactly one stream, and making the session-level
  routes *be* the primary thread's stream keeps a single-threaded session's
  observable behaviour identical while giving the multi-agent surface the
  same envelope to build on.
- `send_to_agent` is asynchronous by design: the contract says threads are
  durable and concurrent, so a synchronous wait would both freeze the
  coordinator through the child's run and make the fan-out pattern the roster
  exists for impossible. The reply returning as a
  `agent.thread_message_received` that re-enters the coordinator's chain is
  what keeps the call non-blocking without losing the answer.
- The seam between "one engine loop" and "many threads" is the event writer,
  not the loop: `ThreadEventLogWriter` stamps `thread_id` on the same
  `EventLogWriter` surface the strategy already used, so a child runs the
  same `DefaultStrategy` — the loop never learned a second thread exists,
  which is also why a child's events cannot leak into a sibling's context.
- `startup_seconds` reports a fixed 0 instead of a fabricated measurement:
  the runtime provisions the sandbox once per session and threads share it,
  so there is no per-thread startup the field could truthfully measure.
- The roster's members are pinned at dispatch: a named member runs the
  version the roster resolved at write time, and a `self` replica runs the
  coordinator's *effective* configuration — the same resolved definition the
  coordinator's own turn runs, session-level overrides included — because the
  contract calls `self` a copy of the coordinator, not a fresh resolution of
  its durable row.

## 6. Corresponding tests

- `tests/unit/session-primary-thread.test.ts` — migration back-fill (primary
  row per pre-existing session, `thread_id` on every pre-thread event),
  create-time primary insert, the `session.thread_status_*` emission order,
  the single-thread event-sequence regression (pre-thread sequence plus only
  the thread events), the primary/thread stream predicates, and session
  delete clearing thread rows.
- `tests/unit/coordinator-send-to-agent.test.ts` — the dispatch, reply, and
  chain logic against the real `SessionManager` with a scripted executor:
  `list_agents`/`send_to_agent` mounting, the `thread_created` → `sent` →
  `running` → `idle` → `received` order on the primary stream, a follow-up
  keeping the child's history, two concurrent children, the 26th child
  refused as a tool error, no coordinator tools on a non-rostered thread,
  every §4.3 aggregation rule, and the §4.5 routing cases — a parked
  `agent.tool_use` / `agent.custom_tool_use` cross-posted to the primary
  stream, per-thread `event_ids` on the thread's status event and the union
  on the session's, and `user.tool_confirmation` / `user.custom_tool_result`
  stamped onto the owning thread, cross-posted, and resumed on its chain.
- `tests/integration/coordinator-send-to-agent.test.ts` — the full turn over
  `DefaultSessionExecutor` + `DefaultStrategy` + a scripted model: the
  coordinator's `send_to_agent`, the child's shared-workspace file write, the
  reply reaching the coordinator's second request as `[来自 reviewer] done`.
- `tests/conformance/session-threads.test.ts` — the official SDK drives
  `threads.list`, `threads.retrieve`, `threads.events.list`, and
  `threads.events.stream` over HTTP against a live turn.
- `tests/conformance/session-threads-multiagent.test.ts` — the official SDK
  drives a rostered coordinator end to end; after `send_to_agent`,
  `threads.list` answers the primary thread plus the spawned child.
- `tests/conformance/official-route-coverage.test.ts` — every thread route,
  archive included, decodes the real route's 404 for an unknown session.
- `tests/unit/session-archive.test.ts` — a session archive now emits the
  primary thread's `session.thread_status_terminated` ahead of the
  session-level `session.status_terminated`.
- `tests/unit/session-thread-archive.test.ts` — the archive route's
  `primary_thread_not_archivable` / `thread_running` / success / idempotent
  cases, archiving a parked child freeing the slot and dropping its parked
  call from the session's `event_ids` union, and every §4.5 interrupt rule:
  scoped on a parked child (error results, `end_turn`, no model call),
  unscoped across running and parked threads, the already-idle no-op, and
  the unknown / cross-session `session_thread_id` refusal.

## 7. Status

`partial`. Implemented: the `session_threads` table and `events.thread_id` /
`cross_posted` columns with migration back-fill, a derived primary-thread id,
`session.thread_status_*` events on every thread transition (a child's
cross-posted), thread-aware session status aggregation, the four thread read
routes with the published envelopes and resume semantics, the primary-stream
definition of the session-level event surface, the coordinator's `list_agents`
and `send_to_agent` tools, child threads spawned on their own execution
chains sharing the session's sandbox, the `session.thread_created` and
`agent.thread_message_sent`/`received` exchange (cross-posted where the
contract puts it on the primary stream), the 25-child concurrency cap, the
`[来自 <name>]` reply projection into the receiver's context, the
requires_action cross-post (a child's parked `agent.*tool_use` lifted onto
the primary stream and attributed by `session_thread_id`), per-thread
`event_ids` on a thread's status event against the union on the session's,
the routed answer (`user.tool_confirmation` / `user.custom_tool_result`
stamped onto the owning thread and cross-posted), thread-scoped
`user.interrupt` (unscoped closes every unarchived thread; scoped touches one;
a parked thread's calls are closed with the published error text before it
settles `paused`), `POST .../threads/{tid}/archive` with its
`primary_thread_not_archivable` / `thread_running` / idempotent refusals, and
the shared-ceiling budget behaviour (each running thread idles on its own
`session.thread_status_idle` (`budget_reached`), the aggregate reports
`requires_action` while a thread waits on a confirmation, and a budget raise
resumes each budget-parked thread on its own `internal.resume_after_budget`).

Not implemented: the advisor role and the Console thread surface. The
`multiagent` roster itself is accepted, validated, stored, and projected on
the agent (`agents.md`), and an `advisor` member is refused with
`advisor_unsupported` by decision — not planned.
