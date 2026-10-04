/**
 * Unit test: the per-request usage split that keeps a cache read from being
 * recorded — and billed — as a full-rate input token.
 */
import { describe, expect, it } from 'vitest';
import { splitModelRequestUsage } from '@/strategy/model-usage.js';

describe('splitModelRequestUsage', () => {
  it('records only the uncached share as input and reports both cache buckets', () => {
    expect(
      splitModelRequestUsage({
        inputTokens: 1000,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 },
      }),
    ).toEqual({ input: 100, cacheRead: 800, cacheWrite: 100 });
  });

  it('records the whole input when the provider reports no cache details', () => {
    expect(splitModelRequestUsage({ inputTokens: 1000 })).toEqual({
      input: 1000,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('reports zeros when the provider reports no usage at all', () => {
    expect(splitModelRequestUsage(undefined)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0 });
    expect(splitModelRequestUsage({})).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('fills only the buckets the provider reported', () => {
    // A provider that knows cache reads but not writes yields a partial
    // details object; each missing bucket is a real zero, not a guess.
    expect(
      splitModelRequestUsage({
        inputTokens: 500,
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 300 },
      }),
    ).toEqual({ input: 200, cacheRead: 300, cacheWrite: 0 });
  });
});
