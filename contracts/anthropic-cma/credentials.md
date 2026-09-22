# CMA Contract — credentials and vaults

Contract area: `/v1/vaults` and vault credentials.
Status: `supported` for the wire profile and rotation; OAuth refresh is
`unavailable`, see §4 and §7.
Source: `src/core/credentials/canonical-credential.ts`,
`src/api/routes/credential-vaults.ts`, `src/core/credentials/policy.ts`.

---

## 1. Official definition

- A vault carries `display_name` and optional `metadata`.
- A credential nests its type under `auth`. Each type has its own shape:
  - `mcp_oauth` — keyed by `mcp_server_url`, with `access_token` and an optional
    `refresh` block carrying `token_endpoint`, `client_id`, and
    `token_endpoint_auth`.
  - `static_bearer` — keyed by `mcp_server_url`, carrying a fixed `token`.
  - `environment_variable` — keyed by `secret_name`, carrying `secret_value`,
    `networking`, and `injection_location`.
- MCP credential types are **keyed by `mcp_server_url`**: a credential matches
  the MCP server declared with the same URL. Matching normalizes scheme and host
  case, removes a default port, and ignores a single trailing slash; a different
  path, subdomain, or non-default port is a genuine mismatch.
- Write-only fields — `token`, `access_token`, `refresh_token`,
  `client_secret`, `secret_value` — are accepted on write and never returned.
- Structural fields — `mcp_server_url`, `secret_name`, `token_endpoint`,
  `client_id` — are locked after creation. Changing one requires archiving the
  credential and creating a new one.
- `injection_location` is an optional object with `header` and `body` booleans,
  sibling to `networking`:
  - On create, **omitting it enables both positions**; supplying the object
    fills omitted fields with `false`.
  - An explicit `null` for the object or either field is an error; the field
    should be omitted instead.
  - At least one position must be enabled.
  - The response always returns both fields resolved.

## 2. Current SandBase shape

Wire profile:

- `display_name` is read from the **top level** of the payload, a sibling of
  `auth` and `metadata`. `auth.display_name` is accepted as a local alias and
  the top-level spelling wins when both are present.
- The three canonical `auth.type` values are supported. The local legacy values
  `bearer_token` (flat) and the `auth_type` + `value` + `variable_name` flat
  spelling are accepted on write and normalized.
- Supplying both `auth` and the flat spelling is rejected rather than merged:
  merging would let a flat field override a nested one, which is how a
  credential ends up pointed somewhere the caller did not intend.

Write-only handling:

- Secret material is encrypted at rest; the record stores only a hint (the last
  four characters) for display.
- `toCanonicalCredential` omits write-only fields entirely rather than masking
  them, because a mask could be mistaken for the real value.

Locked fields:

- `checkCredentialUpdate` reports **every** locked field an update tried to
  change, so the caller learns the full set rather than fixing one and
  rediscovering the next.

Rotation:

- A rotation replaces only the ciphertext, nonce, tag, and hint. The credential's
  identity, `auth_type`, name, network policy, and injection locations are
  preserved. The prior ciphertext is overwritten, so the old secret is not
  recoverable from this runtime once rotation succeeds.
- When the rotated Vault is referenced by a live Session, the runtime asks that
  Session's MCP manager to close and reconnect its configured transports, so the
  next MCP tool call uses the newly resolved credential without recreating the
  Session. A reconnect failure does not roll back the committed rotation: the
  Session is reported in the failure set the caller receives, and the MCP status
  remains the source of truth for a degraded server.

`injection_location`:

- Implemented to the published rules, including the create/update asymmetry, the
  `null` rejection, the at-least-one rule, and returning both fields resolved.
- The local legacy `injection_locations` token list is kept as a SandBase
  extension on the stored record, so a caller that wrote a token list still
  observes it. The canonical `auth` projection carries `injection_location` only
  for environment variables.
- For the two MCP types the field is not part of the create shape, so a credential
  created through the published route stores an empty list. On a credential keyed by
  `mcp_server_url` an empty list is read as "not specified" and the secret is
  presented as a request header, which is the only position a url transport offers.
  A list that was given is still read as written, so a keyed credential never gains
  a position its own record excluded.

MCP URL binding:

- `mcpServerUrlMatches` canonicalizes both sides before comparing: scheme and
  host case, a default port, and a single trailing slash are normalized, and a
  different path, subdomain, or non-default port is a mismatch. It is applied on
  the connection path: a credential keyed by `mcp_server_url` is attached only to
  the server whose URL it names, and a caller that names no server never receives
  one. A credential for another endpoint is not applicable to this call rather than
  refused for it, so the connection is attempted without authentication and no
  denial is recorded.

GitHub resource boundary:

Session execution:

- `DefaultSessionExecutor` resolves the session's vaults once per turn with
  `resolveSessionCredentialInjections`, injects the resulting `environment` into
  the sandbox command environment, redacts every value a sandbox tool hands back,
  and clears the retained values when the turn ends. The resolver is supplied by
  the runtime composition (`src/index.ts` → `createRuntimeSessionServices` → the
  executor), so a runtime started by the CLI has the path; an embedder that
  assembles these services without a credential store runs sessions with no vault.
- A shell command declares no target host, so only credentials the policy admits
  without one reach the environment. A `limited` credential is denied for a shell
  command exactly as it is denied for any other call without a target host.
- The same resolved `environment` starts a stdio MCP server the agent declares,
  and a vault value wins over the `env` the agent configured itself. A
  url-transport server is handed the credentials scoped to its own URL as request
  headers, on the initial SSE request and on every message POST. Values an MCP tool
  returns are scrubbed the way a sandbox tool's return value is, and the resolver's
  bundle is cleared after each use so nothing outlives the call.
- The delegated child path is **not** covered: `DelegationService` builds its own
  sandbox tools and does not thread credentials, so a sub-agent receives no vault
  environment. Nothing is injected into model requests either.

- A `github_repository.authorization_token` is a separate encrypted
  session-resource secret, matching the official CMA GitHub resource shape. It
  is not resolved from `vault_ids`; Vault credentials are used for MCP and
  environment-variable authentication. A future `credential_id` reference may
  be offered as a SandBase extension, but it must not replace the canonical
  resource field or make GitHub mounts depend on an unrelated Vault.

## 3. Alignment

Aligned for: the nested `auth` profile, all three type shapes, MCP keying by
URL with normalization, write-only secret handling, locked structural fields,
the `injection_location` create rules and the both-fields-resolved read
projection, rotation that preserves identity and reconnects the MCP transports of
the sessions that reference the vault, and the session path that injects a
vault's environment into its own sandbox commands and into a stdio MCP server the
agent declares, attaches a `static_bearer` credential to the url-transport server
whose URL it was keyed to, and redacts what each of them returns.
There is no credential update route: structural fields are locked, so a change
means archive and recreate.

## 4. Differences

| Difference | Detail |
| --- | --- |
| OAuth refresh | There is no refresh loop, no refresh-failure event, and no validate endpoint. A supplied `refresh` block is parsed, recorded, and reported back as **not executed**, with a warning on the response. |
| Legacy ingress | The flat `auth_type` spelling and the `injection_locations` token list are accepted for backward compatibility. The published contract defines neither. |
| Read projection | The canonical `auth` object is additive on read: it is returned beside the local `auth_type` / `name` / `variable_name` / `injection_locations` fields. The Console credential pages render and search on those local fields (`CredentialPages.tsx`, `CredentialVaultPages.tsx`) and `tests/integration/api.test.ts` asserts them, so dropping them is a Console migration rather than a wire change. |
| Local network policy | `networking` normalization uses the same shared normalizer the runtime policy uses, so a stored policy and an enforced policy cannot disagree. The published contract states the field and its meaning, not the normalization detail. |
| Audit | Rotations append a credential audit event. The published contract requires rotation semantics without fixing an audit shape. |
| Delegated execution | A session's vault environment reaches its own sandbox commands and a stdio MCP server it declares, but the delegated child path builds its own sandbox tools and receives none. The published contract does not describe sub-agent credential scope, so this is recorded as a boundary rather than presented as alignment. |

## 5. Reason for the difference

- OAuth refresh is reported rather than silently stored because the failure mode
  matters: a session would keep presenting an expired access token and report
  nothing. A warning that reaches the caller is the difference between a
  diagnosable auth failure and a mystery.
- The legacy spelling is accepted so existing SandBase callers keep working, but
  it is documented as legacy rather than presented as canonical.
- Rotation preserving identity follows from the locking rule: if identity
  fields cannot change, a rotation that changed them would be a new credential
  wearing an old id.

## 6. Corresponding tests

- `tests/unit/canonical-credential.test.ts` — 26 cases: `injection_location`
  create/update asymmetry and `null` rejection, all three auth shapes, the
  both-spellings rejection, MCP URL normalization and mismatch cases, locked
  field reporting, and write-only omission from the projection.
- `tests/integration/canonical-credential-wire.test.ts` — each canonical type
  created through the published endpoint and read back through it: the nested
  round trip with its resolved `injection_location`, the `static_bearer` name on
  the wire, the `refresh` warning, the mixed-shape refusal, the legacy flat alias,
  the missing-field refusals, and that no response carries the secret.
- `tests/integration/credential-execution.test.ts` — the executor resolves the
  session's vault, the bash tool receives `{env: {TOKEN: …}}`, the string the
  strategy sees is redacted, and no persisted event carries the secret.
- `tests/unit/credential-policy.test.ts` — network policy normalization.
- `tests/unit/credential-redaction.test.ts` — secret material never appears in
  a response.
- `tests/integration/api.test.ts` — vault and credential CRUD, rotation,
  and canonical response shape.
- `tests/integration/mcp.test.ts` — a real stdio MCP server reports the value it
  was started with, proving the session's Vault environment credential reached the
  process and that the agent's own `env` value lost to it; the same case under a
  `limited` credential shows the refusal reaching the audit trail instead. A real
  SSE server reports the header it received, which is `Bearer` plus the credential
  keyed to its URL and `none` for a credential keyed elsewhere or for a caller that
  names no server. The transport half of the rotation expectation is asserted in
  this file too: a row that is rotated in place leaves the connected process holding
  the previous value until the session is asked to reconnect, after which the same
  tool wrapper reports the new one; `tests/integration/credential-rotation.test.ts`
  covers the route that asks for it.
- `tests/integration/credential-rotation.test.ts` — the rotation route notifies
  every active Session that references the rotated Vault.

## 7. Status

`supported` for the wire profile, write-only handling, locked fields, and
rotation. OAuth refresh is `unavailable` and is recorded as such in the capability
matrix rather than presented as supported.
