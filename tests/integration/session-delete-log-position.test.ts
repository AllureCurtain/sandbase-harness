/**
 * Integration test: where the delete marker sits in the retained log.
 *
 * `api.test.ts:2893` already asserts that a deleted session's log stays queryable
 * and that it *contains* a `session.deleted` event. `toContain` is the weakest
 * form of that claim: it passes if the marker were the first event, if it were
 * duplicated, or if every event that preceded the delete had been dropped, since
 * a log holding only the marker still contains it.
 *
 * `SessionManager.delete()` (`session-manager.ts:1064-1078`) appends the marker
 * after draining the run chain, so what the append-only guarantee actually
 * promises is stronger: the retained log is **the pre-delete log, in order,
 * followed by exactly one marker**. That is what a client replaying after a
 * delete reads, and it is what makes the log usable as history rather than as a
 * tombstone.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';

describe('Session deletion and the retained event log', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-delete-log-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_delete',
      'delete',
      JSON.stringify({ name: 'delete', model: 'gpt-4o', system: 'p' }),
    );
    const sessionManager = new SessionManager(db, undefined, 'pi', undefined, (engine) => engine === 'builtin' || engine === 'pi');
    sessionManager.setExecutor({
      async *execute(session: Session, _event: UserEvent): AsyncIterable<SessionEvent> {
        yield {
          id: 'sevt_fake_agent_message',
          sessionId: session.id,
          seq: 0,
          type: 'agent.message',
          content: [{ type: 'text', text: 'echo' }],
          createdAt: new Date(),
        };
      },
    });
    return createServer({ db, sessionManager, agents: [], reloadAgents: () => ({ agents: [], errors: [] }), consoleRoot: null });
  }

  async function sessionWithEvents(server: ReturnType<typeof createServer>, count: number): Promise<string> {
    const created = await server.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_delete' }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    if (count > 0) {
      const appended = await server.request(`/v1/sessions/${id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: Array.from({ length: count }, () => ({ type: 'user.interrupt' })) }),
      });
      expect(appended.status).toBe(200);
    }
    return id;
  }

  async function events(server: ReturnType<typeof createServer>, id: string, query = ''): Promise<any> {
    const res = await server.request(`/v1/sessions/${id}/events${query}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  it('records the termination and then the deletion, after the events that were already there', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 2);
    const before = await events(server, id);
    expect(before.data.map((event: { type: string }) => event.type)).toEqual(['user.interrupt', 'user.interrupt']);

    const del = await server.request(`/v1/sessions/${id}`, { method: 'DELETE' });

    expect(del.status).toBe(200);
    const after = await events(server, id);
    // Position, not just presence: the pre-delete events keep their place, the
    // delete's own lifecycle change is recorded before the deletion, and the
    // marker is last. `toContain` alone would accept a log holding nothing but
    // the marker.
    //
    // Two new events rather than one, because `delete()` is not a single writer:
    // it moves the session to a terminal status through `updateStatus`, which
    // logs `session.status_terminated`, and then appends `session.deleted`
    // itself. A client replaying the log reads the lifecycle transition and then
    // the deletion, so the ordering is asserted exactly.
    expect(after.data.map((event: { type: string }) => event.type)).toEqual([
      'user.interrupt',
      'user.interrupt',
      'session.status_terminated',
      'session.deleted',
    ]);
    expect(after.data.slice(0, 2).map((event: { id: string }) => event.id)).toEqual(
      before.data.map((event: { id: string }) => event.id),
    );
  });

  it('keeps the retained log walkable by cursor after the delete', async () => {
    const server = setUp();
    const id = await sessionWithEvents(server, 3);
    await server.request(`/v1/sessions/${id}`, { method: 'DELETE' });
    const whole = await events(server, id);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const query = cursor === null ? '?limit=2' : `?limit=2&page=${encodeURIComponent(cursor)}`;
      const page = await events(server, id, query);
      walked.push(...page.data.map((event: { id: string }) => event.id));
      cursor = page.next_page;
      if (cursor === null) break;
    }

    // The retained log is still one ordered collection, not a tail that only the
    // unpaginated read can see: three events, the termination, and the deletion.
    expect(walked).toEqual(whole.data.map((event: { id: string }) => event.id));
    expect(walked).toHaveLength(5);
  });
});
