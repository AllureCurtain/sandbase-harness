/**
 * A scheduled deployment's timezone over HTTP.
 *
 * The engine tests cover the wall-clock arithmetic. This covers the half that
 * makes the arithmetic reachable: that a zone can be put on a deployment at all.
 * Before this, a caller could send `timezone: "Asia/Tokyo"`, be answered `201`,
 * and receive a deployment that fired at 09:00 UTC — the exact silent-wrong-hour
 * outcome the engine work was written to prevent. So every assertion here is on
 * the stored column or on the response, never on a helper.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';
import { loadSkills } from '@/core/skills/loader.js';
import { createLogger, InMemoryLogStore } from '@/core/observability/logger.js';

describe('scheduled deployment timezone over HTTP', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let sessionManager: SessionManager;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-schedule-tz-'));
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

    sessionManager = new SessionManager(db);
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
    return { res, body: (await res.json()) as any };
  }

  const create = (body: unknown) => send('POST', '/v1/scheduled-deployments', body);

  /** The stored column, so a passing assertion cannot come from the projection alone. */
  function storedTimeZone(id: string): string {
    const row = db.prepare('SELECT timezone FROM scheduled_deployments WHERE id = ?').get(id) as { timezone: string };
    return row.timezone;
  }

  it('stores the named zone and resolves the cadence in it', async () => {
    const tokyo = await create({ name: 'Tokyo morning', agent_id: 'agent_sched', cron: '0 9 * * *', timezone: 'Asia/Tokyo' });
    expect(tokyo.res.status).toBe(201);
    expect(tokyo.body.timezone).toBe('Asia/Tokyo');
    // 09:00 Tokyo is 00:00 UTC, so the instant must not be the UTC one.
    expect(tokyo.body.next_run_at.endsWith('T00:00:00.000Z')).toBe(true);
    expect(storedTimeZone(tokyo.body.id)).toBe('Asia/Tokyo');

    const utc = await create({ name: 'UTC morning', agent_id: 'agent_sched', cron: '0 9 * * *' });
    expect(utc.res.status).toBe(201);
    expect(utc.body.timezone).toBe('UTC');
    expect(utc.body.next_run_at.endsWith('T09:00:00.000Z')).toBe(true);
    expect(storedTimeZone(utc.body.id)).toBe('UTC');

    // The two differ by the zone offset, which is the whole point of the field.
    expect(tokyo.body.next_run_at).not.toBe(utc.body.next_run_at);
  });

  it('accepts the canonical schedule object as well as the flat fields', async () => {
    const canonical = await create({
      name: 'Canonical morning',
      agent_id: 'agent_sched',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' },
    });
    expect(canonical.res.status).toBe(201);
    expect(canonical.body.timezone).toBe('Asia/Tokyo');
    expect(canonical.body.cron).toBe('0 9 * * *');
    expect(canonical.body.next_run_at.endsWith('T00:00:00.000Z')).toBe(true);
    expect(storedTimeZone(canonical.body.id)).toBe('Asia/Tokyo');
  });

  it('refuses an unknown zone and writes nothing', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM scheduled_deployments').get() as { n: number }).n;
    const { res, body } = await create({
      name: 'Bad zone',
      agent_id: 'agent_sched',
      cron: '0 9 * * *',
      timezone: 'Mars/Olympus',
    });
    expect(res.status).toBe(400);
    expect(body.error.message).toContain('Mars/Olympus');
    const after = (db.prepare('SELECT COUNT(*) AS n FROM scheduled_deployments').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('re-arms the next run when an update moves the zone', async () => {
    const created = await create({ name: 'Movable', agent_id: 'agent_sched', cron: '0 9 * * *' });
    expect(created.body.next_run_at.endsWith('T09:00:00.000Z')).toBe(true);

    const moved = await send('PUT', `/v1/scheduled-deployments/${created.body.id}`, { timezone: 'Asia/Tokyo' });
    expect(moved.res.status).toBe(200);
    expect(moved.body.timezone).toBe('Asia/Tokyo');
    // Changing only the zone must move the run, not leave it at the old instant.
    expect(moved.body.next_run_at.endsWith('T00:00:00.000Z')).toBe(true);
    expect(storedTimeZone(created.body.id)).toBe('Asia/Tokyo');

    const untouched = await send('PUT', `/v1/scheduled-deployments/${created.body.id}`, { name: 'Renamed' });
    expect(untouched.body.timezone).toBe('Asia/Tokyo');
    expect(untouched.body.next_run_at).toBe(moved.body.next_run_at);

    const pinned = await send('PUT', `/v1/scheduled-deployments/${created.body.id}`, { next_run_at: '2030-01-01T00:00:00.000Z' });
    expect(pinned.body.next_run_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('refuses an unknown zone on update without changing the stored zone', async () => {
    const created = await create({ name: 'Guarded', agent_id: 'agent_sched', cron: '0 9 * * *', timezone: 'Asia/Tokyo' });
    const { res } = await send('PUT', `/v1/scheduled-deployments/${created.body.id}`, { timezone: 'Nowhere/Special' });
    expect(res.status).toBe(400);
    expect(storedTimeZone(created.body.id)).toBe('Asia/Tokyo');
  });

  it('echoes the zone on every read and keeps a pre-column row running', async () => {
    const created = await create({ name: 'Readable', agent_id: 'agent_sched', cron: '0 9 * * *', timezone: 'Asia/Tokyo' });

    const listed = await send('GET', '/v1/scheduled-deployments');
    const found = listed.body.data.find((row: any) => row.id === created.body.id);
    expect(found.timezone).toBe('Asia/Tokyo');

    const single = await send('GET', `/v1/scheduled-deployments/${created.body.id}`);
    expect(single.body.timezone).toBe('Asia/Tokyo');

    // A row written before the column existed took no value at all, so it must
    // read as UTC — the same zone the runner already fell back to — rather than
    // as no zone, which would leave a stored schedule unable to resolve.
    db.prepare(`
      INSERT INTO scheduled_deployments (id, name, agent_id, cron, payload, status, next_run_at, metadata, created_at, updated_at)
      VALUES ('sched_pre_column', 'Pre-column', 'agent_sched', '0 9 * * *', '{}', 'active', '2020-01-01T09:00:00.000Z', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    const legacy = await send('GET', '/v1/scheduled-deployments/sched_pre_column');
    expect(legacy.body.timezone).toBe('UTC');

    // Two due rows differing only in zone: the runner must advance each in the
    // zone the column holds, which is the whole behaviour under test.
    for (const [id, timezone] of [['sched_legacy_utc', 'UTC'], ['sched_legacy_tokyo', 'Asia/Tokyo']] as const) {
      db.prepare(`
        INSERT INTO scheduled_deployments (id, name, agent_id, cron, timezone, payload, status, next_run_at, metadata, created_at, updated_at)
        VALUES (?, ?, 'agent_sched', '0 9 * * *', ?, '{}', 'active', '2020-01-01T09:00:00.000Z', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run(id, id, timezone);
    }
    await send('POST', '/v1/scheduled-deployments/run-due');

    const advanced = db.prepare('SELECT id, next_run_at FROM scheduled_deployments WHERE id IN (?, ?)')
      .all('sched_legacy_utc', 'sched_legacy_tokyo') as Array<{ id: string; next_run_at: string }>;
    const byId = new Map(advanced.map((row) => [row.id, row.next_run_at]));
    expect(byId.get('sched_legacy_utc')?.endsWith('T09:00:00.000Z')).toBe(true);
    expect(byId.get('sched_legacy_tokyo')?.endsWith('T00:00:00.000Z')).toBe(true);
  });

  it('gives every workspace the column', () => {
    const columns = db.prepare('PRAGMA table_info(scheduled_deployments)').all() as Array<{ name: string; notnull: number; dflt_value: string }>;
    const timezone = columns.find((column) => column.name === 'timezone');
    expect(timezone).toBeDefined();
    expect(timezone?.notnull).toBe(1);
    expect(timezone?.dflt_value).toBe("'UTC'");
  });
});
