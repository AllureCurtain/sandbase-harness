/**
 * Integration test: `POST`/`PUT /v1/environments/{id}` and
 * `DELETE /v1/environments/{id}`.
 *
 * The published update contract is patch semantics on every field: `metadata`
 * merges key-by-key and deletes a key on `null` or `""`, `description` clears
 * on `null`, and `config` merges against the stored declaration. `POST` is the
 * documented method; `PUT` stays registered as the pre-official alias and must
 * answer identically.
 *
 * Deletion is physical and answers `{ id, type: "environment_deleted" }`. It is
 * refused when the row is the workspace default, or when any session still
 * names the environment — `sessions.environment_id` is a hard foreign key, so
 * even finished sessions block the delete rather than lose their history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('environment update and delete', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-env-update-delete-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_default', 'local', '', '{}', '{}')").run();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_edit', 'editable', 'old notes', '{}', ?)"
    ).run(JSON.stringify({ keep: '1', drop: '2' }));
    app = createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const update = async (method: string, id: string, body: Record<string, unknown>) => {
    const res = await app.request(`/v1/environments/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const stored = (id: string) =>
    db.prepare('SELECT name, description, config, metadata FROM environments WHERE id = ?').get(id) as
      | { name: string; description: string; config: string; metadata: string }
      | undefined;

  it('updates name, description, and metadata with patch semantics over POST', async () => {
    const { status, body } = await update('POST', 'env_edit', {
      name: 'renamed',
      description: 'new notes',
      metadata: { drop: null, added: '3' },
    });

    expect(status).toBe(200);
    expect(body.name).toBe('renamed');
    expect(body.description).toBe('new notes');
    // `keep` survived the patch, `drop` was deleted by `null`, `added` is new.
    expect(body.metadata).toEqual({ keep: '1', added: '3' });
    const row = stored('env_edit');
    expect(JSON.parse(row!.metadata)).toEqual({ keep: '1', added: '3' });
  });

  it('gives PUT the same patch semantics as the published POST', async () => {
    const { status, body } = await update('PUT', 'env_edit', { metadata: { drop: null } });
    expect(status).toBe(200);
    expect(body.metadata).toEqual({ keep: '1' });
  });

  it('deletes a metadata key on an empty string too', async () => {
    const { status, body } = await update('POST', 'env_edit', { metadata: { keep: '' } });
    expect(status).toBe(200);
    expect(body.metadata).toEqual({ drop: '2' });
  });

  it('clears description on null and preserves it when omitted', async () => {
    const cleared = await update('POST', 'env_edit', { description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.description).toBeNull();
    expect(stored('env_edit')!.description).toBe('');

    const renamed = await update('POST', 'env_edit', { name: 'still no notes' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.description).toBeNull();
  });

  it('preserves metadata when the field is omitted or null', async () => {
    const omitted = await update('POST', 'env_edit', { name: 'untouched metadata' });
    expect(omitted.status).toBe(200);
    expect(omitted.body.metadata).toEqual({ keep: '1', drop: '2' });

    const wholeNull = await update('POST', 'env_edit', { metadata: null });
    expect(wholeNull.status).toBe(200);
    expect(wholeNull.body.metadata).toEqual({ keep: '1', drop: '2' });
  });

  it('refuses a metadata value that is not an object', async () => {
    const { status, body } = await update('POST', 'env_edit', { metadata: 'oops' });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('metadata');
  });

  it('answers 404 for an update or delete of a missing or archived environment', async () => {
    expect((await update('POST', 'env_missing', { name: 'x' })).status).toBe(404);

    db.prepare("UPDATE environments SET archived_at = datetime('now') WHERE id = 'env_edit'").run();
    expect((await update('POST', 'env_edit', { name: 'x' })).status).toBe(404);

    const res = await app.request('/v1/environments/env_edit', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('refuses to delete the workspace default environment', async () => {
    const res = await app.request('/v1/environments/env_default', { method: 'DELETE' });
    const body = await res.json() as any;

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('environment_protected');
    expect(stored('env_default')).toBeDefined();
  });

  it('refuses to delete an environment a session still names', async () => {
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_live', 'agent_x', 'x', 'env_edit', 'running')"
    ).run();

    const res = await app.request('/v1/environments/env_edit', { method: 'DELETE' });
    const body = await res.json() as any;

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('environment_in_use');
    expect(stored('env_edit')).toBeDefined();
  });

  it('keeps finished-session history attached: a terminal session still blocks the delete', async () => {
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_done', 'agent_x', 'x', 'env_edit', 'completed')"
    ).run();

    const res = await app.request('/v1/environments/env_edit', { method: 'DELETE' });
    const body = await res.json() as any;

    // The row is a foreign-key target of session history: deleting it would
    // orphan the record of which environment the session ran on.
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('environment_in_use');
  });

  it('physically deletes an unreferenced environment and cleans up its worker keys', async () => {
    db.prepare(
      "INSERT INTO environment_worker_keys (id, environment_id, name, key_hash, key_prefix) VALUES ('ewk_1', 'env_edit', 'w', 'hash_1', 'sbwk_x')"
    ).run();

    const res = await app.request('/v1/environments/env_edit', { method: 'DELETE' });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: 'env_edit', type: 'environment_deleted' });
    expect(stored('env_edit')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM environment_worker_keys WHERE environment_id = ?').get('env_edit'))
      .toEqual({ count: 0 });

    const read = await app.request('/v1/environments/env_edit');
    expect(read.status).toBe(404);
  });

  it('answers 404 when deleting a missing environment', async () => {
    const res = await app.request('/v1/environments/env_missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
