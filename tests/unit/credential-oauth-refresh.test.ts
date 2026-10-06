/**
 * MCP OAuth refresh at the injection boundary.
 *
 * `refreshMcpOauthCredentialsForServer` is what a url-transport connect calls
 * before its headers are resolved: a credential whose `expires_at` is due is
 * POSTed to its token endpoint, the answer is re-encrypted in place, and a
 * failure is stamped on the row, audited, and published — while the stored
 * token stays untouched so the connect proceeds with the last known value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { decryptSecret, encryptSecret } from '@/core/security/secrets.js';
import {
  refreshMcpOauthCredentialsForServer,
  OAUTH_REFRESH_SKEW_MS,
  OAUTH_REFRESH_RETRY_WINDOW_MS,
} from '@/core/credentials/oauth-refresh.js';
import { parseOAuthState } from '@/core/credentials/canonical-credential.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';

const SERVER_URL = 'https://mcp.vendor.example/mcp';
const TOKEN_ENDPOINT = 'https://auth.vendor.example/token';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function seedOAuthCredential(
  db: Database,
  dataDir: string,
  opts: {
    id?: string;
    vaultId?: string;
    mcpServerUrl?: string;
    accessToken?: string;
    refreshToken?: string | null;
    clientSecret?: string | null;
    state?: Record<string, unknown>;
  } = {},
): string {
  const id = opts.id ?? 'vcrd_oauth';
  const access = encryptSecret(opts.accessToken ?? 'old-access-token', dataDir);
  const refresh = opts.refreshToken != null
    ? encryptSecret(opts.refreshToken, dataDir)
    : { ciphertext: '', nonce: '', tag: '' };
  const client = opts.clientSecret != null
    ? encryptSecret(opts.clientSecret, dataDir)
    : { ciphertext: '', nonce: '', tag: '' };
  db.prepare(
    `INSERT INTO credential_records (
      id, vault_id, name, auth_type, mcp_server_url, value_hint, network,
      injection_locations, secret_ciphertext, secret_nonce, secret_tag,
      oauth_state, refresh_token_ciphertext, refresh_token_nonce, refresh_token_tag,
      client_secret_ciphertext, client_secret_nonce, client_secret_tag,
      status, metadata, created_at, updated_at
    ) VALUES (?, ?, 'oauth', 'mcp_oauth', ?, '••••oken', '{"type":"unrestricted","allowed_hosts":[]}', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(
    id,
    opts.vaultId ?? 'vlt_a',
    opts.mcpServerUrl ?? SERVER_URL,
    access.ciphertext, access.nonce, access.tag,
    JSON.stringify(opts.state ?? {
      token_endpoint: TOKEN_ENDPOINT,
      expires_at: PAST,
      has_refresh_token: opts.refreshToken != null,
    }),
    refresh.ciphertext, refresh.nonce, refresh.tag,
    client.ciphertext, client.nonce, client.tag,
    new Date().toISOString(), new Date().toISOString(),
  );
  return id;
}

function storedSecret(db: Database, id: string, dataDir: string): string {
  const row = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as any;
  return decryptSecret({ ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_tag }, dataDir);
}

function storedRefreshToken(db: Database, id: string, dataDir: string): string {
  const row = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as any;
  if (!row.refresh_token_ciphertext) return '';
  return decryptSecret({ ciphertext: row.refresh_token_ciphertext, nonce: row.refresh_token_nonce, tag: row.refresh_token_tag }, dataDir);
}

function storedState(db: Database, id: string) {
  const row = db.prepare('SELECT oauth_state FROM credential_records WHERE id = ?').get(id) as any;
  return parseOAuthState(row.oauth_state);
}

function auditActions(db: Database, id: string): string[] {
  return (db.prepare('SELECT action FROM credential_audit_events WHERE credential_id = ?').all(id) as Array<{ action: string }>).map((r) => r.action);
}

/** A fetch stub recording calls and answering a canned token response. */
function stubFetch(response: { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('mcp_oauth refresh at the injection boundary', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  function setup(): Database {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-oauth-refresh-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_x', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('a', 'a', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_a', 'a')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_o', 'a', 'a', 'env_x', 'running', '["vlt_a"]')`);
    return db;
  }

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes a due token and persists the rotated secrets encrypted', async () => {
    const db = setup();
    const id = seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt-old', clientSecret: 'cs-1' });
    const { calls, fetchImpl } = stubFetch({
      body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 },
    });

    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(TOKEN_ENDPOINT);
    expect(call.init?.method).toBe('POST');
    const body = new URLSearchParams(String(call.init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
    // Default token_endpoint_auth is client_secret_basic on the header.
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(':cs-1', 'utf8').toString('base64')}`);
    expect(body.get('client_secret')).toBeNull();

    // The stored material changed in place; the plaintext is nowhere on the row.
    expect(storedSecret(db, id, tmpDir!)).toBe('at-new');
    expect(storedRefreshToken(db, id, tmpDir!)).toBe('rt-new');
    const row = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as any;
    expect(JSON.stringify(row)).not.toContain('at-new');
    expect(JSON.stringify(row)).not.toContain('rt-new');
    const state = storedState(db, id);
    expect(state.lastRefreshStatus).toBe('ok');
    expect(Date.parse(state.expiresAt!)).toBeGreaterThan(Date.now());
    expect(auditActions(db, id)).toContain('refresh');
  });

  it('resolves the fresh token through the normal injection path', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt-old' });
    const { fetchImpl } = stubFetch({ body: { access_token: 'at-fresh', expires_in: 600 } });

    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    const bundle = resolveSessionCredentialInjections(db, 'sess_o', {
      dataDir: tmpDir,
      mcpServerUrl: SERVER_URL,
    });
    expect(bundle.request_headers.Authorization).toBe('Bearer at-fresh');
  });

  it('does not call the endpoint when the token is not due', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, {
      refreshToken: 'rt',
      state: { token_endpoint: TOKEN_ENDPOINT, expires_at: FUTURE, has_refresh_token: true },
    });
    const { calls, fetchImpl } = stubFetch({});
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it('skips a credential with no recorded expiry or no refresh token', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, {
      id: 'vcrd_no_expiry',
      refreshToken: 'rt',
      state: { token_endpoint: TOKEN_ENDPOINT, has_refresh_token: true },
    });
    seedOAuthCredential(db, tmpDir!, {
      id: 'vcrd_no_token',
      refreshToken: null,
      state: { token_endpoint: TOKEN_ENDPOINT, expires_at: PAST, has_refresh_token: false },
    });
    const { calls, fetchImpl } = stubFetch({});
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it('refreshes inside the skew window before the nominal expiry', async () => {
    const db = setup();
    const almost = new Date(Date.now() + OAUTH_REFRESH_SKEW_MS - 1000).toISOString();
    seedOAuthCredential(db, tmpDir!, {
      refreshToken: 'rt',
      state: { token_endpoint: TOKEN_ENDPOINT, expires_at: almost, has_refresh_token: true },
    });
    const { calls, fetchImpl } = stubFetch({ body: { access_token: 'at', expires_in: 600 } });
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
  });

  it('keeps the stored refresh token when the response rotates none', async () => {
    const db = setup();
    const id = seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt-keep' });
    const { fetchImpl } = stubFetch({ body: { access_token: 'at-new', expires_in: 600 } });
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(storedRefreshToken(db, id, tmpDir!)).toBe('rt-keep');
    expect(storedSecret(db, id, tmpDir!)).toBe('at-new');
  });

  it.each([
    ['client_secret_post', (headers: Record<string, string>, body: URLSearchParams) => {
      expect(headers.authorization).toBeUndefined();
      expect(body.get('client_secret')).toBe('cs-1');
    }],
    ['none', (headers: Record<string, string>, body: URLSearchParams) => {
      expect(headers.authorization).toBeUndefined();
      expect(body.get('client_secret')).toBeNull();
    }],
  ])('honours token_endpoint_auth type %s', async (authType, assert) => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, {
      refreshToken: 'rt',
      clientSecret: 'cs-1',
      state: {
        token_endpoint: TOKEN_ENDPOINT,
        token_endpoint_auth_type: authType,
        client_id: 'c1',
        expires_at: PAST,
        has_refresh_token: true,
      },
    });
    const { calls, fetchImpl } = stubFetch({ body: { access_token: 'at', expires_in: 600 } });
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    assert(calls[0].init?.headers as Record<string, string>, new URLSearchParams(String(calls[0].init?.body)));
  });

  it('publishes vault_credential.refresh_failed and stamps the row on failure', async () => {
    const db = setup();
    const id = seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt' });
    const { fetchImpl } = stubFetch({ status: 401, body: { error: 'invalid_grant' } });
    const published: Array<{ type: string; subjectId: string; extra?: Record<string, unknown> }> = [];

    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
      publish: async (event) => { published.push(event); },
    });

    const state = storedState(db, id);
    expect(state.lastRefreshStatus).toBe('failed');
    expect(state.lastRefreshError).toContain('401');
    expect(auditActions(db, id)).toContain('refresh_failed');
    expect(published).toEqual([{
      type: 'vault_credential.refresh_failed',
      subjectId: id,
      extra: { vault_id: 'vlt_a', error: state.lastRefreshError },
    }]);
    // The stored token is left in place: the connect proceeds with the last
    // known value and the endpoint answers for itself.
    expect(storedSecret(db, id, tmpDir!)).toBe('old-access-token');
  });

  it('deduplicates attempts within the retry window', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt' });
    const { calls, fetchImpl } = stubFetch({ status: 500 });
    const clock = new Date('2026-01-01T00:00:00Z');
    const now = () => clock;
    const opts = { sessionId: 'sess_o', mcpServerUrl: SERVER_URL, dataDir: tmpDir, fetchImpl, now };

    await refreshMcpOauthCredentialsForServer(db, opts);
    await refreshMcpOauthCredentialsForServer(db, opts);
    expect(calls).toHaveLength(1);

    // Past the window the next connect retries.
    clock.setTime(clock.getTime() + OAUTH_REFRESH_RETRY_WINDOW_MS + 1);
    await refreshMcpOauthCredentialsForServer(db, opts);
    expect(calls).toHaveLength(2);
  });

  it('joins a concurrent refresh rather than starting a second one', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt' });
    const { calls, fetchImpl } = stubFetch({ body: { access_token: 'at', expires_in: 600 } });
    const opts = { sessionId: 'sess_o', mcpServerUrl: SERVER_URL, dataDir: tmpDir, fetchImpl };

    // Two sessions connecting at once share the vault; the second joins the
    // running attempt instead of racing a rotated refresh token.
    await Promise.all([
      refreshMcpOauthCredentialsForServer(db, opts),
      refreshMcpOauthCredentialsForServer(db, opts),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('does not touch a credential keyed to a different MCP server', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt', mcpServerUrl: 'https://other.example/mcp' });
    const { calls, fetchImpl } = stubFetch({ body: { access_token: 'at' } });
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it('reads the session row when no vault id override is supplied', async () => {
    const db = setup();
    seedOAuthCredential(db, tmpDir!, { refreshToken: 'rt' });
    const { calls, fetchImpl } = stubFetch({ body: { access_token: 'at', expires_in: 600 } });
    await refreshMcpOauthCredentialsForServer(db, {
      sessionId: 'sess_o',
      mcpServerUrl: SERVER_URL,
      dataDir: tmpDir,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
  });
});
