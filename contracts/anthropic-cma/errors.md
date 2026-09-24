# CMA Contract — errors

Contract area: error envelope and error codes.
Status: `supported` — with the code-string caveat in §4.
Source: `src/api/routes/resource-utils.ts`, `src/api/cma-admission.ts`,
`src/api/capability-errors.ts`.

<!-- capability-status
structured-error-envelope: supported
-->

---

## 1. Official definition

- A rejected request returns a structured error object rather than a bare
  string, so a client can branch on the failure kind without parsing prose.
- The published contract groups failures by category: the request was invalid,
  the resource was absent, or the request conflicts with current state.

## 2. Current SandBase shape

The envelope helpers are `src/api/routes/resource-utils.ts`; admission failures
are raised by `src/api/cma-admission.ts` and capability refusals by
`src/api/capability-errors.ts`.

Errors are produced by shared helpers so every route answers in one shape:

| Helper | HTTP | `error.type` | Extra |
| --- | --- | --- | --- |
| `invalid(c, message, code?)` | 400 | `invalid_request` | optional stable `code` |
| `conflict(c, message, code?)` | 409 | `conflict` | optional stable `code` |
| `notFound(c, message)` | 404 | `not_found` | — |
| `unsupportedCapability(c, error)` | 400 | `unsupported_capability` | `details.capabilities: [{id, reason}]` |

The same `notFound` envelope answers a path this server does not serve. It is
registered as the server's fallback in `src/api/server.ts`, so an unrouted
request gets `application/json` and `error.type: "not_found"` rather than the
framework's `text/plain` body. Its message is `No route matches this request`,
which is deliberately a fixed sentence: it does not echo the requested path, and
it stays distinguishable from a route's own missing-resource message. Because
authentication, throttling, and compatibility admission are mounted before
routing, an unmatched `/v1/*` path still answers `401`, `429`, or an admission
`400` before the fallback can run.

Admission failures add a stable code from `CMA_ADMISSION_CODES`:

| Code | Condition |
| --- | --- |
| `missing_anthropic_version` | compatibility caller omitted the version header |
| `unsupported_anthropic_version` | version present, not `2023-06-01` |
| `missing_anthropic_beta` | compatibility caller omitted the beta header |
| `malformed_anthropic_beta` | beta is not comma-separated identifiers |
| `unsupported_anthropic_beta` | beta does not match the resource family |
| `conflicting_memory_store_beta` | both memory betas on a memory-store path |

Memory preconditions add `precondition_failed` on a 409, carrying the current
content hash so the caller can retry against the real state.

A rejected capability carries the specific capability ids and their reasons, so
the caller learns which request field to remove rather than receiving a generic
"unsupported".

## 3. Alignment

Aligned for: structured envelope, category separation (invalid / conflict /
missing), a machine-readable code where a client must branch, and an error that
names the exact offending capability, field, or precondition.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Code strings | SandBase `code` values are local and stable. The published contract documents error categories, not SandBase's code vocabulary; no code string here is claimed to be an upstream value. |
| HTTP status mapping | SandBase maps a memory content-hash mismatch to 409 `precondition_failed`. The published contract states the precondition concept but not this exact status pairing. |
| Extensions | `unsupported_capability` and `precondition_failed` are SandBase codes covering local runtime facts. |

## 5. Reason for the difference

- Local code strings exist because a client that retries needs to distinguish a
  fixable request bug from a state conflict. Collapsing every 400 into one
  opaque body would make correct retry logic impossible, which the admission
  module records as its own rationale.
- 409 for a failed precondition reflects that the request was well-formed but
  the stored state moved. 400 would imply the caller's request was malformed,
  which it was not.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — rejection cases assert `error.type` and the
  presence of a stable code; resource lifecycle cases assert 404 vs 409.
- `tests/integration/unrouted-path-404.test.ts` — an unrouted path in the
  managed-agents, extension, and non-`/v1` namespaces, and an unmounted verb on a
  mounted path, each answer the JSON `not_found` envelope; a missing resource
  keeps its own message; the Console surface keeps its status codes; and
  authentication still precedes routing.
- `tests/unit/memory-semantics.test.ts` — precondition evaluation returns
  `precondition_failed` with the current hash.

## 7. Status

`supported` — the envelope and category separation are enforced and tested. The
specific code strings are a documented local projection, not an upstream claim.
