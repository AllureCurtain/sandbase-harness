/**
 * Integration test: a parked wait bounded by configuration, end to end.
 *
 * The published contract has a session wait for a caller's answer without a
 * limit — `权限策略.md:668` says it pauses with `requires_action` and "会话会无限期
 * 等待响应" — so the default must stay an indefinite wait and the bound is an
 * opt-in local extension. This test pins both halves of that, on the real
 * settings store, the real session manager and the real sweep the operations
 * timer drives.
 *
 * The setup parks a session by appending the event that parks it and moving the
 * session to `requires_action`, which is the same thing the model loop does — the
 * parking mechanism is not what is under test here, the bound is. The reason this
 * matters: a session at its ceiling must never be ended (frozen decision D23),
 * and that only holds together because a ceiling here refuses the next event
 * *without* changing status, so the session is still `requires_action` and every
 * status-based check sees an ordinary parked session.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { sweepExpiredParkedWaits, parkedWaitTimeoutSeconds } from '@/core/operations/parked-wait-sweep.js';
import { REQUIRES_ACTION_TIMEOUT_OPTION } from '@/core/settings/adapters.js';
import {
  activateRuntimeSettings,
  getOrSeedRuntimeSettings,
  saveRuntimeSettings,
} from '@/core/settings/store.js';
import { PARKED_WAIT_TIMEOUT_CODE } from '@/core/session/parked-wait.js';
import type { CostProfile } from '@/core/session/cost-profile.js';

/** One cent per thousand tokens, so a test moves spend in whole cents. */
const PROFILE: CostProfile = {
  id: 'test',
  models: { 'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 } },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('Bounded parked wait', () => {
  let db: Database | undefined;
  let manager: SessionManager | undefined;
  let workspace: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    manager = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  function setUp(): { db: Database; manager: SessionManager; workspace: string } {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-parked-wait-'));
    const database = new Database(join(workspace, 'test.db'));
    database.runMigrations();
    database.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    database.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_parked', 'parked-agent', '{}')");
    const sessionManager = new SessionManager(database);
    sessionManager.setCostProfile(PROFILE);
    db = database;
    manager = sessionManager;
    return { db: database, manager: sessionManager, workspace };
  }

  /**
   * Configure the bound through the real settings store, saved and activated.
   *
   * Activation is validated, so the model needs a key or the whole config is
   * refused as `failed` and `effective_config` never carries the bound — which is
   * the state the "failed to activate" case below relies on.
   */
  function setBound(database: Database, seconds: number, dir: string): void {
    const initial = getOrSeedRuntimeSettings(database, {}, dir);
    const changed = {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      loop_engine: {
        provider: 'builtin' as const,
        options: { ...initial.saved_config.loop_engine.options, [REQUIRES_ACTION_TIMEOUT_OPTION]: seconds },
      },
    };
    const saved = saveRuntimeSettings(database, changed, initial.revision, dir);
    if (!saved.ok) throw new Error(`settings save refused: ${saved.reason}`);
    const activated = activateRuntimeSettings(database, {}, dir);
    if (activated.activation_status === 'failed') {
      throw new Error(`settings activation failed: ${JSON.stringify(activated.activation_errors)}`);
    }
  }

  /** Park a session on `blockIds` the way the model loop does, then set the status. */
  function park(
    database: Database,
    sessionManager: SessionManager,
    blockIds: string[],
    options: { parkedAt: Date; kind?: 'custom' | 'gated'; budget?: unknown },
  ): string {
    const session = sessionManager.create({
      agent: 'agent_parked',
      ...(options.budget ? { budget: options.budget as never } : {}),
    });
    for (const blockId of blockIds) {
      sessionManager.getEventLogger().append(session.id, {
        type: options.kind === 'gated' ? 'agent.tool_use' : 'agent.custom_tool_use',
        content: [{
          type: 'tool_use',
          id: blockId,
          name: options.kind === 'gated' ? 'bash' : 'lookup_customer',
          input: {},
          ...(options.kind === 'gated' ? { requires_confirmation: true } : {}),
        }] as never,
      });
    }
    // Backdate the parking events so the bound is measured from when the session
    // actually parked, not from when this test ran.
    database.prepare('UPDATE events SET created_at = ? WHERE session_id = ?')
      .run(options.parkedAt.toISOString(), session.id);
    database.prepare("UPDATE sessions SET status='requires_action' WHERE id=?").run(session.id);
    return session.id;
  }

  function sweep(database: Database, sessionManager: SessionManager, dir: string, now = NOW): string[] {
    return sweepExpiredParkedWaits({ db: database, sessionManager, dataDir: dir, now });
  }

  function events(sessionManager: SessionManager, sessionId: string) {
    return sessionManager.getEventLogger().getEvents(sessionId);
  }

  it('leaves a parked session parked when no bound is configured', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    // No settings write at all: this is the published indefinite wait.
    expect(parkedWaitTimeoutSeconds(database, dir)).toBeUndefined();
    const sessionId = park(database, sessionManager, ['custom_1'], { parkedAt: new Date(NOW.getTime() - 86_400_000) });

    expect(sweep(database, sessionManager, dir)).toEqual([]);
    expect(sessionManager.get(sessionId)?.status).toBe('requires_action');
    expect(events(sessionManager, sessionId).some((e) => e.type === 'session.error')).toBe(false);
  });

  it('ends a parked session past the bound, with a coded error and the timed_out status', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    expect(parkedWaitTimeoutSeconds(database, dir)).toBe(300);
    const sessionId = park(database, sessionManager, ['custom_1'], { parkedAt: new Date(NOW.getTime() - 301_000) });

    expect(sweep(database, sessionManager, dir)).toEqual([sessionId]);

    const session = sessionManager.get(sessionId);
    expect(session?.status).toBe('timed_out');
    const error = events(sessionManager, sessionId).find((e) => e.type === 'session.error');
    expect(error).toBeDefined();
    // The reason is machine-readable, on the carrier every coded failure uses.
    expect((error!.metadata?.error as { type: string }).type).toBe(PARKED_WAIT_TIMEOUT_CODE);
    // The runtime decided to stop waiting; no retry by the runtime changes that.
    expect((error!.metadata?.error as { retry_status: string }).retry_status).toBe('not_retryable');
  });

  it('leaves a parked session alone until the bound has actually passed', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    const sessionId = park(database, sessionManager, ['custom_1'], { parkedAt: new Date(NOW.getTime() - 299_000) });

    expect(sweep(database, sessionManager, dir)).toEqual([]);
    expect(sessionManager.get(sessionId)?.status).toBe('requires_action');
  });

  it('does not answer the parked calls on the caller behalf', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    const sessionId = park(database, sessionManager, ['custom_1', 'custom_2'], {
      parkedAt: new Date(NOW.getTime() - 400_000),
    });

    sweep(database, sessionManager, dir);

    // The session stopped waiting; nobody decided what the tools returned.
    const log = events(sessionManager, sessionId);
    expect(log.some((e) => e.type === 'agent.tool_result')).toBe(false);
    expect(log.some((e) => e.type === 'user.custom_tool_result')).toBe(false);
    // Both calls are still visibly unanswered in the append-only log.
    expect(log.filter((e) => e.type === 'agent.custom_tool_use')).toHaveLength(2);
  });

  it('measures the bound from the parking event, so a session already expired ends on the first pass', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 60, dir);
    // Parked a week before the runtime looked at it: the longest waits are the
    // ones an operator most wants bounded, so they must not look freshly parked.
    const sessionId = park(database, sessionManager, ['custom_1'], {
      parkedAt: new Date(NOW.getTime() - 7 * 86_400_000),
    });

    expect(sweep(database, sessionManager, dir)).toEqual([sessionId]);
    expect(sessionManager.get(sessionId)?.status).toBe('timed_out');
  });

  it('ends a session parked on an approval-gated call too', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    const sessionId = park(database, sessionManager, ['call_1'], {
      parkedAt: new Date(NOW.getTime() - 400_000),
      kind: 'gated',
    });

    expect(sweep(database, sessionManager, dir)).toEqual([sessionId]);
    expect(sessionManager.get(sessionId)?.status).toBe('timed_out');
  });

  it('never ends a parked session at its spending ceiling, and still accepts its answer (D23)', async () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 1, dir);
    // One dollar, spent to the cent: the session is out of budget.
    const sessionId = park(database, sessionManager, ['custom_1'], {
      parkedAt: new Date(NOW.getTime() - 86_400_000),
      budget: { type: 'limit', max_list_cost: { amount: '1', currency: 'USD' } },
    });
    sessionManager.getEventLogger().append(sessionId, {
      type: 'span.model_request_end',
      modelUsed: 'model-priced',
      tokensIn: 100_000,
      tokensOut: 0,
    });
    expect(sessionManager.isBudgetExhausted(sessionId)).toBe(true);

    // A ceiling here does not change status, so this session is still
    // `requires_action` and still parked — and must still be left alone.
    expect(sweep(database, sessionManager, dir)).toEqual([]);
    expect(sessionManager.get(sessionId)?.status).toBe('requires_action');

    // And the reason it is protected: its answer is a settlement event the
    // budget deliberately still accepts, so the client is not hung.
    await expect(sessionManager.sendEvent(sessionId, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'custom_1',
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    } as never)).resolves.toBeDefined();
  });

  it('ends several expired sessions in one pass and leaves the unexpired one parked', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    const expiredA = park(database, sessionManager, ['custom_a'], { parkedAt: new Date(NOW.getTime() - 500_000) });
    const expiredB = park(database, sessionManager, ['custom_b'], { parkedAt: new Date(NOW.getTime() - 600_000) });
    const fresh = park(database, sessionManager, ['custom_c'], { parkedAt: new Date(NOW.getTime() - 10_000) });

    const ended = sweep(database, sessionManager, dir);

    expect(ended.sort()).toEqual([expiredA, expiredB].sort());
    expect(sessionManager.get(expiredA)?.status).toBe('timed_out');
    expect(sessionManager.get(expiredB)?.status).toBe('timed_out');
    expect(sessionManager.get(fresh)?.status).toBe('requires_action');
  });

  it('is idempotent: a second pass ends nothing', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    setBound(database, 300, dir);
    park(database, sessionManager, ['custom_1'], { parkedAt: new Date(NOW.getTime() - 400_000) });

    expect(sweep(database, sessionManager, dir)).toHaveLength(1);
    expect(sweep(database, sessionManager, dir)).toEqual([]);
  });

  it('treats a bound that was saved but never activated as no bound', () => {
    const { db: database, manager: sessionManager, workspace: dir } = setUp();
    // An operator's unactivated edit must not start ending sessions: the sweep
    // reads what the runtime is actually running, not what was last typed.
    const initial = getOrSeedRuntimeSettings(database, {}, dir);
    const saved = saveRuntimeSettings(database, {
      ...initial.saved_config,
      model: { ...initial.saved_config.model, api_key: 'model-secret' },
      loop_engine: {
        provider: 'builtin' as const,
        options: { ...initial.saved_config.loop_engine.options, [REQUIRES_ACTION_TIMEOUT_OPTION]: 1 },
      },
    }, initial.revision, dir);
    expect(saved.ok).toBe(true);
    expect(parkedWaitTimeoutSeconds(database, dir)).toBeUndefined();

    const sessionId = park(database, sessionManager, ['custom_1'], {
      parkedAt: new Date(NOW.getTime() - 86_400_000),
    });
    expect(sweep(database, sessionManager, dir)).toEqual([]);
    expect(sessionManager.get(sessionId)?.status).toBe('requires_action');
  });
});
