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

import type { UserDefineOutcomeEvent, UserEvent } from '@/types/cma-protocol.js';
import { normalizeMessageContent } from './session-normalizers.js';
import {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  MAX_OUTCOME_MAX_ITERATIONS,
} from '@/core/outcomes/contract.js';

/** Maximum number of events accepted in one creation call. */
export const MAX_INITIAL_EVENTS = 50;

/**
 * The published `user.define_outcome` budget, owned by the outcome contract.
 *
 * Re-exported here so the ingress validator and any future outcome loop cannot drift
 * apart on how much work an outcome is allowed to do.
 */
export {
  DEFAULT_OUTCOME_MAX_ITERATIONS,
  MAX_OUTCOME_MAX_ITERATIONS,
} from '@/core/outcomes/contract.js';

const INITIAL_EVENT_TYPES = new Set(['user.message', 'user.define_outcome']);

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
        message: `initial_events[${index}].type must be user.message or user.define_outcome (got "${String(event.type)}")`,
      };
    }

    if (event.type === 'user.define_outcome') {
      const outcome = normalizeDefineOutcome(event);
      if (!outcome.ok) {
        return {
          ok: false,
          code: 'invalid_initial_events',
          message: `initial_events[${index}].${outcome.message}`,
        };
      }
      events.push(outcome.event);
      continue;
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

type DefineOutcomeResult = { ok: true; event: UserDefineOutcomeEvent } | { ok: false; message: string };

/**
 * Validate a `user.define_outcome` payload.
 *
 * `rubric` is a union of an inline text document and a reference to an uploaded file.
 * `max_iterations` defaults to 3 and is rejected outside 1..20 rather than clamped,
 * because silently lowering a caller's budget would change how much work the outcome is
 * allowed to do. Unknown fields are dropped rather than stored, so the admitted event
 * carries exactly what the projection returns.
 */
export function normalizeDefineOutcome(event: Record<string, unknown>): DefineOutcomeResult {
  const description = typeof event.description === 'string' ? event.description.trim() : '';
  if (description.length === 0) return { ok: false, message: 'description is required' };

  const rubric = normalizeRubric(event.rubric);
  if (!rubric.ok) return { ok: false, message: rubric.message };

  let maxIterations = DEFAULT_OUTCOME_MAX_ITERATIONS;
  if (event.max_iterations !== undefined) {
    if (typeof event.max_iterations !== 'number' || !Number.isInteger(event.max_iterations)) {
      return { ok: false, message: 'max_iterations must be an integer' };
    }
    if (event.max_iterations < 1 || event.max_iterations > MAX_OUTCOME_MAX_ITERATIONS) {
      return {
        ok: false,
        message: `max_iterations must be between 1 and ${MAX_OUTCOME_MAX_ITERATIONS}`,
      };
    }
    maxIterations = event.max_iterations;
  }

  return {
    ok: true,
    event: {
      type: 'user.define_outcome',
      description,
      rubric: rubric.value,
      max_iterations: maxIterations,
    },
  };
}

type RubricResult =
  | { ok: true; value: UserDefineOutcomeEvent['rubric'] }
  | { ok: false; message: string };

function normalizeRubric(value: unknown): RubricResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'rubric is required' };
  }
  const rubric = value as Record<string, unknown>;
  if (rubric.type === 'text') {
    const content = typeof rubric.content === 'string' ? rubric.content.trim() : '';
    if (content.length === 0) return { ok: false, message: 'rubric.content is required for a text rubric' };
    return { ok: true, value: { type: 'text', content } };
  }
  if (rubric.type === 'file') {
    if (typeof rubric.file_id !== 'string' || rubric.file_id.length === 0) {
      return { ok: false, message: 'rubric.file_id is required for a file rubric' };
    }
    return { ok: true, value: { type: 'file', file_id: rubric.file_id } };
  }
  return { ok: false, message: 'rubric.type must be text or file' };
}
