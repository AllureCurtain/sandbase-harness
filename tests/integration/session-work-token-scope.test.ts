/**
 * Integration test: the session work token's authority beyond the Work API.
 *
 * A `mawt_...` bearer — the `sessions_token` inside a claimed item's `secret` —
 * authenticates the session-level calls a self-hosted worker makes: its own
 * session's retrieve and event surface, and the memory stores that session
 * attached (writes included, unless the attachment is `read_only`). These
 * assertions pin the fence around that grant: another session's routes, an
 * unattached store, a non-answer event type, and every endpoint outside the
 * worker's scope all refuse, and the token dies with its session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { WorkQueue } from '@/sandbox/self-hosted-provider.js';
import { createServer } from '@/api/server.js';
import { issueSessionWorkToken } from '@/core/auth/session-work-tokens.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA, CMA_AGENT_MEMORY_BETA } from '@/core/cma/compatibility.js';

const HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};
const API_KEY = 'test-api-key';

describe('Session work token scope', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let token: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-swts-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO memory_stores (id, name) VALUES ('memstore_a', 'store a'), ('memstore_b', 'store b'), ('memstore_ro', 'store ro')").run();
    db.prepare("INSERT INTO memory_records (id, store_id, path, content) VALUES ('mem_1', 'memstore_a', '/notes/a.md', 'alpha')").run();
    db.prepare("INSERT INTO memory_records (id, store_id, path, content) VALUES ('mem_ro1', 'memstore_ro', '/notes/ro.md', 'readonly')").run();
    // sess_a attaches store a read/write and store ro read-only; sess_b owns
    // the unattached store the token must never reach.
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES (
        'sess_a', 'agent_x', 'x', 'env_a',
        '[{"type":"memory_store","memory_store_id":"memstore_a","mount_path":"/mnt/memory/a"},
          {"type":"memory_store","memory_store_id":"memstore_ro","mount_path":"/mnt/memory/ro","access":"read_only"}]',
        'paused'
      )`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_name, environment_id, resources, status) VALUES (
        'sess_b', 'agent_x', 'x', 'env_a',
        '[{"type":"memory_store","memory_store_id":"memstore_b","mount_path":"/mnt/memory/b"}]',
        'paused'
      )`,
    ).run();

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      apiKeys: [API_KEY],
      workQueue: new WorkQueue(db),
    });
    token = issueSessionWorkToken(db, 'sess_a', 'env_a');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function call(path: string, init: RequestInit = {}, credential: string | null = token) {
    return app.request(path, {
      ...init,
      headers: {
        ...HEADERS,
        // The memory family admits its own beta, exactly as the worker's SDK
        // memory client sends it.
        ...(path.includes('/memory_stores/') ? { 'anthropic-beta': CMA_AGENT_MEMORY_BETA } : {}),
        ...(init.headers as Record<string, string> | undefined),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
    });
  }

  it('authenticates the session retrieve, event list, and stream for its own session', async () => {
    const retrieve = await call('/v1/sessions/sess_a');
    expect(retrieve.status).toBe(200);
    const session = await retrieve.json() as { id: string; resources: Array<Record<string, unknown>> };
    expect(session.id).toBe('sess_a');
    // The worker reads `resources` to learn which stores to materialize.
    expect(session.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_a' }),
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_ro', access: 'read_only' }),
    ]));

    expect((await call('/v1/sessions/sess_a/events')).status).toBe(200);
    const stream = await call('/v1/sessions/sess_a/events/stream');
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();
  });

  it('refuses the other session entirely, even on the same route names', async () => {
    for (const path of ['/v1/sessions/sess_b', '/v1/sessions/sess_b/events', '/v1/sessions/sess_b/events/stream']) {
      const res = await call(path);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    }
    const res = await call('/v1/memory_stores/memstore_b/memories');
    expect(res.status).toBe(401);
  });

  it('lists and reads memories on an attached store, and writes when the attachment is read_write', async () => {
    const list = await call('/v1/memory_stores/memstore_a/memories?view=full');
    expect(list.status).toBe(200);
    const page = await list.json() as { data: Array<{ id: string; content?: string }> };
    expect(page.data[0]).toMatchObject({ id: 'mem_1', content: 'alpha' });

    expect((await call('/v1/memory_stores/memstore_a/memories/mem_1?view=full')).status).toBe(200);

    const created = await call('/v1/memory_stores/memstore_a/memories', {
      method: 'POST',
      body: JSON.stringify({ path: '/notes/new.md', content: 'synced up' }),
    });
    expect(created.status).toBe(201);
    const memory = await created.json() as { id: string };
    expect(memory.id).toMatch(/^mem_/);

    expect((await call('/v1/memory_stores/memstore_a/memories/mem_1', {
      method: 'POST',
      body: JSON.stringify({ content: 'alpha v2' }),
    })).status).toBe(200);

    const removed = await call('/v1/memory_stores/memstore_a/memories/mem_1', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { type: string }).type).toBe('memory_deleted');
  });

  it('refuses writes on a read-only attachment with 403 while reads pass', async () => {
    expect((await call('/v1/memory_stores/memstore_ro/memories')).status).toBe(200);
    expect((await call('/v1/memory_stores/memstore_ro/memories/mem_ro1?view=full')).status).toBe(200);

    for (const init of [
      { method: 'POST', body: JSON.stringify({ path: '/notes/x.md', content: 'x' }) },
    ] as const) {
      const res = await call('/v1/memory_stores/memstore_ro/memories', init);
      expect(res.status).toBe(403);
      expect((await res.json() as { error: { type: string } }).error.type).toBe('permission_error');
    }
    const update = await call('/v1/memory_stores/memstore_ro/memories/mem_ro1', {
      method: 'POST',
      body: JSON.stringify({ content: 'tampered' }),
    });
    expect(update.status).toBe(403);
    const del = await call('/v1/memory_stores/memstore_ro/memories/mem_ro1', { method: 'DELETE' });
    expect(del.status).toBe(403);
    // Nothing was written: the record still reads back its original content.
    const row = db.prepare('SELECT content FROM memory_records WHERE id = ?').get('mem_ro1') as { content: string };
    expect(row.content).toBe('readonly');
  });

  it('posts only tool-answer events, refusing steer/message/outcome with 403', async () => {
    const steer = await call('/v1/sessions/sess_a/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.steer', content: [{ type: 'text', text: 'x' }], idempotency_key: 'k' }] }),
    });
    expect(steer.status).toBe(403);
    expect((await steer.json() as { error: { type: string } }).error.type).toBe('permission_error');

    const message = await call('/v1/sessions/sess_a/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }] }),
    });
    expect(message.status).toBe(403);

    // A tool-answer type passes the fence and reaches event validation — the
    // 400 says "no pending call", which is the log's answer, not the scope's.
    const answer = await call('/v1/sessions/sess_a/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.custom_tool_result', custom_tool_use_id: 'nope', content: [{ type: 'text', text: 'done' }] }] }),
    });
    expect(answer.status).toBe(400);
    expect((await answer.json() as { error: { message: string } }).error.message).toContain('custom tool');
  });

  it('refuses every endpoint outside the worker scope and never masquerades as an API key', async () => {
    for (const path of ['/v1/agents', '/v1/memory_stores', '/v1/memory_stores/memstore_a', '/v1/environments/env_a']) {
      const res = await call(path);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    }
    // Even the memory family is fenced to the `memories` subresource.
    expect((await call('/v1/memory_stores/memstore_a/memory_versions')).status).toBe(401);
    // An unknown `mawt_` value is a bad credential, not an anonymous one.
    expect((await call('/v1/sessions/sess_a', {}, 'mawt_forged')).status).toBe(401);
    // Missing credential is still refused — the token does not lower the gate.
    expect((await call('/v1/sessions/sess_a', {}, null)).status).toBe(401);
  });

  it('stops authenticating the moment its session ends', async () => {
    expect((await call('/v1/sessions/sess_a')).status).toBe(200);
    db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = 'sess_a'").run();
    const res = await call('/v1/sessions/sess_a');
    expect(res.status).toBe(401);
    expect((await call('/v1/memory_stores/memstore_a/memories')).status).toBe(401);
  });

  it('leaves the API key with the full surface, including what the token may not reach', async () => {
    const res = await call('/v1/agents', {}, API_KEY);
    expect(res.status).toBe(200);
    expect((await call('/v1/sessions/sess_b', {}, API_KEY)).status).toBe(200);
    expect((await call('/v1/memory_stores/memstore_b/memories', {}, API_KEY)).status).toBe(200);
    // The API key is not fenced to tool-answer events.
    const send = await call('/v1/sessions/sess_a/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ type: 'user.steer', content: [{ type: 'text', text: 'x' }], idempotency_key: 'k' }] }),
    }, API_KEY);
    expect(send.status).not.toBe(403);
  });
});
