/**
 * Integration test: the published vault update and delete verbs.
 *
 * The published surface (`POST /v1/vaults/{id}`, `DELETE /v1/vaults/{id}`,
 * `GET`/`DELETE /v1/vaults/{id}/credentials/{cid}`) used to be unreachable:
 * a vault could be created, listed and archived, and a credential could be
 * created and soft-deleted, but the verbs the SDK calls — patch a vault,
 * physically remove a vault, read one credential back, physically remove one —
 * had no route. This suite pins the implemented semantics:
 *
 *  - `POST /:id` patches `display_name`/`metadata` (`null` deletes a key) and
 *    refuses an archived vault with `vault_archived`.
 *  - `DELETE /:id` returns the `{id, type: 'vault_deleted'}` tombstone and
 *    physically removes the vault and its credentials; a non-terminal session
 *    referencing it answers `vault_in_use`; a terminal one does not block.
 *  - Credential `GET` returns the row without any secret material.
 *  - Credential `DELETE` returns `vault_credential_deleted` and physically
 *    removes the row while the audit trail survives.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const PUBLISHED = '/v1/vaults';
const LOCAL = '/v1/credential-vaults';

describe('Vault update/delete and credential retrieve/delete', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-vault-lifecycle-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  async function createVault(server: ReturnType<typeof createServer>, name = 'vault') {
    const res = await send(server, 'POST', PUBLISHED, { name, metadata: { team: 'a', drop: 'x' } });
    expect(res.status).toBe(201);
    return res.body!.id as string;
  }

  async function createCredential(server: ReturnType<typeof createServer>, vaultId: string) {
    const res = await send(server, 'POST', `${PUBLISHED}/${vaultId}/credentials`, {
      name: 'deploy token',
      auth_type: 'environment_variable',
      variable_name: 'DEPLOY_TOKEN',
      value: 'super-secret-value',
      injection_locations: ['request_headers'],
    });
    expect(res.status).toBe(201);
    return res.body!.id as string;
  }

  it('patches display_name and metadata, preserving omitted fields', async () => {
    const server = setUp();
    const id = await createVault(server);

    const res = await send(server, 'POST', `${PUBLISHED}/${id}`, {
      display_name: 'renamed vault',
      metadata: { team: 'b', drop: null, added: 'y' },
    });
    expect(res.status).toBe(200);
    expect(res.body!.name).toBe('renamed vault');
    expect(res.body!.display_name).toBe('renamed vault');
    expect(res.body!.metadata).toEqual({ team: 'b', added: 'y' });
  });

  it('preserves fields omitted from the patch', async () => {
    const server = setUp();
    const id = await createVault(server);

    const res = await send(server, 'POST', `${PUBLISHED}/${id}`, { metadata: { only: 'patch' } });
    expect(res.status).toBe(200);
    expect(res.body!.name).toBe('vault');
    expect(res.body!.metadata).toEqual({ team: 'a', drop: 'x', only: 'patch' });
  });

  it('refuses an update on an archived vault', async () => {
    const server = setUp();
    const id = await createVault(server);
    expect((await send(server, 'POST', `${PUBLISHED}/${id}/archive`)).status).toBe(200);

    const res = await send(server, 'POST', `${PUBLISHED}/${id}`, { display_name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body!.error.code).toBe('vault_archived');
  });

  it('deletes a vault physically, removes its credentials, and keeps the audit trail', async () => {
    const server = setUp();
    const id = await createVault(server);
    const credentialId = await createCredential(server, id);

    const res = await send(server, 'DELETE', `${PUBLISHED}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, type: 'vault_deleted' });

    expect((await send(server, 'GET', `${PUBLISHED}/${id}`)).status).toBe(404);
    expect(db!.prepare('SELECT COUNT(*) AS n FROM credential_records WHERE vault_id = ?').get(id))
      .toEqual({ n: 0 });
    const audit = db!.prepare(
      "SELECT action FROM credential_audit_events WHERE credential_id = ?",
    ).all(credentialId) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toContain('delete');
  });

  it('allows deleting an archived vault', async () => {
    const server = setUp();
    const id = await createVault(server);
    await send(server, 'POST', `${PUBLISHED}/${id}/archive`);

    const res = await send(server, 'DELETE', `${PUBLISHED}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body!.type).toBe('vault_deleted');
  });

  it('refuses to delete a vault a live session references', async () => {
    const server = setUp();
    const id = await createVault(server);
    db!.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_live', 'agent_x', 'x', 'env_a', 'running', ?)",
    ).run(JSON.stringify([id]));

    const res = await send(server, 'DELETE', `${PUBLISHED}/${id}`);
    expect(res.status).toBe(409);
    expect(res.body!.error.code).toBe('vault_in_use');
    expect(db!.prepare('SELECT id FROM credential_vaults WHERE id = ?').get(id)).toBeDefined();
  });

  it('lets a terminal session keep its vault_ids history without blocking the delete', async () => {
    const server = setUp();
    const id = await createVault(server);
    db!.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_done', 'agent_x', 'x', 'env_a', 'completed', ?)",
    ).run(JSON.stringify([id]));

    const res = await send(server, 'DELETE', `${PUBLISHED}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body!.type).toBe('vault_deleted');
  });

  it('retrieves one credential without exposing secret material', async () => {
    const server = setUp();
    const id = await createVault(server);
    const credentialId = await createCredential(server, id);

    const res = await send(server, 'GET', `${PUBLISHED}/${id}/credentials/${credentialId}`);
    expect(res.status).toBe(200);
    expect(res.body!.id).toBe(credentialId);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['secret_ciphertext', 'secret_nonce', 'secret_tag', 'super-secret-value']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('deletes a credential physically and returns the tombstone', async () => {
    const server = setUp();
    const id = await createVault(server);
    const credentialId = await createCredential(server, id);

    const res = await send(server, 'DELETE', `${PUBLISHED}/${id}/credentials/${credentialId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: credentialId, type: 'vault_credential_deleted' });

    expect(db!.prepare('SELECT id FROM credential_records WHERE id = ?').get(credentialId)).toBeUndefined();
    expect((await send(server, 'GET', `${PUBLISHED}/${id}/credentials/${credentialId}`)).status).toBe(404);
    // A second delete is a 404, not a repeated tombstone.
    expect((await send(server, 'DELETE', `${PUBLISHED}/${id}/credentials/${credentialId}`)).status).toBe(404);
    const audit = db!.prepare(
      "SELECT action FROM credential_audit_events WHERE credential_id = ?",
    ).all(credentialId) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toContain('delete');
  });

  it('answers 404 for a credential on an archived or missing vault', async () => {
    const server = setUp();
    const id = await createVault(server);
    const credentialId = await createCredential(server, id);
    await send(server, 'POST', `${PUBLISHED}/${id}/archive`);

    expect((await send(server, 'GET', `${PUBLISHED}/${id}/credentials/${credentialId}`)).status).toBe(404);
    expect((await send(server, 'DELETE', `${PUBLISHED}/${id}/credentials/${credentialId}`)).status).toBe(404);
    expect((await send(server, 'GET', `${PUBLISHED}/vlt_missing/credentials/x`)).status).toBe(404);
  });

  it('serves the same verbs under the local /v1/credential-vaults prefix', async () => {
    const server = setUp();
    const res = await send(server, 'POST', LOCAL, { name: 'local vault' });
    const id = res.body!.id as string;

    expect((await send(server, 'POST', `${LOCAL}/${id}`, { display_name: 'x' })).status).toBe(200);
    expect((await send(server, 'DELETE', `${LOCAL}/${id}`)).status).toBe(200);
  });
});
