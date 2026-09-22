/**
 * The outcome loop's control flow.
 *
 * `contracts/anthropic-cma/sessions.md` §2 says an outcome iterates until the
 * rubric is satisfied, the budget is spent, or the session is interrupted. These
 * tests pin the three things that decide whether the loop is honest: the budget
 * is the only thing that can stop a `needs_revision` from starting another turn,
 * a failure in the turn itself is never graded, and an interrupt ends the outcome
 * instead of leaving an evaluation open.
 */

import { describe, it, expect } from 'vitest';
import { OutcomeInterruptedError, OUTCOME_BUDGET_REACHED_RESULT, runOutcomeLoop } from '@/core/outcomes/loop.js';
import { BUDGET_ERROR_CODES } from '@/core/session/session-budget.js';
import type { SessionEvent } from '@/types/session.js';
import type { OutcomeGrade } from '@/core/outcomes/grader.js';

/** A scripted run: turns and grades are consumed in order. */
function harness(
  grades: OutcomeGrade[],
  opts: {
    abortAfterEvaluations?: number;
    abortAfterTurns?: number;
    exhaustedAfterEvaluations?: number;
    exhaustedAfterTurns?: number;
  } = {},
) {
  const spans: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const revisions: string[] = [];
  const turns: string[] = [];
  let gradeIndex = 0;
  let turnCount = 0;

  return {
    spans,
    revisions,
    turns,
    input: {
      outcomeId: 'outc_loop',
      request: { description: 'Ship a working endpoint', maxIterations: grades.length },
      rubric: '- returns 200',
      grader: {
        grade: async () => {
          const grade = grades[Math.min(gradeIndex, grades.length - 1)];
          gradeIndex += 1;
          return grade;
        },
      },
      logger: {
        append: (span: { type: string; metadata: Record<string, unknown> }) => {
          spans.push(span);
          return { id: `sevt_${spans.length}` } as SessionEvent;
        },
      },
      appendRevision: (text: string) => {
        revisions.push(text);
        return { id: `sevt_rev_${revisions.length}` } as SessionEvent;
      },
      runTurn: async function* () {
        turnCount += 1;
        turns.push(`turn ${turnCount}`);
        yield { id: `sevt_turn_${turnCount}` } as SessionEvent;
      },
      readTranscript: () => `assistant: attempt ${turnCount}`,
      isAborted: () =>
        (opts.abortAfterEvaluations !== undefined && gradeIndex >= opts.abortAfterEvaluations) ||
        // Models an interrupt that lands while a turn is running rather than
        // between iterations.
        (opts.abortAfterTurns !== undefined && turnCount >= opts.abortAfterTurns),
      // A ceiling is read from the session's spend, so the harness models it as a
      // count of the evaluations and turns that have happened by then.
      isExhausted: () =>
        (opts.exhaustedAfterEvaluations !== undefined && gradeIndex >= opts.exhaustedAfterEvaluations) ||
        (opts.exhaustedAfterTurns !== undefined && turnCount >= opts.exhaustedAfterTurns),
    },
  };
}

const satisfied: OutcomeGrade = { result: 'satisfied', explanation: 'The endpoint returns 200.' };
const revise: OutcomeGrade = { result: 'needs_revision', explanation: 'The response body is empty.' };

describe('runOutcomeLoop', () => {
  it('stops at the first satisfied verdict without revising', async () => {
    const run = harness([satisfied]);
    const result = await runOutcomeLoop(run.input);

    expect(result).toEqual({ result: 'satisfied', iterations: 1, explanation: 'The endpoint returns 200.' });
    expect(run.turns).toHaveLength(0);
    expect(run.revisions).toEqual([]);
    expect(run.spans.map((span) => span.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
    ]);
    expect(run.spans.at(-1)?.metadata).toMatchObject({ iteration: 0, result: 'satisfied' });
  });

  it('feeds the explanation back and iterates until the rubric is satisfied', async () => {
    const run = harness([revise, satisfied]);
    const result = await runOutcomeLoop(run.input);

    expect(result.result).toBe('satisfied');
    expect(result.iterations).toBe(2);
    expect(run.turns).toEqual(['turn 1']);
    expect(run.revisions).toHaveLength(1);
    expect(run.revisions[0]).toContain('The response body is empty.');
    expect(run.revisions[0]).toContain('Ship a working endpoint');
    expect(run.spans.map((span) => span.metadata.iteration)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(run.spans.at(-1)?.metadata).toMatchObject({ result: 'satisfied' });
  });

  it('reports the spent budget instead of asking for a revision it cannot run', async () => {
    const run = harness([revise, revise]);
    const result = await runOutcomeLoop(run.input);

    expect(result).toEqual({
      result: 'max_iterations_reached',
      iterations: 2,
      explanation: 'The response body is empty.',
    });
    // The last allowed evaluation reports the budget, not another revision…
    expect(run.spans.at(-1)?.metadata).toMatchObject({ iteration: 1, result: 'max_iterations_reached' });
    // …and the agent still gets one final turn to settle its answer.
    expect(run.turns).toEqual(['turn 1', 'turn 2']);
    expect(run.revisions.at(-1)).toContain('iteration budget for this outcome is spent');
  });

  it('ends an interrupted outcome as interrupted, without leaving an evaluation open', async () => {
    const run = harness([revise, satisfied], { abortAfterEvaluations: 1 });
    await expect(runOutcomeLoop(run.input)).rejects.toBeInstanceOf(OutcomeInterruptedError);

    expect(run.spans.map((span) => span.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
      // The interrupt is published as one further end event, with no start id
      // because that evaluation never began.
      'span.outcome_evaluation_end',
    ]);
    expect(run.spans.at(-1)?.metadata).toMatchObject({ result: 'interrupted', outcome_evaluation_start_id: '', iteration: 1 });
    // No revision was appended for the iteration that never ran.
    expect(run.revisions).toHaveLength(0);
  });

  it('does not measure a revision turn the caller stopped', async () => {
    const run = harness([revise, satisfied], { abortAfterTurns: 1 });
    await expect(runOutcomeLoop(run.input)).rejects.toBeInstanceOf(OutcomeInterruptedError);

    // The revision was appended and its turn ran, but nothing graded the stopped
    // turn: an interrupt that lands inside a turn is noticed before measuring it.
    expect(run.turns).toEqual(['turn 1']);
    expect(run.revisions).toHaveLength(1);
    expect(run.spans.map((span) => span.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
      'span.outcome_evaluation_end',
    ]);
    expect(run.spans[2].metadata).toMatchObject({ iteration: 0, result: 'needs_revision' });
    expect(run.spans[3].metadata).toMatchObject({
      iteration: 1,
      result: 'interrupted',
      outcome_evaluation_start_id: '',
    });
  });

  it('closes the outcome as interrupted when the settling turn is stopped', async () => {
    // One allowed iteration: the evaluation reports the spent budget, and the
    // interrupt then lands during the final turn it allows.
    const run = harness([revise], { abortAfterTurns: 1 });
    const result = await runOutcomeLoop(run.input);

    expect(result).toMatchObject({ result: 'interrupted', iterations: 1 });
    expect(run.turns).toEqual(['turn 1']);
    // The budget verdict stays on the log; the interrupt close is what ended the
    // outcome, so a client reading it does not stop at `max_iterations_reached`.
    expect(run.spans.map((span) => span.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
      'span.outcome_evaluation_end',
    ]);
    expect(run.spans[2].metadata).toMatchObject({ iteration: 0, result: 'max_iterations_reached' });
    expect(run.spans[3].metadata).toMatchObject({
      iteration: 0,
      result: 'interrupted',
      outcome_evaluation_start_id: '',
    });
  });

  it('spends nothing once the session has reached its ceiling', async () => {
    // Already exhausted when the loop starts, which is the state a declaration's
    // own turn leaves behind when it crosses the cap.
    const run = harness([revise, satisfied], { exhaustedAfterEvaluations: 0 });
    const result = await runOutcomeLoop(run.input);

    expect(result).toEqual({ result: OUTCOME_BUDGET_REACHED_RESULT, iterations: 0, explanation: '' });
    // Neither the grading pass nor a revision turn runs: the ceiling stops the
    // loop before its next model request, not after it.
    expect(run.turns).toEqual([]);
    expect(run.revisions).toEqual([]);
    expect(run.spans.map((span) => span.type)).toEqual(['span.outcome_evaluation_end']);
    expect(run.spans[0].metadata).toMatchObject({
      iteration: 0,
      result: OUTCOME_BUDGET_REACHED_RESULT,
      outcome_evaluation_start_id: '',
    });
  });

  it('ends the outcome when a revision turn spends the last of the ceiling', async () => {
    const run = harness([revise, satisfied], { exhaustedAfterTurns: 1 });
    const result = await runOutcomeLoop(run.input);

    // The turn the revision asked for ran and was paid for; nothing measured it.
    expect(result).toMatchObject({ result: OUTCOME_BUDGET_REACHED_RESULT, iterations: 1 });
    expect(run.turns).toEqual(['turn 1']);
    expect(run.revisions).toHaveLength(1);
    expect(run.spans.map((span) => span.type)).toEqual([
      'span.outcome_evaluation_start',
      'span.outcome_evaluation_ongoing',
      'span.outcome_evaluation_end',
      'span.outcome_evaluation_end',
    ]);
    expect(run.spans[2].metadata).toMatchObject({ iteration: 0, result: 'needs_revision' });
    expect(run.spans[3].metadata).toMatchObject({
      iteration: 1,
      result: OUTCOME_BUDGET_REACHED_RESULT,
      outcome_evaluation_start_id: '',
    });
  });

  it('does not run the settling turn once the ceiling is spent', async () => {
    // Two allowed iterations: the last evaluation reports the spent budget, and by
    // then the ceiling has been reached too.
    const run = harness([revise, revise], { exhaustedAfterEvaluations: 2 });
    const result = await runOutcomeLoop(run.input);

    expect(result).toMatchObject({ result: OUTCOME_BUDGET_REACHED_RESULT, iterations: 2 });
    // The settling turn is a model request, so it is skipped: only the revision
    // turn of iteration 1 ran.
    expect(run.turns).toEqual(['turn 1']);
    expect(run.spans.at(-1)?.metadata).toMatchObject({
      iteration: 1,
      result: OUTCOME_BUDGET_REACHED_RESULT,
    });
    expect(run.spans.filter((span) => span.metadata.result === 'max_iterations_reached')).toHaveLength(1);
  });

  it('spells the verdict the way admission spells the refusal', () => {
    // One name for one fact: a client reading the outcome's terminal event and a
    // client reading the 400 should not have to learn two.
    expect(OUTCOME_BUDGET_REACHED_RESULT).toBe(BUDGET_ERROR_CODES.reached);
  });
});
