# CMA Contract — session budget

Contract area: `max_list_cost` enforcement, usage reporting, pause and resume.
Status: `partial`. See §7.
Source: `src/core/session/session-budget.ts`,
`src/core/session/cost-profile.ts`, `src/core/session/session-manager.ts`,
`src/api/standard.ts`.

---

## 1. Official definition

- A session may carry a budget: `{"type": "limit", "max_list_cost":
  {"amount": "<integer cents as a string>", "currency": "USD"}}`.
- The budget is a **session-wide** ceiling shared by every thread. Each thread's
  cost is priced by the model that thread used.
- Enforcement lands **between model requests**: the request that crossed the cap
  completed, and the next one does not start.
- Reaching the cap pauses the session rather than terminating it. Every thread
  that pauses emits `session.thread_status_idle` with `stop_reason:
  budget_reached`; if a thread's last request both crossed the cap and finished
  its turn, that thread reports `end_turn` while the session still reports
  `budget_reached`.
- At the cap, only **settlement** events are accepted: `user.tool_confirmation`,
  `user.tool_result`, `user.custom_tool_result`, `user.interrupt`. A work-starting
  `user.message` is rejected.
- A budget cannot be attached to a session that has already consumed cost, and
  cannot be lowered to a value at or below what was already consumed. Removing a
  budget (`null`) and later attaching one is refused by the published contract.
- `session.usage` echoes the budget, or `null` when the session has none, and
  carries the accumulated list cost.

## 2. Current SandBase shape

Budget value and every refusal rule live in
`src/core/session/session-budget.ts`:

- `parseSessionBudget` maps `undefined` to "no budget", `null` to "remove", and
  validates the object form: `type: 'limit'`, an `amount` that is a positive
  integer string with no leading zero, and `currency: 'USD'`.
- `BUDGET_ERROR_CODES` names each refusal, and `budgetError` attaches it.

Pricing lives in `src/core/session/cost-profile.ts`:

- A `CostProfile` is **operator configuration**, read from the
  `MANAGED_AGENTS_COST_PROFILE` environment variable. It maps a model name to
  `input_per_mtok_cents` / `output_per_mtok_cents` / cache rates.
- `computeCost` returns `{microcents, cents, unpricedModels, perModel}`.
  Arithmetic is exact integer microcents throughout — `cents * 1_000_000` and a
  per-million-token rate cancel their factors — so no floating-point rounding
  enters a spend comparison. `list_cost` is reported as
  `Math.ceil(microcents / 1e6)`.
- A model the profile cannot price is reported in `unpricedModels`. It is never
  priced at zero.

Enforcement lives in `src/core/session/session-manager.ts`:

- `create()` calls `assertBudgetDeclarable`, which refuses a session whose own
  model, or any model in its resolved coordinator roster, has no list price.
- `isBudgetExhausted` reads spend through `sessionSpend` — the same function the
  API projects — so the client's number and the enforcement decision cannot
  disagree.
- `runTurn` passes `shouldStopBeforeModelRequest` into the executor; it becomes a
  cross-step `stopWhen` in `src/strategy/default-strategy.ts`, which is what
  places enforcement between requests rather than mid-request.
- `assertBudgetAllowsEvent` rejects a work-starting event at the cap with
  `BUDGET_SETTLEMENT_EVENT_LIST` named in the message.
- `buildUsagePayload` builds the `session.usage` payload: `list_cost` is present
  only when every model used was priced, and `budget` is always present
  (`null` when absent).
- A deployment's `budget` is copied onto each session it starts
  (`src/core/operations/scheduler.ts`), so it bounds one run rather than
  accumulating across runs.

## 3. Alignment

Aligned with:

- the budget value shape and its `type: 'limit'` / `max_list_cost` nesting;
- enforcement between model requests, expressed as an engine stop condition
  rather than an abort;
- pause rather than terminate, with the session reporting `budget_reached`;
- the settlement-event whitelist at the cap;
- refusing to attach, or to lower below consumed cost;
- `session.usage` echoing the budget and the accumulated list cost;
- a shared session-wide ceiling, since delegated runs mirror their
  `span.model_request_end` onto the same session log.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Prices are local, not official | `list_cost` is computed from an operator-supplied `CostProfile`. SandBase never embeds vendor prices. With the default empty profile, no model is priced and a session cannot be budgeted at all. |
| Unpriced model ⇒ no budget | A model the profile does not list makes the session unbudgetable (`modelWithoutListPrice`). The published contract has authoritative prices, so the case does not arise for it. |
| `list_cost` withheld when incomplete | When any model used is unpriced, `usage.list_cost` is omitted rather than reported as a lower bound. Reporting a lower bound as a total would understate spend to a caller that is about to choose a new cap. |
| No `budget_reached` on the thread when the turn also ended | The thread reports `end_turn` whenever the turn completed, and only the session reports `budget_reached`. This matches the published rule for the both-at-once case; the session-level reason is the authoritative pause signal. |
| No rescheduling | `session.status_rescheduled` / `session.thread_status_rescheduled` are not emitted, because no transient-error retry schedule exists. |
| Server-tool cost is always zero | `usage.server_tool_use` reports `{web_search_requests: 0, web_fetch_requests: 0}` unconditionally, because web tool execution is `unavailable`. This is a true statement about local behaviour, not a claim that the tools ran. |

## 5. Reason for the difference

- **Local pricing.** A self-hosted runtime has no vendor billing feed, and
  embedding a price table would make SandBase assert numbers it cannot verify.
  Making the profile operator-supplied means the spend number is traceable to a
  configuration the operator can inspect, and an *unpriceable* session fails
  loudly instead of being metered against invented prices. This is the same
  reason the entry is `partial` rather than `supported`: the mechanism matches,
  the price source deliberately does not.
- **Withholding an incomplete total.** A partial cost is worse than none when the
  consumer is choosing a cap: it reads as "this is what you spent" and leads to a
  budget that is too low. Naming the unpriced models instead lets the operator
  fix the profile.
- **No rescheduling.** Emitting a retry status implies a retry loop. SandBase has
  none, and inventing the event would tell a client to wait for something that
  will not happen.

## 6. Corresponding tests

- `tests/unit/session-budget.test.ts` — budget parsing and every refusal code,
  exact-microcent cost arithmetic, unpriced-model naming, exhaustion at the
  boundary, settlement-event acceptance at the cap, attach/lower/remove rules,
  the three-state budget (`undefined` / `null` / object), `buildUsagePayload`,
  and derivation from the durable log across a restart.
- `tests/unit/session-threads.test.ts` — the primary thread reporting
  `budget_reached` as its own `stop_reason` on `session.thread_status_idle`.
- `tests/integration/operations-bridge.test.ts` — deployment budget passthrough.

## 7. Status

`partial`. The enforcement mechanism, event vocabulary, and refusal rules follow
the published contract. The deviation is the price source: costs come from a
local, operator-supplied profile rather than authoritative vendor list prices, so
a session whose models are unpriced cannot be budgeted and `list_cost` is omitted
while any used model is unpriced. Not `supported`, because a `supported` entry
would claim the same cost figures the published contract reports, which this
runtime cannot produce without inventing prices.
