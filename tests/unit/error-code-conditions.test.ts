/**
 * The condition behind each unasserted public error code is pinned (item 18, error taxonomy — conditions).
 *
 * This is the last of the four taxonomy checks. The inventory says which codes exist, the attribution says
 * where each is raised, the coverage check says which ones any test asserts — and this one answers the
 * question a caller actually asks: *when does this code happen?* It covers precisely the **16 codes that no
 * test asserts**, because for the other 42 the tests are the documentation and a hand-written sentence would
 * be a second, weaker copy of them.
 *
 * **What is machine-checked and what is not, stated plainly.** The module and line for each code are
 * verified against the source, so a code that moves invalidates its own documentation row. The `condition`
 * sentence is **not** machine-checked: it is a name-and-site reading of the emitter, not a behavioural test,
 * and a wrong sentence is a documentation bug rather than a broken invariant. Claiming otherwise would be the
 * same mistake as treating a bounds assertion as proof of a value inside the bounds, and the same mistake as
 * treating a documented code as a tested one.
 *
 * The set is also tied to the coverage fixture, so the two cannot disagree about which codes are unwitnessed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONDITIONS = join(process.cwd(), 'tests', 'fixtures', 'error-code-conditions.json');
const COVERAGE = join(process.cwd(), 'tests', 'fixtures', 'error-code-coverage.json');

interface Condition {
  module: string;
  line: number;
  condition: string;
}

function pinnedConditions(): Record<string, Condition> {
  return (JSON.parse(readFileSync(CONDITIONS, 'utf8')) as { conditions: Record<string, Condition> })
    .conditions;
}

/** The codes no test mentions, read from the coverage fixture rather than restated here. */
function unassertedCodes(): string[] {
  const covered = (
    JSON.parse(readFileSync(COVERAGE, 'utf8')) as { covered: Record<string, string[]> }
  ).covered;
  return Object.entries(covered)
    .filter(([, files]) => files.length === 0)
    .map(([code]) => code)
    .sort();
}

describe('error-code conditions', () => {
  it('documents exactly the codes no test asserts', () => {
    expect(Object.keys(pinnedConditions()).sort()).toEqual(unassertedCodes());
  });

  it('pins each code to a source line that still emits it', () => {
    for (const [code, entry] of Object.entries(pinnedConditions())) {
      const text = readFileSync(join(process.cwd(), entry.module), 'utf8');
      const line = text.split('\n')[entry.line - 1] ?? '';
      expect(line, `${code} should still be emitted at ${entry.module}:${entry.line}`).toContain(code);
    }
  });

  it('states a condition for every documented code', () => {
    for (const [code, entry] of Object.entries(pinnedConditions())) {
      expect(entry.condition.trim().length, `${code} needs a condition`).toBeGreaterThan(20);
      expect(entry.line, `${code} needs a positive line number`).toBeGreaterThan(0);
      expect(entry.module.startsWith('src/'), `${code} should name a src module`).toBe(true);
    }
  });
});
