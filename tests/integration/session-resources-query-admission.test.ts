/**
 * `GET /v1/sessions/{id}/resources` refuses a query parameter it does not implement.
 *
 * The accept list is empty because the listing implements no parameter. The published CMA
 * docs document none for it — the resource API is documented for adding and removing
 * resources (`附加和下载文件.md`), and no published request targets this listing with a
 * query string — and this repository's own contract names the route in the group that
 * "return their whole set rather than a window" (`contracts/anthropic-cma/pagination.md`),
 * so no window parameter is implemented or claimed either. A parameter used to be ignored,
 * so `?limit=5` answered a page as though the request had been understood.
 *
 * Admission runs **before** the session lookup, and that ordering is asserted in both
 * directions: it is the difference between "this request is malformed" and "this session
 * does not exist".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('session resources listing query admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const listing = '/v1/sessions/sess_r/resources';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-session-resources-admission-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, vault_ids) VALUES ('sess_r', 'agent_x', 'x', 'env_a', '[]')",
    ).run();

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
    // Not an envelope: a refused request must not read as "this session has no resources".
    expect(body).not.toHaveProperty('data');
  });

  it('names this route as accepting no query parameters', async () => {
    const { status, body } = await get(`${listing}?page=2`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('page');
    expect(body.error.message).toContain('accepts no query parameters');
    // The contract records this listing as returning its whole set rather than a window, so
    // refusing a window parameter is refusing something that was never claimed to work.
    expect(body.error.message).not.toContain('page=2 or');
  });

  it('still accepts the compatibility parameter without advertising it', async () => {
    const { status, body } = await get(`${listing}?beta=1`);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('refuses before the session is resolved, in both directions', async () => {
    const refusedUnknown = await get('/v1/sessions/sess_missing/resources?limit=5');
    expect(refusedUnknown.status).toBe(400);
    expect(refusedUnknown.body.error.message).toContain('limit');

    const missing = await get('/v1/sessions/sess_missing/resources');
    expect(missing.status).toBe(404);
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
