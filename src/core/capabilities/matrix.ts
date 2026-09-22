/**
 * CMA capability matrix.
 *
 * One entry per contract area, each recording whether SandBase implements the
 * published behaviour and why. The matrix exists because "we did not implement
 * this" and "we chose not to implement this" are different facts that a single
 * boolean cannot express, and because an unverified claim must be visibly
 * unverified rather than silently counted as done.
 *
 * Contract documents under `contracts/anthropic-cma/` are the prose companion:
 * a `supported` entry there has a matching `supported` entry here.
 */

/**
 * Capability status.
 *
 * - `supported` — implemented and covered by tests that exercise the behaviour.
 * - `partial` — implemented for a documented subset, or with a documented
 *   deviation. The entry's `reason` must name the deviation.
 * - `unavailable` — not implemented; a request relying on it fails before
 *   persisting state or executing anything.
 * - `planned` — not implemented and scheduled as future work.
 * - `not_applicable` — deliberately out of scope for a local-first runtime.
 * - `unverified` — implemented, but not confirmed against the published
 *   contract or a real service. Not a claim of correctness.
 */
export const CAPABILITY_STATUSES = [
  'supported',
  'partial',
  'unavailable',
  'planned',
  'not_applicable',
  'unverified',
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Contract areas, matching the file names under `contracts/anthropic-cma/`. */
export const CAPABILITY_AREAS = [
  'headers',
  'pagination',
  'errors',
  'agents',
  'sessions',
  'budget',
  'threads',
  'events',
  'streaming',
  'tools',
  'custom-tools',
  'system-message',
  'memory-stores',
  'files',
  'credentials',
  'github-repository',
  'operations',
  'capabilities',
  'unsupported',
] as const;

export type CapabilityArea = (typeof CAPABILITY_AREAS)[number];

export interface CapabilityEntry {
  /** Contract area this entry describes. */
  area: CapabilityArea;
  /** Precise identity of the capability within the area. */
  id: string;
  status: CapabilityStatus;
  /** Why this status, in one sentence. Required for every non-`supported` entry. */
  reason: string;
  /** Contract document that carries the seven-section detail. */
  contract: string;
}

/**
 * The matrix.
 *
 * Statuses are deliberately conservative. A capability is only `supported`
 * when a test exercises the published behaviour; anything inferred from local
 * behaviour alone is `unverified`.
 */
export const CMA_CAPABILITY_MATRIX: readonly CapabilityEntry[] = [
  {
    area: 'headers',
    id: 'compatibility-header-admission',
    status: 'partial',
    reason: 'Version, beta, and mutual-exclusion rules are enforced; a request with no compatibility header is accepted as a local caller, which the published contract does not define.',
    contract: 'contracts/anthropic-cma/headers.md',
  },
  {
    area: 'headers',
    id: 'extension-namespace-exclusion',
    status: 'supported',
    reason: '/v1/x/* never enters CMA admission, so local extensions cannot be gated by cloud beta headers.',
    contract: 'contracts/anthropic-cma/headers.md',
  },
  {
    area: 'pagination',
    id: 'opaque-cursors',
    status: 'partial',
    reason: '/v1 canonical collections all return {data, prev_page, next_page}; /v1/x extension collections still use the local has_more/first_id/last_id envelope, cursors are readable base64url JSON rather than opaque binary, and a windowed page is addressed by page number rather than by a stable sort key.',
    contract: 'contracts/anthropic-cma/pagination.md',
  },
  {
    area: 'pagination',
    id: 'cursor-query-binding',
    status: 'supported',
    reason: 'A cursor records the ordering and the normalized filter that produced it, and a replay under a different query is rejected with invalid_page_cursor instead of returning a page that never existed for that query.',
    contract: 'contracts/anthropic-cma/pagination.md',
  },
  {
    area: 'errors',
    id: 'structured-error-envelope',
    status: 'supported',
    reason: 'Every rejection returns {error:{type,message}} with a stable code where the caller needs to branch programmatically.',
    contract: 'contracts/anthropic-cma/errors.md',
  },
  {
    area: 'agents',
    id: 'agent-crud',
    status: 'supported',
    reason: 'Canonical agent definitions are created, listed, read, and version-archived through /v1/agents.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'agents',
    id: 'model-object-profile',
    status: 'partial',
    reason: 'String and object model forms parse, but effort, inference_geo, and the canonical multiagent roster are handled as structured unavailable results rather than executed.',
    contract: 'contracts/anthropic-cma/agents.md',
  },
  {
    area: 'sessions',
    id: 'session-lifecycle',
    status: 'supported',
    reason: 'Sessions are created, resumed, interrupted, and terminated with the canonical status transitions.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'sessions',
    id: 'initial-events',
    status: 'supported',
    reason: 'initial_events are validated against the documented whitelist and the 50-event ceiling, and creation plus resource attachment plus event delivery is wrapped in one local transaction so a rejected event cannot leave a half-created session.',
    contract: 'contracts/anthropic-cma/sessions.md',
  },
  {
    area: 'budget',
    id: 'session-budget',
    status: 'partial',
    reason: 'Consumption is priced in integer microcents from the append-only log, and a session may declare a max_list_cost ceiling at creation. At the ceiling the next work-starting event is refused with budget_reached while events that settle work already in flight are still accepted, so the next model request does not start. Two deviations are deliberate: prices come from an operator-supplied cost profile rather than official list prices, so a session whose model the profile cannot price is refused a budget and usage.list_cost is withheld while any used model is unpriced; and reaching the ceiling refuses the event instead of transitioning the session to a paused state, because the published thread-level budget_reached signal belongs to the thread surface, which this runtime does not implement.',
    contract: 'contracts/anthropic-cma/budget.md',
  },
  {
    area: 'events',
    id: 'append-only-event-log',
    status: 'supported',
    reason: 'The event log is append-only and every event carries a monotonic sequence number.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'processed-at-lifecycle',
    status: 'supported',
    reason: 'Inbound events record processed_at once admitted, so a client can tell queued from handled.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'session-error-structure',
    status: 'supported',
    reason: 'Every failure path through a turn appends session.error carrying {error:{type,message,retry_status}}, with the retry disposition derived from the error code rather than guessed.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'events',
    id: 'error-enum-completeness',
    status: 'unverified',
    reason: 'The published error enumeration is not exhaustively documented; local codes are not claimed to match upstream values.',
    contract: 'contracts/anthropic-cma/events.md',
  },
  {
    area: 'streaming',
    id: 'resumable-sse',
    status: 'supported',
    reason: 'SSE replay resumes from the last delivered sequence without gaps or duplicates.',
    contract: 'contracts/anthropic-cma/streaming.md',
  },
  {
    area: 'streaming',
    id: 'agent-message-stream-preview',
    status: 'supported',
    reason: 'event_start and event_delta previews are opt-in, not persisted, and absent from the default buffered stream.',
    contract: 'contracts/anthropic-cma/streaming.md',
  },
  {
    area: 'tools',
    id: 'builtin-tool-execution',
    status: 'partial',
    reason: 'File, shell, search, and web_fetch tools execute; web_search accepts configuration but has no search provider and fails admission before execution.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'web-fetch-execution',
    status: 'partial',
    reason: 'WebFetch executes over HTTP/HTTPS with domain policy, per-redirect revalidation, private-address rejection, timeout and byte caps, HTML text extraction, and a max_content_tokens budget; it converts text-like content only (no image or PDF rendering), the token budget is a character estimate, and TLS hostnames are verified but content is not sandboxed beyond redaction.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'web-tool-domain-policy',
    status: 'supported',
    reason: 'The domain grammar, one-of allowed/blocked exclusivity, and the empty-list rejection match the published rules.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'tool-output-overflow',
    status: 'partial',
    reason: 'Overflow has one unified contract (spill path, preview, marker, retrieval), but the local threshold is 50,000 chars rather than the published 100,000.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'tools',
    id: 'mcp-tool-approval-gate',
    status: 'supported',
    reason: 'An mcp_toolset defaults to always_ask and an agent_toolset to always_allow; a tool discovered at connect time is admitted only if the toolset is enabled and not denied, and a discovered tool that inherits always_ask reaches the user for confirmation because the gate is derived from the resolved tool map, not from the declared configs alone.',
    contract: 'contracts/anthropic-cma/tools.md',
  },
  {
    area: 'custom-tools',
    id: 'custom-tool-declaration',
    status: 'supported',
    reason: 'Custom tool declarations parse to the canonical wire shape and are reflected back in the agent definition.',
    contract: 'contracts/anthropic-cma/custom-tools.md',
  },
  {
    area: 'system-message',
    id: 'system-message-events',
    status: 'supported',
    reason: 'system.message is accepted and persisted as its own event domain.',
    contract: 'contracts/anthropic-cma/system-message.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-crud',
    status: 'supported',
    reason: 'Memory stores and memories support create, read, update, delete, and list with path and depth scoping.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-limits-and-preconditions',
    status: 'supported',
    reason: 'Size, per-store, per-session, and instruction limits are enforced, and content_sha256 preconditions gate writes.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-version-audit',
    status: 'supported',
    reason: 'Each write records a memory version that can be listed and read afterwards.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'memory-stores',
    id: 'memory-multi-mount',
    status: 'supported',
    reason: 'A session attaches up to 8 stores, each with its own mount path, instructions, and access; one binding resolution feeds the ContextBuilder, the memory API, and the sandbox file tools, and read_only is enforced at the tool layer rather than only declared.',
    contract: 'contracts/anthropic-cma/memory-stores.md',
  },
  {
    area: 'github-repository',
    id: 'github-repository-materialization',
    status: 'supported',
    reason: 'A github_repository resource is cloned, checked out at the requested ref, mounted into the sandbox, and its .claude/skills are registered for the session, with staging cleaned up on every failure path and the token kept out of argv, events, and logs.',
    contract: 'contracts/anthropic-cma/github-repository.md',
  },
  {
    area: 'github-repository',
    id: 'github-repository-identity-freeze',
    status: 'supported',
    reason: 'Changing the repository URL, checkout, or mount path of a running session is refused: the registered skills and any files already read cannot be retroactively corrected, so a new session is required.',
    contract: 'contracts/anthropic-cma/github-repository.md',
  },
  {
    area: 'files',
    id: 'file-resources',
    status: 'supported',
    reason: 'Files are uploaded, listed, read, and mounted at a canonical sandbox path.',
    contract: 'contracts/anthropic-cma/files.md',
  },
  {
    area: 'files',
    id: 'file-mount-path',
    status: 'supported',
    reason: 'The canonical mount path form is produced and validated for every file resource.',
    contract: 'contracts/anthropic-cma/files.md',
  },
  {
    area: 'credentials',
    id: 'canonical-credential-wire-profile',
    status: 'supported',
    reason: 'The nested auth profile, write-only secret fields, and locked structural fields are enforced on write and projected on read.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'credential-rotation',
    status: 'supported',
    reason: 'Rotating a secret replaces only the ciphertext and leaves the credential identity unchanged.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'credential-injection-execution',
    status: 'partial',
    reason: 'A turn on a session that attaches a vault injects its unrestricted environment variables into the sandbox command environment and into any stdio MCP server the agent declares (a vault value wins over the value the agent configured), hands a url-transport server the credentials scoped to its own `mcp_server_url` (a `static_bearer` or `mcp_oauth` credential is attached only to the endpoint it names, on the SSE request and on every message POST), redacts every value a sandbox tool hands back and every value an MCP tool returns, and clears the retained values when the turn ends. The runtime composition supplies the resolver, so a CLI-started runtime resolves the session vault while an embedder that omits it runs sessions with no vault. Two deviations: the delegated child path builds its own sandbox tools and does not thread credentials, so a sub-agent receives no vault environment; and nothing is injected into model requests, so a credential authenticates an outbound call rather than a completion.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'credentials',
    id: 'oauth-refresh',
    status: 'unavailable',
    reason: 'No refresh loop, refresh-failure event, or validate endpoint exists, and none is scheduled. A supplied refresh block is parsed, stored, and answered with an explicit warning that it will not be executed, so a caller never assumes a token was renewed.',
    contract: 'contracts/anthropic-cma/credentials.md',
  },
  {
    area: 'operations',
    id: 'webhook-subscriptions',
    status: 'partial',
    reason: 'Locally implemented, but the delivery behaviour is not the published contract. Subscriptions are managed over REST under /v1/webhooks (with the /v1/x mirror) and delivery runs from a bridge the runtime composes at startup: each durable event is projected as it is broadcast and a 60-second tick retries due deliveries and runs due deployments, while POST /v1/webhooks/dispatch and POST /v1/webhooks/retry-due remain for on-demand passes. Every attempt carries the published header names and a Standard Webhooks v1 signature over id.timestamp.body — a retry keeps the delivery id and signs with its own timestamp, and each subscription holds its own whsec_ secret that is returned once at creation, and a rotation window keeps the previous secret valid in a second webhook-signature entry until it is retired — but the payload is the local {type: "webhook_event", event, webhook_id, data, created_at} envelope rather than the published reference envelope, nothing retires the previous secret automatically, no auto-disable or disabled_reason exists (a non-2xx is retried, never a disable), the private-address rule is absent, and the backoff is a fixed 60s/120s rather than jittered.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'scheduled-deployment-timers',
    status: 'partial',
    reason: 'A stored resource with a cron cadence evaluated in the deployment\'s own IANA timezone, a run record per attempt, and session creation through the canonical SessionManager path. It is not the published deployment contract: there is no /v1/deployments alias, no trigger_context, no pause/unpause routes, no deployment.* lifecycle events, and no failure split — every session-creation error records a failed run and advances the cadence, with no own-agent preflight, auto-pause or auto-archive. Re-arming after downtime follows from the persisted next_run_at rather than a timer: POST /v1/scheduled-deployments/run-due must be driven by a caller.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'operations',
    id: 'outcome-evaluation',
    status: 'supported',
    reason: 'Declared outcomes evaluate deterministically against the event log rather than by model judgement, so a pass/fail is reproducible. A local extension: the published contract defines no deterministic evaluator.',
    contract: 'contracts/anthropic-cma/operations.md',
  },
  {
    area: 'capabilities',
    id: 'capability-inventory-endpoint',
    status: 'supported',
    reason: '/v1/x/capabilities returns the runtime capability inventory for Console and client consumption.',
    contract: 'contracts/anthropic-cma/capabilities.md',
  },
  {
    area: 'capabilities',
    id: 'capability-status-truthfulness',
    status: 'supported',
    reason: 'The six-value status enum distinguishes unimplemented from deliberately out-of-scope and from unverified.',
    contract: 'contracts/anthropic-cma/capabilities.md',
  },
  {
    area: 'unsupported',
    id: 'dreams',
    status: 'not_applicable',
    reason: 'Dreams are a cloud scheduling feature with no local-first analogue; not scheduled.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'threads',
    id: 'threads-and-coordinator',
    status: 'partial',
    reason: 'Thread identity, lifecycle and message-direction events, cross-posting to the primary stream, the 25-thread limit with advisor exemption, roster validation and snapshotting, archive rules, per-thread event isolation and both documented endpoints are implemented. Delegation is still routed by the agent delegations list rather than by roster membership, no advisor consultation tool exists, and a session_thread_id on an interrupting event is not routed to a named thread.',
    contract: 'contracts/anthropic-cma/threads.md',
  },
  {
    area: 'unsupported',
    id: 'session-budget-alerts',
    status: 'not_applicable',
    reason: 'Budget notification is a hosted billing feature: it needs an outbound channel to a party who pays for the account, and SandBase is single-tenant and local, so the operator is already the only party to notify.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'unsupported',
    id: 'mcp-tunnel',
    status: 'not_applicable',
    reason: 'MCP tunnel is a hosted connectivity feature outside the local-first scope.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
  {
    area: 'unsupported',
    id: 'web-search-execution',
    status: 'unavailable',
    reason: 'No search provider is bundled or configured, and search-engine HTML scraping is not an accepted substitute; enabling web_search fails admission before a session is persisted. WebFetch execution is a separate, implemented capability.',
    contract: 'contracts/anthropic-cma/unsupported.md',
  },
];

/**
 * Look up one entry.
 *
 * Throws on an unknown id so a typo cannot silently find nothing, and returns a
 * copy so a consumer cannot mutate the shared matrix by holding an entry.
 */
export function capabilityEntry(id: string): CapabilityEntry {
  const entry = CMA_CAPABILITY_MATRIX.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown capability: ${id}`);
  return { ...entry };
}

/** Entries with a given status. Returns copies, for the same reason. */
export function capabilitiesWithStatus(status: CapabilityStatus): CapabilityEntry[] {
  return CMA_CAPABILITY_MATRIX.filter((entry) => entry.status === status).map((entry) => ({ ...entry }));
}

/** Grouped counts, useful for a coverage summary in the Console or a report. */
export function capabilitySummary(): Record<CapabilityStatus, number> {
  const summary = Object.fromEntries(CAPABILITY_STATUSES.map((status) => [status, 0])) as Record<CapabilityStatus, number>;
  for (const entry of CMA_CAPABILITY_MATRIX) summary[entry.status] += 1;
  return summary;
}

/**
 * Machine-readable projection.
 *
 * This is what `/v1/x/capabilities` serves and what a Console renders, so the
 * registry and any published JSON cannot drift apart.
 */
export function capabilityMatrixJson(): {
  type: 'capability_matrix';
  statuses: readonly CapabilityStatus[];
  summary: Record<CapabilityStatus, number>;
  capabilities: CapabilityEntry[];
} {
  return {
    type: 'capability_matrix',
    statuses: CAPABILITY_STATUSES,
    summary: capabilitySummary(),
    capabilities: CMA_CAPABILITY_MATRIX.map((entry) => ({ ...entry })),
  };
}
