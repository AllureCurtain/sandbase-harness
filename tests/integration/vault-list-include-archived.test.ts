/**
 * Integration test: the vault listing honours the published `include_archived`.
 *
 * The published contract makes the archived half of a vault collection opt-in:
 * "默认排除已归档的记录（传递 `include_archived=true` 可将其包含在内）"
 * (`将工作委派给智能体/使用保管库进行身份验证.md:1119`). The exclusion used to be
 * hardcoded in the listing's `WHERE` clause and the parameter was read by nobody, so a
 * caller who passed it was handed a page that omitted exactly the rows they asked for —
 * with nothing in the response to say the filter had been ignored.
 *
 * Both halves matter and are asserted separately: that archived vaults appear when
 * asked for, and that they stay absent when not. A change that returned them always
 * would satisfy the first half and be wrong.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const CANONICAL = '/v1/credential-vaults';
const PUBLISHED = '/v1/vaults';

describe('Vault listing, include_archived', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-vault-archived-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare(
      "INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_a', 'a', '', '{}', '{}')",
    ).run();
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

  /** One active vault and one archived vault, so both halves of the filter are observable. */
  async function seedOneArchived(server: ReturnType<typeof createServer>, prefix = PUBLISHED) {
    const active = await send(server, 'POST', prefix, { name: 'active vault' });
    const archived = await send(server, 'POST', prefix, { name: 'archived vault' });
    expect(active.status).toBe(201);
    expect(archived.status).toBe(201);

    const archivedId = archived.body!.id as string;
    const archivedRes = await send(server, 'POST', `${prefix}/${archivedId}/archive`);
    expect(archivedRes.status).toBe(200);
    // The seeding assumption itself: a vault that was not actually archived would make
    // every assertion below pass for the wrong reason.
    expect(archivedRes.body!.status).toBe('archived');
    expect(archivedRes.body!.archived_at).not.toBeNull();

    return { activeId: active.body!.id as string, archivedId };
  }

  function namesOf(page: Record<string, any>): string[] {
    return (page.data as { name: string }[]).map((vault) => vault.name).sort();
  }

  it('excludes archived vaults by default and includes them on request', async () => {
    const server = setUp();
    const { archivedId } = await seedOneArchived(server);

    const byDefault = await send(server, 'GET', PUBLISHED);
    expect(byDefault.status).toBe(200);
    expect(namesOf(byDefault.body!)).toEqual(['active vault']);

    const including = await send(server, 'GET', `${PUBLISHED}?include_archived=true`);
    expect(including.status).toBe(200);
    expect(namesOf(including.body!)).toEqual(['active vault', 'archived vault']);

    // The row must arrive labelled as archived, not merely present: a page that returned
    // the archived vault as if it were active is not the behavior that was asked for, and
    // is the failure a caller filtering on `status` would be misled by.
    const archivedRow = (including.body!.data as Record<string, any>[])
      .find((vault) => vault.id === archivedId);
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.status).toBe('archived');
    expect(archivedRow!.archived_at).not.toBeNull();

    const activeRow = (including.body!.data as Record<string, any>[])
      .find((vault) => vault.name === 'active vault');
    expect(activeRow!.status).not.toBe('archived');
    expect(activeRow!.archived_at).toBeNull();
  });

  it('reads `include_archived=false` as the documented default', async () => {
    const server = setUp();
    await seedOneArchived(server);

    const omitted = await send(server, 'GET', PUBLISHED);
    const explicitFalse = await send(server, 'GET', `${PUBLISHED}?include_archived=false`);

    expect(explicitFalse.status).toBe(200);
    // Compared to the omitted request rather than to a literal, so the two ways of asking
    // for the default cannot drift apart.
    expect(explicitFalse.body).toEqual(omitted.body);
  });

  it('refuses a malformed value instead of falling back to the default', async () => {
    const server = setUp();
    await seedOneArchived(server);

    for (const raw of ['yes', '1', '0', 'TRUE', 'True', '', 'null']) {
      const rejected = await send(server, 'GET', `${PUBLISHED}?include_archived=${raw}`);
      expect(rejected.status, `include_archived=${JSON.stringify(raw)}`).toBe(400);
      expect(rejected.body!.error.type, `include_archived=${JSON.stringify(raw)}`).toBe('invalid_request_error');
      expect(rejected.body!.error.message).toContain('include_archived');
      // A refusal, not a page: the caller must not be able to read the rejection as a
      // successful listing that happens to be empty.
      expect(rejected.body!.data).toBeUndefined();
    }
  });

  it('refuses a repeated parameter rather than guessing which was meant', async () => {
    const server = setUp();
    const { archivedId } = await seedOneArchived(server);

    // Two contradictory requests in one query string. Whichever value a first-wins or
    // last-wins rule picked, the caller asked for both, so there is no reading that is
    // not a guess.
    const repeated = await send(
      server,
      'GET',
      `${PUBLISHED}?include_archived=true&include_archived=false`,
    );
    expect(repeated.status).toBe(400);
    expect(repeated.body!.error.message).toContain('include_archived');

    // And the ambiguous request did not leak archived rows on the way to being refused.
    const clean = await send(server, 'GET', PUBLISHED);
    expect(clean.body!.data.some((vault: { id: string }) => vault.id === archivedId)).toBe(false);
  });

  it('behaves identically at the published and local prefixes', async () => {
    // One router mounted twice, so the parameter cannot be a property of one spelling.
    for (const prefix of [PUBLISHED, CANONICAL]) {
      const server = setUp();
      await seedOneArchived(server, prefix);

      const byDefault = await send(server, 'GET', prefix);
      const including = await send(server, 'GET', `${prefix}?include_archived=true`);

      expect(namesOf(byDefault.body!), `${prefix} default`).toEqual(['active vault']);
      expect(namesOf(including.body!), `${prefix} include_archived=true`)
        .toEqual(['active vault', 'archived vault']);
    }
  });

  it('keeps an archived vault unretrievable on its own', async () => {
    // Listing an archived vault is not an un-archive: the single-resource read and the
    // archive route are unchanged, so archiving is still terminal.
    const server = setUp();
    const { archivedId } = await seedOneArchived(server);

    const direct = await send(server, 'GET', `${PUBLISHED}/${archivedId}`);
    expect(direct.status).toBe(404);

    const reArchive = await send(server, 'POST', `${PUBLISHED}/${archivedId}/archive`);
    expect(reArchive.status).toBe(404);
  });
});
