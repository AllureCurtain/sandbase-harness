/**
 * Integration test: an update publishes `deployment.updated` when it changes a
 * field, and nothing when it does not.
 *
 * `deployment.updated` was the last name in the deployment write family with no
 * emitter. `PUT /v1/deployments/{id}` rewrote eight caller-visible fields and
 * returned, so the most commonly called route of the three told nobody.
 *
 * The interesting half is the no-op rule, which the published table states for
 * the sibling resource: "环境已更新，且至少有一个字段发生了变化。无操作的更新不会发出
 * 任何事件" (`订阅Webhook.md:78`). Every field the route writes is therefore
 * asserted twice — once changed, once re-sent unchanged — because an emitter that
 * fires unconditionally passes every "it published" case and fails only these.
 *
 * The stored `payload` and `metadata` are JSON strings, so the comparison has to
 * be structural. A text comparison reports a change for the same object re-sent
 * with its keys in another order, which is a change the caller did not make and
 * cannot avoid, since they do not know the order the server wrote. That case is
 * asserted directly.
 *
 * Delivery is asserted against a real HTTP receiver on an ephemeral loopback
 * port, and every assertion is scoped to the subscription its own case created —
 * the fixture is shared and one event is delivered to every matching
 * subscription.
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

describe('deployment.updated', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-updated-'));
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
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_other', 'other', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_one', 'one', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_two', 'two', '{}')`);

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
    receiver = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        received.push({ body: raw ? JSON.parse(raw) : null, headers: req.headers });
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

  async function subscribe(events: string[] = ['deployment.updated']): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url: receiverUrl, events }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function createDeployment(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ name, agent_id: 'agent_one', cron: '0 20 * * 5', payload: { a: 1 }, metadata: { m: 1 }, ...extra }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function put(path: string, body: Record<string, unknown>) {
    const res = await app.request(path, { method: 'PUT', headers: CMA_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.event === event && item.body?.webhook_id === webhookId);
  }

  /**
   * One field, two calls: it changes, then the same value is re-sent. Exactly one
   * event has to come out of the pair, which is what separates an emitter that
   * compares from one that fires on every write.
   */
  async function fieldCase(name: string, body: Record<string, unknown>, initial: Record<string, unknown> = {}) {
    const webhookId = await subscribe();
    const id = await createDeployment(name, initial);

    const changed = await put(`/v1/deployments/${id}`, body);
    expect(changed.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);

    const reSent = await put(`/v1/deployments/${id}`, body);
    expect(reSent.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);
    return { webhookId, id };
  }

  it('publishes when name changes, and not when it is re-sent', async () => {
    const { webhookId, id } = await fieldCase('rename', { name: 'renamed' });
    const got = receivedFor(webhookId, 'deployment.updated');
    expect(got[0].body.data).toEqual({ type: 'deployment', id });
    // The signature header set is the one the dispatcher emits, so this path did
    // not bypass signing.
    expect(got[0].headers['webhook-signature']).toBeDefined();
  });

  it('publishes when agent_id changes, and not when it is re-sent', async () => {
    await fieldCase('reagent', { agent_id: 'agent_two' });
  });

  it('publishes when environment_id changes, and not when it is re-sent', async () => {
    await fieldCase('reenv', { environment_id: 'env_other' });
  });

  it('publishes when cron changes, and not when it is re-sent', async () => {
    await fieldCase('recron', { cron: '30 21 * * 5' });
  });

  it('publishes when timezone changes, and not when it is re-sent', async () => {
    await fieldCase('retz', { timezone: 'Asia/Tokyo' });
  });

  it('publishes when next_run_at is set explicitly, and not when it is re-sent', async () => {
    await fieldCase('rerun', { next_run_at: '2030-01-01T00:00:00.000Z' });
  });

  it('publishes when payload changes, and not when it is re-sent', async () => {
    await fieldCase('repayload', { payload: { a: 2 } });
  });

  it('publishes when metadata changes, and not when it is re-sent', async () => {
    await fieldCase('remeta', { metadata: { m: 2 } });
  });

  it('does not publish for the same payload content sent in a different key order', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('keyorder', { payload: { alpha: 1, beta: 2 } });

    // Same content, keys the other way round. The stored value is a
    // serialization, and the caller does not know which order it was written in,
    // so treating this as a change would report an update that did not happen.
    const res = await put(`/v1/deployments/${id}`, { payload: { beta: 2, alpha: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ alpha: 1, beta: 2 });
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(0);
  });

  it('does not publish for the same nested payload content sent in a different key order', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('nested', { payload: { outer: { x: 1, y: 2 }, list: [1, 2] } });

    const res = await put(`/v1/deployments/${id}`, { payload: { list: [1, 2], outer: { y: 2, x: 1 } } });
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(0);
  });

  it('publishes for a payload whose content actually differs', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('realchange', { payload: { alpha: 1, beta: 2 } });

    // The neighbour of the key-order case: the same keys, one value different.
    const res = await put(`/v1/deployments/${id}`, { payload: { alpha: 1, beta: 3 } });
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);
  });

  it('publishes nothing for a PUT that changes no field at all', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('noop');
    const before = await app.request(`/v1/deployments/${id}`, { headers: CMA_HEADERS });
    const current = await before.json();

    // Send back exactly what the resource already holds. `updated_at` moves on
    // every write, so an implementation counting it as a change publishes here.
    const res = await put(`/v1/deployments/${id}`, {
      name: current.name,
      agent_id: current.agent_id,
      cron: current.cron,
      timezone: current.timezone,
      payload: current.payload,
      metadata: current.metadata,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated_at).toBeDefined();
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(0);
  });

  it('reports each change by its own event when an update changes the pause state and a field', async () => {
    const webhookId = await subscribe(['deployment.updated', 'deployment.paused', 'deployment.unpaused']);
    const id = await createDeployment('both');

    const res = await put(`/v1/deployments/${id}`, { status: 'paused', name: 'both-renamed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
    expect(res.body.name).toBe('both-renamed');
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('reports a pause-state change alone as the pause event only', async () => {
    const webhookId = await subscribe(['deployment.updated', 'deployment.paused']);
    const id = await createDeployment('pauseonly');

    // The pause state has dedicated events, and the pause routes also move it. If
    // this event covered the transition, `POST /{id}/pause` would have to publish
    // it too.
    const res = await put(`/v1/deployments/${id}`, { status: 'paused' });
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(0);
  });

  it('publishes through the local scheduled-deployments spelling too', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('localspelling');

    const res = await put(`/v1/scheduled-deployments/${id}`, { name: 'local-renamed' });
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);
  });

  it('does not publish for an archived deployment, which still answers 404', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('archived-update');
    const archived = await app.request(`/v1/deployments/${id}/archive`, { method: 'POST', headers: CMA_HEADERS });
    expect(archived.status).toBe(200);

    const res = await put(`/v1/deployments/${id}`, { name: 'too-late' });
    expect(res.status).toBe(404);
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(0);
  });

  it('completes the update even when the subscriber cannot be reached', async () => {
    const webhookId = await subscribe();
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url: 'http://127.0.0.1:1/hook', events: ['deployment.updated'] }),
    });
    expect(res.status).toBe(201);
    const unreachable = (await res.json()).id;
    const id = await createDeployment('unreachable-update');

    const updated = await put(`/v1/deployments/${id}`, { name: 'still-updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('still-updated');

    // The failed attempt is recorded for the retry sweep.
    const rows = db.prepare(
      'SELECT * FROM webhook_deliveries WHERE event = ? AND webhook_id = ?',
    ).all('deployment.updated', unreachable) as unknown as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe('delivered');
    // The reachable subscriber from this case still got it, so the two
    // subscriptions are independent.
    expect(receivedFor(webhookId, 'deployment.updated')).toHaveLength(1);
  });
});
