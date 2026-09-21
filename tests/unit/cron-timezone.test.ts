/**
 * Cron evaluation in a schedule's own timezone.
 *
 * The properties worth pinning are the ones a UTC-only implementation gets
 * wrong: the same wall time is a different instant in a different zone, the
 * offset moves across a DST boundary, a spring-forward gap has no run at all,
 * and an unknown zone is refused rather than defaulted.
 */

import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  nextCronRun,
  parseCron,
  upcomingCronRuns,
  wallClockOf,
} from '@/core/operations/cron.js';

describe('cron field grammar', () => {
  it('accepts a bare value, a list, a range, and a step', () => {
    expect(parseCron('0 9 * * *')).not.toBeNull();
    expect(parseCron('0,30 9 * * *')?.minutes).toEqual(new Set([0, 30]));
    expect(parseCron('0-4 9 * * *')?.minutes).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(parseCron('*/15 9 * * *')?.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it('refuses a malformed or out-of-range field', () => {
    expect(parseCron('0 9 * *')).toBeNull();
    expect(parseCron('60 9 * * *')).toBeNull();
    expect(parseCron('0 24 * * *')).toBeNull();
    expect(parseCron('0 9 32 * *')).toBeNull();
    expect(parseCron('abc 9 * * *')).toBeNull();
  });
});

describe('timezone validation', () => {
  it('accepts an IANA name and refuses an unknown one', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('refuses an unknown zone instead of falling back to UTC', () => {
    const after = new Date('2026-07-01T00:00:00Z');
    expect(nextCronRun('0 9 * * *', after, 'Mars/Olympus')).toBeNull();
  });
});

describe('next run in a zone', () => {
  const after = new Date('2026-07-01T00:00:00Z');

  it('resolves the same wall time to different instants per zone', () => {
    const tokyo = nextCronRun('0 9 * * *', after, 'Asia/Tokyo');
    const utc = nextCronRun('0 9 * * *', after, 'UTC');

    expect(tokyo).not.toBeNull();
    expect(utc).not.toBeNull();
    expect(wallClockOf(tokyo!, 'Asia/Tokyo')).toMatchObject({ hour: 9, minute: 0 });
    expect(wallClockOf(utc!, 'UTC')).toMatchObject({ hour: 9, minute: 0 });
    // The reference instant is already 09:00 in Tokyo, so Tokyo's next 09:00 is
    // the following day while UTC's is the same day: 15 hours apart. The
    // assertion that matters is that both resolve to 09:00 in their own zone.
    expect(tokyo!.getTime()).not.toBe(utc!.getTime());
  });

  it('moves the absolute instant across a DST boundary', () => {
    const january = nextCronRun('0 9 * * *', new Date('2026-01-01T00:00:00Z'), 'America/New_York');
    const july = nextCronRun('0 9 * * *', new Date('2026-07-01T00:00:00Z'), 'America/New_York');

    expect(january).not.toBeNull();
    expect(july).not.toBeNull();
    expect(wallClockOf(january!, 'America/New_York')).toMatchObject({ hour: 9, minute: 0 });
    expect(wallClockOf(july!, 'America/New_York')).toMatchObject({ hour: 9, minute: 0 });
    // EST is UTC-5 and EDT is UTC-4, so 09:00 local is a different instant.
    expect(july!.getTime() - january!.getTime()).not.toBe(0);
    expect(wallClockOf(january!, 'UTC').hour).toBe(14);
    expect(wallClockOf(july!, 'UTC').hour).toBe(13);
  });

  it('reports no run for a wall time inside a spring-forward gap', () => {
    // America/New_York springs forward on 2026-03-08 at 02:00 local, so 02:30
    // does not exist that day.
    const after = new Date('2026-03-07T12:00:00Z');
    // 02:30 on 2026-03-08 does not exist, so the search skips that day and
    // lands on a year where the same wall time is real.
    const onTheDay = nextCronRun('30 2 8 3 *', after, 'America/New_York');
    expect(onTheDay).not.toBeNull();
    expect(wallClockOf(onTheDay!, 'America/New_York').year).not.toBe(2026);
    // The same wall time on a day that is not the transition resolves normally.
    const nextDay = nextCronRun('30 2 9 3 *', after, 'America/New_York');
    expect(nextDay).not.toBeNull();
    expect(wallClockOf(nextDay!, 'America/New_York')).toMatchObject({ hour: 2, minute: 30 });
  });

  it('returns successive occurrences without repeating one', () => {
    const runs = upcomingCronRuns('0 */6 * * *', after, 'UTC', 3);
    expect(runs).toHaveLength(3);
    expect(runs[1].getTime() - runs[0].getTime()).toBe(6 * 60 * 60 * 1000);
    expect(runs[2].getTime() - runs[1].getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it('never returns the minute the reference instant falls in', () => {
    const exactlyNine = new Date('2026-07-01T09:00:00Z');
    const next = nextCronRun('0 9 * * *', exactlyNine, 'UTC');
    expect(next!.getTime()).toBeGreaterThan(exactlyNine.getTime());
  });
});
