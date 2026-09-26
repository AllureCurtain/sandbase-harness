/**
 * `pi_rpc_closed` — the transport could not place a write.
 *
 * `rpc-wire.ts` documents this code as one half of a deliberate pair: a caller
 * branching on retry disposition must be able to tell "the command never left
 * this process" (`pi_rpc_closed`) from "the engine that was serving this session
 * no longer exists" (`pi_rpc_session_closed`). The other half is asserted by
 * existing tests; this one was asserted nowhere, so the pair could collapse into
 * a single code without a single test noticing — and the two demand opposite
 * dispositions from a caller.
 */

import { describe, expect, it } from 'vitest';
import { PiRpcClosedError, PiRpcError } from '@/strategy/pi/rpc-transport.js';

describe('pi_rpc_closed', () => {
  it('is the code and name the transport raises for a write it could not place', () => {
    const error = new PiRpcClosedError('stdout ended');

    expect(error).toBeInstanceOf(PiRpcError);
    expect(error.code).toBe('pi_rpc_closed');
    expect(error.name).toBe('PiRpcClosedError');
  });

  it('carries the detail that explains the closure', () => {
    expect(new PiRpcClosedError('stdout ended').message).toContain('stdout ended');
  });

  it('stays distinct from the code for a session whose engine is gone', () => {
    // A caller that cannot tell these apart will either retry a command that
    // already left the process or give up on one that never did.
    expect(new PiRpcClosedError('stdout ended').code).not.toBe('pi_rpc_session_closed');
  });
});
