/**
 * `GET /v1/sessions/{id}/artifacts` serves the published envelope.
 *
 * The listing answered `{data, has_more, first_id, last_id}`. `has_more` and `first_id`
 * occur **nowhere** in the published contract (measured: zero occurrences, against 34 for
 * `next_page`), so a client built against the published documentation could not read this
 * response's pagination fields at all. It was the last canonical `/v1` collection on the
 * local envelope.
 *
 * The listing returns its whole set unwindowed, so both cursors are null — the documented
 * shape for a complete-set canonical collection. Windowing it would be a separate
 * behaviour, so these tests also pin that the conversion did not start cutting pages.
 *
 * Row *order* is deliberately not asserted: `created_at` is `datetime('now')` with second
 * granularity and this query has no tie-break, so two artifacts created in the same second
 * have an unspecified relative order. That reorders an unwindowed page but cannot drop a
 * row from it, which is why it is not part of this change.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('session artifacts listing envelope', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-artifacts-envelope-'));
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

  async function newSession(): Promise<string> {
    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_x' }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  /** Create an artifact through the published route, and return its id. */
  async function addArtifact(sessionId: string, name: string): Promise<string> {
    const res = await app.request(`/v1/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `/artifacts/${name}`, content: `body of ${name}` }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  async function listArtifacts(sessionId: string) {
    const res = await app.request(`/v1/sessions/${sessionId}/artifacts`);
    return { status: res.status, body: (await res.json()) as any };
  }

  it('serves the published envelope, not the local one', async () => {
    const sessionId = await newSession();
    const artifactId = await addArtifact(sessionId, 'notes.txt');

    const { status, body } = await listArtifacts(sessionId);
    expect(status).toBe(200);
    expect(body.data.map((row: any) => row.id)).toEqual([artifactId]);
    expect(body).toHaveProperty('prev_page');
    expect(body).toHaveProperty('next_page');
    expect(body).not.toHaveProperty('has_more');
    expect(body).not.toHaveProperty('first_id');
    expect(body).not.toHaveProperty('last_id');
  });

  it('keeps returning the complete set, unwindowed, after the conversion', async () => {
    const sessionId = await newSession();
    const first = await addArtifact(sessionId, 'one.txt');
    const second = await addArtifact(sessionId, 'two.txt');

    const { body } = await listArtifacts(sessionId);
    // Set equality rather than order: see the note at the top of this file.
    expect(new Set(body.data.map((row: any) => row.id))).toEqual(new Set([first, second]));
    expect(body.data).toHaveLength(2);
    // A complete set says so with nulls. Windowing this listing is a separate change, so
    // neither cursor may appear just because the envelope was converted.
    expect(body.prev_page).toBeNull();
    expect(body.next_page).toBeNull();
  });

  it('returns the published empty shape for a session with no artifacts', async () => {
    const sessionId = await newSession();
    const { status, body } = await listArtifacts(sessionId);

    expect(status).toBe(200);
    expect(body).toEqual({ data: [], prev_page: null, next_page: null });
    expect(body).not.toHaveProperty('has_more');
    expect(body).not.toHaveProperty('first_id');
    expect(body).not.toHaveProperty('last_id');
  });

  it('still returns 404 for a session that does not exist', async () => {
    const res = await app.request('/v1/sessions/sess_missing/artifacts');
    expect(res.status).toBe(404);
  });
});
