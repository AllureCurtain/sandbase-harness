# CMA Contract — system.message

Contract area: the `system.message` event domain.
Status: `supported`.
Source: `src/api/routes/system-message.ts`, `src/types/cma-protocol.ts`.

---

## 1. Official definition

- `system.message` is its own event domain, distinct from `user.message` and
  `agent.message`.
- It carries privileged system-level content rather than conversational turns,
  so it must not be rendered or treated as either participant speaking.
- It is an outbound event: the runtime emits it to the client.

## 2. Current SandBase shape

- `system.message` is accepted and persisted as its own event type, not folded
  into an agent or user domain.
- The payload shape is validated before persistence.
- Downstream consumers (event projection, Console rendering) treat
  `system.message` distinctly, so a system notice is not rendered with a user
  or agent identity.

## 3. Alignment

Aligned for: separate event domain, outbound direction, and distinct treatment
in projection and rendering.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Field vocabulary | SandBase validates its own field set for the payload. The published contract documents the domain and its privileged nature, not an exhaustive field list. |
| Console rendering | The Console has its own presentation for a system notice. Presentation is a local concern with no wire effect. |

## 5. Reason for the difference

- The published documentation names the domain and its semantics but does not
  enumerate every payload field. SandBase validates the fields it does handle
  and rejects a malformed payload rather than accepting an unknown shape it
  cannot interpret.
- Distinct Console presentation exists so an operator can tell a system notice
  from a conversation turn at a glance.

## 6. Corresponding tests

- `tests/unit/system-message-contract.test.ts` — the domain is accepted,
  persisted separately, and validated.

## 7. Status

`supported` — the domain is implemented as a first-class event type and covered
by a dedicated contract test.
