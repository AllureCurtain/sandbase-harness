/**
 * The published retry schedule: "retries up to three times per endpoint and event with 5-120 s jittered
 * exponential backoff" (`contracts/anthropic-cma/operations.md`).
 *
 * The dispatcher used to schedule fixed 60 s and 120 s delays, so every endpoint that failed at the same
 * moment retried at the same moment — the synchronised re-attack jitter exists to prevent. These assert
 * the window itself, which is what the contract publishes, and they assert it deterministically through
 * the injectable jitter source rather than by sampling `Math.random`.
 */

import { describe, expect, it } from 'vitest';
import { nextRetryAt } from '@/core/operations/webhook-dispatcher.js';
import type { WebhookDispatchOptions } from '@/core/operations/webhook-dispatcher.js';

const BASE = Date.parse('2026-07-23T00:00:00.000Z');
const opts = (extra: Record<string, unknown>) =>
  ({ now: () => new Date(BASE), ...extra }) as unknown as WebhookDispatchOptions;

describe('published webhook retry backoff', () => {
  it('jitters inside the published window and doubles the ceiling per attempt', () => {
    // Attempt 1 backs off inside [5, 60] s and attempt 2 inside [5, 120] s.
    expect(nextRetryAt(false, 1, opts({ random: () => 0 }))).toBe(new Date(BASE + 5_000).toISOString());
    expect(nextRetryAt(false, 1, opts({ random: () => 1 }))).toBe(new Date(BASE + 60_000).toISOString());
    expect(nextRetryAt(false, 2, opts({ random: () => 0 }))).toBe(new Date(BASE + 5_000).toISOString());
    expect(nextRetryAt(false, 2, opts({ random: () => 1 }))).toBe(new Date(BASE + 120_000).toISOString());
  });

  it('never leaves the published 5-120 s window, for any draw or attempt', () => {
    for (const attempt of [1, 2]) {
      for (const draw of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const at = Date.parse(nextRetryAt(false, attempt, opts({ random: () => draw })) as string);
        expect(at - BASE).toBeGreaterThanOrEqual(5_000);
        expect(at - BASE).toBeLessThanOrEqual(120_000);
      }
    }
  });

  it('still stops after the published three attempts, and after a success', () => {
    expect(nextRetryAt(false, 3, opts({ random: () => 0.5 }))).toBeNull();
    expect(nextRetryAt(true, 1, opts({ random: () => 0.5 }))).toBeNull();
    expect(nextRetryAt(false, 2, opts({ random: () => 0.5, maxAttempts: 2 }))).toBeNull();
  });
});