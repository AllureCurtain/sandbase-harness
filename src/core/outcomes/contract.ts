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
