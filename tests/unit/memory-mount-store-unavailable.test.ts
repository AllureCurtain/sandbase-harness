/**
 * The memory store-unavailable refusal.
 *
 * `storeUnavailable` is the single place the mount adapter says "this store
 * cannot be used", and the refusal has to carry two things a caller cannot
 * recover on its own: the wire code it switches on, and *which* store is
 * unavailable. Without the identifier an operator reading a log line has no way
 * to tell which of a session's attached stores needs attention.
 */

import { describe, expect, it } from 'vitest';
import { storeUnavailable } from '@/core/memory/mount-adapter.js';

describe('storeUnavailable', () => {
  it('refuses with the documented code and says which store is unavailable', () => {
    const result = storeUnavailable('store_abc');

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('store_unavailable');
    expect(result.error.message).toContain('store_abc');
    expect(result.error.message).toMatch(/unavailable|archived/);
  });

  it('interpolates the identifier rather than reporting a fixed store', () => {
    // Two different stores must not produce the same message, or the message
    // would be decoration rather than information.
    const first = storeUnavailable('store_abc');
    const second = storeUnavailable('store_xyz');

    expect(first.error.message).not.toBe(second.error.message);
    expect(second.error.message).toContain('store_xyz');
    expect(second.error.message).not.toContain('store_abc');
  });
});
