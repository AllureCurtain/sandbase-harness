# CMA Contract — agents

Contract area: `/v1/agents` — agent definitions, model profile, toolsets.
Status: `supported` for CRUD; `partial` for the model object profile. See §4.
Source: `src/core/agent/schema.ts`, `src/core/agent/update.ts`,
`src/core/agent/model-object.ts`, `src/api/routes/agents.ts`,
`src/api/routes/session-normalizers.ts`.

<!-- capability-status
agent-crud: supported
model-object-profile: partial
-->

---

## 1. Official definition

- An agent is a named, versioned definition: model, system prompt, tools, and
  the resources it may use.
- `model` may be a plain string, or an object carrying `id` plus optional
  `speed`, `effort`, and `inference_geo`.
- An agent may declare a `multiagent` roster describing other agents it can
  delegate to.
- Tool entries may carry per-tool configuration, including the domain policy for
  `web_fetch` and `web_search`.

## 2. Current SandBase shape

The write paths are `src/core/agent/schema.ts` and `src/core/agent/update.ts`,
the model profile is `src/core/agent/model-object.ts`, and the routes are
`src/api/routes/agents.ts` with `src/api/routes/session-normalizers.ts`.

- Agent definitions are created, listed, read, and version-archived. Updating an
  agent produces a new archived version; the prior definition remains readable
  rather than being overwritten. `PUT` and `PATCH` share one partial-update
  implementation.
- `model` normalizes to a string for execution. The object form is parsed field
  by field by `normalizeModelField`, and each field is either honoured or
  refused by name (see §4).
- Toolsets (`builtin` / `custom` / `mcp` / `skill`) are validated against a Zod
  schema before an agent is persisted; a definition that fails validation is
  rejected instead of being stored partially.
- `web_tool.configuration` is fully validated (domain grammar, allowed/blocked
  exclusivity, empty-list rejection). See [`tools.md`](./tools.md).

## 3. Alignment

Aligned for: agent identity and versioning, toolset structure and validation,
the string model form, web tool configuration shape, and refusing a declared
field the runtime cannot honour instead of dropping it.

## 4. Differences

| Difference | Detail |
| --- | --- |
| `model.speed` | Accepted and stored as the local config spelling; `fast` / `standard` / `extended` are local vocabulary. |
| `model.effort` | Parsed, validated, and carried into the stored definition, but it does not change the provider request, and the API read projection does not return it. Recorded as accepted-but-no-effect rather than as executed. |
| `model.inference_geo` | Refused by name with `unsupported_model_field` when a well-formed pin is sent: this runtime has no inference-geography control, so accepting it would promise a pin it cannot hold. An unknown value is `invalid_inference_geo` first. |
| Version retention | SandBase keeps prior agent versions readable in its own archive table. The published contract states versioning but not the retention mechanism. |

## 5. Reason for the difference

- A local provider has no inference geography, so executing an `inference_geo`
  pin would mean inventing semantics. Refusing it by name tells the caller the
  field was understood and cannot take effect, which is the only answer they can
  act on.
- `effort` is retained rather than refused because the canonical request shape
  carries it and the value is worth preserving for a provider that can use it
  later; it is recorded as having no effect today so no caller infers a quality
  change from it.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — agent create/list/read/version behaviour and
  toolset rejection cases.
- `tests/unit/agent-model-object.test.ts` — the model object profile: each
  field's acceptance or refusal, including `effort` carried through validation
  and `inference_geo` refused by name.
- `tests/integration/agent-update-contract.test.ts` — the unified partial-update
  semantics and the unknown-field refusal.
- `tests/unit/web-tool-policy.test.ts` — per-tool web configuration validation.

## 7. Status

`supported` for agent CRUD and toolset validation. `partial` overall, because
the model object profile is understood but partly unexecuted: `effort` has no
effect and `inference_geo` is refused rather than honoured.
