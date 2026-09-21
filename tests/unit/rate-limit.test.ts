import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  callerIdentity,
  createInboundRateLimiter,
  requestKind,
  resolveInboundRateLimitPolicy,
} from '@/api/rate-limit.js';

const T0 = Date.parse('2026-09-15T00:00:00.000Z');

function appWith(limiter: ReturnType<typeof createInboundRateLimiter>) {
  const app = new Hono();
  app.use('/v1/*', limiter.middleware);
  app.get('/v1/thing', (c) => c.json({ ok: true }));
  app.post('/v1/thing', (c) => c.json({ ok: true }));
  app.options('/v1/thing', (c) => c.body(null, 204));
  app.get('/v1/x/health', (c) => c.json({ ok: true }));
  return app;
}

describe('resolveInboundRateLimitPolicy', () => {
  it('limits a key-protected runtime and leaves an open local one unlimited', () => {
    expect(resolveInboundRateLimitPolicy({ authEnabled: true, env: {} })).toMatchObject({ enabled: true, readPerMinute: 1200, writePerMinute: 300 });
    expect(resolveInboundRateLimitPolicy({ authEnabled: false, env: {} }).enabled).toBe(false);
  });

  it('lets explicit overrides and environment values control the policy', () => {
    expect(resolveInboundRateLimitPolicy({ enabled: false, authEnabled: true, env: { MANAGED_AGENTS_INBOUND_RATE_LIMIT: 'on' } }).enabled).toBe(false);
    expect(resolveInboundRateLimitPolicy({ authEnabled: false, env: { MANAGED_AGENTS_INBOUND_RATE_LIMIT: 'on', MANAGED_AGENTS_INBOUND_RATE_LIMIT_READ: '60', MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE: '10' } })).toEqual(expect.objectContaining({ enabled: true, readPerMinute: 60, writePerMinute: 10 }));
    expect(resolveInboundRateLimitPolicy({ authEnabled: true, env: { MANAGED_AGENTS_INBOUND_RATE_LIMIT: 'maybe', MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE: '-5' } }).writePerMinute).toBe(300);
  });

  it('re-evaluates dynamic auth posture when no explicit override is set', () => {
    let auth = false;
    const policy = resolveInboundRateLimitPolicy({ authEnabled: () => auth, env: {} });
    expect(policy.enabled).toBe(false);
    auth = true;
    expect(policy.shouldLimit?.()).toBe(true);
    auth = false;
    expect(policy.shouldLimit?.()).toBe(false);
  });
});

describe('requestKind and callerIdentity', () => {
  it('classifies GET/HEAD as reads and mutating methods as writes', () => {
    expect(requestKind('GET')).toBe('read');
    expect(requestKind('head')).toBe('read');
    expect(requestKind('OPTIONS')).toBe('read');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requestKind(method)).toBe('write');
  });

  it('hashes credentials and falls back to the forwarded address', async () => {
    const identityFor = async (headers: Record<string, string>) => {
      let captured = '';
      const app = new Hono();
      app.use('/v1/*', async (c, next) => { captured = callerIdentity(c); await next(); });
      app.get('/v1/thing', (c) => c.json({ ok: true }));
      await app.request('/v1/thing', { headers });
      return captured;
    };
    const identity = await identityFor({ Authorization: 'Bearer secret-key' });
    expect(identity.startsWith('key:')).toBe(true);
    expect(identity).not.toContain('secret-key');
    expect(await identityFor({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })).toBe('ip:203.0.113.9');
  });
});

describe('inbound rate limiter middleware', () => {
  it('counts writes and returns a structured 429 with retry headers', async () => {
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 100, writePerMinute: 2 }, () => T0));
    expect((await app.request('/v1/thing', { method: 'POST' })).headers.get('X-RateLimit-Remaining')).toBe('1');
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);
    const third = await app.request('/v1/thing', { method: 'POST' });
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatchObject({ type: 'rate_limit_error', code: 'inbound_rate_limited' });
    expect(Number(third.headers.get('Retry-After'))).toBe(60);
    expect(third.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('keeps read/write buckets independent and resets at the next window', async () => {
    let now = T0;
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 1, writePerMinute: 1 }, () => now));
    expect((await app.request('/v1/thing')).status).toBe(200);
    expect((await app.request('/v1/thing')).status).toBe(429);
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);
    now += 60_000;
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);
  });

  it('uses independent buckets per credential and exempts health', async () => {
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 100, writePerMinute: 1 }, () => T0));
    const authA = { Authorization: 'Bearer a' };
    expect((await app.request('/v1/thing', { method: 'POST', headers: authA })).status).toBe(200);
    expect((await app.request('/v1/thing', { method: 'POST', headers: authA })).status).toBe(429);
    expect((await app.request('/v1/thing', { method: 'POST', headers: { Authorization: 'Bearer b' } })).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await app.request('/v1/x/health')).status).toBe(200);
  });

  it('does not count OPTIONS preflight even when the direct middleware is mounted', async () => {
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 1, writePerMinute: 1 }, () => T0));
    for (let i = 0; i < 5; i += 1) expect((await app.request('/v1/thing', { method: 'OPTIONS' })).status).toBe(204);
    expect((await app.request('/v1/thing')).status).toBe(200);
  });

  it('holds one budget across a wall-clock minute boundary', async () => {
    // The window is anchored to the request that opened it. Aligning it to the
    // wall-clock minute instead clears every bucket at the boundary, which lets
    // a burst straddling it spend a one-write budget twice inside 60 seconds.
    let now = Date.parse('2026-09-15T00:00:59.995Z');
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 100, writePerMinute: 1 }, () => now));
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);

    now += 10; // 00:01:00.005 — the next wall-clock minute, same 60-second span
    const straddling = await app.request('/v1/thing', { method: 'POST' });
    expect(straddling.status).toBe(429);
    expect(Number(straddling.headers.get('Retry-After'))).toBe(60);

    now += 59_990; // 00:01:59.995 — exactly WINDOW_MS after the window opened
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);
  });

  it('reports Retry-After as the window the caller is inside', async () => {
    const now = Date.parse('2026-09-15T00:00:30.000Z');
    const app = appWith(createInboundRateLimiter({ enabled: true, readPerMinute: 100, writePerMinute: 1 }, () => now));
    expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);

    const throttled = await app.request('/v1/thing', { method: 'POST' });
    expect(throttled.status).toBe(429);
    // The caller's own window still has a full minute to run; the minute
    // boundary is 30s away and is not what it is waiting for.
    expect(Number(throttled.headers.get('Retry-After'))).toBe(60);
  });

  it('bypasses all counting while disabled', async () => {
    const app = appWith(createInboundRateLimiter({ enabled: false, readPerMinute: 1, writePerMinute: 1 }, () => T0));
    for (let i = 0; i < 5; i += 1) expect((await app.request('/v1/thing', { method: 'POST' })).status).toBe(200);
  });
});
