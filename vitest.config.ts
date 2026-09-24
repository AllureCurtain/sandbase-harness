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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**/*.ts'],
    },
  },
});
