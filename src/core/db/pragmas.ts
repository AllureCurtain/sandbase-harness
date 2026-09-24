/**
 * SQLite connection hardening for the runtime state database.
 *
 * The runtime opens the same workspace database from more than one process:
 * `src/index.ts` opens it for the CLI, and `src/core/runtime/bootstrap.ts`
 * opens it for a server or an embedder. A deferred transaction reads without a
 * write lock and only takes one at its first write, so a second process can
 * commit in between and the first one then fails to promote its read snapshot —
 * immediately, because a connection that never asked for `busy_timeout` has no
 * wait to fall back on. The settings below are therefore part of the connection
 * contract rather than tuning: each one is read back after it is set, and a
 * connection whose settings did not take effect is refused instead of used.
 *
 * The recipe follows the state-database pragma set in Omnara's
 * `internal/machinedaemon/statedb/store.go`: `_txlock=immediate`,
 * `busy_timeout=5000`, `foreign_keys=ON`, `trusted_schema=OFF`,
 * `journal_mode=WAL`, `synchronous=FULL`. The `SetMaxOpenConns(1)` half of that
 * recipe is inherent here — `node:sqlite`'s `DatabaseSync` is one synchronous
 * connection with no pool — so it needs no code, and the two macOS-only
 * full-sync pragmas it also sets are left out for the reason
 * `connectionPragmaSpecs` records.
 *
 * `DatabaseSync` also takes a `timeout` option on newer Node releases, which
 * sets the same value as `busy_timeout`. The pragma is used instead so the
 * setting can be read back on the oldest supported Node (`engines: >=22`) and
 * so it is part of the same verified contract as everything else here.
 *
 * Only pragma names that come from this module's own spec are interpolated
 * into SQL; nothing callers supply reaches a `PRAGMA` statement.
 */

/** How long a writer waits for another process's write lock before failing. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * The journal mode SQLite reports for a database that only exists in memory.
 * Such a database has no WAL to enable, so `journal_mode` is the one
 * expectation that follows the database rather than the file.
 */
const IN_MEMORY_JOURNAL_MODE = 'memory';

/**
 * The connection surface the pragma contract needs. `DatabaseSync` and this
 * project's `Database` both satisfy it structurally, which keeps this module
 * free of the `createRequire` dance that `database.ts` needs for bundling.
 */
export type SqliteConnection = {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
};

/** One connection setting, how to install it, and what it must read back. */
export type SqlitePragmaSpec = {
  /** Pragma name, both in the installing statement and in the read-back. */
  name: string;
  /** Statement that installs the required value. */
  apply: string;
  /** Value the connection must report afterwards. */
  expected: string | number;
  /** Why this value, and what changing it would cost. */
  rationale: string;
};

/**
 * The pragmas every runtime connection must hold.
 *
 * Omnara's recipe also sets `fullfsync` and `checkpoint_fullfsync` on macOS, and
 * this runtime deliberately does not. `node:sqlite` is Node's own SQLite build,
 * and `deps/sqlite/sqlite.gyp` at v24.9.0 defines no
 * `SQLITE_ENABLE_FULLFSYNC`, so nothing shows that this build's macOS full-sync
 * path exists; the pragma itself is only a settable flag that reads back as 1
 * even on Windows, where F_FULLFSYNC does not exist, so a successful read-back
 * would not prove the guarantee. Putting it in the connection contract would
 * claim durability this build cannot demonstrate, which is worse than not
 * claiming it: `PRAGMA synchronous = FULL` is the guarantee that does apply
 * here. The macOS branch needs a host to verify on, so if a Node release turns
 * out to enable that compile-time option, add the two pragmas to this spec and
 * to the verification together — with that check recorded.
 */
export function connectionPragmaSpecs(): SqlitePragmaSpec[] {
  return [
    {
      name: 'journal_mode',
      apply: 'PRAGMA journal_mode = WAL',
      expected: 'wal',
      rationale:
        'WAL keeps a reader from blocking the writer and lets a crashed process recover from the log, and the runtime already assumed it. It is read back because the statement alone does not prove the file took the mode.',
    },
    {
      name: 'foreign_keys',
      apply: 'PRAGMA foreign_keys = ON',
      expected: 1,
      rationale:
        'Session, memory and credential writes rely on the declared references. SQLite parses them either way, so a connection with enforcement off silently stores orphans instead of failing.',
    },
    {
      name: 'busy_timeout',
      apply: `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`,
      expected: SQLITE_BUSY_TIMEOUT_MS,
      rationale:
        'A second process writing the same file waits for the lock instead of failing on the spot. Without the wait, a conflict that lasts milliseconds reaches the caller as an unreproducible failure.',
    },
    {
      name: 'synchronous',
      apply: 'PRAGMA synchronous = FULL',
      // 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA.
      expected: 2,
      rationale:
        'Local write volume is low and writes are serialized by an immediate transaction, so one fsync per commit is affordable and buys the guarantee the recovery contract states. NORMAL would already survive a process crash but not a host crash; changing this value means changing this rationale and the recovery contract together.',
    },
    {
      name: 'trusted_schema',
      apply: 'PRAGMA trusted_schema = OFF',
      expected: 0,
      rationale:
        'Tool and MCP input reaches SQL here, and a trusted schema lets schema elements run functions while a statement is parsed. OFF makes the parser refuse that instead of treating the schema as code.',
    },
  ];
}

/**
 * Install every pragma in the spec.
 *
 * `PRAGMA` statements that return a row are fine here because the read-back is
 * what decides whether the setting took effect.
 */
export function applyConnectionPragmas(
  db: SqliteConnection,
  specs: readonly SqlitePragmaSpec[] = connectionPragmaSpecs(),
): void {
  for (const spec of specs) {
    db.exec(spec.apply);
  }
}

/**
 * Read every pragma back and refuse the connection when one does not match.
 *
 * This is the fail-closed half: a database whose durability, locking or
 * constraint settings could not be confirmed is not handed to callers at all,
 * because otherwise the guarantee fails silently and only shows up as data
 * loss or an intermittent write error much later.
 */
export function verifyConnectionPragmas(
  db: SqliteConnection,
  specs: readonly SqlitePragmaSpec[] = connectionPragmaSpecs(),
): void {
  const inMemory = isInMemoryDatabase(db);
  for (const spec of specs) {
    // An in-memory database cannot be in WAL mode: SQLite answers `memory` for
    // the only journal it has. That one expectation follows the database, and
    // it is still compared rather than skipped. The runtime's state database is
    // a file; `:memory:` is what a unit test or a throwaway tool opens.
    const expected = inMemory && spec.name === 'journal_mode' ? IN_MEMORY_JOURNAL_MODE : spec.expected;
    const actual = readPragma(db, spec.name);
    if (!pragmaSatisfied(actual, expected)) {
      throw new SqlitePragmaError(spec.name, actual, expected);
    }
  }
}

/**
 * Read one pragma's current value.
 *
 * The column name is not the pragma name for every pragma — `PRAGMA
 * busy_timeout` answers with a `timeout` column — so the single value of the
 * single row is what this returns. An unreadable or unknown pragma yields
 * `undefined`, which never satisfies an expectation.
 */
export function readPragma(db: SqliteConnection, name: string): string | number | undefined {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const [value] = Object.values(row);
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Whether the connection's `main` schema lives only in memory. Such a database
 * has no file to put in WAL mode and no durability to promise.
 */
export function isInMemoryDatabase(db: SqliteConnection): boolean {
  const row = db.prepare('PRAGMA database_list').get() as { file?: unknown } | undefined;
  return typeof row?.file === 'string' && row.file.length === 0;
}

/** Raised when a connection cannot show a required pragma value. */
export class SqlitePragmaError extends Error {
  /** Pragma that failed verification. */
  readonly pragma: string;
  /** What the connection reported, or `undefined` when it reported nothing. */
  readonly actual: string | number | undefined;
  /** What the connection was required to report. */
  readonly expected: string | number;

  constructor(pragma: string, actual: string | number | undefined, expected: string | number) {
    super(
      `sqlite pragma ${pragma} reads back ${describePragmaValue(actual)}, expected ${describePragmaValue(expected)}`,
    );
    this.name = 'SqlitePragmaError';
    this.pragma = pragma;
    this.actual = actual;
    this.expected = expected;
  }
}

function pragmaSatisfied(actual: unknown, expected: string | number): boolean {
  if (typeof expected === 'number') return actual === expected;
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}

function describePragmaValue(value: string | number | undefined): string {
  if (value === undefined) return 'nothing (the pragma is not readable on this build)';
  return typeof value === 'number' ? String(value) : `'${value}'`;
}
