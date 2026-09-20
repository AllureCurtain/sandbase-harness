import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const DEFAULT_STALE_AFTER_MS = 30_000;

export class PiSessionBusyError extends Error {
  readonly code = 'pi_session_busy';
  readonly retryable = true;

  constructor(readonly sessionFile: string, readonly owner?: PiLeaseRecord) {
    super(`Pi session file is busy: ${sessionFile}`);
    this.name = 'PiSessionBusyError';
  }
}

export interface PiLeaseRecord {
  version: 1;
  ownerId: string;
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface PiSessionFileLease {
  readonly leasePath: string;
  readonly ownerId: string;
  readonly recoveredStale: boolean;
  renew(): Promise<void>;
  /** Stop heartbeats without deleting the lease when cleanup ownership is unknown. */
  suspendHeartbeat(): void;
  release(): Promise<void>;
}

export interface PiSessionLeaseOptions {
  staleAfterMs?: number;
  now?: () => number;
  ownerId?: string;
  pid?: number;
  host?: string;
}

/**
 * Acquire a cross-runtime lease by exclusive creation and expiry heartbeat.
 * A stale owner is recovered by an atomic rename before the next attempt.
 */
export async function acquirePiSessionFileLease(
  sessionFile: string,
  options: PiSessionLeaseOptions = {},
): Promise<PiSessionFileLease> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError('Pi session lease expiry must be a positive safe integer');
  }
  const now = options.now ?? Date.now;
  const ownerId = options.ownerId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const leasePath = `${sessionFile}.lease`;
  let recoveredStale = false;

  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(leasePath), { recursive: true }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const acquiredAt = now();
    const record = makeRecord(ownerId, pid, host, acquiredAt, staleAfterMs);
    try {
      const handle = await open(leasePath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
      } finally {
        await handle.close();
      }

      let released = false;
      let renewal: Promise<void> = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewal = renewal.then(async () => {
          if (released) return;
          const next = makeRecord(ownerId, pid, host, now(), staleAfterMs);
          await writeFile(leasePath, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        }).catch(() => {
          // The owner remains conservative: a failed heartbeat makes the lease
          // appear stale only after the expiry window, never immediately safe.
        });
      }, Math.max(1_000, Math.floor(staleAfterMs / 3)));

      return {
        leasePath,
        ownerId,
        recoveredStale,
        renew: async () => {
          await renewal;
          if (released) return;
          const next = makeRecord(ownerId, pid, host, now(), staleAfterMs);
          await writeFile(leasePath, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        },
        suspendHeartbeat: () => {
          clearInterval(heartbeat);
        },
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await renewal;
          try {
            const current = JSON.parse(await readFile(leasePath, 'utf8')) as Partial<PiLeaseRecord>;
            if (current.ownerId === ownerId) await rm(leasePath, { force: true });
          } catch {
            // Never remove an unreadable lease: ownership cannot be proven.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readExistingLease(leasePath);
      if (!isStale(existing, now(), staleAfterMs)) {
        throw new PiSessionBusyError(sessionFile, existing?.record);
      }
      const recoveryPath = join(dirname(leasePath), `.${ownerId}.stale`);
      try {
        await rename(leasePath, recoveryPath);
        await rm(recoveryPath, { force: true });
        recoveredStale = true;
      } catch {
        // A concurrent owner won the race. Re-check on the next attempt.
      }
    }
  }

  throw new PiSessionBusyError(sessionFile);
}

function makeRecord(ownerId: string, pid: number, host: string, now: number, staleAfterMs: number): PiLeaseRecord {
  const timestamp = new Date(now).toISOString();
  return {
    version: 1,
    ownerId,
    pid,
    host,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: new Date(now + staleAfterMs).toISOString(),
  };
}

async function readExistingLease(path: string): Promise<{ record?: PiLeaseRecord; mtimeMs?: number } | undefined> {
  try {
    const [contents, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    try {
      const record = JSON.parse(contents) as PiLeaseRecord;
      if (record && record.version === 1 && typeof record.expiresAt === 'string') return { record, mtimeMs: metadata.mtimeMs };
    } catch {
      // Treat a partially written/crashed lease as stale only by mtime.
    }
    return { mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

function isStale(value: { record?: PiLeaseRecord; mtimeMs?: number } | undefined, now: number, staleAfterMs: number): boolean {
  if (!value) return true;
  if (value.record) return Date.parse(value.record.expiresAt) <= now;
  return (value.mtimeMs ?? now) + staleAfterMs <= now;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}
