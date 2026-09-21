# CMA Contract — agents

Contract area: `/v1/agents` — agent definitions, model profile, toolsets.
Status: `supported` for CRUD; `partial` for the model object profile, see §4.
Source: `src/core/agent/schema.ts`, `src/api/routes/agents.ts`,
`src/api/routes/session-normalizers.ts`.

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

- Agent definitions are created, listed, read, and version-archived. Updating an
  agent produces a new archived version; the prior definition remains readable
  rather than being overwritten.
- `model` normalizes to a string for execution. The object form is parsed, and
  its extra fields are handled rather than dropped (see §4).
- Toolsets (`builtin` / `custom` / `mcp` / `skill`) are validated against a Zod
  schema before an agent is persisted; a definition that fails validation is
  rejected instead of being stored partially.
- `web_tool.configuration` is fully validated (domain grammar, allowed/blocked
  exclusivity, empty-list rejection). See `tools.md`.
- Unknown keys and unsupported field values are rejected, not silently
  discarded — a dropped field is a caller believing in behaviour that does not
  exist.

## 3. Alignment

Aligned for: agent identity and versioning, toolset structure and validation,
the string model form, and web tool configuration shape.

## 4. Differences

| Difference | Detail |
| --- | --- |
| `model` object fields | `id` is honoured. `speed` is accepted as the local extension spelling. `effort` and `inference_geo` are parsed but not executed by a local provider, and are surfaced as structured unavailable results rather than silently ignored. |
| `multiagent` roster | A delegation helper exists locally, but the canonical threads/coordinator/advisor profile is not implemented. It is not presented as the canonical roster. See `unsupported.md`. |
| Version retention | SandBase keeps prior agent versions readable in its own archive table. The published contract states versioning but not the retention mechanism. |

## 5. Reason for the difference

- A local provider has no inference geography and no comparable effort control,
  so executing those fields would mean inventing semantics. Returning a
  structured unavailable result tells the caller the field was understood and
  will not take effect.
- The `multiagent` roster is a substantial protocol surface (threads,
  coordinator role, advisor role). Mapping a local delegation helper onto it
  would overstate coverage, so the gap is recorded instead.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — agent create/list/read/version behaviour and
  toolset rejection cases.
- `tests/unit/web-tool-policy.test.ts` — per-tool web configuration validation.

## 7. Status

`supported` for agent CRUD and toolset validation. `partial` overall, because
the model object profile is understood but not executed and the canonical
multiagent roster is not implemented.
