/**
 * Integration test: a pause-state transition publishes its event whichever route
 * caused it.
 *
 * `deployment.paused` and `deployment.unpaused` were published by the two pause
 * routes and by nothing else, but the pause state has a **third door**:
 * `PUT /v1/deployments/{id}` writes `status` and `paused_reason` straight from
 * the request body. A pause through that route produced the durable state and
 * told no subscriber, so "pausing a deployment publishes `deployment.paused`" was
 * true of one route and false of another producing the same state.
 *
 * The fix moved the decision — did the state change, and which event does that
 * mean — into `publishPauseTransition`, which all three routes call. This file
 * therefore tests the rule at every door, and tests the two pause routes again
 * rather than trusting the neighbouring file: the refactor rewrote that code, and
 * a green file next door is not evidence that the code it covers still works.
 *
 * Delivery is asserted against a real HTTP receiver on an ephemeral loopback
 * port, and every assertion is scoped to the subscription its own case created,
 * because the fixture is shared and one transition is delivered to *every*
 * matching subscription.
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

describe('Deployment pause events at every door', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;
  let receiver: Server;
  let received: Received[];
  let receiverUrl: string;

  /** A subscription carrying both pause names, which is what a receiver watching a deployment would list. */
  const BOTH = ['deployment.paused', 'deployment.unpaused'];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-update-pause-'));
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

  async function subscribe(events: string[] = BOTH): Promise<string> {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ url: receiverUrl, events }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function createDeployment(name: string): Promise<string> {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: CMA_HEADERS,
      body: JSON.stringify({ name, agent_id: 'agent_one', cron: '0 20 * * 5' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function put(path: string, body: Record<string, unknown>) {
    const res = await app.request(path, { method: 'PUT', headers: CMA_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function post(path: string) {
    const res = await app.request(path, { method: 'POST', headers: CMA_HEADERS });
    return { status: res.status, body: await res.json() };
  }

  /** Events the receiver took for one subscription, which is what makes a case independent. */
  function receivedFor(webhookId: string, event: string): Received[] {
    return received.filter((item) => item.body?.event === event && item.body?.webhook_id === webhookId);
  }

  it('publishes deployment.paused when an update sets the status, the third door', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('update-pauses');

    const res = await put(`/v1/deployments/${id}`, { status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
    // The reason is still derived the same way, so the event reports the
    // transition without changing what a `PUT` records.
    expect(res.body.paused_reason).toEqual({ type: 'manual' });

    const got = receivedFor(webhookId, 'deployment.paused');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment', id });
    // A subscriber that asked only for the pause names must not receive the
    // unpause one for the same call.
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('publishes deployment.unpaused when an update clears the status', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('update-unpauses');
    await put(`/v1/deployments/${id}`, { status: 'paused' });

    const res = await put(`/v1/deployments/${id}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.paused_reason).toBeNull();

    const got = receivedFor(webhookId, 'deployment.unpaused');
    expect(got).toHaveLength(1);
    expect(got[0].body.data).toEqual({ type: 'deployment', id });
  });

  it('publishes nothing when an update re-sends the status the deployment already has', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('update-same-status');
    await put(`/v1/deployments/${id}`, { status: 'paused' });
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);

    // An idempotent retry, which is the ordinary case rather than an edge one.
    const again = await put(`/v1/deployments/${id}`, { status: 'paused' });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('paused');
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
  });

  it('publishes nothing when an update changes an unrelated field', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('update-rename');

    const res = await put(`/v1/deployments/${id}`, { name: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('renamed');
    // The status was untouched, so neither pause event is a transition. That a
    // rename publishes no `deployment.updated` either is a recorded gap, not
    // something this case asserts: the name has its own trigger rule and its own
    // no-op comparison.
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(0);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('publishes nothing when an update on a paused deployment leaves it paused', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('paused-rename');
    await put(`/v1/deployments/${id}`, { status: 'paused' });
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);

    const res = await put(`/v1/deployments/${id}`, { name: 'paused-and-renamed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(0);
  });

  it('still publishes from the pause route, and only once', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('pause-route');

    const first = await post(`/v1/deployments/${id}/pause`);
    expect(first.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);

    await post(`/v1/deployments/${id}/pause`);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
  });

  it('still publishes from the unpause route, and only once', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('unpause-route');
    await post(`/v1/deployments/${id}/pause`);

    const first = await post(`/v1/deployments/${id}/unpause`);
    expect(first.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(1);

    await post(`/v1/deployments/${id}/unpause`);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(1);
  });

  it('derives the transition from the stored state, not from the route that acted', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('mixed-doors');

    // Paused through the update route, resumed through the pause route.
    await put(`/v1/deployments/${id}`, { status: 'paused' });
    await post(`/v1/deployments/${id}/unpause`);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(1);

    // Paused through the pause route, resumed through the update route, on the
    // same deployment: a route that tracked its own idea of the state instead of
    // reading it would publish a second pause here or none at all.
    await post(`/v1/deployments/${id}/pause`);
    await put(`/v1/deployments/${id}`, { status: 'active' });
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(2);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(2);
  });

  it('publishes through the local scheduled-deployments spelling too', async () => {
    const webhookId = await subscribe();
    const id = await createDeployment('local-spelling-update');

    const res = await put(`/v1/scheduled-deployments/${id}`, { status: 'paused' });
    expect(res.status).toBe(200);
    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
  });

  it('leaves a no-op transition silent even for a subscription on both names', async () => {
    const webhookId = await subscribe(['deployment.paused', 'deployment.unpaused']);
    const id = await createDeployment('silent-both');

    // Three calls, two of them no-ops, on a fresh deployment: exactly two events.
    await post(`/v1/deployments/${id}/pause`);
    await put(`/v1/deployments/${id}`, { status: 'paused' });
    await post(`/v1/deployments/${id}/unpause`);

    expect(receivedFor(webhookId, 'deployment.paused')).toHaveLength(1);
    expect(receivedFor(webhookId, 'deployment.unpaused')).toHaveLength(1);
    const everyEvent = received.filter((item) => item.body?.webhook_id === webhookId);
    expect(everyEvent).toHaveLength(2);
  });
});
