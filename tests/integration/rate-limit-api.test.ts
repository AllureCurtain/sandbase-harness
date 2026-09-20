import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('inbound rate limiting API boundary', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-rate-limit-api-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_echo', 'echo', '{}')`);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeApp(options: { authEnabled: () => boolean; writePerMinute?: number }) {
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      apiKeys: [],
      hasApiKeys: options.authEnabled,
      validateApiKey: (key) => key === 'test-secret-key',
      consoleRoot: null,
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      inboundRateLimit: { writePerMinute: options.writePerMinute ?? 1, readPerMinute: 20 },
    });
  }

  it('applies separate authenticated write/read budgets and rejects invalid credentials before counting', async () => {
    const app = makeApp({ authEnabled: () => true });
    const auth = { Authorization: 'Bearer test-secret-key' };
    const create = () => app.request('/v1/sessions', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_echo' }),
    });

    const first = await create();
    expect(first.status).toBe(201);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('0');

    const throttled = await create();
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error).toMatchObject({ type: 'rate_limit_error', code: 'inbound_rate_limited' });
    expect(Number(throttled.headers.get('Retry-After'))).toBeGreaterThan(0);

    const read = await app.request('/v1/sessions', { headers: auth });
    expect(read.status).toBe(200);
    expect((await app.request('/v1/sessions', { headers: { Authorization: 'Bearer wrong-key' } })).status).toBe(401);
  });

  it('follows managed-key auth posture changes after server startup', async () => {
    let authEnabled = false;
    const app = makeApp({ authEnabled: () => authEnabled });

    const open = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_echo' }),
    });
    expect(open.status).toBe(201);

    authEnabled = true;
    expect((await app.request('/v1/sessions')).status).toBe(401);
    const auth = { Authorization: 'Bearer test-secret-key' };
    const limited = () => app.request('/v1/sessions', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_echo' }),
    });
    expect((await limited()).status).toBe(201);
    expect((await limited()).status).toBe(429);

    authEnabled = false;
    const reopened = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_echo' }),
    });
    expect(reopened.status).toBe(201);
  });

  it('does not count CORS preflight requests', async () => {
    const app = makeApp({ authEnabled: () => true });
    const headers = {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    };
    for (let i = 0; i < 5; i += 1) {
      const preflight = await app.request('/v1/sessions', { method: 'OPTIONS', headers });
      expect(preflight.status).toBe(204);
    }
    const response = await app.request('/v1/sessions', { headers: { Authorization: 'Bearer test-secret-key' } });
    expect(response.status).toBe(200);
  });
});
