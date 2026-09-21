import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import {
  SESSION_RESOURCE_ID_PREFIX,
  addSessionResource,
  attachSessionResources,
  createSessionResourceId,
  deleteSessionResource,
  getSessionResource,
  isSessionResourceId,
  listSessionResources,
  rotateGithubAuthorizationToken,
  toApiSessionResourceInstance,
} from '@/core/session/session-resources.js';

describe('session resource instances', () => {
  let db: Database;
  let temp: string;
  const sessionId = 'sess_test';

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'session-resource-test-'));
    db = new Database(join(temp, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_demo', 'demo', '{}')");
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('${sessionId}', 'agent_demo', 'demo', 'env_default', 'idle')`);
  });

  afterEach(() => {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  });

  it('mints a canonical sesrsc_ identifier', () => {
    const id = createSessionResourceId();
    expect(id.startsWith(SESSION_RESOURCE_ID_PREFIX)).toBe(true);
    expect(isSessionResourceId(id)).toBe(true);
    expect(isSessionResourceId('ses_abc')).toBe(false);
  });

  it('numbers attached resources in declaration order', () => {
    addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' }, mountPath: '/a.csv' });
    addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_b' }, mountPath: '/b.csv' });
    const listed = listSessionResources(db, sessionId);
    expect(listed.map((entry) => entry.position)).toEqual([0, 1]);
    expect(listed.map((entry) => entry.mountPath)).toEqual(['/a.csv', '/b.csv']);
  });

  it('gives every resource a distinct ID', () => {
    const first = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' } });
    const second = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_b' } });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.instance.id).not.toBe(second.instance.id);
  });

  it('keeps a resource addressable by ID', () => {
    const added = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' } });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(getSessionResource(db, sessionId, added.instance.id)?.id).toBe(added.instance.id);
    expect(getSessionResource(db, sessionId, 'sesrsc_missing')).toBeUndefined();
  });

  it('scopes a lookup to its own session', () => {
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status) VALUES ('sess_other', 'agent_demo', 'demo', 'env_default', 'idle')`);
    const added = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' } });
    if (!added.ok) throw new Error('setup failed');
    expect(getSessionResource(db, 'sess_other', added.instance.id)).toBeUndefined();
  });

  it('removes a file resource while the session runs', () => {
    const added = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' } });
    if (!added.ok) throw new Error('setup failed');
    const removed = deleteSessionResource(db, sessionId, added.instance.id);
    expect(removed.ok).toBe(true);
    expect(listSessionResources(db, sessionId)).toEqual([]);
    expect(getSessionResource(db, sessionId, added.instance.id)).toBeUndefined();
  });

  it('reports a missing resource on delete', () => {
    const result = deleteSessionResource(db, sessionId, 'sesrsc_missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('refuses a memory_store attached after creation', () => {
    const result = addSessionResource(db, { sessionId, type: 'memory_store', resource: { type: 'memory_store', memory_store_id: 'memstore_x' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_request');
      expect(result.message).toContain('only be attached when the session is created');
    }
    expect(listSessionResources(db, sessionId)).toEqual([]);
  });

  it('allows a memory_store attached at creation', () => {
    const result = addSessionResource(
      db,
      { sessionId, type: 'memory_store', resource: { type: 'memory_store', memory_store_id: 'memstore_x' } },
      { atCreation: true },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses to remove a memory_store from a running session', () => {
    const added = addSessionResource(
      db,
      { sessionId, type: 'memory_store', resource: { type: 'memory_store', memory_store_id: 'memstore_x' } },
      { atCreation: true },
    );
    if (!added.ok) throw new Error('setup failed');
    const removed = deleteSessionResource(db, sessionId, added.instance.id);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.message).toContain('cannot be removed');
  });

  it('rotates a github authorization token in place', () => {
    const added = addSessionResource(db, {
      sessionId,
      type: 'github_repository',
      resource: {
        type: 'github_repository',
        url: 'https://github.com/acme/widget',
        repository: 'acme/widget',
        mount_path: '/workspace/widget',
        authorization_token: { type: 'encrypted_secret', ciphertext: 'old' },
      },
      mountPath: '/workspace/widget',
    });
    if (!added.ok) throw new Error('setup failed');

    const rotated = rotateGithubAuthorizationToken(db, sessionId, added.instance.id, {
      type: 'encrypted_secret',
      ciphertext: 'new',
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const stored = getSessionResource(db, sessionId, added.instance.id);
    expect((stored?.config.authorization_token as Record<string, unknown>).ciphertext).toBe('new');
    // The mount identity is untouched by a rotation.
    expect(stored?.config.url).toBe('https://github.com/acme/widget');
    expect(stored?.config.mount_path).toBe('/workspace/widget');
  });

  it('refuses to rotate a token on a non-github resource', () => {
    const added = addSessionResource(db, { sessionId, type: 'file', resource: { type: 'file', file_id: 'file_a' } });
    if (!added.ok) throw new Error('setup failed');
    const result = rotateGithubAuthorizationToken(db, sessionId, added.instance.id, { ciphertext: 'new' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('only github_repository resources');
  });

  it('never echoes an authorization token in the API projection', () => {
    const added = addSessionResource(db, {
      sessionId,
      type: 'github_repository',
      resource: {
        type: 'github_repository',
        url: 'https://github.com/acme/widget',
        repository: 'acme/widget',
        mount_path: '/workspace/widget',
        authorization_token: { type: 'encrypted_secret', ciphertext: 'secret-value' },
      },
      mountPath: '/workspace/widget',
    });
    if (!added.ok) throw new Error('setup failed');

    const projected = toApiSessionResourceInstance(added.instance);
    expect(projected).not.toHaveProperty('authorization_token');
    expect(JSON.stringify(projected)).not.toContain('secret-value');
    expect(projected.id).toBe(added.instance.id);
    expect(projected.type).toBe('github_repository');
    expect(projected.url).toBe('https://github.com/acme/widget');
  });

  it('attaches every resource from a session-create payload', () => {
    const attached = attachSessionResources(db, sessionId, [
      { type: 'file', file_id: 'file_a', mount_path: '/a.csv' },
      { type: 'memory_store', memory_store_id: 'memstore_x', access: 'read_only' },
    ]);
    expect(attached).toHaveLength(2);
    expect(attached.map((entry) => entry.type)).toEqual(['file', 'memory_store']);
    expect(listSessionResources(db, sessionId)).toHaveLength(2);
  });

  it('continues past a malformed resource in a create payload', () => {
    // A create payload was already normalized by the route, so a bad entry
    // simply fails to attach rather than aborting the whole session.
    const attached = attachSessionResources(db, sessionId, [
      { type: 'not_a_type' as never, file_id: 'file_a' },
      { type: 'file', file_id: 'file_b' },
    ]);
    expect(attached.map((entry) => entry.type)).toEqual(['not_a_type', 'file']);
  });
});
