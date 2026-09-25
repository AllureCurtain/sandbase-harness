/**
 * A session created with resources holds them as instances.
 *
 * `POST /v1/sessions` accepted `resources`, stored them in the session's own column, and
 * created **no** resource instances, so the documented resource surface was unreachable for
 * every session the runtime had ever created. Measured at `e8c021bc` against a live listener:
 *
 *   POST /v1/sessions {resources: [{type: 'github_repository', …}]}  ->  201
 *   GET  /v1/sessions/{id}/resources                                 ->  200 {"data": []}
 *   SELECT COUNT(*) FROM session_resource_instances                  ->  0
 *
 * `session.resources` is the declaration the sandbox mounts; the resource API addresses
 * *instances*, each with its own `sesrsc_` id, and that distinction is load-bearing — a file
 * resource can be added and removed while a session runs, and a GitHub resource's id is what a
 * token rotation addresses. A session whose declaration exists but whose instances do not can
 * never rotate, detach, or read back a resource: `DELETE /v1/sessions/{id}/resources/{rid}` had
 * no id to accept.
 *
 * The attachment happens in `SessionManager.create` rather than in each route, because only two
 * of the four creation paths can use `createWithInitialEvents` — the `sse` and `wait` run modes
 * create the session and stream the reply, and cannot hand the events to it. A per-route hook
 * is what left the instance table empty in the first place.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { listSessionResources } from '@/core/session/session-resources.js';
import { createServer } from '@/api/server.js';

describe('session resource instances at creation', () => {
  let db: Database;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let app: ReturnType<typeof createServer>;

  const repositoryResource = () => ({
    type: 'github_repository',
    url: 'https://github.com/example/repo',
    authorization_token: 'ghp_probe',
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-attach-'));
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

    sessionManager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager,
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

  async function post(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  }

  it('records a created session\'s resources as addressable instances', async () => {
    const created = await post('/v1/sessions', { agent: 'agent_x', resources: [repositoryResource()] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const listed = await get(`/v1/sessions/${created.body.id}/resources`);

    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    const instance = listed.body.data[0];
    // An instance is an object with its own id, not a copy of the declaration: this is the id a
    // rotation or detachment addresses, and before the fix there was none to address.
    expect(instance.id).toMatch(/^sesrsc_/);
    expect(instance.type).toBe('github_repository');
    expect(instance.mount_path).toBe('/workspace/repo');
    expect(typeof instance.created_at).toBe('string');

    // The same id resolves on its own route, so the listing is not a synthesized array.
    const single = await get(`/v1/sessions/${created.body.id}/resources/${instance.id}`);
    expect(single.status).toBe(200);
    expect(single.body.id).toBe(instance.id);
  });

  it('attaches the instances for a session created by POST /v1/runs', async () => {
    // The other creation route. Its `async` mode uses `createWithInitialEvents`; `sse` and
    // `wait` use plain `create`, which is why the attachment lives in `create` — the assertion
    // for that path is the direct `create` case below.
    const run = await post('/v1/runs', {
      agent: 'agent_x',
      input: 'hello',
      response_mode: 'async',
      session: { resources: [repositoryResource()] },
    });

    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const listed = await get(`/v1/sessions/${run.body.session_id}/resources`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toMatch(/^sesrsc_/);
  });

  it('attaches through plain create(), which is the path the streaming run modes use', () => {
    // `POST /v1/runs` with `response_mode: 'sse'` or the default `'wait'` creates the session
    // with `create()` and streams the reply itself, so it cannot pass an attachment hook. A
    // hook supplied per-route left exactly this path without instances.
    const session = sessionManager.create({
      agent: 'agent_x',
      environmentId: 'env_default',
      resources: [repositoryResource()],
    });

    const listed = listSessionResources(db, session.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toMatch(/^sesrsc_/);
    expect(listed[0]!.type).toBe('github_repository');
    // No `mountPath`: `create` records what it is given. Deriving the mount path and
    // normalizing the shape is the routes' job, which is why the HTTP cases above see
    // `/workspace/repo` and this one does not.
    expect(listed[0]!.mountPath).toBeUndefined();
  });

  it('keeps the instance separate from the declaration, so detaching is not a no-op', async () => {
    const created = await post('/v1/sessions', { agent: 'agent_x', resources: [repositoryResource()] });
    const listed = await get(`/v1/sessions/${created.body.id}/resources`);
    const instanceId = listed.body.data[0].id as string;

    const detached = await app.request(`/v1/sessions/${created.body.id}/resources/${instanceId}`, { method: 'DELETE' });
    expect(detached.status).toBe(200);

    // The instance is gone...
    expect((await get(`/v1/sessions/${created.body.id}/resources`)).body.data).toHaveLength(0);
    // ...while the session's declaration is untouched. That difference is the proof the
    // listing is backed by an instance table and not by the session's own JSON column: a
    // projection of the column would survive the delete.
    const session = await get(`/v1/sessions/${created.body.id}`);
    expect(session.body.resources).toHaveLength(1);
    expect(session.body.resources[0].type).toBe('github_repository');
  });

  it('attaches a memory_store at creation while refusing to add one live', async () => {
    // `memory_store` is the one resource type the contract attaches for the life of the
    // session. Creation-time attachment is therefore the only way it can ever exist, and it
    // proves the instances are created as "at creation" rather than as a live add.
    const store = await post('/v1/memory_stores', { name: 'probe' });
    expect(store.status, JSON.stringify(store.body)).toBe(201);

    const created = await post('/v1/sessions', {
      agent: 'agent_x',
      resources: [{ type: 'memory_store', memory_store_id: store.body.id, access: 'read_write' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await get(`/v1/sessions/${created.body.id}/resources`)).body.data).toHaveLength(1);

    // The same type through the live add route is refused, so the two paths are distinguishable.
    const live = await post(`/v1/sessions/${created.body.id}/resources`, {
      type: 'memory_store',
      memory_store_id: store.body.id,
      access: 'read_write',
    });
    expect(live.status).toBe(400);
    expect(live.body.error.message).toContain('can only be attached when the session is created');
  });
});
