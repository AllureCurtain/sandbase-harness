/**
 * Thread-scoped budget pause and resume — PR 3.6 (design doc §4.6).
 *
 * The session's spending ceiling is shared (D2): every thread's model requests
 * price into the same `sessionSpend`, so one cap stops them all — but each
 * running thread stops on its own `session.thread_status_idle`
 * (`budget_reached`), and the session aggregate follows the §4.3 priority
 * rules (`requires_action` outranks an all-paused aggregate). An accepted
 * budget update then re-enters each budget-parked thread separately on
 * `internal.resume_after_budget`.
 *
 * The scripted executor stands in for the strategy layer exactly as the
 * coordinator tests use it: `send_to_agent` runs through the real
 * `buildCoordinatorTools`, the "model" records the spend a step commits via
 * `span.model_request_end`, and the `budgetExhausted` callback is honoured the
 * way `DefaultStrategy`'s `stopWhen` reads it after `onStepFinish`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager, type ExecuteOptions, type SessionExecutor } from '@/core/session/session-manager.js';
import { buildCoordinatorTools } from '@/core/session/coordinator-tools.js';
import { primaryThreadIdForSession, type SessionThread } from '@/core/session/session-threads.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { CostProfile } from '@/core/session/cost-profile.js';
import type { Session, SessionEvent } from '@/types/session.js';

/** One cent per thousand tokens, so a script moves spend in whole cents. */
const PROFILE: CostProfile = {
  id: 'test',
  models: { 'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 } },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

const COORDINATOR: AgentDefinition = {
  name: 'coordinator',
  model: 'model-priced',
  system: 'coordinate',
  multiagent: {
    type: 'coordinator',
    agents: [{ type: 'agent', id: 'agent_worker', version: 1 }],
  },
};
const WORKER: AgentDefinition = { name: 'reviewer', model: 'model-priced', system: 'review' };

/** What one turn does, in order. */
interface TurnActions {
  sendToAgent?: { agent: string; message: string };
  /** Commit this many cents of spend (as `span.model_request_end` rows). */
  spend?: number;
  /** End the turn parked on an approval-gated `agent.tool_use`. */
  park?: { tool: string };
  say?: string;
}

class ScriptedExecutor implements SessionExecutor {
  private readonly scripts = new Map<string, TurnActions[]>();
  readonly invocations: Array<{ threadId: string; agentName: string; eventType: string }> = [];

  constructor(private readonly eventLogger: ReturnType<SessionManager['getEventLogger']>) {}

  script(agentName: string, actions: TurnActions[]): void {
    this.scripts.set(agentName, [...actions]);
  }

  async *execute(session: Session, event: any, options?: ExecuteOptions): AsyncIterable<SessionEvent> {
    const thread = options?.thread;
    const threadId = thread?.id ?? primaryThreadIdForSession(session.id);
    const agent = thread?.agentDefinition ?? session.agentDefinition ?? COORDINATOR;
    const agentName = thread?.agentName ?? session.agentName;
    this.invocations.push({ threadId, agentName, eventType: event.type });

    const queue = this.scripts.get(agentName) ?? [];
    const actions = queue.shift() ?? {};

    if (options?.coordinatorHost && agent.multiagent && actions.sendToAgent) {
      const tools = buildCoordinatorTools(agent, options.coordinatorHost) as Record<string, any>;
      await tools.send_to_agent.execute({
        agent: actions.sendToAgent.agent,
        message: actions.sendToAgent.message,
      });
    }

    // The spend this turn's steps committed, recorded the way `onStepFinish`
    // would. `budgetExhausted` is checked after — the strategy's stopWhen
    // ordering — so a turn that crosses the cap stops before its next step.
    if (actions.spend) {
      this.eventLogger.append(session.id, {
        type: 'span.model_request_end',
        modelUsed: 'model-priced',
        tokensIn: actions.spend * 1000,
        tokensOut: 0,
      });
    }
    if (actions.park) {
      const useEvent = this.eventLogger.append(session.id, {
        type: 'agent.tool_use',
        threadId,
        content: [{
          type: 'tool_use',
          id: `toolu_park_${agentName}_${threadId}`,
          name: actions.park.tool,
          input: {},
          requires_confirmation: true,
        } as never],
      });
      options?.broadcast?.(useEvent);
      options?.onRequiresAction?.();
      return;
    }
    if (options?.budgetExhausted?.()) return;

    const evt = this.eventLogger.append(session.id, {
      type: 'agent.message',
      threadId,
      content: [{ type: 'text', text: actions.say ?? '' }],
    });
    options?.broadcast?.(evt);
  }
}

async function until(manager: SessionManager, sessionId: string, predicate: (events: SessionEvent[]) => boolean, ms = 10000): Promise<SessionEvent[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const events = manager.getEventLogger().getEvents(sessionId);
    if (predicate(events)) return events;
    if (Date.now() > deadline) return events;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function untilThreads(manager: SessionManager, sessionId: string, predicate: (threads: SessionThread[]) => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const threads = manager.getThreadStore().listBySession(sessionId);
    if (predicate(threads)) return threads;
    if (Date.now() > deadline) return threads;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const stopReasonOf = (event: SessionEvent | undefined) =>
  (event?.metadata as { stop_reason?: { type?: string } } | undefined)?.stop_reason?.type;

/** The thread-level idle events for one thread. */
const threadIdles = (events: SessionEvent[], threadId: string) =>
  events.filter((e) => e.type === 'session.thread_status_idle' && e.metadata?.session_thread_id === threadId);

describe('thread-scoped budget (§4.6)', () => {
  let directory: string;
  let db: Database;
  let manager: SessionManager;
  let executor: ScriptedExecutor;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-thread-budget-'));
    db = new Database(join(directory, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_coordinator', 'coordinator', 1, ?)`)
      .run(JSON.stringify(COORDINATOR));
    db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_worker', 'reviewer', 1, ?)`)
      .run(JSON.stringify(WORKER));
    manager = new SessionManager(db);
    manager.setCostProfile(PROFILE);
    executor = new ScriptedExecutor(manager.getEventLogger());
    manager.setExecutor(executor);
  });

  afterEach(async () => {
    await manager.shutdown();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('each running thread emits its own budget_reached idle and the session aggregates to idle(budget_reached)', async () => {
    // Coordinator dispatches, then spends 10 cents; the child spends 10 cents.
    // Cap is 5 cents: both turns cross the ceiling and idle on budget_reached.
    const session = manager.create({
      agent: 'agent_coordinator',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    const primaryId = primaryThreadIdForSession(session.id);
    executor.script('coordinator', [{ sendToAgent: { agent: 'reviewer', message: 'work' }, spend: 10 }]);
    executor.script('reviewer', [{ spend: 10 }]);

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });

    const threads = await untilThreads(manager, session.id, (t) =>
      t.length === 2 && t.every((x) => x.status === 'paused'));
    const child = threads.find((t) => t.parentThreadId === primaryId)!;

    const events = await until(manager, session.id, (e) =>
      threadIdles(e, child.id).length > 0 && e.some((x) => x.type === 'session.status_idle'));

    // Each running thread published its own idle on budget_reached.
    expect(stopReasonOf(threadIdles(events, primaryId).at(-1))).toBe('budget_reached');
    expect(stopReasonOf(threadIdles(events, child.id).at(-1))).toBe('budget_reached');

    // The aggregate followed once every unarchived thread was paused, and it
    // names the shared reason.
    const sessionIdle = events.filter((e) => e.type === 'session.status_idle').at(-1);
    expect(stopReasonOf(sessionIdle)).toBe('budget_reached');
    expect(manager.get(session.id)?.status).toBe('paused');

    // A budget-parked child is suspended, not finished: no reply was posted to
    // the parent's stream.
    expect(events.some((e) => e.type === 'agent.thread_message_received' && e.threadId === primaryId)).toBe(false);
  });

  it('a requires_action child outranks the budget-parked aggregate at the cap', async () => {
    // The coordinator spends past the cap; the child parks on a gated call.
    // §4.3: requires_action beats the all-paused aggregate even when the
    // reason the pauses share is budget_reached.
    const session = manager.create({
      agent: 'agent_coordinator',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    const primaryId = primaryThreadIdForSession(session.id);
    executor.script('coordinator', [{ sendToAgent: { agent: 'reviewer', message: 'gated work' }, spend: 10 }]);
    executor.script('reviewer', [{ park: { tool: 'bash' } }]);

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });

    const threads = await untilThreads(manager, session.id, (t) =>
      t.length === 2 && t.some((x) => x.status === 'requires_action'));
    const child = threads.find((t) => t.parentThreadId === primaryId)!;

    // The primary idled on the ceiling; the child waits on its answer.
    const events = await until(manager, session.id, (e) => threadIdles(e, primaryId).length > 0);
    expect(stopReasonOf(threadIdles(events, primaryId).at(-1))).toBe('budget_reached');
    expect(child.status).toBe('requires_action');

    // The aggregate reports the thread still waiting on a client — a budget
    // idle would tell the client the session stopped for money while a parked
    // call still needs its answer (§4.3 rows 2–3). `requires_action` surfaces
    // on the wire as `session.status_idle` with the matching stop_reason.
    const after = await until(manager, session.id, (e) =>
      e.some((x) => x.type === 'session.status_idle' && stopReasonOf(x) === 'requires_action'));
    expect(manager.get(session.id)?.status).toBe('requires_action');
    const sessionIdle = after.filter((e) => e.type === 'session.status_idle').at(-1);
    expect(stopReasonOf(sessionIdle)).toBe('requires_action');
  });

  it('resumes each budget-parked thread on its own chain after the ceiling lifts', async () => {
    // Same shape as the first case, but after both threads idle on the
    // ceiling the budget is raised: each thread re-enters on its own
    // internal.resume_after_budget trigger, and each finishes end_turn.
    const session = manager.create({
      agent: 'agent_coordinator',
      budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
    });
    const primaryId = primaryThreadIdForSession(session.id);
    executor.script('coordinator', [
      { sendToAgent: { agent: 'reviewer', message: 'work' }, spend: 10 },
      // The resumed turn: no more spend scripted, so it ends end_turn.
      { say: 'coordinator done' },
    ]);
    executor.script('reviewer', [
      { spend: 10 },
      { say: 'worker done' },
    ]);

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });
    const threads = await untilThreads(manager, session.id, (t) =>
      t.length === 2 && t.every((x) => x.status === 'paused'));
    const child = threads.find((t) => t.parentThreadId === primaryId)!;
    expect(manager.get(session.id)?.status).toBe('paused');

    await manager.updateSession(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } },
    });

    // Each thread got its own resume trigger on its own chain.
    await untilThreads(manager, session.id, (t) => t.every((x) => x.status === 'paused'));
    const resumeOn = (threadId: string) =>
      executor.invocations.filter((i) => i.threadId === threadId && i.eventType === 'internal.resume_after_budget').length;
    await until(manager, session.id, () => resumeOn(primaryId) >= 1 && resumeOn(child.id) >= 1);
    expect(resumeOn(primaryId)).toBe(1);
    expect(resumeOn(child.id)).toBe(1);

    // The resume never fabricates an utterance, and the resumed child turn
    // that ended end_turn posted its reply to the parent — the reply the
    // budget pause held back.
    const events = await until(manager, session.id, (e) =>
      e.some((x) => x.type === 'agent.thread_message_received' && x.threadId === primaryId));
    expect(events.filter((e) => e.type === 'user.message')).toHaveLength(1);
    expect(events.some((e) => e.type === 'agent.thread_message_received' && e.threadId === primaryId)).toBe(true);

    // With every thread end_turn-paused and the reply delivered, the session
    // aggregates idle on end_turn, no longer on the ceiling.
    await until(manager, session.id, (e) => {
      const idle = e.filter((x) => x.type === 'session.status_idle').at(-1);
      return stopReasonOf(idle) === 'end_turn';
    });
    expect(stopReasonOf(events.filter((e) => e.type === 'session.status_idle').at(-1))).toBe('end_turn');
  });
});
