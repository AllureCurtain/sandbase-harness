/**
 * The published `user.define_outcome` iteration budget.
 *
 * A session's outcome work is bounded by `max_iterations`, which defaults to 3 and is
 * rejected outside 1..20 rather than clamped — silently lowering a caller's budget
 * would change how much work the outcome is allowed to do. They live beside the event
 * contract because the ingress validator and any future outcome loop have to agree on
 * them, and nothing else may define a second pair.
 */
export const DEFAULT_OUTCOME_MAX_ITERATIONS = 3;
export const MAX_OUTCOME_MAX_ITERATIONS = 20;

/**
 * Stable code for a `{type: "file"}` rubric that cannot be read.
 *
 * The evaluation refuses rather than grading against an empty rubric: a grader
 * handed no criteria would report a verdict about nothing, and the caller would
 * have no way to tell that from a real measurement.
 */
export const OUTCOME_RUBRIC_FILE_NOT_FOUND_CODE = 'outcome_rubric_file_not_found';
