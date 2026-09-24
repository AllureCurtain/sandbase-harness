/**
 * Unit test: what counts as a parked call.
 *
 * `src/core/session/parked-calls.ts` is one definition read from two sides that
 * must never disagree — the `stop_reason.event_ids` projection tells a client
 * which ids to answer, and the executor's resume gate decides whether a turn may
 * start. If they drift, a client is either told to answer a call the gate does
 * not know about, or a turn starts against a tool-result sequence that is still
 * missing a call, which providers reject with "Tool result is missing for tool
 * call <id>".
 *
 * The integration suite (`tests/integration/resume-gate.test.ts`) proves the
 * end-to-end behaviour through the real strategy and status transition. This
 * pins the definition's own edge cases, which a driven session cannot easily
 * arrange: resolution arriving in either order, a custom result answering by the
 * block id, the MCP event types, and a resolved call being excluded from what the
 * array still reports.
 */

import { describe, it, expect } from 'vitest';
import { parkedCalls } from '@/core/session/parked-calls.js';
import type { SessionEvent } from '@/types/session.js';

let seq = 0;

function event(id: string, type: SessionEvent['type'], extra: Partial<SessionEvent> = {}): SessionEvent {
  seq += 1;
  return {
    id,
    sessionId: 'sess_1',
    seq,
    type,
    createdAt: new Date(0),
    ...extra,
  } as SessionEvent;
}

function gatedUse(id: string, blockId: string, requiresConfirmation = true): SessionEvent {
  return event(id, 'agent.tool_use', {
    content: [{ type: 'tool_use', id: blockId, name: 'bash', input: {}, requires_confirmation: requiresConfirmation }] as any,
  });
}

function mcpUse(id: string, blockId: string): SessionEvent {
  return event(id, 'agent.mcp_tool_use', {
    content: [{ type: 'tool_use', id: blockId, name: 'mcp_files_read', input: {}, requires_confirmation: true }] as any,
  });
}

function customUse(id: string, blockId: string): SessionEvent {
  return event(id, 'agent.custom_tool_use', {
    content: [{ type: 'tool_use', id: blockId, name: 'lookup_customer', input: {} }] as any,
    metadata: { custom_tool: true },
  });
}

function toolResult(id: string, blockId: string): SessionEvent {
  return event(id, 'agent.tool_result', {
    content: [{ type: 'tool_result', tool_use_id: blockId, content: 'ok' }] as any,
  });
}

function customResult(id: string, blockId: string): SessionEvent {
  return event(id, 'user.custom_tool_result', {
    content: [{ type: 'text', text: 'x' }] as any,
    metadata: { custom_tool_use_id: blockId },
  });
}

describe('parkedCalls', () => {
  it('reports nothing for an empty log', () => {
    expect(parkedCalls([])).toEqual([]);
  });

  it('reports a gated call by its event id and block id', () => {
    expect(parkedCalls([gatedUse('sevt_a', 'call_1')]))
      .toEqual([{ eventId: 'sevt_a', blockId: 'call_1' }]);
  });

  it('reports a pending custom call, which carries no requires_confirmation', () => {
    // A custom call is parked because the runtime has no executor for it, not
    // because a policy gated it, so the flag is absent.
    expect(parkedCalls([customUse('sevt_c', 'custom_1')]))
      .toEqual([{ eventId: 'sevt_c', blockId: 'custom_1' }]);
  });

  it('reports an MCP call the same way as a built-in one', () => {
    expect(parkedCalls([mcpUse('sevt_m', 'mcp_1')]))
      .toEqual([{ eventId: 'sevt_m', blockId: 'mcp_1' }]);
  });

  it('ignores a tool_use that is not awaiting confirmation', () => {
    expect(parkedCalls([gatedUse('sevt_a', 'call_1', false)])).toEqual([]);
  });

  it('reports the event id, never the block id, as what the array names', () => {
    const [call] = parkedCalls([gatedUse('sevt_a', 'call_1')]);
    expect(call.eventId).toBe('sevt_a');
    expect(call.blockId).toBe('call_1');
    // The two are different values and the exchange depends on which is which:
    // the event id is answered with, the block id pairs the result.
    expect(call.eventId).not.toBe(call.blockId);
  });

  it('excludes a call whose block id a built-in result answers', () => {
    expect(parkedCalls([gatedUse('sevt_a', 'call_1'), toolResult('sevt_r', 'call_1')])).toEqual([]);
  });

  it('excludes a call whose block id an MCP result answers', () => {
    const result = event('sevt_r', 'agent.mcp_tool_result', {
      content: [{ type: 'tool_result', tool_use_id: 'mcp_1', content: 'ok' }] as any,
    });
    expect(parkedCalls([mcpUse('sevt_m', 'mcp_1'), result])).toEqual([]);
  });

  it('excludes a call whose block id a custom result answers', () => {
    expect(parkedCalls([customUse('sevt_c', 'custom_1'), customResult('sevt_r', 'custom_1')])).toEqual([]);
  });

  it('resolves regardless of whether the result precedes the call in the log', () => {
    // The projection exempts a `user.tool_confirmation`, so a result can only
    // follow its call — but the two passes make the order irrelevant, and that is
    // what lets one function serve both callers without a second traversal.
    expect(parkedCalls([toolResult('sevt_r', 'call_1'), gatedUse('sevt_a', 'call_1')])).toEqual([]);
  });

  it('keeps a call whose result answers a different call', () => {
    expect(parkedCalls([gatedUse('sevt_a', 'call_1'), toolResult('sevt_r', 'call_2')]))
      .toEqual([{ eventId: 'sevt_a', blockId: 'call_1' }]);
  });

  it('keeps a result that answers nothing from resolving a later call', () => {
    // A custom result must not resolve a built-in call that reuses the id, and
    // vice versa: the resolution pass keys each answer by the block id the
    // *pairing* uses, so the two families stay separable.
    const events = [customUse('sevt_c', 'custom_1'), customResult('sevt_r', 'custom_2'), gatedUse('sevt_a', 'call_1')];
    expect(parkedCalls(events)).toEqual([
      { eventId: 'sevt_c', blockId: 'custom_1' },
      { eventId: 'sevt_a', blockId: 'call_1' },
    ]);
  });

  it('reports both families together, in log order', () => {
    const events = [
      gatedUse('sevt_a', 'call_1'),
      customUse('sevt_c', 'custom_1'),
      mcpUse('sevt_m', 'mcp_1'),
    ];
    expect(parkedCalls(events)).toEqual([
      { eventId: 'sevt_a', blockId: 'call_1' },
      { eventId: 'sevt_c', blockId: 'custom_1' },
      { eventId: 'sevt_m', blockId: 'mcp_1' },
    ]);
  });

  it('drops only the answered call when several are parked', () => {
    const events = [
      gatedUse('sevt_a', 'call_1'),
      customUse('sevt_c', 'custom_1'),
      toolResult('sevt_r', 'call_1'),
    ];
    expect(parkedCalls(events)).toEqual([{ eventId: 'sevt_c', blockId: 'custom_1' }]);
  });

  it('ignores a custom result that carries no usable id', () => {
    // A malformed carrier must not silently resolve a call.
    const malformed = event('sevt_r', 'user.custom_tool_result', { metadata: { custom_tool_use_id: 7 } });
    expect(parkedCalls([customUse('sevt_c', 'custom_1'), malformed]))
      .toEqual([{ eventId: 'sevt_c', blockId: 'custom_1' }]);
  });

  it('ignores a tool event whose content holds no matching block', () => {
    const empty = event('sevt_e', 'agent.custom_tool_use', { content: [{ type: 'text', text: 'x' }] as any });
    expect(parkedCalls([empty])).toEqual([]);
  });

  it('ignores unrelated event types', () => {
    const noise = [
      event('sevt_1', 'user.message', { content: [{ type: 'text', text: 'hi' }] as any }),
      event('sevt_2', 'session.status_running'),
      event('sevt_3', 'agent.message', { content: [{ type: 'text', text: 'done' }] as any }),
      event('sevt_4', 'session.usage'),
    ];
    expect(parkedCalls(noise)).toEqual([]);
  });
});
