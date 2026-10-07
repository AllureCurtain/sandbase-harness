# CMA Contract — custom tools

Contract area: caller-executed custom tool declarations.
Status: `supported`.
Source: `src/types/agent.ts` (`CanonicalCustomTool`),
`src/api/routes/session-normalizers.ts`.

<!-- capability-status
custom-tool-declaration: supported
custom-tool-worker-execution: supported
-->

---

## 1. Official definition

- A custom tool is declared as an independent `tools[]` entry on the agent, not
  grouped inside a toolset.
- Minimum fields: `name`, `description`, and an input schema.
- A custom tool is executed by the caller, not the runtime. The runtime's job is
  to surface the call and accept the result.

## 2. Current SandBase shape

The declaration is `CanonicalCustomTool` in `src/types/agent.ts`; normalization
is `src/api/routes/session-normalizers.ts`.

`CanonicalCustomTool`:

| Field | Required | Note |
| --- | --- | --- |
| `type` | yes | literal `'custom'` |
| `name` | yes | tool identity |
| `description` | yes | what the tool does, for the model |
| `input_schema` | yes | JSON Schema; `parameters` accepted as a legacy alias |
| `parameters` | no | legacy-only alias for `input_schema` |
| `enabled` | no | legacy-only, accepted from `custom_toolset` input, never projected canonically |

- `custom_toolset` (the legacy SandBase grouping) is accepted on ingress and
  projected back as a flat `CanonicalCustomTool` list, so a client reading an
  agent sees the canonical shape regardless of how it was written.
- The declaration deliberately carries no permission policy. The caller decides
  whether to run the tool, so a policy field would claim governance the runtime
  does not have.
- A tool call for a custom tool is persisted and surfaced to the caller; the
  runtime waits for the caller's result rather than executing anything.
- The waiting loop is the published one: `agent.custom_tool_use` is emitted, the
  session pauses with `stop_reason.type: "requires_action"`, and the call's
  **event** id is listed in `stop_reason.event_ids` alongside any approval-gated
  call parked at the same time. The caller answers with
  `user.custom_tool_result`, passing that event id in `custom_tool_use_id`. The
  `tool_use` block id is accepted there too, as a documented local convenience.
  Whichever arrives, the persisted `metadata.custom_tool_use_id` is the **block**
  id, because the model-facing projection pairs a custom tool result to its call
  by tool-call id. A call that has been answered stops being listed, and a second
  answer for one call — by either spelling — is refused.
- The turn resumes when the **last** parked call is answered. A custom tool call
  and an approval-gated call parked in the same step are answered independently
  and in either order; each answer is recorded as it arrives and the session
  stays in `requires_action` until none is left. Answering only some of them does
  not start a turn, does not fail a session, and leaves the rest listed.
- On a **self-hosted** environment there is a second way for the call to be
  answered, and it is the same answer by a different hand. After the
  `agent.custom_tool_use` event is persisted, the session's sandbox enqueues a
  `custom_tool` work item on the environment's work queue — payload
  `{tool_name, tool_use_id, input}`, where `tool_use_id` is the call's
  `tool_use` block id — and a worker claims, executes, and completes it through
  the same `/v1/x/worker` routes as every other kind. The completed outcome is
  injected back as a `user.custom_tool_result` addressed to that block id,
  through `SessionManager.sendEvent`, so the parked-call rules still apply: a
  second answer — from the caller or from a late completion — is refused, a
  result for a session that has ended is refused, and the last parked answer
  resumes the turn through the normal execution chain. The worker declares its
  tools in a local module (`managed-agents worker poll --tools <module>`): a
  call naming a tool the worker does not declare is answered with an
  `is_error` result, a thrown handler the same, and a completion the queue
  records `failed` also reaches the session as an error result, because a
  parked call must end with an answer. On every other provider nothing is
  enqueued and the caller answers as before; a self-hosted session may also be
  answered by the caller in the published way, whichever arrives first.

## 3. Alignment

Aligned for: the inline `tools[]` placement, the field set, the `input_schema`
name, and the absence of a runtime-side permission policy on the declaration.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Legacy ingress | `custom_toolset` and `parameters` are accepted on write for backward compatibility. The published contract defines neither. |
| Canonical projection | Only the canonical shape is returned. A legacy grouping is not echoed back as written. |
| Worker execution | On self-hosted environments the runtime's own workers can execute the call: the persisted call becomes a `custom_tool` work item and its completion is injected as the `user.custom_tool_result`. The published contract has the environment worker performing this role; here it is the local worker over the local queue — same parked-call semantics, different transport. On non-self-hosted providers the caller answers as published. |

## 5. Reason for the difference

- The legacy grouping existed before the canonical shape was known. Accepting it
  on ingress is a migration courtesy; projecting it back would keep the old
  shape alive in every consumer.
- Not projecting `custom_toolset` is deliberate: a client should not have to
  handle two shapes for one fact.

## 6. Corresponding tests

- `tests/unit/custom-tool-canonical-shape.test.ts` — declaration parsing and
  canonical projection.
- `tests/unit/custom-tool-loop.test.ts` — the caller-executed loop: the runtime
  surfaces the call and accepts the caller's result without executing anything.
- `tests/integration/custom-tool-event-id.test.ts` — the published answer
  exchange end to end against the real strategy and status transition: the
  parked call's own event id in `event_ids` and not the block id, an answer
  naming it accepted and the model resumed with the paired result, the block-id
  spelling still accepted, the persisted `metadata.custom_tool_use_id` staying
  the block id, an answered call no longer listed while an unanswered one is
  kept, a second answer refused even when it uses the other spelling, an id
  naming nothing refused, and the projected `stop_reason` carrying exactly
  `{type, event_ids}` with no `action_type`.
- `tests/integration/resume-gate.test.ts` — a partial answer, in every
  combination including a custom call parked beside an approval-gated one, leaves
  the session in `requires_action` with no `session.error` and starts no turn,
  and the remaining answers resume it with every call paired.
- `tests/integration/api.test.ts` — agent round-trip carrying a custom tool.
- `tests/integration/worker-custom-tools.test.ts` — the self-hosted path end to
  end: the persisted call enqueues a `custom_tool` item, a worker's completion
  through the real routes resolves the parked call and resumes the turn, an
  `is_error` result and a `failed` completion both reach the session as error
  results, a second completion cannot answer twice, a completion after the
  session ended injects nothing, a local environment enqueues nothing, and the
  worker-side registry covers declared, undeclared, and throwing handlers plus
  `--tools` module loading.

## 7. Status

`supported` — the canonical declaration is parsed, projected, and covered by
tests; on self-hosted environments the environment's own workers can execute
the parked call through the work queue, with the completion injected under the
same admission rules as a caller's answer.
