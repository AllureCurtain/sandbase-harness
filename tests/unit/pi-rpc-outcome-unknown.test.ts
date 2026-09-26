/**
 * `pi_rpc_outcome_unknown` — a command was written and its outcome could not be
 * confirmed.
 *
 * The transport documents this beside its opposite: `pi_rpc_command_rejected`
 * means Pi answered `success: false`, so the outcome is *known* — the command
 * was refused. This one means the write left the process and nothing came back.
 * The two are the same shape of failure to a careless caller and demand opposite
 * behaviour: one may be re-sent, the other may already have run. Hence the
 * explicit `outcomeUnknown` flag, asserted here because it is the marker a caller
 * is supposed to branch on rather than infer.
 */

import { describe, expect, it } from 'vitest';
import { PiRpcError, PiRpcOutcomeUnknownError } from '@/strategy/pi/rpc-transport.js';
import { PI_RPC_COMMAND_REJECTED_CODE, PI_RPC_OUTCOME_UNKNOWN_CODE } from '@/strategy/pi/rpc-wire.js';

describe('pi_rpc_outcome_unknown', () => {
  it('is the code and name for a written command whose outcome could not be confirmed', () => {
    const error = new PiRpcOutcomeUnknownError('prompt', 'stdout ended mid-compose');

    expect(error).toBeInstanceOf(PiRpcError);
    expect(error.code).toBe('pi_rpc_outcome_unknown');
    expect(error.name).toBe('PiRpcOutcomeUnknownError');
  });

  it('is marked so a caller cannot treat the command as not having happened', () => {
    const error = new PiRpcOutcomeUnknownError('prompt', 'stdout ended mid-compose');

    expect(error.outcomeUnknown).toBe(true);
  });

  it('names the command and the reason in its message', () => {
    const error = new PiRpcOutcomeUnknownError('prompt', 'stdout ended mid-compose');

    expect(error.message).toContain('prompt');
    expect(error.message).toContain('stdout ended mid-compose');
  });

  it('is not the code for a refusal, whose outcome is known', () => {
    // Conflating the two would let a caller re-send a command that may already
    // have run. Asserted against the constants, not two literal values: a
    // literal-to-literal comparison cannot notice the codes being collapsed.
    expect(PI_RPC_OUTCOME_UNKNOWN_CODE).not.toBe(PI_RPC_COMMAND_REJECTED_CODE);
    expect(new PiRpcOutcomeUnknownError('prompt', 'detail').code).not.toBe(PI_RPC_COMMAND_REJECTED_CODE);
  });
});
