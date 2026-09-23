/**
 * Pi RPC transport: framing, demultiplexing, correlation, and fail-closed
 * behaviour on malformed or unanswered input.
 *
 * These assertions are the ones that keep a framing bug from becoming a policy
 * bug: an event that is misread, an unmatched response that resolves a pending
 * command, or a timeout reported as a clean failure would each let the runtime
 * claim something the engine never said.
 */

import { describe, expect, it } from 'vitest';
import {
  PI_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
  PiRpcClosedError,
  PiRpcProtocolError,
  PiRpcTimeoutError,
  PiRpcTransport,
  type PiExtensionUiRequest,
} from '@/strategy/pi/rpc-transport.js';
import { createPiRpcWire, settleAsync, waitFor } from './pi-rpc-test-helpers.js';

function transportFor(wire: ReturnType<typeof createPiRpcWire>, overrides: Partial<{
  onEvent: (frame: Record<string, unknown>) => void;
  onExtensionUiRequest: (request: PiExtensionUiRequest) => void;
  onClosed: (reason: unknown) => void;
}> = {}) {
  const events: Record<string, unknown>[] = [];
  const uiRequests: PiExtensionUiRequest[] = [];
  const closes: unknown[] = [];
  const transport = new PiRpcTransport({
    stdin: wire.stdin,
    stdout: wire.stdout,
    onEvent: (frame) => { events.push(frame); overrides.onEvent?.(frame); },
    onExtensionUiRequest: (request) => { uiRequests.push(request); overrides.onExtensionUiRequest?.(request); },
    onClosed: (reason) => { closes.push(reason); overrides.onClosed?.(reason); },
  });
  transport.start();
  return { transport, events, uiRequests, closes };
}

describe('Pi RPC transport', () => {
  it('correlates a response with its command by id and leaves events alone', async () => {
    const wire = createPiRpcWire();
    const { transport, events } = transportFor(wire);
    const pending = transport.send('get_state', {});

    await waitFor(() => wire.written.length === 1, 'the get_state command');
    const sent = wire.written[0];
    expect(sent).toMatchObject({ type: 'get_state' });
    expect(typeof sent.id).toBe('string');

    wire.say({ type: 'agent_settled' });
    wire.say({ type: 'response', id: sent.id, success: true, data: { sessionId: 'pi-native' } });

    await expect(pending).resolves.toMatchObject({ success: true });
    await settleAsync();
    // The response settled the command and was never surfaced as an event.
    expect(events.map((event) => event.type)).toEqual(['agent_settled']);
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('serializes asynchronous event handlers in stdout order', async () => {
    const wire = createPiRpcWire();
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];
    const transport = new PiRpcTransport({
      stdin: wire.stdin,
      stdout: wire.stdout,
      onEvent: async (frame) => {
        events.push(String(frame.type));
        if (frame.type === 'first') await firstFinished;
      },
      onExtensionUiRequest: () => {},
      onClosed: () => {},
    });
    transport.start();
    wire.say({ type: 'first' });
    wire.say({ type: 'second' });
    await waitFor(() => events.length === 1, 'the first event handler to start');
    expect(events).toEqual(['first']);
    releaseFirst();
    await waitFor(() => events.length === 2, 'the second event handler to finish');
    expect(events).toEqual(['first', 'second']);
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('treats a response with no matching id as inert rather than as authority', async () => {
    const wire = createPiRpcWire();
    const { transport, events } = transportFor(wire);
    const pending = transport.send('get_state', {}, { timeoutMs: 40 });

    await waitFor(() => wire.written.length === 1, 'the get_state command');
    // Pi emits id-less responses for parse failures; they must not settle a
    // pending command, or a failed write would look like a success.
    wire.say({ type: 'response', success: true, data: { sessionId: 'not-mine' } });
    wire.say({ type: 'response', id: 'sb-9999', success: true, data: { sessionId: 'not-mine' } });

    await expect(pending).rejects.toBeInstanceOf(PiRpcTimeoutError);
    expect(events).toEqual([]);
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('surfaces a blocking extension_ui_request with its prefill payload', async () => {
    const wire = createPiRpcWire();
    const { transport, uiRequests } = transportFor(wire);

    wire.say({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'editor',
      title: 'SandBase tool approval',
      prefill: '{"kind":"sandbase_tool_gate"}',
    });
    wire.say({ type: 'extension_ui_request', id: 'ui-2', method: 'notify', message: 'done' });

    await waitFor(() => uiRequests.length === 2, 'two UI requests');
    expect(uiRequests[0]).toMatchObject({
      id: 'ui-1',
      method: 'editor',
      blocking: true,
      prefill: '{"kind":"sandbase_tool_gate"}',
    });
    // A fire-and-forget method is not something Pi waits on; answering it would
    // write a response the engine never asked for.
    expect(uiRequests[1]).toMatchObject({ id: 'ui-2', method: 'notify', blocking: false });
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('answers a UI request with the request id, and does not wait for a reply', async () => {
    const wire = createPiRpcWire();
    const { transport } = transportFor(wire);

    // Pi resolves the open dialog and sends no `response` frame for it, so this
    // must resolve on the write alone. Awaiting a correlated response here would
    // make every answer time out after the dialog was in fact answered.
    await transport.respond('ui-7', { value: '{"decision":"deny"}' });

    expect(wire.written).toEqual([
      { id: 'ui-7', type: 'extension_ui_response', value: '{"decision":"deny"}' },
    ]);
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('drops a non-JSON diagnostic line but fails closed on a malformed frame', async () => {
    const wire = createPiRpcWire();
    const { transport, events, closes } = transportFor(wire);

    wire.sayRaw('warning: model fallback applied\n');
    wire.say({ type: 'agent_settled' });
    await waitFor(() => events.length === 1, 'the agent_settled event');

    // A JSON object that is missing its discriminator cannot be trusted as an
    // engine frame, so the reader stops instead of guessing at a type.
    wire.sayRaw('{"success":true}\n');
    await waitFor(() => closes.length === 1, 'the transport to close');
    expect(closes[0]).toMatchObject({ kind: 'reader-error' });
    expect((closes[0] as { error: Error }).error).toBeInstanceOf(PiRpcProtocolError);
    expect(transport.closed).toBe(true);
  });

  it('propagates a reader protocol error to pending commands', async () => {
    const wire = createPiRpcWire();
    const { transport } = transportFor(wire);
    const pending = transport.send('get_state', {});
    await waitFor(() => wire.written.length === 1, 'the get_state command');
    wire.sayRaw('{"broken":\n');
    await expect(pending).rejects.toBeInstanceOf(PiRpcProtocolError);
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('reports a missing response as outcome_unknown, never as a clean failure', async () => {
    const wire = createPiRpcWire();
    const { transport } = transportFor(wire);
    const pending = transport.send('steer', { message: 'go' }, { timeoutMs: 30 });

    await expect(pending).rejects.toMatchObject({
      code: 'pi_rpc_timeout',
      outcomeUnknown: true,
    });
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('rejects a refused command as a known rejection, not an unknown outcome', async () => {
    const wire = createPiRpcWire();
    const { transport } = transportFor(wire);
    const pending = transport.send('prompt', { message: 'hello' });

    await waitFor(() => wire.written.length === 1, 'the prompt command');
    wire.say({ type: 'response', id: (wire.written[0] as { id: string }).id, success: false, error: 'busy' });

    await expect(pending).rejects.toMatchObject({ code: 'pi_rpc_command_rejected', detail: 'busy' });
    await transport.close({ kind: 'closed-by-runtime' });
  });

  it('settles every pending command when the transport closes', async () => {
    const wire = createPiRpcWire();
    const { transport } = transportFor(wire);
    const first = transport.send('prompt', { message: 'one' });
    const second = transport.send('steer', { message: 'two' });
    const firstOutcome = first.catch((error: unknown) => error);
    const secondOutcome = second.catch((error: unknown) => error);

    await transport.close({ kind: 'reader-ended' });

    expect(await firstOutcome).toBeInstanceOf(PiRpcClosedError);
    expect(await secondOutcome).toBeInstanceOf(PiRpcClosedError);
    // Post-close writes are refused rather than silently buffered.
    await expect(transport.send('prompt', { message: 'three' })).rejects.toBeInstanceOf(PiRpcClosedError);
  });

  it('stops reading after the record stream ends and reports why', async () => {
    const wire = createPiRpcWire();
    const { closes } = transportFor(wire);

    wire.end();
    await waitFor(() => closes.length === 1, 'the reader to end');
    expect(closes[0]).toEqual({ kind: 'reader-ended' });
  });

  it('keeps a default request deadline so no command waits forever', () => {
    expect(PI_RPC_DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
