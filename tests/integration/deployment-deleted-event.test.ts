/**
 * Integration test: deleting a deployment publishes `deployment.deleted`.
 *
 * Delete is the terminal write route on a deployment, and the published table
 * states the event carries the final result precisely because there is no
 * object left to fetch:
 *
 * > `deployment.deleted` — 部署已删除。
 * > — `订阅Webhook.md`
 *
 * That ordering is the interesting claim: a subscriber must be able to rely on
 * the row being gone when the reference arrives, so the publish sits after the
 * write, and the receiver measures it at delivery time rather than after the
 * route returns.
 *
 * Delete is also where referential integrity is tested: `drun_` run records
 * carry a hard `schedule_id` foreign key, so the route removes them in the same
 * transaction as the deployment row. Sessions a run created are independent
 * resources and survive.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';
import { CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA } from '@/core/cma/compatibility.js';

const CMA_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': 'test-key',
  'anthropic-version': CMA_ANTHROPIC_VERSION,
  'anthropic-beta': CMA_MANAGED_AGENTS_BETA,
};

type Received = { body: any; headers: Record<string, string | string[] | undefined> };

describe('deployment.deleted', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;
  /**
   * Whether the row named by a `deployment.deleted` reference was already gone
   * **at the moment the event was delivered**. The event is the final result —
   * there is no object to fetch — so the publish must follow the write, and the
   * only place that can be measured is inside the receiver.
   */
  let goneAtDelivery: boolean[];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-deleted-'));
    const agentsDir = join(tmpDir, 'agents');
    const skillsDir = join(tmpDir, 'skills');
    const dataDir = join(tmpDir, '.managed-agents');
    const configPath = join(dataDir, 'config.yaml');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, 'model:\n  provider: openai\n  api_key: secret-value\n');

    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_one', 'one', '{}')`);

    const sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [],
      consoleRoot: null,
      workspace: { root: tmpDir, dataDir, agentsDir, skillsDir, configPath, target: 'local' },
      runtime: { models: [], sandboxProviders: ['local'], memory: 'disabled', authEnabled: false },
      skills: loadSkills(skillsDir).skills,
      logger,
      logStore,
      restart: () => undefined,
      listRuntimeModels: () => [],
      registerModelProvider: () => undefined,
      setDefaultRuntimeModel: () => undefined,
      reloadAgents: () => ({ agents: [], errors: [] }),
    });

    received = [];
    goneAtDelivery = [];
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        received.push({ body, headers: req.headers });
        if (body?.data?.type === 'deployment.deleted' && typeof body?.data?.id === 'string') {
          const row = db.prepare('SELECT id FROM scheduled_deployments WHERE id = ?').get(body.data.id);
          goneAtDelivery.push(row === undefined);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    receiverUrl = `http://127.0.0.1:${port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function subscribe(events: string[], url = receiverUrl): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url, events }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function createDeployment(name: string): Promise<string> {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({
        name,
        agent_id: 'agent_one',
        environment_id: 'env_default',
        cron: '0 20 * * 5',
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'run' }] }],
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  function addRunRow(scheduleId: string): string {
    const id = `drun_${scheduleId}`;
    db.prepare(
      `INSERT INTO scheduled_deployment_runs (id, schedule_id, status, trigger_type) VALUES (?, ?, 'succeeded', 'scheduled')`,
    ).run(id, scheduleId);
    return id;
  }

  async function del(path: string) {
    const res = await app.request(path, { method: 'DELETE', headers: CMA_HEADERS });
    return { status: res.status, body: await res.json() as any };
  }

  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.data?.type === event && item.headers?.['x-sandbase-webhook-endpoint-id'] === webhookId);
  }

  it('publishes deployment.deleted with a reference to a row already gone at delivery', async () => {
    const webhookId = await subscribe(['deployment.deleted']);
    const id = await createDeployment('deleted-one');

    const res = await del(`/v1/deployments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, type: 'deployment_deleted' });

    const got = receivedFor(webhookId, 'deployment.deleted');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment.deleted', id, organization_id: 'org_local', workspace_id: 'wrkspc_local' });
    expect(got[0].headers['webhook-signature']).toBeDefined();

    // The reference names a deployment that no longer exists — that is what the
    // published contract means by the event being the final result, and it is
    // only true if the write landed first.
    expect(goneAtDelivery).toContain(true);
  });

  it('removes the deployment run records in the same transaction', async () => {
    const id = await createDeployment('deleted-with-runs');
    const runId = addRunRow(id);

    const res = await del(`/v1/deployments/${id}`);
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT id FROM scheduled_deployments WHERE id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM scheduled_deployment_runs WHERE schedule_id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM scheduled_deployment_runs WHERE id = ?').get(runId)).toBeUndefined();
  });

  it('deletes a paused deployment and an archived deployment the same way', async () => {
    const pausedId = await createDeployment('deleted-paused');
    const pauseRes = await app.request(`/v1/deployments/${pausedId}/pause`, { method: 'POST', headers: CMA_HEADERS });
    expect(pauseRes.status).toBe(200);
    expect((await del(`/v1/deployments/${pausedId}`)).status).toBe(200);

    const archivedId = await createDeployment('deleted-archived');
    const archiveRes = await app.request(`/v1/deployments/${archivedId}/archive`, { method: 'POST', headers: CMA_HEADERS });
    expect(archiveRes.status).toBe(200);
    expect((await del(`/v1/deployments/${archivedId}`)).status).toBe(200);
  });

  it('serves the delete on the /v1/scheduled-deployments alias too', async () => {
    const id = await createDeployment('deleted-alias');
    const res = await del(`/v1/scheduled-deployments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, type: 'deployment_deleted' });
    expect(db.prepare('SELECT id FROM scheduled_deployments WHERE id = ?').get(id)).toBeUndefined();
  });

  it('answers 404 and publishes nothing for a missing id or a repeat delete', async () => {
    const webhookId = await subscribe(['deployment.deleted']);

    const missing = await del('/v1/deployments/depl_missing');
    expect(missing.status).toBe(404);

    const id = await createDeployment('deleted-twice');
    expect((await del(`/v1/deployments/${id}`)).status).toBe(200);
    const second = await del(`/v1/deployments/${id}`);
    expect(second.status).toBe(404);

    // Exactly one event: the successful delete. The 404s produced none.
    expect(receivedFor(webhookId, 'deployment.deleted')).toHaveLength(1);
  });
});
