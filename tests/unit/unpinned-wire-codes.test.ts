/**
 * The two published wire codes that no test spells.
 *
 * The coverage fixture derives coverage from **literal presence** in the test
 * tree, and it recorded both of these as mentioned by no test. That reading was
 * half wrong and the half it got wrong is the interesting part:
 *
 * - `pi_policy_mismatch` is exercised by `tests/unit/pi-resume-refusal.test.ts`
 *   and `tests/unit/pi-session-continuity.test.ts`, and `outcome_rubric_file_not_found`
 *   is raised by `session-manager.ts:1353`. But **every reference goes through the
 *   imported constant**, which is the point: comparing against the constant means
 *   the published string is never pinned. Rewrite the value on either side and
 *   every existing assertion still passes, because both sides moved together.
 *
 * So the gap was not "unasserted behaviour" but "unpinned wire spelling" — the
 * same defect this series already named when a distinctness check compared two
 * literals instead of two constants. A client branches on the **string**, so the
 * string is the contract, and it is pinned here by value and against each other.
 */

import { describe, expect, it } from 'vitest';
import { OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE } from '@/core/outcomes/contract.js';
import { PI_POLICY_MISMATCH_CODE } from '@/strategy/pi/session-continuity.js';

describe('published wire codes that every other test reaches by constant', () => {
  it('pins the policy-mismatch code by value', () => {
    expect(PI_POLICY_MISMATCH_CODE).toBe('pi_policy_mismatch');
    // The doc beside the constant draws the line against a generic discontinuity
    // code: the file and the row still agree about which Pi conversation this is,
    // so reporting it as discontinuity would send an operator to repair the wrong
    // fact. A prefix check is the cheap guard against that rename.
    expect(PI_POLICY_MISMATCH_CODE.startsWith('pi_')).toBe(true);
    expect(PI_POLICY_MISMATCH_CODE).not.toBe('pi_session_discontinuous');
  });

  it('pins the unreadable-rubric code by value, and keeps the two apart', () => {
    expect(OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE).toBe('outcome_rubric_file_not_found');
    expect(OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE.startsWith('outcome_')).toBe(true);
    // Two constants, compared as constants: collapsing either into the other, or
    // into a shared value, has to fail here rather than passing everywhere.
    expect(OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE).not.toBe(PI_POLICY_MISMATCH_CODE);
  });
});
