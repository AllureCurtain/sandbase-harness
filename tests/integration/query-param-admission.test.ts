/**
 * Integration test: a query parameter the route does not implement is refused.
 *
 * A silently dropped filter is worse than an error, because the answer is
 * plausible: `?deployment_id=nope` and a misspelled parameter both return `200`
 * with an empty or unfiltered page, and nothing in that response invites the
 * caller to look again. This is the principle the agent update path already
 * applies to fields — `Unknown agent update field "x"` — carried to the query
 * string.
 *
 * The cases are organised around the mechanisms rather than the route count:
 * the refusal itself (over every handler that reads a parameter), the parameters
 * that must keep working, and `beta`, which is accepted everywhere because 36
 * published examples put it on the URL.
 *
 * The refusal runs before resource lookup, which is what lets most of the
 * refusal cases use a made-up id: the request is judged malformed before any
 * state is read, so a dummy id never reaches the question of whether it exists.
 * One case asserts that ordering deliberately, because it is a choice and not an
 * accident.
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

/** Every handler that reads a query parameter, with one parameter it implements. */
const ROUTES: Array<{ name: string; method: string; path: string; accepts: string[] }> = [
  { name: 'session list', method: 'GET', path: '/v1/sessions', accepts: ['limit', 'status', 'agent_id', 'page'] },
  { name: 'session events', method: 'GET', path: '/v1/sessions/ses_missing/events', accepts: ['limit', 'after_id'] },
  { name: 'event stream', method: 'GET', path: '/v1/sessions/ses_missing/events/stream', accepts: ['event_deltas', 'event_deltas[]', 'last_event_id'] },
  { name: 'skill list', method: 'GET', path: '/v1/skills', accepts: ['source', 'limit', 'page'] },
  { name: 'deployment runs', method: 'GET', path: '/v1/deployment_runs', accepts: ['deployment_id', 'has_error'] },
  { name: 'vault audit', method: 'GET', path: '/v1/vaults/vlt_missing/audit', accepts: ['limit', 'page'] },
  { name: 'credential audit', method: 'GET', path: '/v1/vaults/vlt_missing/credentials/cred_missing/audit', accepts: ['limit', 'page'] },
  { name: 'memory list', method: 'GET', path: '/v1/memory_stores/memstore_missing/memories', accepts: ['path_prefix', 'depth'] },
  { name: 'memory versions', method: 'GET', path: '/v1/memory_stores/memstore_missing/memory_versions', accepts: ['memory_id'] },
  { name: 'runtime logs', method: 'GET', path: '/v1/x/logs', accepts: ['level', 'limit', 'q'] },
  { name: 'mcp status', method: 'GET', path: '/v1/x/mcp/status', accepts: ['session_id'] },
  { name: 'handoff bundles', method: 'GET', path: '/v1/x/handoff-bundles', accepts: ['session_id', 'limit'] },
  { name: 'environment work items', method: 'GET', path: '/v1/environments/env_default/work-items', accepts: ['limit'] },
];

describe('Query-parameter admission', () => {
  let app: ReturnType<typeof createServer>;
  let db: Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-query-params-'));
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
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(ROUTES)('refuses an unimplemented parameter on the $name route', async (route) => {
    const res = await app.request(`${route.path}?not_a_real_parameter=1`, { method: route.method });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
    // Naming the parameter is the whole point: a caller has to learn which one is
    // wrong, and a generic "bad request" would leave them guessing.
    expect(body.error.message).toContain('"not_a_real_parameter"');
  });

  it.each(ROUTES)('names every parameter the $name route does implement', async (route) => {
    const res = await app.request(`${route.path}?not_a_real_parameter=1`, { method: route.method });
    const body = await res.json();
    // The assertion reads the advertised list specifically, not the whole message.
    // Checking `message.includes(parameter)` would pass for the wrong reason on any
    // route whose *other* refusals mention the parameter by name — `/v1/x/mcp/status`
    // answers "session_id query param is required", so it satisfied that weaker
    // check even with the whole mechanism disabled. The probe that disabled the
    // mechanism is how this was found.
    const advertised = body.error.message.match(/This route accepts: (.*)\.$/)?.[1];
    expect(advertised, `${route.name} should advertise its parameters`).toBeDefined();
    for (const parameter of route.accepts) {
      expect(advertised!.split(', '), `${route.name} should advertise ${parameter}`).toContain(parameter);
    }
  });

  it.each(ROUTES)('accepts beta on the $name route, because the published examples send it', async (route) => {
    const res = await app.request(`${route.path}?beta=true`, { method: route.method });
    // Not 200: several of these routes answer 404 or 503 for a missing resource or
    // an unconfigured queue. What matters is that `beta` is never the reason for a
    // refusal, so the assertion is specifically that it is not the 400 under test.
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error.message).not.toContain('beta');
    }
  });

  it('does not advertise beta as an implemented parameter', async () => {
    // Accepted but not implemented: the compatibility semantics are not modelled,
    // so listing it beside `limit` and `page` would read as honouring it.
    const res = await app.request('/v1/skills?nope=1');
    const body = await res.json();
    expect(body.error.message).toContain('This route accepts: source, limit, page.');
    expect(body.error.message).not.toContain('beta');
  });

  it('names every unimplemented parameter when several are sent', async () => {
    const res = await app.request('/v1/skills?one=1&two=2');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('"one"');
    expect(body.error.message).toContain('"two"');
    expect(body.error.message).toContain('parameters');
  });

  it('refuses before reading state, so a missing resource does not mask it', async () => {
    // The session genuinely does not exist; a route that looked it up first would
    // answer 404 and leave the caller believing their parameter was understood.
    const res = await app.request('/v1/sessions/ses_does_not_exist/events?bogus=1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('"bogus"');
  });

  it('serves the legacy /v1/x mirror with the same refusal', async () => {
    // A deployment-runs router is mounted at both prefixes by one factory, so this
    // asserts the refusal is not something the canonical prefix adds on the way in.
    // `/v1/x/skills` would be the wrong route to test that with: it does not exist,
    // so the 404 would be about the path and not about the parameter.
    const res = await app.request('/v1/x/deployment_runs?bogus=1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('"bogus"');
  });

  it('still accepts every parameter the Console and the SDK send', async () => {
    // `?limit=100` is what the Console's session list sends; `page`, `limit`,
    // `status`, and `agent_id` are what the TypeScript SDK sends. A refusal that
    // broke either would be a regression, so they are pinned together.
    const consoleList = await app.request('/v1/sessions?limit=100');
    expect(consoleList.status).toBe(200);

    const sdkList = await app.request('/v1/sessions?limit=5&status=idle&agent_id=agent_x&page=not-a-cursor');
    // A malformed cursor is its own 400; what matters is that it is not the
    // unknown-parameter refusal.
    expect(sdkList.status).toBe(400);
    expect((await sdkList.json()).error.message).not.toContain('Unknown query parameter');
  });

  it('still applies an implemented filter', async () => {
    const res = await app.request('/v1/skills?source=custom');
    expect(res.status).toBe(200);

    const bad = await app.request('/v1/skills?source=bogus');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain('source must be custom or anthropic');
  });

  it('still refuses an unusable value for an implemented parameter', async () => {
    const res = await app.request('/v1/deployment_runs?has_error=maybe');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('has_error must be "true" or "false"');
  });
});
