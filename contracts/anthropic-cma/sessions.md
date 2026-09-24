# CMA Contract — sessions

Contract area: `/v1/sessions` — lifecycle, status transitions, initial events,
resources, budget.
Status: `supported` for lifecycle, initial events, and the declared-outcome loop.
The session budget is a separate contract area with its own status and is not
claimed here; see `budget.md`.
Source: `src/api/routes/sessions.ts`, `src/api/routes/initial-events.ts`,
`src/api/routes/session-normalizers.ts`, `src/api/standard.ts`,
`src/core/agent/overrides.ts`, `src/core/session/session-manager.ts`.

<!-- capability-status
session-lifecycle: supported
initial-events: supported
outcome-grading: supported
-->

---

## 1. Official definition

- A session runs one agent against one environment. It is created, may be
  resumed, interrupted, and terminated.
- `POST /v1/sessions` accepts optional `initial_events` processed at creation,
  so a session can start with work already queued.
- The `agent` field accepts three forms: an id string (the agent's current
  version), an object with an optional `version` (a pinned version), and
  `agent_with_overrides`, which runs a pinned or current version with part of
  its configuration replaced for this session only.
- An override is per-field and never merges: an omitted field is inherited from
  the referenced agent version, `null` (or `[]` for a list) clears it for this
  session, and any other value replaces it wholesale. Overriding a field does
  not modify the agent and does not create a version.
- Session status reflects what a caller must do next: idle, running, waiting for
  action, terminated, or failed.
- The session-scoped event stream is the canonical way to observe progress.

## 2. Current SandBase shape

The routes are `src/api/routes/sessions.ts` with
`src/api/routes/initial-events.ts` and `src/api/routes/session-normalizers.ts`;
the lifecycle and the outcome loop live in `src/core/session/session-manager.ts`;
override resolution is `src/core/agent/overrides.ts`; the wire projection is
`src/api/standard.ts`.

Status projection (`toApiSessionStatus`):

| Internal | API status |
| --- | --- |
| `running` | `running` |
| `requires_action` | `requires_action` |
| `completed` | `terminated` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `timed_out` | `timed_out` |
| `cleanup_pending` | `cleanup_pending` |
| anything else | `idle` |

The session-level `stop_reason` (`toApiEvent`):

- A `session.status_idle` event carries the session-level reason as an **object
  at the top level**, which is where the published client reads it:
  `select(.type == "session.status_idle") | .stop_reason.type`. The published
  loop uses that value to choose between answering a blocking call and stopping.
- It is persisted in the generic metadata carrier (`lifecycleMetadataFor` writes
  `metadata.stop_reason`), so the projection lifts it and `metadata` keeps it —
  this is a projection, not a move. `src/api/routes/runs.ts` reads the persisted
  path to choose between a `202` with `wait_deadline_reached` and a terminal
  body, and that reader is unaffected.
- `type` is `requires_action` when the session is waiting for a tool
  confirmation and `end_turn` when it paused with nothing outstanding. An
  interrupt reports `end_turn` too: the published contract states there is no
  dedicated interrupt reason, so no separate value is invented here.
- `event_ids` names the pending calls by the `agent.tool_use` /
  `agent.mcp_tool_use` **event** id — the `id` the event listing reports for that
  event. That is the address the published client sends back, so the two halves
  of the exchange agree. Resolution is still tracked by the `tool_use` **block**
  id, because a tool result pairs to its call by tool-call id, so a call that
  already has a result is excluded even though the array reports event ids.
- A `user.tool_confirmation` may address the call by that event id **or** by the
  `tool_use` block id. The block id is a documented local fallback, kept because
  this runtime's own callers and tests answer with one; widening which
  identifier *selects* the call does not widen authority, since the pending check
  and the one-shot resolution still decide whether anything runs. Whichever
  arrives, the confirmation event's `metadata.tool_use_id` and the
  `agent.tool_result` appended for the decision both carry the **block** id, and
  a second decision for the same call is refused whichever spelling it uses.
- An idle event whose metadata carries no `stop_reason` omits the top-level field
  rather than sending `null`.
- Model-derived events keep the provider's `stop_reason` **string** from the
  `events.stop_reason` column. The two shapes share the field name because both
  published shapes spell it `stop_reason`; they are distinguished by event type
  and a status event has no model response behind it.

`initial_events`:

- At most 50 events (`MAX_INITIAL_EVENTS`).
- Only `user.message` and `user.define_outcome` are accepted; any other type is
  rejected with `invalid_initial_event_type` and names the offending index.
- `user.message` requires a string or content-block array; a malformed payload
  is rejected rather than coerced.
- `user.define_outcome` requires a `description` and a `rubric`, which is either
  `{type: "text", content}` or `{type: "file", file_id}`; `max_iterations` defaults to
  3 and is rejected outside 1..20 rather than clamped. A malformed payload is reported
  as `invalid_initial_events` with the index and the offending field. The admitted
  event is normalized, so the log holds the default rather than an absent budget.
- The creation response deliberately does not echo `initial_events`: the events
  are observable on the session's own event stream, and echoing them would
  suggest they are session state rather than accepted input.
- Creation is one local transaction: the session row, its resource attachments,
  and the delivery of every `initial_events` entry are wrapped together, so an
  event rejected at admission rolls the whole creation back. The alternative —
  creating the session first and then admitting events — would leave a
  half-created session with no durable record of which events were accepted, and
  a caller retrying would have no way to tell whether the first attempt partly
  took effect.

Session resources:

- Attached at creation from the canonical `resources` array.
- Resource instances carry their own `sesrsc_` id and support lifecycle
  operations. See `files.md` and `credentials.md`.

Session agent reference (`agent_with_overrides`):

- The overridable fields are exactly `model`, `system`, `tools`, `mcp_servers`
  and `skills`. Any other field in the object is refused with
  `invalid_agent_overrides` rather than ignored, because a caller that sends one
  believes it changed how the session runs.
- A session created with overrides stores the resolved configuration as its own
  snapshot (`sessions.agent_definition`, the same column a version pin uses),
  and that snapshot is what the loop reads. `agent_id` and `agent_version` keep
  pointing at the agent and version the session was derived from, and the agent
  row and its version list are untouched.
- Capability admission and the Pi agent policy judge the resolved configuration,
  not the base agent, so an override cannot pass a gate on the agent and then
  execute with a tool or model set the gate never saw.
- Four refusals, each a code-carrying 400 reported before the session row
  exists, so a refused override creates nothing:
  - `agent_model_required` — `model: null`; a session always needs a model;
  - `agent_tools_cleared_with_skills` — `tools` cleared (null or `[]`) while the
    effective `skills` is non-empty, because skills need the `read` tool;
  - `agent_mcp_server_not_found` — the resolved definition binds an
    `mcp_toolset` to a server the effective `mcp_servers` does not declare;
  - `invalid_agent_override_field` (malformed field, named in the message) and
    `invalid_agent_overrides` (unknown field). A malformed `model` keeps the
    model profile's own codes (`invalid_model`, `invalid_model_speed`,
    `unsupported_model_field`), the same ones the agent definition path
    publishes for that field.
- A `model` override replaces the whole model object: the agent's own `effort`
  is not inherited, and an `effort` inside the override is refused (see §4).
- A malformed reference is refused with `invalid_agent_ref` and an absent one
  with `agent_required`, so "malformed" and "missing" are distinguishable.
- `POST /v1/runs` accepts only the two pinning forms: the override form is
  refused there with a 400 naming the reason, rather than accepted and ignored.

Declared outcome evaluation:

- A `user.define_outcome` event is an instruction as well as a record: its
  `description` and rubric project into the turn's context, so the queued turn
  works against declared criteria. A `{type: "file"}` rubric names its file
  rather than inlining it.
- Once that turn completes, the runtime appends
  `span.outcome_evaluation_start`, `span.outcome_evaluation_ongoing` and
  `span.outcome_evaluation_end`, and the end event carries the verdict
  (`satisfied | needs_revision | failed`), an explanation and the id of the start
  event it closes. See `events.md` for the payloads.
- The grader runs in its own context window over what the agent produced: its
  messages, tool calls and their results. The system prompt, the session's
  lifecycle events, the outcome instruction and any earlier verdict are excluded,
  so an evaluation is not anchored to the runtime's scaffolding or to its own
  previous answer.
- The rubric comes from the declared outcome: inline text is used directly and a
  file rubric is read from the upload the Files API stored. A rubric file that
  cannot be read refuses the evaluation with `outcome_rubric_file_not_found`
  rather than grading against an empty rubric.
- A grader that cannot run — no model provider configured — closes the end event
  as `failed` and surfaces `session.error` with code
  `outcome_evaluator_unavailable` and `retry_status: not_retryable`. The
  evaluation is never silently skipped: an ungraded outcome and a failed outcome
  would otherwise be indistinguishable to a client.
- A turn that threw is not graded, and the end event is appended on every path so
  a client waiting on `span.outcome_evaluation_end` cannot hang.
- A `needs_revision` verdict starts another iteration: the explanation is appended
  as a real `user.message` and a further turn runs inside the same outcome, so the
  revision is visible in the log and the next turn reads its context from it. The
  loop stops at the first `satisfied` or `failed`, at the declared `max_iterations`
  (the last allowed evaluation reports `max_iterations_reached` and the agent still
  gets one final turn to settle its answer), when the session is interrupted, or
  when the session reaches the spending ceiling it declared. An interrupt closes the
  outcome as `interrupted`; a spent ceiling closes it as `budget_reached`, which is
  the code admission refuses the next work-starting event with. Neither records a
  `session.error`. A re-declared outcome on the same session is graded again, under
  a new `outcome_id`.
- A runtime that composes no grader refuses `user.define_outcome` at admission
  with `outcome_grader_unavailable` (400) on both ingress paths, rather than
  accepting an outcome it can never evaluate.

## 3. Alignment

Aligned for: lifecycle endpoints, status vocabulary, initial event processing,
the 50-event ceiling, the initial event type whitelist, the three `agent`
reference forms, and the tri-state override rule.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Session budget | Owned by [`budget.md`](./budget.md), which is `partial`. `/v1/sessions` accepts a `budget` at creation and echoes it back, and rejects a malformed one before the session is persisted; pricing and the ceiling rules are that contract's subject, not this one's. |
| Creation response | `initial_events` is not echoed back. The published contract does not state whether the creation response echoes it. |
| `cleanup_pending` | SandBase exposes this as a distinct status for local sandbox teardown. |
| Extension endpoints | Session inspection and control endpoints under `/v1/x` are local additions and are excluded from CMA admission. |
| Override refusal codes | `agent_model_required` is the published code for a cleared `model`. `agent_tools_cleared_with_skills`, `agent_mcp_server_not_found`, `invalid_agent_override_field`, `invalid_agent_overrides`, `invalid_agent_ref` and `agent_required` are SandBase spellings for the same conditions, published so a client can distinguish them without parsing prose. |
| `model.effort` in an override | Refused with `invalid_agent_override_field` rather than accepted and ignored. A definition may carry `effort` for read-back; a session snapshot is projected without an effort field, and no local provider executes one. |
| MCP cross-check scope | The published exception covers clearing `mcp_servers`. Locally the same check runs on the resolved definition, so a `tools` override that binds an `mcp_toolset` to an undeclared server is refused with `agent_mcp_server_not_found` instead of persisting a toolset that silently does nothing. |
| Outcome grader is provider-backed | Grading runs through a model provider. With none configured the evaluation closes as `failed` and the session records `outcome_evaluator_unavailable` with `retry_status: not_retryable` rather than reporting a verdict the runtime cannot produce. |
| No grader composed | `user.define_outcome` is refused at admission with `outcome_grader_unavailable` on both ingress paths, rather than accepted as an outcome the runtime can never evaluate. |
| Outcome iteration stopped for confirmation | A revision turn that stops for a tool confirmation ends the outcome as `interrupted`: the loop cannot drive another turn while the session waits for a human, and an outcome does not resume by itself. The published contract does not describe what a confirmation does to an outcome's iteration. |
| Outcome verdict at the spending ceiling | A session that spends its declared ceiling during an outcome closes it with `result: "budget_reached"` instead of transitioning to the published paused state. The ceiling is enforced between model requests and the loop's turns are not events, so this verdict is how a client learns why the iterations stopped; `budget.md` owns the ceiling itself. |
| `stop_reason.event_ids` for custom tools | **Partly not aligned.** For approval-gated `agent.tool_use` / `agent.mcp_tool_use` calls the array now names the pending events' own ids, and a `user.tool_confirmation` may address a call by that id. The `agent.custom_tool_use` half is not covered: those events are not scanned into `event_ids`, and `user.custom_tool_result.custom_tool_use_id` still accepts only the `tool_use` block id, so a conforming client's custom-tool answer is refused. That is a separate change with its own validator and answer event. |
| `stop_reason.action_type` | `tool_confirmation` is a SandBase extension field inside the object, not part of the published shape. It is kept for the local Console and is not presented as a published field. |

## 5. Reason for the difference

- Session budget has its own contract file rather than a clause here. A ceiling is
  priced from an operator-supplied profile and enforced at event admission, so it
  changes what an accepted event is allowed to start — a session-ingress concern
  whose evidence is a refusal code, not a lifecycle transition.
- Not echoing `initial_events` avoids presenting accepted input as restatable
  session state; the event stream is the authoritative record.
- `cleanup_pending` exists because local sandbox teardown is asynchronous and a
  caller needs to know teardown is still in progress.
- An override that cannot be honoured is refused rather than repaired: a session
  that quietly ran the base agent after a caller asked for a different one is the
  failure the override exists to prevent, and the same reasoning makes an
  unexecutable `effort` a refusal instead of a no-op field.
- The MCP cross-check runs on the resolved definition because the defect does not
  depend on which field introduced the binding. The agent definition path already
  refuses an undeclared server reference; letting an override reach the same state
  through the other field would be the same check applied to half the inputs.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — session create/read/status cases, engine
  admission, and rejection of an unknown loop engine.
- `tests/unit/session-resource-instances.test.ts` — resource attach, list,
  delete, and the memory-store at-creation rule.
- `tests/unit/agent-overrides.test.ts` — override parsing and resolution: the
  tri-state rule per field, the refusal codes, the cross-check on the resolved
  definition, and that the base definition is never mutated.
- `tests/integration/session-agent-overrides.test.ts` — the same behaviour over
  the wire: the override reaches the session's frozen snapshot while the durable
  agent and its version list stay untouched, a session without overrides keeps
  following the agent, every refusal is a code-carrying 400 that creates nothing,
  and `/v1/runs` refuses the override form.
- `tests/integration/outcome-grading.test.ts` — a declared outcome reaches the
  agent's context, the completed turn is graded, the span triple reaches the
  event log in order, and a runtime with no provider records
  `outcome_evaluator_unavailable` with `retry_status: not_retryable`.
- `tests/unit/outcome-loop.test.ts` and `tests/integration/outcome-loop.test.ts` —
  the revision loop: a `needs_revision` verdict appended as a real `user.message`
  with the executor re-entered for it, the spent budget reported as
  `max_iterations_reached` with one final settling turn, an interrupt closing the
  outcome as `interrupted` with no `session.error` (including one that lands inside
  a revision turn and one that stops for a tool confirmation), a session that spends
  its declared ceiling closing the outcome as `budget_reached` without another
  grading pass or turn, and `outcome_grader_unavailable` as a 400 on both ingress
  paths with nothing written.
- `tests/unit/cma-event-contract.test.ts` — `initial_events` validation: the
  whitelist, the 50-event ceiling, the `user.define_outcome` defaulting and its
  rejection cases, and the projection that lifts the payload out of the metadata
  carrier.
- `tests/integration/define-outcome-event.test.ts` — the same contract over the
  wire: an initial outcome reaches the log and returns projected on the event
  listing, a live malformed outcome is refused with `invalid_define_outcome` while
  a valid one is stored, and a rejected creation leaves no session behind.
- `tests/integration/initial-events-transaction.test.ts` — the transaction
  boundary: a rejected initial event leaves no session row and no attached
  resource behind, a successful batch creates the session and delivers every
  event, and the events' order and `processed_at` reflect admission.
- `tests/integration/session-stop-reason.test.ts` — the projected session-level
  `stop_reason`: `stop_reason.type` readable at the top level of a real
  `requires_action` pause and of a paused session reporting `end_turn`, the
  persisted `metadata.stop_reason` path a `202` decision reads still resolving
  and agreeing with the projection, the provider's `stop_reason` string on a
  model event left untouched, no other event type gaining an object, and an idle
  event with no reason omitting the field rather than sending `null`.
- `tests/integration/approval-event-id.test.ts` — the event-id exchange both
  ways: `event_ids` naming the pending event's own id and not the block id, a
  decision sent with that event id executing the tool, the block id still
  accepted, the deny result and the confirmation metadata both recorded under the
  block id so the model-facing pairing survives, a second decision refused even
  when it uses the other spelling, an id naming neither refused, a resolved call
  not re-decidable by its event id, and the refusal surfacing as
  `400 invalid_request` over the real route.

## 7. Status

`supported` for lifecycle, status vocabulary, initial events, the `agent`
reference including `agent_with_overrides`, and the declared-outcome loop:
grading runs in its own context window over what the agent produced, a
`needs_revision` verdict is appended as a real `user.message` and re-enters the
executor, and the loop is bounded by the declared `max_iterations`. The session
budget is `partial` in its own contract file, and this file does not claim it.
