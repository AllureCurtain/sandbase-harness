/**
 * Primary thread — PR 3.1.
 *
 * Covers the migration back-fill (every existing session gains one primary
 * thread row, every pre-thread event gains its `thread_id`), the store's
 * read/write helpers, and the thread-status events a single-agent session
 * emits around the lifecycle the session has always published.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import {
  primaryThreadIdForSession,
  SessionThreadStore,
} from '@/core/session/session-threads.js';
import { MIGRATIONS } from '@/core/db/migrations.js';

describe('session primary thread', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-thread-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('migration 062', () => {
    it('back-fills a primary thread row and thread_id for sessions and events that predate it', () => {
      // Recreate the pre-062 world: run every migration except the threads one,
      // write a session plus an event the old schema produced, then apply 062.
      // The rows are written by hand rather than through `SessionManager.create`,
      // which on this build already knows it owes a thread row a schema that
      // does not have the table for it.
      const legacy = new Database(join(tmpDir, 'legacy.db'));
      try {
        legacy.runMigrations(MIGRATIONS.filter((m) => m.version < 62));
        legacy.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
        legacy.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'test-agent', '{}')`);
        const sessionId = 'sess_legacy1';
        legacy.prepare(`
          INSERT INTO sessions (
            id, agent_id, agent_name, agent_version, agent_definition, loop_engine,
            environment_id, status, title, context_id, resources, vault_ids, metadata, budget
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId, 'agent_test', 'test-agent', 1, null, 'builtin',
          'env_default', null, null, '[]', '[]', null, null,
        );
        legacy.prepare(`
          INSERT INTO events (id, session_id, seq, type, content, metadata, processed_at)
          VALUES ('sevt_l1', ?, 1, 'user.message', '[{"type":"text","text":"hello"}]', '{}', '2026-10-01T00:00:00.000Z')
        `).run(sessionId);
        legacy.prepare(`
          INSERT INTO events (id, session_id, seq, type, content, metadata, processed_at)
          VALUES ('sevt_l2', ?, 2, 'agent.message', '[{"type":"text","text":"hi there"}]', '{}', '2026-10-01T00:00:01.000Z')
        `).run(sessionId);

        legacy.runMigrations(MIGRATIONS.filter((m) => m.version === 62));

        const store = new SessionThreadStore(legacy);
        const threads = store.listBySession(sessionId);
        expect(threads).toHaveLength(1);
        const primary = threads[0]!;
        expect(primary.id).toBe(primaryThreadIdForSession(sessionId));
        expect(primary.parentThreadId).toBeNull();
        expect(primary.agentName).toBe('test-agent');
        expect(primary.sessionId).toBe(sessionId);

        // Every pre-thread event carries the primary thread id — the back-fill
        // claims them for the primary stream rather than leaving them unowned.
        const rows = legacy
          .prepare(`SELECT thread_id, cross_posted FROM events WHERE session_id = ? ORDER BY seq`)
          .all(sessionId) as Array<{ thread_id: string | null; cross_posted: number }>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.thread_id).toBe(primary.id);
          expect(row.cross_posted).toBe(0);
        }
      } finally {
        legacy.close();
      }
    });
  });

  describe('create', () => {
    it('creates the primary thread row with the session', () => {
      const session = manager.create({ agent: 'agent_test' });
      const threads = manager.getThreadStore().listBySession(session.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]!.id).toBe(`sth_${session.id.replace(/^sess_/, '')}`);
      expect(threads[0]!.parentThreadId).toBeNull();
      expect(threads[0]!.status).toBe('queued');
    });
  });

  describe('thread status events', () => {
    it('emits session.thread_status_running then session.status_running when a turn starts', async () => {
      const execute = vi.fn(async function* () {});
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'hi' }],
      });
      await vi.waitFor(() => expect(manager.get(session.id)!.status).toBe('paused'));

      const events = manager.getEventLogger().getEvents(session.id);
      const types = events.map((e) => e.type);
      const threadRunning = types.indexOf('session.thread_status_running');
      const sessionRunning = types.indexOf('session.status_running');
      expect(threadRunning).toBeGreaterThan(-1);
      expect(sessionRunning).toBeGreaterThan(-1);
      // The thread event precedes the session-level aggregate it caused.
      expect(threadRunning).toBeLessThan(sessionRunning);

      const primaryId = primaryThreadIdForSession(session.id);
      const running = events[threadRunning]!;
      expect(running.threadId).toBe(primaryId);
      expect(running.metadata?.session_thread_id).toBe(primaryId);
      expect(running.metadata?.agent_name).toBe('test-agent');

      // Every event the turn produced names the primary thread.
      for (const event of events) {
        expect(event.threadId).toBe(primaryId);
      }
    });

    it('emits session.thread_status_idle around the session-level idle pair', async () => {
      const execute = vi.fn(async function* (session: { id: string }) {
        manager.getEventLogger().append(session.id, {
          type: 'agent.message',
          content: [{ type: 'text', text: 'done' }],
        });
      });
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'hi' }],
      });
      await vi.waitFor(() => expect(manager.get(session.id)!.status).toBe('paused'));

      const types = manager.getEventLogger().getEvents(session.id).map((e) => e.type);
      const threadIdle = types.indexOf('session.thread_status_idle');
      const usage = types.indexOf('session.usage');
      const sessionIdle = types.indexOf('session.status_idle');
      // The contract's ordering: thread event first, then `session.usage`
      // immediately before the session-level `session.status_idle`.
      expect(threadIdle).toBeGreaterThan(-1);
      expect(usage).toBe(sessionIdle - 1);
      expect(threadIdle).toBeLessThan(usage);
    });

    it('single-thread event sequence matches the pre-thread sequence plus the new thread events', async () => {
      // The regression the design doc demands: a single-agent session produces
      // exactly the events it produced before threads — interleaved only with
      // `session.thread_status_*` rows.
      const execute = vi.fn(async function* (session: { id: string }) {
        manager.getEventLogger().append(session.id, {
          type: 'agent.message',
          content: [{ type: 'text', text: 'pong' }],
        });
      });
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'ping' }],
      });
      await vi.waitFor(() => expect(manager.get(session.id)!.status).toBe('paused'));

      const types = manager.getEventLogger().getEvents(session.id).map((e) => e.type);
      const withoutThreadEvents = types.filter((t) => !t.startsWith('session.thread_'));
      expect(withoutThreadEvents).toEqual([
        'user.message',
        'session.status_running',
        'agent.message',
        'session.usage',
        'session.status_idle',
      ]);
      // And the thread events that were added: running before the session's
      // running, idle before the session's usage+idle close.
      expect(types.filter((t) => t === 'session.thread_status_running')).toHaveLength(1);
      expect(types.filter((t) => t === 'session.thread_status_idle')).toHaveLength(1);
    });
  });

  describe('primary stream', () => {
    it('getPrimaryEvents returns every event a single-thread session wrote', async () => {
      const execute = vi.fn(async function* (session: { id: string }) {
        manager.getEventLogger().append(session.id, {
          type: 'agent.message',
          content: [{ type: 'text', text: 'ok' }],
        });
      });
      manager.setExecutor({ execute });
      const session = manager.create({ agent: 'agent_test' });
      await manager.sendEvent(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'go' }],
      });
      await vi.waitFor(() => expect(manager.get(session.id)!.status).toBe('paused'));

      const all = manager.getEventLogger().getEvents(session.id);
      const primary = manager.getEventLogger().getPrimaryEvents(session.id);
      expect(primary.map((e) => e.id)).toEqual(all.map((e) => e.id));
    });

    it('getThreadEvents scopes to the thread and respects afterSeq', async () => {
      const session = manager.create({ agent: 'agent_test' });
      const primaryId = primaryThreadIdForSession(session.id);
      manager.getEventLogger().append(session.id, {
        type: 'user.message',
        content: [{ type: 'text', text: 'a' }],
      });
      manager.getEventLogger().append(session.id, {
        type: 'agent.message',
        content: [{ type: 'text', text: 'b' }],
      });

      const threadEvents = manager.getEventLogger().getThreadEvents(session.id, primaryId);
      expect(threadEvents).toHaveLength(2);
      const after = manager.getEventLogger().getThreadEvents(session.id, primaryId, threadEvents[0]!.seq);
      expect(after.map((e) => e.seq)).toEqual([2]);
      // A different thread id sees none of this thread's rows.
      expect(manager.getEventLogger().getThreadEvents(session.id, 'sth_other')).toHaveLength(0);
    });
  });

  describe('session delete', () => {
    it('deleting a session removes its thread rows (session_id table discovery)', async () => {
      const session = manager.create({ agent: 'agent_test' });
      expect(manager.getThreadStore().listBySession(session.id)).toHaveLength(1);
      await manager.delete(session.id);
      expect(manager.getThreadStore().listBySession(session.id)).toHaveLength(0);
    });
  });

  describe('primary/session drift', () => {
    // A crash can leave `sessions.status` ahead of a thread row nothing ran
    // (the recovery tests raw-write `status='running'` while the primary stays
    // `queued`). Recovery calls `updateStatus('paused')`, which the thread row
    // cannot reach from `queued` — and that refusal must not deadlock the
    // session row it is trying to reset. The primary is reconciled to the
    // target the session row already names.
    it('re-syncs the primary thread and session row when recovery resets a drifted status', () => {
      const session = manager.create({ agent: 'agent_test' });
      db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
      const primaryId = manager.primaryThreadId(session.id);
      expect(manager.getThreadStore().get(primaryId)!.status).toBe('queued');

      manager.reconcileOrphans();

      expect(manager.get(session.id)!.status).toBe('paused');
      expect(manager.getThreadStore().get(primaryId)!.status).toBe('paused');
    });
  });
});
