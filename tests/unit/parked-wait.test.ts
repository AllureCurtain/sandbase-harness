/**
 * Unit test: the rule that decides a parked wait has expired.
 *
 * `src/core/session/parked-wait.ts` is the only place that answers "should this
 * session stop waiting", and it is deliberately pure so that answer can be read
 * in one place instead of being spread across a timer callback. Three of its
 * rules are ways the feature could be actively harmful rather than merely wrong,
 * and each has a case here:
 *
 * - **no bound configured** must mean the published indefinite wait
 *   (`权限策略.md:668`), so the default deployment is unchanged and conformant;
 * - **a session at its spending ceiling** must never be ended (frozen decision
 *   D23). A ceiling here does not change status, so such a session is still
 *   `requires_action` and looks abandoned to a rule that only reads status — and
 *   its next event is a settlement event the budget deliberately still accepts;
 * - **the bound is measured from when the session parked**, not from when a pass
 *   noticed, or the longest waits would be the ones that never expired.
 */

import { describe, it, expect } from 'vitest';
import { expiredParkedWait, PARKED_WAIT_TIMEOUT_CODE } from '@/core/session/parked-wait.js';
import type { SessionEvent, SessionStatus } from '@/types/session.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');

function at(secondsAgo: number): Date {
  return new Date(NOW.getTime() - secondsAgo * 1000);
}

let seq = 0;

function event(
  id: string,
  type: SessionEvent['type'],
  createdAt: Date,
  extra: Partial<SessionEvent> = {},
): SessionEvent {
  seq += 1;
  return { id, sessionId: 'sess_1', seq, type, createdAt, ...extra } as SessionEvent;
}

function parkedCustom(id: string, blockId: string, createdAt: Date): SessionEvent {
  return event(id, 'agent.custom_tool_use', createdAt, {
    content: [{ type: 'tool_use', id: blockId, name: 'lookup_customer', input: {} }] as any,
  });
}

function parkedGated(id: string, blockId: string, createdAt: Date): SessionEvent {
  return event(id, 'agent.tool_use', createdAt, {
    content: [{
      type: 'tool_use', id: blockId, name: 'bash', input: {}, requires_confirmation: true,
    }] as any,
  });
}

function customResult(id: string, blockId: string, createdAt: Date): SessionEvent {
  return event(id, 'user.custom_tool_result', createdAt, {
    content: [{ type: 'text', text: 'x' }] as any,
    metadata: { custom_tool_use_id: blockId },
  });
}

function facts(overrides: {
  status?: SessionStatus;
  budgetExhausted?: boolean;
  events?: SessionEvent[];
  timeoutSeconds?: number | undefined;
  now?: Date;
} = {}) {
  return {
    status: (overrides.status ?? 'requires_action') as SessionStatus,
    budgetExhausted: overrides.budgetExhausted ?? false,
    events: overrides.events ?? [parkedCustom('sevt_c', 'custom_1', at(600))],
    timeoutSeconds: 'timeoutSeconds' in overrides ? overrides.timeoutSeconds : 300,
    now: overrides.now ?? NOW,
  };
}

describe('expiredParkedWait', () => {
  it('exposes a stable code for the ending event', () => {
    expect(PARKED_WAIT_TIMEOUT_CODE).toBe('requires_action_timeout');
  });

  it('does not expire a wait when no bound is configured', () => {
    // The published behaviour, and the default: the session waits indefinitely.
    expect(expiredParkedWait(facts({ timeoutSeconds: undefined }))).toBeUndefined();
  });

  it('treats a zero or negative bound as no bound rather than as "expire now"', () => {
    // A malformed row must not turn into a bound of zero, which would end every
    // parked session the instant it parked.
    expect(expiredParkedWait(facts({ timeoutSeconds: 0 }))).toBeUndefined();
    expect(expiredParkedWait(facts({ timeoutSeconds: -1 }))).toBeUndefined();
  });

  it('does not expire a wait before the bound has passed', () => {
    expect(expiredParkedWait(facts({
      events: [parkedCustom('sevt_c', 'custom_1', at(299))],
      timeoutSeconds: 300,
    }))).toBeUndefined();
  });

  it('expires a wait once exactly the bound has passed', () => {
    const expired = expiredParkedWait(facts({
      events: [parkedCustom('sevt_c', 'custom_1', at(300))],
      timeoutSeconds: 300,
    }));
    expect(expired).toBeDefined();
    expect(expired!.parkedForMs).toBe(300_000);
  });

  it('reports the calls that were still unanswered, by event and block id', () => {
    const expired = expiredParkedWait(facts({
      events: [
        parkedGated('sevt_g', 'call_1', at(900)),
        parkedCustom('sevt_c', 'custom_1', at(600)),
      ],
    }));
    expect(expired!.calls.map((call) => call.eventId)).toEqual(['sevt_g', 'sevt_c']);
    expect(expired!.calls.map((call) => call.blockId)).toEqual(['call_1', 'custom_1']);
  });

  it('measures the bound from the oldest parked call', () => {
    // The session has been parked as long as its longest-waiting call, not as
    // long as its most recent one: the second call arriving must not refresh the
    // clock and let an abandoned session sit past its bound indefinitely.
    const expired = expiredParkedWait(facts({
      events: [
        parkedGated('sevt_g', 'call_1', at(900)),
        parkedCustom('sevt_c', 'custom_1', at(10)),
      ],
    }));
    expect(expired!.parkedForMs).toBe(900_000);
    expect(expired!.parkedAt).toEqual(at(900));
  });

  it('keeps a session that is parked but not the parked status', () => {
    for (const status of ['running', 'paused', 'queued', 'failed', 'completed'] as SessionStatus[]) {
      expect(expiredParkedWait(facts({ status }))).toBeUndefined();
    }
  });

  it('keeps a session that is in requires_action with nothing parked', () => {
    // `requires_action` with every call answered is a session about to resume,
    // not an abandoned one.
    expect(expiredParkedWait(facts({
      events: [parkedCustom('sevt_c', 'custom_1', at(600)), customResult('sevt_r', 'custom_1', at(500))],
    }))).toBeUndefined();
  });

  it('never expires a wait on a session at its spending ceiling (D23)', () => {
    // The carve-out that matters: a ceiling here does not change status, so this
    // session is still `requires_action` and still parked, and its answer is a
    // settlement event the budget still accepts.
    expect(expiredParkedWait(facts({ budgetExhausted: true }))).toBeUndefined();
  });

  it('checks the ceiling before the bound, so an exhausted session is kept even when long expired', () => {
    const expired = expiredParkedWait(facts({
      budgetExhausted: true,
      events: [parkedCustom('sevt_c', 'custom_1', at(86_400))],
      timeoutSeconds: 1,
    }));
    expect(expired).toBeUndefined();
    expect(expiredParkedWait(facts({
      budgetExhausted: false,
      events: [parkedCustom('sevt_c', 'custom_1', at(86_400))],
      timeoutSeconds: 1,
    }))).toBeDefined();
  });

  it('expires a session that has been parked far longer than the bound', () => {
    // Including the case that matters after a restart: a session parked before
    // the runtime started is already past its bound on the first pass.
    const expired = expiredParkedWait(facts({
      events: [parkedCustom('sevt_c', 'custom_1', at(604_800))],
      timeoutSeconds: 300,
    }));
    expect(expired!.parkedForMs).toBe(604_800_000);
  });
});
