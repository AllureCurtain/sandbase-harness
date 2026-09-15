import { describe, expect, it } from 'vitest';
import { isTerminal, transition } from '@/core/session/state-machine.js';
import type { SessionStatus } from '@/types/session.js';

describe('Pi terminal lifecycle states', () => {
  it.each(['cancelled', 'timed_out', 'cleanup_pending'] as SessionStatus[])('treats %s as terminal and distinct from completed', (status) => {
    expect(isTerminal(status)).toBe(true);
    expect(status).not.toBe('completed');
    expect(transition('running', status)).toBe(status);
  });

  it('keeps cleanup_pending from becoming a normal completed release', () => {
    expect(isTerminal('cleanup_pending')).toBe(true);
  });
});
