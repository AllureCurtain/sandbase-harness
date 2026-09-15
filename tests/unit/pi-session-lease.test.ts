import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePiSessionFileLease, PiSessionBusyError } from '@/strategy/pi/session-lease.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Pi session-file lease', () => {
  it('rejects a live concurrent owner and removes its lease on release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 10_000 });

    await expect(acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 2_000, staleAfterMs: 10_000 }))
      .rejects.toMatchObject({ code: 'pi_session_busy' } satisfies Partial<PiSessionBusyError>);
    expect(existsSync(`${sessionFile}.lease`)).toBe(true);
    await first.release();
    expect(existsSync(`${sessionFile}.lease`)).toBe(false);
  });

  it('recovers an expired owner through an atomic stale rename', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-lease-stale-'));
    directories.push(directory);
    const sessionFile = join(directory, 'session.jsonl');
    const first = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-a', now: () => 1_000, staleAfterMs: 10 });
    const recovered = await acquirePiSessionFileLease(sessionFile, { ownerId: 'owner-b', now: () => 2_000, staleAfterMs: 10 });

    expect(recovered.recoveredStale).toBe(true);
    await first.release();
    await recovered.release();
    expect(existsSync(`${sessionFile}.lease`)).toBe(false);
  });
});
