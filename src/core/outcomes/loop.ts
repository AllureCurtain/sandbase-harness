/**
 * Outcome-driven loop.
 *
 * A declared outcome starts a self-directed loop: the agent works, a grader
 * measures the deliverable against the rubric, the explanation goes back into the
 * session as a revision message, and the agent iterates — until the rubric is
 * satisfied, the grader says it cannot be met, the iteration budget is spent, or
 * the session is interrupted.
 *
 * The loop is driven from the persisted event log rather than from in-memory
 * state. Each revision is a real `user.message`, and each grading pass is the
 * span triple `runOutcomeEvaluation` publishes, so a resumed or replayed session
 * reconstructs exactly the sequence the agent ran.
 *
 * Failure handling is deliberately asymmetric:
 *
 * - a turn that throws propagates immediately, so the session's own error is what
 *   a client sees — the grader never runs on a turn that failed;
 * - a grader that throws closes its evaluation span as `failed` and then
 *   propagates, so the evaluator's failure becomes the session error instead of
 *   silently ending the outcome as if the deliverable had been judged.
 */

import type { SessionEvent } from '@/types/session.js';
import type { OutcomeEvaluationResult } from '@/types/cma-protocol.js';
import { runOutcomeEvaluation, type OutcomeSpanLogger } from './evaluation.js';
import type { OutcomeGrader } from './grader.js';

/**
 * Rejection code for `user.define_outcome` on a runtime with no grader.
 *
 * Accepting the event and never grading it would leave the session running with
 * no way for the outcome to end, so the absence of a grader fails closed at
 * admission rather than at the end of the first iteration.
 */
export const OUTCOME_GRADER_UNAVAILABLE_CODE = 'outcome_grader_unavailable';

/**
 * Admission refusal for a declared outcome on a grader-less runtime.
 *
 * Carries its code so the session ingress can answer 400 with the stable value
 * instead of letting message-sniffing fallbacks call it a runtime fault.
 */
export function outcomeGraderUnavailableError(): Error & { code: string } {
  const error = new Error(
    'This runtime composes no outcome grader, so a declared outcome could never be measured.',
  ) as Error & { code: string };
  error.code = OUTCOME_GRADER_UNAVAILABLE_CODE;
  return error;
}

/** Whether a thrown value is the declaration refusal above. */
export function isOutcomeGraderUnavailableError(error: unknown): error is Error & { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === OUTCOME_GRADER_UNAVAILABLE_CODE
  );
}

/** Raised when an interrupt stopped the outcome mid-flight. */
export class OutcomeInterruptedError extends Error {
  constructor() {
    super('The outcome was interrupted before it completed.');
    this.name = 'OutcomeInterruptedError';
  }
}

export interface OutcomeRequest {
  description: string;
  /** Iterations allowed, already defaulted by the ingress normalizer. */
  maxIterations: number;
}

export interface OutcomeLoopInput {
  outcomeId: string;
  request: OutcomeRequest;
  /** Rubric text, already resolved from inline content or an uploaded file. */
  rubric: string;
  grader: OutcomeGrader;
  logger: OutcomeSpanLogger;
  /** Append a revision message so the next turn sees the grader's explanation. */
  appendRevision: (text: string) => SessionEvent;
  /** Run one agent turn over the log as it currently stands. */
  runTurn: () => AsyncIterable<SessionEvent>;
  /** Read the session's log as a grader-facing transcript. */
  readTranscript: () => string;
  /**
   * True once the outcome must stop driving turns.
   *
   * Two things make it true: the caller aborted the session, or a turn left the
   * run in a state the loop cannot continue through — a tool confirmation is
   * pending, so another turn would answer work the session is still waiting on.
   * Both close the outcome as `interrupted`; the session's own status carries
   * the difference between them.
   */
  isAborted: () => boolean;
}

export interface OutcomeLoopResult {
  result: OutcomeEvaluationResult;
  /** How many evaluations ran, counting the one that ended the outcome. */
  iterations: number;
  explanation: string;
}

export async function runOutcomeLoop(input: OutcomeLoopInput): Promise<OutcomeLoopResult> {
  const maxIterations = Math.max(1, input.request.maxIterations);
  let explanation = '';

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (input.isAborted()) {
      closeInterrupted(input, iteration);
      throw new OutcomeInterruptedError();
    }

    if (iteration > 0) {
      // The revision is appended before the turn, so the turn re-reads the log
      // and sees the grader's explanation as its instruction.
      input.appendRevision(revisionMessage(input.request.description, explanation));
      for await (const event of input.runTurn()) {
        void event;
      }
      // A turn can consume the interrupt, so the stop is re-checked before the
      // turn is measured: grading a turn the caller stopped would report a
      // verdict about work that never finished.
      if (input.isAborted()) {
        closeInterrupted(input, iteration);
        throw new OutcomeInterruptedError();
      }
    }

    const evaluation = await runOutcomeEvaluation({
      outcomeId: input.outcomeId,
      iteration,
      description: input.request.description,
      rubric: input.rubric,
      grader: input.grader,
      logger: input.logger,
      readTranscript: input.readTranscript,
      // The last allowed evaluation reports the budget rather than asking for a
      // revision the loop cannot run.
      budgetSpent: iteration === maxIterations - 1,
    });
    explanation = evaluation.explanation;

    if (evaluation.result === 'satisfied' || evaluation.result === 'failed') {
      return { result: evaluation.result, iterations: iteration + 1, explanation };
    }

    if (evaluation.result === 'max_iterations_reached') {
      // The budget is spent, so no further evaluation runs. The agent still gets
      // one final turn to settle its answer before the session goes idle.
      input.appendRevision(finalRevisionMessage(input.request.description, evaluation.explanation));
      for await (const event of input.runTurn()) {
        void event;
      }
      if (input.isAborted()) {
        // The settling turn was stopped, so `interrupted` — not the budget
        // verdict the last evaluation already reported — is what ended this
        // outcome, and the log says so.
        closeInterrupted(input, iteration);
        return { result: 'interrupted', iterations: iteration + 1, explanation };
      }
      return { result: 'max_iterations_reached', iterations: iteration + 1, explanation };
    }
  }

  return { result: 'max_iterations_reached', iterations: maxIterations, explanation };
}

/**
 * Close an outcome as `interrupted`.
 *
 * The close is not tied to one evaluation, so `outcome_evaluation_start_id` is
 * empty: no start event is being closed. That keeps this event distinguishable
 * from the end span of an evaluation that actually ran, whichever point of the
 * iteration the stop arrived at.
 */
function closeInterrupted(input: OutcomeLoopInput, iteration: number): void {
  input.logger.append({
    type: 'span.outcome_evaluation_end',
    metadata: {
      outcome_id: input.outcomeId,
      outcome_evaluation_start_id: '',
      result: 'interrupted',
      explanation: 'The outcome was interrupted before evaluation completed.',
      iteration,
    },
  });
}

/** The agent-facing instruction that asks for the work the grader will measure. */
export function revisionMessage(description: string, explanation: string): string {
  return [
    `Your work on this outcome was evaluated and still needs revision: ${description}`,
    '',
    'Grader feedback:',
    explanation || 'The grader did not provide an explanation.',
    '',
    'Address each point above, then produce the revised deliverable.',
  ].join('\n');
}

/** The final turn's instruction once no further evaluation will run. */
export function finalRevisionMessage(description: string, explanation: string): string {
  return [
    `The iteration budget for this outcome is spent: ${description}`,
    '',
    'Grader feedback on the last attempt:',
    explanation || 'The grader did not provide an explanation.',
    '',
    'Produce your final answer for the outcome. It will not be evaluated again.',
  ].join('\n');
}
