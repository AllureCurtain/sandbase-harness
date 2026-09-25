/**
 * A disabled webhook endpoint can be re-enabled through the API.
 *
 * `webhooks.status` was stored, projected by `toWebhook`, and honoured by the dispatcher
 * (`WHERE ... status = 'active'`), but **no route wrote it**: `PUT /v1/webhooks/{id}`
 * updated name/url/events/description/metadata only. So an endpoint that was ever disabled
 * could only be brought back by editing the database by hand.
 *
 * That matters before auto-disable is implemented, not after: the published delivery
 * behaviour disables an endpoint in three cases and states that all three are reversible
 * by re-enabling it. Auto-disable without a re-enable path would take an endpoint that
 * retries forever today and make it permanently dead — worse than the bug it fixes.
 *
 * The load-bearing assertions drive the real dispatcher rather than reading the column
 * back: a disabled endpoint receives **no** delivery for an event it subscribes to, and
 * the same endpoint receives one after it is re-enabled. A test that only asserted
 * `body.status` would pass with a route that wrote a field nothing reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const EVENT = 'session.status_idled';

describe('webhook endpoint status can be written', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-status-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      `INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`,
    ).run();

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      skills: [],
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createWebhook(name: string): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Port 1 refuses immediately: delivery fails, but the dispatcher still records the
      // attempt, which is what these tests count. No receiver is needed to observe
      // whether an endpoint was attempted at all.
      body: JSON.stringify({ name, url: 'http://127.0.0.1:1/hook', events: [EVENT] }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  async function putWebhook(id: string, patch: Record<string, unknown>) {
    const res = await app.request(`/v1/webhooks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function getWebhook(id: string) {
    const res = await app.request(`/v1/webhooks/${id}`);
    return { status: res.status, body: (await res.json()) as any };
  }

  /** How many delivery attempts the dispatcher recorded for this endpoint. */
  function deliveriesFor(id: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ?').get(id) as {
        c: number;
      }
    ).c;
  }

  async function dispatch(): Promise<void> {
    const res = await app.request('/v1/webhooks/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: EVENT, data: { session_id: 'sess_x' } }),
    });
    expect(res.status).toBe(202);
  }

  it('stops delivering to a disabled endpoint and resumes when it is re-enabled', async () => {
    const disabled = await createWebhook('disabled');
    const control = await createWebhook('control');

    const off = await putWebhook(disabled, { status: 'disabled' });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('disabled');

    await dispatch();
    // The endpoint that was switched off received nothing, while the control on the same
    // event did — so the assertion is about the toggle, not about dispatch being broken.
    expect(deliveriesFor(disabled)).toBe(0);
    expect(deliveriesFor(control)).toBeGreaterThan(0);

    const on = await putWebhook(disabled, { status: 'active' });
    expect(on.status).toBe(200);
    expect(on.body.status).toBe('active');

    await dispatch();
    expect(deliveriesFor(disabled)).toBeGreaterThan(0);
  });

  it('reports the stored status on the listing and the single read', async () => {
    const id = await createWebhook('one');
    expect((await getWebhook(id)).body.status).toBe('active');

    await putWebhook(id, { status: 'disabled' });
    expect((await getWebhook(id)).body.status).toBe('disabled');

    const listed = await app.request('/v1/webhooks');
    const body = (await listed.json()) as any;
    expect(body.data.find((row: any) => row.id === id).status).toBe('disabled');
  });

  it('refuses an unrecognised status by name and leaves the stored one unchanged', async () => {
    const id = await createWebhook('two');

    const refused = await putWebhook(id, { status: 'paused' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('active');
    expect(refused.body.error.message).toContain('disabled');
    expect((await getWebhook(id)).body.status).toBe('active');

    // A non-string value is refused the same way rather than coerced.
    const nonString = await putWebhook(id, { status: 7 });
    expect(nonString.status).toBe(400);
    expect((await getWebhook(id)).body.status).toBe('active');
  });

  it('leaves the status alone when a patch omits it', async () => {
    const id = await createWebhook('three');
    await putWebhook(id, { status: 'disabled' });

    const renamed = await putWebhook(id, { name: 'renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('renamed');
    // The partial-update semantics every other field already has: an omitted field is not
    // a reset, so a rename cannot silently re-enable an endpoint an operator switched off.
    expect(renamed.body.status).toBe('disabled');
  });

  it('still reports an archived endpoint as archived', async () => {
    const id = await createWebhook('four');
    await putWebhook(id, { status: 'disabled' });
    const archived = await app.request(`/v1/webhooks/${id}/archive`, { method: 'POST' });
    expect(archived.status).toBe(200);
    // Archival wins over the stored status, which is the projection's existing rule.
    expect(((await archived.json()) as any).status).toBe('archived');
  });
});
