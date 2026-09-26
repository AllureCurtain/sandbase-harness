/**
 * `GET /v1/api-keys` refuses a query parameter it does not implement.
 *
 * The accept list is empty because the listing implements no parameter, and four
 * independent measurements agree. The published CMA contract does not contain this
 * endpoint at all — a search of every published doc for `api_keys`, `api-keys` or
 * `/v1/api` returns no match, and its prose mentions of an API key are about the
 * credential a caller holds rather than an administration listing. This repository's own
 * contract classifies the route as a **local collection** (`routes.md`) and names it in
 * the group that "return their whole set rather than a window" (`pagination.md`), so no
 * window parameter is implemented or claimed. And no caller passes one: the Console, the
 * SDK, the CLI and the tests call it bare.
 *
 * A parameter used to be ignored, so `?limit=5` answered a page as though the request had
 * been understood.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('api keys listing query admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const listing = '/v1/api-keys';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-api-keys-admission-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();

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

  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() as any };
  };

  it('refuses a parameter it does not implement instead of ignoring it', async () => {
    const { status, body } = await get(`${listing}?limit=5`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('limit');
    // Not an envelope: a refused request must not read as "there are no API keys".
    expect(body).not.toHaveProperty('data');
  });

  it('names this route as accepting no query parameters', async () => {
    const { status, body } = await get(`${listing}?page=2`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('page');
    expect(body.error.message).toContain('accepts no query parameters');
    // The contract records this listing as returning its whole set rather than a window,
    // so a refusal here cannot be refusing something a caller was promised.
    expect(body.error.message).not.toContain('page=2 or');
  });

  it('still accepts the compatibility parameter without advertising it', async () => {
    const { status, body } = await get(`${listing}?beta=1`);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('leaves the bare request unchanged', async () => {
    const { status, body } = await get(listing);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    // The listing is unwindowed, and its cursors are and stay honestly null.
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });
});
