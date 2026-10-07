/**
 * Integration test: `POST /v1/vaults/{id}/credentials/{id}/mcp_oauth_validate`.
 *
 * The endpoint live-probes a stored credential against its declared MCP
 * server: the `initialize` handshake runs with the secret on the wire, a 401
 * triggers the same refresh exchange the injection boundary owns (persisted
 * the same way), and the verdict is the published `vault_credential_validation`
 * — `valid` only on a completed handshake, `invalid` on a rejection the
 * refresh did not recover, `unknown` on anything transient.
 *
 * The fixture is a real HTTP server answering the two legs the probe needs —
 * the SSE open and the message POST — plus a token endpoint, so the handshake
 * is the same `SSEClientTransport` + `Client` path a session connect uses.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { encryptSecret, decryptSecret } from '@/core/security/secrets.js';
import { validateMcpCredential } from '@/core/credentials/mcp-oauth-validate.js';

const PUBLISHED = '/v1/vaults';

interface StubOptions {
  /** Authorization header values the MCP endpoint accepts, or a judge. */
  accept: (authorization: string | null) => boolean;
  /** Token endpoint behaviour; absent answers 404. */
  tokenResponse?: { status: number; body: unknown };
  /** What the MCP 401 body carries — used to prove scrubbing. */
  unauthorizedBody?: (authorization: string | null) => unknown;
  /** Hold the SSE open request without answering (timeout tests). */
  hang?: boolean;
}

interface StubServers {
  url: string;
  tokenEndpoint: string;
  requests: Array<{ method: string; url: string; authorization: string | null; accept?: string | null }>;
  close: () => Promise<void>;
}

function startStubServers(opts: StubOptions): Promise<StubServers> {
  const requests: StubServers['requests'] = [];
  const sseClients = new Set<ServerResponse>();
  const server = createHttpServer((req, res) => {
    const authorization = req.headers.authorization ?? null;
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: 'POST', url: '/token', authorization });
        const reply = opts.tokenResponse;
        if (!reply) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const payload = typeof reply.body === 'function' ? reply.body(body) : reply.body;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/mcp') {
      requests.push({ method: 'GET', url: '/mcp', authorization, accept: req.headers.accept ?? null });
      if (opts.hang) return; // never answered: the probe's own timeout decides
      if (!opts.accept(authorization)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(
          opts.unauthorizedBody ? opts.unauthorizedBody(authorization) : { error: 'invalid_token' },
        ));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: endpoint\ndata: /mcp/messages\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp/messages') {
      requests.push({ method: 'POST', url: '/mcp/messages', authorization });
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(202).end();
        const rpc = JSON.parse(body) as { id?: unknown; method?: string };
        if (rpc.id !== undefined) {
          const answer = JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'stub-mcp', version: '0.0.1' },
            },
          });
          for (const client of sseClients) {
            client.write(`event: message\ndata: ${answer}\n\n`);
          }
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        tokenEndpoint: `http://127.0.0.1:${port}/token`,
        requests,
        close: () => new Promise((done) => {
          for (const client of sseClients) client.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

function seedCredential(
  db: Database,
  dataDir: string,
  opts: {
    id?: string;
    authType?: string;
    mcpServerUrl?: string | null;
    accessToken?: string;
    refreshToken?: string | null;
    network?: unknown;
    state?: Record<string, unknown>;
  } = {},
): string {
  const id = opts.id ?? 'vcrd_probe';
  const secret = encryptSecret(opts.accessToken ?? 'tok-old', dataDir);
  const refresh = opts.refreshToken != null
    ? encryptSecret(opts.refreshToken, dataDir)
    : { ciphertext: '', nonce: '', tag: '' };
  db.prepare(
    `INSERT INTO credential_records (
      id, vault_id, name, auth_type, mcp_server_url, value_hint, network,
      injection_locations, secret_ciphertext, secret_nonce, secret_tag,
      oauth_state, refresh_token_ciphertext, refresh_token_nonce, refresh_token_tag,
      client_secret_ciphertext, client_secret_nonce, client_secret_tag,
      status, metadata, created_at, updated_at
    ) VALUES (?, ?, 'probe', ?, ?, '••••oken', ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(
    id,
    'vlt_a',
    opts.authType ?? 'mcp_oauth',
    opts.mcpServerUrl === undefined ? null : opts.mcpServerUrl,
    JSON.stringify(opts.network ?? { type: 'unrestricted', allowed_hosts: [] }),
    secret.ciphertext, secret.nonce, secret.tag,
    JSON.stringify(opts.state ?? {}),
    refresh.ciphertext, refresh.nonce, refresh.tag,
    '', '', '',
    new Date().toISOString(), new Date().toISOString(),
  );
  return id;
}

function storedSecret(db: Database, id: string, dataDir: string): string {
  const row = db.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as any;
  return decryptSecret({ ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_tag }, dataDir);
}

function auditActions(db: Database, id: string): string[] {
  return (db.prepare('SELECT action FROM credential_audit_events WHERE credential_id = ?').all(id) as Array<{ action: string }>).map((r) => r.action);
}

describe('mcp_oauth_validate', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let stub: StubServers | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-validate-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_a', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_a', 'a')`);
    server = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });
    return server;
  }

  async function validate(vaultId: string, credentialId: string) {
    const res = await server!.request(`${PUBLISHED}/${vaultId}/credentials/${credentialId}/mcp_oauth_validate`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
      },
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  it('answers valid when the handshake completes and publishes the published shape', async () => {
    const app = setUp();
    stub = await startStubServers({ accept: (auth) => auth === 'Bearer tok-old' });
    const id = seedCredential(db!, tmpDir!, { mcpServerUrl: stub.url });

    const res = await validate('vlt_a', id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'vault_credential_validation',
      credential_id: id,
      vault_id: 'vlt_a',
      status: 'valid',
      has_refresh_token: false,
      mcp_probe: null,
      refresh: null,
    });
    expect(typeof res.body.validated_at).toBe('string');
    // The secret rode the Authorization header on the SSE open exactly the
    // way the injection boundary attaches it, and the transport's own
    // Accept header survived the wrapping fetch.
    expect(stub.requests[0].authorization).toBe('Bearer tok-old');
    expect(stub.requests[0].accept).toContain('text/event-stream');
    expect(auditActions(db!, id)).toContain('validate');
  });

  it('reports invalid on a 401 with no refresh token and captures the probe response', async () => {
    setUp();
    stub = await startStubServers({
      accept: () => false,
      unauthorizedBody: (auth) => ({ error: 'invalid_token', echoed: auth }),
    });
    const id = seedCredential(db!, tmpDir!, { mcpServerUrl: stub.url, accessToken: 'tok-secret-9' });

    const res = await validate('vlt_a', id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invalid');
    expect(res.body.mcp_probe).toMatchObject({
      method: 'initialize',
      http_response: { status_code: 401, content_type: 'application/json' },
    });
    expect(res.body.refresh).toEqual({ status: 'no_refresh_token', http_response: null });
    // The captured body is scrubbed: the token the request carried never
    // appears in what the API publishes back.
    expect(res.body.mcp_probe.http_response.body).not.toContain('tok-secret-9');
    expect(res.body.mcp_probe.http_response.body).toContain('••••');
  });

  it('refreshes on a 401, re-probes, persists the new token, and reports valid', async () => {
    setUp();
    stub = await startStubServers({
      accept: (auth) => auth === 'Bearer tok-new',
      tokenResponse: { status: 200, body: { access_token: 'tok-new', refresh_token: 'rt-new', expires_in: 3600 } },
    });
    const id = seedCredential(db!, tmpDir!, {
      mcpServerUrl: stub.url,
      accessToken: 'tok-old',
      refreshToken: 'rt-old',
      state: {
        token_endpoint: stub!.tokenEndpoint,
        expires_at: '2020-01-01T00:00:00.000Z',
        has_refresh_token: true,
      },
    });

    const res = await validate('vlt_a', id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('valid');
    expect(res.body.refresh).toEqual({ status: 'succeeded', http_response: null });
    expect(res.body.mcp_probe).toBeNull();
    expect(res.body.has_refresh_token).toBe(true);
    // The exchange persisted like the boundary refresher: the stored access
    // token is the new one, encrypted, and the attempts are audited.
    expect(storedSecret(db!, id, tmpDir!)).toBe('tok-new');
    expect(auditActions(db!, id)).toEqual(expect.arrayContaining(['refresh', 'validate']));
    // First probe used the stale token, the re-probe the refreshed one.
    const opens = stub.requests.filter((r) => r.method === 'GET' && r.url === '/mcp');
    expect(opens.map((r) => r.authorization)).toEqual(['Bearer tok-old', 'Bearer tok-new']);
  });

  it('reports invalid when the 401 refresh exchange is itself rejected', async () => {
    setUp();
    stub = await startStubServers({
      accept: () => false,
      tokenResponse: { status: 400, body: { error: 'invalid_grant', echoed: 'rt-old' } },
    });
    const id = seedCredential(db!, tmpDir!, {
      mcpServerUrl: stub.url,
      refreshToken: 'rt-old',
      state: { token_endpoint: stub!.tokenEndpoint, has_refresh_token: true },
    });

    const res = await validate('vlt_a', id);
    expect(res.body.status).toBe('invalid');
    expect(res.body.refresh).toMatchObject({
      status: 'failed',
      http_response: { status_code: 400 },
    });
    // The grant's secret is scrubbed out of the captured error body.
    expect(res.body.refresh.http_response.body).not.toContain('rt-old');
    expect(auditActions(db!, id)).toContain('refresh_failed');
  });

  it('reports unknown when the refresh exchange cannot reach the token endpoint', async () => {
    setUp();
    stub = await startStubServers({ accept: () => false });
    const id = seedCredential(db!, tmpDir!, {
      mcpServerUrl: stub.url,
      refreshToken: 'rt-old',
      // A token endpoint on a port nothing listens on: DNS/TLS/refused is
      // transient, not a rejection.
      state: { token_endpoint: 'http://127.0.0.1:1/token', has_refresh_token: true },
    });

    const res = await validate('vlt_a', id);
    expect(res.body.status).toBe('unknown');
    expect(res.body.refresh).toEqual({ status: 'connect_error', http_response: null });
  });

  it('reports unknown on a 5xx probe without attempting a refresh', async () => {
    setUp();
    // A server that answers 500 on the SSE open: transient, not a rejection.
    const s500 = createHttpServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"upstream"}');
    });
    await new Promise<void>((done) => s500.listen(0, '127.0.0.1', done));
    const port = (s500.address() as AddressInfo).port;
    const id = seedCredential(db!, tmpDir!, {
      mcpServerUrl: `http://127.0.0.1:${port}/mcp`,
      refreshToken: 'rt-old',
      state: { token_endpoint: 'http://127.0.0.1:1/token', has_refresh_token: true },
    });

    const res = await validate('vlt_a', id);
    s500.close();
    expect(res.body.status).toBe('unknown');
    expect(res.body.mcp_probe).toMatchObject({ method: 'initialize', http_response: { status_code: 500 } });
    // A transient rejection is not the 401 recovery path: no exchange ran.
    expect(res.body.refresh).toBeNull();
  });

  it('reports unknown with no http_response when the server cannot be reached', async () => {
    setUp();
    const id = seedCredential(db!, tmpDir!, { mcpServerUrl: 'http://127.0.0.1:1/mcp' });

    const res = await validate('vlt_a', id);
    expect(res.body.status).toBe('unknown');
    expect(res.body.mcp_probe).toEqual({ method: 'initialize', http_response: null });
  });

  it('refuses before decrypting when the network policy does not cover the server host', async () => {
    setUp();
    stub = await startStubServers({ accept: () => true });
    const id = seedCredential(db!, tmpDir!, {
      mcpServerUrl: stub.url,
      network: { type: 'limited', allowed_hosts: ['mcp.allowed.example'] },
    });

    const res = await validate('vlt_a', id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('credential_host_not_allowed');
    // The policy decision is upstream of any wire traffic: the server saw no
    // request, so no secret travelled.
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses a credential type that is not bound to an MCP server', async () => {
    setUp();
    const id = seedCredential(db!, tmpDir!, { authType: 'environment_variable', mcpServerUrl: null });

    const res = await validate('vlt_a', id);
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('answers 404 for a missing vault or credential', async () => {
    setUp();
    expect((await validate('vlt_missing', 'vcrd_x')).status).toBe(404);
    const id = seedCredential(db!, tmpDir!, { mcpServerUrl: 'http://127.0.0.1:1/mcp' });
    expect((await validate('vlt_a', 'vcrd_missing')).status).toBe(404);
    // The same probe answers under the local alias prefix.
    const res = await server!.request(`/v1/credential-vaults/vlt_a/credentials/${id}/mcp_oauth_validate`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
      },
    });
    expect(res.status).toBe(200);
  });

  it('a probe that never answers degrades to unknown rather than hanging', async () => {
    const app = setUp();
    stub = await startStubServers({ accept: () => true, hang: true });
    const id = seedCredential(db!, tmpDir!, { mcpServerUrl: stub.url });
    const row = db!.prepare('SELECT * FROM credential_records WHERE id = ?').get(id) as any;

    const outcome = await validateMcpCredential(db!, row, { dataDir: tmpDir, timeoutMs: 200 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('unknown');
      expect(outcome.result.mcp_probe).toEqual({ method: 'initialize', http_response: null });
    }
  });
});
