# CMA Contract — custom tools

Contract area: caller-executed custom tool declarations.
Status: `supported`.
Source: `src/types/agent.ts` (`CanonicalCustomTool`),
`src/api/routes/session-normalizers.ts`.

---

## 1. Official definition

- A custom tool is declared as an independent `tools[]` entry on the agent, not
  grouped inside a toolset.
- Minimum fields: `name`, `description`, and an input schema.
- A custom tool is executed by the caller, not the runtime. The runtime's job is
  to surface the call and accept the result.

## 2. Current SandBase shape

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

## 3. Alignment

Aligned for: the inline `tools[]` placement, the field set, the `input_schema`
name, and the absence of a runtime-side permission policy on the declaration.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Legacy ingress | `custom_toolset` and `parameters` are accepted on write for backward compatibility. The published contract defines neither. |
| Canonical projection | Only the canonical shape is returned. A legacy grouping is not echoed back as written. |

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
- `tests/integration/api.test.ts` — agent round-trip carrying a custom tool.

## 7. Status

`supported` — the canonical declaration is parsed, projected, and covered by
tests.
