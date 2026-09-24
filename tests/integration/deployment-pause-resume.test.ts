/**
 * Integration test: pausing and resuming a deployment.
 *
 * The published contract defines pause as a lifecycle operation with a meaning,
 * not just a state: pause suppresses the *scheduler* while leaving the `run`
 * endpoint open to a person, records `{"type": "manual"}` as the reason, and
 * unpausing resumes from the next scheduled instant without catching up the
 * triggers that elapsed while it was paused (`高级编排/定时部署.md:488-490`, `:535`).
 *
 * The load-bearing case here is the manual run. `POST /{id}/run` used to refuse
 * any status but `active`, which was reachable only through `paused` — the one
 * status the contract says must still run. So the assertion is not merely "a run
 * is accepted": it is that a run *record* exists afterwards, because a refusal
 * would leave none. The archived case is asserted beside it, because removing that
 * gate is only safe if an archived deployment is still unreachable, and the
 * difference between the two is what the removed guard was standing on.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('Deployment pause and resume', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    app = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-pause-resume-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
    return app;
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  const definition = { name: 'nightly', agent_id: 'agent_a', cron: '0 3 * * *' };
  const BASE = '/v1/scheduled-deployments';

  async function createDeployment(server: ReturnType<typeof createServer>, extra: Record<string, unknown> = {}) {
    const created = await send(server, 'POST', BASE, { ...definition, ...extra });
    expect(created.status).toBe(201);
    return created.body!.id as string;
  }

  /** Force the stored next run into the past, which is the state a pause creates. */
  function setNextRunInPast(id: string, iso: string) {
    db!.prepare('UPDATE scheduled_deployments SET next_run_at = ? WHERE id = ?').run(iso, id);
  }

  const runRows = (id: string) => db!.prepare(
    'SELECT id, status, trigger_type FROM scheduled_deployment_runs WHERE schedule_id = ?',
  ).all(id) as { id: string; status: string; trigger_type: string }[];

  it('pauses with the published reason and clears it on unpause', async () => {
    const server = setUp();
    const id = await createDeployment(server);
    expect((await send(server, 'GET', `${BASE}/${id}`)).body?.paused_reason).toBeNull();

    const paused = await send(server, 'POST', `${BASE}/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body?.status).toBe('paused');
    expect(paused.body?.paused_reason).toEqual({ type: 'manual' });

    const resumed = await send(server, 'POST', `${BASE}/${id}/unpause`);
    expect(resumed.status).toBe(200);
    expect(resumed.body?.status).toBe('active');
    expect(resumed.body?.paused_reason).toBeNull();
  });

  it('keeps status and reason from disagreeing on the update path too', async () => {
    const server = setUp();
    const id = await createDeployment(server);

    // The update route already accepted `status: 'paused'`. It now records the
    // reason with it, so a deployment cannot read as paused with no reason just
    // because it was paused through a different route.
    const paused = await send(server, 'PUT', `${BASE}/${id}`, { status: 'paused' });
    expect(paused.body?.status).toBe('paused');
    expect(paused.body?.paused_reason).toEqual({ type: 'manual' });

    const resumed = await send(server, 'PUT', `${BASE}/${id}`, { status: 'active' });
    expect(resumed.body?.paused_reason).toBeNull();
  });

  it('records the reason for a deployment created paused', async () => {
    const server = setUp();
    const id = await createDeployment(server, { status: 'paused' });
    const read = await send(server, 'GET', `${BASE}/${id}`);
    expect(read.body?.status).toBe('paused');
    expect(read.body?.paused_reason).toEqual({ type: 'manual' });
  });

  it('still runs a paused deployment by hand', async () => {
    const server = setUp();
    const id = await createDeployment(server);
    await send(server, 'POST', `${BASE}/${id}/pause`);
    expect(runRows(id)).toEqual([]);

    const run = await send(server, 'POST', `${BASE}/${id}/run`, {});

    // Not refused. Before this change this call was a 400 and left no run record,
    // which is exactly what the contract says must not happen.
    expect(run.status).toBe(201);
    expect(run.body?.trigger_type).toBe('manual');
    expect(runRows(id)).toHaveLength(1);
    expect(runRows(id)[0].trigger_type).toBe('manual');
  });

  it('does not run a paused deployment on the scheduler path', async () => {
    const server = setUp();
    const id = await createDeployment(server);
    await send(server, 'POST', `${BASE}/${id}/pause`);
    setNextRunInPast(id, '2020-01-01T00:00:00.000Z');

    // The scheduler already filtered on `status = 'active'`, so this is a guard on
    // the rule rather than the fix for it: pause suppresses the timed path, and
    // only the manual path stays open.
    const due = await send(server, 'POST', `${BASE}/run-due`);
    expect(due.status).toBe(202);
    expect(due.body?.data).toEqual([]);
    expect(runRows(id)).toEqual([]);
  });

  it('does not catch up trigger instants missed while paused', async () => {
    const server = setUp();
    const id = await createDeployment(server);
    await send(server, 'POST', `${BASE}/${id}/pause`);
    // The instant the schedule would have fired had it stayed active.
    setNextRunInPast(id, '2020-01-01T00:00:00.000Z');

    const resumed = await send(server, 'POST', `${BASE}/${id}/unpause`);
    expect(resumed.body?.status).toBe('active');
    const nextRunAt = resumed.body?.next_run_at as string;
    expect(Date.parse(nextRunAt)).toBeGreaterThan(Date.now());

    // The consequence, not just the field: nothing fires for the missed instant.
    const due = await send(server, 'POST', `${BASE}/run-due`);
    expect(due.body?.data).toEqual([]);
    expect(runRows(id)).toEqual([]);
  });

  it('leaves a future next run alone when unpausing', async () => {
    const server = setUp();
    const id = await createDeployment(server);
    await send(server, 'POST', `${BASE}/${id}/pause`);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    setNextRunInPast(id, future);

    // Already the next scheduled instant, so recomputing would only discard it —
    // and for a caller-set `next_run_at` it would discard their choice.
    const resumed = await send(server, 'POST', `${BASE}/${id}/unpause`);
    expect(resumed.body?.next_run_at).toBe(future);
  });

  it('is idempotent and refuses an archived or unknown deployment', async () => {
    const server = setUp();
    const id = await createDeployment(server);

    expect((await send(server, 'POST', `${BASE}/${id}/pause`)).status).toBe(200);
    const pausedTwice = await send(server, 'POST', `${BASE}/${id}/pause`);
    expect(pausedTwice.status).toBe(200);
    expect(pausedTwice.body?.paused_reason).toEqual({ type: 'manual' });

    expect((await send(server, 'POST', `${BASE}/${id}/unpause`)).status).toBe(200);
    expect((await send(server, 'POST', `${BASE}/${id}/unpause`)).status).toBe(200);

    expect((await send(server, 'POST', `${BASE}/sched_missing/pause`)).status).toBe(404);
    expect((await send(server, 'POST', `${BASE}/sched_missing/unpause`)).status).toBe(404);

    // Archived is gone, not paused: this is what the removed run gate was standing
    // on, so it is asserted rather than assumed.
    await send(server, 'POST', `${BASE}/${id}/archive`);
    expect((await send(server, 'POST', `${BASE}/${id}/pause`)).status).toBe(404);
    expect((await send(server, 'POST', `${BASE}/${id}/unpause`)).status).toBe(404);
    // A body is required, and only then: `readObjectBody` runs before the lookup,
    // so a bodyless request is a 400 in its own right and would not tell an absent
    // deployment apart from a malformed request.
    expect((await send(server, 'POST', `${BASE}/${id}/run`, {})).status).toBe(404);
    expect((await send(server, 'POST', `${BASE}/${id}/run`)).status).toBe(400);
  });

  it('serves the lifecycle at the published prefix too', async () => {
    const server = setUp();
    const created = await send(server, 'POST', '/v1/deployments', definition);
    const id = created.body!.id as string;

    // The lifecycle routes are declared relative to the deployment router's mount,
    // so they inherit both prefixes without a second registration.
    const paused = await send(server, 'POST', `/v1/deployments/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body?.paused_reason).toEqual({ type: 'manual' });
    expect((await send(server, 'GET', `${BASE}/${id}`)).body?.status).toBe('paused');

    const resumed = await send(server, 'POST', `/v1/deployments/${id}/unpause`);
    expect(resumed.status).toBe(200);
    expect(resumed.body?.status).toBe('active');
  });
});
