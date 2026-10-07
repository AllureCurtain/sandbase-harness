export const UNSUPPORTED_OFFICIAL_ROUTES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/v1\/tunnels(?:\/|$)/, reason: 'MCP tunnels require hosted connectivity outside the local-first scope.' },
  { pattern: /^\/v1\/user_profiles(?:\/|$)/, reason: 'Hosted user profile management is outside the single-tenant runtime scope.' },
  { pattern: /^\/v1\/environments\/[^/]+\/work(?:\/|$)/, reason: 'The hosted Work API is not the local worker queue API.' },
  { pattern: /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/mcp_oauth_validate$/, reason: 'MCP OAuth tokens refresh at the injection boundary; a dedicated validation endpoint is not implemented.' },
  { pattern: /^\/v1\/sessions\/[^/]+\/threads(?:\/|$)/, reason: 'Session threads belong to the multiagent surface this runtime does not implement.' },
];

/**
 * Official SDK routes whose mount is deferred to a tracked implementation PR.
 * Empty: every route in the pinned inventory is either served or a mounted
 * refusal — the structure stays so a future deferral has a declared home.
 */
export const PENDING_OFFICIAL_ROUTES: ReadonlyArray<{ route: string; reason: string; followUp: string }> = [];
