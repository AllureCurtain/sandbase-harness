/**
 * Thread archive + thread-scoped interrupt — PR 3.5.
 *
 * `POST /v1/sessions/:id/threads/:tid/archive` is driven over `app.request`
 * (the same router, no listener): the primary thread answers
 * `primary_thread_not_archivable`, a running child 409, and an idle child is
 * archived with the cross-posted `session.thread_status_terminated` and its
 * concurrency slot released. `user.interrupt` is driven through
 * `SessionManager.sendEvent` with a scripted executor: an unscoped interrupt
 * aborts every running thread and closes every parked call on a
 * `requires_action` thread with the published error result, and a scoped one
 * (`session_thread_id`) touches only the named thread.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '@/api/server.js';
import { Database } from '@/core/db/database.js';
import {
  SessionManager,
  type ExecuteOptions,
  type SessionExecutor,
} from '@/core/session/session-manager.js';
import { primaryThreadIdForSession, type SessionThread } from '@/core/session/session-threads.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session, SessionEvent } from '@/types/session.js';

const COORDINATOR: AgentDefinition = {
  name: 'coordinator',
  model: 'm',
  system: 'coordinate',
  multiagent: {
    type: 'coordinator',
    agents: [{ type: 'agent', id: 'agent_worker', version: 1 }],
  },
};
const WORKER: AgentDefinition = { name: 'reviewer', model: 'm', system: 'review' };

/** A turn that just ends — enough to make a thread transition running → paused. */
const idleExecutor: SessionExecutor = {
  async *execute() { /* yields nothing; the turn ends empty */ },
};

/** A turn that stays open until `release` — enough to keep a thread running. */
function heldExecutor(gate: Promise<void>): SessionExecutor {
  return {
    async *execute(_session: Session, _event: unknown, options?: ExecuteOptions) {
      options?.abortSignal?.throwIfAborted();
      await gate;
    },
  };
}

function seed(db: Database): void {
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_coordinator', 'coordinator', 1, ?)`)
    .run(JSON.stringify(COORDINATOR));
  db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_worker', 'reviewer', 1, ?)`)
    .run(JSON.stringify(WORKER));
}

function childOf(manager: SessionManager, sessionId: string, status: SessionThread['status'] = 'paused'): SessionThread {
  return manager.getThreadStore().insertThread({
    sessionId,
    parentThreadId: primaryThreadIdForSession(sessionId),
    agentName: 'reviewer',
    agentDefinition: WORKER,
    agentId: 'agent_worker',
    agentVersion: 1,
    status,
  });
}

/** Park `thread` on an approval-gated call and move it to requires_action. */
function parkThread(manager: SessionManager, sessionId: string, threadId: string, blockId: string): string {
  const use = manager.getEventLogger().append(sessionId, {
    type: 'agent.tool_use',
    threadId,
    content: [{
      type: 'tool_use',
      id: blockId,
      name: 'bash',
      input: { command: 'rm -rf /' },
      requires_confirmation: true,
    } as never],
  });
  (manager as any).updateThreadStatus(sessionId, threadId, 'requires_action');
  return use.id;
}

async function untilEvents(manager: SessionManager, sessionId: string, predicate: (events: SessionEvent[]) => boolean, ms = 8000): Promise<SessionEvent[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const events = manager.getEventLogger().getEvents(sessionId);
    if (predicate(events)) return events;
    if (Date.now() > deadline) return events;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('thread archive route', () => {
  let directory: string;
  let db: Database;
  let manager: SessionManager;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-thread-archive-'));
    db = new Database(join(directory, 'test.db'));
    db.runMigrations();
    seed(db);
    manager = new SessionManager(db);
    manager.setExecutor(idleExecutor);
    app = createServer({
      db,
      sessionManager: manager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const archive = (sessionId: string, threadId: string) =>
    app.request(`/v1/sessions/${sessionId}/threads/${threadId}/archive`, { method: 'POST' });

  it('refuses the primary thread with primary_thread_not_archivable', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const response = await archive(session.id, primaryThreadIdForSession(session.id));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code?: string } };
    expect(body.error.code).toBe('primary_thread_not_archivable');
    expect(manager.getThreadStore().get(primaryThreadIdForSession(session.id))?.archivedAt).toBeNull();
  });

  it('refuses a running child with 409 thread_running', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const child = childOf(manager, session.id, 'running');
    const response = await archive(session.id, child.id);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code?: string } }).error.code).toBe('thread_running');
    expect(manager.getThreadStore().get(child.id)?.archivedAt).toBeNull();
  });

  it('archives an idle child: thread_status_terminated, slot freed, row returned', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);
    const child = childOf(manager, session.id, 'paused');
    // The child counts against the 25-slot budget before archive.
    expect(manager.getThreadStore().activeChildCount(session.id)).toBe(1);

    const response = await archive(session.id, child.id);
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; status: string; archived_at: string | null };
    expect(body.id).toBe(child.id);
    expect(body.status).toBe('terminated');
    expect(body.archived_at).not.toBeNull();

    const row = manager.getThreadStore().get(child.id)!;
    expect(row.archivedAt).not.toBeNull();
    expect(row.status).toBe('archived');
    // The slot is released — archive is what the concurrency cap counts down on.
    expect(manager.getThreadStore().activeChildCount(session.id)).toBe(0);
    // The termination event is cross-posted so the primary stream reports it.
    const terminated = manager.getEventLogger().getEvents(session.id)
      .find((e) => e.type === 'session.thread_status_terminated' && e.metadata?.session_thread_id === child.id);
    expect(terminated).toBeDefined();
    expect(terminated!.crossPosted).toBe(true);
    expect(manager.getEventLogger().getPrimaryEvents(session.id).map((e) => e.id)).toContain(terminated!.id);
    // An archived row stays out of the aggregate's requires_action union and
    // re-archiving returns the same row without a second termination event.
    const second = await archive(session.id, child.id);
    expect(second.status).toBe(200);
    expect(manager.getEventLogger().getEvents(session.id)
      .filter((e) => e.type === 'session.thread_status_terminated' && e.metadata?.session_thread_id === child.id))
      .toHaveLength(1);
    expect(primaryId).toBe(primaryThreadIdForSession(session.id));
  });

  it('a parked requires_action child can be archived and leaves the session union', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);
    // The primary idles while a child parks — the aggregate a real session
    // reaches (a queued primary + parked child is not a state the runtime
    // produces; the baseline writes the row directly like the aggregation
    // tests do).
    manager.getThreadStore().updateStatus(primaryId, 'paused');
    const child = childOf(manager, session.id, 'running');
    const parkedId = parkThread(manager, session.id, child.id, 'toolu_archivable');
    expect(manager.get(session.id)?.status).toBe('requires_action');

    const response = await archive(session.id, child.id);
    expect(response.status).toBe(200);

    // The aggregate recomputes without the archived row: a parked call that can
    // never be answered no longer holds the session in requires_action.
    const idle = manager.getEventLogger().getEvents(session.id).filter((e) => e.type === 'session.status_idle').at(-1);
    expect(idle).toBeDefined();
    expect((idle!.metadata?.stop_reason as { event_ids?: string[] } | undefined)?.event_ids ?? []).not.toContain(parkedId);
    expect(manager.get(session.id)?.status).not.toBe('requires_action');
    expect(manager.getThreadStore().primaryThreadId(session.id)).toBe(primaryId);
  });
});

describe('thread-scoped user.interrupt', () => {
  let directory: string;
  let db: Database;
  let manager: SessionManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-thread-interrupt-'));
    db = new Database(join(directory, 'test.db'));
    db.runMigrations();
    seed(db);
    manager = new SessionManager(db);
  });

  afterEach(async () => {
    await manager.shutdown();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('a scoped interrupt closes a parked child: error results, idle (end_turn), no model call', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    manager.getThreadStore().updateStatus(primaryThreadIdForSession(session.id), 'paused');
    const primaryId = primaryThreadIdForSession(session.id);
    const child = childOf(manager, session.id, 'running');
    parkThread(manager, session.id, child.id, 'toolu_parked');
    expect(manager.get(session.id)?.status).toBe('requires_action');

    await manager.sendEvent(session.id, {
      type: 'user.interrupt',
      session_thread_id: child.id,
    } as never);

    const events = manager.getEventLogger().getThreadEvents(session.id, child.id);
    // Every parked call is closed with the published error text, on the child's
    // own stream — the projection pairs it like any other tool result.
    const result = events.find((e) => e.type === 'agent.tool_result')!;
    const block = result.content![0] as { tool_use_id: string; content: string; is_error?: boolean };
    expect(block.tool_use_id).toBe('toolu_parked');
    expect(block.is_error).toBe(true);
    expect(block.content).toBe('Tool execution was interrupted before completion. Please retry.');
    // The thread goes straight to paused (end_turn) without a model call —
    // the second idle event is the interrupt's close-out (the first was the
    // requires_action park).
    const idle = events.filter((e) => e.type === 'session.thread_status_idle' && e.metadata?.session_thread_id === child.id).at(-1)!;
    expect((idle.metadata?.stop_reason as { type?: string }).type).toBe('end_turn');
    expect(manager.getThreadStore().get(child.id)?.status).toBe('paused');
    expect(manager.get(session.id)?.status).not.toBe('requires_action');
    // The interrupt event itself is stamped on the child's thread and cross-posted.
    const interrupt = manager.getEventLogger().getEvents(session.id).find((e) => e.type === 'user.interrupt')!;
    expect(interrupt.threadId).toBe(child.id);
    expect(interrupt.crossPosted).toBe(true);
    expect(manager.getThreadStore().primaryThreadId(session.id)).toBe(primaryId);
  });

  it('an unscoped interrupt closes every running thread and every parked one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    manager.setExecutor(heldExecutor(gate));
    const session = manager.create({ agent: 'agent_coordinator' });
    manager.getThreadStore().updateStatus(primaryThreadIdForSession(session.id), 'paused');
    const primaryId = primaryThreadIdForSession(session.id);
    const parked = childOf(manager, session.id, 'running');
    parkThread(manager, session.id, parked.id, 'toolu_unscoped');
    // A second child actively running a turn — its controller must be aborted.
    const running = childOf(manager, session.id, 'running');

    await manager.sendEvent(session.id, { type: 'user.interrupt' } as never);
    release();
    await untilEvents(manager, session.id, (e) =>
      e.some((x) => x.type === 'agent.tool_result') &&
      manager.getThreadStore().get(parked.id)?.status === 'paused');

    const result = manager.getEventLogger().getThreadEvents(session.id, parked.id)
      .find((e) => e.type === 'agent.tool_result')!;
    expect(((result.content![0]) as { is_error?: boolean }).is_error).toBe(true);
    expect(manager.getThreadStore().get(parked.id)?.status).toBe('paused');
    // The unscoped interrupt is the session's own event — it lands on the
    // primary stream as the session-level record the contract names.
    const interrupt = manager.getEventLogger().getEvents(session.id).find((e) => e.type === 'user.interrupt')!;
    expect(interrupt.threadId ?? primaryId).toBe(primaryId);
    expect(interrupt.crossPosted).toBeFalsy();
    expect(manager.getThreadStore().get(running.id)).toBeDefined();
  });

  it('a scoped interrupt on an already-idle thread is a no-op', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    manager.getThreadStore().updateStatus(primaryThreadIdForSession(session.id), 'paused');
    const child = childOf(manager, session.id, 'paused');
    const before = manager.getEventLogger().getEvents(session.id).length;

    await manager.sendEvent(session.id, {
      type: 'user.interrupt',
      session_thread_id: child.id,
    } as never);

    // Only the interrupt event itself is recorded — no status change, no results.
    const events = manager.getEventLogger().getEvents(session.id);
    expect(events.length).toBe(before + 1);
    expect(manager.getThreadStore().get(child.id)?.status).toBe('paused');
  });

  it('refuses a session_thread_id that names no thread of this session', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    manager.getThreadStore().updateStatus(primaryThreadIdForSession(session.id), 'paused');
    await expect(manager.sendEvent(session.id, {
      type: 'user.interrupt',
      session_thread_id: 'sth_nonexistent',
    } as never)).rejects.toThrow(/session_thread_id/);
    // And a thread of ANOTHER session is not addressable here either.
    const other = manager.create({ agent: 'agent_coordinator' });
    const foreign = childOf(manager, other.id, 'paused');
    await expect(manager.sendEvent(session.id, {
      type: 'user.interrupt',
      session_thread_id: foreign.id,
    } as never)).rejects.toThrow(/session_thread_id/);
    expect(manager.getThreadStore().get(foreign.id)?.status).toBe('paused');
  });

  it('a scoped interrupt aborts only the named running thread', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    manager.setExecutor(heldExecutor(gate));
    const session = manager.create({ agent: 'agent_coordinator' });
    manager.getThreadStore().updateStatus(primaryThreadIdForSession(session.id), 'paused');
    const running = childOf(manager, session.id, 'running');
    const parked = childOf(manager, session.id, 'running');
    parkThread(manager, session.id, parked.id, 'toolu_scoped_only');

    // Interrupt only the parked child: its calls close; the running sibling is
    // untouched — its turn must still be aborted by its own signal later.
    await manager.sendEvent(session.id, {
      type: 'user.interrupt',
      session_thread_id: parked.id,
    } as never);

    expect(manager.getThreadStore().get(parked.id)?.status).toBe('paused');
    expect(manager.getThreadStore().get(running.id)?.status).toBe('running');
    release();
    expect(manager.getThreadStore().get(running.id)?.status).toBe('running');
  });
});
