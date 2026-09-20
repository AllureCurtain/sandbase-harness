/**
 * Memory rules — route wiring.
 *
 * `memory-semantics.test.ts` proves the checks behave. It cannot prove the routes
 * call them: a route that ignored every cap would leave that suite green. These
 * tests drive the routes and assert on what the API answers.
 */

import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { memoryStoreRoutes } from '@/api/routes/memory-stores.js';
import type { ServerDeps } from '@/api/server.js';

// Mounted without the CMA admission middleware, so the compatibility headers
// are not part of this boundary. What is under test is the route's own
// enforcement of the published rules.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('memory rules at the route boundary', () => {
  let db: Database;
  let app: Hono;
  let tmpDir: string;
  let storeId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memsem-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    app = new Hono();
    app.route('/v1', memoryStoreRoutes({ db } as unknown as ServerDeps));
    const created = await awaitJson('POST', '/v1/memory_stores', { name: 'notes' });
    expect(created.status).toBe(201);
    storeId = created.body.id as string;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function awaitJson(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: JSON_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  it('refuses content over the 100 kB cap and names both sizes', async () => {
    const atLimit = 'a'.repeat(100 * 1024);
    const ok = await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, {
      path: '/big.txt',
      content: atLimit,
    });
    expect(ok.status).toBe(201);

    const over = await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, {
      path: '/bigger.txt',
      content: atLimit + 'a',
    });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('memory_too_large');
    expect(over.body.error.message).toContain('102400');
    expect(over.body.error.message).toContain('102401');
  });

  it('measures multi-byte content in bytes, not characters', async () => {
    // 60,000 two-byte characters is 120,000 bytes: over the cap in bytes, under it
    // in characters, so a character-based check would accept it.
    const res = await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, {
      path: '/wide.txt',
      content: '中'.repeat(60_000),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('memory_too_large');
  });

  it('rejects a path_prefix without a trailing slash', async () => {
    const res = await app.request(`/v1/memory_stores/${storeId}/memories?path_prefix=/notes`, { headers: JSON_HEADERS });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.message).toContain('path_prefix');
  });

  it('rejects a depth other than 0 or 1', async () => {
    const res = await app.request(`/v1/memory_stores/${storeId}/memories?depth=2`, { headers: JSON_HEADERS });
    expect(res.status).toBe(400);
  });

  it('does not select a sibling directory that shares a string prefix', async () => {
    await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, { path: '/notes-archive/x.txt', content: 'sibling' });
    await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, { path: '/notes/y.txt', content: 'child' });

    const res = await app.request(`/v1/memory_stores/${storeId}/memories?path_prefix=/notes/&depth=1`, { headers: JSON_HEADERS });
    const body = await res.json() as any;
    expect(body.data.map((entry: any) => entry.path)).toEqual(['/notes/y.txt']);
  });

  it('refuses a stale content_sha256 precondition and reports the current hash', async () => {
    const created = await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, {
      path: '/doc.txt',
      content: 'first',
    });
    const stale = '0000000000000000000000000000000000000000000000000000000000000000';

    const refused = await awaitJson('PUT', `/v1/memory_stores/${storeId}/memories/${created.body.id}`, {
      content: 'second',
      precondition: { type: 'content_sha256', content_sha256: stale },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('precondition_failed');
    expect(refused.body.error.current_content_sha256).toMatch(/^[0-9a-f]{64}$/);

    const applied = await awaitJson('PUT', `/v1/memory_stores/${storeId}/memories/${created.body.id}`, {
      content: 'second',
      precondition: { type: 'content_sha256', content_sha256: refused.body.error.current_content_sha256 },
    });
    expect(applied.status).toBe(200);
  });

  it('refuses an unknown precondition type rather than ignoring it', async () => {
    const created = await awaitJson('POST', `/v1/memory_stores/${storeId}/memories`, {
      path: '/doc.txt',
      content: 'first',
    });
    const res = await awaitJson('PUT', `/v1/memory_stores/${storeId}/memories/${created.body.id}`, {
      content: 'second',
      precondition: { type: 'if_match' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invalid_precondition');
  });
});
