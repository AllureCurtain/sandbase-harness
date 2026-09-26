/**
 * `GET /v1/credential-vaults/{id}/credentials` honours the published `include_archived`.
 *
 * The published rule covers both collections in one sentence — "**列出 vault 或凭证：** 分页
 * 返回，最新的在前。默认排除已归档的记录（传递 `include_archived=true` 可将其包含在内）"
 * (`将工作委派给智能体/使用保管库进行身份验证.md:1119`) — and the vaults listing already read it.
 * The credentials listing never did: `listCredentials` hardcoded `AND archived_at IS NULL`, so
 * an archived credential was unreachable through the only listing that serves credentials,
 * and nothing in the response said the filter had been ignored. That is the same defect the
 * vaults listing carried before it was fixed, in the same file.
 *
 * `toCredential` already labelled an archived row (`status: 'archived'`, `archived_at`), so
 * reading the parameter was the only missing piece — which is why the assertions below check
 * the label as well as the membership: a row that is included but indistinguishable from an
 * active one would not be an answer to the question the parameter asks.
 *
 * Out of scope and unchanged: this listing is still unwindowed (`next_page` is always null)
 * and still ignores query parameters it does not implement. Both are recorded separately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('credential listing include_archived', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-cred-archived-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO credential_vaults (id, name) VALUES ('vlt_test', 'test vault')").run();

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

  async function post(path: string, body?: unknown) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  async function get(path: string) {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() as any };
  }

  async function addCredential(variableName: string): Promise<string> {
    const { status, body } = await post('/v1/credential-vaults/vlt_test/credentials', {
      name: variableName.toLowerCase(),
      auth_type: 'environment_variable',
      variable_name: variableName,
      value: 'secret-value',
      network: { type: 'unrestricted' },
      injection_locations: ['request_headers'],
    });
    expect(status, JSON.stringify(body)).toBe(201);
    return body.id as string;
  }

  /** Archive through the published route rather than by writing the column directly. */
  async function archive(credentialId: string) {
    const { status, body } = await post(
      `/v1/credential-vaults/vlt_test/credentials/${credentialId}/archive`,
    );
    expect(status, JSON.stringify(body)).toBeLessThan(300);
  }

  const list = (query = '') => get(`/v1/credential-vaults/vlt_test/credentials${query}`);

  it('excludes an archived credential by default and includes it when asked', async () => {
    const active = await addCredential('TOKEN_ACTIVE');
    const archived = await addCredential('TOKEN_ARCHIVED');
    await archive(archived);

    const byDefault = await list();
    expect(byDefault.status).toBe(200);
    expect(byDefault.body.data.map((row: any) => row.id)).toEqual([active]);

    const included = await list('?include_archived=true');
    expect(included.status).toBe(200);
    const ids = included.body.data.map((row: any) => row.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(archived);

    // Being included is not enough: the row has to be identifiable as archived, or the
    // caller cannot tell the rows the filter admitted from the rows that were never filtered.
    const row = included.body.data.find((candidate: any) => candidate.id === archived);
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
    const activeRow = included.body.data.find((candidate: any) => candidate.id === active);
    expect(activeRow.status).not.toBe('archived');
    expect(activeRow.archived_at).toBeNull();
  });

  it('treats an explicit false as the default', async () => {
    await addCredential('TOKEN_ACTIVE');
    const archived = await addCredential('TOKEN_ARCHIVED');
    await archive(archived);

    const { status, body } = await list('?include_archived=false');
    expect(status).toBe(200);
    expect(body.data.map((row: any) => row.id)).not.toContain(archived);
    expect(body.data).toHaveLength(1);
  });

  it('refuses an invalid value instead of falling back to the default', async () => {
    await addCredential('TOKEN_ACTIVE');

    const { status, body } = await list('?include_archived=yes');
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('include_archived');
    // Not an envelope: a rejected page must not read as "this vault has no credentials".
    expect(body).not.toHaveProperty('data');
  });

  it('keeps a deleted credential out even when archived rows are included', async () => {
    await addCredential('TOKEN_ACTIVE');
    const deleted = await addCredential('TOKEN_DELETED');
    // Deletion is a hard delete through the same state machine; set it directly so this test
    // is about the listing's filter rather than about the delete route.
    db.prepare("UPDATE credential_records SET status = 'deleted' WHERE id = ?").run(deleted);

    const { status, body } = await list('?include_archived=true');
    expect(status).toBe(200);
    expect(body.data.map((row: any) => row.id)).not.toContain(deleted);
    expect(body.data).toHaveLength(1);
  });
});
