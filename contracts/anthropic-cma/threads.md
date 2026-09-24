# CMA Contract — session threads and the coordinator

Contract area: threads, the multi-agent roster, thread lifecycle and message
events, thread listing and archive.
Status: `unavailable`. See §7.
Source: `src/core/session/delegation-service.ts`,
`src/core/orchestrator/agent-orchestrator.ts`, `src/core/agent/schema.ts`,
`src/core/agent/update.ts`.

<!-- capability-status
threads-and-coordinator: unavailable
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

**None of this surface exists.** There is no thread resource, no thread row, no
per-thread event isolation, no `session.thread_*` or `agent.thread_message_*`
event, no `GET /v1/sessions/{id}/threads` route, no archive route, no
`session_thread_id` routing, and no thread-level budget signal. A session is one
event stream and one context window; the budget is session-level only.

What does exist is a **different, smaller mechanism**, and it is not this
surface:

- `src/core/agent/schema.ts` accepts `delegations` (a list of agent names) and
  the boolean `enable_general_subagent`.
- `src/core/session/delegation-service.ts` builds one tool per allowed target
  (`delegate_to_<name>`) plus `general_subagent`, which runs a temporary copy of
  the agent for one level. `src/core/orchestrator/agent-orchestrator.ts`
  (`validateDelegation`) enforces the allowed-target list, the chain, and the
  maximum depth.
- A delegated run is a nested turn with its own sandbox handle and its own
  context. It has no identity, no listing, no per-thread status, and no
  cross-posted lifecycle events, so it cannot be observed the way a thread can.

An earlier revision of this file described a `thread-manager.ts`, a
`multiagent.ts`, and a `session-threads.ts` route. None of those files exist in
the tree. The description was removed rather than reinterpreted, because a
contract document that describes a module nobody can open is worse than a
contract document that records the gap.

## 3. Alignment

None. The only neighbouring concept is delegation, and the local mechanism
differs from the published surface in field names, in lifecycle, and in what a
caller can observe: a thread is a first-class, listable, context-isolated stream
with its own status transitions, while a delegated run is an internal turn.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Threads | Absent. No thread resource, no lifecycle events, no per-thread context isolation, no listing or archive route. |
| Coordinator and advisor roles | Absent. No coordinator may run several threads for one roster agent, and no advisor consultation exists. |
| Thread-scoped budget | Absent. The budget is one session-level ceiling; no `budget_reached` signal is emitted per thread. |
| Interrupt targeting | Absent. `user.interrupt` targets the session; a thread id has nothing to route to. |
| Local delegation extension | `delegations` and `enable_general_subagent` are a one-level parent/child mechanism with its own tool names. It is a local extension, never presented as the canonical roster. |

## 5. Reason for the difference

- The gap is a scope decision, not an oversight: threads, a coordinator role,
  advisor consultations, and per-thread event routing are a protocol surface of
  their own, and this phase implements none of them.
- A partial implementation was rejected on purpose. Thread identity without
  context isolation, or a listed `anthropic.advisor` thread that no consultation
  ever uses, would be a surface that reports work it did not do. The runtime
  reports the gap and tells the caller which local field to use instead.

## 6. Corresponding tests

- `tests/integration/delegation.test.ts` — the local delegation extension: the
  tools built for an agent's `delegations` list, and a delegated run returning
  its result. Evidence that this mechanism exists and is *not* a thread surface.
- `tests/unit/orchestrator.test.ts` — the delegation checks: target not in the
  roster, chain, and depth.

## 7. Status

`unavailable` — nothing in this contract area is implemented. The runtime has no
thread resource, no coordinator or advisor role, no thread lifecycle or
message-direction events, no per-thread event isolation, no thread listing or
archive route, and no thread-scoped budget signal.
