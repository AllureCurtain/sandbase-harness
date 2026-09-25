/**
 * A redirecting webhook endpoint is disabled on the attempt that observes it, and that
 * attempt is never retried.
 *
 * `postWebhook` already refused to follow a redirect (`redirect: 'manual'`), but it then
 * classified the response as `ok = status >= 200 && status < 300`, so a `3xx` became
 * `{ ok: false, error: 'HTTP 302' }` — indistinguishable from a `500` — and `nextRetryAt`
 * queued another attempt. The published delivery behaviour is explicit about both halves:
 * a `3xx` disables the endpoint on the first attempt with the machine-readable reason
 * `auto-disabled: endpoint URL returned a redirect (3xx)`, and a response that triggers
 * auto-disable is never retried, while the three-attempt ceiling still applies to every
 * other failure.
 *
 * The tests use real HTTP listeners rather than a stubbed `fetch`, because the claim being
 * made is about what happens on the wire: the redirect must be observed and **not**
 * followed, which a stub that returns a 302 object cannot demonstrate. The redirect target
 * is a second listener, and its request count is the evidence that nothing was followed.
 *
 * The retry assertions call `retryDueWebhookDeliveries` directly rather than through
 * `POST /v1/webhooks/retry-due`, because only the function accepts a clock — a due retry
 * is otherwise an hour of waiting. It is the same function that route calls with the same
 * options, so the delivery rows and the endpoint state asserted here are the ones the route
 * would produce.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { retryDueWebhookDeliveries } from '@/core/operations/webhook-dispatcher.js';

const EVENT = 'session.status_idled';
const PUBLISHED_REASON = 'auto-disabled: endpoint URL returned a redirect (3xx)';

/** A real HTTP listener whose status code the test can change between attempts. */
type Stub = {
  url: string;
  requests: () => number;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
};

async function startStub(initialStatus: number, location?: string): Promise<Stub> {
  let status = initialStatus;
  let count = 0;
  const server = createHttpServer((_req, res) => {
    count += 1;
    res.statusCode = status;
    if (status >= 300 && status < 400 && location) res.setHeader('Location', location);
    res.end('stub');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests: () => count,
    setStatus: (next) => {
      status = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // The dispatcher's fetch keeps its socket alive, so a bare `close()` would wait for
        // a connection the test is done with.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('a redirecting webhook endpoint is auto-disabled', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  const stubs: Stub[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-webhook-redirect-'));
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

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function stub(status: number, location?: string): Promise<Stub> {
    const started = await startStub(status, location);
    stubs.push(started);
    return started;
  }

  async function createWebhook(name: string, url: string): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, events: [EVENT] }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  async function dispatch(): Promise<void> {
    const res = await app.request('/v1/webhooks/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: EVENT, data: { session_id: 'sess_x' } }),
    });
    expect(res.status).toBe(202);
  }

  async function getWebhook(id: string) {
    const res = await app.request(`/v1/webhooks/${id}`);
    return (await res.json()) as any;
  }

  async function putWebhook(id: string, patch: Record<string, unknown>) {
    const res = await app.request(`/v1/webhooks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  function deliveriesFor(id: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE webhook_id = ?').get(id) as {
        c: number;
      }
    ).c;
  }

  function latestDelivery(id: string) {
    return db
      .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id) as any;
  }

  /** A clock far past every backoff the dispatcher can schedule. */
  async function retryDueLater(id: string) {
    const results = await retryDueWebhookDeliveries(db, {
      secret: 'whsec_test',
      dataDir: tmpDir,
      now: () => new Date(Date.now() + 86_400_000),
    });
    return results.filter((delivery) => delivery.webhook_id === id);
  }

  it('disables the endpoint with the published reason instead of retrying it', async () => {
    const target = await stub(200);
    const endpoint = await stub(302, target.url);
    const id = await createWebhook('redirecting', endpoint.url);

    await dispatch();

    // The redirect was observed rather than followed: the target saw nothing, and the
    // endpoint itself saw exactly one attempt.
    expect(target.requests()).toBe(0);
    expect(endpoint.requests()).toBe(1);

    const read = await getWebhook(id);
    expect(read.status).toBe('disabled');
    expect(read.disabled_reason).toBe(PUBLISHED_REASON);

    // The attempt is terminal rather than pending: the published rule is that a response
    // that triggers auto-disable is never retried.
    const row = latestDelivery(id);
    expect(row.status).toBe('failed');
    expect(row.status_code).toBe(302);
    expect(row.next_retry_at).toBeNull();

    // Nothing becomes due later either, which is the half a `next_retry_at` assertion alone
    // would not prove: the retry-due query also filters on the endpoint still being active.
    expect(await retryDueLater(id)).toEqual([]);
    expect(latestDelivery(id).status).toBe('failed');

    // A disabled endpoint receives nothing for the events it subscribes to.
    await dispatch();
    expect(deliveriesFor(id)).toBe(1);
    expect(endpoint.requests()).toBe(1);
  });

  it('clears the reason when the endpoint is re-enabled and delivers to it again', async () => {
    const target = await stub(200);
    const endpoint = await stub(302, target.url);
    const id = await createWebhook('migrated', endpoint.url);

    await dispatch();
    expect((await getWebhook(id)).disabled_reason).toBe(PUBLISHED_REASON);

    // The endpoint has been moved and now answers 2xx, which is the published remedy.
    endpoint.setStatus(200);
    const on = await putWebhook(id, { status: 'active' });
    expect(on.status).toBe(200);
    expect(on.body.status).toBe('active');
    expect(on.body.disabled_reason).toBeNull();

    // Cleared in storage as well, not only hidden by the projection: an active endpoint must
    // not carry a stored reason for a state it is no longer in.
    const stored = db.prepare('SELECT status, disabled_reason FROM webhooks WHERE id = ?').get(id) as any;
    expect(stored.disabled_reason).toBeNull();

    await dispatch();
    expect(deliveriesFor(id)).toBe(2);
    const row = latestDelivery(id);
    expect(row.status).toBe('delivered');
    expect(row.status_code).toBe(200);
  });

  it('still retries every other failure, so the terminal path is specific to redirects', async () => {
    const endpoint = await stub(500);
    const id = await createWebhook('failing', endpoint.url);

    await dispatch();

    const read = await getWebhook(id);
    expect(read.status).toBe('active');
    expect(read.disabled_reason).toBeNull();

    const row = latestDelivery(id);
    expect(row.status).toBe('pending_retry');
    expect(row.status_code).toBe(500);
    expect(row.next_retry_at).not.toBeNull();

    // The retry really is due and really is attempted, which is the behaviour the redirect
    // case deliberately does not have.
    const due = await retryDueLater(id);
    expect(due).toHaveLength(1);
    expect(due[0].attempt_count).toBe(2);
  });

  it('disables the endpoint when a due retry observes the redirect', async () => {
    const endpoint = await stub(500);
    const id = await createWebhook('flaky', endpoint.url);

    await dispatch();
    expect(latestDelivery(id).status).toBe('pending_retry');
    expect((await getWebhook(id)).status).toBe('active');

    // The endpoint starts redirecting before the retry is due. This is reachable in
    // practice: the retry was queued while the endpoint was failing differently, and an
    // operator can re-enable an endpoint while a retry is still due.
    endpoint.setStatus(302);
    const due = await retryDueLater(id);
    expect(due).toHaveLength(1);
    expect(due[0].status).toBe('failed');
    expect(due[0].next_retry_at).toBeNull();

    const read = await getWebhook(id);
    expect(read.status).toBe('disabled');
    expect(read.disabled_reason).toBe(PUBLISHED_REASON);
  });

  it('treats every redirect status the same way', async () => {
    const target = await stub(200);

    for (const status of [301, 302, 303, 307, 308]) {
      const endpoint = await stub(status, target.url);
      const id = await createWebhook(`redirect-${status}`, endpoint.url);

      await dispatch();

      const read = await getWebhook(id);
      expect(read.status, `status ${status}`).toBe('disabled');
      expect(read.disabled_reason, `status ${status}`).toBe(PUBLISHED_REASON);
      expect(latestDelivery(id).next_retry_at, `status ${status}`).toBeNull();
    }

    // Not one of the five was followed.
    expect(target.requests()).toBe(0);
  });
});
