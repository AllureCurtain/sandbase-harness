/**
 * Integration test: `session.status_idle` carries its `stop_reason` object at
 * the top level.
 *
 * `src/types/cma-protocol.ts` declares `SessionStatusIdleEvent.stop_reason` as a
 * top-level object, but the runtime persists it inside the generic metadata
 * carrier (`metadata.stop_reason`) and the API projection never lifted it. The
 * published client reads exactly the top level:
 *
 *     jq -r 'select(.type == "session.status_idle") | .stop_reason.type // empty'
 *
 * so while the object stayed nested that expression returned the empty string
 * for every idle event, the `case` arm matched neither `requires_action` nor
 * `end_turn`, and a conforming client could not tell "the session paused and
 * needs my answer" from "the turn ended" — including the documented interrupt
 * case, where the contract says the interrupted turn reports `end_turn`.
 *
 * These assertions pin the projected object, that the projection was additive
 * (the persisted path a `202` decision in `src/api/routes/runs.ts` reads still
 * resolves), that the model-derived `stop_reason` **string** is untouched, and
 * that an idle event with no reason omits the field rather than sending `null`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Session status_idle stop_reason projection', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-stop-reason-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);
    manager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager: manager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Every event the API returns for a session, in log order. */
  async function apiEvents(sessionId: string): Promise<any[]> {
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    return body.data ?? body.events ?? body;
  }

  /** The persisted event, straight from the log — not the projection. */
  function loggedEvent(sessionId: string, type: string) {
    return manager.getEventLogger().getEvents(sessionId).find((e) => e.type === type);
  }

  /**
   * Drive a real session to `requires_action` so the assertion covers the
   * reason `SessionManager` itself writes, not a hand-seeded fixture.
   */
  async function sessionAtRequiresAction(): Promise<string> {
    const executor: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(_session, _event, options) {
        options?.onRequiresAction?.();
        return;
      },
    };
    manager.setExecutor(executor);
    const session = manager.create({ agent: 'agent_x' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'go' }],
    } as any);
    await waitFor(
      () => (manager.get(session.id)?.status === 'requires_action' ? 'requires_action' : undefined),
      'session status requires_action',
    );
    return session.id;
  }

  it('exposes stop_reason.type at the top level so the documented read is not empty', async () => {
    const sessionId = await sessionAtRequiresAction();
    const idle = (await apiEvents(sessionId)).find((e) => e.type === 'session.status_idle');
    expect(idle).toBeDefined();

    // The published expression, spelled out: `.stop_reason.type // empty`.
    const type = idle.stop_reason?.type ?? '';
    expect(type).toBe('requires_action');
  });

  it('keeps the object under metadata so the persisted reader still resolves', async () => {
    const sessionId = await sessionAtRequiresAction();

    const persisted = loggedEvent(sessionId, 'session.status_idle')!.metadata?.stop_reason as
      | Record<string, unknown>
      | undefined;
    // This is exactly the predicate `src/api/routes/runs.ts` uses to choose
    // between a `202` with `wait_deadline_reached` and a terminal body.
    expect(persisted).toBeTruthy();
    expect(typeof persisted).toBe('object');
    expect(persisted!.type).toBe('requires_action');

    const idle = (await apiEvents(sessionId)).find((e) => e.type === 'session.status_idle');
    // Additive: the projected object and the metadata carrier agree.
    expect(idle.stop_reason).toEqual(persisted);
    expect(idle.metadata.stop_reason).toEqual(persisted);
  });

  it('reports end_turn on the idle event of a session that paused with a recoverable failure', async () => {
    const session = manager.create({ agent: 'agent_x' });
    // Crash recovery is the real path that pauses a session and publishes
    // `session.status_idle`, and it is also the path an interrupted turn takes
    // to `end_turn`: no dedicated reason exists for an interrupt, the contract
    // says it reports the same `end_turn` a self-completing turn does.
    db.prepare("UPDATE sessions SET status='running' WHERE id=?").run(session.id);
    expect(manager.reconcileOrphans()).toBe(1);

    const idle = (await apiEvents(session.id)).find((e) => e.type === 'session.status_idle');
    expect(idle).toBeDefined();
    expect(idle.stop_reason?.type).toBe('end_turn');
    expect(idle.stop_reason?.event_ids).toBeUndefined();
  });

  it('projects the object only onto session.status_idle and leaves the model stop_reason string alone', async () => {
    const sessionId = await sessionAtRequiresAction();
    // A model-derived event: the `stop_reason` column, a string.
    manager.getEventLogger().append(sessionId, {
      type: 'agent.message',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'max_tokens',
    });

    const events = await apiEvents(sessionId);
    const message = events.find((e) => e.type === 'agent.message');
    expect(message.stop_reason).toBe('max_tokens');

    const idle = events.find((e) => e.type === 'session.status_idle');
    expect(typeof idle.stop_reason).toBe('object');

    // No other event type gained an object.
    for (const event of events) {
      if (event.type === 'session.status_idle') continue;
      expect(typeof event.stop_reason === 'object' && event.stop_reason !== null).toBe(false);
    }
  });

  it('omits the field rather than sending null when an idle event has no reason', async () => {
    const session = manager.create({ agent: 'agent_x' });
    manager.getEventLogger().append(session.id, { type: 'session.status_idle' });

    const idle = (await apiEvents(session.id)).find((e) => e.type === 'session.status_idle');
    expect(idle).toBeDefined();
    expect('stop_reason' in idle).toBe(false);
    expect(idle.stop_reason).toBeUndefined();
  });
});
