/**
 * Unit tests for session usage aggregation.
 *
 * `active_seconds` is derived from the append-only event log rather than from a
 * counter column, so the interesting cases are the interval shapes: closed
 * turns, summed turns, an interrupted pair, and a turn still in flight when the
 * snapshot is taken.
 */

import { describe, expect, it } from 'vitest';
import { activeSecondsFromEvents, buildSessionUsageSnapshot } from '@/core/session/session-usage.js';
import type { SessionEvent } from '@/types/session.js';

function ev(type: SessionEvent['type'], at: string): SessionEvent {
  return {
    id: `sevt_${type}_${at}`,
    sessionId: 'sess_test',
    seq: 1,
    type,
    createdAt: new Date(at),
    processedAt: new Date(at),
  };
}

const T0 = '2026-09-15T00:00:00.000Z';

describe('activeSecondsFromEvents', () => {
  it('returns zero for an empty or non-executing log', () => {
    expect(activeSecondsFromEvents([], new Date(T0))).toBe(0);
    expect(activeSecondsFromEvents([ev('user.message', T0), ev('session.deleted', T0)], new Date(T0))).toBe(0);
  });

  it('measures one closed turn between running and idle', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:00.000Z'),
      ev('agent.message', '2026-09-15T00:00:04.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:10.000Z'),
    ];
    expect(activeSecondsFromEvents(events, new Date(T0))).toBe(10);
  });

  it('sums multiple turns and ignores the gaps between them', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:00.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:10.000Z'),
      // 20 s of waiting for the next user message must not count.
      ev('session.status_running', '2026-09-15T00:00:30.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:35.000Z'),
    ];
    expect(activeSecondsFromEvents(events, new Date(T0))).toBe(15);
  });

  it('counts a turn still in flight up to now', () => {
    // The snapshot is emitted just before the closing idle event is appended,
    // so the interval it describes is still open in the log.
    const events = [ev('session.status_running', '2026-09-15T00:00:00.000Z')];
    expect(activeSecondsFromEvents(events, new Date('2026-09-15T00:00:07.000Z'))).toBe(7);
  });

  it('closes the interval on termination as well as idle', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:00.000Z'),
      ev('session.status_terminated', '2026-09-15T00:00:04.000Z'),
      // A terminated session that somehow logs more activity must not keep
      // accruing against `now`.
      ev('session.error', '2026-09-15T00:00:09.000Z'),
    ];
    expect(activeSecondsFromEvents(events, new Date('2026-09-15T01:00:00.000Z'))).toBe(4);
  });

  it('does not double count when a closing event is missing', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:00.000Z'),
      ev('session.status_running', '2026-09-15T00:00:05.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:08.000Z'),
    ];
    expect(activeSecondsFromEvents(events, new Date('2026-09-15T00:00:08.000Z'))).toBe(8);
  });

  it('never returns a negative duration for out-of-order timestamps', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:10.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:05.000Z'),
    ];
    expect(activeSecondsFromEvents(events, new Date(T0))).toBe(0);
  });
});

describe('buildSessionUsageSnapshot', () => {
  it('pairs the token aggregate with the activity time', () => {
    const events = [
      ev('session.status_running', '2026-09-15T00:00:00.000Z'),
      ev('session.status_idle', '2026-09-15T00:00:03.000Z'),
    ];

    expect(buildSessionUsageSnapshot(events, { tokensIn: 5000, tokensOut: 3200 }, new Date(T0)))
      .toEqual({ input_tokens: 5000, output_tokens: 3200, active_seconds: 3 });
  });

  it('reports zero tokens for a session that has not called a model', () => {
    expect(buildSessionUsageSnapshot([], {}, new Date(T0)))
      .toEqual({ input_tokens: 0, output_tokens: 0, active_seconds: 0 });
  });
});
