/**
 * Database Layer
 *
 * Uses Node.js built-in node:sqlite (experimental in Node 22+, stable in Node 25+).
 * Provides a synchronous SQLite interface with auto-migration support.
 */

import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, type Migration } from './migrations.js';
import { applyConnectionPragmas, verifyConnectionPragmas } from './pragmas.js';

// Load node:sqlite via createRequire so bundlers (esbuild/tsup) don't rewrite
// the specifier. A static `import ... from 'node:sqlite'` gets its node:
// prefix stripped during bundling, producing an unresolvable bare 'sqlite'.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export class Database {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);

    // Connection hardening, then a read-back of every value. A connection whose
    // pragmas did not take effect is closed and refused rather than handed out:
    // the runtime relies on WAL, on enforced foreign keys, on a bounded wait for
    // another process's write lock, and on a commit that survives a crash, and a
    // missing pragma would turn each of those into a silent difference. See
    // ./pragmas.js for the required values and why each one is what it is.
    try {
      applyConnectionPragmas(this.db);
      verifyConnectionPragmas(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Execute raw SQL (no return value).
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Prepare a statement for parameterized queries.
   */
  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  /**
   * Run a function inside an immediate (write-locking) transaction.
   * Auto-rollback on error.
   *
   * `BEGIN IMMEDIATE` takes the write lock when the transaction starts instead
   * of at its first write. A deferred transaction reads from a snapshot and can
   * only be promoted to a writer while no other connection has committed since;
   * with the CLI and a server pointed at the same file, that promotion is where
   * an unrelated write turns into SQLITE_BUSY_SNAPSHOT after the transaction
   * body has already done its work. Taking the lock up front makes the same
   * conflict a bounded wait (`busy_timeout`) at a point the caller can retry.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Run all pending migrations. Defaults to the embedded MIGRATIONS array
   * (bundle-safe). Each migration runs exactly once, tracked in _migrations.
   * Idempotent — running repeatedly is a no-op once applied.
   */
  runMigrations(migrations: Migration[] = MIGRATIONS): void {
    // Create migrations tracking table
    this.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Get applied versions
    const applied = new Set<number>();
    const rows = this.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>;
    for (const row of rows) {
      applied.add(row.version);
    }

    // Run pending migrations in ascending version order
    const pending = [...migrations].sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      if (applied.has(migration.version)) continue;
      this.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          this.exec(migration.sql);
          this.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
            migration.version,
            migration.name,
          );
        });
      } finally {
        this.exec('PRAGMA foreign_keys = ON');
      }
      const violations = this.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`Migration ${migration.version} left foreign key violations`);
      }
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
