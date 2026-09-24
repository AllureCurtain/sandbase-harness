/**
 * Integration test: deployments answer at the published paths.
 *
 * The published contract calls this resource a *deployment* and addresses it at
 * `/v1/deployments*`; this runtime has always called it a *scheduled deployment*
 * and served it at `/v1/scheduled-deployments*`. One router is mounted at both
 * prefixes, and this file checks that claim over HTTP rather than asserting it
 * about the code.
 *
 * Two things here are specific to this resource and would not be caught by a
 * generic alias test:
 *
 * 1. `operations.ts` serves four resource families (`/webhooks`,
 *    `/scheduled-deployments`, `/outcomes`, `/sessions/:id/outcomes`) from one
 *    router. The deployments were therefore *extracted* into their own module
 *    rather than aliased in place, and the extraction is only correct if the other
 *    families did **not** come along. That is asserted, because aliasing three
 *    families by accident is the obvious way to break this.
 * 2. The router is mounted inside `operationsRoutes`, which is itself mounted at
 *    `/v1` and at `/v1/x` with a different collection envelope. So
 *    `/v1/x/scheduled-deployments` must keep working exactly as before, and
 *    `/v1/x/deployments` must serve the same legacy envelope as its twin rather
 *    than the canonical one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const CANONICAL = '/v1/scheduled-deployments';
const PUBLISHED = '/v1/deployments';

describe('Deployment paths, published and local', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-alias-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    // A deployment stores `agent_id` as a plain column with no foreign key, so
    // these routes need no agent row. The only route that would need a real agent
    // is a *successful* `run`, which creates a session; the run asserted here is
    // the refusal case, which returns before any of that.
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

  it('creates a deployment at the published path and reads it back at both', async () => {
    const server = setUp();

    const created = await send(server, 'POST', PUBLISHED, definition);
    expect(created.status).toBe(201);
    expect(created.body?.name).toBe('nightly');
    const id = created.body!.id as string;

    // The same deployment, addressed either way. This is the whole feature: a
    // caller following the published documentation and one using the local
    // spelling are looking at one resource.
    const viaPublished = await send(server, 'GET', `${PUBLISHED}/${id}`);
    const viaCanonical = await send(server, 'GET', `${CANONICAL}/${id}`);
    expect(viaPublished.status).toBe(200);
    expect(viaCanonical.status).toBe(200);
    expect(viaPublished.body).toEqual(viaCanonical.body);
  });

  it('lists the same deployments at both spellings', async () => {
    const server = setUp();
    await send(server, 'POST', CANONICAL, definition);
    await send(server, 'POST', PUBLISHED, { ...definition, name: 'weekly' });

    const published = await send(server, 'GET', PUBLISHED);
    const canonical = await send(server, 'GET', CANONICAL);
    expect(published.status).toBe(200);
    expect(canonical.status).toBe(200);
    expect(published.body).toEqual(canonical.body);
    expect((published.body!.data as { name: string }[]).map((row) => row.name).sort())
      .toEqual(['nightly', 'weekly']);
  });

  it('updates and archives at the published path', async () => {
    const server = setUp();
    const created = await send(server, 'POST', PUBLISHED, definition);
    const id = created.body!.id as string;

    const updated = await send(server, 'PUT', `${PUBLISHED}/${id}`, { name: 'renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body?.name).toBe('renamed');

    const archived = await send(server, 'POST', `${PUBLISHED}/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body?.status).toBe('archived');

    // Archived hides it from both spellings and 404s on both, so the alias did
    // not create a second lifecycle.
    expect((await send(server, 'GET', `${PUBLISHED}/${id}`)).status).toBe(404);
    expect((await send(server, 'GET', `${CANONICAL}/${id}`)).status).toBe(404);
    const published = await send(server, 'GET', PUBLISHED);
    expect(published.body!.data).toEqual([]);
  });

  it('refuses a run the same way at the published path', async () => {
    const server = setUp();
    const created = await send(server, 'POST', PUBLISHED, { ...definition, status: 'paused' });
    const id = created.body!.id as string;

    // `run` refuses a deployment that is not active. The alias must relocate that
    // decision, not soften it, so both spellings answer identically.
    const viaPublished = await send(server, 'POST', `${PUBLISHED}/${id}/run`);
    const viaCanonical = await send(server, 'POST', `${CANONICAL}/${id}/run`);
    expect(viaPublished.status).toBe(400);
    expect(viaPublished.body).toEqual(viaCanonical.body);
  });

  it('reports a missing deployment at the published path in the same shape', async () => {
    const server = setUp();
    const viaPublished = await send(server, 'GET', `${PUBLISHED}/sched_missing`);
    const viaCanonical = await send(server, 'GET', `${CANONICAL}/sched_missing`);
    expect(viaPublished.status).toBe(404);
    expect(viaPublished.body).toEqual(viaCanonical.body);
    expect(viaPublished.body?.error?.type).toBe('not_found');
  });

  it('serves every deployment route at the published prefix', async () => {
    const server = setUp();
    const created = await send(server, 'POST', PUBLISHED, definition);
    const id = created.body!.id as string;

    // Every route the family serves, including the local `/run-due` convenience
    // route, which has no published equivalent. It is aliased rather than curated
    // out, because the alias is a mount: a caller who learned the published
    // spelling should not have to learn which routes answer at it.
    const routes: [string, string][] = [
      ['GET', PUBLISHED],
      ['POST', PUBLISHED],
      ['POST', `${PUBLISHED}/run-due`],
      ['GET', `${PUBLISHED}/${id}`],
      ['PUT', `${PUBLISHED}/${id}`],
      ['GET', `${PUBLISHED}/${id}/runs`],
      ['POST', `${PUBLISHED}/${id}/archive`],
    ];
    for (const [method, path] of routes) {
      const res = await send(server, method, path, method === 'POST' || method === 'PUT' ? definition : undefined);
      expect(res.status, `${method} ${path}`).not.toBe(404);
    }
  });

  it('does not put the other resource families under the published prefix', async () => {
    const server = setUp();

    // The deployment routes were extracted out of the router that also serves
    // webhooks and outcomes. Aliasing that router wholesale would have exposed all
    // four families under `/v1/deployments/`, so this asserts the extraction did
    // not over-reach.
    //
    // These paths do resolve: `/:id` matches them and reports an unknown
    // deployment. So the assertion is on the *shape*, not merely on the status —
    // what would prove the alias went wrong is a 200 carrying webhooks or
    // outcomes, which is what an aliased `operationsRoutes` would return here.
    // `/v1/x/deployments/...` is checked too, because the legacy mirror is mounted
    // from the same place.
    for (const path of [
      `${PUBLISHED}/webhooks`,
      `${PUBLISHED}/outcomes`,
      `${PUBLISHED}/webhooks/wh_x`,
      '/v1/x/deployments/webhooks',
      '/v1/x/deployments/outcomes',
    ]) {
      const res = await send(server, 'GET', path);
      expect(res.status, path).toBe(404);
      expect(res.body?.error?.type, path).toBe('not_found');
      expect(Array.isArray(res.body?.data), path).toBe(false);
    }

    // ...and the families are still where they belong, so the assertion above is
    // not passing because the extraction dropped them entirely.
    expect((await send(server, 'GET', '/v1/webhooks')).status).toBe(200);
    expect((await send(server, 'GET', '/v1/outcomes')).status).toBe(200);
  });

  it('keeps the legacy mirror working for both spellings', async () => {
    const server = setUp();
    const created = await send(server, 'POST', CANONICAL, definition);
    const id = created.body!.id as string;

    // `/v1/x` is the local surface with existing consumers. It kept its own
    // collection envelope, and mounting the deployment router inside
    // `operationsRoutes` is what preserved it — a mount in `server.ts` would have
    // silently dropped these paths.
    const legacyCanonical = await send(server, 'GET', '/v1/x/scheduled-deployments');
    const legacyPublished = await send(server, 'GET', '/v1/x/deployments');
    expect(legacyCanonical.status).toBe(200);
    expect(legacyPublished.status).toBe(200);
    expect(legacyPublished.body).toEqual(legacyCanonical.body);

    // The legacy envelope, not the canonical one: same rows, different page keys.
    expect(legacyPublished.body).toHaveProperty('has_more');
    expect(legacyPublished.body).not.toHaveProperty('next_page');

    const canonical = await send(server, 'GET', CANONICAL);
    expect(canonical.body).toHaveProperty('next_page');
    expect(canonical.body!.data).toEqual(legacyPublished.body!.data);

    expect((await send(server, 'GET', `/v1/x/deployments/${id}`)).status).toBe(200);
    expect((await send(server, 'GET', `/v1/x/scheduled-deployments/${id}`)).status).toBe(200);
  });
});
