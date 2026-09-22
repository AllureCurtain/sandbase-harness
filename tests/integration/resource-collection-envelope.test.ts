/**
 * The canonical envelope for the resource collections that return a complete set.
 *
 * `contracts/anthropic-cma/pagination.md` §2 maps the envelopes and §4 names the
 * collections still on the local one. This file covers the first group of
 * conversions: the Vault, credential, memory-store and memory listings return their
 * whole result, so the honest canonical page is `{data, prev_page: null,
 * next_page: null}` — a synthetic cursor into an empty page would be worse than
 * admitting the end.
 *
 * The audit listings are deliberately **not** converted here: they are truncated by
 * `limit` with no continuation, so neither envelope can describe them truthfully
 * yet, and they stay on the local shape until that is fixed.
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
      '/v1/credential-vaults',
      `/v1/credential-vaults/${vaultId}/credentials`,
      '/v1/memory_stores',
    ];
    for (const path of paths) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expectCursorPage(body, path);
      expect(body.data.length, path).toBeGreaterThan(0);
    }

    // The nested memory listing is scoped by `path_prefix`/`depth` and returns the
    // whole scope, so it has the same shape with an empty result.
    const stores = await get('/v1/memory_stores');
    const memories = await get(`/v1/memory_stores/${stores.body.data[0].id}/memories`);
    expect(memories.res.status).toBe(200);
    expectCursorPage(memories.body, 'memories');
    expect(memories.body.data).toEqual([]);
  });

  it('leaves the limit-truncated audit listings on the local envelope', async () => {
    const { vaultId, credentialId } = await setupApp();
    // Two audit events, so a `limit=1` listing really is truncated.
    await post(`/v1/credential-vaults/${vaultId}/credentials/${credentialId}/mark-used`);
    await post(`/v1/credential-vaults/${vaultId}/credentials/${credentialId}/mark-used`);

    const vaultAudit = await get(`/v1/credential-vaults/${vaultId}/audit`);
    expect(vaultAudit.res.status).toBe(200);
    expect(vaultAudit.body).toHaveProperty('has_more');
    expect(vaultAudit.body).not.toHaveProperty('prev_page');

    // The listing is windowed by `limit` with nothing to continue from, which is why
    // it is not on cursors yet: `next_page: null` would read as "this is all", and the
    // local envelope does not report the truncation either. Converting it needs a
    // followable cursor first.
    const truncated = await get(`/v1/credential-vaults/${vaultId}/audit?limit=1`);
    expect(truncated.res.status).toBe(200);
    expect(truncated.body.data).toHaveLength(1);
    expect(truncated.body).not.toHaveProperty('prev_page');
  });

  it('leaves the SDK-typed collections on the local envelope', async () => {
    await setupApp();

    for (const path of ['/v1/agents', '/v1/skills', '/v1/api-keys', '/v1/environments', '/v1/files', '/v1/sessions']) {
      const { res, body } = await get(path);
      expect(res.status, path).toBe(200);
      expect(typeof body.has_more, path).toBe('boolean');
      expect(body, path).not.toHaveProperty('prev_page');
    }
  });
});
