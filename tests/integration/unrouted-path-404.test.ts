/**
 * Integration test: an unrouted path answers the structured error envelope.
 *
 * Hono's default fallback returns `text/plain` "404 Not Found" for a path the
 * app does not serve. That is a different shape from every 404 this runtime
 * produces, and the difference is not cosmetic: a client decoding `error.type`
 * fails while parsing the body and reports a transport-shaped error for what is
 * really a not-found. These cases pin one envelope for both, and pin the
 * behaviours that must not move with it — a missing resource keeps its own
 * message, the Console surface keeps its status codes, and authentication still
 * precedes routing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('Unrouted path 404 envelope', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  function build(options: { apiKeys?: string[]; consoleRoot?: string | null } = {}) {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-404-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: options.consoleRoot ?? null,
      ...(options.apiKeys ? { apiKeys: options.apiKeys } : {}),
    });
  }

  beforeEach(() => { app = build(); });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function readError(path: string, method = 'GET') {
    const res = await app.request(path, { method });
    const text = await res.text();
    return { res, text };
  }

  it.each([
    ['the managed-agents namespace', '/v1/nope'],
    ['the extension namespace', '/v1/x/nope'],
    ['a namespace the runtime never had', '/v9/nope'],
    ['the server root', '/nope'],
  ])('answers a JSON not_found for %s', async (_label, path) => {
    const { res, text } = await readError(path);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    // Parsing is the point: before this change the body was plain text and this
    // call threw instead of returning a value a client can branch on.
    const body = JSON.parse(text);
    expect(body.error.type).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('answers the same envelope when the path is mounted under another verb', async () => {
    // `/v1/agents` is mounted for GET and POST; DELETE has no handler.
    const { res, text } = await readError('/v1/agents', 'DELETE');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(JSON.parse(text).error.type).toBe('not_found');
  });

  it('keeps a missing resource distinct from an unrouted path', async () => {
    const missing = await app.request('/v1/agents/agent_missing');
    const missingBody = await missing.json() as any;
    const unrouted = await readError('/v1/agents/agent_missing/nope');

    expect(missing.status).toBe(404);
    expect(missingBody.error.type).toBe('not_found');
    expect(missingBody.error.message).toBe('Agent not found: agent_missing');
    // Both are 404 `not_found`, and that is deliberate — the caller branches on
    // the type, not on prose. The two cases must not be *merged* into one
    // message, or a caller loses the ability to tell "wrong path" from
    // "wrong id" when reading logs.
    expect(JSON.parse(unrouted.text).error.message).not.toBe(missingBody.error.message);
  });

  it('leaves the Console surface alone', async () => {
    // No built Console in this fixture: /dashboard must still report the 503
    // HTML page rather than being captured by the JSON fallback.
    const dashboard = await app.request('/dashboard');
    expect(dashboard.status).toBe(503);
    expect(dashboard.headers.get('content-type') ?? '').toContain('text/html');

    const legacy = await app.request('/ui');
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get('location')).toBe('/dashboard');
  });

  it('authenticates before it routes', async () => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    app = build({ apiKeys: ['secret-key'] });

    const anonymous = await app.request('/v1/nope');
    expect(anonymous.status).toBe(401);

    const authorized = await app.request('/v1/nope', {
      headers: { authorization: 'Bearer secret-key' },
    });
    expect(authorized.status).toBe(404);
    expect(JSON.parse(await authorized.text()).error.type).toBe('not_found');
  });
});