/**
 * Durable pending-interaction store: the one-shot guarantee.
 *
 * Every assertion here is about something that must be impossible. The gate's
 * whole safety argument is that one `tool_call` yields one decision, so the
 * interesting cases are the second decision, the stale decision, and the
 * decision aimed at a different call — not the happy path.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import {
  PiInteractionStore,
  fingerprintPiToolInput,
} from '@/strategy/pi/interaction-store.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(sessionId = 'sess_gate_store'): { db: Database; store: PiInteractionStore } {
  const directory = mkdtempSync(join(tmpdir(), 'ma-pi-interactions-'));
  directories.push(directory);
  const db = new Database(join(directory, 'data.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
  db.exec(
    `INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine)
     VALUES ('${sessionId}', 'agent_pi', 'pi-agent', 'env_default', 'running', '[]', '[]', 'pi')`,
  );
  return { db, store: new PiInteractionStore(db) };
}

const OPEN = {
  sessionId: 'sess_gate_store',
  turnId: 'piturn_1',
  piRequestId: 'pi-req-1',
  toolUseId: 'toolu_1',
  toolName: 'bash',
  input: { command: 'rm -rf /tmp/x' },
} as const;

describe('Pi interaction store', () => {
  it('opens one pending record per tool use and leaves it undecided', () => {
    const { db, store } = openStore();
    const record = store.open(OPEN);

    expect(record).toMatchObject({
      sessionId: 'sess_gate_store',
      turnId: 'piturn_1',
      piRequestId: 'pi-req-1',
      toolUseId: 'toolu_1',
      toolName: 'bash',
      state: 'pending',
    });
    expect(record.inputFingerprint).toBe(fingerprintPiToolInput({ command: 'rm -rf /tmp/x' }));
    db.close();
  });

  it('does not reset a decision when the engine re-announces the same call', () => {
    const { db, store } = openStore();
    store.open(OPEN);
    expect(store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      decision: 'deny',
      source: 'user',
    }).kind).toBe('consumed');

    // A repeated `tool_execution_start` must not reopen a decided interaction,
    // or a denial would become a fresh question the model could re-trigger.
    const reopened = store.open(OPEN);
    expect(reopened.state).toBe('denied');
    expect(reopened.decisionSource).toBe('user');
    db.close();
  });

  it('consumes a pending record exactly once', () => {
    const { db, store } = openStore();
    store.open(OPEN);

    const first = store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      toolUseId: OPEN.toolUseId,
      expectedTurnId: OPEN.turnId,
      decision: 'allow',
      source: 'user',
      decidedInput: { command: 'ls' },
    });
    expect(first.kind).toBe('consumed');

    // Acceptance: duplicate approval cannot execute twice. The second attempt
    // must see a decided row, never a consumable one.
    const second = store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      decision: 'allow',
      source: 'user',
    });
    expect(second.kind).toBe('already_decided');
    expect(second.kind === 'already_decided' && second.record.state).toBe('allowed');
    db.close();
  });

  it('reports an unknown request rather than inventing a pending record', () => {
    const { db, store } = openStore();
    expect(store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: 'pi-req-never-opened',
      decision: 'allow',
      source: 'user',
    })).toEqual({ kind: 'unknown_request' });
    db.close();
  });

  it('refuses a decision bound to a different tool use or turn', () => {
    const { db, store } = openStore();
    store.open(OPEN);

    // Both mismatches are checked before the UPDATE, so a decision aimed at the
    // wrong call cannot consume the row it happens to share a request id with.
    expect(store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      toolUseId: 'toolu_other',
      decision: 'allow',
      source: 'user',
    }).kind).toBe('mismatch');

    expect(store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      expectedTurnId: 'piturn_other',
      decision: 'allow',
      source: 'user',
    }).kind).toBe('mismatch');

    expect(store.findPendingByRequest(OPEN.sessionId, OPEN.piRequestId)?.state).toBe('pending');
    db.close();
  });

  it('records a platform decision as platform-decided, never as a user click', () => {
    const { db, store } = openStore();
    store.open(OPEN);
    store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      decision: 'allow',
      source: 'platform',
    });

    const record = store.findPendingByRequest(OPEN.sessionId, OPEN.piRequestId);
    expect(record?.state).toBe('allowed');
    // The source is the difference between "an operator approved this" and "a
    // rule approved this", and a client must not be told the former.
    expect(record?.decisionSource).toBe('platform');
    db.close();
  });

  it('retires pending records as system denials after restart', () => {
    const { db, store } = openStore();
    store.open(OPEN);

    const retired = store.retirePending('runtime restarted before Pi gate response');
    expect(retired).toHaveLength(1);
    expect(store.findPendingByRequest(OPEN.sessionId, OPEN.piRequestId)).toMatchObject({
      state: 'denied',
      decisionSource: 'system',
      denyMessage: 'runtime restarted before Pi gate response',
    });
    expect(store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      decision: 'allow',
      source: 'user',
    }).kind).toBe('already_decided');
    db.close();
  });

  it('keeps a durable deny message and the decided input', () => {
    const { db, store } = openStore();
    store.open(OPEN);
    store.consume({
      sessionId: OPEN.sessionId,
      piRequestId: OPEN.piRequestId,
      decision: 'deny',
      source: 'user',
      denyMessage: 'operator refused',
      decidedInput: { command: 'echo safe' },
    });

    expect(store.findPendingByRequest(OPEN.sessionId, OPEN.piRequestId)).toMatchObject({
      state: 'denied',
      denyMessage: 'operator refused',
      decidedInput: { command: 'echo safe' },
    });
    db.close();
  });

  it('fingerprints equal inputs equally and changed inputs differently', () => {
    // Key order is not part of the input, so a re-serialized object must not be
    // reported as changed arguments.
    expect(fingerprintPiToolInput({ a: 1, b: [2, { c: 3 }] }))
      .toBe(fingerprintPiToolInput({ b: [2, { c: 3 }], a: 1 }));
    expect(fingerprintPiToolInput({ a: 1 })).not.toBe(fingerprintPiToolInput({ a: 2 }));
    expect(fingerprintPiToolInput({ a: 1 })).not.toBe(fingerprintPiToolInput({ a: '1' }));
  });

  it('lists a session history oldest first', () => {
    const { db, store } = openStore();
    store.open(OPEN);
    store.open({ ...OPEN, piRequestId: 'pi-req-2', toolUseId: 'toolu_2' });

    expect(store.listForSession(OPEN.sessionId).map((record) => record.toolUseId))
      .toEqual(['toolu_1', 'toolu_2']);
    db.close();
  });

  it('cascades interaction rows when the session is physically removed', () => {
    const { db, store } = openStore();
    store.open(OPEN);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(OPEN.sessionId);

    // Without the explicit cascade this delete would fail on the foreign key,
    // which is how a session delete would start failing only once a gate opened.
    expect(store.listForSession(OPEN.sessionId)).toEqual([]);
    db.close();
  });
});
