/**
 * `GET /v1/agents` refuses a query parameter it does not implement.
 *
 * The accept list is empty because the listing implements no parameter, and four measurements
 * agree. Of the 21 published `/v1/agents` lines, only two carry a query string, and both are
 * `?beta=true` — the compatibility parameter this route layer already accepts and ignores. No
 * cursor pagination is documented for the listing at all: `before_id`, `after_id`, `has_more` and
 * `page_token` appear zero times across the published docs, and the documented
 * `limit`/`page`/`next_page` convention is shown for `/v1/sessions`. This repository's own contract
 * names `/v1/agents`, with its versions, in the group of collections that return their whole set
 * (`pagination.md:44`). And no local caller passes a query string.
 *
 * A parameter used to be ignored, so `?limit=5` answered a page as though the request had been
 * understood.
 *
 * The last case here is the opposite direction, and it is the point of this file's scope: the
 * sibling route `GET /v1/agents/{id}/versions` must **not** gain this refusal, because the
 * published contract states that the version history listing *is* paginated
 * (`智能体设置.md:506`, "结果是分页的"). Refusing its `limit` or `page` would refuse a capability a
 * caller was promised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('agents listing query admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const listing = '/v1/agents';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-agents-admission-'));
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
    // Not an envelope: a refused request must not read as "there are no agents".
    expect(body).not.toHaveProperty('data');
  });

  it('names this route as accepting no query parameters', async () => {
    const { status, body } = await get(`${listing}?page=2`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('page');
    expect(body.error.message).toContain('accepts no query parameters');
    // The contract records this listing as returning its whole set, so a refusal here cannot be
    // refusing a window a caller was promised.
    expect(body.error.message).not.toContain('page=2 or');
  });

  it('still accepts the compatibility parameter, which the published examples use', async () => {
    const { status, body } = await get(`${listing}?beta=true`);
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('leaves the bare request unchanged', async () => {
    const { status, body } = await get(listing);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('deliberately leaves the version-history listing refusing nothing', async () => {
    const { status, body } = await get('/v1/agents/agent_missing/versions?limit=5');
    // Whatever this route answers for an agent that does not exist, it must not be the query
    // refusal added above: the published contract promises that listing is paginated.
    expect(String(body?.error?.message ?? '')).not.toContain('accepts no query parameters');
    expect(status).not.toBe(0);
  });
});
