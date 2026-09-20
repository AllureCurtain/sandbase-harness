/**
 * `initial_events` normalizer for session creation.
 *
 * The published contract allows a session to start its agent loop in the same
 * call that creates it: `POST /v1/sessions` accepts an optional `initial_events`
 * array, and a non-empty list means the session is created already `running`
 * rather than idle. The constraints below are enforced here so an invalid batch
 * fails before any session row, event, or sandbox exists:
 *
 * - only `user.message` is accepted (every other event kind is either
 *   server-owned or meaningless before the session exists);
 * - at most 50 events;
 * - an empty array is equivalent to omitting the field.
 *
 * The creation response deliberately does not echo `initial_events`; a client
 * confirms them by listing the session's events.
 */

import type { UserEvent } from '@/types/cma-protocol.js';
import { normalizeMessageContent } from './session-normalizers.js';

/** Maximum number of events accepted in one creation call. */
export const MAX_INITIAL_EVENTS = 50;

const INITIAL_EVENT_TYPES = new Set(['user.message']);

export interface InitialEventsResult {
  ok: boolean;
  events?: UserEvent[];
  code?: string;
  message?: string;
}

/**
 * Validate and normalize an `initial_events` payload.
 *
 * `undefined` and `[]` both mean "no initial events", so a caller that
 * normalizes the field unconditionally gets one consistent representation.
 */
export function normalizeInitialEvents(value: unknown): InitialEventsResult {
  if (value === undefined || value === null) return { ok: true, events: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: 'invalid_initial_events',
      message: 'initial_events must be an array',
    };
  }
  if (value.length === 0) return { ok: true, events: [] };
  if (value.length > MAX_INITIAL_EVENTS) {
    return {
      ok: false,
      code: 'too_many_initial_events',
      message: `initial_events accepts at most ${MAX_INITIAL_EVENTS} events (received ${value.length})`,
    };
  }

  const events: UserEvent[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events[${index}] must be an object`,
      };
    }
    const event = raw as Record<string, unknown>;
    if (typeof event.type !== 'string' || !INITIAL_EVENT_TYPES.has(event.type)) {
      return {
        ok: false,
        code: 'invalid_initial_event_type',
        message: `initial_events[${index}].type must be user.message (got "${String(event.type)}")`,
      };
    }

    const content = Array.isArray(event.content) && event.content.length === 0
      ? []
      : normalizeMessageContent(event.content);
    if (!content) {
      return {
        ok: false,
        code: 'invalid_initial_events',
        message: `initial_events[${index}].content must be a string or an array of content blocks`,
      };
    }
    events.push({ type: 'user.message', content });
  }

  return { ok: true, events };
}
