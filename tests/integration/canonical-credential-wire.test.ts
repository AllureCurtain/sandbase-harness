/**
 * Integration test: the canonical credential wire profile over HTTP.
 *
 * `tests/unit/canonical-credential.test.ts` pins the parser and the projection as
 * pure functions; what it cannot show is that the routes use them. A route could
 * accept the canonical shape and still return the local one, or leak the secret it
 * just stored. These assertions create each canonical credential type through the
 * published endpoint and read it back through the same one.
 *
 * The projection is additive while a Console page still renders and searches on
 * the local fields, so the read-back carries the canonical `display_name` and
 * `auth` beside the local `auth_type` / `variable_name`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('Canonical credential wire profile over HTTP', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const SECRET = 'sk-live-super-secret-value-9f3a';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credwire-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    db.prepare("INSERT INTO credential_vaults (id, name) VALUES ('vlt_test', 'test vault')").run();

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    const res = await app.request('/v1/credential-vaults/vlt_test/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function list() {
    const res = await app.request('/v1/credential-vaults/vlt_test/credentials');
    const body = (await res.json()) as Record<string, any>;
    return body.data as Record<string, any>[];
  }

  it('round-trips an environment_variable credential in the nested shape', async () => {
    const created = await post({
      display_name: 'Deploy key',
      auth: { type: 'environment_variable', secret_name: 'DEPLOY_KEY', secret_value: SECRET },
    });

    expect(created.status).toBe(201);
    // `display_name` is a sibling of `auth`, not nested inside it.
    expect(created.body.display_name).toBe('Deploy key');
    expect(created.body.auth).toMatchObject({ type: 'environment_variable', secret_name: 'DEPLOY_KEY' });

    const [readBack] = await list();
    expect(readBack.auth).toMatchObject({ type: 'environment_variable', secret_name: 'DEPLOY_KEY' });
    // Read-back resolves the omitted location to both positions enabled.
    expect(readBack.auth.injection_location).toEqual({ header: true, body: true });
  });

  it('round-trips a static_bearer credential and reports it under the canonical type', async () => {
    const created = await post({
      display_name: 'Vendor API',
      auth: { type: 'static_bearer', mcp_server_url: 'https://mcp.vendor.example/api', token: SECRET },
    });

    expect(created.status).toBe(201);
    // The canonical type name is `static_bearer`; `bearer_token` is the stored
    // local name and must not appear on the wire.
    expect(created.body.auth.type).toBe('static_bearer');
    expect(created.body.auth.mcp_server_url).toBe('https://mcp.vendor.example/api');

    const [readBack] = await list();
    expect(readBack.auth.type).toBe('static_bearer');
    expect(readBack.auth.mcp_server_url).toBe('https://mcp.vendor.example/api');
  });

  it('round-trips an mcp_oauth credential and warns that refresh is not executed', async () => {
    const created = await post({
      display_name: 'OAuth vendor',
      auth: {
        type: 'mcp_oauth',
        mcp_server_url: 'https://oauth.vendor.example/mcp',
        access_token: SECRET,
        refresh: { token_endpoint: 'https://oauth.vendor.example/token', client_id: 'client_abc' },
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.auth.type).toBe('mcp_oauth');
    // A caller who sends a refresh block must learn it will not be honoured.
    expect(created.body.warnings?.join(' ')).toContain('not executed');
  });

  it('never returns the secret it stored, for any type', async () => {
    for (const auth of [
      { type: 'environment_variable', secret_name: 'A_KEY', secret_value: SECRET },
      { type: 'static_bearer', mcp_server_url: 'https://a.example/mcp', token: SECRET },
      { type: 'mcp_oauth', mcp_server_url: 'https://b.example/mcp', access_token: SECRET },
    ]) {
      const created = await post({ auth });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(SECRET);
      expect(JSON.stringify(await list())).not.toContain(SECRET);
    }
  });

  it('rejects a body that mixes the nested and flat shapes', async () => {
    const res = await post({
      auth: { type: 'environment_variable', secret_name: 'X_KEY' },
      auth_type: 'environment_variable',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('either auth or the flat');
  });

  it('still accepts the legacy flat shape as an alias', async () => {
    const created = await post({
      name: 'Legacy env',
      auth_type: 'environment_variable',
      variable_name: 'LEGACY_KEY',
      value: SECRET,
      injection_locations: ['request_headers'],
    });

    expect(created.status).toBe(201);
    const [readBack] = await list();
    // The legacy write is projected back in the canonical nested shape, so a
    // client reading credentials never has to branch on which shape was used.
    expect(readBack.auth.type).toBe('environment_variable');
    expect(readBack.auth.secret_name).toBe('LEGACY_KEY');
    expect(readBack.auth.injection_location).toEqual({ header: true, body: false });
  });

  it('requires the secret_value for an environment_variable credential', async () => {
    const res = await post({ auth: { type: 'environment_variable', secret_name: 'NO_VALUE' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('secret_value is required');
  });

  it('requires mcp_server_url for the MCP-bound types', async () => {
    for (const type of ['static_bearer', 'mcp_oauth']) {
      const res = await post({ auth: { type, token: SECRET, access_token: SECRET } });
      expect(res.status, `${type} should require a server URL`).toBe(400);
      expect(res.body.error.message).toContain('mcp_server_url');
    }
  });
});
