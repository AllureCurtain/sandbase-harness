/**
 * The canonical envelope for the resource collections that return a complete set.
 *
 * `contracts/anthropic-cma/pagination.md` §2 maps the envelopes and §4 names the
 * collections still on the local one. This file covers the complete-set conversions:
 * the Vault, credential, memory-store and memory listings return their whole result,
 * so the honest canonical page is `{data, prev_page: null, next_page: null}` — a
 * synthetic cursor into an empty page would be worse than admitting the end.
 *
 * The audit listings started here as an exception and have since moved: they now
 * carry a real offset cursor, which `followable-cursor-collections.test.ts` covers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('resource collection envelope', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let app: ReturnType<typeof createServer>;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function post(path: string, body?: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { res, body: await res.json() as any };
  }

  /** The canonical envelope, with no local field name present. */
  function expectCursorPage(body: any, label: string) {
    expect(Object.keys(body).sort(), label).toEqual(['data', 'next_page', 'prev_page']);
    expect(body.prev_page, label).toBeNull();
    expect(body.next_page, label).toBeNull();
  }

  /** A runtime holding one vault with one credential, and one memory store. */
  async function setupApp(): Promise<{ vaultId: string; credentialId: string }> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-resource-envelope-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    // An environment and an agent, so the env-scoped and agent-scoped listings have
    // something to page over rather than answering an empty page that would pass any
    // shape assertion.
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
      'agent_envelope',
      'envelope-agent',
      JSON.stringify({ name: 'envelope-agent', model: 'gpt-4o', system: 'You are a test agent.' }),
    );
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir: tmpDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        target: 'local',
      },
    });

    const vault = await post('/v1/credential-vaults', { name: 'Vault' });
    expect(vault.res.status).toBe(201);
    const credential = await post(`/v1/credential-vaults/${vault.body.id}/credentials`, {
      name: 'token',
      auth_type: 'environment_variable',
      variable_name: 'TOKEN',
      value: 'secret-value',
      network: { type: 'unrestricted' },
    });
    expect(credential.res.status).toBe(201);
    const store = await post('/v1/memory_stores', { name: 'Store' });
    expect(store.res.status).toBe(201);
    return { vaultId: vault.body.id as string, credentialId: credential.body.id as string };
  }

  it('returns the canonical envelope for the collections that return their whole set', async () => {
    const { vaultId } = await setupApp();

    const paths = [
      '/v1/agents',
      '/v1/credential-vaults',
      `/v1/credential-vaults/${vaultId}/credentials`,
      '/v1/environments',
      '/v1/memory_stores',
    ];
    for (const path of paths) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expectCursorPage(body, path);
      expect(body.data.length, path).toBeGreaterThan(0);
    }

    // These two answer an empty list in this fixture, so only the shape is asserted:
    // what is being pinned is the envelope, not the seeded content.
    for (const path of ['/v1/api-keys', '/v1/files']) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expectCursorPage(body, path);
    }

    // The nested memory listing is scoped by `path_prefix`/`depth` and returns the
    // whole scope, so it has the same shape with an empty result.
    const stores = await get('/v1/memory_stores');
    const memories = await get(`/v1/memory_stores/${stores.body.data[0].id}/memories`);
    expect(memories.res.status).toBe(200);
    expectCursorPage(memories.body, 'memories');
    expect(memories.body.data).toEqual([]);
  });

  it('serves the nested agent and environment collections under the same rule', async () => {
    await setupApp();

    const agents = await get('/v1/agents');
    const listed = agents.body.data[0];
    expect(listed, 'the seeded agent').toBeDefined();

    const versions = await get(`/v1/agents/${listed.id}/versions`);
    expect(versions.res.status).toBe(200);
    expectCursorPage(versions.body, 'agent versions');
    expect(versions.body.data.length, 'agent versions').toBeGreaterThan(0);

    const workerKeys = await get('/v1/environments/env_default/worker-keys');
    expect(workerKeys.res.status).toBe(200);
    expectCursorPage(workerKeys.body, 'worker keys');
  });

  it('serves the audit listings with a cursor rather than a truncated local page', async () => {
    const { vaultId, credentialId } = await setupApp();
    // Two audit events, so a `limit=1` listing really is truncated.
    await post(`/v1/credential-vaults/${vaultId}/credentials/${credentialId}/mark-used`);
    await post(`/v1/credential-vaults/${vaultId}/credentials/${credentialId}/mark-used`);

    const vaultAudit = await get(`/v1/credential-vaults/${vaultId}/audit`);
    expect(vaultAudit.res.status).toBe(200);
    expectCursorPage(vaultAudit.body, 'vault audit');

    // A cut page now says so, which the local envelope could not: `has_more` was
    // false whether or not rows were left behind.
    const truncated = await get(`/v1/credential-vaults/${vaultId}/audit?limit=1`);
    expect(truncated.res.status).toBe(200);
    expect(truncated.body.data).toHaveLength(1);
    expect(truncated.body.next_page).not.toBeNull();
  });

  it('leaves the session listing and the windowed work-item listing on the local envelope', async () => {
    await setupApp();

    // `sessions` is windowed by a page-number cursor and is the next collection to
    // convert; the work-item listing is windowed by `limit` with no continuation and
    // carries a `counts` object, so it is an extension shape rather than a canonical
    // collection.
    for (const path of ['/v1/sessions', '/v1/environments/env_default/work-items']) {
      const { res, body } = await get(path);
      expect([200, 503], path).toContain(res.status);
      if (res.status !== 200) continue;
      expect(typeof body.has_more, path).toBe('boolean');
      expect(body, path).not.toHaveProperty('prev_page');
    }
  });
});
