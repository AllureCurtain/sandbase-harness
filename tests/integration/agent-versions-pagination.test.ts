/**
 * `GET /v1/agents/{id}/versions` is paginated, as the published contract says it is.
 *
 * The documented clients walk this listing with the SDK's `autoPager()` (`智能体设置.md:552`), and
 * `会话操作.md:274` documents the convention itself: `limit` controls the page size, every response
 * carries a `next_page` cursor, and that cursor goes back as the `page` parameter. This listing
 * previously ignored both parameters and answered its whole set with both cursors `null`.
 *
 * The sibling route `GET /v1/agents` deliberately did **not** gain a window (see
 * `agents-query-admission.test.ts`): the published contract paginates this listing and not that one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const definition = {
  name: 'Window agent',
  model: 'gpt-4o',
  system: 'Version one.',
  description: 'Version one.',
};

describe('agent version history pagination', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-agent-versions-window-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
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

  const request = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  /** Creates an agent and two further definitions, which is what gives the history something to window. */
  const seedVersionedAgent = async () => {
    const created = await request('POST', '/v1/agents', definition);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await request('POST', `/v1/agents/${id}`, { system: 'Version two.' })).status).toBe(200);
    expect((await request('POST', `/v1/agents/${id}`, { system: 'Version three.' })).status).toBe(200);
    return id;
  };

  it('windows the history and hands back a followable cursor', async () => {
    const id = await seedVersionedAgent();

    // Precondition, asserted so a failure here reads as "nothing to paginate" rather than as a
    // pagination defect: the history holds at least two versions.
    const all = await request('GET', `/v1/agents/${id}/versions?limit=100`);
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);

    const first = await request('GET', `/v1/agents/${id}/versions?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.data.length).toBe(1);
    expect(first.body.next_page).not.toBeNull();
    // The first page is the first page: there is nothing behind it.
    expect(first.body.prev_page).toBeNull();

    const second = await request('GET', `/v1/agents/${id}/versions?limit=1&page=${encodeURIComponent(first.body.next_page)}`);
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBe(1);
    // The cursor addresses a real position: the second page is a different version, whatever the
    // resource shape calls the distinguishing field.
    expect(JSON.stringify(second.body.data[0])).not.toBe(JSON.stringify(first.body.data[0]));
    // A caller that walked forward can walk back.
    expect(second.body.prev_page).not.toBeNull();

    // Walking the whole history through cursors reaches every version exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 10; step++) {
      const page = await request('GET', `/v1/agents/${id}/versions?limit=1${cursor ? `&page=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.body.data.length).toBe(1);
      seen.push(JSON.stringify(page.body.data[0]));
      cursor = page.body.next_page;
      if (!cursor) break;
    }
    expect(seen.length).toBe(all.body.data.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor it did not issue instead of reading it as page one', async () => {
    const id = await seedVersionedAgent();
    const { status, body } = await request('GET', `/v1/agents/${id}/versions?page=not-a-cursor`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('page must be a cursor returned by this endpoint');
  });

  it('refuses a parameter it does not implement and names the two it does', async () => {
    const id = await seedVersionedAgent();
    const { status, body } = await request('GET', `/v1/agents/${id}/versions?foo=1`);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('foo');
    expect(body.error.message).toContain('limit');
    expect(body.error.message).toContain('page');
  });

  it('keeps reporting the current definition for an agent with no recorded history', async () => {
    const created = await request('POST', '/v1/agents', { ...definition, name: 'Fresh agent' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const { status, body } = await request('GET', `/v1/agents/${id}/versions`);
    expect(status).toBe(200);
    // One version, so no window to walk: both cursors are honestly null, as before this change.
    expect(body.data.length).toBe(1);
    expect(body.next_page).toBeNull();
    expect(body.prev_page).toBeNull();

    // Still a 404 for an agent that does not exist, and not a pagination error.
    const missing = await request('GET', '/v1/agents/agent_missing/versions');
    expect(missing.status).toBe(404);
    expect(missing.body.error.type).toBe('not_found');
  });
});
