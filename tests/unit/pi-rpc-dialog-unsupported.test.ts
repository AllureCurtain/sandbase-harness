/**
 * `pi_rpc_dialog_unsupported` — a dialog this runtime does not answer arrived.
 *
 * The behaviour is already covered: `tests/unit/pi-rpc-session.test.ts:325`
 * asserts the turn fails with `PiRpcDialogUnsupportedError`. What no test asserts
 * is the **wire spelling**, which is the published contract — it is what
 * `session.error.type` carries and what a client branches on. The existing
 * assertion keys off the class, so a rename would leave every test green while
 * changing what callers receive.
 *
 * The distinction asserted with it is from the frame-trust failure: a dialog the
 * runtime declines to answer is a clean capability answer about a well-formed
 * frame, not a frame that could not be trusted, and reporting the second for the
 * first would send a caller looking for corruption that is not there.
 */

import { describe, expect, it } from 'vitest';
import { PiRpcDialogUnsupportedError } from '@/strategy/pi/rpc-session.js';
import { PI_RPC_DIALOG_UNSUPPORTED_CODE, PI_RPC_PROTOCOL_ERROR_CODE } from '@/strategy/pi/rpc-wire.js';

describe('pi_rpc_dialog_unsupported', () => {
  it('is the code and name for a dialog this runtime does not answer', () => {
    const error = new PiRpcDialogUnsupportedError('plan_review');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('pi_rpc_dialog_unsupported');
    expect(error.name).toBe('PiRpcDialogUnsupportedError');
  });

  it('names the dialog method, so the unanswered question can be found', () => {
    const error = new PiRpcDialogUnsupportedError('plan_review');

    expect(error.message).toContain('plan_review');
    // The turn was failed rather than left waiting, which is the part a caller
    // needs to know: nothing is still blocked inside the child.
    expect(error.message).toContain('failed');
  });

  it('stays distinct from the code for a frame that could not be trusted', () => {
    // A declined dialog is a well-formed frame the runtime chose not to answer;
    // a protocol error is a frame that could not be trusted at all. Collapsing
    // them would report corruption where the engine was simply asking something
    // this runtime does not support.
    expect(PI_RPC_DIALOG_UNSUPPORTED_CODE).not.toBe(PI_RPC_PROTOCOL_ERROR_CODE);
    expect(new PiRpcDialogUnsupportedError('plan_review').code).not.toBe(PI_RPC_PROTOCOL_ERROR_CODE);
  });
});
