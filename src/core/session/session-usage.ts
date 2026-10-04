/**
 * Session usage aggregation.
 *
 * Derives the payload of the `session.usage` snapshot event from durable state:
 * the session's token counters plus the wall-clock time the harness loop spent
 * executing it.
 *
 * `active_seconds` is measured from the append-only event log rather than from
 * a new counter column, so it survives restarts and needs no migration. Turns
 * are serialized per session (`SessionManager.executionChains`), so the session
 * is single-threaded and "at least one thread running" degenerates to the sum of
 * the `session.status_running` → next idle/terminated intervals — exactly the
 * CMA semantic for a single-threaded session.
 */

import type { MonetaryAmount, SessionBudget } from '@/types/cma-protocol.js';
import type { SessionEvent } from '@/types/session.js';

/** Opens an activity interval. */
const ACTIVE_FROM = 'session.status_running';
/** Closes an activity interval. */
const ACTIVE_UNTIL = new Set(['session.status_idle', 'session.status_terminated']);

export interface SessionUsageSnapshot {
  /** Input tokens that missed the provider's prompt cache. */
  input_tokens: number;
  output_tokens: number;
  active_seconds: number;
}

/** The published `session.usage` payload — the snapshot plus the full counters. */
export interface SessionUsagePayload extends SessionUsageSnapshot {
  /** Input tokens read from the provider's prompt cache. */
  cache_read_input_tokens: number;
  /** Input tokens written to the provider's prompt cache, split by TTL. */
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  /** Present only when every model the session used has a list price. */
  list_cost?: MonetaryAmount;
  budget: SessionBudget | null;
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
}

/**
 * The minimal shape the active-seconds derivation reads: a status-transition
 * event type and the time it happened. `SessionEvent` satisfies it, and the
 * session-list route uses it to compute stats from a single bulk query instead
 * of a full event read per row.
 */
export interface ActiveStatusTick {
  type: string;
  processedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

/**
 * Total seconds the session was executing.
 *
 * An interval that is still open (the turn is mid-flight) is counted up to
 * `now`. That case is real: the snapshot is emitted immediately **before** the
 * closing `session.status_idle` is appended, so the interval it describes has
 * not been closed in the log yet.
 */
export function activeSecondsFromEvents(
  events: readonly SessionEvent[],
  now: Date = new Date(),
): number {
  return activeSecondsFromTicks(events, now);
}

/** {@link activeSecondsFromEvents} over any row carrying type + timestamps. */
export function activeSecondsFromTicks(
  ticks: readonly ActiveStatusTick[],
  now: Date = new Date(),
): number {
  let openSinceMs: number | null = null;
  let totalMs = 0;

  for (const event of ticks) {
    if (event.type === ACTIVE_FROM) {
      // Turns never overlap, so a second opening event while one is open means
      // the close was never recorded. Count the earlier interval instead of
      // losing it, then restart from this event.
      if (openSinceMs !== null) {
        const at = eventTimeMs(event, now);
        totalMs += Math.max(0, at - openSinceMs);
      }
      openSinceMs = eventTimeMs(event, now);
      continue;
    }

    if (openSinceMs !== null && ACTIVE_UNTIL.has(event.type)) {
      totalMs += Math.max(0, eventTimeMs(event, now) - openSinceMs);
      openSinceMs = null;
    }
  }

  if (openSinceMs !== null) {
    totalMs += Math.max(0, now.getTime() - openSinceMs);
  }

  return totalMs / 1000;
}

/**
 * Build the usage snapshot. `tokensIn`/`tokensOut` come from the session's
 * aggregate token counters — one addition per model request, never per event
 * projection.
 */
export function buildSessionUsageSnapshot(
  events: readonly SessionEvent[],
  tokens: { tokensIn?: number; tokensOut?: number },
  now: Date = new Date(),
): SessionUsageSnapshot {
  return {
    input_tokens: tokens.tokensIn ?? 0,
    output_tokens: tokens.tokensOut ?? 0,
    active_seconds: activeSecondsFromEvents(events, now),
  };
}

/**
 * `processed_at` is written by the runtime as an ISO string; `created_at` is a
 * SQLite `datetime('now')` default. Prefer the former, and fall back to `now`
 * when a row carries no usable timestamp rather than emitting NaN.
 */
function eventTimeMs(event: ActiveStatusTick, fallback: Date): number {
  const value = event.processedAt ?? event.createdAt;
  const ms = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : fallback.getTime();
}
