# CMA Contract — capabilities

Contract area: capability reporting and status truthfulness.
Status: `supported`.
Source: `src/core/capabilities/matrix.ts`,
`src/core/capabilities/registry.ts`, `src/api/routes/runtime.ts`.

---

## 1. Official definition

- The published contract distinguishes implemented behaviour from behaviour that
  is not implemented. A caller must be able to tell what a given runtime will
  actually do before depending on it.
- A runtime that accepts a request it cannot honour is worse than one that
  refuses it.

## 2. Current SandBase shape

Two complementary inventories are served from `GET /v1/x/capabilities`:

| Inventory | Answers | Shape |
| --- | --- | --- |
| Runtime tool inventory | "can this build execute the tool it accepted?" | `{id, kind, status: available \| unavailable, reason?}` |
| Contract matrix | "does this build implement each published behaviour, and if not, why not?" | `{area, id, status, reason, contract}[]` |

The six-value contract status enum:

| Status | Meaning |
| --- | --- |
| `supported` | implemented and exercised by a test |
| `partial` | implemented for a documented subset or with a documented deviation |
| `unavailable` | not implemented; a dependent request fails before persisting state |
| `planned` | not implemented and scheduled |
| `not_applicable` | deliberately out of scope for a local-first runtime |
| `unverified` | implemented but not confirmed against the published contract |

Properties the matrix enforces:

- Every non-`supported` entry carries a `reason`. A status without a reason
  would be a claim with no substance.
- Every entry names the contract document that carries its seven-section detail,
  so a status is traceable to prose and tests rather than standing alone.
- `capabilitySummary()` reports counts per status, so coverage is visible as a
  distribution rather than a single number. "Coverage" is not scored: a
  `not_applicable` entry is a decision, not a missing point.
- `capabilityMatrixJson()` is the single projection, so the endpoint and any
  published JSON cannot drift apart.
- `capabilityEntry(id)` throws on an unknown id, so a typo in a consumer fails
  loudly instead of silently finding nothing.

The runtime tool inventory remains separate because it answers a different
question: the matrix describes protocol coverage, while the inventory describes
what this particular build can execute. Both are returned so a client never has
to infer one from the other.

## 3. Alignment

Aligned for: reporting implemented vs. unimplemented behaviour, refusing a
request the runtime cannot honour, and keeping "not implemented" distinguishable
from "deliberately out of scope".

## 4. Differences

| Difference | Detail |
| --- | --- |
| Status vocabulary | The six-value enum is a SandBase design. The published contract requires the distinction, not this particular vocabulary. |
| Extension surface | The endpoint lives under `/v1/x/capabilities`, a local extension excluded from CMA admission. The published contract does not define a capability endpoint. |
| Unverified state | `unverified` is a SandBase addition covering behaviour that is implemented but not confirmed against upstream. |

## 5. Reason for the difference

- The six values exist because a boolean cannot express the difference between
  "we have not built this", "we chose not to build this", and "we built it but
  have not confirmed it matches". Collapsing those into two states is how a
  coverage report ends up overstating what works.
- `unverified` is deliberately not a soft `supported`. It exists so a claim that
  has not been checked against the published contract is not counted as done.
- Serving the endpoint under `/v1/x` keeps the extension namespace rule intact:
  a capability query is a local question about a local build.

## 6. Corresponding tests

- `tests/unit/capability-registry.test.ts` — runtime inventory and the
  unsupported-capability rejection path.
- `tests/unit/loop-engine-truthfulness.test.ts` — "no feature is reported as
  available when it cannot execute" cases across engines.

## 7. Status

`supported` — both inventories are served, the six-value enum is enforced with a
required reason per entry, and the rejection path is covered by tests.
