/**
 * Proves the startup path fails closed.
 *
 * A connection whose required pragmas cannot be confirmed must not be handed to
 * callers, and the handle the constructor had already opened must not be left
 * behind. The pragma module is mocked here because a real connection on this
 * platform always satisfies the contract; the refusals themselves are exercised
 * against real connections in `database-pragmas.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pragmaCalls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('@/core/db/pragmas.js', () => ({
  applyConnectionPragmas: () => {
    pragmaCalls.order.push('apply');
  },
  verifyConnectionPragmas: () => {
    pragmaCalls.order.push('verify');
    throw new Error('sqlite pragma busy_timeout reads back 0, expected 5000');
  },
}));

import { Database } from '@/core/db/database.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ma-sqlite-failclosed-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  pragmaCalls.order.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Database startup verification', () => {
  it('applies every pragma before reading any of them back', () => {
    const dbPath = join(makeTempDir(), 'state.db');
    expect(() => new Database(dbPath)).toThrowError(/sqlite pragma busy_timeout reads back 0, expected 5000/);
    expect(pragmaCalls.order).toEqual(['apply', 'verify']);
  });

  it('releases the connection it opened when verification fails', () => {
    const dir = makeTempDir();
    expect(() => new Database(join(dir, 'state.db'))).toThrowError(/reads back 0/);

    // A failed construction must not strand the SQLite handle: on Windows an
    // open handle keeps the directory undeletable, so this removal is the
    // observable proof that `close()` ran. On POSIX the removal succeeds either
    // way, and the assertion is simply not the one doing the work.
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
  });
});
