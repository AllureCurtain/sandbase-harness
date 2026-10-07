/**
 * MCP OAuth refresh, executed at the injection boundary.
 *
 * The published credential contract carries `auth.expires_at` and an
 * `auth.refresh` block (`token_endpoint`, `client_id`, `token_endpoint_auth`)
 * plus the write-only `refresh_token`. This module is the only place those
 * fields are executed: when a url-transport MCP connection resolves its
 * headers, the manager calls in here first, and a credential whose access
 * token has expired is refreshed against its token endpoint before the
 * injection bundle is built.
 *
 * Boundary rules:
 * - Refresh is runtime-side. The refresh token and client secret are decrypted
 *   inside this process, used once for the token request, and never reach an
 *   agent, a subprocess environment, or a tool result. The refreshed access
 *   token is re-encrypted in the same columns rotation writes, so the bundle
 *   resolution that follows reads it through the normal decrypt path — nothing
 *   downstream learns that a refresh happened.
 * - Only `mcp_oauth` credentials keyed by `mcp_server_url` refresh, and only
 *   for the declared server they match; a session never refreshes a credential
 *   it could not inject.
 * - A failed refresh does not hide itself: the outcome is stamped on
 *   `oauth_state`, a `refresh_failed` audit row is appended, and
 *   `vault_credential.refresh_failed` is published. The stored token is left
 *   untouched so the connect still proceeds with the last known value — the
 *   transport's own auth failure is the honest downstream signal, and a retry
 *   is deduplicated by `last_refresh_at` instead of hammering the endpoint on
 *   every connect.
 */

import type { Database } from '@/core/db/database.js';
import { decryptSecret, encryptSecret } from '@/core/security/secrets.js';
import { appendCredentialAuditEvent } from './audit.js';
import { parseSessionVaultIds } from './injection.js';
import {
  mcpServerUrlMatches,
  parseOAuthState,
  serializeOAuthState,
  type OAuthStateRecord,
} from './canonical-credential.js';

/**
 * A token is refreshed this long before its stated expiry: a connect that
 * starts inside the window would otherwise hand the transport a token that
 * dies mid-handshake.
 */
export const OAUTH_REFRESH_SKEW_MS = 30_000;

/**
 * A failed (or just-completed) refresh suppresses another attempt for this
 * long. The guard lives on the row — `last_refresh_at` — rather than in
 * process memory, so a second session resolving the same vault cannot start a
 * parallel refresh, and a restart does not reset the backoff.
 */
export const OAUTH_REFRESH_RETRY_WINDOW_MS = 60_000;

/** What the refresher reports per credential it examined. */
export type OAuthRefreshOutcome =
  | 'refreshed'
  | 'not_due'
  | 'not_refreshable'
  | 'failed';

export interface McpOAuthRefreshOptions {
  /**
   * Session whose vaults scope the refresh. A delegated sub-agent passes its
   * parent's vault ids through `vaultIds` because its own row was never
   * persisted; a real session leaves it unset and the row supplies them.
   */
  sessionId: string;
  /** Declared MCP server URL the connection is being built for. */
  mcpServerUrl: string;
  /**
   * Vault ids overriding the session row's. `undefined` reads the session row;
   * an explicit list — including an empty one — is authoritative, so a child
   * cannot widen its scope by leaving the field unset.
   */
  vaultIds?: string[];
  /** Workspace data directory for secret decryption/encryption. */
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Webhook publisher for `vault_credential.refresh_failed`. Absent means the
   * failure is still audited and stamped on the row, just not delivered — an
   * embedder without a webhook surface passes nothing.
   */
  publish?: (event: { type: string; subjectId: string; extra?: Record<string, unknown> }) => Promise<void> | void;
}

export type CredentialRow = {
  id: string;
  vault_id: string;
  auth_type: string;
  mcp_server_url: string | null;
  oauth_state: string;
  secret_ciphertext: string;
  secret_nonce: string;
  secret_tag: string;
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  refresh_token_tag: string;
  client_secret_ciphertext: string;
  client_secret_nonce: string;
  client_secret_tag: string;
};

type TokenEndpointResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
};

/**
 * The HTTP detail a validation report may publish about a failed exchange or
 * probe — the published `http_response` shape. The body is truncated and
 * scrubbed of every secret the request carried before it is recorded.
 */
export interface CapturedHttpResponse {
  status_code: number;
  content_type: string;
  body: string;
  body_truncated: boolean;
}

/**
 * The published `refresh` object a `vault_credential_validation` reports:
 * the outcome of the exchange a 401 probe triggered.
 */
export interface ValidationRefreshOutcome {
  status: 'succeeded' | 'failed' | 'connect_error' | 'no_refresh_token';
  httpResponse: CapturedHttpResponse | null;
}

/**
 * In-flight refreshes keyed by credential id. Two sessions sharing a vault can
 * connect to the same MCP server at once, and a provider that rotates refresh
 * tokens would invalidate the first answer's token if both ran — so the second
 * caller joins the running refresh instead of starting its own. The row's
 * `last_refresh_at` dedup covers attempts *after* one has finished; this map
 * covers attempts *while* one is running.
 */
const inflightRefreshes = new Map<string, Promise<OAuthRefreshOutcome>>();

/**
 * Refresh every `mcp_oauth` credential in `vaultIds` that applies to
 * `mcpServerUrl` and whose access token is due.
 *
 * Called once per MCP connect — the credential is due only after its
 * `expires_at` (minus skew), and the retry window deduplicates the failure
 * path, so the common case resolves to a single row read.
 */
export async function refreshMcpOauthCredentialsForServer(
  db: Database,
  opts: McpOAuthRefreshOptions,
): Promise<void> {
  if (!opts.mcpServerUrl) return;
  const vaultIds = opts.vaultIds ?? (() => {
    const session = db.prepare('SELECT vault_ids FROM sessions WHERE id = ?').get(opts.sessionId) as { vault_ids: string } | undefined;
    return parseSessionVaultIds(session?.vault_ids ?? '[]');
  })();
  if (vaultIds.length === 0) return;
  const now = opts.now ?? (() => new Date());
  const rows = db.prepare(
    `SELECT *
     FROM credential_records
     WHERE vault_id IN (${vaultIds.map(() => '?').join(',')})
       AND auth_type = 'mcp_oauth'
       AND archived_at IS NULL
       AND status != 'deleted'`,
  ).all(...vaultIds) as unknown as CredentialRow[];

  for (const row of rows) {
    if (!row.mcp_server_url || !mcpServerUrlMatches(row.mcp_server_url, opts.mcpServerUrl)) continue;
    const running = inflightRefreshes.get(row.id);
    if (running) {
      await running.catch(() => {});
      continue;
    }
    const attempt = refreshOneCredential(db, row, opts, now);
    inflightRefreshes.set(row.id, attempt);
    try {
      await attempt;
    } finally {
      if (inflightRefreshes.get(row.id) === attempt) inflightRefreshes.delete(row.id);
    }
  }
}

async function refreshOneCredential(
  db: Database,
  row: CredentialRow,
  opts: McpOAuthRefreshOptions,
  now: () => Date,
): Promise<OAuthRefreshOutcome> {
  const state = parseOAuthState(row.oauth_state);
  if (!state.tokenEndpoint || !state.hasRefreshToken) return 'not_refreshable';

  const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : Number.NaN;
  // No recorded expiry means the runtime cannot know the token is due; the
  // stored value is used until it is replaced, matching the pre-refresh
  // contract for a credential that never declared one.
  if (Number.isNaN(expiresAt)) return 'not_refreshable';
  if (expiresAt - OAUTH_REFRESH_SKEW_MS > now().getTime()) return 'not_due';

  // The retry window suppresses both a parallel second refresh and a
  // reconnect-storm of retries after a failure. `last_refresh_at` is stamped
  // on every attempt, so the guard needs no separate column.
  if (state.lastRefreshAt) {
    const lastAttempt = Date.parse(state.lastRefreshAt);
    if (!Number.isNaN(lastAttempt) && now().getTime() - lastAttempt < OAUTH_REFRESH_RETRY_WINDOW_MS) {
      return state.lastRefreshStatus === 'ok' ? 'not_due' : 'failed';
    }
  }

  const refreshToken = decryptColumn(row, 'refresh_token', opts.dataDir);
  const clientSecret = decryptColumn(row, 'client_secret', opts.dataDir);
  if (!refreshToken) {
    // The bag claims a token that is not decryptable — the same "cannot
    // execute" honesty as a missing one, surfaced as a refresh failure rather
    // than silently skipping, because the credential declared itself covered.
    return recordRefreshFailure(db, row, state, opts, now, 'stored refresh token could not be decrypted');
  }

  try {
    const response = await requestAccessToken(row, state, refreshToken, clientSecret, opts);
    const outcome = 'refreshed' as const;
    commitRefreshSuccess(db, row, state, response, now, opts.dataDir);
    appendCredentialAuditEvent(db, {
      vaultId: row.vault_id,
      credentialId: row.id,
      action: 'refresh',
      actor: 'runtime',
      metadata: { reason: 'access_token_expired' },
    });
    return outcome;
  } catch (err) {
    return recordRefreshFailure(db, row, state, opts, now, sanitizeRefreshError(err));
  }
}

/**
 * POST the refresh grant. Client authentication follows the stored
 * `token_endpoint_auth_type`: `client_secret_post` puts the secret in the
 * body, `none` sends no secret, and anything else — including the published
 * default — is `client_secret_basic` on the Authorization header. The secret
 * only ever travels inside this request; it is never reflected in errors.
 */
async function requestAccessToken(
  row: CredentialRow,
  state: OAuthStateRecord,
  refreshToken: string,
  clientSecret: string,
  opts: McpOAuthRefreshOptions,
): Promise<TokenEndpointResponse> {
  const exchange = await exchangeRefreshGrant(state, refreshToken, clientSecret, opts.fetchImpl);
  if (!exchange.response.ok) {
    // Status and endpoint only: a token endpoint's error body can echo request
    // material back, so nothing from it is carried into the failure record.
    throw new Error(`token endpoint responded ${exchange.response.status}`);
  }
  const payload = parseJson(exchange.bodyText) as TokenEndpointResponse | undefined;
  const accessToken = typeof payload?.access_token === 'string' && payload.access_token ? payload.access_token : undefined;
  if (!accessToken) throw new Error('token endpoint response carried no access_token');
  return payload!;
}

/**
 * The wire half of the refresh grant, shared by the injection-boundary
 * refresher and the validation endpoint: one POST, one captured body. The
 * response body is returned as text so a caller that reports the exchange can
 * publish it (scrubbed) instead of losing the detail a JSON parse would keep.
 */
async function exchangeRefreshGrant(
  state: OAuthStateRecord,
  refreshToken: string,
  clientSecret: string,
  fetchImpl?: typeof fetch,
): Promise<{ response: Response; bodyText: string }> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  if (state.clientId) body.set('client_id', state.clientId);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const authType = state.tokenEndpointAuthType ?? 'client_secret_basic';
  if (clientSecret) {
    if (authType === 'client_secret_post') {
      body.set('client_secret', clientSecret);
    } else if (authType !== 'none') {
      const credentials = `${state.clientId ?? ''}:${clientSecret}`;
      headers.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    }
  }

  const response = await (fetchImpl ?? fetch)(state.tokenEndpoint!, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  return { response, bodyText: await response.text() };
}

/**
 * The refresh half of `mcp_oauth_validate`: run the exchange a 401 probe calls
 * for and report it in the published `refresh` shape.
 *
 * The bookkeeping is identical to the injection-boundary refresher — a success
 * persists the new access token (and a rotated refresh token) through
 * `commitRefreshSuccess`, a failure stamps `oauth_state`, appends a
 * `refresh_failed` audit row, and publishes `vault_credential.refresh_failed`.
 * The deduplicating retry window is deliberately not consulted: this refresh
 * is operator-initiated diagnosis, not a connect storm, and suppressing it
 * would report a refresh that never ran. An in-flight boundary refresh is
 * still joined first: two grants against a provider that rotates refresh
 * tokens would invalidate each other's answer.
 */
export async function refreshMcpOauthCredentialForValidation(
  db: Database,
  row: CredentialRow,
  opts: Pick<McpOAuthRefreshOptions, 'dataDir' | 'fetchImpl' | 'now' | 'publish'> & {
    /** Secrets the captured error body must never echo back. */
    scrubSecrets?: string[];
  },
): Promise<ValidationRefreshOutcome> {
  const now = opts.now ?? (() => new Date());
  const running = inflightRefreshes.get(row.id);
  if (running) {
    // The boundary refresh owns the commit path; if it lands, the validation
    // verdict only needs to know a fresh token now exists.
    if ((await running.catch(() => 'failed' as const)) === 'refreshed') {
      return { status: 'succeeded', httpResponse: null };
    }
  }
  const state = parseOAuthState(row.oauth_state);
  if (!state.tokenEndpoint || !state.hasRefreshToken) {
    return { status: 'no_refresh_token', httpResponse: null };
  }
  const refreshToken = decryptColumn(row, 'refresh_token', opts.dataDir);
  const clientSecret = decryptColumn(row, 'client_secret', opts.dataDir);
  const scrub = [refreshToken, clientSecret, ...(opts.scrubSecrets ?? [])].filter(Boolean);
  if (!refreshToken) {
    await recordRefreshFailure(db, row, state, opts, now, 'stored refresh token could not be decrypted');
    return { status: 'failed', httpResponse: null };
  }

  try {
    const exchange = await exchangeRefreshGrant(state, refreshToken, clientSecret, opts.fetchImpl);
    const httpResponse = captureHttpResponse(exchange.response, exchange.bodyText, scrub);
    if (!exchange.response.ok) {
      await recordRefreshFailure(db, row, state, opts, now, `token endpoint responded ${exchange.response.status}`);
      return { status: 'failed', httpResponse };
    }
    const payload = parseJson(exchange.bodyText) as TokenEndpointResponse | undefined;
    const accessToken = typeof payload?.access_token === 'string' && payload.access_token ? payload.access_token : undefined;
    if (!accessToken) {
      await recordRefreshFailure(db, row, state, opts, now, 'token endpoint response carried no access_token');
      return { status: 'failed', httpResponse };
    }
    commitRefreshSuccess(db, row, state, payload!, now, opts.dataDir);
    appendCredentialAuditEvent(db, {
      vaultId: row.vault_id,
      credentialId: row.id,
      action: 'refresh',
      actor: 'runtime',
      metadata: { reason: 'mcp_oauth_validate' },
    });
    return { status: 'succeeded', httpResponse: null };
  } catch (err) {
    await recordRefreshFailure(db, row, state, opts, now, sanitizeRefreshError(err));
    return { status: 'connect_error', httpResponse: null };
  }
}

/** The published `http_response` shape, with secrets scrubbed before truncation. */
export function captureHttpResponse(
  response: Pick<Response, 'status' | 'headers'>,
  bodyText: string,
  scrubSecrets: string[] = [],
): CapturedHttpResponse {
  let body = bodyText;
  for (const secret of scrubSecrets) {
    if (secret) body = body.split(secret).join('••••');
  }
  const truncated = body.length > 4_000;
  return {
    status_code: response.status,
    content_type: response.headers.get('content-type') ?? '',
    body: truncated ? body.slice(0, 4_000) : body,
    body_truncated: truncated,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Persist a successful refresh: the new access token replaces the stored
 * secret, a rotated refresh token replaces its own encrypted columns, and the
 * `oauth_state` bag records the new expiry and clears the failure fields. A
 * response that omits `refresh_token` keeps the stored one — rotation is the
 * provider's choice, not a requirement.
 */
function commitRefreshSuccess(
  db: Database,
  row: CredentialRow,
  state: OAuthStateRecord,
  response: TokenEndpointResponse,
  now: () => Date,
  dataDir?: string,
): void {
  const refreshedAt = now().toISOString();
  const accessToken = response.access_token as string;
  const encryptedAccess = encryptSecret(accessToken, dataDir);
  let expiresAt: string | undefined;
  if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) {
    expiresAt = new Date(now().getTime() + response.expires_in * 1000).toISOString();
  } else if (typeof response.expires_at === 'string' && !Number.isNaN(Date.parse(response.expires_at))) {
    expiresAt = new Date(Date.parse(response.expires_at)).toISOString();
  }

  const rotated = typeof response.refresh_token === 'string' && response.refresh_token ? response.refresh_token : undefined;
  const encryptedRefresh = rotated ? encryptSecret(rotated, dataDir) : undefined;
  const nextState: OAuthStateRecord = {
    ...state,
    ...(expiresAt ? { expiresAt } : {}),
    hasRefreshToken: true,
    lastRefreshAt: refreshedAt,
    lastRefreshStatus: 'ok',
    lastRefreshError: undefined,
  };

  db.prepare(
    `UPDATE credential_records
     SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?, value_hint = ?,
         refresh_token_ciphertext = ?, refresh_token_nonce = ?, refresh_token_tag = ?,
         oauth_state = ?, updated_at = datetime('now')
     WHERE id = ? AND vault_id = ?`,
  ).run(
    encryptedAccess.ciphertext,
    encryptedAccess.nonce,
    encryptedAccess.tag,
    `••••${accessToken.slice(-4)}`,
    encryptedRefresh?.ciphertext ?? row.refresh_token_ciphertext,
    encryptedRefresh?.nonce ?? row.refresh_token_nonce,
    encryptedRefresh?.tag ?? row.refresh_token_tag,
    serializeOAuthState(nextState),
    row.id,
    row.vault_id,
  );
}

async function recordRefreshFailure(
  db: Database,
  row: CredentialRow,
  state: OAuthStateRecord,
  opts: Pick<McpOAuthRefreshOptions, 'publish'>,
  now: () => Date,
  error: string,
): Promise<OAuthRefreshOutcome> {
  const nextState: OAuthStateRecord = {
    ...state,
    lastRefreshAt: now().toISOString(),
    lastRefreshStatus: 'failed',
    lastRefreshError: error,
  };
  db.prepare(
    `UPDATE credential_records SET oauth_state = ?, updated_at = datetime('now') WHERE id = ? AND vault_id = ?`,
  ).run(serializeOAuthState(nextState), row.id, row.vault_id);
  appendCredentialAuditEvent(db, {
    vaultId: row.vault_id,
    credentialId: row.id,
    action: 'refresh_failed',
    actor: 'runtime',
    metadata: { reason: 'access_token_expired', error },
  });
  // The publish is awaited so the event is dispatched before the connect
  // proceeds, but a delivery failure never fails the refresh path: webhook
  // dispatch keeps its own retry and failure bookkeeping.
  try {
    await opts.publish?.({
      type: 'vault_credential.refresh_failed',
      subjectId: row.id,
      extra: { vault_id: row.vault_id, error },
    });
  } catch {
    // delivery errors are recorded inside the dispatcher
  }
  return 'failed';
}

/** The error text a failure is allowed to carry: a message, never the payload. */
function sanitizeRefreshError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // A token endpoint's response text is never embedded, so the residual risk is
  // a network error string quoting the URL — trimming keeps the record bounded.
  return message.slice(0, 200);
}

function decryptColumn(row: CredentialRow, kind: 'refresh_token' | 'client_secret', dataDir?: string): string {
  const ciphertext = row[`${kind}_ciphertext`];
  const nonce = row[`${kind}_nonce`];
  const tag = row[`${kind}_tag`];
  if (!ciphertext || !nonce || !tag) return '';
  try {
    return decryptSecret({ ciphertext, nonce, tag }, dataDir);
  } catch {
    return '';
  }
}
