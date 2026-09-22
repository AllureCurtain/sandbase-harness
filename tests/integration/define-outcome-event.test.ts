/**
 * `user.define_outcome` over the wire, end to end.
 *
 * `contracts/anthropic-cma/sessions.md` §2 says creation accepts `user.define_outcome`,
 * that its payload is defaulted, and that only `user.message` and it are admitted. The
 * unit contract test pins the validator; this file pins the two seams a validator alone
 * cannot prove: that the admitted payload reaches the event log (which has no per-type
 * payload column, so it rides in `metadata`) and comes back projected on the listing,
 * and that a live event with a payload the runtime will not honour is refused with its
 * own code rather than stored as sent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';

describe('user.define_outcome over the API', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setupApp(): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-define-outcome-'));
    const skillsDir = join(tmpDir, 'skills');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    // The creation path resolves the agent from the store, so the fixture writes the
    // row rather than only handing a definition to the server.
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo-agent',
      'echo-agent',
      JSON.stringify({ name: 'echo-agent', model: 'gpt-4o', system: 'You are a test agent.', tools: [] }),
    );
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    // A declared outcome is admissible only on a runtime that can measure it, so
    // this file registers a grader: its subject is the wire shape of the event,
    // and the refusal a grader-less runtime answers is pinned in
    // tests/integration/outcome-loop.test.ts. No executor is registered, so
    // nothing grades here.
    const sessionManager = new SessionManager(db);
    sessionManager.setOutcomeGrader({
      grade: async () => ({ result: 'satisfied', explanation: 'nothing to check' }),
    });
    app = createServer({
      db,
      sessionManager,
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
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  /** Create a session with the initial events given. */
  async function createSession(initialEvents?: unknown) {
    return post('/v1/sessions', {
      agent: 'agent_echo-agent',
      loop_engine: 'builtin',
      ...(initialEvents === undefined ? {} : { initial_events: initialEvents }),
    });
  }

  it('writes an initial outcome to the log and projects it on the listing', async () => {
    setupApp();

    const created = await createSession([
      { type: 'user.message', content: 'Please define the outcome.' },
      {
        type: 'user.define_outcome',
        description: 'Ship a working endpoint',
        rubric: { type: 'text', content: 'The endpoint returns 200' },
      },
    ]);
    expect(created.res.status).toBe(201);
    expect(created.body).not.toHaveProperty('initial_events');

    const events = await get(`/v1/sessions/${created.body.id}/events`);
    expect(events.res.status).toBe(200);
    const outcome = events.body.data.find((event: any) => event.type === 'user.define_outcome');
    expect(outcome, 'the outcome event is in the log').toBeDefined();
    expect(outcome.description).toBe('Ship a working endpoint');
    expect(outcome.rubric).toEqual({ type: 'text', content: 'The endpoint returns 200' });
    // Defaulted at admission, so the stored event carries a budget rather than null.
    expect(outcome.max_iterations).toBe(3);
  });

  it('accepts a live outcome event and refuses a malformed one with its own code', async () => {
    setupApp();

    const created = await createSession();
    expect(created.res.status).toBe(201);
    const path = `/v1/sessions/${created.body.id}/events`;

    const bad = await post(path, {
      events: [{ type: 'user.define_outcome', description: '   ', rubric: { type: 'text', content: 'x' } }],
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_define_outcome');
    expect(bad.body.error.message).toContain('description is required');

    const outOfRange = await post(path, {
      events: [{
        type: 'user.define_outcome',
        description: 'Ship it',
        rubric: { type: 'text', content: 'x' },
        max_iterations: 21,
      }],
    });
    expect(outOfRange.res.status).toBe(400);
    // Rejected rather than clamped: lowering a caller's budget silently would change
    // how much work the outcome may do.
    expect(outOfRange.body.error.message).toContain('between 1 and 20');

    const good = await post(path, {
      events: [{
        type: 'user.define_outcome',
        description: 'Ship it',
        rubric: { type: 'file', file_id: 'file_rubric' },
        max_iterations: 5,
      }],
    });
    expect(good.res.status).toBe(200);
    expect(good.body.accepted).toBe(true);

    const events = await get(path);
    const outcomes = events.body.data.filter((event: any) => event.type === 'user.define_outcome');
    // The rejected payloads left nothing behind: one accepted event, not three.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].description).toBe('Ship it');
    expect(outcomes[0].rubric).toEqual({ type: 'file', file_id: 'file_rubric' });
    expect(outcomes[0].max_iterations).toBe(5);
  });

  it('rejects a creation whose outcome payload is malformed, leaving no session behind', async () => {
    setupApp();

    const created = await createSession([{ type: 'user.define_outcome', description: 'Ship it' }]);
    expect(created.res.status).toBe(400);
    expect(created.body.error.code).toBe('invalid_initial_events');
    expect(created.body.error.message).toContain('initial_events[0].rubric is required');

    const sessions = await get('/v1/sessions');
    expect(sessions.body.data).toEqual([]);
  });
});
