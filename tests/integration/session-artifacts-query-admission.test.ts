/**
 * `GET /v1/sessions/{id}/artifacts` refuses query parameters it does not implement.
 *
 * The listing read no parameter and ignored every one, so `?limit=5&page=2` answered `200`
 * with the whole unwindowed collection — a caller could page the response and be handed
 * everything, which is the silently-unscoped answer `query-params.ts` exists to remove.
 * Every other canonical `/v1` listing already refuses an unimplemented parameter by name.
 *
 * Two measurements made the refusal safe rather than the trap it was held back for:
 *
 * - The published documentation never names this listing: `artifacts` has **zero**
 *   occurrences in the docs tree. So there is no documented parameter that refusing could
 *   reject, which is what `errors.md` §4 required checking before covering a route that
 *   reads no parameter.
 * - No caller sends one: `src/sdk/client.ts:660` requests the bare path, and a repository
 *   search for `artifacts?` finds no call site.
 *
 * The ordering rule is `query-params.ts:18`: the check runs before resource lookup, so a
 * malformed request is reported as malformed rather than as a missing resource.
 *
 * Two of these cases pass with or without the change — the bare request and the `beta`
 * compatibility case — and are therefore not evidence that the refusal exists; the first,
 * second and fifth do the work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('session artifacts listing query-parameter admission', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-artifacts-admission-'));
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

  async function addArtifact(sessionId: string, name: string): Promise<void> {
    const res = await app.request(`/v1/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `/artifacts/${name}`, content: `body of ${name}` }),
    });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(201);
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  }

  it('refuses an unimplemented parameter by name instead of ignoring it', async () => {
    const sessionId = await newSession();
    await addArtifact(sessionId, 'one.txt');

    const { status, body } = await get(`/v1/sessions/${sessionId}/artifacts?limit=5`);

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Unknown query parameter "limit"');
    expect(body.error.message).toContain('accepts no query parameters');
    // The refusal is not an envelope: a caller must not read a rejected page as an
    // empty page and conclude the session has no artifacts.
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('next_page');
  });

  it('names every unimplemented parameter, with the plural wording', async () => {
    const sessionId = await newSession();

    const { status, body } = await get(
      `/v1/sessions/${sessionId}/artifacts?limit=5&page=2&anything=1`,
    );

    expect(status).toBe(400);
    expect(body.error.message).toContain('Unknown query parameters');
    for (const name of ['limit', 'page', 'anything']) {
      expect(body.error.message).toContain(`"${name}"`);
    }
  });

  it('still accepts the compatibility parameter without advertising it', async () => {
    const sessionId = await newSession();
    await addArtifact(sessionId, 'two.txt');

    const { status, body } = await get(`/v1/sessions/${sessionId}/artifacts?beta=true`);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.next_page).toBeNull();
    // Accepted is not implemented, and it is not in the accepts list either.
    expect(JSON.stringify(body)).not.toContain('beta');
  });

  it('leaves a bare request unchanged', async () => {
    const sessionId = await newSession();
    await addArtifact(sessionId, 'three.txt');

    const { status, body } = await get(`/v1/sessions/${sessionId}/artifacts`);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].artifact_path).toBe('/artifacts/three.txt');
    expect(body.prev_page).toBeNull();
    expect(body.next_page).toBeNull();
  });

  it('refuses the parameter before looking the session up', async () => {
    const malformed = await get('/v1/sessions/sess_missing/artifacts?limit=5');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toContain('Unknown query parameter "limit"');

    // The other direction: with no parameter the missing session is still a 404, so the
    // admission did not replace the lookup.
    const bare = await get('/v1/sessions/sess_missing/artifacts');
    expect(bare.status).toBe(404);
    expect(bare.body.error.type).toBe('not_found');
  });
});
