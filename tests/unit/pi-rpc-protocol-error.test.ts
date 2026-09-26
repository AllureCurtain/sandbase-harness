/**
 * `pi_rpc_protocol_error` — a frame that could not be trusted.
 *
 * `rpc-wire.ts:49-56` says why these codes live in one leaf module: the same
 * literals would otherwise appear in the throwing class, the retry-classification
 * table and tests, and *"a spelling drift between those copies is how a permanent
 * failure silently becomes one a client is told to retry."* So the spelling is
 * asserted as a literal, and the distinctness from the retryable codes is
 * asserted against the constants — comparing two literal values would hold no
 * matter what the constants were set to and so could not notice the drift the
 * doc comment describes.
 */

import { describe, expect, it } from 'vitest';
import { PiRpcError, PiRpcProtocolError } from '@/strategy/pi/rpc-transport.js';
import {
  PI_RPC_COMMAND_REJECTED_CODE,
  PI_RPC_PROTOCOL_ERROR_CODE,
  PI_RPC_TIMEOUT_CODE,
} from '@/strategy/pi/rpc-wire.js';

describe('pi_rpc_protocol_error', () => {
  it('is the code and name for a frame that could not be trusted', () => {
    const error = new PiRpcProtocolError('unexpected frame type "wat"');

    expect(error).toBeInstanceOf(PiRpcError);
    expect(error.code).toBe('pi_rpc_protocol_error');
    expect(error.name).toBe('PiRpcProtocolError');
  });

  it('carries the frame detail that made it untrusted', () => {
    expect(new PiRpcProtocolError('unexpected frame type "wat"').message).toContain('unexpected frame type');
  });

  it('is not one of the codes a client is told to retry', () => {
    // The transport raises the timeout and rejected-command codes for failures a
    // retry can fix. Drift that merged this permanent failure with either of them
    // would tell a client to resend a frame the runtime will always refuse.
    expect(PI_RPC_PROTOCOL_ERROR_CODE).not.toBe(PI_RPC_TIMEOUT_CODE);
    expect(PI_RPC_PROTOCOL_ERROR_CODE).not.toBe(PI_RPC_COMMAND_REJECTED_CODE);
    expect(new PiRpcProtocolError('unexpected frame type "wat"').code).not.toBe(PI_RPC_TIMEOUT_CODE);
  });
});
