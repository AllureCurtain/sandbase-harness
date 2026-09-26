/**
 * `GET /v1/environments` refuses a query parameter it does not implement.
 *
 * The accept list is empty because the listing implements no parameter, and four
 * measurements agree. The published contract documents the **endpoint** but no parameter for
 * its listing: every published `/v1/environments` line was read and not one carries a query
 * string, and the "管理环境" section documents list, retrieve, archive and delete with bare
 * `curl` commands (`云环境设置.md:582-605`). Its `include_archived` opt-in is documented for
 * the memory-store and vault listings, never for environments. This repository's own contract
 * names the route, with its worker keys, in the group that "return their whole set rather than
 * a window" (`pagination.md:45`), so no window parameter is implemented or claimed either. And
 * no local caller passes a query string: the Console, the SDK, the CLI and the tests call it
 * bare.
 *
 * A parameter used to be ignored, so `?limit=5` answered a page as though the request had been
 * understood. The archived-environment exclusion is pre-existing behaviour and is pinned here
 * so that this change cannot be read as having altered it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('environments listing query admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  const listing = '/v1/environments';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-environments-admission-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_active', 'active', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata, archived_at) VALUES ('env_archived', 'archived', '', '{}', '{}', datetime('now'))").run();

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
    // Not an envelope: a refused request must not read as "there are no environments".
    expect(body).not.toHaveProperty('data');
  });

  it('refuses the archived opt-in, which is published for other collections only', async () => {
    const { status, body } = await get(`${listing}?include_archived=true`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('include_archived');
    expect(body.error.message).toContain('accepts no query parameters');
    // The published `include_archived` opt-in names the memory-store and vault listings, so
    // refusing it here cannot be refusing something a caller was told they could send.
    expect(body.error.message).not.toContain('include_archived=true or');
  });

  it('still accepts the compatibility parameter without advertising it', async () => {
    const { status, body } = await get(`${listing}?beta=1`);
    expect(status).toBe(200);
    expect(body.data.map((environment: any) => environment.id)).toEqual(['env_active']);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });

  it('leaves the bare request unchanged, archived environments still excluded', async () => {
    const { status, body } = await get(listing);
    expect(status).toBe(200);
    expect(body.data.map((environment: any) => environment.id)).toEqual(['env_active']);
    // The listing is unwindowed, and its cursors are and stay honestly null.
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();
  });
});
