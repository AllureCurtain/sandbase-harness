/**
 * Session budget over HTTP.
 *
 * The unit tests prove the rules; this proves the routes are wired to them.
 * A ceiling that only exists inside the manager would let a client declare a
 * budget it never receives, or spend past one while every request answers 200.
 * Both halves are asserted here: what a rejected `budget` answers at creation,
 * and what the event ingress answers once the ceiling is reached.
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
import type { CostProfile } from '@/core/session/cost-profile.js';
import type { RuntimeModelInfo } from '@/types/model.js';

/** One cent per thousand tokens, so a test moves spend in whole cents. */
const PROFILE: CostProfile = {
  id: 'test',
  models: {
    'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 },
  },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

const PRICED_BUDGET = { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } };

describe('session budget over HTTP', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let runtimeModelsData: RuntimeModelInfo[] = [];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-budget-api-'));
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
    for (const [id, name, model] of [
      ['agent_priced', 'priced-agent', 'model-priced'],
      ['agent_unpriced', 'unpriced-agent', 'model-unpriced'],
    ] as const) {
      db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
        id,
        name,
        JSON.stringify({ name, model, system: 'You are a test agent.' }),
      );
    }

    sessionManager = new SessionManager(db);
    // The default profile is empty, which prices nothing. Installing a profile
    // here is what makes "no list price" a statement about one model rather
    // than about the runtime as a whole.
    sessionManager.setCostProfile(PROFILE);

    const logStore = new InMemoryLogStore();
    const logger = createLogger({ level: 'debug', logStore, write: () => undefined });

    app = createServer({
      db,
      sessionManager,
      agents: [
        { name: 'priced-agent', model: 'model-priced', system: 'You are a test agent.' },
        { name: 'unpriced-agent', model: 'model-unpriced', system: 'You are a test agent.' },
      ],
      consoleRoot: null,
      workspace: { root: tmpDir, dataDir, agentsDir, skillsDir, configPath, target: 'local' },
      runtime: {
        models: runtimeModelsData,
        sandboxProviders: ['local'],
        memory: 'disabled',
        authEnabled: false,
      },
      skills: loadSkills(skillsDir).skills,
      logger,
      logStore,
      restart: () => undefined,
      listRuntimeModels: () => runtimeModelsData,
      registerModelProvider: (provider) => {
        runtimeModelsData = runtimeModelsData.filter((model) => model.name !== provider.name);
        runtimeModelsData.unshift({
          name: provider.name,
          provider: provider.provider,
          model: provider.model,
          base_url: provider.base_url,
          api_key_state: provider.api_key ? 'configured' : 'not_set',
          base_url_state: provider.base_url ? 'configured' : 'not_set',
          is_default: Boolean(provider.is_default),
        });
      },
      setDefaultRuntimeModel: (name) => {
        runtimeModelsData = runtimeModelsData.map((model) => ({ ...model, is_default: model.name === name }));
      },
      reloadAgents: () => ({ agents: [], errors: [] }),
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function postJson(path: string, body: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as any };
  }

  /** Move the session's derived spend by a known number of cents. */
  function recordCents(sessionId: string, cents: number, model = 'model-priced'): void {
    sessionManager.getEventLogger().append(sessionId, {
      type: 'span.model_request_end',
      modelUsed: model,
      tokensIn: cents * 1000,
      tokensOut: 0,
    });
  }

  it('rejects a malformed amount at creation and leaves no session behind', async () => {
    const before = sessionManager.list().total;
    const { res, body } = await postJson('/v1/sessions', {
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '25.00', currency: 'USD' } },
    });

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('budget_invalid_amount');
    expect(sessionManager.list().total).toBe(before);
  });

  it('rejects an unknown currency and a non-limit type with their own codes', async () => {
    const currency = await postJson('/v1/sessions', {
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'EUR' } },
    });
    expect(currency.res.status).toBe(400);
    expect(currency.body.error.code).toBe('budget_invalid_currency');

    const shape = await postJson('/v1/sessions', {
      agent: 'agent_priced',
      budget: { type: 'capped', max_list_cost: { amount: '100', currency: 'USD' } },
    });
    expect(shape.res.status).toBe(400);
    expect(shape.body.error.code).toBe('budget_invalid_shape');
  });

  it('refuses a budget for an agent whose model has no list price', async () => {
    const { res, body } = await postJson('/v1/sessions', {
      agent: 'agent_unpriced',
      budget: PRICED_BUDGET,
    });

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('budget_model_without_list_price');
    // Refused before the row exists, so the refusal cannot leave an unbudgeted
    // session that looks like the ceiling was accepted.
    expect(sessionManager.list().data.every((session) => session.agentId !== 'agent_unpriced')).toBe(true);
  });

  it('accepts a budget, echoes it, and reports it in the usage payload', async () => {
    const { res, body } = await postJson('/v1/sessions', {
      agent: 'agent_priced',
      budget: PRICED_BUDGET,
    });

    expect(res.status).toBe(201);
    expect(body.budget).toEqual(PRICED_BUDGET);

    recordCents(body.id, 7);
    const usage = sessionManager.buildUsagePayload(body.id);
    expect(usage.list_cost).toBe(7);
    expect(usage.budget).toEqual(PRICED_BUDGET);
  });

  it('omits the budget field entirely for a session that never had one', async () => {
    const { res, body } = await postJson('/v1/sessions', { agent: 'agent_priced' });
    expect(res.status).toBe(201);
    expect(body.budget).toBeUndefined();
  });

  it('refuses a work-starting event at the ceiling and still accepts a settlement event', async () => {
    const created = await postJson('/v1/sessions', {
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '1', currency: 'USD' } },
    });
    expect(created.res.status).toBe(201);
    const sessionId = created.body.id as string;

    recordCents(sessionId, 2);

    const refused = await postJson(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'go on' }] }],
    });
    expect(refused.res.status).toBe(400);
    expect(refused.body.error.code).toBe('budget_reached');
    // The message has to name what may still be sent, or the client can only
    // retry the event that was just rejected.
    expect(refused.body.error.message).toContain('user.tool_confirmation');

    const settled = await postJson(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.interrupt' }],
    });
    expect(settled.res.status).toBe(200);
    expect(settled.body.accepted).toBe(true);
  });

  it('does not refuse events for a session with no budget', async () => {
    const created = await postJson('/v1/sessions', { agent: 'agent_priced' });
    const sessionId = created.body.id as string;
    recordCents(sessionId, 10_000);

    const sent = await postJson(`/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.interrupt' }],
    });
    expect(sent.res.status).toBe(200);
  });
});
