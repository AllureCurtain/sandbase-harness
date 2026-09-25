/**
 * `GET /v1/sessions/{id}/events` serves the published envelope.
 *
 * The route used to answer `{data, has_more, first_id, last_id}`. Three of those four
 * names appear **nowhere** in the published contract — a search of the published
 * documentation returns zero occurrences of `has_more` and `first_id`, against 34 of
 * `next_page` — so a client built against the published contract read `next_page` from
 * this listing, found nothing, and could not page. `pagination.md` §4 had already
 * described this route as carrying `{session_id, after_id}` in its cursor; the route
 * never did.
 *
 * These tests assert the published field names, that the cursor can actually be
 * followed to the end of the log without repeats, and that a cursor this route did not
 * issue is refused rather than answered — a silent restart from the beginning is the
 * one failure a paging client cannot detect.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { encodeCursor } from '@/api/standard.js';

const EVENTS_LIST_ORDER = 'events.appended ASC';

describe('session events listing envelope', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-events-envelope-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      `INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{"sandbox_provider":"local"}')`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{
         "name":"x","model":"gpt-4o-mini","instructions":"test",
         "tools":[{"type":"agent_toolset_20260401"}]
       }')`,
    ).run();

    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [{ id: 'agent_x', name: 'x', model: 'gpt-4o-mini', instructions: 'test' } as any],
      skills: [],
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: tmpDir,
        skillsDir: tmpDir,
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a session with `count` user messages, so its log has a known length. */
  async function sessionWithEvents(count: number): Promise<string> {
    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'agent_x',
        initial_events: Array.from({ length: count }, (_, index) => ({
          type: 'user.message',
          content: `message ${index}`,
        })),
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  async function listEvents(path: string) {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  }

  it('serves the published envelope, not the local one', async () => {
    const sessionId = await sessionWithEvents(3);
    const { status, body } = await listEvents(`/v1/sessions/${sessionId}/events`);

    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('prev_page');
    expect(body).toHaveProperty('next_page');
    expect(body).not.toHaveProperty('has_more');
    expect(body).not.toHaveProperty('first_id');
    expect(body).not.toHaveProperty('last_id');
    // The whole log fits in one page, so the envelope says so with nulls rather than
    // with a `has_more: false` a published client cannot read.
    expect(body.prev_page).toBeNull();
    expect(body.next_page).toBeNull();
  });

  it('walks next_page to the end of the log, yielding every event exactly once', async () => {
    const sessionId = await sessionWithEvents(5);
    const all = await listEvents(`/v1/sessions/${sessionId}/events`);
    const expected = all.body.data.map((event: any) => event.id);
    expect(expected.length).toBeGreaterThanOrEqual(5);

    const walked: string[] = [];
    let page = all.body.next_page;
    let current = await listEvents(`/v1/sessions/${sessionId}/events?limit=2`);
    expect(current.body.prev_page).toBeNull();
    expect(current.body.data).toHaveLength(2);

    // No page repeats a row from the previous one.
    let previousIds = new Set<string>();
    let guard = 0;
    while (true) {
      const ids = current.body.data.map((event: any) => event.id);
      for (const id of ids) {
        expect(previousIds.has(id), `row ${id} repeated on a later page`).toBe(false);
        walked.push(id);
      }
      previousIds = new Set(ids);
      page = current.body.next_page;
      if (page === null) break;
      expect(typeof page).toBe('string');
      guard += 1;
      expect(guard, 'the walk did not terminate').toBeLessThan(50);
      current = await listEvents(
        `/v1/sessions/${sessionId}/events?limit=2&page=${encodeURIComponent(page)}`,
      );
      expect(current.status).toBe(200);
      // A forward-only scan cannot name its predecessor; an invented cursor would not
      // resolve, so the honest answer is null on every page.
      expect(current.body.prev_page).toBeNull();
    }

    expect(walked).toEqual(expected);
  });

  it('refuses a cursor issued for another session, and follows it on its own', async () => {
    const first = await sessionWithEvents(3);
    const second = await sessionWithEvents(3);
    const page = (await listEvents(`/v1/sessions/${first}/events?limit=1`)).body.next_page;
    expect(typeof page).toBe('string');

    const foreign = await listEvents(
      `/v1/sessions/${second}/events?limit=1&page=${encodeURIComponent(page)}`,
    );
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.type).toBe('invalid_request_error');
    expect(foreign.body.error.message).toContain('different filter');

    // The same cursor still works on the session that issued it: the refusal is about
    // the session, not about the cursor.
    const own = await listEvents(
      `/v1/sessions/${first}/events?limit=1&page=${encodeURIComponent(page)}`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0].id).not.toBe(
      (await listEvents(`/v1/sessions/${first}/events?limit=1`)).body.data[0].id,
    );
  });

  it('refuses a page it cannot have issued rather than restarting from the first event', async () => {
    const sessionId = await sessionWithEvents(3);

    const malformed = await listEvents(`/v1/sessions/${sessionId}/events?page=not-a-cursor`);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toContain('page must be a cursor returned by this endpoint');

    // A well-formed cursor naming an event this log does not contain is not one this
    // route issued. Answering the whole log would look like "the page after your
    // position" and the caller could not tell.
    const unknown = encodeCursor({
      order: EVENTS_LIST_ORDER,
      filter: { session_id: sessionId },
      after_id: 'evt_never_existed',
    });
    const refused = await listEvents(`/v1/sessions/${sessionId}/events?page=${encodeURIComponent(unknown)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('page must be a cursor returned by this endpoint');

    // The ordering is bound too, so a cursor from the session listing is not applied to
    // the event log.
    const otherOrder = encodeCursor({ order: 'created_at DESC', after_id: 'evt_x' });
    const mismatched = await listEvents(
      `/v1/sessions/${sessionId}/events?page=${encodeURIComponent(otherOrder)}`,
    );
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error.message).toContain('different ordering');
  });

  it('keeps limit and after_id selecting the same events they selected before', async () => {
    const sessionId = await sessionWithEvents(4);
    const all = (await listEvents(`/v1/sessions/${sessionId}/events`)).body.data as any[];
    expect(all.length).toBeGreaterThanOrEqual(4);

    const limited = await listEvents(`/v1/sessions/${sessionId}/events?limit=2`);
    expect(limited.body.data.map((event: any) => event.id)).toEqual(all.slice(0, 2).map((event) => event.id));

    const after = await listEvents(
      `/v1/sessions/${sessionId}/events?after_id=${encodeURIComponent(all[0].id)}`,
    );
    expect(after.body.data.map((event: any) => event.id)).toEqual(all.slice(1).map((event) => event.id));

    // An unknown raw after_id keeps its old meaning: everything this log has. Only the
    // cursor path refuses, because only there did the server promise the position.
    const unknownAfter = await listEvents('/v1/sessions/' + sessionId + '/events?after_id=evt_nope');
    expect(unknownAfter.status).toBe(200);
    expect(unknownAfter.body.data).toHaveLength(all.length);
  });

  it('still refuses a parameter it does not implement, and accepts page', async () => {
    const sessionId = await sessionWithEvents(1);
    const refused = await listEvents(`/v1/sessions/${sessionId}/events?bogus=1`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('bogus');
    expect(refused.body.error.message).toContain('page');
  });
});
