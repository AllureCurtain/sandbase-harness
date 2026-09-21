# CMA Contract — session threads and the coordinator

Contract area: threads, the multi-agent roster, thread lifecycle and message
events, thread listing and archive.
Status: `partial`. See §7.
Source: `src/core/session/thread-manager.ts`, `src/core/agent/multiagent.ts`,
`src/core/agent/schema.ts`, `src/core/session/delegation-service.ts`,
`src/core/session/session-manager.ts`, `src/api/routes/session-threads.ts`,
`src/api/standard.ts`.

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
  A delegated task therefore reaches the child's own stream as `received`.
- `GET /v1/sessions/{session_id}/threads` lists them;
  `POST /v1/sessions/{session_id}/threads/{thread_id}/archive` archives one.
  Only an idle thread is archivable, and a thread parked on `requires_action`
  counts as idle.
- `user.interrupt` carrying `session_thread_id` stops that thread; omitting it
  interrupts every unarchived thread including the primary one.
- Session status is the aggregate of thread statuses: if any thread is running,
  the session is running.
- The session budget is one shared ceiling across threads.

## 2. Current SandBase shape

`src/core/session/thread-manager.ts` owns thread identity and nothing about
execution:

- `MAX_CONCURRENT_THREADS = 25`; `concurrentCount` excludes the primary thread,
  archived threads, and advisor threads.
- `ensurePrimaryThread` is called from `SessionManager.create`, so a session row
  and its primary thread always appear together.
- `createChildThread` checks the limit *before* inserting, so a refused spawn
  leaves no thread and no `thread_created` event behind.
- `emitCrossPosted` records a lifecycle event on the thread it describes and
  again on the primary stream, which is what makes the primary stream a summary
  of all thread activity.
- `archive` refuses the primary thread (`session_thread_primary_not_archivable`)
  and a running child (`session_thread_not_idle`).
- `THREAD_ERROR_CODES` are stable strings; `isThreadError` recognises them, and
  the API maps them to 400 rather than 500.

`src/core/agent/multiagent.ts` + `src/core/agent/schema.ts` own roster
validation, split by what each layer can decide:

- Shape and cardinality (at most 20, at most one advisor, no duplicate ids, no
  reserved name, no nested roster) are decidable from the definition alone.
- Existence and pinning need the agent store, so they live in
  `resolveMultiagentRoster`, which pins each referenced agent to the version
  resolved now — that is what makes the roster a snapshot.
- `rosterModels` feeds budget admission, so a roster member the profile cannot
  price is caught before the session exists rather than at the first delegation.

`src/core/session/delegation-service.ts` opens a thread per delegated run via the
injected `openDelegationThread` / `recordDelegationEvent` / `closeDelegationThread`
hooks; `SessionManager.delegationThreadHooks()` supplies them, and
`src/core/runtime/session-runtime.ts` wires that bundle into the executor. A
refused spawn degrades to no thread rather than failing the delegation.

`src/api/routes/session-threads.ts` implements the two documented endpoints.

## 3. Alignment

Aligned with:

- the primary thread as the session stream, materialized with a null parent and
  included in the list;
- the 25-thread limit with advisor exemption, checked before the row exists;
- roster cardinality and the reserved advisor name, validated at write time;
- one-level delegation, enforced by rejecting a nested roster;
- lifecycle and message-direction event vocabulary, including cross-posting child
  transitions to the primary stream and naming message direction relative to the
  stream;
- `thread_status_idle` carrying an explicit `stop_reason`, including
  `budget_reached`;
- `archive` restricted to idle non-primary threads;
- the two documented endpoints, session-scoped, with a null `parent_thread_id`
  identifying the primary thread.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Delegation is routed by `delegations`, not by the roster | Delegation tools are built from `agent.delegations`. A coordinator that declares `multiagent` but not `delegations` gets a validated, snapshotted roster and no tools to use it. The roster is enforced and reported, but it is not yet the routing table. |
| No advisor consultation | The `advisor` roster entry is validated, and an advisor thread would be listed and exempt from the limit, but no mid-turn consultation tool exists, so no `anthropic.advisor` thread is ever created by the runtime. |
| `session_thread_id` on interrupting events is not routed | Inbound normalisation does not read `session_thread_id`, so a `user.interrupt` stops the session rather than one named thread. A reported thread id is not silently ignored — it is simply not part of the accepted field set. |
| Session status is not derived from threads | The session status is authoritative and the primary thread tracks it, rather than the session aggregating thread statuses. The observable result is the same for a single-level delegation, since a delegated run happens inside the parent's turn. |
| No `thread_status_rescheduled` | No transient-error retry schedule exists, so the event is never emitted. |
| `agent` object shape beyond `name` | The published examples read `thread.agent.name` and branch on advisor. SandBase emits `name` for every non-advisor thread and carries `self`/`agent` through as the type. The full non-advisor field list is not shown in the local documentation copy, so it is not claimed. |
| Thread list is unpaginated | The two documented endpoints are served, but the list returns the whole set under a page envelope rather than a working cursor: a session is bounded at 25 concurrent threads plus archived ones. |

## 5. Reason for the difference

- **Roster not yet the routing table.** `delegations` predates the roster and is
  what the executor consumes. Wiring roster membership into tool construction is
  a behavioural change to an existing, tested delegation path, so it is recorded
  as a deviation rather than folded in silently. Until then the roster's value is
  validation and budget admission, which is real but narrower than the published
  contract.
- **No advisor consultation.** A consultation is a mid-turn model call with its
  own thread and a self-terminating lifecycle. Implementing the thread without
  the consultation would create an empty thread, which is worse than reporting
  the gap: a client would see `anthropic.advisor` listed with nothing in it.
- **Interrupt routing.** Thread-scoped interrupt needs cancellation plumbing that
  reaches the specific delegated run. Reporting the field as accepted while it
  only stopped the session would be the exact kind of "looks implemented" state
  this contract set exists to avoid.

## 6. Corresponding tests

- `tests/unit/session-threads.test.ts` — primary thread materialization, child
  creation and its announcement, cross-posting to the primary stream, explicit
  idle `stop_reason`, the 25-thread limit with advisor exemption, archive rules
  and slot release, per-thread event isolation with the session log kept whole,
  primary-thread announcement, the delegation hooks (hand-off and report on both
  streams, failure terminating the thread, limit refusal degrading to no thread),
  and the `toApiThread` projection for primary, advisor, and self threads.
- `tests/integration/delegation.test.ts` — running a delegation tool actually
  opens a thread and closes it with the answer, which is the wiring assertion the
  thread unit tests cannot make.

## 7. Status

`partial`. Thread identity, lifecycle events, cross-posting, the concurrency
limit with advisor exemption, roster validation and snapshotting, archive rules,
per-thread event isolation, the two documented endpoints, and the delegation-
opens-a-thread path are implemented and tested. Recorded deviations: delegation
is routed by `delegations` rather than by roster membership; no advisor
consultation exists; `session_thread_id` on an interrupting event is not routed
to a named thread; session status is authoritative rather than aggregated; and
the non-advisor `agent` object's field list beyond `name` is unverified against
the published contract.
