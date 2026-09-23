# CMA Contract — tools

Contract area: built-in tools — availability, web tool domain policy, MCP
toolset approval, and tool output overflow.
Status: `partial` — web tools are configurable but not executable, and the local
overflow threshold differs, see §4.
Source: `src/core/capabilities/registry.ts`, `src/core/agent/web-tool-policy.ts`,
`src/core/agent/standard.ts`, `src/core/mcp/tool-naming.ts`,
`src/core/session/tool-output-overflow.ts`.

---

## 1. Official definition

- A built-in tool is either executable by the runtime or it is not. A runtime
  must not accept a tool configuration it cannot honour.
- `web_fetch` and `web_search` accept a domain policy: `allowed_domains` or
  `blocked_domains`, exactly one of the two.
- Domain grammar: plain ASCII hostnames only. No IP addresses, ports,
  wildcards, scheme prefixes, credentials, or whitespace. `localhost` and the
  `.localhost` / `.local` / `.internal` / `.localdomain` / `.invalid` suffixes
  are refused. `web_fetch` forbids a path; `web_search` permits a path suffix.
- An empty domain list is ambiguous and is refused: supply at least one domain
  or omit the field.
- Tool output beyond the published threshold is automatically written to a
  sandbox file; the model receives a truncated preview plus the file path.

## 2. Current SandBase shape

Tool availability (`RuntimeCapabilityRegistry`):

| Tool | Status |
| --- | --- |
| `bash`, `edit`, `read`, `write`, `glob`, `grep` | available |
| `web_fetch`, `web_search` | unavailable — no safe executable implementation |

An agent requesting an unavailable tool is rejected through
`UnsupportedCapabilityError`, which returns 400 `unsupported_capability` with
the offending ids and reasons. The check runs before a session is persisted, so
an unsupported request never leaves state behind.

Domain policy (`web-tool-policy.ts`):

- Validates `allowed_domains` / `blocked_domains` exclusivity, the 1–64 domain
  and 1–255 character bounds, the empty-list rejection, and the full hostname
  grammar including IPv4 shorthand (`127.1`), bracketed IPv6, reserved
  registry suffixes, and label-boundary hyphen rules.
- `web_fetch` refuses a path; `web_search` permits a path suffix but rejects
  `? # $ , | ^ !` and an empty path.
- Error message paths point at `tools.<i>.configs.<j>.allowed_domains.<k>` so a
  caller can find the offending entry in a nested toolset.

Two layers are deliberately distinguished: **expression** (the schema can
represent the configuration) and **execution** (the runtime can act on it).
`web_tool.configuration` is `supported`; `web_tool.execution` is `unavailable`.

Tool output overflow (`tool-output-overflow.ts`):

- One entry point (`spillToolOutput`) handles every overflow, so no tool
  invents its own truncation format.
- Canonical threshold 100,000 chars is recorded for reference and capability
  reporting; the enforced local limit is 50,000.
- Overflow files go to `/mnt/session/tool_outputs`, and every overflowed result
  carries `TOOL_OVERFLOW_MARKER` so a reader can tell a preview from a complete
  output.

MCP toolset approval (`standard.ts`, `tool-naming.ts`):

- Defaults by toolset kind: `agent_toolset_20260401` → `always_allow`,
  `mcp_toolset` → `always_ask`. A custom tool is outside permission policy
  entirely, because the caller executes it.
- A tool an MCP server exposes is known only after connect, so admission and
  approval are two separate decisions over the same name:
  - **Admission** (`mcpDiscoveredToolAdmitted`) decides visibility. A tool is
    admitted only if its owning toolset is enabled and the effective policy for
    it is not `never_allow` — including a toolset-wide `never_allow`, which
    covers tools the server adds later. A `never_allow` tool is withheld rather
    than gated, because shipping it invites the model to call what the operator
    forbade.
  - **Approval** (`resolveToolsRequiringConfirmation`) decides prompting. It is
    computed from the tool map actually resolved for the turn, so a discovered
    tool that inherits `always_ask` reaches the user for confirmation. A list
    built only from declared `configs` cannot gate a tool the agent never named,
    which is precisely how a discovered MCP tool ran unapproved.
- Both decisions key off the runtime name `mcp_<server>_<tool>`, defined once in
  `tool-naming.ts` and resolved back to a server by longest-prefix match. The
  layers that name a tool and the layers that gate it must agree on the string;
  a second spelling of the rule is how a policy silently stops applying.
- Pi's pre-execution gate is the one exception, and it is not a Harness
  permission verdict: `assertPiAgentCanExecute` admits an agent whose *effective*
  policy marks a native tool `always_ask`, and that tool's calls are stopped by a
  SandBase-managed Pi extension before they execute (`docs/pi-loop-engine.md`,
  "Always_ask gating"). The decision is durable and one-shot, so the call runs only
  if a decision was recorded for it. Anything Pi cannot express at all — a native
  tool Pi does not have, an enabled `mcp_toolset` — is still refused with
  `pi_tool_policy_not_supported` rather than admitted.

## 3. Alignment

Aligned for: the domain grammar and exclusivity rules, the empty-list rejection,
the refusal to accept configuration the runtime cannot execute, a single
unified overflow path rather than per-tool truncation, and the
`always_allow` / `always_ask` split by toolset kind including dynamically
discovered tools.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Web tool execution | SandBase has no safe executable web tool, so requests using one fail before a session is persisted. The published contract describes an executable tool. |
| Overflow threshold | 50,000 locals chars versus the published 100,000. The published value is recorded rather than silently replaced. |
| Overflow file location | `/mnt/session/tool_outputs`. The published contract states "a sandbox file" without fixing the directory. |
| Per-tool config shape | SandBase accepts named per-tool config blocks in a toolset. Field names inside the web policy follow the published ones. |

## 5. Reason for the difference

- Web tools are `unavailable` rather than `planned` because there is no safe
  local implementation: fetching arbitrary URLs from the host exposes the
  runtime's own network position, which is exactly what a sandbox is supposed
  to prevent. Marking them `planned` would imply a local implementation is
  coming.
- The lower local overflow threshold keeps a single tool result from dominating
  a local model's context window, where a hosted runtime has more headroom. The
  canonical constant is kept in the code so the divergence is visible.
- A fixed overflow directory makes retrieval predictable for a follow-up `read`
  call without the model having to parse a path out of prose.

## 6. Corresponding tests

- `tests/unit/web-tool-policy.test.ts` — 46 cases covering the domain grammar,
  exclusivity, empty-list rejection, path rules, and error paths.
- `tests/integration/api.test.ts` — unavailable tool rejection before session
  persistence.
- `tests/unit/tool-output-overflow.test.ts` — spill, preview, and marker
  behaviour, including the write-failure path that reports no path rather than a
  path that does not exist.
- `tests/unit/tool-output-overflow-wiring.test.ts` — the call sites: the built-in
  and MCP tool results share one `spillToolOutput` call, the Pi translator routes
  through the same module, and only one overflow-marker literal exists in the
  codebase. A unit test of the helper cannot detect a strategy that slices output
  inline, so the wiring is asserted separately.
- `tests/unit/custom-tool-canonical-shape.test.ts` — the approval ladder: the
  default per toolset kind, explicit overrides in both directions, custom tools
  ungated, the discovery admission rules, and namespaced-name resolution across
  several servers including the longest-prefix case.
- `tests/integration/mcp-approval-gate.test.ts` — the wiring, against a real
  stdio MCP server: a tool the server exposes but the agent never named is
  admitted yet has its `execute` removed and appears in the confirmation list,
  an explicit `always_allow` lets it run, and a toolset-wide `never_allow` keeps
  it from reaching the model at all.
- `tests/unit/pi-engine-session.test.ts` — Pi refuses an agent whose MCP toolset
  asks by kind, including one with no `default_config` written.
- `tests/unit/console-tool-permission.test.tsx` — the operator-visible half: the
  Console renders the effective policy per toolset, including the kind defaults,
  so a gated third-party MCP server is distinguishable from an ungated one.

## 7. Status

`partial` — configuration validation matches the published rules, and the MCP
toolset approval default applies to dynamically discovered tools. Execution of
web tools is `unavailable` and the local overflow threshold differs from the
published one; both are recorded in the capability matrix.
