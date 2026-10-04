/**
 * Integration test: the deployment resource in its published shape.
 *
 * Scheduled deployments used to be a local-only object (`type:
 * 'scheduled_deployment'`, flat `agent_id`/`cron`, an opaque `payload`). This
 * file pins the published contract end to end: the `depl_`/`drun_` ids and
 * object keys the SDK type declares, the required `initial_events` admission —
 * including `system.message`, which only deployments may start with — and the
 * three runner outcomes the contract ties to them: a classified failure that
 * pauses, an archived agent that archives the deployment without a run, and a
 * manual run that stays allowed while paused.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';
import { createServer } from '@/api/server.js';

describe('Deployment official shape', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-official-'));
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
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_arch', 'old', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_deploy', 'deploy-agent',
      JSON.stringify({ name: 'deploy-agent', model: 'model-test', system: 'You are a test agent.' }),
    );
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_second', 'second-agent',
      JSON.stringify({ name: 'second-agent', model: 'model-test' }),
    );

    const sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [{ name: 'deploy-agent', model: 'model-test', system: 'You are a test agent.' }],
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
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function send(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as any : undefined };
  }

  const validCreate = {
    name: 'nightly',
    agent: 'agent_deploy',
    environment_id: 'env_default',
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'run the checks' }] }],
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
  };

  async function createDeployment(overrides: Record<string, unknown> = {}) {
    return send('POST', '/v1/deployments', { ...validCreate, ...overrides });
  }

  it('projects the published deployment key set with depl_ ids and the resolved agent pin', async () => {
    const created = await createDeployment();
    expect(created.status).toBe(201);
    const deployment = created.body;
    expect(deployment.id).toMatch(/^depl_/);
    // The key set is the published object's — a stray legacy field (flat
    // `agent_id`, `cron`, `payload`, `next_run_at`) would fail this outright.
    expect(Object.keys(deployment).sort()).toEqual([
      'agent', 'archived_at', 'budget', 'created_at', 'description', 'environment_id',
      'id', 'initial_events', 'metadata', 'name', 'paused_reason', 'resources',
      'schedule', 'status', 'type', 'updated_at', 'vault_ids',
    ]);
    expect(deployment.type).toBe('deployment');
    expect(deployment.agent).toEqual({ type: 'agent', id: 'agent_deploy', version: 1 });
    expect(deployment.schedule).toMatchObject({ type: 'cron', expression: '0 9 * * *', timezone: 'UTC' });
    expect(deployment.schedule.upcoming_runs_at).toHaveLength(3);
    expect(deployment.initial_events).toHaveLength(1);
    expect(deployment.status).toBe('active');
    expect(deployment.paused_reason).toBeNull();
    expect(deployment.archived_at).toBeNull();
  });

  it('refuses a create without initial_events or with an empty list', async () => {
    const missing = await send('POST', '/v1/deployments', {
      name: 'x', agent: 'agent_deploy', environment_id: 'env_default',
    });
    expect(missing.status).toBe(400);

    const empty = await createDeployment({ initial_events: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('initial_events');
  });

  it('refuses a create without environment_id or agent', async () => {
    const noEnv = await send('POST', '/v1/deployments', {
      name: 'x', agent: 'agent_deploy', initial_events: validCreate.initial_events,
    });
    expect(noEnv.status).toBe(400);

    const noAgent = await send('POST', '/v1/deployments', {
      name: 'x', environment_id: 'env_default', initial_events: validCreate.initial_events,
    });
    expect(noAgent.status).toBe(400);

    const badAgent = await createDeployment({ agent: 'agent_missing' });
    expect(badAgent.status).toBe(400);
  });

  it('refuses user.tool_confirmation in initial_events but accepts system.message', async () => {
    const refused = await createDeployment({
      initial_events: [{ type: 'user.tool_confirmation', tool_use_id: 'tu_1', result: 'allow' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('initial_events[0].type');

    const accepted = await createDeployment({
      name: 'with-system',
      initial_events: [
        { type: 'system.message', content: [{ type: 'text', text: 'You are a compliance checker.' }] },
        { type: 'user.message', content: [{ type: 'text', text: 'run' }] },
      ],
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.initial_events.map((event: any) => event.type)).toEqual(['system.message', 'user.message']);
  });

  it('pins the declared agent version at create and reports it on retrieve', async () => {
    const created = await createDeployment({ name: 'pinned', agent: { type: 'agent', id: 'agent_deploy', version: 1 } });
    expect(created.status).toBe(201);
    const read = await send('GET', `/v1/deployments/${created.body.id}`);
    expect(read.body.agent).toEqual({ type: 'agent', id: 'agent_deploy', version: 1 });

    const unknown = await createDeployment({ name: 'bad-pin', agent: { type: 'agent', id: 'agent_deploy', version: 99 } });
    expect(unknown.status).toBe(400);
  });

  it('creates a manual-only deployment without a schedule and reports schedule: null', async () => {
    const created = await send('POST', '/v1/deployments', {
      name: 'manual-only',
      agent: 'agent_deploy',
      environment_id: 'env_default',
      initial_events: validCreate.initial_events,
    });
    expect(created.status).toBe(201);
    expect(created.body.schedule).toBeNull();
  });

  it('updates through POST with partial semantics: description clears, schedule null removes the cadence', async () => {
    const created = await createDeployment({ name: 'updatable', description: 'keep me' });
    const id = created.body.id;

    const renamed = await send('POST', `/v1/deployments/${id}`, { name: 'renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('renamed');
    // Omitted fields preserved.
    expect(renamed.body.description).toBe('keep me');
    expect(renamed.body.schedule.expression).toBe('0 9 * * *');

    const cleared = await send('POST', `/v1/deployments/${id}`, { description: null });
    expect(cleared.body.description).toBeNull();

    const unscheduled = await send('POST', `/v1/deployments/${id}`, { schedule: null });
    expect(unscheduled.body.schedule).toBeNull();

    const patched = await send('POST', `/v1/deployments/${id}`, { metadata: { keep: 'a', drop: 'b' } });
    await send('POST', `/v1/deployments/${id}`, { metadata: { drop: '' } });
    const read = await send('GET', `/v1/deployments/${id}`);
    expect(read.body.metadata).toEqual({ keep: 'a' });
  });

  it('filters the list by agent_id, status, include_archived, and created_at bounds', async () => {
    const a = await createDeployment({ name: 'filter-a' });
    const b = await createDeployment({ name: 'filter-b', agent: 'agent_second' });
    await send('POST', `/v1/deployments/${a.body.id}/pause`);
    await send('POST', `/v1/deployments/${b.body.id}/archive`);

    const byAgent = await send('GET', '/v1/deployments?agent_id=agent_second');
    expect(byAgent.body.data.map((row: any) => row.id)).toEqual([]);

    const byAgentArchived = await send('GET', '/v1/deployments?agent_id=agent_second&include_archived=true');
    expect(byAgentArchived.body.data.map((row: any) => row.id)).toEqual([b.body.id]);

    const paused = await send('GET', '/v1/deployments?status=paused');
    expect(paused.body.data.map((row: any) => row.id)).toContain(a.body.id);
    expect(paused.body.data.every((row: any) => row.status === 'paused')).toBe(true);

    const bounded = await send('GET', `/v1/deployments?created_at[gte]=${a.body.created_at}`);
    expect(bounded.body.data.map((row: any) => row.id)).toContain(a.body.id);

    const includeArchived = await send('GET', '/v1/deployments?include_archived=true');
    expect(includeArchived.body.data.map((row: any) => row.id)).toContain(b.body.id);
  });

  it('runs a paused deployment by hand and records a manual trigger_context', async () => {
    const created = await createDeployment({ name: 'paused-run' });
    await send('POST', `/v1/deployments/${created.body.id}/pause`);

    const run = await send('POST', `/v1/deployments/${created.body.id}/run`, {});
    expect(run.status).toBe(201);
    expect(run.body.id).toMatch(/^drun_/);
    expect(run.body).toMatchObject({
      type: 'deployment_run',
      deployment_id: created.body.id,
      trigger_context: { type: 'manual' },
    });
    expect(run.body.session_id).toBeTruthy();
    // The session carries the deployment's agent and actually started working:
    // the initial user.message is in its event log.
    const session = db.prepare('SELECT agent_id, agent_version FROM sessions WHERE id = ?')
      .get(run.body.session_id) as { agent_id: string; agent_version: number };
    expect(session.agent_id).toBe('agent_deploy');
    const events = db.prepare("SELECT type FROM events WHERE session_id = ? ORDER BY seq")
      .all(run.body.session_id) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toContain('user.message');
  });

  it('pauses the deployment with an error reason when its environment is archived', async () => {
    db.prepare(`UPDATE environments SET archived_at = ? WHERE id = 'env_arch'`).run(new Date().toISOString());
    const created = await send('POST', '/v1/deployments', {
      name: 'env-archived-run',
      agent: 'agent_deploy',
      environment_id: 'env_arch',
      initial_events: validCreate.initial_events,
    });
    // An archived environment is refused at create the same way a missing one is.
    expect(created.status).toBe(400);

    // To get a live deployment on a dead environment, create it first and
    // archive the environment afterwards.
    db.prepare(`UPDATE environments SET archived_at = NULL WHERE id = 'env_arch'`).run();
    const live = await send('POST', '/v1/deployments', {
      name: 'env-archived-later',
      agent: 'agent_deploy',
      environment_id: 'env_arch',
      initial_events: validCreate.initial_events,
    });
    expect(live.status).toBe(201);
    db.prepare(`UPDATE environments SET archived_at = ? WHERE id = 'env_arch'`).run(new Date().toISOString());

    const run = await send('POST', `/v1/deployments/${live.body.id}/run`, {});
    expect(run.status).toBe(201);
    expect(run.body.session_id).toBeNull();
    expect(run.body.error.type).toBe('environment_archived_error');

    const read = await send('GET', `/v1/deployments/${live.body.id}`);
    expect(read.body.status).toBe('paused');
    expect(read.body.paused_reason).toEqual({
      type: 'error',
      error: { type: 'environment_archived_error', message: 'Environment env_arch is archived' },
    });
  });

  it('archives the deployment without a run when its agent is archived', async () => {
    const created = await createDeployment({ name: 'agent-archived', agent: 'agent_second' });
    db.prepare(`UPDATE agents SET archived_at = ?, status = 'archived' WHERE id = 'agent_second'`).run(new Date().toISOString());

    const run = await send('POST', `/v1/deployments/${created.body.id}/run`, {});
    expect(run.status).toBe(409);

    const runs = db.prepare('SELECT * FROM scheduled_deployment_runs WHERE schedule_id = ?')
      .all(created.body.id) as unknown[];
    expect(runs).toHaveLength(0);

    const read = await send('GET', `/v1/deployments/${created.body.id}`);
    expect(read.body.archived_at).not.toBeNull();

    db.prepare(`UPDATE agents SET archived_at = NULL, status = 'active' WHERE id = 'agent_second'`).run();
  });

  it('filters the run collection by trigger_type and created_at bounds', async () => {
    const created = await createDeployment({ name: 'run-filter' });
    db.prepare('UPDATE scheduled_deployments SET next_run_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', created.body.id);
    await send('POST', '/v1/deployments/run-due');
    const manual = await send('POST', `/v1/deployments/${created.body.id}/run`, {});

    const scheduled = await send('GET', `/v1/deployment_runs?deployment_id=${created.body.id}&trigger_type=schedule`);
    expect(scheduled.body.data).toHaveLength(1);
    expect(scheduled.body.data[0].trigger_context.type).toBe('schedule');

    const manualOnly = await send('GET', `/v1/deployment_runs?deployment_id=${created.body.id}&trigger_type=manual`);
    expect(manualOnly.body.data.map((run: any) => run.id)).toEqual([manual.body.id]);

    const future = await send('GET', `/v1/deployment_runs?created_at[gte]=2099-01-01T00:00:00Z`);
    expect(future.body.data).toEqual([]);
    const past = await send('GET', `/v1/deployment_runs?deployment_id=${created.body.id}&created_at[lte]=2099-01-01T00:00:00Z`);
    expect(past.body.data).toHaveLength(2);
  });
});
