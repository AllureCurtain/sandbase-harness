/**
 * The declared-outcome revision loop through a real session.
 *
 * `contracts/anthropic-cma/sessions.md` §2 says a `needs_revision` verdict
 * appends the explanation as a real `user.message` and runs another turn inside
 * the same outcome, bounded by the declared `max_iterations`; that an interrupt
 * closes the outcome as `interrupted` without a `session.error`; and that a
 * runtime which composes no grader refuses the declaration at admission. The
 * unit test pins the loop's control flow in isolation, so this file pins the
 * seams it cannot reach: that `SessionManager.runTurn` drives the loop over the
 * session's own log, re-enters the executor for every revision, and answers the
 * refusal as a 400 on both ingress paths without writing anything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import {
  SessionManager,
  type ExecuteOptions,
  type SessionExecutor,
} from '@/core/session/session-manager.js';
import type { EventLogger } from '@/core/session/event-logger.js';
import type { OutcomeGrade, OutcomeGradeInput } from '@/core/outcomes/grader.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';

const OUTCOME_EVENT = {
  type: 'user.define_outcome',
  description: 'Ship a working endpoint',
  rubric: { type: 'text', content: 'The endpoint returns 200' },
  max_iterations: 3,
} as const;

const NEEDS_REVISION: OutcomeGrade = { result: 'needs_revision', explanation: 'The response body is empty.' };
const SATISFIED: OutcomeGrade = { result: 'satisfied', explanation: 'The endpoint returns 200.' };

/** A scripted agent: one turn per call, with the stops a test asks for. */
class ScriptedExecutor implements SessionExecutor {
  readonly turns: string[] = [];

  constructor(
    private readonly logger: EventLogger,
    private readonly script: {
      /** Turn number (1-based) that stops for a tool confirmation. */
      requireActionOnTurn?: number;
      /** Turn number (1-based) during which the caller interrupts the session. */
      interruptOnTurn?: number;
    } = {},
    private readonly hooks: { interrupt?: () => Promise<void> } = {},
  ) {}

  async *execute(session: Session, _event: UserEvent, options?: ExecuteOptions): AsyncIterable<SessionEvent> {
    const turn = this.turns.length + 1;
    this.turns.push(`turn ${turn}`);

    if (this.script.interruptOnTurn === turn) {
      // The interrupt lands while the turn is running, which is exactly the case
      // the loop has to notice before it measures anything.
      await this.hooks.interrupt?.();
      return;
    }
    if (this.script.requireActionOnTurn === turn) {
      options?.onRequiresAction?.();
      return;
    }
    yield this.logger.append(session.id, {
      type: 'agent.message',
      content: [{ type: 'text', text: `attempt ${turn}` }],
    });
  }

  async cleanupSession(): Promise<void> {}
}

function textOf(event: SessionEvent): string {
  return (event.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}


describe('declared outcome revision loop', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let executor: ScriptedExecutor;
  let grades: OutcomeGrade[];
  let graded: OutcomeGradeInput[];
  let interruptTarget: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-outcome-loop-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')`);
    manager = new SessionManager(db);
    grades = [];
    graded = [];
    interruptTarget = undefined;
    manager.setOutcomeGrader({
      grade: async (input) => {
        const grade = grades[Math.min(graded.length, grades.length - 1)];
        graded.push(input);
        return grade;
      },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function useExecutor(
    script: ConstructorParameters<typeof ScriptedExecutor>[1] = {},
    hooks: ConstructorParameters<typeof ScriptedExecutor>[2] = {},
  ): void {
    executor = new ScriptedExecutor(manager.getEventLogger(), script, hooks);
    manager.setExecutor(executor);
  }

  /** Wait until the session leaves the running state, or fail loudly. */
  async function settle(sessionId: string): Promise<Session> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const session = manager.get(sessionId);
      if (session && session.status !== 'running' && session.status !== 'queued') return session;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Session ${sessionId} never stopped running (status: ${manager.get(sessionId)?.status})`);
  }

  function eventsOf(sessionId: string): SessionEvent[] {
    return manager.getEventLogger().getEvents(sessionId);
  }

  function spansOf(events: SessionEvent[]): SessionEvent[] {
    return events.filter((event) => event.type.startsWith('span.outcome_evaluation'));
  }

  function endsOf(events: SessionEvent[]): SessionEvent[] {
    return events.filter((event) => event.type === 'span.outcome_evaluation_end');
  }

  function revisionsOf(events: SessionEvent[]): SessionEvent[] {
    return events.filter((event) => event.type === 'user.message');
  }

  it('re-runs the turn with the grader feedback as a real user message', async () => {
    useExecutor();
    grades = [NEEDS_REVISION, SATISFIED];

    const session = manager.createWithInitialEvents({ agent: 'agent_x' }, [OUTCOME_EVENT as UserEvent]);
    await settle(session.id);

    // Turn 1 is the declaration's own turn; turn 2 is the revision the verdict owed.
    expect(executor.turns).toEqual(['turn 1', 'turn 2']);

    const events = eventsOf(session.id);
    const revisions = revisionsOf(events);
    expect(revisions).toHaveLength(1);
    expect(textOf(revisions[0])).toContain('The response body is empty.');
    expect(textOf(revisions[0])).toContain('Ship a working endpoint');

    // One triple per evaluation, with `iteration` counting from 0.
    expect(spansOf(events).map((event) => event.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
    ]);
    expect(endsOf(events).map((event) => event.metadata)).toMatchObject([
      { iteration: 0, result: 'needs_revision' },
      { iteration: 1, result: 'satisfied' },
    ]);

    // The second evaluation measured the revision, and the grader still sees only
    // what the agent produced: its own feedback is not part of the transcript.
    expect(graded).toHaveLength(2);
    expect(graded[1].transcript).toContain('attempt 2');
    expect(graded[1].transcript).not.toContain('The response body is empty.');

    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(manager.get(session.id)?.status).toBe('paused');
  });

  it('reports the spent budget instead of asking for a revision, then settles', async () => {
    useExecutor();
    grades = [NEEDS_REVISION];

    const session = manager.createWithInitialEvents({ agent: 'agent_x' }, [
      { ...OUTCOME_EVENT, max_iterations: 2 } as UserEvent,
    ]);
    await settle(session.id);

    // The declaration turn, one revision turn, and the final turn the spent
    // budget still allows so the agent can settle its answer.
    expect(executor.turns).toHaveLength(3);

    const events = eventsOf(session.id);
    expect(endsOf(events).map((event) => event.metadata)).toMatchObject([
      { iteration: 0, result: 'needs_revision' },
      { iteration: 1, result: 'max_iterations_reached' },
    ]);
    // The budget, not the grader, is what stopped the loop: no third evaluation.
    expect(spansOf(events).filter((event) => event.type === 'span.outcome_evaluation_start')).toHaveLength(2);
    const revisions = revisionsOf(events);
    expect(revisions).toHaveLength(2);
    expect(textOf(revisions[revisions.length - 1])).toContain('iteration budget for this outcome is spent');
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(manager.get(session.id)?.status).toBe('paused');
  });

  it('closes an interrupted outcome as interrupted without a session error', async () => {
    useExecutor(
      { interruptOnTurn: 2 },
      {
        interrupt: async () => {
          await manager.sendEvent(interruptTarget!, { type: 'user.interrupt' } as UserEvent);
        },
      },
    );
    grades = [NEEDS_REVISION, SATISFIED];

    const created = manager.createWithInitialEvents({ agent: 'agent_x' }, [OUTCOME_EVENT as UserEvent]);
    interruptTarget = created.id;
    await settle(created.id);

    // The revision turn started and was stopped, so nothing after it ran.
    expect(executor.turns).toEqual(['turn 1', 'turn 2']);

    const events = eventsOf(created.id);
    const ends = endsOf(events);
    expect(ends).toHaveLength(2);
    expect(ends[0].metadata).toMatchObject({ iteration: 0, result: 'needs_revision' });
    // The interrupt close is not tied to one evaluation, so it names no start span.
    expect(ends[1].metadata).toMatchObject({
      iteration: 1,
      result: 'interrupted',
      outcome_evaluation_start_id: '',
    });
    // Nothing measured the stopped turn, and the stop is not reported as an error.
    expect(spansOf(events).filter((event) => event.type === 'span.outcome_evaluation_start')).toHaveLength(1);
    expect(revisionsOf(events)).toHaveLength(1);
    expect(events.some((event) => event.type === 'user.interrupt')).toBe(true);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(manager.get(created.id)?.status).toBe('paused');
  });

  it('ends the outcome when a revision turn stops for a tool confirmation', async () => {
    useExecutor({ requireActionOnTurn: 2 });
    grades = [NEEDS_REVISION, SATISFIED];

    const session = manager.createWithInitialEvents({ agent: 'agent_x' }, [OUTCOME_EVENT as UserEvent]);
    await settle(session.id);

    // The incomplete turn is not graded and no third turn is started while the
    // session waits on a human.
    expect(executor.turns).toEqual(['turn 1', 'turn 2']);
    const events = eventsOf(session.id);
    expect(endsOf(events).map((event) => event.metadata)).toMatchObject([
      { iteration: 0, result: 'needs_revision' },
      { iteration: 1, result: 'interrupted', outcome_evaluation_start_id: '' },
    ]);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(manager.get(session.id)?.status).toBe('requires_action');
  });
});

describe('a declared outcome on a runtime that composes no grader', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  const declaration = {
    type: 'user.define_outcome',
    description: 'Ship a working endpoint',
    rubric: { type: 'text', content: 'The endpoint returns 200' },
  };

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setupApp(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-outcome-no-grader-'));
    const skillsDir = join(tmpDir, 'skills');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo-agent',
      'echo-agent',
      JSON.stringify({ name: 'echo-agent', model: 'gpt-4o', system: 'You are a test agent.', tools: [] }),
    );
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    // No setOutcomeGrader: this is the runtime the refusal is about, so the
    // declaration is refused rather than accepted and left unmeasured.
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      skills: loadSkills(skillsDir).skills,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir,
        target: 'local',
      },
    });
  }

  async function post(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as any };
  }

  it('refuses an initial declaration instead of creating a session it cannot measure', async () => {
    setupApp();

    const created = await post('/v1/sessions', {
      agent: 'agent_echo-agent',
      loop_engine: 'builtin',
      initial_events: [declaration],
    });

    expect(created.res.status).toBe(400);
    expect(created.body.error).toMatchObject({ code: 'outcome_grader_unavailable' });

    // The refusal happens inside the creation transaction, so nothing survives it:
    // no session row and no event, which is stronger than refusing the batch.
    const sessions = await app.request('/v1/sessions');
    expect(((await sessions.json()) as any).data).toHaveLength(0);
    const events = db!.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
    expect(events.count).toBe(0);
  });

  it('refuses a live declaration with the same code and writes nothing', async () => {
    setupApp();

    const created = await post('/v1/sessions', { agent: 'agent_echo-agent', loop_engine: 'builtin' });
    expect(created.res.status).toBe(201);

    const refused = await post(`/v1/sessions/${created.body.id}/events`, { events: [declaration] });
    expect(refused.res.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'outcome_grader_unavailable' });

    const events = await app.request(`/v1/sessions/${created.body.id}/events`);
    const listing = (await events.json()) as any;
    expect(listing.data.some((event: any) => event.type === 'user.define_outcome')).toBe(false);
  });
});
