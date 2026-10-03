/**
 * `session.error` projection.
 *
 * The published event carries a typed `error` object whose `type` is one of
 * eight official values and whose `retry_status` is an object. The runtime's
 * own vocabulary is richer — Pi transport codes, work-queue codes, parked-wait
 * codes — so this module owns the two directions of that gap:
 *
 * - {@link officialErrorType} classifies a local code and the error that
 *   produced it into the official `type`, at write time. The local code is
 *   preserved under `error.code` rather than lost.
 * - {@link normalizeRetryStatus} turns a disposition into the published
 *   `{type}` object, and reads back the string form the append-only log still
 *   holds for events written before this projection existed.
 *
 * `billing_error` is part of the enumeration but has no local producer: a
 * self-hosted runtime has no billing boundary.
 */

import type { SessionErrorRetryStatus, SessionErrorType } from '@/types/cma-protocol.js';
import {
  MODEL_AUTH_FAILED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
} from '@/model/errors.js';

const OFFICIAL_ERROR_TYPES: ReadonlySet<string> = new Set<SessionErrorType>([
  'unknown_error',
  'model_overloaded_error',
  'model_rate_limited_error',
  'model_request_failed_error',
  'mcp_connection_failed_error',
  'mcp_authentication_failed_error',
  'billing_error',
  'credential_host_unreachable_error',
]);

/**
 * Model-resolution codes whose cause is a failed request against the provider
 * or the configuration that names it. The published contract has no finer
 * bucket for them than `model_request_failed_error`.
 */
const MODEL_REQUEST_FAILED_CODES: ReadonlySet<string> = new Set([
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_AUTH_FAILED_CODE,
]);

/**
 * Classify a failure into the published `error.type`.
 *
 * A coded failure already knows what it is, so the table reads the code and
 * nothing else — a `pi_timed_out` must not be read as a model timeout just
 * because its message says "timed out". An uncoded failure is the opposite:
 * provider errors (429, 529, other HTTP statuses, transport timeouts) arrive
 * without a code, so the error's own status and message carry the
 * classification. Anything else — Pi, parked wait, work queue, internal — is
 * `unknown_error`, the honest answer rather than a guess.
 */
export function officialErrorType(code: string | undefined, error?: unknown): SessionErrorType {
  if (code === undefined) {
    const status = httpStatusOf(error);
    if (status === 529 || matchesMessage(error, /overloaded/i)) return 'model_overloaded_error';
    if (status === 429 || matchesMessage(error, /rate.?limit/i)) return 'model_rate_limited_error';
    if (
      status !== undefined
      || matchesMessage(error, /timeout|timed out|etimedout|econnreset|econnrefused/i)
    ) {
      return 'model_request_failed_error';
    }
    return 'unknown_error';
  }
  if (MODEL_REQUEST_FAILED_CODES.has(code)) return 'model_request_failed_error';
  if (code === 'credential_host_unreachable') return 'credential_host_unreachable_error';
  if (/^mcp_(auth|authentication)/.test(code)) return 'mcp_authentication_failed_error';
  if (code.startsWith('mcp_')) return 'mcp_connection_failed_error';
  return 'unknown_error';
}

/**
 * The disposition object `session.error.retry_status` publishes.
 *
 * `retryable` is the only local disposition that survives as something other
 * than `terminal`: an unrecognized or unknown code tells the client nothing
 * reliable about replaying, and `terminal` is the one answer that cannot be
 * misread as an invitation.
 */
export function retryStatus(kind: 'retryable' | 'not_retryable' | 'unknown'): SessionErrorRetryStatus {
  return { type: kind === 'retryable' ? 'retrying' : 'terminal' };
}

/**
 * Read a persisted `retry_status` back into the published object.
 *
 * Events written before the object form hold the old strings: `retryable`
 * maps to `retrying`, and `not_retryable` and `unknown` both map to
 * `terminal`. An object already in the published form passes through, and
 * anything unrecognizable is `terminal` for the same reason an unknown code is.
 */
export function normalizeRetryStatus(value: unknown): SessionErrorRetryStatus {
  if (value && typeof value === 'object' && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    if (type === 'retrying' || type === 'exhausted' || type === 'terminal') return { type };
    return { type: 'terminal' };
  }
  return { type: value === 'retryable' ? 'retrying' : 'terminal' };
}

/**
 * Project a persisted `session.error` metadata payload onto the wire shape.
 *
 * Both generations of the log pass through here: a new event already stores
 * `type` as an official value and `retry_status` as an object, while an old
 * one stores the local code in `type` and a string in `retry_status`. The old
 * `type` is reclassified into the official value and reported under `code`,
 * so a reader of the log never sees the unofficial spelling.
 */
export function projectSessionError(error: unknown): SessionErrorPayload | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const raw = error as Record<string, unknown>;
  const storedType = typeof raw.type === 'string' ? raw.type : undefined;
  const type = storedType !== undefined && OFFICIAL_ERROR_TYPES.has(storedType)
    ? (storedType as SessionErrorType)
    : officialErrorType(storedType);
  const code = typeof raw.code === 'string'
    ? raw.code
    : storedType !== undefined && storedType !== type
      ? storedType
      : undefined;
  return {
    type,
    message: typeof raw.message === 'string' ? raw.message : '',
    retry_status: normalizeRetryStatus(raw.retry_status),
    ...(code !== undefined ? { code } : {}),
    ...(typeof raw.mcp_server_name === 'string' ? { mcp_server_name: raw.mcp_server_name } : {}),
    ...(typeof raw.credential_id === 'string' ? { credential_id: raw.credential_id } : {}),
    ...(typeof raw.vault_id === 'string' ? { vault_id: raw.vault_id } : {}),
  };
}

/** The wire shape `toApiEvent` publishes for `session.error`. */
export interface SessionErrorPayload {
  type: SessionErrorType;
  message: string;
  retry_status: SessionErrorRetryStatus;
  code?: string;
  mcp_server_name?: string;
  credential_id?: string;
  vault_id?: string;
}

/** HTTP status attached to a provider error (`APICallError.statusCode`). */
function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status = typeof record.statusCode === 'number' ? record.statusCode
    : typeof record.status === 'number' ? record.status
    : undefined;
  return status !== undefined && status >= 400 && status < 600 ? status : undefined;
}

function matchesMessage(error: unknown, pattern: RegExp): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && pattern.test(message);
}
