/**
 * `pi_rpc_gate_lost` — a gated tool reached execution with no gate decision.
 *
 * The behaviour is already covered: `tests/unit/pi-rpc-session.test.ts:701`
 * asserts the turn fails with `PiRpcGateLostError`. What is asserted nowhere is
 * the **wire spelling**, and that is the published contract — a client branches on
 * the code string, and it is what `session.error.type` carries. A rename would
 * therefore leave every existing test green, because they key off the class or
 * the constant, while changing what callers actually receive. Hence the literal.
 *
 * Its distinction from `pi_rpc_gate_unavailable` is asserted with it, because the
 * two describe different facts that both end as "the gate did not govern": the
 * extension never loaded, versus a gated call that ran anyway.
 */

import { describe, expect, it } from 'vitest';
import { PiRpcGateLostError } from '@/strategy/pi/rpc-session.js';
import { PI_RPC_GATE_LOST_CODE, PI_RPC_GATE_UNAVAILABLE_CODE } from '@/strategy/pi/rpc-wire.js';

describe('pi_rpc_gate_lost', () => {
  it('is the code and name for a gated tool that ran without a decision', () => {
    const error = new PiRpcGateLostError('shell', 'call_42');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('pi_rpc_gate_lost');
    expect(error.name).toBe('PiRpcGateLostError');
  });

  it('names the tool and the call so the unguarded execution can be found', () => {
    const error = new PiRpcGateLostError('shell', 'call_42');

    expect(error.message).toContain('shell');
    expect(error.message).toContain('call_42');
  });

  it('stays distinct from the code for a gate extension that never loaded', () => {
    // Both mean the gate did not govern, but they are different facts: one is a
    // start-up fault, the other is a tool that already ran. Collapsing them would
    // hide an unguarded execution behind a configuration error.
    expect(PI_RPC_GATE_LOST_CODE).not.toBe(PI_RPC_GATE_UNAVAILABLE_CODE);
    expect(new PiRpcGateLostError('shell', 'call_42').code).not.toBe(PI_RPC_GATE_UNAVAILABLE_CODE);
  });
});
