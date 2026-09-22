import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { dispatchWebhookEvent, retryDueWebhookDeliveries } from '@/core/operations/webhook-dispatcher.js';
import { signWebhookDelivery } from '@/core/operations/webhook-signature.js';

describe('webhook dispatcher', () => {
  let db: Database;
  let tmpDir: string;
  const fixedNow = new Date('2026-07-23T00:00:00.000Z');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-whd-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches matching webhooks and stores signed delivered records', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_ok', 'OK', 'https://example.com/hook', JSON.stringify(['session.*']), fixedNow.toISOString(), fixedNow.toISOString());
    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;

    const results = await dispatchWebhookEvent(db, {
      event: 'session.status_running',
      data: { session_id: 'sess_1' },
    }, { secret: 'secret', fetchImpl, now: () => fixedNow });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(String(init.body)).toContain('session.status_running');
    expect(init.headers['X-Managed-Agents-Signature']).toMatch(/^sha256=/);
    expect(results[0]).toMatchObject({
      webhook_id: 'wh_ok',
      status: 'delivered',
      status_code: 204,
      attempt_count: 1,
      next_retry_at: null,
    });
  });

  it('sends the published Standard Webhooks v1 headers', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_hdr', 'HDR', 'https://example.com/hook', JSON.stringify(['*']), fixedNow.toISOString(), fixedNow.toISOString());
    const fetchImpl = vi.fn(async () => ({ status: 204 })) as unknown as typeof fetch;

    await dispatchWebhookEvent(db, {
      event: 'session.status_idle',
      data: { session_id: 'sess_1' },
      id: 'whevt_fixed',
    }, { secret: 'whsec_secret_value', fetchImpl, now: () => fixedNow });

    const [, init] = (fetchImpl as any).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // The legacy header is still sent, so an existing receiver keeps working.
    expect(headers['X-Managed-Agents-Signature']).toMatch(/^sha256=/);
    // The published set, keyed by the delivery id and the timestamp the
    // signature covers.
    expect(headers['webhook-id']).toMatch(/^whd_/);
    expect(headers['webhook-timestamp']).toBe(String(Math.floor(fixedNow.getTime() / 1000)));
    expect(headers['webhook-signature']).toMatch(/^v1,/);

    // The signature really does cover id.timestamp.body.
    const expected = signWebhookDelivery({
      secret: 'whsec_secret_value',
      id: headers['webhook-id'],
      timestamp: headers['webhook-timestamp'],
      body: String(init.body),
    });
    expect(headers['webhook-signature']).toBe(expected);
  });

  it('queues failed deliveries for retry and later marks them delivered', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_retry', 'Retry', 'https://example.com/retry', JSON.stringify(['turn_complete']), fixedNow.toISOString(), fixedNow.toISOString());
    const failingFetch = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;

    const first = await dispatchWebhookEvent(db, {
      event: 'turn_complete',
      data: { ok: false },
    }, { secret: 'secret', fetchImpl: failingFetch, now: () => fixedNow });

    expect(first[0]).toMatchObject({
      status: 'pending_retry',
      status_code: 503,
      attempt_count: 1,
    });
    expect(first[0].next_retry_at).toBe('2026-07-23T00:01:00.000Z');

    const successfulFetch = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    const retried = await retryDueWebhookDeliveries(db, {
      secret: 'secret',
      fetchImpl: successfulFetch,
      now: () => new Date('2026-07-23T00:02:00.000Z'),
    });

    expect(successfulFetch).toHaveBeenCalledOnce();
    expect(retried[0]).toMatchObject({
      status: 'delivered',
      status_code: 200,
      attempt_count: 2,
      next_retry_at: null,
    });

    // The retry is the same delivery, so it carries the published header set the
    // first attempt carried: the id is unchanged and the timestamp is this
    // attempt's, which is what the receiver's freshness window checks.
    const [, retryInit] = (successfulFetch as any).mock.calls[0];
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders['webhook-id']).toBe(first[0].id);
    expect(retryHeaders['webhook-timestamp']).toBe(String(Math.floor(new Date('2026-07-23T00:02:00.000Z').getTime() / 1000)));
    expect(retryHeaders['X-Managed-Agents-Signature']).toMatch(/^sha256=/);
    expect(retryHeaders['webhook-signature']).toBe(signWebhookDelivery({
      secret: 'secret',
      id: retryHeaders['webhook-id'],
      timestamp: retryHeaders['webhook-timestamp'],
      body: String(retryInit.body),
    }));
  });

  it('keeps one delivery id and re-signs every attempt with its own timestamp', async () => {
    db.prepare(
      `INSERT INTO webhooks (id, name, url, events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('wh_multi', 'Multi', 'https://example.com/multi', JSON.stringify(['turn_failed']), fixedNow.toISOString(), fixedNow.toISOString());

    const secret = 'whsec_MQ==';
    const attemptOne = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;
    const attemptTwo = vi.fn(async () => ({ status: 503 })) as unknown as typeof fetch;
    const attemptThree = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch;
    const times = [
      fixedNow,
      new Date('2026-07-23T00:02:00.000Z'),
      new Date('2026-07-23T00:05:00.000Z'),
    ];

    const [first] = await dispatchWebhookEvent(db, { event: 'turn_failed', data: {} }, { secret, fetchImpl: attemptOne, now: () => times[0] });
    const [second] = await retryDueWebhookDeliveries(db, { secret, fetchImpl: attemptTwo, now: () => times[1] });
    const [third] = await retryDueWebhookDeliveries(db, { secret, fetchImpl: attemptThree, now: () => times[2] });

    // One delivery across three attempts, so a receiver can deduplicate on the id.
    expect([second.id, third.id]).toEqual([first.id, first.id]);
    expect([first.attempt_count, second.attempt_count, third.attempt_count]).toEqual([1, 2, 3]);
    expect(third).toMatchObject({ status: 'delivered', status_code: 200 });

    const attempts = [attemptOne, attemptTwo, attemptThree];
    attempts.forEach((fetchImpl, index) => {
      const [, init] = (fetchImpl as any).mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers['webhook-id']).toBe(first.id);
      expect(headers['webhook-timestamp']).toBe(String(Math.floor(times[index].getTime() / 1000)));
      expect(headers['webhook-signature']).toBe(signWebhookDelivery({
        secret,
        id: first.id,
        timestamp: headers['webhook-timestamp'],
        body: String(init.body),
      }));
    });
  });
});
