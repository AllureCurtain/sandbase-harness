/**
 * Integration test: the top-level deployment-run collection and item routes.
 *
 * The published contract addresses a deployment run as its own resource
 * (`GET /v1/deployment_runs?deployment_id=...`, `GET /v1/deployment_runs/{id}`),
 * and the rows have existed all along — reachable only nested under one
 * deployment. So the load-bearing cases here are the ones a nested route cannot
 * answer: the filters, and the item lookup by the id a `deployment_run` event
 * would carry.
 *
 * Both outcome kinds are exercised against the real runner rather than seeded
 * directly, because the interesting half of the projection is what the run
 * *recorded*: a successful run is the only one with a session to take the agent
 * identity from, and the failed one is the only one that proves the documented
 * fallback is what actually happens. The deployment whose agent does not exist is
 * what produces the failed run — `runSchedule` records the failure rather than
 * throwing, so it is reachable without a provider.
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

describe('Deployment runs collection', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-deployment-runs-'));
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
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_sched',
      'schedule-agent',
      JSON.stringify({ name: 'schedule-agent', model: 'model-test', system: 'You are a test agent.' }),
    );

    const sessionManager = new SessionManager(db);
    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [{ name: 'schedule-agent', model: 'model-test', system: 'You are a test agent.' }],
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

  const BASE = '/v1/deployment_runs';

  async function createDeployment(name: string, agentId: string) {
    const created = await send('POST', '/v1/scheduled-deployments', { name, agent_id: agentId, cron: '0 3 * * *' });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  /** A run that succeeded: the agent exists, so a session is created for real. */
  async function makeSuccessfulRun(deploymentId: string) {
    db.prepare('UPDATE scheduled_deployments SET next_run_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', deploymentId);
    const due = await send('POST', '/v1/scheduled-deployments/run-due');
    expect(due.status).toBe(202);
    const run = (due.body.data as any[]).find((entry) => entry.schedule_id === deploymentId);
    expect(run?.status).toBe('created_session');
    return run.id as string;
  }

  /** A run that failed: no such agent, so session creation throws and is recorded. */
  async function makeFailedRun(deploymentId: string) {
    const run = await send('POST', `/v1/scheduled-deployments/${deploymentId}/run`, {});
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('failed');
    return run.body.id as string;
  }

  it('lists one deployment’s runs in the published shape', async () => {
    const deploymentId = await createDeployment('shape', 'agent_sched');
    const runId = await makeSuccessfulRun(deploymentId);

    const listed = await send('GET', `${BASE}?deployment_id=${deploymentId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    const run = listed.body.data[0];

    expect(run.type).toBe('deployment_run');
    expect(run.id).toBe(runId);
    // The collection key is the published name, not the stored column.
    expect(run.deployment_id).toBe(deploymentId);
    expect(run.session_id).toBeTruthy();
    expect(run.error).toBeNull();
    expect(run.trigger_context).toEqual({ type: 'schedule' });

    // The agent identity comes from the session the run created, so it is the one
    // that ran — including a version the deployment itself does not carry.
    const session = db.prepare('SELECT agent_id, agent_version FROM sessions WHERE id = ?')
      .get(run.session_id) as { agent_id: string; agent_version: number };
    expect(session.agent_id).toBe('agent_sched');
    expect(run.agent).toEqual({ type: 'agent', id: 'agent_sched', version: session.agent_version });

    // `created_at` is the stored start instant, not a recomputed one.
    const stored = db.prepare('SELECT started_at FROM scheduled_deployment_runs WHERE id = ?')
      .get(runId) as { started_at: string };
    expect(run.created_at).toBe(stored.started_at);
  });

  it('reports an error object on a failed run and the documented agent fallback', async () => {
    const deploymentId = await createDeployment('failing', 'agent_missing');
    const runId = await makeFailedRun(deploymentId);

    const read = await send('GET', `${BASE}/${runId}`);
    expect(read.status).toBe(200);
    expect(read.body.session_id).toBeNull();
    expect(read.body.error.type).toBe('deployment_run_failed');
    expect(read.body.error.message).toContain('Agent not found');

    // No session means no recorded version, so the projection says so rather than
    // borrowing one: the id is the deployment's agent, the version is unknown.
    expect(read.body.agent).toEqual({ type: 'agent', id: 'agent_missing', version: null });
    // A hand-triggered run carries the trigger the runtime recorded.
    expect(read.body.trigger_context).toEqual({ type: 'manual' });
  });

  it('filters by deployment and returns nothing for an unrelated one', async () => {
    const first = await createDeployment('filter-a', 'agent_sched');
    const second = await createDeployment('filter-b', 'agent_sched');
    const runA = await makeSuccessfulRun(first);
    await makeSuccessfulRun(second);

    const onlyFirst = await send('GET', `${BASE}?deployment_id=${first}`);
    expect(onlyFirst.body.data.map((run: any) => run.id)).toEqual([runA]);

    const onlySecond = await send('GET', `${BASE}?deployment_id=${second}`);
    expect(onlySecond.body.data).toHaveLength(1);
    expect(onlySecond.body.data[0].id).not.toBe(runA);

    // A filter that matches nothing is an empty page, not an error and not every run.
    const none = await send('GET', `${BASE}?deployment_id=sched_does_not_exist`);
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it('filters by has_error in both directions', async () => {
    const good = await createDeployment('has-error-good', 'agent_sched');
    const bad = await createDeployment('has-error-bad', 'agent_missing');
    const goodRun = await makeSuccessfulRun(good);
    const badRun = await makeFailedRun(bad);

    const errors = await send('GET', `${BASE}?deployment_id=${bad}&has_error=true`);
    expect(errors.body.data.map((run: any) => run.id)).toEqual([badRun]);

    const successes = await send('GET', `${BASE}?deployment_id=${good}&has_error=false`);
    expect(successes.body.data.map((run: any) => run.id)).toEqual([goodRun]);
    expect(successes.body.data[0].error).toBeNull();
  });

  it('refuses an unusable has_error by name instead of ignoring it', async () => {
    const res = await send('GET', `${BASE}?has_error=maybe`);
    // Ignoring it would answer a filtered question with an unfiltered list, and the
    // caller could not tell. This is how `level` is treated on the log route.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('has_error');
  });

  it('returns every run when no filter is given, newest first', async () => {
    const all = await send('GET', BASE);
    expect(all.status).toBe(200);
    const stamps = all.body.data.map((run: any) => Date.parse(run.created_at));
    expect(stamps.length).toBeGreaterThan(1);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM scheduled_deployment_runs').get() as { n: number };
    expect(all.body.data).toHaveLength(rows.n);
  });

  it('404s an unknown run in the usual error shape', async () => {
    const res = await send('GET', `${BASE}/srun_missing`);
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('not_found');
    // The `type` alone does not discriminate: an unmounted path answers 404 with
    // the same `type` and the message "No route matches this request". Asserting
    // only the type made this case pass with the route removed entirely, i.e. for
    // the wrong reason. The message is what tells a lookup miss from a missing
    // route, so it is asserted.
    expect(res.body.error.message).toBe('Deployment run not found');
  });

  it('agrees with the nested route on every run they both describe', async () => {
    const deploymentId = await createDeployment('agreement', 'agent_sched');
    const runId = await makeSuccessfulRun(deploymentId);

    // Two projections of one row is a divergence risk, so they are pinned together
    // rather than each being checked against its own expectation.
    const nested = await send('GET', `/v1/deployments/${deploymentId}/runs`);
    const collected = await send('GET', `${BASE}?deployment_id=${deploymentId}`);
    const fromNested = nested.body.data.find((run: any) => run.id === runId);
    const fromCollection = collected.body.data.find((run: any) => run.id === runId);

    expect(fromNested).toBeTruthy();
    expect(fromCollection).toBeTruthy();
    expect(fromCollection.id).toBe(fromNested.id);
    expect(fromCollection.session_id).toBe(fromNested.session_id);
    expect(fromCollection.created_at).toBe(fromNested.started_at);
    expect(fromCollection.deployment_id).toBe(fromNested.schedule_id);
    // The error is the one field that changes representation, not meaning.
    expect(fromNested.error).toBeNull();
    expect(fromCollection.error).toBeNull();
  });

  it('serves the collection at the legacy mirror with its own envelope', async () => {
    const canonical = await send('GET', BASE);
    expect(canonical.body).toHaveProperty('prev_page');
    expect(canonical.body).toHaveProperty('next_page');
    expect(canonical.body).not.toHaveProperty('has_more');

    // The mirror is one mount of the same router, so it answers with the same data
    // under the older envelope rather than diverging.
    const mirror = await send('GET', '/v1/x/deployment_runs');
    expect(mirror.status).toBe(200);
    expect(mirror.body).toHaveProperty('has_more');
    expect(mirror.body.data.map((run: any) => run.id)).toEqual(canonical.body.data.map((run: any) => run.id));
  });
});
