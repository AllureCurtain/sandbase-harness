/**
 * The shared driver's contract, asserted rather than described.
 *
 * `support/app.ts` states the setup every shape-layer suite depends on:
 * migrations run, the `env_default` environment row exists, no agent rows are
 * seeded, authentication stays off, and each caller gets its own database and
 * temp directory. Those are the assumptions the other suites are written
 * against, so if the driver stops holding one of them the suites would fail in
 * their own terms — with an assertion about beta headers or 404 envelopes —
 * rather than pointing at the harness that changed.
 *
 * The second case is the one that keeps the driver from being replaced by a
 * stub: it exercises the wired app rather than the returned object, so a factory
 * that returns a plausible-looking context with an unwired app fails here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './app.js';

const contexts: ConformanceContext[] = [];

afterEach(() => {
  disposeConformanceContexts(contexts);
});

describe('the conformance driver', () => {
  it('gives every caller its own database, with the environment row in place', () => {
    const first = makeConformanceApp('ma-driver-first-');
    const second = makeConformanceApp('ma-driver-second-');
    contexts.push(first, second);

    expect(first.tmpDir).not.toBe(second.tmpDir);
    // A second connection to the first context's file would share state; two
    // contexts that happen to be the same database is the failure this rules out.
    first.db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_only_in_first', 'x', '{}')`);
    const seenBySecond = second.db
      .prepare(`SELECT COUNT(*) AS n FROM environments WHERE id = 'env_only_in_first'`)
      .get() as { n: number };
    expect(seenBySecond.n).toBe(0);

    const seeded = first.db.prepare(`SELECT id FROM environments WHERE id = 'env_default'`).get();
    expect(seeded).toBeTruthy();
  });

  it('returns an app that is actually wired, not just a context', async () => {
    const ctx = makeConformanceApp('ma-driver-wired-');
    contexts.push(ctx);

    const read = await ctx.app.request('/v1/agents', {
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'managed-agents-2026-04-01' },
    });
    const missing = await ctx.app.request('/v1/driver_contract_unknown_route');

    expect(read.status).toBe(200);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type') ?? '').toContain('application/json');
  });
});
