/**
 * Unit tests for the SQLite connection contract in `src/core/db/pragmas.ts` and
 * for the transaction behaviour of `Database`.
 *
 * Covers: the hardened pragma set on a fresh, an existing, and an in-memory
 * database; the read-back that refuses a connection whose settings did not take
 * effect; the write lock an immediate transaction takes; and a writer that
 * queues behind another process instead of failing with SQLITE_BUSY.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Database } from '@/core/db/database.js';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SqlitePragmaError,
  connectionPragmaSpecs,
  isInMemoryDatabase,
  readPragma,
  verifyConnectionPragmas,
} from '@/core/db/pragmas.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ma-sqlite-pragmas-'));
  tempDirs.push(dir);
  return dir;
}

/** Poll for a condition instead of sleeping a fixed amount. */
async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A connection holding exactly the values the runtime requires. */
function openConformingConnection(dbPath: string): InstanceType<typeof DatabaseSync> {
  const connection = new DatabaseSync(dbPath);
  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  connection.exec('PRAGMA synchronous = FULL');
  connection.exec('PRAGMA trusted_schema = OFF');
  return connection;
}

/**
 * A second process for the queueing test: it takes the write lock, says so
 * through a marker file, holds the lock for a while, and commits. Plain
 * `node:sqlite` is enough — what is under test is the runtime's own connection
 * waiting for it.
 */
const HOLD_WRITE_LOCK_WORKER = `
const { DatabaseSync } = require('node:sqlite');
const { writeFileSync } = require('node:fs');
const { workerData } = require('node:worker_threads');

const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = ' + workerData.busyTimeoutMs);
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO probe (id) VALUES ('external')");
writeFileSync(workerData.readyFile, 'ready');
const deadline = Date.now() + workerData.holdMs;
while (Date.now() < deadline) {
  // Hold the write lock across the runtime's attempt to begin its own.
}
db.exec('COMMIT');
db.close();
`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Database pragma contract', () => {
  it('applies and verifies the hardened pragma set on a new database', () => {
    const db = new Database(join(makeTempDir(), 'fresh.db'));
    try {
      expect(readPragma(db, 'journal_mode')).toBe('wal');
      expect(readPragma(db, 'foreign_keys')).toBe(1);
      expect(readPragma(db, 'busy_timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);
      // 2 is FULL: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA.
      expect(readPragma(db, 'synchronous')).toBe(2);
      expect(readPragma(db, 'trusted_schema')).toBe(0);
      expect(isInMemoryDatabase(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('hardens an existing database written before the pragma set existed, and keeps its rows', () => {
    const dbPath = join(makeTempDir(), 'existing.db');

    // What the runtime wrote before this change: no busy_timeout, no
    // synchronous, no trusted_schema, and the default rollback journal.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('CREATE TABLE legacy_rows (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacy.exec("INSERT INTO legacy_rows (id, value) VALUES ('row_1', 'kept')");
    expect(readPragma(legacy, 'journal_mode')).toBe('delete');
    legacy.close();

    const db = new Database(dbPath);
    try {
      expect(readPragma(db, 'journal_mode')).toBe('wal');
      expect(readPragma(db, 'foreign_keys')).toBe(1);
      expect(readPragma(db, 'busy_timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);
      expect(readPragma(db, 'synchronous')).toBe(2);
      expect(readPragma(db, 'trusted_schema')).toBe(0);
      expect(db.prepare('SELECT value FROM legacy_rows WHERE id = ?').get('row_1')).toEqual({ value: 'kept' });
    } finally {
      db.close();
    }
  });

  it('keeps foreign keys enforced after migrations switch them off and on again', () => {
    const db = new Database(join(makeTempDir(), 'migrated.db'));
    try {
      db.runMigrations();
      expect(readPragma(db, 'foreign_keys')).toBe(1);

      // The setting is proved by enforcement, not only by the read-back.
      db.exec('CREATE TABLE parent_row (id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE child_row (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent_row(id))');
      expect(() => db.exec("INSERT INTO child_row (id, parent_id) VALUES ('child_1', 'missing')")).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('accepts an in-memory database, whose only journal is memory', () => {
    // SQLite has no WAL for a database that never reaches a file, so the
    // journal expectation follows the database. Every other pragma is applied
    // and verified exactly as it is for the on-disk state database.
    const db = new Database(':memory:');
    try {
      expect(isInMemoryDatabase(db)).toBe(true);
      expect(readPragma(db, 'journal_mode')).toBe('memory');
      expect(readPragma(db, 'foreign_keys')).toBe(1);
      expect(readPragma(db, 'busy_timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);
      expect(readPragma(db, 'synchronous')).toBe(2);
      expect(readPragma(db, 'trusted_schema')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('verifies exactly the pragmas it can hold this build to', () => {
    // No platform branch: the verified set is the same everywhere. The
    // macOS-only `fullfsync` and `checkpoint_fullfsync` from Omnara's recipe
    // are deliberately absent, because Node's bundled SQLite defines no
    // SQLITE_ENABLE_FULLFSYNC and the pragma is a flag that reads back as set on
    // any platform, so it could not prove the guarantee it would be claimed for.
    expect(connectionPragmaSpecs().map((spec) => spec.name)).toEqual([
      'journal_mode',
      'foreign_keys',
      'busy_timeout',
      'synchronous',
      'trusted_schema',
    ]);
  });

  it('refuses a connection whose pragma did not take effect', () => {
    const dir = makeTempDir();

    const conforming = openConformingConnection(join(dir, 'conforming.db'));
    try {
      expect(() => verifyConnectionPragmas(conforming)).not.toThrow();
    } finally {
      conforming.close();
    }

    // Each case gets its own file: a broken `journal_mode` is written into the
    // file rather than held by the connection, so sharing one path would let
    // one case decide the next one's result.
    const broken = [
      ['PRAGMA busy_timeout = 0', 'busy_timeout', SQLITE_BUSY_TIMEOUT_MS],
      ['PRAGMA foreign_keys = OFF', 'foreign_keys', 1],
      ['PRAGMA synchronous = NORMAL', 'synchronous', 2],
      ['PRAGMA trusted_schema = ON', 'trusted_schema', 0],
      ['PRAGMA journal_mode = DELETE', 'journal_mode', 'wal'],
    ] as const;

    for (const [index, [statement, pragma, expected]] of broken.entries()) {
      const connection = openConformingConnection(join(dir, `broken-${index}.db`));
      try {
        connection.exec(statement);
        expect(() => verifyConnectionPragmas(connection)).toThrowError(SqlitePragmaError);

        let caught: unknown;
        try {
          verifyConnectionPragmas(connection);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqlitePragmaError);
        expect((caught as SqlitePragmaError).pragma).toBe(pragma);
        expect((caught as SqlitePragmaError).expected).toBe(expected);
        expect((caught as SqlitePragmaError).message).toContain(`sqlite pragma ${pragma} reads back`);
      } finally {
        connection.close();
      }
    }
  });

  it('refuses a connection whose pragma cannot be read at all', () => {
    const connection = new DatabaseSync(join(makeTempDir(), 'unreadable.db'));
    try {
      // An unknown pragma answers with no row. That is "not confirmed", which
      // is a refusal rather than a pass.
      expect(readPragma(connection, 'definitely_not_a_pragma')).toBeUndefined();
      expect(() =>
        verifyConnectionPragmas(connection, [
          {
            name: 'definitely_not_a_pragma',
            apply: 'PRAGMA definitely_not_a_pragma = 1',
            expected: 1,
            rationale: 'test fixture',
          },
        ]),
      ).toThrowError(/reads back nothing/);
    } finally {
      connection.close();
    }
  });
});

describe('Database transactions', () => {
  it('takes the write lock when the transaction begins, not at its first write', () => {
    const dbPath = join(makeTempDir(), 'lock.db');
    const db = new Database(dbPath);
    const probe = new DatabaseSync(dbPath);
    probe.exec('PRAGMA busy_timeout = 0');
    try {
      db.transaction(() => {
        // Nothing has been written inside the transaction yet. With a deferred
        // BEGIN this second connection would take the write lock here and the
        // failure would land on the runtime transaction's first write instead.
        expect(() => probe.exec('BEGIN IMMEDIATE')).toThrowError(/locked/i);
      });

      // The refusal above released nothing, and the runtime transaction
      // committed: the lock is free again.
      probe.exec('BEGIN IMMEDIATE');
      probe.exec('ROLLBACK');
    } finally {
      probe.close();
      db.close();
    }
  });

  it('documents the deferred hazard an immediate transaction avoids', () => {
    const dbPath = join(makeTempDir(), 'snapshot.db');
    const writer = new Database(dbPath);
    const deferred = new DatabaseSync(dbPath);
    deferred.exec('PRAGMA busy_timeout = 0');
    try {
      writer.exec('CREATE TABLE snapshot_probe (id TEXT PRIMARY KEY)');

      deferred.exec('BEGIN');
      deferred.prepare('SELECT COUNT(*) AS c FROM snapshot_probe').get();
      // Another process commits while the deferred transaction holds its read
      // snapshot; promoting that snapshot to a writer can no longer succeed,
      // and no busy_timeout can wait it out.
      writer.transaction(() => {
        writer.exec("INSERT INTO snapshot_probe (id) VALUES ('writer')");
      });
      expect(() => deferred.exec("INSERT INTO snapshot_probe (id) VALUES ('deferred')")).toThrowError(/locked/i);
      deferred.exec('ROLLBACK');
    } finally {
      deferred.close();
      writer.close();
    }
  });

  it('lets the CLI and the server open one database and both write', () => {
    const dbPath = join(makeTempDir(), 'shared.db');
    // src/index.ts and src/core/runtime/bootstrap.ts both open this file.
    const cli = new Database(dbPath);
    const server = new Database(dbPath);
    try {
      cli.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
      cli.transaction(() => {
        cli.exec("INSERT INTO probe (id) VALUES ('cli')");
      });
      server.transaction(() => {
        server.exec("INSERT INTO probe (id) VALUES ('server')");
      });
      expect(server.prepare('SELECT COUNT(*) AS c FROM probe').get()).toEqual({ c: 2 });
    } finally {
      cli.close();
      server.close();
    }
  });

  it('waits for another process holding the write lock instead of failing with SQLITE_BUSY', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'queued.db');
    const readyFile = join(dir, 'writer-ready');
    const holdMs = 500;

    const db = new Database(dbPath);
    db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');

    const worker = new Worker(HOLD_WRITE_LOCK_WORKER, {
      eval: true,
      workerData: { dbPath, readyFile, holdMs, busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS },
    });
    const workerFailures: Error[] = [];
    worker.on('error', (error: Error) => workerFailures.push(error));

    try {
      await waitForFile(readyFile, 20_000);

      const started = Date.now();
      db.transaction(() => {
        db.exec("INSERT INTO probe (id) VALUES ('runtime')");
      });
      const waitedMs = Date.now() - started;

      const exitCode = await new Promise<number>((resolve) => {
        worker.once('exit', (code) => resolve(code ?? -1));
      });

      expect(workerFailures).toEqual([]);
      expect(exitCode).toBe(0);
      // The runtime waited for the other writer rather than failing at once;
      // the same insert on a connection without busy_timeout is refused.
      expect(waitedMs).toBeGreaterThanOrEqual(200);
      expect(
        (db.prepare('SELECT id FROM probe ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id),
      ).toEqual(['external', 'runtime']);
    } finally {
      db.close();
      await worker.terminate();
    }
  });
});
