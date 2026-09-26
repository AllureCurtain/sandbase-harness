/**
 * `already_exists` — the last public code no test named.
 *
 * `mount-adapter.ts:53-72` deliberately has **no existence pre-check**: `create`
 * runs the INSERT inside a transaction and reads the unique-constraint violation,
 * because a pre-check and an insert are two statements and the pair is racy. The
 * class documents that choice, and this test is the first thing that checks the
 * documented consequence: the second writer gets `already_exists` rather than a
 * thrown error escaping to the executor, and the first writer's record survives.
 *
 * Two things are asserted beyond the code, because a code-only assertion would
 * pass even if the failed attempt left a half-written row: the store still holds
 * exactly one record with the original content, and the constraint is **per
 * store**, so the same path in another store is a different memory rather than a
 * collision.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { Database } from '@/core/db/database.js';
import { SqliteMemoryMountAdapter } from '@/core/memory/mount-adapter.js';

let db: Database;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'ma-memory-already-exists-'));
  db = new Database(join(dbDir, 'test.db'));
  db.runMigrations();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function store(name: string): string {
  const id = `memstore_${nanoid(12)}`;
  db.prepare('INSERT INTO memory_stores (id, name, description, provider, config, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, '', 'sqlite', '{}', '{}');
  return id;
}

describe('a second memory at an occupied path', () => {
  it('reports already_exists instead of throwing out of the transaction', () => {
    const storeId = store('occupied');
    const adapter = new SqliteMemoryMountAdapter(db);
    const first = adapter.create(storeId, '/notes/a.md', 'first');
    expect(first.ok).toBe(true);

    const second = adapter.create(storeId, '/notes/a.md', 'second');

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('already_exists');
    // The message has to name both facts a caller needs to repair the call.
    expect(second.error.message).toContain('/notes/a.md');
    expect(second.error.message).toContain(storeId);
  });

  it('leaves the first record and its content untouched', () => {
    const storeId = store('survivor');
    const adapter = new SqliteMemoryMountAdapter(db);
    adapter.create(storeId, '/notes/a.md', 'first');

    adapter.create(storeId, '/notes/a.md', 'second');

    const listed = adapter.list(storeId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.content).toBe('first');
  });

  it('treats the same path in another store as a different memory', () => {
    // The uniqueness the adapter relies on is scoped to the store. If it were
    // global, one tenant's path would block another's, and the code above would
    // be reported for a request that should have succeeded.
    const adapter = new SqliteMemoryMountAdapter(db);
    const a = store('tenant-a');
    const b = store('tenant-b');
    expect(adapter.create(a, '/notes/shared.md', 'in a').ok).toBe(true);

    const inOtherStore = adapter.create(b, '/notes/shared.md', 'in b');

    expect(inOtherStore.ok).toBe(true);
    const listed = adapter.list(b);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((file) => file.content)).toEqual(['in b']);
  });
});
