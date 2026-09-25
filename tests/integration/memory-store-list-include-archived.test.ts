/**
 * Integration test: the memory-store listing honours the published `include_archived`.
 *
 * The published contract makes the archived half of a memory-store collection opt-in:
 * "默认排除已归档的存储；传递 `include_archived: true` 可将其包含在内"
 * (`管理智能体上下文/记忆存储.md:1206`), with `?include_archived=true` as its worked
 * example (`:1210`). The exclusion used to be hardcoded in the listing's `WHERE`, so a
 * caller who passed the parameter was handed a page that omitted exactly the rows they
 * asked for.
 *
 * The vault listing takes the same published parameter and the reading lives in one
 * shared helper, so the last case here compares the two collections' refusals to each
 * other rather than to a literal: two copies of a validation rule would drift, and the
 * comparison is what would notice.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('Memory store listing, include_archived', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-memstore-archived-'));
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

  /** One active store and one archived store, so both halves of the filter are observable. */
  async function seedOneArchived(server: ReturnType<typeof createServer>) {
    const active = await send(server, 'POST', '/v1/memory_stores', { name: 'active store' });
    const archived = await send(server, 'POST', '/v1/memory_stores', { name: 'archived store' });
    expect(active.status).toBe(201);
    expect(archived.status).toBe(201);

    const archivedId = archived.body!.id as string;
    const archivedRes = await send(server, 'POST', `/v1/memory_stores/${archivedId}/archive`);
    expect(archivedRes.status).toBe(200);
    // The seeding assumption itself: a store that was not actually archived would make
    // every assertion below pass for the wrong reason.
    expect(archivedRes.body!.status).toBe('archived');
    expect(archivedRes.body!.archived_at).not.toBeNull();

    return { activeId: active.body!.id as string, archivedId };
  }

  function namesOf(page: Record<string, any>): string[] {
    return (page.data as { name: string }[]).map((store) => store.name).sort();
  }

  it('excludes archived stores by default and includes them on request', async () => {
    const server = setUp();
    const { archivedId } = await seedOneArchived(server);

    const byDefault = await send(server, 'GET', '/v1/memory_stores');
    expect(byDefault.status).toBe(200);
    expect(namesOf(byDefault.body!)).toEqual(['active store']);

    const including = await send(server, 'GET', '/v1/memory_stores?include_archived=true');
    expect(including.status).toBe(200);
    expect(namesOf(including.body!)).toEqual(['active store', 'archived store']);

    // The row must arrive labelled as archived, not merely present: a page that returned
    // the archived store as if it were active is not the behavior that was asked for, and
    // is the failure a caller filtering on `status` would be misled by.
    const archivedRow = (including.body!.data as Record<string, any>[])
      .find((store) => store.id === archivedId);
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.status).toBe('archived');
    expect(archivedRow!.archived_at).not.toBeNull();

    const activeRow = (including.body!.data as Record<string, any>[])
      .find((store) => store.name === 'active store');
    expect(activeRow!.status).not.toBe('archived');
    expect(activeRow!.archived_at).toBeNull();
  });

  it('reads `include_archived=false` as the documented default', async () => {
    const server = setUp();
    await seedOneArchived(server);

    const omitted = await send(server, 'GET', '/v1/memory_stores');
    const explicitFalse = await send(server, 'GET', '/v1/memory_stores?include_archived=false');

    expect(explicitFalse.status).toBe(200);
    // Compared to the omitted request rather than to a literal, so the two ways of asking
    // for the default cannot drift apart.
    expect(explicitFalse.body).toEqual(omitted.body);
  });

  it('refuses a malformed value instead of falling back to the default', async () => {
    const server = setUp();
    await seedOneArchived(server);

    for (const raw of ['yes', '1', '0', 'TRUE', 'True', '', 'null']) {
      const rejected = await send(server, 'GET', `/v1/memory_stores?include_archived=${raw}`);
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

    const repeated = await send(
      server,
      'GET',
      '/v1/memory_stores?include_archived=true&include_archived=false',
    );
    expect(repeated.status).toBe(400);
    expect(repeated.body!.error.message).toContain('include_archived');

    // And the ambiguous request did not leak archived rows on the way to being refused.
    const clean = await send(server, 'GET', '/v1/memory_stores');
    expect(clean.body!.data.some((store: { id: string }) => store.id === archivedId)).toBe(false);
  });

  it('keeps an archived store unretrievable on its own', async () => {
    // Listing an archived store is not an un-archive: the single-resource read and the
    // archive route are unchanged, so archiving is still terminal.
    const server = setUp();
    const { archivedId } = await seedOneArchived(server);

    const direct = await send(server, 'GET', `/v1/memory_stores/${archivedId}`);
    expect(direct.status).toBe(404);

    const reArchive = await send(server, 'POST', `/v1/memory_stores/${archivedId}/archive`);
    expect(reArchive.status).toBe(404);
  });

  it('refuses the parameter with the same words as the vault listing', async () => {
    // The parameter has one implementation, shared by both collections. Comparing the two
    // collections' refusals to each other — rather than each to a literal — is what would
    // notice a second copy of the rule drifting away from the first.
    const server = setUp();
    await send(server, 'POST', '/v1/memory_stores', { name: 'store' });
    await send(server, 'POST', '/v1/credential-vaults', { name: 'vault' });

    for (const raw of ['yes', '', 'null']) {
      const store = await send(server, 'GET', `/v1/memory_stores?include_archived=${raw}`);
      const vault = await send(server, 'GET', `/v1/credential-vaults?include_archived=${raw}`);
      expect(store.status, `value ${JSON.stringify(raw)}`).toBe(400);
      expect(vault.status, `value ${JSON.stringify(raw)}`).toBe(400);
      expect(store.body!.error.message, `value ${JSON.stringify(raw)}`).toBe(vault.body!.error.message);
    }

    const storeRepeat = await send(
      server, 'GET', '/v1/memory_stores?include_archived=true&include_archived=false',
    );
    const vaultRepeat = await send(
      server, 'GET', '/v1/credential-vaults?include_archived=true&include_archived=false',
    );
    expect(storeRepeat.status).toBe(400);
    expect(vaultRepeat.status).toBe(400);
    expect(storeRepeat.body!.error.message).toBe(vaultRepeat.body!.error.message);
  });
});
