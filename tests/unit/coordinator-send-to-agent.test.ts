/**
 * Coordinator `send_to_agent` — PR 3.3.
 *
 * Drives the real `SessionManager` (thread store, execution chains, cross-post
 * writes, status aggregation, reply re-dispatch) with a scripted
 * `SessionExecutor` that stands in for the strategy layer: it mounts the real
 * `buildCoordinatorTools` against the per-turn `coordinatorHost` the manager
 * injects, calls `send_to_agent`, and appends the thread-scoped
 * `agent.tool_use` / `agent.message` rows a model turn would. That exercises
 * everything §4.4 fixes except the model call itself — the dispatch, the child's
 * own chain, the reply pair, and the parent's re-entry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import { SessionManager, type ExecuteOptions, type SessionExecutor } from '@/core/session/session-manager.js';
import { buildCoordinatorTools, MAX_ACTIVE_CHILD_THREADS } from '@/core/session/coordinator-tools.js';
import { primaryThreadIdForSession, type SessionThread } from '@/core/session/session-threads.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session, SessionEvent, SessionStatus } from '@/types/session.js';

/** The coordinator's roster: one named member, `reviewer`. */
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
const WORKER2: AgentDefinition = { name: 'reviewer2', model: 'm', system: 'review more' };

/** The coordinator's two-member roster, for fan-out dispatch. */
const COORDINATOR2: AgentDefinition = {
  name: 'coordinator',
  model: 'm',
  system: 'coordinate',
  multiagent: {
    type: 'coordinator',
    agents: [
      { type: 'agent', id: 'agent_worker', version: 1 },
      { type: 'agent', id: 'agent_worker2', version: 1 },
    ],
  },
};

/** What one turn does, in order. */
interface TurnActions {
  /** Invoke `send_to_agent` with these args on this turn. */
  sendToAgent?: { agent: string; message: string; thread_id?: string };
  /** Invoke `send_to_agent` several times in this one turn (fan-out dispatch). */
  sendToAgents?: Array<{ agent: string; message: string; thread_id?: string }>;
  /** Invoke `list_agents` and record its raw JSON output here. */
  listAgents?: (raw: string) => void;
  /** Capture this turn's model-facing message projection (the thread's context). */
  captureMessages?: (messages: unknown) => void;
  /** Emit a child-file-write tool_use + result pair before the message. */
  writeFile?: { path: string; content: string };
  /** Hold the turn open until resolved — used to overlap two children. */
  hold?: { promise: Promise<void>; resolve: () => void };
  /** The assistant text this turn ends on. */
  say?: string;
}

/**
 * A strategy-layer stand-in. Each call is handed the manager's real
 * `coordinatorHost` and `thread`; the script decides what the "model" does with
 * them. Appends go through the manager's own `EventLogger` with the running
 * thread's id — the same stamping `ThreadEventLogWriter` performs inside the
 * real executor.
 */
class ScriptedExecutor implements SessionExecutor {
  /** Per-agent queue of actions for successive turns on that agent's thread. */
  private readonly scripts = new Map<string, TurnActions[]>();
  /** Every execute() call, in order, with its thread id and agent. */
  readonly invocations: Array<{ threadId: string; agentName: string; eventType: string }> = [];
  /** The raw string each send_to_agent returned, for tool-error assertions. */
  readonly sendResults: string[] = [];
  /** Resolves each time a thread's turn starts running. */
  readonly turnStarted = new Map<string, Array<() => void>>();
  /**
   * Optional resolver for a `thread_id` the script cannot know until the child
   * row exists. A send_to_agent arg of `'DYNAMIC'` is substituted at dispatch.
   */
  resolveDynamicThread?: () => string;

  constructor(
    private readonly eventLogger: ReturnType<SessionManager['getEventLogger']>,
    private readonly contextEvents: (sessionId: string, threadId: string) => SessionEvent[],
  ) {}

  /** Queue the actions an agent's next turns take, in order, keyed by agent name. */
  script(agentName: string, actions: TurnActions[]): void {
    this.scripts.set(agentName, [...actions]);
  }

  /** A promise that resolves the next time a turn starts on `agentName`. */
  nextTurnOn(agentName: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = this.turnStarted.get(agentName) ?? [];
      list.push(resolve);
      this.turnStarted.set(agentName, list);
    });
  }

  async *execute(session: Session, event: any, options?: ExecuteOptions): AsyncIterable<SessionEvent> {
    const thread = options?.thread;
    const threadId = thread?.id ?? primaryThreadIdForSession(session.id);
    const agent = thread?.agentDefinition ?? session.agentDefinition ?? COORDINATOR;
    const agentName = thread?.agentName ?? session.agentName;
    this.invocations.push({ threadId, agentName, eventType: event.type });
    for (const wake of this.turnStarted.get(agentName) ?? []) wake();
    this.turnStarted.set(agentName, []);

    const queue = this.scripts.get(agentName) ?? [];
    const actions = queue.shift() ?? {};

    // Hand the model-facing context to the test — this is the projection the
    // reply `[来自 <name>]` must land in for the coordinator's next turn.
    if (actions.captureMessages) {
      const { eventsToMessages } = await import('@/core/session/events-to-messages.js');
      actions.captureMessages(eventsToMessages(this.contextEvents(session.id, threadId)));
    }

    if (actions.hold) {
      await actions.hold.promise;
    }

    // Mount the same tools the real executor mounts for a rostered thread.
    if (options?.coordinatorHost && agent.multiagent) {
      const tools = buildCoordinatorTools(agent, options.coordinatorHost) as Record<string, any>;
      if (actions.listAgents && tools.list_agents) {
        actions.listAgents(await tools.list_agents.execute());
      }
      const sends = [
        ...(actions.sendToAgent ? [actions.sendToAgent] : []),
        ...(actions.sendToAgents ?? []),
      ];
      for (const send of sends) {
        if (!tools.send_to_agent) break;
        const threadId = send.thread_id === 'DYNAMIC'
          ? this.resolveDynamicThread?.()
          : send.thread_id;
        const out = await tools.send_to_agent.execute({
          agent: send.agent,
          message: send.message,
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
        });
        this.sendResults.push(typeof out === 'string' ? out : JSON.stringify(out));
      }
    }

    // A child writing a file is a tool_use + tool_result pair on its own thread.
    if (actions.writeFile) {
      this.eventLogger.append(session.id, {
        type: 'agent.tool_use',
        threadId,
        content: [{ type: 'tool_use', id: `toolu_${threadId}`, name: 'write', input: actions.writeFile }],
      });
      this.eventLogger.append(session.id, {
        type: 'agent.tool_result',
        threadId,
        content: [{ type: 'tool_result', tool_use_id: `toolu_${threadId}`, content: 'wrote' }],
      });
    }

    // The turn ends on the assistant text the script names.
    const evt = this.eventLogger.append(session.id, {
      type: 'agent.message',
      threadId,
      content: [{ type: 'text', text: actions.say ?? '' }],
    });
    options?.broadcast?.(evt);
  }
}

function seedAgents(db: Database, coordinator: AgentDefinition = COORDINATOR): void {
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_coordinator', 'coordinator', 1, ?)`)
    .run(JSON.stringify(coordinator));
  db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_worker', 'reviewer', 1, ?)`)
    .run(JSON.stringify(WORKER));
  db.prepare(`INSERT INTO agents (id, name, version, definition) VALUES ('agent_worker2', 'reviewer2', 1, ?)`)
    .run(JSON.stringify(WORKER2));
}

/** Poll until `predicate` over the session's events holds, or time out. */
async function until(manager: SessionManager, sessionId: string, predicate: (events: SessionEvent[]) => boolean, ms = 10000): Promise<SessionEvent[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const events = manager.getEventLogger().getEvents(sessionId);
    if (predicate(events)) return events;
    if (Date.now() > deadline) return events;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Poll until `predicate` over the session's threads holds. */
async function untilThreads(manager: SessionManager, sessionId: string, predicate: (threads: SessionThread[]) => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const threads = manager.getThreadStore().listBySession(sessionId);
    if (predicate(threads)) return threads;
    if (Date.now() > deadline) return threads;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const types = (events: SessionEvent[]) => events.map((e) => e.type);

describe('coordinator send_to_agent', () => {
  let directory: string;
  let db: Database;
  let manager: SessionManager;
  let executor: ScriptedExecutor;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ma-coord-'));
    db = new Database(join(directory, 'test.db'));
    db.runMigrations();
    seedAgents(db);
    manager = new SessionManager(db);
    executor = new ScriptedExecutor(
      manager.getEventLogger(),
      (sessionId, threadId) => manager.getEventLogger().getThreadEvents(sessionId, threadId),
    );
    manager.setExecutor(executor);
  });

  afterEach(async () => {
    await manager.shutdown();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('mounts list_agents returning the roster and live threads', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    let raw = '';
    executor.script('coordinator', [{ listAgents: (out) => { raw = out; } }]);
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });
    await until(manager, session.id, (e) => e.some((x) => x.type === 'session.status_idle'));

    const parsed = JSON.parse(raw) as { agents: Array<{ name: string; agent_id: string }>; threads: unknown[] };
    expect(parsed.agents.map((a) => a.name)).toEqual(['reviewer']);
    expect(parsed.agents[0]!.agent_id).toBe('agent_worker');
    expect(parsed.threads).toEqual([]);
  });

  it('dispatches a child, runs it on its own chain, and returns the reply to the coordinator', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);

    // Coordinator turn 1: dispatch to reviewer, say "dispatched", idle.
    // Child turn: write a file, say "done", end_turn → reply goes back.
    // Coordinator turn 2 (re-entered by internal.thread_message): read the
    // file-visible reply and say its final answer.
    let coordinatorSecondMessages: unknown;
    executor.script('coordinator', [
      { sendToAgent: { agent: 'reviewer', message: 'review this' }, say: 'dispatched' },
      { captureMessages: (m) => { coordinatorSecondMessages = m; }, say: 'coordinator final' },
    ]);
    executor.script('reviewer', [
      { writeFile: { path: 'review.md', content: 'notes' }, say: 'done' },
    ]);

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'start' }] });

    // Wait for the full exchange: the child's reply must have been received and
    // the coordinator's second turn run.
    const events = await until(manager, session.id, (e) =>
      e.some((x) => x.type === 'agent.thread_message_received')
        && e.filter((x) => x.type === 'agent.message').length >= 3,
    );

    const childId = (await untilThreads(manager, session.id, (t) => t.length === 2))
      .find((t) => t.parentThreadId === primaryId)!.id;

    const prim = types(manager.getEventLogger().getPrimaryEvents(session.id));
    // §5 primary-stream order: created → sent → child running → child idle → received.
    const idx = (t: SessionEvent['type']) => prim.indexOf(t);
    expect(prim).toContain('session.thread_created');
    expect(prim).toContain('agent.thread_message_sent');
    expect(prim).toContain('session.thread_status_running');
    expect(prim).toContain('session.thread_status_idle');
    expect(prim).toContain('agent.thread_message_received');
    expect(idx('session.thread_created')).toBeLessThan(idx('agent.thread_message_sent'));

    // The child's status events are the ones about the child thread, on the
    // primary stream by cross-post.
    const childRunning = events.find((e) => e.type === 'session.thread_status_running' && e.metadata?.session_thread_id === childId);
    const childIdle = events.find((e) => e.type === 'session.thread_status_idle' && e.metadata?.session_thread_id === childId);
    expect(childRunning?.crossPosted).toBe(true);
    expect(childIdle?.crossPosted).toBe(true);
    expect(events.indexOf(childRunning!)).toBeLessThan(events.indexOf(childIdle!));
    // The reply `received` the primary stream sees is the one addressed to the
    // primary thread — the dispatch's `received` lives on the child's stream.
    expect(events.indexOf(childIdle!)).toBeLessThan(
      events.findIndex((e) => e.type === 'agent.thread_message_received' && e.threadId === primaryId),
    );

    // The reply came back to the coordinator and re-entered its chain — its
    // second turn's context carried `[来自 reviewer] done`.
    const received = events.find((e) => e.type === 'agent.thread_message_received' && e.threadId === primaryId);
    expect(received?.crossPosted).toBe(true);
    expect(received?.metadata?.from_agent_name).toBe('reviewer');
    expect(JSON.stringify(coordinatorSecondMessages)).toContain('[来自 reviewer] done');

    // The child ran on its own thread id, the coordinator twice on the primary.
    const coord = executor.invocations.filter((i) => i.threadId === primaryId);
    const child = executor.invocations.filter((i) => i.threadId === childId);
    expect(coord.map((i) => i.eventType)).toEqual(['user.message', 'internal.thread_message']);
    expect(child.map((i) => i.eventType)).toEqual(['internal.thread_message']);

    // The session aggregates back to idle once every thread is idle.
    await untilThreads(manager, session.id, (t) => t.every((x: SessionThread) => x.status === 'paused'));
    expect(manager.get(session.id)?.status).toBe('paused');
  });

  it('a follow-up to the same thread_id keeps its history', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);

    let childSecondMessages: unknown;
    executor.script('coordinator', [
      { sendToAgent: { agent: 'reviewer', message: 'first task' }, say: 'one' },
      { sendToAgent: { agent: 'reviewer', message: 'second task', thread_id: 'DYNAMIC' }, say: 'two' },
    ]);
    executor.script('reviewer', [
      { say: 'first done' },
      { captureMessages: (m) => { childSecondMessages = m; }, say: 'second done' },
    ]);

    // Resolve 'DYNAMIC' to the live child id at dispatch time. By the time the
    // coordinator's follow-up turn runs, the child row already exists — the
    // resolver reads the store rather than a captured variable, so the answer
    // does not depend on which side of the await the test is on.
    executor.resolveDynamicThread = () =>
      manager.getThreadStore().listBySession(session.id).find((t) => t.parentThreadId === primaryId)!.id;

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });

    // Coordinator turn 1 dispatches and idles; the child's reply re-enters the
    // coordinator for turn 2, which sends the follow-up onto the same thread.
    // The child's second reply lands on the primary as a second
    // thread_message_received — waiting for two proves the follow-up ran.
    const events = await until(manager, session.id, (e) =>
      e.filter((x) => x.type === 'agent.thread_message_received' && x.threadId === primaryId).length >= 2);

    // The child's second turn rebuilt context from its own thread — so the
    // first received message and its own "first done" reply are in its history.
    const projection = JSON.stringify(childSecondMessages);
    expect(projection).toContain('[来自 coordinator] first task');
    expect(projection).toContain('first done');
    expect(events.filter((x) => x.type === 'agent.thread_message_received' && x.threadId === primaryId)).toHaveLength(2);
  });

  it('runs two dispatched children concurrently', async () => {
    // Re-seed the coordinator with a two-member roster.
    db.prepare('UPDATE agents SET definition = ? WHERE id = ?').run(JSON.stringify(COORDINATOR2), 'agent_coordinator');
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);

    let relA!: () => void; let relB!: () => void;
    const gateA = new Promise<void>((r) => { relA = r; });
    const gateB = new Promise<void>((r) => { relB = r; });

    // One coordinator turn fans out to both members; each child holds on a gate.
    executor.script('coordinator', [{
      sendToAgents: [
        { agent: 'reviewer', message: 'task A' },
        { agent: 'reviewer2', message: 'task B' },
      ],
      say: 'dispatched both',
    }]);
    executor.script('reviewer', [{ hold: { promise: gateA, resolve: () => relA() }, say: 'A done' }]);
    executor.script('reviewer2', [{ hold: { promise: gateB, resolve: () => relB() }, say: 'B done' }]);

    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });
    const threads = await untilThreads(manager, session.id, (t) => t.length === 3);
    const children = threads.filter((t) => t.parentThreadId === primaryId);
    expect(children).toHaveLength(2);

    // Both children reach running before either goes idle — the concurrency the
    // 25-thread budget counts.
    await untilThreads(manager, session.id, () =>
      children.every((c) => manager.getThreadStore().get(c.id)?.status === 'running'),
    );
    const events = await until(manager, session.id, (e) =>
      e.filter((x) => x.type === 'session.thread_status_running'
        && children.some((c) => c.id === x.metadata?.session_thread_id)).length === 2,
    );
    const runningIdx = children.map((c) =>
      events.findIndex((e) => e.type === 'session.thread_status_running' && e.metadata?.session_thread_id === c.id));
    const idleIdx = events.findIndex((e) => e.type === 'session.thread_status_idle'
      && children.some((c) => c.id === e.metadata?.session_thread_id));
    expect(runningIdx.every((i) => i >= 0)).toBe(true);
    expect(idleIdx === -1 || Math.max(...runningIdx) < idleIdx).toBe(true);

    relA!(); relB!();
    await until(manager, session.id, (e) => e.filter((x) => x.type === 'agent.thread_message_received').length >= 2);
  });

  it('refuses the 26th concurrent child as a tool error', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    const primaryId = primaryThreadIdForSession(session.id);
    const store = manager.getThreadStore();
    // Fill the cap with synthetic children so dispatch must count 25.
    for (let i = 0; i < MAX_ACTIVE_CHILD_THREADS; i++) {
      store.insertThread({
        sessionId: session.id,
        parentThreadId: primaryId,
        agentName: 'reviewer',
        agentDefinition: WORKER,
        agentId: 'agent_worker',
        agentVersion: 1,
        status: 'running',
      });
    }
    // Drive a coordinator turn that attempts the over-cap dispatch.
    executor.script('coordinator', [{ sendToAgent: { agent: 'reviewer', message: 'one too many' }, say: 'tried' }]);
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });
    await until(manager, session.id, (e) => e.some((x) => x.type === 'session.status_idle'));

    expect(executor.sendResults.at(-1)).toContain('Concurrency limit');
    expect(store.listBySession(session.id).filter((t) => t.parentThreadId === primaryId)).toHaveLength(MAX_ACTIVE_CHILD_THREADS);
  });

  it('does not mount coordinator tools on a non-rostered child', async () => {
    const session = manager.create({ agent: 'agent_coordinator' });
    // Dispatch a child; the child's own turn must see no list_agents/send_to_agent.
    executor.script('coordinator', [{ sendToAgent: { agent: 'reviewer', message: 'go' }, say: 'dispatched' }]);
    executor.script('reviewer', [{ say: 'done' }]);
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'x' }] });
    await until(manager, session.id, (e) => e.some((x) => x.type === 'agent.thread_message_received'));
    // Reviewer has no multiagent, so the executor mounts no coordinator tools —
    // the roster gate is what keeps delegation to one level.
    expect(buildCoordinatorTools(WORKER, {} as never)).toEqual({});
  });

  /**
   * §4.3 session-status aggregation — one case per rule. Each drives the real
   * `recomputeSessionStatus` via a thread transition, asserting the session's
   * published `status` follows the threads', not a directly-written value.
   *
   * Baselines are written straight onto the thread row (`updateStatus`), which
   * bypasses the transition guard; the transition under test goes through
   * `updateThreadStatus`, the path that emits the event and recomputes.
   */
  describe('session-status aggregation (§4.3)', () => {
    const setThread = (sessionId: string, threadId: string, status: SessionStatus) =>
      (manager as any).updateThreadStatus(sessionId, threadId, status);
    const childOf = (sessionId: string, status: SessionStatus = 'paused') =>
      manager.getThreadStore().insertThread({
        sessionId,
        parentThreadId: primaryThreadIdForSession(sessionId),
        agentName: 'reviewer',
        agentDefinition: WORKER,
        agentId: 'agent_worker',
        agentVersion: 1,
        status,
      });
    const baseline = (sessionId: string, threadId: string, session: SessionStatus, thread: SessionStatus) => {
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(session, sessionId);
      manager.getThreadStore().updateStatus(threadId, thread);
    };

    it('a running child keeps the session running while the primary is idle', async () => {
      const session = manager.create({ agent: 'agent_coordinator' });
      const primaryId = primaryThreadIdForSession(session.id);
      const child = childOf(session.id, 'queued');
      baseline(session.id, primaryId, 'paused', 'paused');
      setThread(session.id, child.id, 'running');
      expect(manager.get(session.id)?.status).toBe('running');
    });

    it('a requires_action child surfaces as the session requires_action', () => {
      const session = manager.create({ agent: 'agent_coordinator' });
      const primaryId = primaryThreadIdForSession(session.id);
      baseline(session.id, primaryId, 'paused', 'paused');
      const child = childOf(session.id, 'running');
      setThread(session.id, child.id, 'requires_action');
      expect(manager.get(session.id)?.status).toBe('requires_action');
    });

    it('running outranks requires_action when both exist', () => {
      const session = manager.create({ agent: 'agent_coordinator' });
      const a = childOf(session.id, 'running');
      const b = childOf(session.id, 'running');
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('running', session.id);
      setThread(session.id, a.id, 'requires_action');
      // b is still running → the aggregate stays running, not requires_action.
      expect(manager.get(session.id)?.status).toBe('running');
      setThread(session.id, b.id, 'requires_action');
      expect(manager.get(session.id)?.status).toBe('requires_action');
    });

    it('all unarchived paused → session paused', () => {
      const session = manager.create({ agent: 'agent_coordinator' });
      const primaryId = primaryThreadIdForSession(session.id);
      const child = childOf(session.id, 'running');
      baseline(session.id, primaryId, 'running', 'running');
      setThread(session.id, primaryId, 'paused');
      setThread(session.id, child.id, 'paused');
      expect(manager.get(session.id)?.status).toBe('paused');
    });

    it('a terminal primary makes the session terminal regardless of children', () => {
      const session = manager.create({ agent: 'agent_coordinator' });
      const primaryId = primaryThreadIdForSession(session.id);
      childOf(session.id, 'running');
      baseline(session.id, primaryId, 'running', 'running');
      setThread(session.id, primaryId, 'completed');
      expect(manager.get(session.id)?.status).toBe('completed');
      // The still-running child cannot resurrect the aggregate.
      expect(manager.get(session.id)?.status).not.toBe('running');
    });
  });
});
