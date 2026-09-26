/**
 * The `model_auth_failed` classification.
 *
 * An existing test already asserted this code — but through the *constant*
 * (`{ code: MODEL_AUTH_FAILED_CODE }`), which is relative to whatever the
 * constant happens to be. It would keep passing if the wire spelling changed
 * under it, so the thing a caller actually switches on was never pinned. These
 * cases assert the literal spelling, and the classification boundary the
 * implementation documents: only a structured status is read, because a status
 * guessed out of an error message would classify a body that merely mentions
 * "401" and a mis-classified failure is worse than an unclassified one.
 */

import { describe, expect, it } from 'vitest';
import { describeModelError } from '@/strategy/default-strategy.js';

function codeOf(error: unknown): string | undefined {
  return (describeModelError(error) as Error & { code?: string }).code;
}

describe('model_auth_failed', () => {
  it('is the code the wire carries for a provider 401', () => {
    expect(codeOf({ statusCode: 401, message: 'unauthorized' })).toBe('model_auth_failed');
  });

  it('is the code for a provider 403 as well', () => {
    // 401 and 403 mean the same thing to a caller here: the credentials were
    // refused, and the operator can fix them.
    expect(codeOf({ status: 403, message: 'forbidden' })).toBe('model_auth_failed');
  });

  it('does not classify a body that merely mentions the status', () => {
    expect(codeOf(new Error('upstream said 401 unauthorized'))).not.toBe('model_auth_failed');
  });

  it('keeps 404 distinct from an auth failure', () => {
    expect(codeOf({ statusCode: 404, message: 'no such model' })).toBe('model_not_found');
  });
});
