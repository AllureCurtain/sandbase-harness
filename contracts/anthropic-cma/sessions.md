# CMA Contract — sessions

Contract area: `/v1/sessions` — lifecycle, status transitions, initial events,
resources, budget.
Status: `supported` for lifecycle and initial events. The session budget is a
separate contract area with its own status and is not claimed here; see
`budget.md`.
Source: `src/api/routes/sessions.ts`, `src/api/routes/initial-events.ts`,
`src/api/routes/session-normalizers.ts`, `src/api/standard.ts`,
`src/core/agent/overrides.ts`, `src/core/session/session-manager.ts`.

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
  gets one final turn to settle its answer), or when the session is interrupted. An
  interrupt closes the outcome as `interrupted` and records no `session.error`. A
  re-declared outcome on the same session is graded again, under a new
  `outcome_id`.
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

## 7. Status

`supported` for lifecycle, status vocabulary, initial events, the `agent`
reference including `agent_with_overrides`, and the declared-outcome evaluation.
`partial` for the declared-outcome *loop*: grading is delivered, revision is not,
and the capability matrix records that split rather than claiming the loop. The
session budget is `partial` in its own contract file, and this file does not
claim it.
