/**
 * `GET /v1/environments/{id}/worker-keys` refuses a query parameter it does not implement.
 *
 * The route is a local self-hosted extension: the published CMA contract has no
 * counterpart for worker keys at all (zero mentions across the published docs), so it
 * documents no parameter for this listing either. There is therefore nothing to honour
 * and nothing ambiguous to resolve, and an **empty** accept list is the honest one — the
 * listing reads no query parameter, so a parameter used to be ignored and `?limit=5`
 * answered a page as though the request had been understood.
 *
 * That the refusal happens **before** the environment is resolved is asserted in both
 * directions, because it is the difference between "this request is malformed" and "this
 * environment does not exist" — an unknown parameter on a missing environment must not
 * read as a `404`, and a bare request on a missing environment must still be one.
 *
 * `beta` is the one accepted-and-ignored compatibility parameter, deliberately not
 * advertised in the refusal's list. POST routes are untouched by this change and are
 * exercised by their own suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('environment worker-keys listing query admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const listing = '/v1/environments/env_a/worker-keys';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-worker-keys-admission-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });

    // A key to list, created through the route with no query string — the shape every
    // local caller uses (`src/sdk/client.ts`, the CLI).
    const created = await app.request(listing, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worker-one' }),
    });
    expect(created.status, await created.text()).toBe(201);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() as any };
  };

  it('refuses a parameter it does not implement instead of ignoring it', async () => {
    const { status, body } = await get(`${listing}?limit=5`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('limit');
    // Not an envelope: a refused request must not read as "this environment has no keys".
    expect(body).not.toHaveProperty('data');
  });

  it('names this route as accepting no query parameters', async () => {
    const { status, body } = await get(`${listing}?include_archived=true`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('include_archived');
    expect(body.error.message).toContain('accepts no query parameters');
    // The published contract documents no parameter for this local-only route, so the
    // refusal cannot be refusing something a caller was told they could send.
    expect(body.error.message).not.toContain('include_archived=true or');
  });

  it('still accepts the compatibility parameter without advertising it', async () => {
    const { status, body } = await get(`${listing}?beta=1`);
    expect(status).toBe(200);
    expect(body.data.map((key: any) => key.name)).toContain('worker-one');
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('refuses before the environment is resolved, in both directions', async () => {
    // Unknown parameter on a missing environment is a malformed request, not a 404.
    const refusedUnknown = await get('/v1/environments/env_missing/worker-keys?limit=5');
    expect(refusedUnknown.status).toBe(400);
    expect(refusedUnknown.body.error.message).toContain('limit');

    // A bare request on a missing environment is still the 404 it always was.
    const missing = await get('/v1/environments/env_missing/worker-keys');
    expect(missing.status).toBe(404);
  });

  it('leaves the bare request unchanged', async () => {
    const { status, body } = await get(listing);
    expect(status).toBe(200);
    expect(body.data.map((key: any) => key.name)).toContain('worker-one');
    // The listing is unwindowed, and its cursors are and stay honestly null.
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
    // Still no raw secret in a listing.
    expect(JSON.stringify(body)).not.toContain('secret_key');
  });
});
