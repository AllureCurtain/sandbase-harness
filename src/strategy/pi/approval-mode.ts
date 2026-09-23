/**
 * Platform-owned approval mode for the Pi tool gate.
 *
 * A gated Pi tool call has exactly one question to answer — may this call run
 * this once — and this module names who is allowed to answer it:
 *
 * - `interactive` (the default) waits for a person: the call is published as an
 *   approval card and nothing executes until a matching decision is consumed.
 * - `preauthorized_once` lets the runtime answer the call itself under a
 *   platform-owned rule. Selecting the mode *is* the preauthorization
 *   authority, so it is opt-in, off by default, and never inferred.
 *
 * What the unattended mode is not, and must not become:
 *
 * - not a standing permission: the rule is consulted again for the next gated
 *   call, and a consumed decision authorizes nothing beyond the call it
 *   consumed;
 * - not human: neither the durable record (`decision_source`) nor the published
 *   tool use (`confirmation_source`) may carry `user` for a platform answer, so
 *   no client can read an automatic decision as a click by a person;
 * - not a bypass: a rule that does not name a call leaves the gate waiting for a
 *   person rather than denying a call someone could still approve, and every
 *   path that cannot consume a decision still denies.
 */

import type { PiInteractionRecord } from './interaction-store.js';

/**
 * The approval modes this runtime recognizes.
 *
 * The names are the persisted `loop_engine.options.approval_mode` values, so an
 * unrecognized one is refused by Settings rather than coerced to a default.
 */
export const PI_APPROVAL_MODES = ['interactive', 'preauthorized_once'] as const;

export type PiApprovalMode = (typeof PI_APPROVAL_MODES)[number];

/** The mode in force when no operator selected the unattended one. */
export const PI_APPROVAL_MODE_DEFAULT: PiApprovalMode = 'interactive';

/**
 * The platform's answer for one gated call.
 *
 * A rule returns `undefined` when it does not name the call. That is not a
 * denial: the gate then waits for a person exactly as it always has, so the
 * unattended mode can neither refuse what a person could still approve nor
 * approve what the rule does not name.
 */
export type PiPreauthorizedDecision =
  | { allow: true }
  | { allow: false; reason: string };

/** Platform-owned per-call rule, consulted once per gate. */
export type PiPreauthorizedRule = (interaction: PiInteractionRecord) => PiPreauthorizedDecision | undefined;

/**
 * The rule the runtime applies once an operator selects `preauthorized_once`.
 *
 * It names exactly the calls the session's own compiled policy gates: the gate
 * only ever asks about a tool whose declared policy is `always_ask`, so the
 * operator's selection is the preauthorization and it cannot widen the tool set
 * the agent declared. The reason never claims a person decided, and the answer
 * still travels the one-shot consume path, so it authorizes one call and no
 * more.
 */
export const PI_PREAUTHORIZED_ONCE_RULE: PiPreauthorizedRule = () => ({ allow: true });

/**
 * The rule for a resolved mode, or `undefined` when the mode is off.
 *
 * A runtime started `interactive` therefore has nothing that could answer a
 * gate on its own, which is the same object shape an embedder gets by omitting
 * the option: unattended operation has to be selected, never assumed.
 */
export function piPreauthorizedRuleFor(mode: PiApprovalMode): PiPreauthorizedRule | undefined {
  return mode === 'preauthorized_once' ? PI_PREAUTHORIZED_ONCE_RULE : undefined;
}
