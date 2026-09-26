/**
 * The public error-code inventory is pinned (item 18, error taxonomy).
 *
 * `errors.md` states that SandBase `code` values are "local and stable". Stable was a claim with nothing
 * enforcing it: a rename or an addition was invisible until a caller broke. This test makes the inventory a
 * checked artifact, so changing it is a deliberate act that shows up in a diff.
 *
 * **Model, stated so its limits are not mistaken for completeness.** The scan reads every `.ts` file under
 * `src`, recursively, for exactly two shapes: `code: '<literal>'` (the helper argument) and
 * `_CODE = '<literal>'` (the exported constant style). A code built any other way — concatenated,
 * defaulted, or assembled elsewhere and passed as a variable — is invisible here. That is the same
 * limitation every scan in this repository has: an inventory is only as good as its model of where the
 * values live. **Broadening the model is the right response to a miss, not deleting the assertion.**
 *
 * The pinned values live in `tests/fixtures/error-codes.json`, which is data rather than code on purpose:
 * the fixture is produced by the scan, while this file is authored by hand. Composing a source file by
 * interpolating measured data through a shell is how the first attempt at this test produced a file that
 * `tsc` accepted and Vite refused to transform.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'error-codes.json');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** Every code the source emits, by the two shapes this inventory models. Sorted, so the comparison is stable. */
function scanCodes(): string[] {
  const codes = new Set<string>();
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/code:\s*'([a-z_]+)'/g)) codes.add(match[1]);
    for (const match of text.matchAll(/_CODE\s*=\s*'([a-z_]+)'/g)) codes.add(match[1]);
  }
  return [...codes].sort();
}

function pinnedCodes(): string[] {
  return (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { codes: string[] }).codes;
}

describe('public error-code inventory', () => {
  it('matches the codes the source emits, in both directions', () => {
    // One-sided comparison would let a code be dropped from the fixture without failing, so this asserts
    // set equality: every emitted code is pinned, and every pinned code is still emitted.
    expect(scanCodes()).toEqual([...pinnedCodes()].sort());
  });

  it('is non-empty and free of duplicates', () => {
    const pinned = pinnedCodes();
    expect(pinned.length).toBeGreaterThan(0);
    expect(new Set(pinned).size).toBe(pinned.length);
  });
});
