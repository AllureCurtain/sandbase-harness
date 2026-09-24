/**
 * Bounded waits.
 *
 * The published contract has a session wait for a caller's answer without any
 * limit: `权限策略.md:668` says the session pauses with `requires_action` and
 * "会话会无限期等待响应" — it waits indefinitely. That is the behaviour this
 * runtime has by default, and this module changes nothing about it.
 *
 * What it adds is the operator's option to bound that wait. An unattended
 * deployment can then end a session nobody is coming back to answer instead of
 * retaining its workspace forever, and it learns why from a machine-readable
 * code rather than from prose. Because the published behaviour is an indefinite
 * wait, the bound is a **local extension**, it is off unless configured, and it
 * is recorded as a difference rather than presented as published.
 *
 * Three rules carry the weight, and each is a way this could be wrong rather
 * than a detail:
 *
 * 1. **A session at its spending ceiling is never timed out** (frozen decision
 *    D23). A ceiling in this runtime refuses the next work-starting event
 *    *without changing the session's status* — `capabilities/matrix.ts` records
 *    that as deliberate — so a budget-blocked session is still
 *    `requires_action` and looks exactly like an abandoned one to a rule that
 *    only reads status. It is not abandoned: `user.custom_tool_result` is a
 *    settlement event (`session-budget.ts`), so the answer such a session waits
 *    for is the very event that settles the spend. Ending it would destroy work
 *    the runtime had explicitly promised to keep accepting.
 *
 * 2. **The bound is measured from when the session parked**, not from when a
 *    pass noticed. A bound derived from the observer's clock would restart on
 *    every tick and would reset across a restart, so a session parked for a week
 *    would look freshly parked to a runtime that had just booted — the longest
 *    waits, which are the ones an operator most wants bounded, would be the ones
 *    that never expired.
 *
 * 3. **The parked set comes from `parkedCalls`**, the same definition
 *    `stop_reason.event_ids` publishes. A second derivation would let the
 *    timeout and the published array disagree about what the session was waiting
 *    for, which is the class of defect the resume gate exists to prevent.
 *
 * The ceiling is an input rather than computed here, and deliberately so: the
 * caller passes `SessionManager.isBudgetExhausted`, the same predicate that
 * refuses a work-starting event at the ceiling. Pricing needs a database and a
 * cost profile, and recomputing the verdict here would create a second opinion
 * about whether a session is out of budget.
 */

import { parkedCalls, type ParkedCall } from './parked-calls.js';
import type { SessionEvent, SessionStatus } from '@/types/session.js';

/**
 * Code carried by the `session.error` that ends an expired parked wait.
 *
 * The reason has to be machine-readable, and this is the carrier every other
 * coded failure already uses, so a client that classifies runtime failures does
 * not need a second code path for this one.
 */
export const PARKED_WAIT_TIMEOUT_CODE = 'requires_action_timeout';

/** What the caller knows about the session, so the decision stays pure. */
export interface ParkedWaitFacts {
  status: SessionStatus;
  /** `SessionManager.isBudgetExhausted` for this session. */
  budgetExhausted: boolean;
  events: SessionEvent[];
  /** `undefined` when no bound is configured — the published indefinite wait. */
  timeoutSeconds: number | undefined;
  now: Date;
}

/** An expired parked wait, and the calls that were still unanswered. */
export interface ExpiredParkedWait {
  /** The calls the session was waiting on when the bound passed. */
  calls: ParkedCall[];
  /** When the session parked: its oldest parked call. */
  parkedAt: Date;
  /** How long it had been parked when the bound was applied. */
  parkedForMs: number;
}

/**
 * Decide whether a parked session's wait has expired.
 *
 * Returns `undefined` whenever the session must keep waiting, which is every
 * case except a genuinely expired bound on a genuinely parked session that is
 * not out of budget: no bound configured, not parked, not the parked status, or
 * at the ceiling.
 */
export function expiredParkedWait(facts: ParkedWaitFacts): ExpiredParkedWait | undefined {
  const { status, budgetExhausted, events, timeoutSeconds, now } = facts;

  // No bound is the published behaviour, and a nonsensical bound is treated the
  // same way: a zero or negative value must not terminate every parked session
  // the instant it parks.
  if (!timeoutSeconds || timeoutSeconds <= 0) return undefined;
  if (status !== 'requires_action') return undefined;
  if (budgetExhausted) return undefined;

  const calls = parkedCalls(events);
  if (calls.length === 0) return undefined;

  const parkedAt = calls.reduce(
    (oldest, call) => (call.parkedAt < oldest ? call.parkedAt : oldest),
    calls[0].parkedAt,
  );
  const parkedForMs = now.getTime() - parkedAt.getTime();
  if (parkedForMs < timeoutSeconds * 1000) return undefined;

  return { calls, parkedAt, parkedForMs };
}
