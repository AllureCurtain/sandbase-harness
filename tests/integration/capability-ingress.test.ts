import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@/api/server.js';
import { getEnabledToolNames } from '@/core/agent/standard.js';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import type { AgentDefinition } from '@/types/agent.js';

const unsupportedWebAgent = {
  name: 'legacy-web-agent',
  model: 'gpt-4o',
  system: 'Use web tools.',
  tools: [{
    type: 'agent_toolset_20260401',
    configs: [{ name: 'web_fetch' }, { name: 'web_search' }],
  }],
} satisfies AgentDefinition;

const unsupportedCapabilityError = {
  type: 'unsupported_capability',
  message: 'Agent requests unavailable runtime capabilities: web_search',
  details: {
    capabilities: [
      { id: 'web_search', reason: 'No search provider is bundled or configured in this runtime; web_search declarations are accepted but not executable.' },
    ],
  },
};

function createCapabilityTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ma-capability-ingress-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
    'agent_safe',
    'safe-agent',
    JSON.stringify({ name: 'safe-agent', model: 'gpt-4o', system: 'Stay safe.' }),
  );
  db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
    'agent_legacy-current',
    unsupportedWebAgent.name,
    JSON.stringify(unsupportedWebAgent),
  );

  const executedSessionIds: string[] = [];
  const sessionManager = new SessionManager(db);
  const executor: SessionExecutor = {
    async *execute(session) {
      executedSessionIds.push(session.id);
    },
  };
  sessionManager.setExecutor(executor);

  const app = createServer({
    db,
    sessionManager,
    agents: [{ name: 'safe-agent', model: 'gpt-4o', system: 'Stay safe.' }],
    reloadAgents: () => ({ agents: [], errors: [] }),
  });

  return { app, db, tmpDir, executedSessionIds };
}

async function postJson(app: ReturnType<typeof createServer>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() as any };
}

describe('capability ingress admission', () => {
  const contexts: ReturnType<typeof createCapabilityTestApp>[] = [];

  afterEach(() => {
    for (const context of contexts.splice(0)) {
      context.db.close();
      rmSync(context.tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects legacy snapshotted and current definitions before appending events or executing', async () => {
    const context = createCapabilityTestApp();
    contexts.push(context);
    const { app, db, executedSessionIds } = context;

    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, agent_id, agent_name, agent_version, agent_definition,
        environment_id, status, resources, vault_ids
      ) VALUES (?, ?, ?, ?, ?, 'env_default', 'queued', '[]', '[]')
    `);
    insertSession.run(
      'sess_legacy_snapshot',
      'agent_safe',
      'safe-agent',
      1,
      JSON.stringify(unsupportedWebAgent),
    );
    insertSession.run(
      'sess_legacy_current',
      'agent_legacy-current',
      unsupportedWebAgent.name,
      1,
      null,
    );

    for (const sessionId of ['sess_legacy_snapshot', 'sess_legacy_current']) {
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(sessionId) as { count: number }).count;
      const response = await postJson(app, `/v1/sessions/${sessionId}/events`, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'do not run' }] }],
      });

      expect(response.res.status).toBe(400);
      expect(response.body.error).toEqual(unsupportedCapabilityError);
      expect((db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(sessionId) as { count: number }).count).toBe(eventsBefore);
      expect(executedSessionIds).not.toContain(sessionId);
    }

    for (const [sessionId, body] of [
      ['sess_legacy_snapshot', { content: 'do not stream' }],
      ['sess_legacy_current', { content: 'do not stream' }],
      ['sess_legacy_current', { content: 'do not send', stream: false }],
    ] as const) {
      const response = await postJson(app, `/v1/sessions/${sessionId}/messages`, body);
      expect(response.res.status).toBe(400);
      expect(response.res.headers.get('content-type')).toContain('application/json');
      expect(response.body.error).toEqual(unsupportedCapabilityError);
      expect((db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?').get(sessionId) as { count: number }).count).toBe(0);
      expect(executedSessionIds).not.toContain(sessionId);
    }
  });

  it('returns templates without enabled unavailable tools whose agents can be saved through the agent endpoint', async () => {
    const context = createCapabilityTestApp();
    contexts.push(context);

    const templatesResponse = await context.app.request('/v1/x/templates');
    expect(templatesResponse.status).toBe(200);
    const templates = await templatesResponse.json() as { data: Array<{ id: string; agent: AgentDefinition }> };

    for (const template of templates.data) {
      const enabledToolNames = getEnabledToolNames(template.agent);
      expect(enabledToolNames, template.id).not.toContain('web_fetch');
      expect(enabledToolNames, template.id).not.toContain('web_search');

      const created = await postJson(context.app, '/v1/agents', template.agent);
      expect(created.res.status, template.id).toBe(201);
    }
  });
});
