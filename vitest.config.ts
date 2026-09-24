import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec,prop}.{ts,tsx}'],
    // Declare the per-test budget instead of inheriting vitest's implicit
    // 5000ms. GitHub's Windows runner is roughly ten times slower than a
    // developer machine on this suite: tests/unit/runtime-session-runtime.test.ts
    // averages 0.4s per test locally and 3.9s per test there, so those tests
    // already sat against the default and the vitest 5 upgrade pushed 32 tests
    // across 11 files over it. The heaviest suites in this repository declare
    // their own budgets (tests/integration/github-materialization-real.test.ts
    // uses 60s, the Kubernetes suites 240-300s); this is the budget for the
    // rest, and it still fails a genuinely hung test.
    testTimeout: 30_000,
    // The same budget for setup and teardown. `testTimeout` above does not
    // cover a hook — `hookTimeout` has its own implicit default of 10000ms —
    // so a runner slow enough to need the larger per-test budget could still
    // fail in `beforeEach`, and the failure was then reported against whichever
    // test happened to be running rather than against the shared setup that
    // actually timed out. That is not hypothetical: a Windows job on 2026-09-24
    // failed eleven tests across eight unrelated files this way, with
    // tests/unit/event-logger.test.ts taking 130s for 12 tests that normally
    // finish in under a second, and every job passed on a re-run of the same
    // commit. Almost every suite here sets up a temporary database and runs
    // migrations in a hook, which is the heaviest single step in the file, so
    // holding setup to a *smaller* budget than the test it prepares is the
    // wrong way round. A genuinely hung hook still fails, at 30s instead of 10s.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**/*.ts'],
    },
  },
});
