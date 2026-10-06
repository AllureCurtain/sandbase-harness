/**
 * `redacted` content-block parity, end to end.
 *
 * The published contract uses `{type: "redacted"}` as the placeholder for
 * content withheld by model policy. It is a runtime output — `agent.message`
 * and replayed `user.message` content may carry it and the log keeps it
 * verbatim — but it is never client input: every user-facing ingress that
 * accepts a content-block array refuses one with 400 rather than persisting a
 * claim the model withheld content it never produced.
 *
 * The refusal is pinned on every ingress that takes user content —
 * `POST /v1/sessions` `initial_events`, `POST /v1/sessions/{id}/messages`,
 * the `POST /v1/sessions/{id}/events` batch (including a nested `tool_result`
 * on `user.custom_tool_result`), and `POST /v1/runs` `input` — plus the read
 * side, where a persisted redacted block round-trips through the event
 * listing unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';

const REDACTED = { type: 'redacted' };

describe('redacted content blocks over the API', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-redacted-'));
    const skillsDir = join(tmpDir, 'skills');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_echo-agent',
      'echo-agent',
      JSON.stringify({ name: 'echo-agent', model: 'gpt-4o', system: 'You are a test agent.', tools: [] }),
    );
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
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
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  async function createSession(initialEvents?: unknown) {
    return post('/v1/sessions', {
      agent: 'agent_echo-agent',
      loop_engine: 'builtin',
      ...(initialEvents === undefined ? {} : { initial_events: initialEvents }),
    });
  }

  it('refuses a redacted block in initial_events before the session exists', async () => {
    setupApp();

    const created = await createSession([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }, REDACTED] },
    ]);
    expect(created.res.status).toBe(400);
    expect(created.body.error.code).toBe('invalid_initial_events');
    expect(created.body.error.message).toContain('initial_events[0].content[1].type');
    expect(created.body.error.message).toContain('redacted');

    const listed = await get('/v1/sessions');
    expect(listed.body.data ?? listed.body).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ agent: expect.objectContaining({ id: 'agent_echo-agent' }) }),
    ]));
  });

  it('refuses a redacted block on POST /messages', async () => {
    setupApp();
    const created = await createSession();
    expect(created.res.status).toBe(201);

    const sent = await post(`/v1/sessions/${created.body.id}/messages`, {
      content: [REDACTED],
      stream: false,
    });
    expect(sent.res.status).toBe(400);
    expect(sent.body.error.message).toContain('redacted');

    const events = await get(`/v1/sessions/${created.body.id}/events`);
    expect(
      events.body.data.filter((event: any) => event.type === 'user.message'),
      'the refused message never reaches the log',
    ).toHaveLength(0);
  });

  it('refuses redacted on the /events batch for user.message and nested custom_tool_result content', async () => {
    setupApp();
    const created = await createSession();
    expect(created.res.status).toBe(201);
    const path = `/v1/sessions/${created.body.id}/events`;

    const message = await post(path, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }, REDACTED] }],
    });
    expect(message.res.status).toBe(400);
    expect(message.body.error.message).toContain('user.message');
    expect(message.body.error.message).toContain('redacted');

    const nested = await post(path, {
      events: [{
        type: 'user.custom_tool_result',
        custom_tool_use_id: 'customu_x',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [REDACTED] }],
      }],
    });
    expect(nested.res.status).toBe(400);
    expect(nested.body.error.message).toContain('content[0].content[0]');
  });

  it('refuses a redacted block on POST /v1/runs input', async () => {
    setupApp();

    const run = await post('/v1/runs', {
      agent: 'agent_echo-agent',
      loop_engine: 'builtin',
      input: [REDACTED],
      response_mode: 'async',
    });
    expect(run.res.status).toBe(400);
    expect(run.body.error.message).toContain('input[0].type');
    expect(run.body.error.message).toContain('redacted');
  });

  it('keeps a persisted redacted block verbatim on the event listing', async () => {
    setupApp();
    const created = await createSession();
    expect(created.res.status).toBe(201);
    const sessionId = created.body.id as string;

    // The block is runtime output, so the fixture writes the log row the way a
    // policy-withheld model reply would have persisted it.
    db!.prepare(
      `INSERT INTO events (id, session_id, seq, type, content) VALUES (?, ?, 999, 'agent.message', ?)`,
    ).run(
      'evt_redacted-1',
      sessionId,
      JSON.stringify([{ type: 'text', text: 'partial' }, REDACTED]),
    );

    const events = await get(`/v1/sessions/${sessionId}/events`);
    expect(events.res.status).toBe(200);
    const message = events.body.data.find((event: any) => event.id === 'evt_redacted-1');
    expect(message.content).toEqual([{ type: 'text', text: 'partial' }, REDACTED]);
  });
});
