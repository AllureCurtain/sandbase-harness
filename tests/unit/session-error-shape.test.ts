/**
 * The `session.error` wire shape: official `type` classification, object
 * `retry_status`, and the read-back normalization that keeps events persisted
 * before this shape readable.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeRetryStatus,
  officialErrorType,
  projectSessionError,
  retryStatus,
} from '@/core/session/session-error.js';
import { toApiEvent } from '@/api/standard.js';
import type { SessionEvent } from '@/types/session.js';

const MODEL_CODES = [
  'model_not_found',
  'model_provider_not_configured',
  'model_config_invalid',
  'model_auth_failed',
];

const UNKNOWN_CODES = [
  'internal_error',
  'pi_timed_out',
  'pi_session_busy',
  'pi_cleanup_pending',
  'pi_rpc_closed',
  'pi_rpc_command_rejected',
  'pi_rpc_timeout',
  'pi_rpc_outcome_unknown',
  'pi_rpc_protocol_error',
  'pi_always_ask_not_supported',
  'pi_tool_policy_not_supported',
  'pi_sandbox_provider_not_supported',
  'pi_user_event_not_supported',
  'pi_message_content_not_supported',
  'loop_engine_not_supported',
  'loop_engine_invalid',
  'unsupported_capability',
  'tool_error',
  'sandbox_error',
  'parked_wait_timeout',
  'work_queue_timeout',
  'work_outcome_unknown',
  'work_lease_lost',
  'outcome_evaluator_unavailable',
  'outcome_rubric_file_not_found',
  'budget_reached',
];

const OFFICIAL_TYPES = new Set([
  'unknown_error',
  'model_overloaded_error',
  'model_rate_limited_error',
  'model_request_failed_error',
  'mcp_connection_failed_error',
  'mcp_authentication_failed_error',
  'billing_error',
  'credential_host_unreachable_error',
]);

function codedError(code: string | undefined, message = 'failed'): Error {
  return Object.assign(new Error(message), code !== undefined ? { code } : {});
}

describe('officialErrorType', () => {
  it.each(MODEL_CODES)('maps the model-resolution code %s to model_request_failed_error', (code) => {
    expect(officialErrorType(code, codedError(code))).toBe('model_request_failed_error');
  });

  it('maps an MCP connection code to mcp_connection_failed_error', () => {
    expect(officialErrorType('mcp_connect_failed', codedError('mcp_connect_failed')))
      .toBe('mcp_connection_failed_error');
    expect(officialErrorType('mcp_server_unreachable', codedError('mcp_server_unreachable')))
      .toBe('mcp_connection_failed_error');
  });

  it('maps an MCP authentication code to mcp_authentication_failed_error', () => {
    expect(officialErrorType('mcp_auth_failed', codedError('mcp_auth_failed')))
      .toBe('mcp_authentication_failed_error');
    expect(officialErrorType('mcp_authentication_failed', codedError('mcp_authentication_failed')))
      .toBe('mcp_authentication_failed_error');
  });

  it('maps the credential host code to credential_host_unreachable_error', () => {
    expect(officialErrorType('credential_host_unreachable', codedError('credential_host_unreachable')))
      .toBe('credential_host_unreachable_error');
  });

  it.each(UNKNOWN_CODES)('maps the local code %s to unknown_error', (code) => {
    expect(officialErrorType(code, codedError(code))).toBe('unknown_error');
  });

  it('reads a 529 status as model_overloaded_error', () => {
    const err = Object.assign(new Error('overloaded'), { statusCode: 529 });
    expect(officialErrorType(undefined, err)).toBe('model_overloaded_error');
    expect(officialErrorType(undefined, new Error('model overloaded, retry later')))
      .toBe('model_overloaded_error');
  });

  it('reads a 429 status as model_rate_limited_error', () => {
    const err = Object.assign(new Error('slow down'), { statusCode: 429 });
    expect(officialErrorType(undefined, err)).toBe('model_rate_limited_error');
    expect(officialErrorType(undefined, new Error('rate limit exceeded')))
      .toBe('model_rate_limited_error');
  });

  it.each([400, 401, 403, 404, 500, 502, 503])(
    'reads a %i status as model_request_failed_error',
    (statusCode) => {
      const err = Object.assign(new Error('provider failed'), { statusCode });
      expect(officialErrorType(undefined, err)).toBe('model_request_failed_error');
    },
  );

  it('reads an uncoded timeout as model_request_failed_error', () => {
    expect(officialErrorType(undefined, new Error('request timed out')))
      .toBe('model_request_failed_error');
  });

  it('reads an uncoded failure with no signal as unknown_error', () => {
    expect(officialErrorType(undefined, new Error('plain failure'))).toBe('unknown_error');
    expect(officialErrorType(undefined, 'not an error')).toBe('unknown_error');
    expect(officialErrorType(undefined)).toBe('unknown_error');
  });

  it('never produces billing_error', () => {
    for (const code of [...MODEL_CODES, ...UNKNOWN_CODES, 'billing_error']) {
      expect(officialErrorType(code, codedError(code)), code).not.toBe('billing_error');
    }
  });
});

describe('retryStatus', () => {
  it('publishes the three local dispositions as objects', () => {
    expect(retryStatus('retryable')).toEqual({ type: 'retrying' });
    expect(retryStatus('not_retryable')).toEqual({ type: 'terminal' });
    expect(retryStatus('unknown')).toEqual({ type: 'terminal' });
  });
});

describe('normalizeRetryStatus', () => {
  it.each([
    ['retryable', 'retrying'],
    ['not_retryable', 'terminal'],
    ['unknown', 'terminal'],
  ] as const)('reads the legacy string %s as %s', (legacy, expected) => {
    expect(normalizeRetryStatus(legacy)).toEqual({ type: expected });
  });

  it('passes a published object through', () => {
    expect(normalizeRetryStatus({ type: 'exhausted' })).toEqual({ type: 'exhausted' });
    expect(normalizeRetryStatus({ type: 'retrying' })).toEqual({ type: 'retrying' });
  });

  it('falls back to terminal for an unrecognizable value', () => {
    expect(normalizeRetryStatus(undefined)).toEqual({ type: 'terminal' });
    expect(normalizeRetryStatus('garbage')).toEqual({ type: 'terminal' });
    expect(normalizeRetryStatus({ type: 'mystery' })).toEqual({ type: 'terminal' });
  });
});

describe('projectSessionError', () => {
  it('reclassifies a legacy payload and keeps its code', () => {
    const projected = projectSessionError({
      type: 'pi_timed_out',
      message: 'pi turn timed out',
      retry_status: 'not_retryable',
    });

    expect(projected).toEqual({
      type: 'unknown_error',
      message: 'pi turn timed out',
      retry_status: { type: 'terminal' },
      code: 'pi_timed_out',
    });
  });

  it('passes a new-shape payload through', () => {
    const projected = projectSessionError({
      type: 'model_request_failed_error',
      message: 'unauthorized',
      retry_status: { type: 'terminal' },
      code: 'model_auth_failed',
      credential_id: 'cred_1',
      vault_id: 'vault_1',
    });

    expect(projected).toEqual({
      type: 'model_request_failed_error',
      message: 'unauthorized',
      retry_status: { type: 'terminal' },
      code: 'model_auth_failed',
      credential_id: 'cred_1',
      vault_id: 'vault_1',
    });
  });

  it('omits code for an event that only carried an official type', () => {
    const projected = projectSessionError({
      type: 'unknown_error',
      message: 'x',
      retry_status: { type: 'terminal' },
    });

    expect(projected).not.toHaveProperty('code');
  });

  it('reports nothing for a missing or malformed payload', () => {
    expect(projectSessionError(undefined)).toBeUndefined();
    expect(projectSessionError('error')).toBeUndefined();
    expect(projectSessionError([])).toBeUndefined();
  });
});

describe('toApiEvent session.error projection', () => {
  function persistedEvent(retryStatusValue: unknown, type = 'work_queue_timeout'): SessionEvent {
    return {
      id: 'sevt_test',
      sessionId: 'sess_test',
      seq: 1,
      type: 'session.error',
      content: [{ type: 'text', text: 'boom' }],
      metadata: { error: { type, message: 'boom', retry_status: retryStatusValue } },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as unknown as SessionEvent;
  }

  it.each([
    ['retryable', 'retrying'],
    ['not_retryable', 'terminal'],
    ['unknown', 'terminal'],
  ] as const)('normalizes the legacy %s disposition on the way out', (legacy, expected) => {
    const api = toApiEvent(persistedEvent(legacy));

    expect(api.error?.type).toBe('unknown_error');
    expect(api.error?.code).toBe('work_queue_timeout');
    expect(api.error?.retry_status).toEqual({ type: expected });
  });

  it('publishes one of the official types for every stored shape', () => {
    for (const stored of ['model_auth_failed', 'internal_error', 'pi_rpc_closed']) {
      const type = toApiEvent(persistedEvent('unknown', stored)).error?.type;
      expect(type && OFFICIAL_TYPES.has(type), `stored type ${stored}`).toBe(true);
    }
  });
});
