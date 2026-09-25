/**
 * Integration test: the vault and memory-store listings honour the published
 * `limit`/`page`.
 *
 * The published rule is "使用 `limit`（默认 20，最大 100）和 `page` 游标进行分页"
 * (`管理智能体上下文/Dreams.md:575`), and the listings it governs are described as
 * paginated in the same words ("分页返回，最新的在前",
 * `将工作委派给智能体/使用保管库进行身份验证.md:1119`). Both listings answered a
 * single unfiltered page and read neither parameter, so a caller who asked for page
 * two was handed page one again with a `next_page` of `null`, and nothing in the
 * response said the request had been ignored.
 *
 * The assertions are deliberately about **the collection as a whole**, not just the
 * size of one page: a page that repeats a row, or that starts from the wrong end, has
 * the right length and is still wrong. Every page walk here is closed by checking that
 * the pages partition the collection exactly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const VAULTS = '/v1/credential-vaults';
const VAULTS_PUBLISHED = '/v1/vaults';
const STORES = '/v1/memory_stores';
const VAULT_COUNT = 25;

describe('Collection listing pagination', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-collection-pagination-'));
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

  /** Seed `count` rows of one collection, oldest first, and return their ids in order. */
  async function seed(
    server: ReturnType<typeof createServer>,
    prefix: string,
    count: number,
    label: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const created = await send(server, 'POST', prefix, { name: `${label}-${String(index).padStart(2, '0')}` });
      expect(created.status, `${label} ${index}`).toBe(201);
      ids.push(created.body!.id as string);
    }
    return ids;
  }

  function idsOf(page: Record<string, any>): string[] {
    return (page.data as { id: string }[]).map((row) => row.id);
  }

  /** Walk `next_page` to the end, collecting every id the endpoint returned. */
  async function walk(
    server: ReturnType<typeof createServer>,
    path: string,
    first: Record<string, any>,
  ): Promise<{ ids: string[]; pages: number }> {
    const ids = idsOf(first);
    let pages = 1;
    let next = first.next_page as string | null;
    while (next) {
      // A cursor that loops would otherwise hang the suite rather than fail it.
      expect(pages, 'the walk did not terminate').toBeLessThan(50);
      const page = await send(server, 'GET', `${path}${path.includes('?') ? '&' : '?'}page=${encodeURIComponent(next)}`);
      expect(page.status).toBe(200);
      ids.push(...idsOf(page.body!));
      next = page.body!.next_page as string | null;
      pages += 1;
    }
    return { ids, pages };
  }

  it('answers the published default page of 20 and offers a next cursor', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    const page = await send(server, 'GET', VAULTS);
    expect(page.status).toBe(200);
    // The published default is 20, not "everything": a listing that ignored `limit`
    // would answer all 25 here and pass a weaker assertion.
    expect(idsOf(page.body!)).toHaveLength(20);
    expect(page.body!.prev_page).toBeNull();
    expect(page.body!.next_page).toEqual(expect.any(String));

    const capped = await send(server, 'GET', `${VAULTS}?limit=100`);
    expect(idsOf(capped.body!)).toHaveLength(VAULT_COUNT);
    expect(capped.body!.next_page).toBeNull();
  });

  it('partitions the whole collection across cursor pages with no repeats', async () => {
    const server = setUp();
    const seeded = await seed(server, VAULTS, VAULT_COUNT, 'vault');

    const first = await send(server, 'GET', `${VAULTS}?limit=10`);
    expect(idsOf(first.body!)).toHaveLength(10);
    expect(first.body!.prev_page).toBeNull();

    const { ids, pages } = await walk(server, `${VAULTS}?limit=10`, first.body!);
    expect(pages).toBe(3);
    expect(ids).toHaveLength(VAULT_COUNT);
    // Exactly once each: a page boundary that repeats or skips a row is the failure
    // mode an offset scheme actually has, and a length check cannot see it.
    expect(new Set(ids).size).toBe(VAULT_COUNT);
    expect([...ids].sort()).toEqual([...seeded].sort());
  });

  it('returns to the previous page with `prev_page`', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    const first = await send(server, 'GET', `${VAULTS}?limit=10`);
    const second = await send(server, 'GET', `${VAULTS}?limit=10&page=${encodeURIComponent(first.body!.next_page)}`);
    expect(second.body!.prev_page).toEqual(expect.any(String));
    expect(idsOf(second.body!)).not.toEqual(idsOf(first.body!));

    const back = await send(server, 'GET', `${VAULTS}?limit=10&page=${encodeURIComponent(second.body!.prev_page)}`);
    expect(back.status).toBe(200);
    expect(idsOf(back.body!)).toEqual(idsOf(first.body!));
    // The first page's own `prev_page` stays null: one step back from page two is the
    // start of the collection, not a cursor to a page that does not exist.
    expect(back.body!.prev_page).toBeNull();
  });

  it('ends the walk exactly on the last full page', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    const exact = await send(server, 'GET', `${VAULTS}?limit=${VAULT_COUNT}`);
    expect(idsOf(exact.body!)).toHaveLength(VAULT_COUNT);
    // 25 rows in pages of 25: a boundary computed with `<=` instead of `<` would offer
    // one more page here, and that page would be empty.
    expect(exact.body!.next_page).toBeNull();

    const pageFour = await send(server, 'GET', `${VAULTS}?limit=10`);
    const secondPage = await send(server, 'GET', `${VAULTS}?limit=10&page=${encodeURIComponent(pageFour.body!.next_page)}`);
    const thirdPage = await send(server, 'GET', `${VAULTS}?limit=10&page=${encodeURIComponent(secondPage.body!.next_page)}`);
    expect(idsOf(thirdPage.body!)).toHaveLength(5);
    expect(thirdPage.body!.next_page).toBeNull();
  });

  it('refuses a limit it does not implement instead of substituting the default', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    for (const raw of ['0', '101', 'abc', '1.5', '', '-1', ' 5 ']) {
      const vault = await send(server, 'GET', `${VAULTS}?limit=${encodeURIComponent(raw)}`);
      expect(vault.status, `limit=${JSON.stringify(raw)}`).toBe(400);
      expect(vault.body!.error.type, `limit=${JSON.stringify(raw)}`).toBe('invalid_request_error');
      expect(vault.body!.error.message).toContain('limit');
      // The range is published, so it is named rather than left to a second request.
      expect(vault.body!.error.message, `limit=${JSON.stringify(raw)}`).toContain('100');
    }

    const repeated = await send(server, 'GET', `${VAULTS}?limit=5&limit=10`);
    expect(repeated.status).toBe(400);
    expect(repeated.body!.error.message).toContain('sent 2 times');
  });

  it('refuses a page cursor it did not issue', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    for (const raw of ['garbage', 'not-a-cursor', Buffer.from('{"page":0}', 'utf8').toString('base64url')]) {
      const page = await send(server, 'GET', `${VAULTS}?page=${encodeURIComponent(raw)}`);
      expect(page.status, `page=${JSON.stringify(raw)}`).toBe(400);
      expect(page.body!.error.message).toContain('must be a cursor returned by this endpoint');
    }
  });

  it('refuses a cursor issued for a different filter or collection', async () => {
    const server = setUp();
    await seed(server, VAULTS, VAULT_COUNT, 'vault');
    await seed(server, STORES, VAULT_COUNT, 'store');

    const next = (await send(server, 'GET', VAULTS)).body!.next_page as string;
    const encoded = encodeURIComponent(next);

    // Same collection, different view: replaying this cursor under `include_archived`
    // would answer a page counted against the other collection.
    const refiltered = await send(server, 'GET', `${VAULTS}?include_archived=true&page=${encoded}`);
    expect(refiltered.status).toBe(400);
    expect(refiltered.body!.error.message).toContain('different filter');

    // Different collection with the same ordering: the cursor names the collection it
    // was counted in, so it is refused rather than applied to another collection's rows.
    const replayed = await send(server, 'GET', `${STORES}?page=${encoded}`);
    expect(replayed.status).toBe(400);
    expect(replayed.body!.error.message).toContain('different ordering');

    // The control: the same cursor against the query that issued it is accepted, so the
    // two refusals above are about the mismatch and not about the cursor being unusable.
    const accepted = await send(server, 'GET', `${VAULTS}?page=${encoded}`);
    expect(accepted.status).toBe(200);
    expect(idsOf(accepted.body!)).toHaveLength(5);
  });

  it('paginates the memory-store listing the same way, on both mount prefixes', async () => {
    const server = setUp();
    const seeded = await seed(server, STORES, VAULT_COUNT, 'store');
    // More vaults than the default page, so the published mount has to window too.
    await seed(server, VAULTS, VAULT_COUNT, 'vault');

    const page = await send(server, 'GET', STORES);
    expect(idsOf(page.body!)).toHaveLength(20);

    const first = await send(server, 'GET', `${STORES}?limit=10`);
    const walked = await walk(server, `${STORES}?limit=10`, first.body!);
    expect(walked.ids).toHaveLength(VAULT_COUNT);
    expect([...walked.ids].sort()).toEqual([...seeded].sort());

    // The vault router is mounted at the published prefix too, so the parameter has to
    // work at both spellings without a second edit: the same window, the same rows.
    const canonical = await send(server, 'GET', `${VAULTS}?limit=7`);
    const published = await send(server, 'GET', `${VAULTS_PUBLISHED}?limit=7`);
    expect(published.status).toBe(200);
    expect(idsOf(published.body!)).toHaveLength(7);
    expect(idsOf(published.body!)).toEqual(idsOf(canonical.body!));
  });

  it('windows the published newest-first order, deterministically', async () => {
    const server = setUp();
    const seeded = await seed(server, VAULTS, VAULT_COUNT, 'vault');

    // `created_at` is `datetime('now')`, so the rows seeded above all share one
    // timestamp and say nothing about which end of the collection page one starts at.
    // Distinct stamps make the published "最新的在前" a measurable claim rather than one
    // that passes because insertion order happened to agree with it.
    seeded.forEach((id, index) => {
      db!.prepare('UPDATE credential_vaults SET created_at = ? WHERE id = ?')
        .run(`2026-01-01T00:00:${String(index).padStart(2, '0')}Z`, id);
    });
    const newestFirst = [...seeded].reverse();

    const page = await send(server, 'GET', `${VAULTS}?limit=7`);
    expect(idsOf(page.body!)).toEqual(newestFirst.slice(0, 7));

    const walked = await walk(server, `${VAULTS}?limit=7`, page.body!);
    expect(walked.ids).toEqual(newestFirst);
  });

  it('answers the same refusals for both collections', async () => {
    const server = setUp();

    for (const raw of ['0', '101', 'abc']) {
      const vault = await send(server, 'GET', `${VAULTS}?limit=${raw}`);
      const store = await send(server, 'GET', `${STORES}?limit=${raw}`);
      expect(store.status, `limit=${raw}`).toBe(vault.status);
      // The message is normalized only where the two collections legitimately differ:
      // the shared helper produces it, so any other difference is drift.
      expect(store.body!.error.message, `limit=${raw}`).toBe(vault.body!.error.message);
    }
  });
});
